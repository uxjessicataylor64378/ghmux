import { ask, askHidden, die, info, ok, warn } from './util.mjs';
import { accountEnv, gh } from './gh.mjs';
import { ACCOUNT_FIELDS, assertAccount, getAccount, getAccounts, loadConfig, saveConfig } from './store.mjs';

/** 解析 --set k=v 参数 */
function parseSets(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--set') continue;
    const p = args[i + 1];
    if (!p) die('--set 需要 key=value 参数');
    const eq = p.indexOf('=');
    if (eq < 1) die(`--set 格式应为 key=value，收到: ${p}`);
    const k = p.slice(0, eq), v = p.slice(eq + 1);
    if (!ACCOUNT_FIELDS.includes(k)) die(`未知字段 "${k}"，可用: ${ACCOUNT_FIELDS.join(', ')}`);
    out[k] = v;
  }
  return out;
}

/** 收集 --key value 形态的 flag（含 --key=value） */
function parseFlags(args) {
  const known = ['token', 'user', 'name', 'email', 'proxy', 'ssh-key', 'note', 'from-gh', 'force'];
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    let key = a.slice(2), val;
    if (key.includes('=')) { [key, val] = key.split(/=(.*)/); }
    else if (known.includes(key) && key !== 'from-gh' && key !== 'force') { val = args[++i]; }
    else val = true; // 布尔 flag
    out[key] = val;
  }
  return out;
}

/**
 * 用 token 调 GET /user 验证并回填身份信息（走账户 proxy 出口）。
 * 返回 null（无效）或 { login, id, name, email }。
 */
export async function fetchGithubIdentity(token, proxy) {
  const { code, out, err } = await gh(['api', 'user'], { env: { GH_TOKEN: token, ...(proxy ? { https_proxy: proxy, HTTPS_PROXY: proxy } : {}) }, allowFail: true });
  if (code !== 0) return { error: err.trim() };
  try {
    const u = JSON.parse(out);
    return { login: u.login, id: u.id, name: u.name || u.login, email: u.email || null };
  } catch {
    return { error: '响应解析失败' };
  }
}

export async function cmdAdd(name, args) {
  const cfg = loadConfig();
  if (getAccounts(cfg)[name]) die(`账户 "${name}" 已存在（改名或先 ghmux rm ${name}）`);

  const flags = parseFlags(args);
  const acc = { addedAt: new Date().toISOString() };

  // token：--token / --from-gh（取当前 gh 登录 token）/ 交互输入
  let token = flags.token;
  if (!token && flags['from-gh']) {
    const r = await gh(['auth', 'token'], { allowFail: true });
    if (r.code !== 0 || !r.out.trim()) die('--from-gh 失败：gh 未登录（gh auth login 后重试，或改用 --token）');
    token = r.out.trim();
    acc.tokenSource = 'gh';
  }
  if (!token) {
    token = await askHidden('PAT token（输入不回显，经典 PAT 建议 repo,workflow,read:org 权限）: ');
    if (!token) die('未输入 token');
  }
  acc.token = token;

  // 出口代理（这台机器的多账户纪律：每个 GitHub 账户绑定受控出口端口）
  acc.proxy = flags.proxy || null;

  // 在线验证 + 回填 githubUser / name / email
  info('验证 token（GET /user）…');
  const ident = await fetchGithubIdentity(token, acc.proxy);
  if (ident.error) {
    warn(`token 验证失败: ${ident.error}`);
    if (!flags.force) die('加 --force 可跳过验证保存（不推荐）');
  }
  acc.githubUser = flags.user || ident.login || null;
  acc.name = flags.name || ident.name || null;
  if (!acc.githubUser) die('无法确定 GitHub 用户名（离线模式请提供 --user <github登录名>）');
  // email 默认：显式参数 > GitHub 公开邮箱 > 官方 noreply（隐私友好且头像可关联）
  acc.email = flags.email || ident.email || `${ident.id ?? 'user'}+${acc.githubUser}@users.noreply.github.com`;

  acc.sshKey = flags['ssh-key'] || null;
  acc.note = flags.note || null;

  cfg.accounts[name] = acc;
  saveConfig(cfg);
  ok(`账户 "${name}" 已保存：${acc.githubUser} <${acc.email}>${acc.proxy ? `（出口 ${acc.proxy}）` : ''}`);
}

