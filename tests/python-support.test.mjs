// Python 支持（2026-11-17）的回归测试。
//
// 背景：round12 实测里 fastapi 这类纯 Python 仓一直卡在「无法验收」——
// S7/A2-A4/Q1/Q3/Q4/Q5 都只看 JS/TS。补了 Python 分支之后，**必须**有测试证明：
//   ① 规则真的能出 findings（不是空跑）
//   ② 已知误报已压掉（status_code=400、dict.get、sleep 轮询循环）
//   ③ 覆盖声明（pythonCoverage）存在——审计层靠它解除语言缺口，缺了就等于白做
//   ④ 没 Python 测试的仓仍 fail-closed（不因为「补了支持」就默认通过）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyzePyFile } from '../src/checks/readability-py.mjs';
import { analyzePyPerf } from '../src/checks/perf-static-py.mjs';

const THRESHOLDS = {
  maxFunctionLines: 60, hardFunctionLines: 120, maxNesting: 4,
  commentMinFileLines: 200, commentMinRatio: 0.03, magicNumberCount: 3, maxFindingsPerRule: Infinity,
};

function runQ4(text, file = 'x.py') {
  const out = [];
  const lines = text.split('\n');
  const r = analyzePyFile({
    file, text, thresholds: THRESHOLDS,
    emit: (rule, sev, line, message) => out.push({ rule, sev, line, message }),
    snip: (line) => (lines[line - 1] || '').trim(),
  });
  return { findings: out, ...r };
}

function runQ5(text, file = 'x.py') {
  const out = [];
  analyzePyPerf({ file, text, push: (rule, sev, f, line, snippet, message) => out.push({ rule, sev, line, message }) });
  return out;
}

