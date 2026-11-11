import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import {
  buildBaseline,
  fingerprint,
  loadBaseline,
  matchFindings,
  normalizePath,
  normalizeText,
  saveBaseline,
} from '../src/baseline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'finalcheck.js');

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-baseline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function finding(over = {}) {
  return {
    checkId: 'S3',
    rule: 'S3.secret-literal',
    file: 'src/a.js',
    line: 3,
    severity: 'high',
    force: 'card',
    message: '疑似密钥/口令字面量',
    snippet: 'const apiKey = ***',
    ...over,
  };
}

const FIXED_NOW = new Date('2026-11-11T00:00:00.000Z');

/* ---------- 归一化与指纹 ---------- */

test('baseline: normalizePath 反斜杠转 /、去前导 ./、不折叠大小写', () => {
  assert.equal(normalizePath('src\\a.js'), 'src/a.js');
  assert.equal(normalizePath('./src/a.js'), 'src/a.js');
  assert.equal(normalizePath('.\\src\\a.js'), 'src/a.js');
  assert.equal(normalizePath('Src/A.js'), 'Src/A.js', '不得做大小写折叠');
});

test('baseline: normalizeText 压缩连续空白并去行尾空白', () => {
  assert.equal(normalizeText('  a\n\t b   c  '), 'a b c');
  assert.equal(normalizeText('a\r\n b'), 'a b');
});

test('baseline: 指纹只认 rule/路径/文本，行号漂移与路径写法不同都不改变 hash', () => {
  const a = fingerprint(finding({ line: 1 }));
  const b = fingerprint(finding({ line: 900 }));
  assert.equal(a, b, '行号不得进入指纹');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(
    fingerprint(finding({ file: 'src\\a.js', message: '疑似密钥/口令字面量' })),
    fingerprint(finding({ file: './src/a.js', message: ' 疑似密钥/口令字面量\n' })),
  );
  assert.equal(
    fingerprint(finding({ message: '旧文案' })) === fingerprint(finding({ message: '新文案' })),
    false,
  );
});

/* ---------- a. 行号漂移 ---------- */

test('baseline a: 行号 +5 漂移 → hash 命中，算 existing 而不是 new', () => {
  const base = buildBaseline([finding({ line: 3 })], { tier: 'L2', now: FIXED_NOW });
  const m = matchFindings([finding({ line: 8 })], base);
  assert.equal(m.new.length, 0, '行号漂移不能报新增');
  assert.equal(m.fixed.length, 0);
  assert.equal(m.existing.length, 1);
  assert.equal(m.matchedByHash, 1);
  assert.equal(m.matchedByKey, 0);
  assert.equal(m.existing[0].line, 8, 'existing 保留本次行号，供报告定位');
});

/* ---------- b. 同键多条 ---------- */

test('baseline b: 同 rule/file 两条、基线只有一条 → 一条 existing + 一条 new', () => {
  const base = buildBaseline([finding({ line: 3 })], { tier: 'L2', now: FIXED_NOW });
  const current = [finding({ line: 3 }), finding({ line: 9, message: '另一处同类问题' })];
  const m = matchFindings(current, base);
  assert.equal(m.existing.length, 1);
  assert.equal(m.new.length, 1);
  assert.equal(m.fixed.length, 0);
  assert.equal(m.matchedByHash, 1);
  assert.equal(m.matchedByKey, 0, 'hash 已配对后，同键的第二条不能顶替已消费的基线条目');
  assert.equal(m.new[0].line, 9);
});

test('baseline b2: message 微调（hash 失效）但 checkId/rule/file 未变 → 按 key 配对为 existing', () => {
  const base = buildBaseline([finding({ line: 3, message: '旧文案' })], { tier: 'L2', now: FIXED_NOW });
  const m = matchFindings([finding({ line: 3, message: '新文案（措辞调整）' })], base);
  assert.equal(m.new.length, 0);
  assert.equal(m.existing.length, 1);
  assert.equal(m.matchedByHash, 0);
  assert.equal(m.matchedByKey, 1);
});

/* ---------- c. 已修复 ---------- */

test('baseline c: 基线里有、本次没有 → fixed；基线为空 → 本次全部 new', () => {
  const base = buildBaseline([finding()], { tier: 'L2', now: FIXED_NOW });
  const m = matchFindings([], base);
  assert.equal(m.fixed.length, 1);
  assert.equal(m.new.length, 0);
  assert.equal(m.existing.length, 0);
  assert.equal(m.fixed[0].file, 'src/a.js');

  const empty = matchFindings([finding()], { version: 1, createdAt: null, tier: 'L2', entries: [] });
  assert.equal(empty.new.length, 1);
  assert.equal(empty.fixed.length, 0);
});

