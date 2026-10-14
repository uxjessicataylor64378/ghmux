import { GHMUX_DIR, run } from './util.mjs';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_FILE = path.join(GHMUX_DIR, 'api.lock');
const MUTATE_TS = path.join(GHMUX_DIR, 'last-mutate.json');
const LOCK_STALE_MS = 30_000;
export const MUTATE_MIN_GAP_MS = 1000; // 官方 best-practices：变异请求间隔 ≥1s

/**
 * 跨进程串行锁（官方建议请求串行/队列化，防触发 secondary limit 并发检测）。
 * 陈旧锁 30s 自动接管，避免残留死锁。
 */
export async function withApiLock(fn) {
  fs.mkdirSync(GHMUX_DIR, { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK_FILE); continue; }
      } catch { /* 刚被释放，重试 */ }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

/** 变异请求最小间隔：不足 1s 补足等待（跨进程，时间戳文件） */
export async function throttleMutation() {
  let last = 0;
  try { last = JSON.parse(fs.readFileSync(MUTATE_TS, 'utf8')).at; } catch {}
  const wait = last + MUTATE_MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  fs.writeFileSync(MUTATE_TS, JSON.stringify({ at: Date.now() }), { mode: 0o600 });
}

/** 从 gh api 参数推断 HTTP 方法（gh 语义：带 -f/-F/--raw-field/--input 默认 POST） */
export function inferMethod(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-X' || args[i] === '--method') return (args[i + 1] || 'GET').toUpperCase();
    if (args[i].startsWith('--method=')) return args[i].split('=')[1].toUpperCase();
  }
  // gh api 语义：-f/--raw-field、-F/--field、--input 都会把默认方法变为 POST
  const mutatingFlags = ['-f', '--raw-field', '-F', '--field', '--input'];
  for (let i = 0; i < args.length; i++) {
    if (mutatingFlags.includes(args[i])) return 'POST';
  }
  return 'GET';
}

export const isMutating = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(method);

/**
 * 限流判定：只有限流类才值得等。
 * - 真实限流（primary/secondary）的响应体含 rate limit / secondary rate / abuse / too many requests
 * - 裸 429 保守视为限流；裸 403 是权限不足（无关键词），404 与其他 4xx 是参数/权限错误——
 *   绝不重试：官方明确「故意忽略重复的 4xx 验证错误」会被 suspension。
 */
export function classifyFailure(stderr) {
  const s = (stderr || '').toLowerCase();
  if (/rate limit|secondary rate|abuse detection|too many requests/.test(s)) {
    const m = s.match(/retry (?:after|in) (\d+)/) || s.match(/x-ratelimit-reset[^0-9]*(\d+)/);
    return { kind: 'ratelimit', waitSec: m ? Math.min(Number(m[1]), 3600) : null };
  }
  if (/: 429\b/.test(s)) return { kind: 'ratelimit', waitSec: null };
  if (/: 4\d\d\b/.test(s)) return { kind: 'no-retry' }; // 404/403/400…：重试只会加重问题
  return { kind: 'unknown' };
}

/** 执行 gh（供各模块复用：统一 env 注入） */
export function gh(args, { env = {}, allowFail = false } = {}) {
  return run('gh', args, { env, allowFail });
}

/** 以某账户身份生成 gh 环境变量：token + 受控出口代理 */
export function accountEnv(acc) {
  const env = {};
  if (acc?.token) {
    env.GH_TOKEN = acc.token;
    env.GITHUB_TOKEN = acc.token;
  }
  if (acc?.proxy) {
    env.https_proxy = acc.proxy;
    env.HTTPS_PROXY = acc.proxy;
  }
  return env;
}
