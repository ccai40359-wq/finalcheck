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

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
