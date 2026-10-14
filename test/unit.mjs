/** 纯函数单测：限流分类 / retry-after 提取 / 方法推断。运行: node test/unit.mjs */
import { classifyFailure, inferMethod, isMutating } from '../src/gh.mjs';

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`${ok ? '✓' : '✗'} ${desc}${ok ? '' : ` → 得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`);
}

// ── classifyFailure：只有限流类才重试，4xx 参数/权限错误绝不重试 ──
check('primary limit + retry-after → ratelimit',
  classifyFailure('gh: API rate limit exceeded for x. retry after 60s').kind, 'ratelimit');
check('secondary limit → ratelimit',
  classifyFailure('gh: You have exceeded a secondary rate limit... retry in 30 seconds').kind, 'ratelimit');
check('abuse detection → ratelimit',
  classifyFailure('gh: You have triggered an abuse detection mechanism').kind, 'ratelimit');
check('裸 429 → ratelimit',
  classifyFailure('gh: https://api.github.com/x: 429 Too Many Requests').kind, 'ratelimit');
check('404 → no-retry',
  classifyFailure('gh: https://api.github.com/repos/a/b: 404 Not Found').kind, 'no-retry');
check('403 权限（无限流字样）→ no-retry',
  classifyFailure('gh: https://api.github.com/repos/a/b: 403 Resource not accessible').kind, 'no-retry');
check('422 参数校验 → no-retry',
  classifyFailure('gh: https://api.github.com/repos/a/b: 422 Validation Failed').kind, 'no-retry');
check('网络错误 → unknown',
  classifyFailure('gh: connection refused').kind, 'unknown');
check('retry-after 提取 87s',
  classifyFailure('rate limit exceeded. retry after 87s').waitSec, 87);
check('无 retry-after → null（走 ≥61s 默认退避）',
  classifyFailure('rate limit exceeded').waitSec, null);

// ── inferMethod：gh 语义（-f/-F/--raw-field/--input 默认 POST）──
check('默认 GET', inferMethod(['user']), 'GET');
check('-f → POST', inferMethod(['-f', 'title=x', 'repos/a/b/issues']), 'POST');
check('-F → POST', inferMethod(['-F', 'n=1', 'repos/a/b']), 'POST');
check('--method DELETE', inferMethod(['--method', 'DELETE', 'repos/a/b']), 'DELETE');
check('-X PATCH', inferMethod(['-X', 'PATCH', 'repos/a/b']), 'PATCH');
check('--include 不误判为 POST', inferMethod(['--include', 'user']), 'GET');
check('--input → POST', inferMethod(['--input', 'f.json', 'repos/a/b']), 'POST');

// ── isMutating ──
check('POST 是变异', isMutating('POST'), true);
check('GET 非变异', isMutating('GET'), false);
check('DELETE 是变异', isMutating('DELETE'), true);

console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail} 项失败 / ${pass} 项通过`);
process.exit(fail === 0 ? 0 : 1);
