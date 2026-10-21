// tools.mjs — ghmux MCP 活跃层：Agent 操作 GitHub 多账户的工具面（热加载，改完调 reload）
//
// 设计原则（Agent-first）：
// - 任务动词优先：commit_push 一个调用完成「以正确身份提交并推送」；who 直接回答
//   「这个仓库该用哪个账户」——不镜像 CLI 的每个子命令
// - MCP 进程 cwd ≠ agent 的 cwd：涉仓库工具一律显式收 cwd 参数
// - ⚠️ 只 import src 的纯函数（store/gh 底层）——cmd* 系列会 console.log +
//   process.exit（CLI 语义），在 MCP 里会污染 stdout/杀进程，绝不用
// - 输出首行 = 结论（✅/❌/要点），明细在后
// - 对 GitHub 的一切流量经 gh cli（api/认证/代理），零裸 HTTP；限流合规（串行锁、
//   变异 ≥1s、退避重试、4xx 不重试）由 src/gh.mjs 提供
// - token 永不回显（accounts/check 输出只标有无）；账户出口遵守 accounts-cards
//   纪律：操作 IP 绑定后不随意换、同类账户不共出口、换绑后短时勿操作

import { z } from "zod";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig, saveConfig, getAccount, getAccounts, ACCOUNT_FIELDS } from "../src/store.mjs";
import { accountEnv, classifyFailure, gh, inferMethod, isMutating, throttleMutation, withApiLock } from "../src/gh.mjs";
import { expandHome } from "../src/util.mjs";

// ---------- 内部帮助（cwd 感知；错误走 return，绝不 process.exit） ----------

const err = (msg) => ({ content: [{ type: "text", text: `❌ ${msg}` }], isError: true });
const ok = (text) => ({ content: [{ type: "text", text }] });

/** spawn（cwd 感知）；MCP 进程 stdout 被协议占用，子进程输出收集后返回不上抛 */
function run(cmd, args, { cwd, env } = {}) {
	return new Promise((res) => {
		const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "", e = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (e += d));
		child.on("error", (er) => res({ code: 127, out: "", err: er.message }));
		child.on("close", (code) => res({ code: code ?? 1, out, err: e }));
	});
}

const git = (cwd, args, env) => run("git", args, { cwd, env });
const gitTop = async (cwd) => {
	const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
	return r.code === 0 ? r.out.trim() : null;
};

/** CLI bin 绝对路径（credential helper 锚定它，防 PATH 漂移） */
const CLI_BIN = join(import.meta.dirname, "../bin/ghmux.mjs");

const localGet = async (cwd, key) => (await git(cwd, ["config", "--local", "--get", key])).out.trim();

