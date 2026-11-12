import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveGitleaks, runGitleaks, parseGitleaksReport, GITLEAKS_MISSING_WARNING } from '../src/checks/gitleaks.mjs';
import { checkSecrets } from '../src/checks/secrets.mjs';

// 运行时拼接：测试源码本身不该长得像一枚真密钥（避免被仓库自己的扫描器误报）。
const FAKE_SECRET = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const LITERAL = 'sk_' + 'live_' + '9f2Kq8LmN3pR7sT1';

async function fixture(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-gl-proj-'));
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

// 假 gitleaks：按参数把报告写到 --report-path，并把收到的 argv 记录到 --source 下的
// .gitleaks-invocation.json（供断言命令形态）。不依赖真二进制，也不联网。
async function fakeBinary(t, { report = '[]', exitCode = 0, hang = false, ext = '.mjs' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-gl-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, `fake-gitleaks${ext}`);
  const body = hang
    ? 'setInterval(() => {}, 1000);\n'
    : [
      'import { writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      'const argv = process.argv.slice(2);',
      'const value = (flag) => argv[argv.indexOf(flag) + 1];',
      'await writeFile(path.join(value("--source"), ".gitleaks-invocation.json"), JSON.stringify(argv));',
      `await writeFile(value("--report-path"), ${JSON.stringify(report)});`,
      `process.exit(${exitCode});`,
    ].join('\n');
  await writeFile(script, body);
  return script;
}

const leak = (rule, file, line, extra = {}) => ({ RuleID: rule, File: file, StartLine: line, ...extra });

test('gitleaks: RuleID 映射为 S3.gitleaks:<id>，file/line/severity/force 符合契约', () => {
  const projectDir = path.join(os.tmpdir(), 'fc-gl-map-proj');
  const report = JSON.stringify([
    leak('aws-access-token', 'src/app.js', 12, { EndLine: 13, Match: FAKE_SECRET, Secret: FAKE_SECRET }),
    leak('private-key', path.join(projectDir, 'deploy', 'key.pem'), 3),
  ]);
  const parsed = parseGitleaksReport(report, projectDir);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.findings.length, 2);
  const first = parsed.findings[0];
  assert.equal(first.checkId, 'S3');
  assert.equal(first.rule, 'S3.gitleaks:aws-access-token');
  assert.equal(first.file, 'src/app.js');
  assert.equal(first.line, 12);
  assert.equal(first.severity, 'high');
  assert.equal(first.force, 'card');
  assert.equal(first.snippet, '[redacted]');
  assert.equal(first.source, 'program');
  assert.match(first.message, /aws-access-token/);
  assert.equal(parsed.findings[1].file, 'deploy/key.pem');
  assert.equal(parsed.findings[1].line, 3);
  const serialized = JSON.stringify(parsed);
  assert.ok(!serialized.includes(FAKE_SECRET), 'Match/Secret 原文不得进入结果');
  assert.ok(!serialized.includes('Match'), '不得原样回显 Match 字段');
});

test('gitleaks: 文档命中降为 medium/tip，源码命中仍是 high/card', () => {
  const projectDir = path.join(os.tmpdir(), 'fc-gl-doc');
  const parsed = parseGitleaksReport(JSON.stringify([
    leak('aws-access-token', 'README.md', 8),
    leak('aws-access-token', 'src/app.js', 8),
  ]), projectDir);
  const doc = parsed.findings.find((f) => f.file === 'README.md');
  const src = parsed.findings.find((f) => f.file === 'src/app.js');
  assert.equal(doc.severity, 'medium');
  assert.equal(doc.force, 'tip');
  assert.match(doc.message, /文档|示例/);
  assert.equal(src.severity, 'high');
  assert.equal(src.force, 'card');
});

test('gitleaks: 同 file+line 多条命中只留字典序第一条，其余进 warnings', () => {
  const parsed = parseGitleaksReport(JSON.stringify([
    leak('zeta-rule', 'a.js', 5),
    leak('alpha-rule', 'a.js', 5),
    leak('alpha-rule', 'a.js', 5),
    leak('beta-rule', 'a.js', 6),
  ]), path.join(os.tmpdir(), 'fc-gl-dup'));
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].rule, 'S3.gitleaks:alpha-rule');
  const dupWarning = parsed.warnings.find((w) => /同位置/.test(w));
  assert.ok(dupWarning);
  assert.match(dupWarning, /zeta-rule/);
  assert.ok(!dupWarning.includes(FAKE_SECRET));
});

