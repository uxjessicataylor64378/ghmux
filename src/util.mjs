import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const GHMUX_DIR = path.join(os.homedir(), '.ghmux');

export function die(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

export function info(msg) { console.log(msg); }
export function warn(msg) { console.error(`⚠ ${msg}`); }
export function ok(msg) { console.log(`✓ ${msg}`); }

/** 展开 ~ 与环境变量 */
export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 执行命令，返回 {code, out, err}。allowFail 时不抛异常 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...opts.env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (opts.allowFail) resolve({ code: 127, out: '', err: e.message });
      else die(`无法执行 ${cmd}: ${e.message}（请确认已安装并在 PATH 中）`);
    });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 继承 stdio 执行（交互/透传场景），返回退出码 */
export function runInherit(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, ...opts.env },
    });
    child.on('error', (e) => die(`无法执行 ${cmd}: ${e.message}`));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** 交互提问 */
export function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => { rl.close(); resolve(ans.trim()); });
  });
}

/** 隐藏输入提问（token 等，stty -echo）；非 TTY 时退化为普通提问 */
export async function askHidden(prompt) {
  const { execSync } = await import('node:child_process');
  if (!process.stdin.isTTY) return ask(prompt);
  process.stdout.write(prompt);
  const sttyOk = (() => { try { execSync('stty -echo', { stdio: 'inherit' }); return true; } catch { return false; } })();
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => {
    rl.question('', (ans) => {
      rl.close();
      if (sttyOk) { try { execSync('stty echo', { stdio: 'inherit' }); } catch {} }
      process.stdout.write('\n');
      resolve(ans.trim());
    });
  });
}

/** 原子写 JSON（tmp+rename），并设置 0600 权限 */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 当前 ghmux 可执行文件绝对路径（写 credential helper 用，防 PATH 漂移） */
export function selfPath() {
  let p = process.argv[1];
  try { p = fs.realpathSync(p); } catch {}
  return p;
}
