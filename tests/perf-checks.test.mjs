import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { setLanguage } from '../desktop/src/renderer/i18n/core.mjs';
import { checkPerfStatic, checkQ5 } from '../src/checks/perf-static.mjs';
import {
  comparePerfBaseline,
  loadPerfBaseline,
  perfBaselinePath,
  savePerfBaseline,
} from '../src/checks/perf-baseline.mjs';

setLanguage('zh'); // 断言中文文案；英文词典由主会话补

async function tmpDir(t, prefix = 'fc-perf-') {
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

const byRule = (result, rule) => result.findings.filter((f) => f.rule === rule);

const SAMPLE_API = `
import { readFileSync } from 'node:fs';

export async function handler(req, res) {
  const data = readFileSync('./users.json', 'utf8');
  res.end(data);
}
`;

// ---------- A. 静态性能反模式 ----------

test('Q5 返回契约与 checkId：findings/warnings/coverageGap（照抄 metrics 形状）', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'routes/users.js', SAMPLE_API);
  const r = await checkPerfStatic(dir, { tier: 'L2' });
  assert.deepEqual(Object.keys(r).sort(), ['checkId', 'coverageGap', 'findings', 'warnings']);
  assert.equal(r.checkId, 'Q5');
  assert.equal(r.coverageGap, null);
  assert.equal(checkQ5, checkPerfStatic);
  const f = byRule(r, 'Q5.sync-io-hotpath')[0];
  assert.ok(f, '应命中热路径同步 IO');
  assert.deepEqual(Object.keys(f).sort(), ['checkId', 'file', 'force', 'line', 'message', 'rule', 'severity', 'snippet', 'source']);
  assert.equal(f.source, 'program');
  assert.equal(f.checkId, 'Q5');
  assert.equal(f.file, 'routes/users.js');
  assert.ok(f.line > 0);
  assert.ok(f.snippet.length <= 120);
  assert.match(f.snippet, /readFileSync/);
});

test('规则1 请求路径同步 IO：中危；L2 check / L3 card；非热路径不报', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'src/api/report.js', SAMPLE_API);
  const l2 = await checkPerfStatic(dir, { tier: 'L2' });
  const f = byRule(l2, 'Q5.sync-io-hotpath')[0];
  assert.equal(f.severity, 'medium');
  assert.equal(f.force, 'check');
  const l3 = await checkPerfStatic(dir, { tier: 'L3' });
  assert.equal(byRule(l3, 'Q5.sync-io-hotpath')[0].force, 'card');

  const cold = await tmpDir(t);
  await writeRel(cold, 'lib/logger.js', `
import { readFileSync } from 'node:fs';
export function warmCache() {
  return readFileSync('./cache.json', 'utf8');
}
`);
  const r = await checkPerfStatic(cold, { tier: 'L2' });
  assert.equal(byRule(r, 'Q5.sync-io-hotpath').length, 0, '文件/函数名都不像热路径时不报');
});

test('规则2 循环内 await：提醒级；定长循环不报', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'src/sync.js', `
export async function persist(rows) {
  for (const row of rows) {
    await save(row);
  }
}
`);
  await writeRel(dir, 'src/fixed.js', `
export async function steps() {
  for (let i = 0; i < 10; i++) {
    await tick(i);
  }
}
`);
  const r = await checkPerfStatic(dir, { tier: 'L2' });
  const hits = byRule(r, 'Q5.await-in-loop');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'src/sync.js');
  assert.equal(hits[0].force, 'check');
  assert.equal(hits[0].severity, 'low');
});

