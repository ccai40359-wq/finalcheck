// 跨版本可用的测试入口：显式列出 tests/*.test.mjs 交给 node --test。
// 原因：Node 20 不认识 `node --test "tests/*.test.mjs"` 这种 glob，Node 24 也不接受目录参数；
// 这里统一由一个脚本枚举文件，本地和 CI 用完全相同的命令。
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const dir = path.join(process.cwd(), 'tests');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join('tests', f));

if (!files.length) {
  console.error('no test files found under tests/');
  process.exit(1);
}

// 单测默认不真跑 Trivy / Semgrep（每个 audit 用例跑一次会慢到分钟级且依赖网络下载漏洞库）；
// Trivy 映射逻辑由注入 runner 的用例覆盖。需要真跑时显式 FINALCHECK_TRIVY=on。
const env = { ...process.env, FINALCHECK_TRIVY: process.env.FINALCHECK_TRIVY || 'off', FINALCHECK_SEMGREP: process.env.FINALCHECK_SEMGREP || 'off' };

// 并发上限：默认不限制时 node --test 会按 CPU 核数开并行。
// 本项目有一批「真实等待」的测试（后台任务要等命令几秒、模拟网关要等子代理 800ms、
// 回合墙钟要等 300ms 定时器）。在 2 核 CI 上，2256 个用例全挤两个核里，
// 这几条会被饿死到 "cancelledByParent / Promise resolution is still pending"，
// 表现为「本地全绿、CI 红」。压到 4 之后重活有时间片，本地 16 核也不明显变慢。
// 需要更快时可 FC_TEST_CONCURRENCY=8 npm test（但要留意上面这批测试是否会抖）。
const concurrency = String(process.env.FC_TEST_CONCURRENCY || '4');
const args = [`--test-concurrency=${concurrency}`, '--test', ...files];
const r = spawnSync(process.execPath, args, { stdio: 'inherit', env });
process.exit(r.status ?? 1);