test('gitleaks: 坏 JSON / 非数组 / 缺字段容错，不抛错', () => {
  const bad = parseGitleaksReport('not json', path.join(os.tmpdir(), 'fc-gl-bad'));
  assert.equal(bad.valid, false);
  assert.equal(bad.findings.length, 0);
  assert.match(bad.warnings[0], /JSON/);
  const obj = parseGitleaksReport('{"x":1}', path.join(os.tmpdir(), 'fc-gl-obj'));
  assert.equal(obj.valid, false);
  const mixed = parseGitleaksReport(JSON.stringify([
    null,
    { File: 'a.js', StartLine: 1 },
    { RuleID: 'r', StartLine: 2 },
    leak('r', '../../outside.js', 3),
  ]), path.join(os.tmpdir(), 'fc-gl-mixed'));
  assert.equal(mixed.valid, true);
  assert.equal(mixed.findings.length, 1, '缺 RuleID 用 unknown-rule 兜底');
  assert.equal(mixed.findings[0].rule, 'S3.gitleaks:unknown-rule');
  assert.equal(mixed.warnings.length, 1);
  assert.match(mixed.warnings[0], /3 条/);
});

test('gitleaks: exit 1 但报告有效仍解析（不因退出码丢结果）', async (t) => {
  const dir = await fixture({ 'src/app.js': 'const x = 1;\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = await fakeBinary(t, {
    report: JSON.stringify([leak('generic-api-key', 'src/app.js', 7, { Secret: FAKE_SECRET }) ]),
    exitCode: 1,
  });
  const r = await runGitleaks(dir, { binaryPath: script });
  assert.equal(r.available, true);
  assert.equal(r.ok, true);
  assert.equal(r.status, 1);
  assert.equal(r.gapKind, null);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].rule, 'S3.gitleaks:generic-api-key');
  assert.ok(r.warnings.some((w) => /退出码 1/.test(w)));
  assert.ok(!JSON.stringify(r).includes(FAKE_SECRET));
});

