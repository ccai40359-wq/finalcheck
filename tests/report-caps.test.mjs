import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import {
  DEFAULT_REPORT_CAPS, resolveReportCaps, truncationNotCoveredLine,
} from '../src/report-caps.mjs';
import { checkMetrics } from '../src/checks/metrics.mjs';
import { checkReadability } from '../src/checks/readability.mjs';
import { checkPerfStatic } from '../src/checks/perf-static.mjs';
import { audit } from '../src/audit.mjs';
import { renderReport } from '../src/report.mjs';

// reportCaps：默认不截断（结论里的条数=真实命中数）；显式配置才截断，且必须点名总量。

async function tmpDir(t, prefix = 'fc-caps-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeRel(dir, rel, text) {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, text, 'utf8');
}

const byRule = (r, rule) => r.findings.filter((f) => f.rule === rule);

async function makeNamingFiles(dir, n) {
  for (let i = 0; i < n; i++) await writeRel(dir, `naming/${String(i).padStart(2, '0')}.js`, 'const q = 1;\n');
}

async function makeLargeFiles(dir, n) {
  for (let i = 0; i < n; i++) {
    const tag = `big${i}`;
    const body = [`// ${tag}`, ...Array.from({ length: 800 }, (_, j) => `const ${tag}_${j} = ${j};`)];
    await writeRel(dir, `${tag}.js`, body.join('\n') + '\n'); // 801 行 > 默认阈值 800
  }
}

async function makeAwaitFiles(dir, n) {
  for (let i = 0; i < n; i++) {
    await writeRel(dir, `await/loop${i}.js`, [
      `export async function persist${i}(rows) {`,
      '  for (const row of rows) {',
      '    await save(row);',
      '  }',
      '}',
      '',
    ].join('\n'));
  }
}

async function makeUnusedExportFile(dir, n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(`export function orphanHelper${i}() {`, '  return 1;', '}');
  }
  await writeRel(dir, 'orphans.mjs', lines.join('\n') + '\n');
}

async function makeDuplicateBlockFiles(dir, blocks) {
  for (const name of ['a.js', 'b.js', 'c.js']) {
    const lines = [];
    for (let i = 0; i < blocks; i++) {
      lines.push(
        `const alphaValue${i} = computeAlpha${i}(input);`,
        `const betaValue${i} = computeBeta${i}(alphaValue${i});`,
        `if (betaValue${i} > thresholdValue${i}) {`,
        `  return betaValue${i};`,
        '}',
        `const gammaValue${i} = betaValue${i} + 1;`,
      );
    }
    await writeRel(dir, name, lines.join('\n') + '\n');
  }
}

test('reportCaps 默认三个上限全是 Infinity（不截断）', () => {
  const { caps, warnings } = resolveReportCaps({});
  assert.deepEqual(warnings, []);
  for (const [key, value] of Object.entries(DEFAULT_REPORT_CAPS)) {
    assert.equal(value, Infinity, `${key} 默认必须不截断`);
    assert.equal(caps[key], Infinity);
  }
});

test('reportCaps 合法正整数生效；负数/字符串回落不截断并写 warning', () => {
  const { caps, warnings } = resolveReportCaps({
    reportCaps: { 'Q4.perRule': 3, 'Q3.largeFile': -1, 'Q5.perRule': '20' },
  });
  assert.equal(caps['Q4.perRule'], 3);
  assert.equal(caps['Q3.largeFile'], Infinity);
  assert.equal(caps['Q5.perRule'], Infinity);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /reportCaps\["Q3.largeFile"\] 的值 -1 无效/);
  assert.match(warnings[1], /reportCaps\["Q5.perRule"\] 的值 20 无效/);

  const bad = resolveReportCaps({ reportCaps: 'nope' });
  assert.equal(bad.caps['Q4.perRule'], Infinity);
  assert.match(bad.warnings[0], /reportCaps 必须是对象/);

  const typo = resolveReportCaps({ reportCaps: { 'Q4.rule': 5 } });
  assert.equal(typo.caps['Q4.perRule'], Infinity);
  assert.match(typo.warnings[0], /未知配置项 reportCaps\["Q4.rule"\]/);
});

