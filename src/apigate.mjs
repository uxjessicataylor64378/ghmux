import { die, info, runInherit, warn } from './util.mjs';
import { getAccount, getAccounts, requireToken } from './store.mjs';
import { accountEnv, classifyFailure, gh, inferMethod, isMutating, throttleMutation, withApiLock } from './gh.mjs';
import { boundAccountName } from './use.mjs';

/** 解析 api/as 的账户参数：--as <name> 显式优先，否则当前仓库绑定 */
async function pickAccount(asFlag) {
  if (asFlag) {
    const acc = getAccount(asFlag);
    if (!acc) die(`未找到账户 "${asFlag}"`);
    return { name: asFlag, acc };
  }
  const bound = await boundAccountName();
  if (bound) {
    const acc = getAccount(bound);
    if (!acc) die(`仓库绑定的账户 "${bound}" 已不存在`);
    return { name: bound, acc };
  }
  die('不在绑定账户的仓库内；请加 --as <账户名> 指定');
}

const DEFAULT_RL_WAIT_S = 61; // 官方 best-practices：无 retry-after 时至少等 1 分钟
const MAX_RETRIES = 2;

/**
 * ghmux api：gh api 的限流合规包装。
 * - 跨进程串行锁（secondary limit 检测并发）
 * - 变异请求（POST/PATCH/PUT/DELETE）间隔 ≥1s
 * - 限流类失败（403/429 + rate limit/abuse 字样）按 retry-after 或 ≥61s 指数退避，最多 2 次重试
 * - 404 与其他 4xx 绝不重试（官方：重复打已知错误 → suspension）
 */
export async function cmdApi(args) {
  let asFlag = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--as') { asFlag = args[++i]; if (!asFlag) die('--as 需要账户名'); }
    else if (args[i].startsWith('--as=')) asFlag = args[i].slice(5);
    else rest.push(args[i]);
  }
  const noRetry = rest.includes('--no-retry');
  const endpoint = rest.find((a) => !a.startsWith('-'));
  if (!endpoint) die('用法: ghmux api [--as <账户>] <endpoint> [gh api 参数…]');
  const { name, acc } = await pickAccount(asFlag);
  requireToken(acc, name);

  const method = inferMethod(rest);
  // 端点节约（2026-10-14 用户定）：GET 默认本地缓存 30s（gh --cache = etag 条件请求，
  // 304 不计限额）——agent 循环查同一端点时重复调用零请求；显式 --cache/--no-cache 时不覆盖
  const userCache = rest.some((a) => a === '--cache' || a.startsWith('--cache=') || a === '--no-cache');
  if (!userCache && !isMutating(method)) rest.push('--cache', '30s');
  const env = accountEnv(acc);

  await withApiLock(async () => {
    if (isMutating(method)) await throttleMutation();
    for (let attempt = 0; ; attempt++) {
      const r = await gh(['api', ...rest], { env, allowFail: true });
      process.stdout.write(r.out);
      if (r.code === 0) { process.exit(0); }
      if (noRetry || attempt >= MAX_RETRIES) {
        process.stderr.write(r.err);
        die(`gh api 失败（${method} ${endpoint}${noRetry ? '' : '，重试次数已用尽'}）`, r.code);
      }
      const cls = classifyFailure(r.err);
      if (cls.kind === 'no-retry' || cls.kind === 'unknown') {
        process.stderr.write(r.err);
        die(`gh api 失败（${method} ${endpoint}，${cls.kind === 'no-retry' ? '4xx 客户端错误不重试' : '非限流错误不重试'}）`, r.code);
      }
      // ratelimit：遵守 retry-after / x-ratelimit-reset；没有就 61s 起指数退避
      const waitSec = cls.waitSec ?? (DEFAULT_RL_WAIT_S * Math.pow(2, attempt));
      warn(`限流命中（${method} ${endpoint}），按退避纪律等 ${waitSec}s 后重试（第 ${attempt + 1}/${MAX_RETRIES} 次，Ctrl-C 放弃）`);
      await new Promise((res) => setTimeout(res, waitSec * 1000));
    }
  });
}

/**
 * ghmux as <账户> -- <命令…>：以账户身份执行任意命令。
 * 注入 GH_TOKEN/GITHUB_TOKEN 与出口代理 env——gh 的全部子命令（pr/release/…）
 * 与 curl 等均以该账户身份、走该账户的受控出口运行。
 */
export async function cmdAs(args) {
  const sep = args.indexOf('--');
  if (sep < 1) die('用法: ghmux as <账户> -- <命令…>（如 ghmux as work -- gh pr list）');
  const name = args[sep - 1];
  const cmdArgs = args.slice(sep + 1);
  if (!cmdArgs.length) die('-- 后没有命令');
  const acc = getAccount(name);
  if (!acc) die(`未找到账户 "${name}"`);
  requireToken(acc, name);
  const env = accountEnv(acc);
  info(`▸ 以 ${name}（${acc.githubUser}${acc.proxy ? ` · 出口 ${acc.proxy}` : ''}）执行: ${cmdArgs.join(' ')}`);
  const code = await runInherit(cmdArgs[0], cmdArgs.slice(1), { env });
  process.exit(code);
}
