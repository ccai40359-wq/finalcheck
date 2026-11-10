import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { audit } from '../src/audit.mjs';
import { checkQ1 } from '../src/checks/q1.mjs';
import { renderReport } from '../src/report.mjs';

// 结论口径测试：未授权（等用户点头）与能力缺失（本机跑不了）必须分开判。
// 全部用临时最小项目，零依赖 lockfile → npm audit 不联网、不装包；test 脚本用 node -e 立即退出。

const LOCK = {
  name: 'probe', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'probe', version: '1.0.0', license: 'UNLICENSED' } },
};
const README = [
  '# Probe project',
  '',
  'Minimal Node.js project used by FinalCheck verdict tests. To install, run the test script:',
  '',
  '```',
  'npm install',
  'npm test',
  '```',
  '',
  'The project deliberately has zero external dependencies, so the dependency audit stays offline.',
  'It contains no secrets, no HTTP routes and no password handling.',
  '',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
].join('\n');

async function makeProject(t, { lock = true, app = "const greeting = 'hello';\nconsole.log(greeting);\n" } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-verdict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'probe', version: '1.0.0', private: true, license: 'UNLICENSED',
    scripts: { start: 'node app.js', test: 'node -e "process.exit(0)"' },
  }), 'utf8');
  if (lock) await writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(LOCK), 'utf8');
  await writeFile(path.join(dir, 'README.md'), README, 'utf8');
  await writeFile(path.join(dir, 'app.js'), app, 'utf8');
  return dir;
}

test('Q1：run=false 标 unauthorized；无 package.json 属能力缺失', async (t) => {
  const dir = await makeProject(t);
  const r = await checkQ1(dir, { tier: 'L2', run: false });
  assert.equal(r.gapKind, 'unauthorized');
  assert.match(r.coverageGap, /未授权/);
  // 保留原 coverageGap 字符串，老测试/桌面端复述不受影响
  assert.match(r.coverageGap, /Q1：未授权执行测试/);

  const empty = await mkdtemp(path.join(os.tmpdir(), 'fc-verdict-empty-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const r2 = await checkQ1(empty, { tier: 'L2', run: true });
  assert.match(r2.coverageGap, /无 package\.json/);
  assert.notEqual(r2.gapKind, 'unauthorized');
});

test('runTests=false 的 L2：Q1 只算未授权 → 待授权，不是无法验收/拦', async (t) => {
  const dir = await makeProject(t);
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false });

  assert.equal(res.conclusion.verdict, '待授权');
  assert.notEqual(res.conclusion.verdict, '无法验收');
  assert.notEqual(res.conclusion.verdict, '拦');
  assert.notEqual(res.conclusion.verdict, '过'); // 没跑测试不能算全过

  const q1 = res.gates.gapItems.find((g) => g.checkId === 'Q1');
  assert.equal(q1.kind, 'unauthorized');
  assert.deepEqual(res.conclusion.pendingAuth.map((g) => g.checkId), ['Q1']);
  // 其余计划内检查确实跑完了
  const plannedMinusQ1 = res.gates.planned.filter((id) => id !== 'Q1');
  assert.deepEqual(res.gates.executed, plannedMinusQ1);

  const text = renderReport(res);
  assert.match(text, /待授权/);
  assert.match(text, /授权后重跑：Q1 需要执行项目测试/);
  assert.ok(text.includes(`本轮覆盖：${res.gates.executed.join('/')}`), '报告必须列本轮真实覆盖列表');
  assert.match(text, /未跑：Q1/);
});

test('无 lockfile：S4 属能力缺失 → 仍判无法验收', async (t) => {
  const dir = await makeProject(t, { lock: false });
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: true });

  assert.equal(res.conclusion.verdict, '无法验收');
  const s4 = res.gates.gapItems.find((g) => g.checkId === 'S4');
  assert.equal(s4.kind, 'unavailable');
  assert.match(s4.reason, /lockfile/);
  // 能力缺失的 reason 只列应跑未跑的关
  assert.match(res.conclusion.reason, /覆盖不足/);
  assert.match(res.conclusion.reason, /S4/);
});

test('Q2 未授权路径也归为 unauthorized；能力缺失 gap 仍然压制待授权', async (t) => {
  const dir = await makeProject(t, { lock: false });
  await writeFile(path.join(dir, 'finalcheck.quality.json'), JSON.stringify({
    checks: [{ id: 'lint', command: 'node -e "process.exit(0)"' }],
  }), 'utf8');
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false });

  const q2 = res.gates.gapItems.find((g) => g.checkId === 'Q2');
  assert.equal(q2.kind, 'unauthorized');
  const q1 = res.gates.gapItems.find((g) => g.checkId === 'Q1');
  assert.equal(q1.kind, 'unauthorized');
  // S4 无 lockfile 是能力缺失 → 仍封顶无法验收（未授权不掩盖真正跑不了的关）
  assert.equal(res.conclusion.verdict, '无法验收');
});

test('无 gap：L2 全过 → 过', async (t) => {
  const dir = await makeProject(t);
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: true });

  assert.deepEqual(res.gates.gapItems, []);
  assert.equal(res.conclusion.verdict, '过');
});

test('无 gap：中危卡条目 → 修完再过', async (t) => {
  const dir = await makeProject(t, { app: "const cfg = { debug: true };\nconsole.log(cfg);\n" });
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: true });

  assert.deepEqual(res.gates.gapItems, []);
  assert.equal(res.conclusion.verdict, '修完再过');
  assert.ok(res.findings.some((f) => f.rule === 'S5.debug-on'));
});

test('无 gap：高危实锤 → 拦', async (t) => {
  const dir = await makeProject(t, { app: "const apiKey = 'abcdef1234567890';\nconsole.log(apiKey);\n" });
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: true });

  assert.deepEqual(res.gates.gapItems, []);
  assert.equal(res.conclusion.verdict, '拦');
  assert.ok(res.findings.some((f) => f.checkId === 'S3' && f.severity === 'high' && f.force === 'card'));
});

test('report：兜底文案按计划/执行生成，不再写死 S2/S6-S8 未启用', async (t) => {
  const dir = await makeProject(t);
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: true });
  const text = renderReport(res);

  assert.ok(text.includes(`本轮覆盖：${res.gates.executed.join('/')}`));
  // S6 已接线进 L2：兜底文案不得再把它列为未启用
  assert.match(text, /未启用：D1\/D2\/D3/);
  assert.ok(!/未启用：[\s\S]*\bS6\b/.test(text.split('\n').find((l) => l.includes('未启用')) || ''));
  assert.doesNotMatch(text, /S2\/S6-S8 未启用/);
  assert.doesNotMatch(text, /S2\/S6-S8/);
});
