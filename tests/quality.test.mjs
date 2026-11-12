import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { audit } from '../src/audit.mjs';
import {
  QUALITY_FILE, parseCoverage, normalizeQualityConfig, checkQuality, hasQualityConfig
} from '../src/checks/quality.mjs';

async function tmpProject(config) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-quality-'));
  if (config !== undefined) await writeFile(path.join(dir, QUALITY_FILE), JSON.stringify(config), 'utf8');
  return dir;
}

// 注入 runner：单测不真的起进程，超时/慢命令都靠假结果
const fake = (fn) => async (command, cwd, timeoutMs) => fn({ command, cwd, timeoutMs });

test('parseCoverage：istanbul 表格 / text-summary / Lines 三种形状都认得', () => {
  assert.equal(parseCoverage('| All files | 82.51 | 70.1 | 88.8 | 82.5 |'), 82.51);
  assert.equal(parseCoverage('Statements   : 64.2% ( 9/14 )'), 64.2);
  assert.equal(parseCoverage('Lines        : 71.43% ( 10/14 )'), 71.43);
  assert.equal(parseCoverage('no numbers here'), null);
});

test('normalizeQualityConfig：坏字段收敛（缺 id/超长 timeout/非法 severity）', () => {
  const [a, b] = normalizeQualityConfig({
    checks: [
      { command: 'npm test', timeoutMs: 99999999, severity: 'boom' },
      { id: 'lint', command: 'npx eslint .', timeoutMs: 1, optional: true, maxMs: 0 }
    ]
  });
  assert.equal(a.id, 'check1');
  assert.equal(a.timeoutMs, 600000); // 上限 10 分钟
  assert.equal(a.severity, 'high');
  assert.equal(b.timeoutMs, 3000); // 下限 3 秒
  assert.equal(b.maxMs, null);
  assert.equal(b.optional, true);
});

test('checkQuality：没配置 → coverageGap，不产生假的「通过」', async () => {
  const dir = await tmpProject(undefined);
  try {
    assert.equal(await hasQualityConfig(dir), false);
    const r = await checkQuality(dir, { tier: 'L2' });
    assert.deepEqual(r.findings, []);
    assert.match(r.coverageGap, /未找到/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkQuality：run=false（外部项目未授权）→ coverageGap，不执行命令', async () => {
  const dir = await tmpProject({ checks: [{ id: 'tests', command: 'npm test' }] });
  let called = 0;
  try {
    const r = await checkQuality(dir, { tier: 'L3', run: false, runner: fake(() => { called++; return { code: 0, ms: 10 }; }) });
    assert.equal(called, 0);
    assert.match(r.coverageGap, /未授权/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkQuality：命令 exit≠0 → 高危 finding（L3 是 card）', async () => {
  const dir = await tmpProject({ checks: [{ id: 'tests', command: 'npm test' }] });
  try {
    const r = await checkQuality(dir, {
      tier: 'L3',
      runner: fake(() => ({ code: 2, ms: 1200, out: '', err: 'token = "abcdef123456" 3 failed' }))
    });
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.equal(f.rule, 'Q2.tests-failed');
    assert.equal(f.force, 'card');
    assert.equal(f.severity, 'high');
    assert.match(f.snippet, /exit 2/);
    assert.doesNotMatch(f.message, /abcdef123456/); // 输出里的密钥值被打码
    assert.equal(r.runs[0].code, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkQuality：超时 → timeout finding；optional 项降为 tip', async () => {
  const dir = await tmpProject({ checks: [{ id: 'bench', command: 'node bench.mjs', optional: true }] });
  try {
    const r = await checkQuality(dir, { tier: 'L2', runner: fake(() => ({ code: 124, ms: 5000, timedOut: true, out: '', err: '' })) });
    assert.equal(r.findings[0].rule, 'Q2.bench-timeout');
    assert.equal(r.findings[0].severity, 'tip');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkQuality：maxMs 超阈值 → slow；expect 不匹配 → expect', async () => {
  const dir = await tmpProject({
    checks: [{ id: 'bench', command: 'node bench.mjs', maxMs: 500, expect: 'p95=' }]
  });
  try {
    const r = await checkQuality(dir, { tier: 'L2', runner: fake(() => ({ code: 0, ms: 900, out: 'p50=12', err: '' })) });
    const rules = r.findings.map((f) => f.rule).sort();
    assert.deepEqual(rules, ['Q2.bench-expect', 'Q2.bench-slow']);
    assert.deepEqual(r.runs.map((x) => ({ id: x.id, code: x.code, ms: x.ms, slow: x.slow, expectOk: x.expectOk })),
      [{ id: 'bench', code: 0, ms: 900, slow: true, expectOk: false }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkQuality：覆盖率低于 minPercent → 高危', async () => {
  const dir = await tmpProject({ checks: [{ id: 'cover', command: 'npx c8 npm test', minPercent: 40 }] });
  try {
    const r = await checkQuality(dir, { tier: 'L2', runner: fake(() => ({ code: 0, ms: 800, out: 'Statements   : 12.5% ( 1/8 )', err: '' })) });
    assert.equal(r.findings[0].rule, 'Q2.cover-coverage');
    assert.equal(r.findings[0].severity, 'high');
    assert.match(r.findings[0].message, /12\.5%/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkQuality：必填覆盖率解析不出来 → finding，不编数字或判过', async () => {
  const dir = await tmpProject({ checks: [{ id: 'cover', command: 'npm test', minPercent: 40 }] });
  try {
    const r = await checkQuality(dir, { tier: 'L2', runner: fake(() => ({ code: 0, ms: 800, out: 'all good', err: '' })) });
    assert.equal(r.findings[0].rule, 'Q2.cover-coverage-missing');
    assert.match(r.findings[0].message, /没能.*解析出覆盖率/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('audit 集成：有 quality.json 才把 Q2 加进计划；runTests=false 记 gap', async () => {
  const dir = await tmpProject({ checks: [{ id: 'ok', command: 'node -e "process.exit(0)"' }] });
  try {
    await writeFile(path.join(dir, 'README.md'), '# demo\n', 'utf8');
    const r1 = await audit(dir, { tier: 'L2', interactive: true, runTests: true });
    assert.ok(r1.gates.planned.includes('Q2'));
    assert.ok(r1.gates.executed.includes('Q2'));
    assert.equal(r1.findings.filter((f) => f.checkId === 'Q2').length, 0);

    const r2 = await audit(dir, { tier: 'L2', interactive: true, runTests: false });
    assert.ok(r2.gates.planned.includes('Q2'));
    assert.match(r2.gates.gaps.join(' '), /Q2/); // 未授权执行 → 明确记缺口
    assert.equal(r2.gates.executed.includes('Q2'), false);

    const r3 = await audit(dir, { tier: 'L1', interactive: true, runTests: true }); // L1 没有 Q2
    assert.equal(r3.gates.planned.includes('Q2'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