test('reportCaps：--no-caps 覆盖配置，全部回落不截断并说明', () => {
  const { caps, warnings } = resolveReportCaps({ reportCaps: { 'Q4.perRule': 5 } }, { noCaps: true });
  assert.equal(caps['Q4.perRule'], Infinity);
  assert.equal(caps['Q3.largeFile'], Infinity);
  assert.equal(caps['Q5.perRule'], Infinity);
  assert.match(warnings[0], /--no-caps 已忽略/);
});

test('Q4 默认不截断：同一规则命中 30 条时 30 条都在', async (t) => {
  const dir = await tmpDir(t);
  await makeNamingFiles(dir, 30);
  const r = await checkReadability(dir, { rustMetrics: false });
  assert.equal(byRule(r, 'Q4.naming').length, 30);
  assert.ok(r.warnings.some((w) => /Q4.naming 命中 30 条.*可能含噪声.*全部条目已保留/.test(w)), '不截断也要保留噪声提示');
  assert.equal(r.reportTruncations, undefined, '未配置上限时不应有截断记录');
});

test('Q4 配 Q4.perRule=5：只报 5 条 + warning 写总量 + 截断记录', async (t) => {
  const dir = await tmpDir(t);
  await makeNamingFiles(dir, 30);
  const r = await checkReadability(dir, { rustMetrics: false, reportCaps: { 'Q4.perRule': 5 } });
  assert.equal(byRule(r, 'Q4.naming').length, 5);
  assert.ok(r.warnings.some((w) => /Q4：规则 Q4.naming 命中 30 条，按配置 reportCaps\["Q4.perRule"\]=5 只报前 5 条，其余 25 条未列出/.test(w)), 'warning 必须写清规则/总量/上限/未列出条数');
  assert.equal(r.reportTruncations.length, 1);
  assert.equal(r.reportTruncations[0].total, 30);
  assert.equal(r.reportTruncations[0].reported, 5);
});

test('Q3 默认不截断：11 个超大文件全部报告', async (t) => {
  const dir = await tmpDir(t);
  await makeLargeFiles(dir, 11);
  const r = await checkMetrics(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'Q3.large-file').length, 11);
  assert.ok(r.warnings.some((w) => /Q3.large-file 命中 11 条.*可能含噪声.*全部条目已保留/.test(w)));
  assert.equal(r.reportTruncations, undefined);
});

test('Q3 配 Q3.largeFile=5：只报 5 个 + warning 写总量 + 截断记录', async (t) => {
  const dir = await tmpDir(t);
  await makeLargeFiles(dir, 11);
  const r = await checkMetrics(dir, { tier: 'L2', reportCaps: { 'Q3.largeFile': 5 } });
  assert.equal(byRule(r, 'Q3.large-file').length, 5);
  assert.ok(r.warnings.some((w) => /Q3：规则 Q3.large-file 命中 11 条，按配置 reportCaps\["Q3.largeFile"\]=5 只报前 5 条，其余 6 条未列出/.test(w)));
  assert.equal(r.reportTruncations.length, 1);
  assert.equal(r.reportTruncations[0].total, 11);
  assert.equal(r.reportTruncations[0].reported, 5);
});

test('Q5 默认不截断：同一规则命中 30 条时 30 条都在', async (t) => {
  const dir = await tmpDir(t);
  await makeAwaitFiles(dir, 30);
  const r = await checkPerfStatic(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'Q5.await-in-loop').length, 30);
  assert.ok(r.warnings.some((w) => /Q5.await-in-loop 命中 30 条.*可能含噪声.*全部条目已保留/.test(w)));
  assert.equal(r.reportTruncations, undefined);
});