/* ---------- d. 基线损坏 ---------- */

test('baseline d: 不存在 → data null 且无 warning；损坏/版本不符/entries 非数组 → warning + 全部 new', async (t) => {
  const dir = await tmp(t);
  const missing = path.join(dir, 'nope.json');
  const miss = await loadBaseline(missing);
  assert.deepEqual(miss, { data: null, warning: null });

  const broken = path.join(dir, 'broken.json');
  await writeFile(broken, '{ bad json');
  const bad = await loadBaseline(broken);
  assert.equal(bad.data, null);
  assert.match(String(bad.warning), /JSON/);

  const v2 = path.join(dir, 'v2.json');
  await writeFile(v2, JSON.stringify({ version: 2, entries: [] }));
  const wrongVersion = await loadBaseline(v2);
  assert.equal(wrongVersion.data, null);
  assert.match(String(wrongVersion.warning), /version/);

  const noEntries = path.join(dir, 'no-entries.json');
  await writeFile(noEntries, JSON.stringify({ version: 1, entries: {} }));
  const badEntries = await loadBaseline(noEntries);
  assert.equal(badEntries.data, null);
  assert.match(String(badEntries.warning), /entries/);

  // 调用方口径：拿不到可用基线时，当前发现一条都不能少（不是「无基线通过」）
  const current = [finding()];
  const m = matchFindings(current, bad.data || { version: 1, entries: [] });
  assert.equal(m.new.length, 1);
  assert.equal(m.existing.length, 0);
});

/* ---------- e. 快照稳定性 ---------- */

test('baseline e: buildBaseline version=1、createdAt 可控、entries 按 file/line/rule 稳定排序', () => {
  const data = buildBaseline([
    finding({ file: 'b.js', line: 2, rule: 'R.b', checkId: 'B' }),
    finding({ file: 'a.js', line: 10, rule: 'R.a' }),
    finding({ file: 'a.js', line: 2, rule: 'R.z' }),
    finding({ file: 'a.js', line: 2, rule: 'R.a' }),
  ], { tier: 'L1', now: FIXED_NOW });
  assert.equal(data.version, 1);
  assert.equal(data.createdAt, '2026-11-11T00:00:00.000Z');
  assert.equal(data.tier, 'L1');
  assert.deepEqual(
    data.entries.map((e) => [e.file, e.line, e.rule]),
    [['a.js', 2, 'R.a'], ['a.js', 2, 'R.z'], ['a.js', 10, 'R.a'], ['b.js', 2, 'R.b']],
  );
  assert.ok(data.entries.every((e) => e.hash.length === 64), '每条都带 sha256');
  // 同样输入重复构建 → 字节级稳定（可比对/可提交）
  assert.equal(JSON.stringify(data), JSON.stringify(buildBaseline([
    finding({ file: 'a.js', line: 2, rule: 'R.a' }),
    finding({ file: 'a.js', line: 2, rule: 'R.z' }),
    finding({ file: 'a.js', line: 10, rule: 'R.a' }),
    finding({ file: 'b.js', line: 2, rule: 'R.b', checkId: 'B' }),
  ], { tier: 'L1', now: FIXED_NOW })));
});

test('baseline e2: saveBaseline 自动建目录 + 原子写（无残留 tmp），loadBaseline 可回读', async (t) => {
  const dir = await tmp(t);
  const file = path.join(dir, '.finalcheck', 'baseline.json');
  const data = buildBaseline([finding()], { tier: 'L2', now: FIXED_NOW });
  await saveBaseline(file, data);
  const loaded = await loadBaseline(file);
  assert.equal(loaded.warning, null);
  assert.deepEqual(loaded.data, data);
  const leftovers = (await readdir(path.join(dir, '.finalcheck'))).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '原子写不得留下 tmp 文件');

  // 覆盖已有基线：tmp+rename 必须能替换旧文件（Windows 上也不能留半截）
  const next = buildBaseline([finding({ line: 9 })], { tier: 'L3', now: FIXED_NOW });
  await saveBaseline(file, next);
  const reloaded = await loadBaseline(file);
  assert.equal(reloaded.warning, null);
  assert.equal(reloaded.data.tier, 'L3');
  assert.equal(reloaded.data.entries[0].line, 9);
});

/* ---------- f. CLI 端到端 ---------- */

// 合成密钥运行时拼接，避免测试源码本身被仓库的 S3 扫描命中。
const FAKE_KEY = ['sk', 'live', 'baseline', 'test', 'key', '123'].join('_');

