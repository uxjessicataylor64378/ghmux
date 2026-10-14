# ghmux — GitHub 多账户管理 CLI

一个零依赖（Node ≥ 20）的命令行工具，掌管 GitHub 多账户的**提交身份、推送凭证、出口 IP 与 API 限流合规**。

## 为什么

多个 GitHub 账户时最容易出的事故：

| 事故 | ghmux 的防线 |
|---|---|
| 用 A 账号的身份提交了 B 账号的仓库 | `use` 绑定仓库→账户；`commit` 校验身份、漂移自动纠正 |
| 推送时凭证串号（keychain 里旧 token 抢先） | 专用 credential helper（清空继承链，按仓库注入正确 token） |
| 多账户同出口 IP（风控信号） | 账户级 `proxy` 字段，push/api 全链路走各自受控出口 |
| 限流期间继续打 API → 官方明确会 ban | api 网关：串行锁 + 变异 ≥1s + 退避重试 + 4xx 绝不重试 |

## 快速上手

```sh
npm install -g .            # 或 npm link 开发模式

ghmux add work \
  --token ghp_xxx \
  --proxy http://127.0.0.1:7898   # 自动验证 token、回填用户名/noreply 邮箱

cd 某个仓库
ghmux use work              # 绑定：提交身份 + 凭证 + 出口写进 local config
ghmux commit -m "..."       # 提交（身份漂移自动纠正，完成后回显 author）
ghmux push                  # 推送（正确账户凭证 + 正确出口）
ghmux api user --jq .login  # gh api 网关（当前仓库账户身份）
ghmux as work -- gh pr list # 以账户身份执行任意 gh 命令
```

未绑定的仓库：`ghmux commit --auto` / `push --auto` 按 origin owner 匹配账户，
身份与凭证**一次性注入（-c 参数），不落盘**。

## 命令

```
账户   add / ls / edit --set k=v / rm / check [名字] / doctor
绑定   use <名> / which / unuse
操作   commit [git参数…] [--auto] / push [git参数…] [--auto]
API    api [--as <名>] <endpoint> [gh-api参数…] / as <名> -- <命令…>
内部   git-credential <名> <get|store|erase>（git credential helper 协议）
```

账户字段：`githubUser` `name` `email` `token` `sshKey` `proxy` `note`。
配置存于 `~/.ghmux/config.json`（0600，原子写）。

## 限流合规设计（依据 GitHub 官方 rate-limits + best-practices，2026-10 查证）

官方明确**会封号的只有两类**：限流期间继续发请求；故意忽略重复的 4xx 验证错误。
其余都是限流（403/429）不封号。`ghmux api` 按此设计：

- **串行**：跨进程锁（`~/.ghmux/api.lock`，30s 陈旧自愈）——防并发触发 secondary limit
- **变异间隔 ≥1s**：POST/PATCH/PUT/DELETE 前按时间戳文件补足（跨进程生效）
- **退避重试**：限流类失败（rate limit / secondary / abuse / 裸 429）按响应里的
  `retry-after` / `x-ratelimit-reset` 等待；没有则 ≥61s 指数退避，最多 2 次
- **绝不重试**：404 与其他 4xx（权限/参数错误重试只会加重问题）；`--no-retry` 全关
- **限额查询**：`check` 走 `GET /rate_limit`（官方不计限额端点）
- 基于 `gh` CLI 转发：继承其内建限流退避与认证管理，不裸拼 HTTP

## 出口 IP 纪律（多账户环境）

每个账户可配 `proxy`（如 `http://127.0.0.1:7898` 按地区固定出口）：

- `use` 时写入 `http.https://github.com/.proxy`（仅该仓库生效）
- `api` / `as` 注入 `https_proxy` 环境变量
- `sshKey` 场景自动生成带 `ProxyCommand`（nc connect 隧道）的 `core.sshCommand`

## 测试

```sh
node test/unit.mjs   # 限流分类 / retry-after 提取 / 方法推断，20 项
```