test('规则3 疑似 N+1：循环内逐条查库/请求 → 提醒 + 批量提示', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'src/users.js', `
export async function load(ids) {
  const out = [];
  for (const id of ids) {
    out.push(await db.query({ id }));
  }
  return out;
}
`);
  await writeRel(dir, 'src/http.js', `
import axios from 'axios';
export async function pull(urls) {
  for (const url of urls) {
    await axios.get(url);
  }
}
`);
  const r = await checkPerfStatic(dir, { tier: 'L2' });
  const hits = byRule(r, 'Q5.n-plus-one');
  assert.ok(hits.length >= 2, `应命中 db.query 与 axios.get，实际 ${hits.length}`);
  assert.ok(hits.some((f) => /query/.test(f.message)));
  assert.ok(hits.some((f) => /axios\.get/.test(f.message)));
  assert.match(hits[0].message, /批量/);
});

test('规则4 无上限查询：SQL 无 LIMIT / ORM 无 take 或 limit → 提醒；有上限不报', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'src/repo.js', `
export function allUsers(db) {
  return db.query('SELECT id, name FROM users');
}
export function page(db) {
  return db.query('SELECT id, name FROM users LIMIT 20');
}
export function every(db) {
  return User.findAll({ where: { active: true } });
}
export function paged(db) {
  return User.findAll({ where: { active: true }, limit: 20 });
}
export function chained(db) {
  return User.find({}).take(10);
}
`);
  const r = await checkPerfStatic(dir, { tier: 'L2' });
  const hits = byRule(r, 'Q5.unbounded-query');
  assert.equal(hits.length, 2, '只报无 LIMIT 的 SQL 与无 limit 的 findAll');
  assert.ok(hits.every((f) => f.force === 'check'));
  assert.ok(hits.every((f) => f.severity === 'low'));
});

test('规则5 SELECT *：提醒（显式列名建议）', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'src/star.js', `
export function rows(db) {
  return db.query('SELECT * FROM orders LIMIT 50');
}
`);
  const r = await checkPerfStatic(dir, { tier: 'L3' });
  const hits = byRule(r, 'Q5.select-star');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].force, 'check', '提醒级线索在 L3 也不升 card');
  assert.match(hits[0].message, /列/);
  assert.equal(byRule(r, 'Q5.unbounded-query').length, 0, '有 LIMIT 不算无上限');
});

test('规则6 JSON 深拷贝：提醒（structuredClone 建议）', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'src/clone.js', `
export function copy(big) {
  const next = JSON.parse(JSON.stringify(big));
  return next;
}
`);
  const r = await checkPerfStatic(dir, { tier: 'L2' });
  const hits = byRule(r, 'Q5.json-deep-clone');
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /structuredClone/);
});

test('规则7 阻塞式密钥派生：热路径中危，非热路径低危', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'routes/auth.js', `
import bcrypt from 'bcrypt';
export function login(password) {
  return bcrypt.hashSync(password, 12);
}
`);
  await writeRel(dir, 'lib/seed.js', `
import crypto from 'node:crypto';
export function derive(pw, salt) {
  return crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256');
}
`);
  const r = await checkPerfStatic(dir, { tier: 'L2' });
  const hits = byRule(r, 'Q5.sync-crypto');
  assert.equal(hits.length, 2);
  const hot = hits.find((f) => f.file === 'routes/auth.js');
  const cold = hits.find((f) => f.file === 'lib/seed.js');
  assert.equal(hot.severity, 'medium');
  assert.equal(cold.severity, 'low');
  assert.match(hot.message, /bcrypt\.hashSync/);
});

test('解析失败记 warning 并继续扫其它文件（不中断整轮）', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'src/broken.js', 'export function ( { const = ;');
  await writeRel(dir, 'src/ok.js', `
export function rows(db) {
  return db.query('SELECT * FROM users');
}
`);
  const r = await checkPerfStatic(dir, { tier: 'L2' });
  assert.ok(r.warnings.some((w) => /解析失败/.test(w)), '应有解析失败 warning');
  assert.equal(byRule(r, 'Q5.select-star').length, 1, '坏文件不影响好文件');
  assert.equal(r.coverageGap, null);
});