export async function cmdLs() {
  const accounts = getAccounts();
  const names = Object.keys(accounts);
  if (!names.length) { info('（还没有账户，运行 ghmux add <名字> 添加）'); return; }
  for (const n of names) {
    const a = accounts[n];
    const bits = [a.githubUser, a.email];
    if (a.proxy) bits.push(`出口 ${a.proxy}`);
    if (a.sshKey) bits.push(`ssh ${a.sshKey}`);
    info(`  ${n.padEnd(14)} ${bits.join(' · ')}`);
  }
}

export async function cmdRm(name) {
  const cfg = loadConfig();
  assertAccount(name, cfg);
  delete cfg.accounts[name];
  saveConfig(cfg);
  ok(`账户 "${name}" 已删除（已 use 过的仓库 local 配置不受影响，可到仓库里跑 ghmux unuse 清理）`);
}

export async function cmdEdit(name, args) {
  const cfg = loadConfig();
  assertAccount(name, cfg);
  const sets = parseSets(args);
  if (!Object.keys(sets).length) die('用法: ghmux edit <name> --set key=value [--set key2=value2]');
  Object.assign(cfg.accounts[name], sets);
  saveConfig(cfg);
  ok(`账户 "${name}" 已更新: ${Object.keys(sets).join(', ')}`);
}

/** GET /rate_limit 不消耗配额（官方文档明确），拿各资源余额 */
async function fetchLimits(acc) {
  const { code, out, err } = await gh(['api', 'rate_limit'], { env: accountEnv(acc), allowFail: true });
  if (code !== 0) return { error: err.trim().split('\n')[0] };
  try {
    const r = JSON.parse(out).resources;
    return {
      core: r.core, search: r.search, graphql: r.graphql,
      mutations: r.graphql ? undefined : undefined,
    };
  } catch { return { error: '解析失败' }; }
}

const pct = (r) => (r && typeof r.limit === 'number') ? `${r.remaining}/${r.limit}` : '-';

export async function cmdCheck(name) {
  const acc = name ? assertAccount(name) : null;
  const list = name ? { [name]: acc } : getAccounts();
  const names = Object.keys(list);
  if (!names.length) { info('（还没有账户）'); return; }
  for (const n of names) {
    info(`▸ ${n}（${list[n].githubUser}）`);
    const id = await fetchGithubIdentity(list[n].token, list[n].proxy);
    if (id.error) { warn(`  token 无效: ${id.error}`); continue; }
    const lim = await fetchLimits(list[n]);
    if (lim.error) { warn(`  限额查询失败: ${lim.error}`); continue; }
    info(`  token ✓   core ${pct(lim.core)} · search ${pct(lim.search)} · graphql ${pct(lim.graphql)}`);
  }
}

export async function cmdDoctor() {
  const g = await gh(['--version'], { allowFail: true });
  if (g.code === 0) ok(`gh: ${g.out.trim().split('\n')[0]}`);
  else warn('gh 不可用（api/as/check 功能依赖 gh cli）');
  const cfg = loadConfig();
  const names = Object.keys(getAccounts(cfg));
  info(`配置: ~/.ghmux/config.json · 账户 ${names.length} 个${names.length ? `（${names.join(', ')}）` : ''}`);
  for (const n of names) {
    const a = getAccount(n, cfg);
    const miss = ['githubUser', 'email', 'token'].filter((k) => !a[k]);
    if (miss.length) warn(`  ${n}: 缺少 ${miss.join(', ')}`);
    else info(`  ${n}: 字段完整${a.proxy ? `（出口 ${a.proxy}）` : '（未配出口代理）'}`);
  }
  info('网络连通性检查请运行: ghmux check');
}