test('Q5 配 Q5.perRule=5：只报 5 条 + warning 写总量 + 截断记录', async (t) => {
  const dir = await tmpDir(t);
  await makeAwaitFiles(dir, 30);
  const r = await checkPerfStatic(dir, { tier: 'L2', reportCaps: { 'Q5.perRule': 5 } });
  assert.equal(byRule(r, 'Q5.await-in-loop').length, 5);
  assert.ok(r.warnings.some((w) => /Q5：规则 Q5.await-in-loop 命中 30 条，按配置 reportCaps\["Q5.perRule"\]=5 只报前 5 条，其余 25 条未列出/.test(w)));
  assert.equal(r.reportTruncations.length, 1);
  assert.equal(r.reportTruncations[0].total, 30);
  assert.equal(r.reportTruncations[0].reported, 5);
});

test('Q3 未使用导出默认全报；配 Q3.unusedExport=5 时只报 5 条 + warning + 截断记录', async (t) => {
  const dir = await tmpDir(t);
  await makeUnusedExportFile(dir, 12);
  const all = await checkMetrics(dir, { tier: 'L2' });
  assert.equal(byRule(all, 'Q3.unused-export').length, 12, '默认 Infinity：12 条全部保留');
  assert.ok(all.warnings.some((w) => /Q3.unused-export 命中 12 条.*全部条目已保留/.test(w)));
  assert.equal(all.reportTruncations, undefined);

  const capped = await checkMetrics(dir, { tier: 'L2', reportCaps: { 'Q3.unusedExport': 5 } });
  assert.equal(byRule(capped, 'Q3.unused-export').length, 5);
  assert.ok(capped.warnings.some((w) => /Q3：规则 Q3.unused-export 命中 12 条，按配置 reportCaps\["Q3.unusedExport"\]=5 只报前 5 条，其余 7 条未列出/.test(w)));
  assert.equal(capped.reportTruncations.length, 1);
  assert.equal(capped.reportTruncations[0].total, 12);
  assert.equal(capped.reportTruncations[0].reported, 5);
});

test('Q3 重复代码块默认全报；配 Q3.duplicateBlock=2 时只报 2 条 + warning + 截断记录', async (t) => {
  const dir = await tmpDir(t);
  await makeDuplicateBlockFiles(dir, 3);
  const all = await checkMetrics(dir, { tier: 'L2' });
  assert.equal(byRule(all, 'Q3.duplicate-block').length, 3, '默认 Infinity：3 个独立重复块全部保留');
  assert.equal(all.reportTruncations, undefined);

  const capped = await checkMetrics(dir, { tier: 'L2', reportCaps: { 'Q3.duplicateBlock': 2 } });
  assert.equal(byRule(capped, 'Q3.duplicate-block').length, 2);
  assert.ok(capped.warnings.some((w) => /Q3：规则 Q3.duplicate-block 命中 3 条，按配置 reportCaps\["Q3.duplicateBlock"\]=2 只报前 2 条，其余 1 条未列出/.test(w)));
  assert.equal(capped.reportTruncations.length, 1);
  assert.equal(capped.reportTruncations[0].total, 3);
  assert.equal(capped.reportTruncations[0].reported, 2);
});

test('Q4 单文件单规则默认全报；配 Q4.perFile=4 时按文件截断 + warning 带文件名 + Not covered', async (t) => {
  const dir = await tmpDir(t);
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'm', 'n', 'o', 'p', 'q', 'r', 's'];
  await writeRel(dir, 'names.js', names.map((n) => `let ${n} = 1;`).join('\n') + '\n');

  const all = await checkReadability(dir, { rustMetrics: false });
  assert.equal(byRule(all, 'Q4.naming').length, names.length, '默认 Infinity：15 条全部保留');
  assert.equal(all.reportTruncations, undefined);

  const capped = await checkReadability(dir, { rustMetrics: false, reportCaps: { 'Q4.perFile': 4 } });
  assert.equal(byRule(capped, 'Q4.naming').length, 4);
  assert.ok(capped.warnings.some((w) => /Q4：规则 Q4.naming（names\.js）命中 15 条，按配置 reportCaps\["Q4.perFile"\]=4 只报前 4 条，其余 11 条未列出/.test(w)));
  assert.equal(capped.reportTruncations.length, 1);
  assert.equal(capped.reportTruncations[0].file, 'names.js');
  assert.equal(capped.reportTruncations[0].total, 15);
  assert.equal(capped.reportTruncations[0].reported, 4);
});

