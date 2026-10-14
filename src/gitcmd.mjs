import { die, info, ok, run, runInherit, selfPath, warn } from './util.mjs';
import { getAccount } from './store.mjs';
import { accountEnv } from './gh.mjs';
import { boundAccountName, gitTop, matchByOwner, remoteOwner } from './use.mjs';

/**
 * 解析当前仓库应使用的账户：local 绑定优先；
 * 未绑定时按 origin owner 匹配（--auto 直接采用匹配结果）。
 */
export async function resolveAccount(autoAdopt = false) {
  const top = await gitTop();
  if (!top) die('当前目录不在 git 仓库内');
  const bound = await boundAccountName();
  if (bound) {
    const acc = getAccount(bound);
    if (!acc) die(`仓库绑定的账户 "${bound}" 已不存在（ghmux unuse 解绑后重新 use）`);
    return { name: bound, acc, how: 'bound' };
  }
  const owner = await remoteOwner();
  const match = matchByOwner(owner);
  if (match && autoAdopt) {
    const acc = getAccount(match);
    info(`未绑定，但 origin owner=${owner} 匹配账户 "${match}"（--auto 采用）`);
    return { name: match, acc, how: 'auto' };
  }
  if (match) die(`仓库未绑定账户；origin owner=${owner} 匹配 "${match}"，先运行 ghmux use ${match}（或加 --auto）`);
  die('仓库未绑定账户，且无法按 origin owner 匹配；先运行 ghmux use <账户名>');
}

/** 提交前校验并纠正身份漂移（user.name/email 被手动改动的情况） */
async function ensureIdentity(name, acc) {
  const curName = (await run('git', ['config', '--local', '--get', 'user.name'], { allowFail: true })).out.trim();
  const curEmail = (await run('git', ['config', '--local', '--get', 'user.email'], { allowFail: true })).out.trim();
  if (curName === acc.name && curEmail === acc.email) return;
  warn(`身份漂移：当前 ${curName || '∅'} <${curEmail || '∅'}>，纠正为账户 ${name} 的 ${acc.name} <${acc.email}>`);
  await run('git', ['config', '--local', 'user.name', acc.name]);
  await run('git', ['config', '--local', 'user.email', acc.email]);
}

export async function cmdCommit(args) {
  const auto = extractAuto(args);
  const { name, acc, how } = await resolveAccount(auto);
  if (how === 'auto') {
    // 一次性身份注入（不写 local config，保持仓库未绑定状态）
    info(`▸ 以 ${name}（${acc.name} <${acc.email}>）提交 [--auto 一次性身份]`);
    const code = await runInherit('git', ['-c', `user.name=${acc.name}`, '-c', `user.email=${acc.email}`, 'commit', ...args]);
    if (code !== 0) die(`git commit 退出码 ${code}`, code);
  } else {
    await ensureIdentity(name, acc);
    info(`▸ 以 ${name}（${acc.name} <${acc.email}>）提交`);
    const code = await runInherit('git', ['commit', ...args]);
    if (code !== 0) die(`git commit 退出码 ${code}`, code);
  }
  const last = await run('git', ['log', '-1', '--format=%an <%ae>'], { allowFail: true });
  if (last.code === 0) ok(`提交完成，author: ${last.out.trim()}`);
}

export async function cmdPush(args) {
  const auto = extractAuto(args);
  const { name, acc, how } = await resolveAccount(auto);
  if (how !== 'auto') await ensureIdentity(name, acc);
  if (!acc.token && !acc.sshKey) warn('账户既无 token 也无 sshKey，推送可能要求手动输入凭证');
  const bits = [name, acc.githubUser];
  if (acc.proxy) bits.push(`出口 ${acc.proxy}`);
  info(`▸ 推送（${bits.join(' · ')}，认证/出口经 gh cli 通道）`);
  // 推送统一走 gh cli 通道（2026-10-14 用户定）：认证用 gh 的 credential helper
  // （GH_TOKEN env 注入后 gh auth git-credential 输出该账户 token），代理用 env
  // （https_proxy，与 api/as 同构）。-c 一次性清空继承链防 keychain 旧凭证抢先，
  // 不落盘；local config 里 use 写的 ghmux helper 继续服务手动 git push 场景。
  const extra = [
    '-c', 'credential.helper=',
    '-c', 'credential.helper=!gh auth git-credential',
  ];
  const code = await runInherit('git', [...extra, 'push', ...args], { env: accountEnv(acc) });
  if (code !== 0) die(`git push 退出码 ${code}`, code);
  ok('推送完成');
}

function extractAuto(args) {
  const i = args.indexOf('--auto');
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

/**
 * git credential helper 协议实现（use 时写进 local config 调用）。
 * stdin: protocol/host/… 键值对；get 时输出 username/password。
 * store/erase 为 no-op：token 唯一事实源是 ~/.ghmux/config.json。
 */
export async function cmdGitCredential(name, action) {
  if (!action || !['get', 'store', 'erase'].includes(action)) {
    die('内部命令：ghmux git-credential <账户> <get|store|erase>（由 git 调用）');
  }
  const acc = getAccount(name);
  if (!acc) die(`credential helper：账户 "${name}" 不存在`);
  let input = '';
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { input += d; });
    process.stdin.on('end', resolve);
    // 无 stdin 数据（EOF）时立即结束
    if (process.stdin.isTTY) resolve();
  });
  if (action === 'get' && acc.token && acc.githubUser) {
    const host = (input.match(/^host=(.+)$/m) || [])[1] || '';
    // 只应答 github.com（含子域精确匹配）；其他 host / 空 host 一律沉默
    if (/^(?:[a-z0-9-]+\.)*github\.com$/i.test(host)) {
      process.stdout.write(`username=${acc.githubUser}\npassword=${acc.token}\n`);
    }
  }
  process.exit(0);
}
