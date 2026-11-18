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
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
process.exit(r.status ?? 1);