test('audit + 报告：Q3.unusedExport / Q4.perFile 截断都在 ## Not covered 点名', async (t) => {
  const dir = await tmpDir(t, 'fc-caps-audit-new-');
  await makeUnusedExportFile(dir, 12);
  await writeRel(dir, 'names.js', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'm', 'n', 'o', 'p', 'q', 'r', 's']
    .map((n) => `let ${n} = 1;`).join('\n') + '\n');
  await writeFile(path.join(dir, 'finalcheck.config.json'), JSON.stringify({
    reportCaps: { 'Q3.unusedExport': 5, 'Q4.perFile': 4 },
  }), 'utf8');

  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false });
  assert.equal(byRule(res, 'Q3.unused-export').length, 5);
  assert.equal(byRule(res, 'Q4.naming').length, 4);
  assert.equal(res.reportTruncations.length, 2);
  const text = renderReport(res);
  const notCovered = text.slice(text.indexOf('## Not covered'));
  assert.ok(text.includes('## Not covered'));
  assert.match(notCovered, /- Q3：规则 Q3\.unused-export 命中 12 条，按配置 reportCaps\["Q3\.unusedExport"\]=5 只报前 5 条，其余 7 条未列出/);
  assert.match(notCovered, /- Q4：规则 Q4\.naming（names\.js）命中 15 条，按配置 reportCaps\["Q4\.perFile"\]=4 只报前 4 条，其余 11 条未列出/);
});

test('audit 遇非法 reportCaps：回落不截断 + warning，不吞条目', async (t) => {
  const dir = await tmpDir(t, 'fc-caps-bad-');
  await makeNamingFiles(dir, 3);
  await writeFile(path.join(dir, 'finalcheck.config.json'), JSON.stringify({
    reportCaps: { 'Q4.perRule': -1 },
  }), 'utf8');
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false });
  assert.equal(byRule(res, 'Q4.naming').length, 3);
  assert.ok(res.warnings.some((w) => /reportCaps\["Q4.perRule"\] 的值 -1 无效.*已按不截断处理/.test(w)));
  assert.equal(res.reportTruncations, undefined);
});

test('audit 从 finalcheck.config.json 传 caps：5 条 findings + warning + reportTruncations', async (t) => {
  const dir = await tmpDir(t, 'fc-caps-audit-');
  await makeNamingFiles(dir, 30);
  await writeFile(path.join(dir, 'finalcheck.config.json'), JSON.stringify({
    reportCaps: { 'Q4.perRule': 5 },
  }), 'utf8');
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false });
  assert.equal(byRule(res, 'Q4.naming').length, 5);
  assert.ok(res.warnings.some((w) => /命中 30 条.*只报前 5 条.*其余 25 条未列出/.test(w)));
  assert.equal(res.reportTruncations.length, 1);
  assert.equal(res.reportTruncations[0].checkId, 'Q4');
  const text = renderReport(res);
  const notCovered = text.slice(text.indexOf('## Not covered'), text.indexOf('## Skipped'));
  assert.ok(text.includes('## Not covered'), '截断必须出现在报告的 Not covered 段');
  assert.match(notCovered, /- Q4：规则 Q4.naming 命中 30 条/);
});

test('维度报告 ## Not covered 点名 reportTruncations', () => {
  const res = {
    projectDir: 'D:/probe',
    tier: {
      effective: 'L2', requested: 'L2', signals: [],
      dimensions: { 代码可读性: { level: 'L2', verdict: '过' } },
    },
    gates: { planned: ['Q4'], executed: ['Q4'], gapItems: [] },
    findings: [],
    conclusion: { verdict: '过', reason: 'ok' },
    warnings: [],
    reportTruncations: [{
      checkId: 'Q4', rule: 'Q4.naming', configKey: 'Q4.perRule', total: 30, reported: 5, cap: 5,
    }],
  };
  const text = renderReport(res);
  assert.ok(text.includes('## Not covered'));
  const section = text.slice(text.indexOf('## Not covered'), text.indexOf('## Skipped'));
  assert.ok(section.includes(truncationNotCoveredLine(res.reportTruncations[0])));
});
