#!/usr/bin/env node
/** ghmux — GitHub 多账户管理 CLI：身份/凭证/推送/API 限流合规网关 */
import { die } from '../src/util.mjs';
import * as accounts from '../src/accounts.mjs';
import * as use from '../src/use.mjs';
import * as gitcmd from '../src/gitcmd.mjs';
import * as apigate from '../src/apigate.mjs';

const HELP = `ghmux — GitHub 多账户管理 CLI

用法: ghmux <命令> [参数]

账户管理
  add <名字> [--user <gh用户名>] [--name <显示名>] [--email <邮箱>]
             [--token <PAT>] [--proxy <http://127.0.0.1:789x>]
             [--ssh-key <路径>] [--from-gh] [--force]
                                       添加账户（缺省交互输入；自动验证 token 并
                                       回填 GitHub 用户名/邮箱，默认 noreply 邮箱）
  ls                                  列出账户
  edit <名字> --set key=value         修改字段（githubUser/name/email/token/proxy/sshKey/note）
  rm <名字>                           删除账户
  check [名字]                        验证 token + 限额余额（GET /rate_limit 不计限额）
  doctor                              环境体检（本地检查，不打网络）

仓库绑定（写 git local config，不动全局）
  use <名字>                          绑定当前仓库：提交身份 + HTTPS 凭证 + 出口代理 + SSH
  which                               查看当前绑定/身份漂移/按 origin 的匹配建议
  unuse                               解绑并清理写入的配置

日常操作
  commit [git-commit 参数…] [--auto]  校验身份（漂移自动纠正）后提交，完成后回显 author
  push   [git-push 参数…] [--auto]    以绑定账户推送（凭证/代理由 use 配置提供）

GitHub API（限流合规网关）
  api [--as <账户>] <endpoint> [gh-api 参数…]
                                       gh api 包装：跨进程串行、变异 ≥1s 间隔、
                                       限流退避重试（retry-after/≥61s 指数退避 ≤2 次）、
                                       404/4xx 绝不重试；--no-retry 关闭重试
  as <账户> -- <命令…>                 以账户身份（GH_TOKEN+出口代理）执行任意命令，
                                       如 ghmux as work -- gh pr list

细节
  git-credential <账户> <get|store|erase>   内部：credential helper 协议（git 调用）
  help / --help                          本帮助

账户配置存于 ~/.ghmux/config.json（0600）。
限流依据 GitHub 官方 rate-limits + best-practices 文档（2026-10 查证）设计。
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    case 'add': return accounts.cmdAdd(rest[0], rest.slice(1));
    case 'ls': case 'list': return accounts.cmdLs();
    case 'rm': return accounts.cmdRm(rest[0]);
    case 'edit': return accounts.cmdEdit(rest[0], rest.slice(1));
    case 'check': return accounts.cmdCheck(rest[0]);
    case 'doctor': return accounts.cmdDoctor();
    case 'use': return use.cmdUse(requireArg(rest, '用法: ghmux use <账户名>'));
    case 'which': return use.cmdWhich();
    case 'unuse': return use.cmdUnuse();
    case 'commit': return gitcmd.cmdCommit(rest);
    case 'push': return gitcmd.cmdPush(rest);
    case 'api': return apigate.cmdApi(rest);
    case 'as': return apigate.cmdAs(rest);
    case 'git-credential': return gitcmd.cmdGitCredential(rest[0], rest[1]);
    default:
      die(`未知命令 "${cmd}"，运行 ghmux help 查看用法`);
  }
}

function requireArg(rest, usage) {
  if (!rest[0]) die(usage);
  return rest[0];
}

main().catch((e) => die(e.stack || e.message));