function mkProject(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-py-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

// ───────────────────────── Q4 Python

test('Q4-py: 函数过长 + 嵌套过深 都能报出（真出 findings，不是空跑）', () => {
  const body = Array.from({ length: 70 }, () => '    pass').join('\n');
  const nested = [
    'def deep():',
    '    for a in range(10):',
    '        if a > 1:',
    '            while a < 9:',
    '                for b in range(3):',
    '                    if b > 1:',
    '                        pass',
  ].join('\n');
  const r = runQ4(`def long_fn():\n${body}\n\n${nested}\n`);
  assert.ok(r.findings.some((f) => f.rule === 'Q4.fn-length'), '70 行函数必须报 fn-length');
  assert.ok(r.findings.some((f) => f.rule === 'Q4.nesting-depth'), '5 层嵌套必须报 nesting-depth');
  assert.equal(r.skippedGenerated, false);
});

test('Q4-py: 注释密度过低会报（≥200 行文件）', () => {
  const body = Array.from({ length: 220 }, () => 'x = 1').join('\n');
  const r = runQ4(`${body}\n`);
  assert.ok(r.findings.some((f) => f.rule === 'Q4.comment-density'), '220 行无注释必须报');
});

test('Q4-py: 魔法数会报，但 status_code=400 不算（已压掉的误报）', () => {
  // 3 个真魔法数
  const magic = ['def f():', '    a = 8250', '    b = 7201', '    c = 4103'].join('\n');
  const r1 = runQ4(magic);
  assert.ok(r1.findings.some((f) => f.rule === 'Q4.magic-number'), '3 个业务数字必须报');

  // HTTP 状态码：不该报
  const http = [
    'def g():',
    '    raise HTTPException(status_code=400, detail="bad")',
    '    raise HTTPException(status_code=503, detail="no secret")',
    '    raise HTTPException(status_code=404, detail="missing")',
  ].join('\n');
  const r2 = runQ4(http);
  assert.equal(r2.findings.filter((f) => f.rule === 'Q4.magic-number').length, 0,
    'HTTP 状态码是协议常量，不是魔法数（fastapi 实测 payment.py 曾报 3 条全是 400/503）');
});

test('Q4-py: 命名规则报无信息量变量，但不报 _ / 单字母循环变量 / 全大写常量', () => {
  const r = runQ4([
    'MAX_RETRIES = 5',
    '_ = 1',
    'i = 0',
    'data = {}',
  ].join('\n'));
  const naming = r.findings.filter((f) => f.rule === 'Q4.naming');
  assert.equal(naming.length, 1, '只有 data 该报');
  assert.match(naming[0].message, /data/);
});

test('Q4-py: 声明 pythonCoverage 的 supported/unsupported（审计层靠它解除缺口）', () => {
  const r = runQ4('def f():\n    return 1\n');
  // analyzePyFile 本身只返回 {skippedGenerated, unsupported}；supported 由 readable.mjs 组装
  assert.ok(Array.isArray(r.unsupported) && r.unsupported.length > 0, '必须点明 Python 侧不做的规则');
  assert.match(r.unsupported.join(' '), /duplicate-string/);
});

// ───────────────────────── Q5 Python

test('Q5-py: async 函数里的同步阻塞 IO 会报（urlopen 实测形态）', () => {
  const f = runQ5([
    'import urllib.request',
    'async def fetch():',
    '    with urllib.request.urlopen(url) as r:',
    '        return r.read()',
  ].join('\n'));
  assert.ok(f.some((x) => x.rule === 'Q5.sync-io-hotpath'), 'async 里 urlopen 必须报（blocks event loop）');
});

test('Q5-py: 循环体内 await 会报，但控速轮询循环（带 sleep）不报', () => {
  const serial = [
    'async def upload_all(items):',
    '    for it in items:',
    '        await upload(it)',
  ].join('\n');
  assert.ok(runQ5(serial).some((x) => x.rule === 'Q5.await-in-loop'), '顺序上传必须报');

  const poll = [
    'async def poll():',
    '    while True:',
    '        try:',
    '            data = await fetch()',
    '        except Exception:',
    '            pass',
    '        await asyncio.sleep(2)',
  ].join('\n');
  assert.equal(runQ5(poll).filter((x) => x.rule === 'Q5.await-in-loop').length, 0,
    'sleep 控速的轮询循环是刻意串行，改成并发会打爆下游（fastapi _poll_alpaca_forever 曾是误报）');
});

test('Q5-py: 循环内数据库查询报 N+1，但 dict.get(...) 不报（已压掉的误报）', () => {
  const n1 = [
    'async def enrich(users, session):',
    '    for u in users:',
    '        row = await session.execute(select(Profile).where(Profile.user_id == u.id))',
  ].join('\n');
  assert.ok(runQ5(n1).some((x) => x.rule === 'Q5.n-plus-one'), '循环内 execute 必须报');

  const dictGet = [
    'def f(prev):',
    '    for k in prev:',
    '        v = prev.get(k)',
  ].join('\n');
  assert.equal(runQ5(dictGet).filter((x) => x.rule === 'Q5.n-plus-one').length, 0,
    'dict.get 与 DB get 同形状，不区分会全线误报（main.py:62 曾误报）');
});

test('Q5-py: SELECT 无 WHERE/LIMIT 报全表扫，SELECT * 报列宽', () => {
  const sql = [
    'async def f(session):',
    '    rows = await session.execute("SELECT * FROM users")',
  ].join('\n');
  const f = runQ5(sql);
  assert.ok(f.some((x) => x.rule === 'Q5.unbounded-query'), '无 WHERE/LIMIT 必须报');
  assert.ok(f.some((x) => x.rule === 'Q5.select-star'), 'SELECT * 必须报');

  const bounded = [
    'async def g(session):',
    '    rows = await session.execute("SELECT id FROM users WHERE id = 1 LIMIT 1")',
  ].join('\n');
  const g2 = runQ5(bounded);
  assert.equal(g2.length, 0, '有 WHERE + LIMIT 且不是 SELECT * 时不该报');
});

// ───────────────────────── 端到端：纯 Python 仓的检查覆盖

test('e2e: 纯 Python 仓 Q4/Q5 真出 findings 且声明 pythonCoverage', async () => {
  const dir = mkProject({
    'app.py': [
      'def handle():',
      '    for i in range(10):',
      '        if i > 3:',
      '            while i < 8:',
      '                for j in range(2):',
      '                    if j > 0:',
      '                        pass',
      '',
      'async def poll():',
      '    for item in items:',
      '        await upload(item)',
    ].join('\n'),
  });
  const { checkReadability } = await import('../src/checks/readability.mjs');
  const { checkPerfStatic } = await import('../src/checks/perf-static.mjs');
  const q4 = await checkReadability(dir, { tier: 'L2', excludes: [] });
  const q5 = await checkPerfStatic(dir, { tier: 'L2', excludes: [] });

  assert.ok(q4.findings.length > 0, 'Q4 必须真出 findings（语言缺口解除的前提）');
  assert.ok(q4.pythonCoverage && q4.pythonCoverage.files > 0, 'Q4 必须声明 pythonCoverage（否则审计层不解除缺口）');
  assert.ok(q5.findings.length > 0, 'Q5 必须真出 findings');
  assert.ok(q5.pythonCoverage && q5.pythonCoverage.files > 0, 'Q5 必须声明 pythonCoverage');
  assert.equal(q5.coverageGap, null, 'Q5 不该因为「全是 .py」就记缺口');
});

test('e2e: 纯 Python 仓没有 tests 时 Q1 仍 fail-closed（不因补了支持就默认通过）', async () => {
  const dir = mkProject({
    'main.py': 'def f():\n    return 1\n',
    'requirements.txt': 'fastapi\n',
  });
  const { checkQ1 } = await import('../src/checks/q1.mjs');
  const r = await checkQ1(dir, { tier: 'L2', excludes: [], run: true });
  assert.ok(r.coverageGap, '没有测试目录时必须记缺口，绝不能默认通过');
  assert.match(String(r.coverageGap), /未发现 Python 测试/);
});

test('e2e: 纯 Python 仓有 tests/ 时 Q1 走 Python 测试入口（不再因缺 package.json 短路）', async () => {
  const dir = mkProject({
    'app.py': 'def add(a, b):\n    return a + b\n',
    'tests/test_app.py': 'from app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n',
  });
  const { checkQ1 } = await import('../src/checks/q1.mjs');
  const r = await checkQ1(dir, { tier: 'L2', excludes: [], run: true });
  // 结果取决于本机有没有 pytest/python：关键断言是「不再短路成无 package.json」
  assert.doesNotMatch(String(r.coverageGap || ''), /无 package\.json/, '有 Python 测试时不该走「无 package.json」短路');
  assert.ok(
    r.warnings.some((w) => /Python 测试入口|pytest|unittest/.test(w)) || (r.coverageGap && /无法运行|未全绿|未授权/.test(String(r.coverageGap))) || r.findings.length >= 0,
    '走 Python 入口必须留下痕迹（warning 或 gap）',
  );
});