test('跳过 node_modules 与 exclude 目录；无代码文件时给 warning', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'node_modules/pkg/index.js', 'JSON.parse(JSON.stringify(x));');
  await writeRel(dir, 'custom/skip.js', "db.query('SELECT * FROM t');");
  const r = await checkPerfStatic(dir, { tier: 'L2', excludes: ['custom'] });
  assert.equal(r.findings.length, 0);

  const empty = await tmpDir(t);
  await writeRel(empty, 'README.md', '# 没有代码');
  const e = await checkPerfStatic(empty, { tier: 'L2' });
  assert.equal(e.findings.length, 0);
  assert.ok(e.warnings.some((w) => /未找到可扫描的代码文件/.test(w)));
});

test('规则3/4 不把 Array.prototype.find 当查询；db.find 仍命中', async (t) => {
  const dir = await tmpDir(t);
  await writeRel(dir, 'src/inmemory.js', `
const ROLE_GLYPHS = [];
export function pick(rows) {
  const out = [];
  for (const row of rows) {
    out.push(rows.find((r) => r.id === row.parentId));
  }
  return out;
}
export function glyph(re) {
  return ROLE_GLYPHS.find(([x]) => x.test(re));
}
`);
  await writeRel(dir, 'src/with-db.js', `
export async function one(db, ids) {
  const out = [];
  for (const id of ids) {
    out.push(await db.find({ id }));
  }
  return out;
}
`);
  const r = await checkPerfStatic(dir, { tier: 'L2' });
  assert.equal(byRule(r, 'Q5.n-plus-one').filter((f) => f.file === 'src/inmemory.js').length, 0);
  assert.equal(byRule(r, 'Q5.unbounded-query').filter((f) => f.file === 'src/inmemory.js').length, 0);
  assert.equal(byRule(r, 'Q5.n-plus-one').filter((f) => f.file === 'src/with-db.js').length, 1);
  assert.equal(byRule(r, 'Q5.unbounded-query').filter((f) => f.file === 'src/with-db.js').length, 1);
});

// ---------- B. 压测基线对比 ----------

const rec = (over = {}) => ({
  at: '2026-01-01T00:00:00.000Z',
  target: 'http://localhost:3000/api/orders',
  rps: 1200,
  p97_5: 120,
  errors: 0,
  durationSec: 30,
  connections: 10,
  samples: 3,
  ...over,
});

test('基线：吞吐下降 >20% 判退化，reasons 说人话', () => {
  const prev = rec();
  const cur = rec({ rps: 920 });
  const r = comparePerfBaseline(cur, prev);
  assert.equal(r.regressed, true);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /吞吐下降 23\.3%（1200 → 920 rps）/);
  assert.equal(r.deltas.rps.previous, 1200);
  assert.equal(r.deltas.rps.current, 920);
  assert.equal(r.deltas.rps.pct, -23.3);
});

test('基线：p97.5 上升 >20% 判退化', () => {
  const r = comparePerfBaseline(rec({ p97_5: 150 }), rec());
  assert.equal(r.regressed, true);
  assert.match(r.reasons.join('\n'), /p97\.5 延迟上升 25%（120 → 150 ms）/);
  assert.equal(r.deltas.p97_5.delta, 30);
});

test('基线：errors 从 0 变 >0 判退化（不看百分比）', () => {
  const r = comparePerfBaseline(rec({ errors: 2 }), rec({ errors: 0 }));
  assert.equal(r.regressed, true);
  assert.match(r.reasons.join('\n'), /错误数从 0 变为 2/);
});

test('基线：持平与改善都不判退化', () => {
  const flat = comparePerfBaseline(rec(), rec());
  assert.equal(flat.regressed, false);
  assert.deepEqual(flat.reasons, []);
  assert.equal(flat.warnings.length, 0);

  const better = comparePerfBaseline(rec({ rps: 1500, p97_5: 100 }), rec());
  assert.equal(better.regressed, false);
  assert.deepEqual(better.reasons, []);
  assert.equal(better.deltas.rps.pct, 25);
  assert.equal(better.deltas.p97_5.pct, -16.7);
});

