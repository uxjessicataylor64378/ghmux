import { die, info, ok, run, selfPath, warn } from './util.mjs';
import { assertAccount, getAccount, getAccounts } from './store.mjs';

/** 当前目录是否在 git 仓库内，返回 toplevel 绝对路径 */
export async function gitTop() {
  const r = await run('git', ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (r.code !== 0) return null;
  return r.out.trim();
}

/** 本地 ghmux 绑定（写在 git local config 的 ghmux.account） */
export async function boundAccountName() {
  const r = await run('git', ['config', '--local', '--get', 'ghmux.account'], { allowFail: true });
  return r.code === 0 ? r.out.trim() : null;
}

/** 读 origin remote 的 owner（https 或 ssh 形态），用于未绑定时自动匹配账户 */
export async function remoteOwner() {
  const r = await run('git', ['remote', 'get-url', 'origin'], { allowFail: true });
  if (r.code !== 0) return null;
  const url = r.out.trim();
  const m = url.match(/github\.com[/:]([^/]+)\//i) || url.match(/github\.com[/:]([^]+)$/i);
  return m ? m[1].toLowerCase() : null;
}

/** 按 remote owner 匹配账户（大小写不敏感） */
export function matchByOwner(owner) {
  if (!owner) return null;
  for (const [name, acc] of Object.entries(getAccounts())) {
    if (acc.githubUser?.toLowerCase() === owner) return name;
  }
  return null;
}

async function gitSet(args) {
  const r = await run('git', args, { allowFail: true });
  if (r.code !== 0) die(`git config 失败: git ${args.join(' ')}\n${r.err}`);
}

/** unset 类操作：键不存在（退出码 5）是正常情况，静默通过 */
async function gitUnset(args) {
  await run('git', args, { allowFail: true });
}

/** use 写入的完整 local config 键列表（unuse 按此清理） */
function configKeys(acc) {
  const keys = ['user.name', 'user.email', 'ghmux.account'];
  if (acc.proxy) keys.push('http.https://github.com/.proxy');
  if (acc.sshKey) keys.push('core.sshCommand');
  return keys;
}

export async function cmdUse(name) {
  const acc = assertAccount(name);
  const top = await gitTop();
  if (!top) die('当前目录不在 git 仓库内（ghmux 以仓库为单位绑定账户）');
  const hasToken = Boolean(acc.token);
  if (!hasToken) warn('该账户无 token：HTTPS 推送将无法自动认证（ghmux edit 补 token）');

  // 清掉旧绑定可能遗留的键，再写新值
  const prev = await boundAccountName();
  if (prev && prev !== name) {
    const prevAcc = getAccount(prev);
    if (prevAcc) for (const k of configKeys(prevAcc)) await gitUnset(['config', '--local', '--unset-all', k]);
  }

  await gitSet(['config', '--local', 'user.name', acc.name]);
  await gitSet(['config', '--local', 'user.email', acc.email]);
  await gitSet(['config', '--local', 'ghmux.account', name]);

  // 凭证：空条目（--add 保证不被后续 set 替换）清空 system/global 继承的 helper 链
  // （Xcode 系统层注入的 osxkeychain 会抢先返回旧凭证，多 helper 语义先到先得），
  // 再追加本账户专用 helper。
  await gitUnset(['config', '--local', '--unset-all', 'credential.helper']);
  await gitSet(['config', '--local', '--add', 'credential.helper', '']);
  await gitSet(['config', '--local', '--add', 'credential.helper', `!${selfPath()} git-credential ${name}`]);

  if (acc.proxy) {
    await gitSet(['config', '--local', 'http.https://github.com/.proxy', acc.proxy]);
  }
  if (acc.sshKey) {
    // ssh 走 http 代理需 ProxyCommand；macOS 自带 nc 支持 connect 隧道
    let cmd = `ssh -i ${acc.sshKey} -o IdentitiesOnly=yes`;
    if (acc.proxy) {
      const m = acc.proxy.match(/^https?:\/\/([^/]+):(\d+)/);
      if (m) cmd += ` -o ProxyCommand='nc -X connect -x ${m[1]}:${m[2]} %h %p'`;
    }
    await gitSet(['config', '--local', 'core.sshCommand', cmd]);
  }

  ok(`${top}`);
  ok(`已绑定 ${name} → ${acc.githubUser} <${acc.email}>${acc.proxy ? ` · 出口 ${acc.proxy}` : ''}`);
  info('提交身份、HTTPS 凭证、出口代理已写入 local config（不影响其他仓库与全局配置）');
}

export async function cmdUnuse() {
  const top = await gitTop();
  if (!top) die('不在 git 仓库内');
  const name = await boundAccountName();
  if (!name) { info('当前仓库未绑定 ghmux 账户'); return; }
  const acc = getAccount(name);
  const keys = ['user.name', 'user.email', 'ghmux.account', 'credential.helper'];
  if (acc?.proxy) keys.push('http.https://github.com/.proxy');
  if (acc?.sshKey) keys.push('core.sshCommand');
  for (const k of keys) await gitUnset(['config', '--local', '--unset-all', k]);
  ok(`已解绑 ${name}（user/凭证/代理配置已移除，回到全局默认）`);
}

export async function cmdWhich() {
  const top = await gitTop();
  if (!top) { info('不在 git 仓库内'); return; }
  const name = await boundAccountName();
  const user = (await run('git', ['config', '--local', '--get', 'user.name'], { allowFail: true })).out.trim();
  const email = (await run('git', ['config', '--local', '--get', 'user.email'], { allowFail: true })).out.trim();
  if (!name) {
    info(`仓库: ${top}\n未绑定账户（当前 local 身份: ${user || '未设置'} <${email || '未设置'}>）`);
    const owner = await remoteOwner();
    const match = matchByOwner(owner);
    if (match) info(`检测到 origin owner = ${owner}，匹配账户 "${match}"，运行 ghmux use ${match} 绑定`);
    return;
  }
  const acc = getAccount(name);
  if (!acc) { warn(`绑定的账户 "${name}" 已被删除（ghmux unuse 清理）`); return; }
  const drift = (user !== acc.name || email !== acc.email);
  info(`仓库: ${top}\n账户: ${name} → ${acc.githubUser} <${acc.email}>${acc.proxy ? `\n出口: ${acc.proxy}` : ''}${acc.sshKey ? `\nSSH:  ${acc.sshKey}` : ''}`);
  if (drift) warn(`local 身份已被改动（当前 ${user} <${email}>），ghmux commit 会自动纠正回账户身份`);
  // 绑定与 remote 归属不一致：容易推错号（提交身份 A、推送凭证 B）
  const owner = await remoteOwner();
  if (owner && acc.githubUser?.toLowerCase() !== owner) {
    warn(`origin owner 是 "${owner}"，与绑定账户 "${acc.githubUser}" 不一致——确认没绑错（ghmux use <正确账户> 切换）`);
  }
}