test('gitleaks: 默认 --no-git，scanHistory 去掉它；报告写临时目录且跑完删除', async (t) => {
  const dir = await fixture({ 'app.js': 'x\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = await fakeBinary(t, { report: '[]' });

  const first = await runGitleaks(dir, { binaryPath: script });
  assert.equal(first.ok, true);
  const recorded = JSON.parse(await readFile(path.join(dir, '.gitleaks-invocation.json'), 'utf8'));
  assert.ok(recorded.includes('--no-git'));
  assert.ok(recorded.includes('--redact'));
  assert.ok(recorded.includes('--no-banner'));
  assert.ok(recorded.includes('--exit-code'));
  assert.equal(recorded[recorded.indexOf('--exit-code') + 1], '0');
  assert.equal(recorded[recorded.indexOf('--report-format') + 1], 'json');
  assert.equal(recorded[recorded.indexOf('--source') + 1], dir);
  const reportPath = recorded[recorded.indexOf('--report-path') + 1];
  assert.ok(path.isAbsolute(reportPath));
  assert.ok(!reportPath.startsWith(path.resolve(dir)), '报告不得落在被审项目内');
  await assert.rejects(access(reportPath), '临时报告跑完应删除');

  const second = await runGitleaks(dir, { binaryPath: script, scanHistory: true });
  assert.equal(second.ok, true);
  const recorded2 = JSON.parse(await readFile(path.join(dir, '.gitleaks-invocation.json'), 'utf8'));
  assert.ok(!recorded2.includes('--no-git'), 'scanHistory 应扫 git 历史');
  assert.equal(recorded2[recorded2.indexOf('--source') + 1], dir);
});

test('gitleaks: 缺二进制只记 warning、无 coverageGap；自研规则照跑', async (t) => {
  const dir = await fixture({ 'app.js': `const apiKey = "${LITERAL}";\n` });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const missing = await runGitleaks(dir, { binaryPath: null });
  assert.equal(missing.available, false);
  assert.equal(missing.gapKind, null);
  assert.deepEqual(missing.warnings, [GITLEAKS_MISSING_WARNING]);
  assert.equal(missing.findings.length, 0);

  const script = await fakeBinary(t, { report: '[]' });
  const out = await checkSecrets(dir, { gitleaks: { path: script } });
  assert.ok(out.findings.some((f) => f.rule === 'S3.secret-literal'), '自研 S3 规则不能因 gitleaks 缺席/空报告而停摆');
  assert.equal(out.coverageGap, null);
});

test('gitleaks: 超时杀掉进程 → gapKind unavailable + 超时 warning', async (t) => {
  const dir = await fixture({ 'app.js': 'x\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = await fakeBinary(t, { hang: true });
  const r = await runGitleaks(dir, { binaryPath: script, timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.status, 124);
  assert.equal(r.gapKind, 'unavailable');
  assert.match(r.warnings[0], /超时/);
  assert.equal(r.findings.length, 0);
});

test('gitleaks: 坏报告 → gapKind unavailable，不计为已执行', async (t) => {
  const dir = await fixture({ 'app.js': 'x\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bad = await fakeBinary(t, { report: 'not-json' });
  const r1 = await runGitleaks(dir, { binaryPath: bad });
  assert.equal(r1.ok, false);
  assert.equal(r1.gapKind, 'unavailable');
  assert.match(r1.gapReason, /报告/);
  assert.ok(r1.warnings.some((w) => /JSON|报告/.test(w)));

  const obj = await fakeBinary(t, { report: '{"leaks":[]}' });
  const r2 = await runGitleaks(dir, { binaryPath: obj });
  assert.equal(r2.gapKind, 'unavailable');
  assert.match(r2.warnings[0], /数组/);
});

test('gitleaks: exclude 对 gitleaks 命中同样生效', async (t) => {
  const dir = await fixture({ 'app.js': 'x\n', 'vendor/lib.js': 'x\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = await fakeBinary(t, {
    report: JSON.stringify([leak('vendor-rule', 'vendor/lib.js', 2), leak('app-rule', 'app.js', 4)]),
  });
  const r = await runGitleaks(dir, { binaryPath: script, excludes: ['vendor'] });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].file, 'app.js');
  assert.ok(r.warnings.some((w) => /exclude 过滤 1 条/.test(w)));
});

test('gitleaks: .js 假二进制也通过 node 启动', async (t) => {
  const dir = await fixture({ 'app.js': 'x\n' });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = await fakeBinary(t, { report: '[]', ext: '.js' });
  const r = await runGitleaks(dir, { binaryPath: script });
  assert.equal(r.ok, true, '.js 结尾的路径要用 process.execPath 启动');
});

test('gitleaks: 定位优先级 config.path > GITLEAKS_PATH > PATH', () => {
  assert.equal(resolveGitleaks({
    config: { gitleaks: { path: 'C:/cfg/gitleaks.exe' } },
    env: { GITLEAKS_PATH: 'C:/env/gitleaks.exe' },
    find: () => 'C:/path/gitleaks.exe',
  }), 'C:/cfg/gitleaks.exe');
  assert.equal(resolveGitleaks({
    config: { gitleaks: {} },
    env: { GITLEAKS_PATH: 'C:/env/gitleaks.exe' },
    find: () => 'C:/path/gitleaks.exe',
  }), 'C:/env/gitleaks.exe');
  assert.equal(resolveGitleaks({ config: {}, env: {}, find: () => 'C:/path/gitleaks.exe' }), 'C:/path/gitleaks.exe');
  assert.equal(resolveGitleaks({ config: {}, env: {}, find: () => null }), null);
  assert.equal(resolveGitleaks({ config: { path: 'C:/cfg/gitleaks.exe' }, env: {}, find: () => null }), 'C:/cfg/gitleaks.exe');
});

test('S3: gitleaks 跑不起来才 coverageGap；空报告不封顶且不丢自研结果', async (t) => {
  const dir = await fixture({ 'app.js': `const apiKey = "${LITERAL}";\n` });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const okScript = await fakeBinary(t, { report: '[]' });
  const ok = await checkSecrets(dir, { gitleaks: { path: okScript } });
  assert.equal(ok.coverageGap, null);

  const badScript = await fakeBinary(t, { report: 'broken' });
  const bad = await checkSecrets(dir, { gitleaks: { path: badScript } });
  assert.match(String(bad.coverageGap), /报告/);
  assert.ok(bad.findings.some((f) => f.rule === 'S3.secret-literal'), 'gitleaks 坏掉也不能丢自研结果');
});

test('S3: gitleaks 与自研同 file+line 去重，保留自研；异位置保留 gitleaks 规则名', async (t) => {
  const dir = await fixture({
    'app.js': `const apiKey = "${LITERAL}";\nconsole.log('ok');\n`,
    'other.js': '// no secret here\nconst y = 2;\n',
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = await fakeBinary(t, {
    report: JSON.stringify([
      leak('generic-api-key', 'app.js', 1, { Match: FAKE_SECRET, Secret: FAKE_SECRET }),
      leak('generic-api-key', 'other.js', 2, { Match: FAKE_SECRET, Secret: FAKE_SECRET }),
    ]),
  });
  const out = await checkSecrets(dir, { gitleaks: { path: script } });
  const appHits = out.findings.filter((f) => f.file === 'app.js');
  assert.equal(appHits.length, 1, '同位置只保留自研一条');
  assert.equal(appHits[0].rule, 'S3.secret-literal');
  assert.ok(out.warnings.some((w) => /generic-api-key/.test(w) && /保留自研/.test(w)));
  const other = out.findings.find((f) => f.file === 'other.js');
  assert.ok(other, '异位置的 gitleaks 命中要保留');
  assert.equal(other.rule, 'S3.gitleaks:generic-api-key');
  assert.equal(other.severity, 'high');
  assert.equal(other.force, 'card');
  assert.equal(other.line, 2);
  const serialized = JSON.stringify({ findings: out.findings, warnings: out.warnings });
  assert.ok(!serialized.includes(FAKE_SECRET), 'Secret/Match 原文永远不进报告');
});