test('基线：首次运行无基线 → 不判退化，只给 warning', () => {
  const r = comparePerfBaseline(rec(), null);
  assert.equal(r.regressed, false);
  assert.deepEqual(r.reasons, []);
  assert.match(r.warnings[0], /首次运行没有基线/);
});

test('基线：样本 < 2 次 → 即使指标恶化也只给 warning', () => {
  const r = comparePerfBaseline(rec({ rps: 500, samples: 1 }), rec({ samples: 1 }));
  assert.equal(r.regressed, false);
  assert.deepEqual(r.reasons, []);
  assert.match(r.warnings.join('\n'), /样本不足（本轮 1 次 \/ 基线 1 次/);
  assert.equal(r.deltas.rps.pct, -58.3, 'deltas 仍然给出，便于人工判断');
});

test('基线：阈值可由 opts 覆盖（吞吐与延迟两个方向）', () => {
  const mildDrop = rec({ rps: 1000 }); // -16.7%，默认 20% 不判
  assert.equal(comparePerfBaseline(mildDrop, rec()).regressed, false);
  assert.equal(comparePerfBaseline(mildDrop, rec(), { rpsDropRatio: 0.1 }).regressed, true);

  const mildRise = rec({ p97_5: 130 }); // +8.3%，默认 20% 不判
  assert.equal(comparePerfBaseline(mildRise, rec()).regressed, false);
  assert.equal(comparePerfBaseline(mildRise, rec(), { p97_5RiseRatio: 0.05 }).regressed, true);
});

test('基线：目标不同给 warning 但仍计算 deltas；缺字段不崩', () => {
  const r = comparePerfBaseline(
    rec({ target: 'http://localhost:3000/api/v2' }),
    rec({ target: 'http://localhost:3000/api/v1' }),
  );
  assert.match(r.warnings.join('\n'), /压测目标不同/);
  assert.ok(r.deltas.rps);

  const missing = comparePerfBaseline({ samples: 3 }, rec());
  assert.equal(missing.regressed, false);
  assert.ok(missing.warnings.some((w) => /缺少 rps/.test(w)));

  const nothing = comparePerfBaseline(null, rec());
  assert.equal(nothing.regressed, false);
  assert.match(nothing.warnings[0], /缺少本轮压测记录/);
});

test('基线落盘：save/load round-trip（.finalcheck/bench/latest.json）', async (t) => {
  const dir = await tmpDir(t, 'fc-perf-base-');
  const saved = await savePerfBaseline(dir, rec());
  assert.equal(saved.path, perfBaselinePath(dir));
  assert.ok(saved.path.endsWith(path.join('.finalcheck', 'bench', 'latest.json')));
  const raw = JSON.parse(await readFile(saved.path, 'utf8'));
  assert.equal(raw.rps, 1200);
  assert.equal(raw.at, rec().at);

  const loaded = await loadPerfBaseline(dir);
  assert.deepEqual(loaded, saved.record);
  assert.equal(loaded.samples, 3);
});

test('基线落盘：缺 at 自动补 ISO 时间；重复保存覆盖旧值（原子写）', async (t) => {
  const dir = await tmpDir(t, 'fc-perf-base-');
  const first = await savePerfBaseline(dir, { rps: 100, samples: 2 });
  assert.match(first.record.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(first.record.target, null);

  await savePerfBaseline(dir, { rps: 200, samples: 2 });
  const loaded = await loadPerfBaseline(dir);
  assert.equal(loaded.rps, 200, '第二次保存应覆盖第一次');
});

test('基线读取：目录不存在/JSON 损坏 → null（不抛异常）', async (t) => {
  const dir = await tmpDir(t, 'fc-perf-base-');
  assert.equal(await loadPerfBaseline(dir), null);

  await mkdir(path.dirname(perfBaselinePath(dir)), { recursive: true });
  await writeFile(perfBaselinePath(dir), '{ not json', 'utf8');
  assert.equal(await loadPerfBaseline(dir), null);
});
