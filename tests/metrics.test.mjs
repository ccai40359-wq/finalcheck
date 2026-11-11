import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { checkMetrics, checkQ3 } from '../src/checks/metrics.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-q3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeLines(dir, name, count, make = (i) => `const value${i} = ${i};`) {
  const body = Array.from({ length: count }, (_, i) => make(i)).join('\n');
  await writeFile(path.join(dir, name), body + '\n');
  return body.split('\n').length;
}

const byRule = (r, rule) => r.findings.filter((f) => f.rule === rule);

test('Q3 返回契约 + 超 800 行 → medium；L2 check / L3 card', async (t) => {
  const dir = await tmp(t);
  await writeLines(dir, 'big.js', 850);
  const l2 = await checkMetrics(dir, { tier: 'L2' });
  assert.deepEqual(Object.keys(l2).sort(), ['checkId', 'coverageGap', 'findings', 'warnings']);
  assert.equal(l2.checkId, 'Q3');
  assert.equal(l2.coverageGap, null);
  const f = byRule(l2, 'Q3.large-file')[0];
  assert.ok(f);
  assert.deepEqual(Object.keys(f).sort(), ['checkId', 'file', 'force', 'line', 'message', 'rule', 'severity', 'snippet', 'source']);
  assert.equal(f.source, 'program');
  assert.equal(f.severity, 'medium');
  assert.equal(f.force, 'check');
  const l3 = await checkMetrics(dir, { tier: 'L3' });
  assert.equal(byRule(l3, 'Q3.large-file')[0].force, 'card');
  assert.equal(checkQ3, checkMetrics, 'checkQ3 别名指向同一实现');
});

test('Q3 超过 1500 行 → high', async (t) => {
  const dir = await tmp(t);
  await writeLines(dir, 'huge.js', 1600);
  const r = await checkMetrics(dir, { tier: 'L2' });
  const f = byRule(r, 'Q3.large-file')[0];
  assert.equal(f.severity, 'high');
  assert.match(f.message, /1600 行/);
});

test('Q3 metrics.maxFileLines 配置覆盖默认 800 阈值（双向）', async (t) => {
  const dir = await tmp(t);
  await writeLines(dir, 'big.js', 850);
  await writeFile(path.join(dir, 'finalcheck.config.json'), JSON.stringify({ metrics: { maxFileLines: 1000 } }));
  const relaxed = await checkMetrics(dir, { tier: 'L2' });
  assert.equal(byRule(relaxed, 'Q3.large-file').length, 0, '850 行低于配置的 1000 行阈值');

  await writeFile(path.join(dir, 'finalcheck.config.json'), JSON.stringify({ metrics: { maxFileLines: 500 } }));
  const strict = await checkMetrics(dir, { tier: 'L2' });
  const f = byRule(strict, 'Q3.large-file')[0];
  assert.ok(f, '850 行超过配置的 500 行阈值');
  assert.equal(f.severity, 'medium');
  assert.match(f.snippet, /500/);
});

test('Q3 同一 6 行块出现在 3 个文件 → medium，报文件:行 + 次数，最多 1 条', async (t) => {
  const dir = await tmp(t);
  const block = [
    'const alphaValue = computeAlpha(input);',
    'const betaValue = computeBeta(alphaValue);',
    'if (betaValue > thresholdValue) {',
    '  return betaValue;',
    '}',
    'const gammaValue = betaValue + 1;',
  ];
  for (const [name, suffix] of [['a.js', 'A'], ['b.js', 'B'], ['c.js', 'C']]) {
    await writeFile(path.join(dir, name), ['const input = 1;', ...block, `const unique${suffix} = 1;`].join('\n') + '\n');
  }
  const r = await checkMetrics(dir, { tier: 'L2' });
  const hits = byRule(r, 'Q3.duplicate-block');
  assert.equal(hits.length, 1, 'overlapping windows of the same block must be de-duplicated');
  assert.equal(hits[0].severity, 'medium');
  assert.match(hits[0].message, /共 3 处/);
  assert.match(hits[0].snippet, /\.js:\d+ × 3/);
  assert.equal(hits[0].force, 'check');
});

