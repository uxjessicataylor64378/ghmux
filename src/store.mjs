import fs from 'node:fs';
import path from 'node:path';
import { GHMUX_DIR, writeJsonAtomic } from './util.mjs';

const CONFIG_FILE = path.join(GHMUX_DIR, 'config.json');

/** 账户可设置字段（token 加密存储于同文件，权限 0600） */
export const ACCOUNT_FIELDS = [
  'githubUser', // GitHub 登录名（决定 remote owner 匹配与 credential username）
  'name',       // git 提交显示名 user.name
  'email',      // git 提交邮箱 user.email
  'token',      // PAT（api 与 HTTPS 推送凭证）
  'sshKey',     // 可选：SSH 私钥路径（SSH remote 推送用）
  'proxy',      // 可选：受控出口代理，如 http://127.0.0.1:7898
  'note',       // 备注
];

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { version: 1, accounts: {} };
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(GHMUX_DIR, { recursive: true });
  writeJsonAtomic(CONFIG_FILE, cfg);
  fs.chmodSync(CONFIG_FILE, 0o600);
}

export function getAccounts(cfg = loadConfig()) {
  return cfg.accounts ?? {};
}

export function getAccount(name, cfg = loadConfig()) {
  return getAccounts(cfg)[name] ?? null;
}

/** 校验账户存在，否则带候选列表退出 */
export function assertAccount(name, cfg = loadConfig()) {
  const acc = getAccount(name, cfg);
  if (!acc) {
    const names = Object.keys(getAccounts(cfg));
    const hint = names.length ? `\n可用账户: ${names.join(', ')}` : '\n还没有账户，先运行: ghmux add <名字>';
    console.error(`✗ 未找到账户 "${name}"${hint}`);
    process.exit(1);
  }
  return acc;
}

/** token 缺失时给出针对性提示（api/推送都靠它） */
export function requireToken(acc, name) {
  if (!acc.token) {
    console.error(`✗ 账户 "${name}" 未配置 token，请运行: ghmux edit ${name} --set token=<PAT>`);
    process.exit(1);
  }
  return acc.token;
}