async function miniProject(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-baseline-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'mini', version: '1.0.0' }, null, 2));
  // 零外部依赖 lockfile：S4 直接判「无可审计包」，不访问 registry（测试不联网）
  await writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'mini',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: 'mini', version: '1.0.0' } },
  }, null, 2));
  await writeFile(path.join(dir, 'src', 'index.js'), 'module.exports = 1;\n');
  return dir;
}

function runCli(dir, extra = []) {
  const r = spawnSync(process.execPath, [BIN, 'audit', dir, '--tier', 'L1', '--no-tests', '--json', ...extra], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  return r;
}

test('baseline f: --write-baseline 写基线；无改动 --fail-on new 退出 0；引入新问题退出 1', async (t) => {
  const dir = await miniProject(t);

  const first = runCli(dir, ['--write-baseline', '--fail-on', 'new']);
  assert.equal(first.status, 0, `首次写基线应通过：${first.stderr}`);
  const json1 = JSON.parse(first.stdout);
  assert.equal(json1.baseline.file, '.finalcheck/baseline.json');
  assert.equal(json1.baseline.counts.written, true, '本轮刚写入的基线不应把自己全算新增');
  assert.equal(json1.baseline.counts.new, 0);
  assert.equal(json1.conclusion.verdict, '过');

  const baselineFile = path.join(dir, '.finalcheck', 'baseline.json');
  const snapshot = await loadBaseline(baselineFile);
  assert.equal(snapshot.warning, null, '写出的基线必须可回读');
  assert.equal(snapshot.data.version, 1);

  const second = runCli(dir, ['--fail-on', 'new']);
  assert.equal(second.status, 0, `无改动时 --fail-on new 必须退出 0：${second.stderr}`);
  const json2 = JSON.parse(second.stdout);
  assert.equal(json2.baseline.counts.new, 0);
  assert.equal(json2.baseline.counts.fixed, 0);
  assert.equal(json2.baseline.counts.existing, 0);

  // 显式 --baseline <路径> 与默认路径等价
  const explicit = runCli(dir, ['--baseline', baselineFile, '--fail-on', 'new']);
  assert.equal(explicit.status, 0, `显式 --baseline 路径应生效：${explicit.stderr}`);
  assert.equal(JSON.parse(explicit.stdout).baseline.file, '.finalcheck/baseline.json');

  // 引入一条新的高危密钥 → 相对基线是 new → 退出 1
  await writeFile(path.join(dir, 'src', 'secret.js'), `const apiKey = "${FAKE_KEY}";\n`);
  const third = runCli(dir, ['--fail-on', 'new']);
  assert.equal(third.status, 1, `新增卡项时 --fail-on new 必须退出 1：${third.stderr}`);
  const json3 = JSON.parse(third.stdout);
  assert.ok(json3.baseline.counts.new >= 1);
  assert.ok(json3.baseline.counts.newBlocking >= 1);
  assert.ok(json3.baseline.new.some((f) => f.rule === 'S3.secret-literal' && f.file === 'src/secret.js'));
  assert.equal(json3.baseline.counts.new, json3.baseline.new.length, 'counts 与明细条数一致');
});

test('baseline f2: 文本报告末尾追加 Baseline 段落；无基线只打印一行提示', async (t) => {
  const dir = await miniProject(t);
  const textRun = spawnSync(process.execPath, [BIN, 'audit', dir, '--tier', 'L1', '--no-tests'], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.match(textRun.stdout, /未启用基线（--baseline\/--write-baseline）/, '无基线时必须有明确提示');

  const writeRun = spawnSync(process.execPath, [BIN, 'audit', dir, '--tier', 'L1', '--no-tests', '--write-baseline'], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
  });
  assert.equal(writeRun.status, 0, writeRun.stderr);
  assert.match(writeRun.stdout, /## Baseline/);
  assert.match(writeRun.stdout, /- 基线：\.finalcheck\/baseline\.json（已写入）/);
  assert.match(writeRun.stdout, /新增 0 条（卡项\/高危 0 条）、已修复 0 条、仍在 0 条/);
});

test('baseline f3: 基线 JSON 损坏 → 全部算新增（CLI 不判通过）', async (t) => {
  const dir = await miniProject(t);
  await mkdir(path.join(dir, '.finalcheck'), { recursive: true });
  await writeFile(path.join(dir, '.finalcheck', 'baseline.json'), '{ bad json');
  await writeFile(path.join(dir, 'src', 'secret.js'), `const apiKey = "${FAKE_KEY}";\n`);
  const r = runCli(dir, ['--fail-on', 'new']);
  assert.equal(r.status, 1, `损坏基线必须按全部新增处理：${r.stderr}`);
  const json = JSON.parse(r.stdout);
  assert.ok(json.warnings.some((w) => w.includes('基线') && w.includes('JSON')));
  assert.ok(json.baseline.counts.new >= 1);
});