test('Q3 A→B→A 相对导入环 → high，列出环上文件', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'a.mjs'), "import { b } from './b.mjs';\nexport const a = 1;\n");
  await writeFile(path.join(dir, 'b.mjs'), "import { a } from './a.mjs';\nexport const b = 2;\n");
  const r = await checkMetrics(dir, { tier: 'L2' });
  const hits = byRule(r, 'Q3.import-cycle');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].severity, 'high');
  assert.match(hits[0].snippet, /a\.mjs → b\.mjs → a\.mjs/);
  assert.equal(byRule(r, 'Q3.unused-export').length, 0, 'mutual imports count as usage');
});

test('Q3 未使用导出 → low；同文件内部引用不算，其它文件引用才算', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'orphan.mjs'), [
    'export function orphanHelper() {',
    '  return 1;',
    '}',
    'export const usedValue = 2;',
    'export const innerOnly = 3;',
    'function useInner() {',
    '  return innerOnly;',
    '}',
    '',
  ].join('\n'));
  await writeFile(path.join(dir, 'main.mjs'), "import { usedValue } from './orphan.mjs';\nconsole.log(usedValue);\n");
  const r = await checkMetrics(dir, { tier: 'L2' });
  const hits = byRule(r, 'Q3.unused-export');
  assert.deepEqual(hits.map((f) => f.snippet).sort(), ['export const innerOnly', 'export function orphanHelper']);
  assert.ok(hits.every((f) => f.severity === 'low'));
  assert.ok(!hits.some((f) => f.snippet.includes('usedValue')));
});

test('Q3 L3 只让 medium/high 变 card；low 未使用导出仍为 check，不挤进会卡交付层', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'orphan.mjs'), 'export function orphanHelper() {\n  return 1;\n}\n');
  const r = await checkMetrics(dir, { tier: 'L3' });
  const hit = byRule(r, 'Q3.unused-export')[0];
  assert.equal(hit.severity, 'low');
  assert.equal(hit.force, 'check');

  await writeLines(dir, 'big.js', 850);
  const medium = byRule(await checkMetrics(dir, { tier: 'L3' }), 'Q3.large-file')[0];
  assert.equal(medium.force, 'card');
});

test('Q3 文件数超过 500 → 只扫前 500 并记 warning', async (t) => {
  const dir = await tmp(t);
  for (let i = 0; i < 501; i++) {
    await writeFile(path.join(dir, `f${String(i).padStart(4, '0')}.js`), `const v${i} = ${i};\n`);
  }
  const r = await checkMetrics(dir, { tier: 'L2' });
  assert.ok(r.warnings.includes('Q3：文件数超限，只扫前 500 个'));
  assert.deepEqual(r.findings, []);
});

test('Q3 单文件 >1MB → 跳过并记 warning，不因读不动而瞎报', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'huge.js'), '// ' + 'x'.repeat(1024 * 1024 + 64));
  const r = await checkMetrics(dir, { tier: 'L2' });
  assert.deepEqual(r.findings, []);
  assert.ok(r.warnings.some((w) => /跳过超过 1MB/.test(w)));
  assert.equal(r.coverageGap, null);
});

test('Q3 干净的小项目 → 空 findings（全部通过也要返回契约形状）', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, 'util.mjs'), 'export function sharedHelper() {\n  return 1;\n}\n');
  await writeFile(path.join(dir, 'main.mjs'), "import { sharedHelper } from './util.mjs';\nsharedHelper();\n");
  const r = await checkMetrics(dir, { tier: 'L3' });
  assert.deepEqual(r.findings, []);
  assert.equal(r.coverageGap, null);
  assert.equal(r.checkId, 'Q3');
});

test('Q3 excludes 生效：排除两个文件后重复块不再成立', async (t) => {
  const dir = await tmp(t);
  const block = [
    'const alphaValue = computeAlpha(input);',
    'const betaValue = computeBeta(alphaValue);',
    'if (betaValue > thresholdValue) {',
    '  return betaValue;',
    '}',
    'const gammaValue = betaValue + 1;',
  ];
  for (const [name, suffix] of [['a.js', 'A'], ['b.js', 'B'], ['c.js', 'C']]) {
    await writeFile(path.join(dir, name), ['const input = 1;', ...block, `const unique${suffix} = 1;`].join('\n') + '\n');
  }
  const r = await checkMetrics(dir, { tier: 'L2', excludes: ['b.js', 'c.js'] });
  assert.deepEqual(r.findings, []);
});