/** 仓库账户决策：绑定 → 账户；未绑定按 origin owner 匹配；autoAdopt 时直接采用 */
async function resolveAccount(cwd, autoAdopt = false) {
	const bound = await localGet(cwd, "ghmux.account");
	if (bound) {
		const acc = getAccount(bound);
		if (acc) return { name: bound, acc, how: "bound" };
		return { error: `仓库绑定的账户 "${bound}" 已不存在（unuse 后重新 use）` };
	}
	const url = (await git(cwd, ["remote", "get-url", "origin"])).out.trim();
	const owner = (url.match(/github\.com[/:]([^/]+)\//i) || [])[1]?.toLowerCase() ?? null;
	if (!owner) return { error: "仓库未绑定账户且无 origin owner 可匹配（先 use）" };
	const match = Object.entries(getAccounts()).find(([, a]) => a.githubUser?.toLowerCase() === owner);
	if (!match) return { error: `origin owner=${owner} 无匹配账户（先 ghmux add）` };
	if (!autoAdopt) return { error: `仓库未绑定；origin owner=${owner} 匹配账户 "${match[0]}"——加 adopt: true 采用或先 use` };
	return { name: match[0], acc: match[1], how: "auto" };
}

/** 身份漂移检测/纠正：local user.* 与账户不符时改回（返回纠正说明或 null） */
async function fixIdentity(cwd, name, acc, auto) {
	const curName = await localGet(cwd, "user.name");
	const curEmail = await localGet(cwd, "user.email");
	if (curName === acc.name && curEmail === acc.email) return null;
	if (!auto) return `身份漂移：当前 ${curName || "∅"} <${curEmail || "∅"}> ≠ 账户 ${name}（提交会被拒绝，加 adopt 或先 use）`;
	await git(cwd, ["config", "--local", "user.name", acc.name]);
	await git(cwd, ["config", "--local", "user.email", acc.email]);
	return `身份漂移已纠正：${curName || "∅"} → ${acc.name} <${acc.email}>`;
}

// ---------- 工具面 ----------

export function register(server, ctx) {
	const { tool } = ctx;

	const cwdArg = z.string().describe("仓库绝对路径（MCP 进程 cwd ≠ agent cwd，必须显式给）");

	tool("who", "决策查询：某仓库该用哪个 GitHub 账户身份——绑定账户/origin 匹配建议/身份漂移状态，agent 动手改仓库前先调这个", { cwd: cwdArg }, async ({ cwd }) => {
		const top = await gitTop(cwd);
		if (!top) return err(`${cwd} 不是 git 仓库`);
		const bound = await localGet(top, "ghmux.account");
		const acc = bound ? getAccount(bound) : null;
		if (acc) {
			const drift = await fixIdentity(top, bound, acc, false);
			const url = (await git(top, ["remote", "get-url", "origin"])).out.trim();
			const owner = (url.match(/github\.com[/:]([^/]+)\//i) || [])[1]?.toLowerCase();
			const mismatch = owner && acc.githubUser?.toLowerCase() !== owner
				? `⚠️ origin owner=${owner} 与绑定账户 ${acc.githubUser} 不一致（确认没绑错）` : "";
			return ok([`✅ ${top} → ${bound}（${acc.githubUser} <${acc.email}>${acc.proxy ? ` · 出口 ${acc.proxy}` : ""}）`,
				drift, mismatch].filter(Boolean).join("\n"));
		}
		const r = await resolveAccount(top);
		return ok(r.error ? `⚠️ ${top}：${r.error}` : `✅ 未绑定，origin 匹配 "${r.name}"（use 绑定 / commit_push 加 adopt 采用）`);
	});

	tool("accounts", "账户清单：名字/GitHub 用户名/提交邮箱/出口端口（token 不回显只标有无）", {}, async () => {
		const all = getAccounts();
		const names = Object.keys(all);
		if (!names.length) return ok("（无账户，先 add）");
		return ok(names.map((n) => {
			const a = all[n];
			return `${n}  ${a.githubUser}  <${a.email}>  ${a.proxy ? `出口 ${a.proxy.replace(/^https?:\/\/127\.0\.0\.1:/, ":")}` : "无出口"}  token${a.token ? "✓" : "✗"}`;
		}).join("\n"));
	});

	tool("check", "验证账户 token 有效性 + 限额余额——每账户仅 1 个请求（GET /rate_limit：401=token 无效，端点本身不计限额；限流按资源池 core/search/graphql，非逐端点）", {
		account: z.string().optional().describe("账户名（缺省 = 全部，逐个串行）"),
	}, async ({ account }) => {
		const list = account ? { [account]: getAccount(account) } : getAccounts();
		if (account && !list[account]) return err(`未找到账户 "${account}"`);
		const lines = [];
		for (const [n, acc] of Object.entries(list)) {
			if (!acc) return err(`未找到账户 "${n}"`);
			const lim = await gh(["api", "rate_limit"], { env: accountEnv(acc), allowFail: true });
			if (lim.code !== 0) { lines.push(`❌ ${n}: token 无效或查询失败（${lim.err.trim().split("\n")[0]}）`); continue; }
			const r = JSON.parse(lim.out).resources;
			const p = (x) => `${x.remaining}/${x.limit}`;
			lines.push(`✅ ${n}（${acc.githubUser}）core ${p(r.core)} · search ${p(r.search)} · graphql ${p(r.graphql)}${acc.proxy ? ` · 出口 ${acc.proxy}` : ""}`);
		}
		return ok(lines.join("\n"));
	});

	tool("commit_push", "一击必杀：以正确账户身份提交并推送（身份漂移自动纠正；推送认证/出口走 gh cli 通道；完成后回显 author 与远端分支）。agent 改完代码收尾就用它。⚠️ 提交规范化像真实仓库：message 用 conventional commits（feat/fix/docs/chore/refactor/test），祈使句首行 ≤72 字符，正文（空行后）说明动机与上下文——不要 smoke/test 之类的敷衍提交", {
		cwd: cwdArg,
		message: z.string().describe('commit message（conventional commits：如 "feat: add retry backoff\n\nSecondary rate limits require …"；首行祈使句 ≤72 字符）；message 以 "(push)" 结尾且无待提交内容时跳过 commit 只推送既有提交'),
		paths: z.array(z.string()).optional().describe("要 add 的路径（缺省 = 只提交已 staged 的内容）"),
		adopt: z.boolean().optional().describe("仓库未绑定时按 origin owner 匹配账户并采用（一次性注入，不落盘）"),
		push_args: z.array(z.string()).optional().describe('透传 git push 的额外参数（如 ["--force"]）'),
	}, async ({ cwd, message, paths, adopt, push_args }) => {
		const top = await gitTop(cwd);
		if (!top) return err(`${cwd} 不是 git 仓库`);
		const r = await resolveAccount(top, adopt);
		if (r.error) return err(r.error);
		const { name, acc, how } = r;
		// bound：漂移落盘纠正；auto：不落盘（commit 用 -c 一次性注入身份）
		const drift = how === "bound" ? await fixIdentity(top, name, acc, true) : null;
		if (paths?.length) {
			const add = await git(top, ["add", "--", ...paths.map((p) => resolve(cwd, p))]);
			if (add.code !== 0) return err(`git add 失败: ${add.err}`);
		}
		// push-only 模式（message 以 "(push)" 结尾）：无 staged 内容 + 本地 ahead → 跳过 commit 直接推
		const staged = (await git(top, ["diff", "--cached", "--name-only"])).out.trim();
		let author = "";
		if (!(staged === "" && message.endsWith("(push)"))) {
			const commitArgs = how === "auto"
				? ["-c", `user.name=${acc.name}`, "-c", `user.email=${acc.email}`, "commit", "-m", message]
				: ["commit", "-m", message];
			const c = await git(top, commitArgs);
			if (c.code !== 0) return err(`git commit 失败: ${c.err || c.out}`);
		}
		author = (await git(top, ["log", "-1", "--format=%an <%ae>"])).out.trim();
		const push = await git(top,
			["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", ...(push_args ?? [])],
			accountEnv(acc));
		if (push.code !== 0) return err(`提交成功（${author}）但推送失败: ${push.err}`);
		return ok([`✅ ${name}（${acc.githubUser}${acc.proxy ? ` · 出口 ${acc.proxy}` : ""}${how === "auto" ? " · --auto 一次性" : ""}）`,
			`提交: ${author}`, drift, "推送完成"].filter(Boolean).join("\n"));
	});

	tool("api", "GitHub API 网关（限流合规：跨进程串行、变异 ≥1s、限流退避重试、404/4xx 绝不重试）。一切 GitHub 查询/变更走这里，不要自己拼 HTTP", {
		endpoint: z.string().describe('API 端点（如 "user"、"/repos/{o}/{r}/issues"；gh api 语法）'),
		account: z.string().optional().describe("账户名（缺省 = 当前仓库绑定；无绑定时必填）"),
		cwd: cwdArg.optional(),
		gh_args: z.array(z.string()).optional().describe('透传 gh api 参数（如 ["--method","DELETE"] 或 ["-f","key=val","--jq",".login"]）'),
	}, async ({ endpoint, account, cwd, gh_args }) => {
		let acc = null, name = null;
		if (account) { acc = getAccount(account); name = account; }
		else if (cwd) {
			const top = await gitTop(cwd);
			const bound = top ? await localGet(top, "ghmux.account") : "";
			acc = bound ? getAccount(bound) : null; name = bound || null;
		}
		if (!acc) return err("未指定账户：account 参数或绑定仓库的 cwd 二选一");
		if (!acc.token) return err(`账户 "${name}" 无 token`);
		const extra = gh_args ?? [];
		const method = inferMethod(extra);
		// 端点节约：GET 默认本地缓存 30s（etag 条件请求，304 不计限额）；
		// 显式 --cache/--no-cache 时不覆盖
		const userCache = extra.some((a) => a === "--cache" || a.startsWith("--cache=") || a === "--no-cache");
		if (!userCache && !isMutating(method)) extra.push("--cache", "30s");
		const args = ["api", ...extra, endpoint];
		const env = accountEnv(acc);
		let out = await withApiLock(async () => {
			if (isMutating(method)) await throttleMutation();
			for (let attempt = 0; ; attempt++) {
				const r = await gh(args, { env, allowFail: true });
				if (r.code === 0) return { ok: true, out: r.out };
				const cls = classifyFailure(r.err);
				if (cls.kind !== "ratelimit" || attempt >= 2) return { ok: false, out: r.out, err: r.err, kind: cls.kind };
				const waitSec = cls.waitSec ?? 61 * 2 ** attempt;
				await new Promise((s) => setTimeout(s, waitSec * 1000));
			}
		});
		const head = out.ok ? "✅" : out.kind === "no-retry" ? "❌（4xx 客户端错误，按纪律不重试）" : "❌";
		return { content: [{ type: "text", text: `${head} ${name} · ${method} ${endpoint}\n${out.out || out.err || ""}` }], isError: !out.ok };
	});

	tool("as", "以账户身份执行任意命令（注入 GH_TOKEN/GITHUB_TOKEN + 出口代理 env——gh 全部子命令如 pr/release、curl 等都以该账户、该出口运行）", {
		account: z.string().describe("账户名"),
		command: z.array(z.string()).min(1).describe('命令及参数（如 ["gh","pr","list"]）'),
		cwd: cwdArg.optional(),
	}, async ({ account, command, cwd }) => {
		const acc = getAccount(account);
		if (!acc) return err(`未找到账户 "${account}"`);
		if (!acc.token) return err(`账户 "${account}" 无 token`);
		const r = await run(command[0], command.slice(1), { cwd, env: accountEnv(acc) });
		return { content: [{ type: "text", text: `▶ ${account}（${acc.githubUser}${acc.proxy ? ` · 出口 ${acc.proxy}` : ""}）exit ${r.code}\n${r.out || r.err}` }], isError: r.code !== 0 };
	});

	tool("use", "绑定仓库→账户（写 local config：提交身份 + 专用凭证 + 出口代理；不动全局）", {
		cwd: cwdArg, account: z.string(),
	}, async ({ cwd, account }) => {
		const acc = getAccount(account);
		if (!acc) return err(`未找到账户 "${account}"`);
		const top = await gitTop(cwd);
		if (!top) return err(`${cwd} 不是 git 仓库`);
		const set = async (args) => { const r = await git(top, args); if (r.code !== 0) throw new Error(`git config: ${r.err}`); };
		// unset-all 对不存在的键 exit 5（键本就没配过 = 目标已达成），容错跳过
		const unset = async (key) => { const r = await git(top, ["config", "--local", "--unset-all", key]); if (r.code !== 0 && r.code !== 5) throw new Error(`git config: ${r.err}`); };
		try {
			await unset("credential.helper");
			await set(["config", "--local", "--add", "credential.helper", ""]);
			// 手动 git push 场景的凭证锚定 ghmux 自有 helper（按绑定账户回显 token）；
			// ghmux/MCP 的推送则统一 -c 覆盖为 gh cli 通道（GH_TOKEN env 注入）
			await set(["config", "--local", "--add", "credential.helper", `!${CLI_BIN} git-credential ${account}`]);
			await set(["config", "--local", "user.name", acc.name]);
			await set(["config", "--local", "user.email", acc.email]);
			await set(["config", "--local", "ghmux.account", account]);
			if (acc.proxy) await set(["config", "--local", "http.https://github.com/.proxy", acc.proxy]);
			if (acc.sshKey) {
				let cmd = `ssh -i ${expandHome(acc.sshKey)} -o IdentitiesOnly=yes`;
				const m = acc.proxy?.match(/^https?:\/\/([^/]+):(\d+)/);
				if (m) cmd += ` -o ProxyCommand='nc -X connect -x ${m[1]}:${m[2]} %h %p'`;
				await set(["config", "--local", "core.sshCommand", cmd]);
			}
		} catch (e) { return err(e.message); }
		return ok(`✅ ${top} 已绑定 ${account} → ${acc.githubUser} <${acc.email}>${acc.proxy ? ` · 出口 ${acc.proxy}` : ""}\n（凭证经 gh cli；⚠️ 绑定即该账户的操作出口，遵守 accounts-cards 出口纪律：不随意换、同类账户不共出口）`);
	});

	tool("unuse", "解绑仓库（清理 use 写入的全部 local 配置）", { cwd: cwdArg }, async ({ cwd }) => {
		const top = await gitTop(cwd);
		if (!top) return err(`${cwd} 不是 git 仓库`);
		for (const k of ["credential.helper", "user.name", "user.email", "ghmux.account", "http.https://github.com/.proxy", "core.sshCommand"])
			await git(top, ["config", "--local", "--unset-all", k]);
		return ok(`✅ ${top} 已解绑（user/凭证/代理/SSH 配置已清理）`);
	});

	tool("add", "添加账户（token 必填——MCP 无交互；自动经 gh api user 验证并回填 GitHub 用户名/noreply 邮箱）。token 与 tokenFromFile 二选一：tokenFromFile 从本地文件读（敏感凭据不落对话记录的标准姿势，如 accounts-cards 卡片导出）", {
		name: z.string(),
		token: z.string().optional().describe("PAT（classic 建议 repo,workflow,read:org;需删仓加 delete_repo）——与 tokenFromFile 二选一"),
		tokenFromFile: z.string().optional().describe("从文件读 PAT 路径（值首尾空白剥除）——敏感值不经调用参数"),
		proxy: z.string().optional().describe("受控出口代理（proxylanes 泳道，如 http://127.0.0.1:24001；同类账户不得共用同一出口）"),
		github_user: z.string().optional().describe("离线时显式指定（缺省在线验证回填）"),
		email: z.string().optional(), display_name: z.string().optional(),
	}, async ({ name, token: tokenArg, tokenFromFile, proxy, github_user, email, display_name }) => {
		let token = tokenArg;
		if (tokenFromFile) token = readFileSync(resolve(tokenFromFile), "utf8").trim();
		if (!token) return err("token / tokenFromFile 必须给一个");
		const cfg = loadConfig();
		if (cfg.accounts?.[name]) return err(`账户 "${name}" 已存在`);
		const id = await gh(["api", "user"], { env: { GH_TOKEN: token, ...(proxy ? { https_proxy: proxy, HTTPS_PROXY: proxy } : {}) }, allowFail: true });
		let ident = {};
		if (id.code === 0) ident = JSON.parse(id.out);
		else if (!github_user) return err(`token 验证失败且未给 github_user（${id.err.trim().split("\n")[0]}）`);
		const acc = {
			githubUser: github_user || ident.login, name: display_name || ident.name || ident.login,
			email: email || ident.email || `${ident.id ?? "user"}+${ident.login ?? github_user}@users.noreply.github.com`,
			token, proxy: proxy || null, sshKey: null, note: null, addedAt: new Date().toISOString(),
		};
		if (!acc.githubUser) return err("无法确定 GitHub 用户名");
		cfg.accounts ??= {}; cfg.accounts[name] = acc; saveConfig(cfg);
		return ok(`✅ 账户 "${name}" 已保存：${acc.githubUser} <${acc.email}>${acc.proxy ? `（出口 ${acc.proxy}）` : ""}`);
	});

	tool("edit", "修改账户字段（key=value 语义同 CLI：githubUser/name/email/token/proxy/sshKey/note）", {
		name: z.string(), field: z.enum(ACCOUNT_FIELDS), value: z.string(),
	}, async ({ name, field, value }) => {
		const cfg = loadConfig();
		if (!cfg.accounts?.[name]) return err(`未找到账户 "${name}"`);
		cfg.accounts[name][field] = field === "proxy" && value === "" ? null : value;
		saveConfig(cfg);
		return ok(`✅ ${name}.${field} 已更新`);
	});
}
