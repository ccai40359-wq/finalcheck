// 模拟客户端测试台（0.26）：每次 npm test 都跑一遍「真人用法」剧本与工具层套件。
// 每个剧本一个独立子进程（环境变量 / 模块单例互不影响），全部在临时目录里跑，不碰真实数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIM = path.join(ROOT, 'scripts', 'sim');
const scenarios = readdirSync(path.join(SIM, 'scenarios')).filter((f) => f.endsWith('.json'));

for (const f of scenarios) {
  const sc = JSON.parse(readFileSync(path.join(SIM, 'scenarios', f), 'utf8'));
  if (!sc.mock) continue; // 只有真模型版本的剧本不进单测
  test(`模拟客户端剧本：${sc.name} — ${sc.description || ''}`.slice(0, 200), () => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'fc-simtest-'));
    const r = spawnSync(process.execPath, [path.join(SIM, 'run.mjs'), path.join(SIM, 'scenarios', f), '--out', out], { encoding: 'utf8', timeout: 180000 });
    let report = '';
    try { report = readFileSync(path.join(out, 'report.md'), 'utf8'); } catch { /* 没跑到报告 */ }
    assert.equal(r.status, 0, `剧本未通过：\n${report || r.stdout + r.stderr}`);
  });
}

test('工具层套件（不接模型）：读/搜/改/写/命令/长输出落盘可读/越界拒绝/回滚', () => {
  const r = spawnSync(process.execPath, [path.join(SIM, 'tools.mjs')], { encoding: 'utf8', timeout: 180000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
