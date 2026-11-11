import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { checkMetrics } from '../src/checks/metrics.mjs';
import { checkReadability } from '../src/checks/readability.mjs';
import { checkPerfStatic } from '../src/checks/perf-static.mjs';
import { audit } from '../src/audit.mjs';
import { dedupeCrossCopies, normalizeCopyPath } from '../src/dedupe.mjs';

async function tmpDir(t, prefix = 'fc-scan-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeRel(dir, rel, text) {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, text, 'utf8');
  return abs;
}

const bigFile = (n = 850) => Array.from({ length: n }, (_, i) => `const value${i} = ${i};`).join('\n') + '\n';

test('① 跨副本去重：release-x 副本与真实 src/a.js 只报 1 条，保留真实源码路径', async (t) => {
  const dir = await tmpDir(t, 'fc-dedupe-');
  await writeRel(dir, 'src/a.js', bigFile());
  await writeRel(dir, 'release-x/win-unpacked/src/a.js', bigFile());

  const r = await checkMetrics(dir, { tier: 'L2' });
  const large = r.findings.filter((f) => f.rule === 'Q3.large-file');
  assert.equal(large.length, 1, '副本被剪枝后同一行只应出现一次');
  assert.equal(large[0].file, 'src/a.js', '保留真实源码路径，不是打包副本');

  // 归一化口径本身（副本目录即使没被剪枝，也要能识别为同一份文件）
  assert.equal(normalizeCopyPath('release-x/win-unpacked/src/a.js'), 'src/a.js');
  assert.equal(
    normalizeCopyPath('desktop/release-0110/win-unpacked/resources/src/a.js'),
    'src/a.js',
  );
  const real = { checkId: 'Q3', rule: 'Q3.large-file', file: 'src/a.js', line: 0 };
  const copy = { ...real, file: 'desktop/release-0110/win-unpacked/resources/src/a.js' };
  const merged = dedupeCrossCopies([copy, real]);
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].file, 'src/a.js');
  assert.match(merged.warnings[0], /合并 1 条跨副本重复发现/);

  // 找不到真实源码时保留副本，并在 warning 里说明
  const copyOnly = dedupeCrossCopies([
    { ...real, file: 'release-0110/win-unpacked/src/a.js' },
    { ...real, file: 'release-0111/win-unpacked/src/a.js' },
  ]);
  assert.equal(copyOnly.findings.length, 1);
  assert.match(copyOnly.findings[0].file, /win-unpacked/);
  assert.match(copyOnly.warnings.join('\n'), /只存在于打包副本/);
});

test('② fixtures 默认不参与结论；显式 includeFixtures 才报（Q4/Q5/audit）', async (t) => {
  const dir = await tmpDir(t, 'fc-fixtures-');
  await writeRel(dir, 'src/app.js', 'const q = 1;\n');
  await writeRel(dir, 'src/fixtures/bad.js', 'const q = 1;\n');
  await writeRel(dir, 'tests/fixtures/nested/bad.ts', 'const w: any = 1;\n');
  await writeRel(dir, 'src/query.mjs', "export function rows(db) { return db.query('SELECT * FROM t'); }\n");
  await writeRel(dir, 'src/fixtures/query.mjs', "export function rows(db) { return db.query('SELECT * FROM t'); }\n");

  const q4 = await checkReadability(dir, { rustMetrics: false });
  assert.deepEqual([...new Set(q4.findings.map((f) => f.file))], ['src/app.js']);
  assert.ok(q4.warnings.some((w) => /夹具目录/.test(w) && /src\/fixtures/.test(w)), '夹具跳过必须明示');

  const q4All = await checkReadability(dir, { rustMetrics: false, includeFixtures: true });
  assert.ok(q4All.findings.some((f) => f.file === 'src/fixtures/bad.js'));
  assert.ok(q4All.findings.some((f) => f.file === 'tests/fixtures/nested/bad.ts'));

  const q5 = await checkPerfStatic(dir, { tier: 'L2' });
  assert.deepEqual([...new Set(q5.findings.map((f) => f.file))], ['src/query.mjs']);
  const q5All = await checkPerfStatic(dir, { tier: 'L2', includeFixtures: true });
  assert.ok(q5All.findings.some((f) => f.file === 'src/fixtures/query.mjs'));

  // audit 层也要能显式纳入夹具（默认过滤是兜底，不依赖各检查自觉）
  await writeRel(dir, 'src/fixtures/secret.js', 'const apiKey = "sk-abcdefgh12345678";\n');
  const hidden = await audit(dir, { tier: 'L1', interactive: true, runTests: false });
  assert.ok(!hidden.findings.some((f) => /fixtures/.test(f.file || '')), '默认审计不把夹具当产品漏洞');
  const shown = await audit(dir, { tier: 'L1', interactive: true, runTests: false, includeFixtures: true });
  assert.ok(shown.findings.some((f) => f.checkId === 'S3' && /fixtures/.test(f.file)), 'includeFixtures 显式纳入');
});

test('③ finalcheck.config.json 的 exclude 对 Q3/Q4/Q5 都生效', async (t) => {
  const dir = await tmpDir(t, 'fc-exclude-');
  await writeRel(dir, 'package.json', JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e ""' } }));
  await writeRel(dir, 'custom/large.js', bigFile());
  await writeRel(dir, 'custom/name.js', 'const q = 1;\n');
  await writeRel(dir, 'custom/query.js', "db.query('SELECT * FROM t');\n");

  const run = async (exclude) => {
    await writeRel(dir, 'finalcheck.config.json', JSON.stringify({ exclude }));
    return audit(dir, { tier: 'L2', interactive: true, runTests: false });
  };

  const excluded = await run(['custom']);
  assert.deepEqual(excluded.findings.filter((f) => ['Q3', 'Q4', 'Q5'].includes(f.checkId)).filter((f) => f.file.startsWith('custom/')), [],
    'exclude 后 Q3/Q4/Q5 都不应再报 custom/ 下的文件');

  const included = await run([]);
  const hits = included.findings.filter((f) => ['Q3', 'Q4', 'Q5'].includes(f.checkId) && f.file.startsWith('custom/'));
  assert.ok(hits.some((f) => f.checkId === 'Q3'), 'Q3 需要能扫到 custom/（阳性对照）');
  assert.ok(hits.some((f) => f.checkId === 'Q4'), 'Q4 需要能扫到 custom/（阳性对照）');
  assert.ok(hits.some((f) => f.checkId === 'Q5'), 'Q5 需要能扫到 custom/（阳性对照）');
});

test('④ 构建产物剪枝清单仍进 warnings（Q3/Q4/Q5 都不静默）', async (t) => {
  const dir = await tmpDir(t, 'fc-pruned-');
  await writeRel(dir, 'src/ok.js', 'const ok = 1;\n');
  await writeRel(dir, 'release/a.js', bigFile());
  await writeRel(dir, 'dist/b.js', bigFile());
  await writeRel(dir, 'build/c.js', bigFile());
  await writeRel(dir, 'release-0110/win-unpacked/resources/src/d.js', bigFile());

  const results = [
    await checkMetrics(dir, { tier: 'L2' }),
    await checkReadability(dir, { rustMetrics: false }),
    await checkPerfStatic(dir, { tier: 'L2' }),
  ];
  for (const r of results) {
    const warning = r.warnings.find((w) => /构建产物目录/.test(w));
    assert.ok(warning, `${r.checkId} 必须明示构建产物剪枝`);
    assert.match(warning, /release|dist|build/);
  }
});
