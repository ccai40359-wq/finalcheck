import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import {
  appendUsage,
  readUsage,
  computeStats,
  usageFilePath,
  RETENTION_DAYS,
  MAX_EVENTS
} from '../desktop/src/main/usage-ledger.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const atOffsetDays = (offset) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
};
const atOffsetKey = (offset) => dayKey(new Date(atOffsetDays(offset)));

async function freshFile(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'usage.json');
  process.env.FINALCHECK_USAGE_FILE = file;
  return file;
}

async function seed(file, events) {
  await writeFile(file, JSON.stringify({ version: 1, events }), 'utf8');
}

test('usage-ledger: 追加/读回，形状 version:1 + events', async (t) => {
  const file = await freshFile(t);
  assert.equal(usageFilePath(), file);
  await appendUsage({ at: Date.now() - 1000, model: 'm1', providerId: 'p1', prompt: 10, completion: 5, cached: 3 });
  await appendUsage({ at: Date.now(), model: 'm2', providerId: 'p2', prompt: 20, completion: 7, cached: null });
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.events.length, 2);
  const ledger = await readUsage();
  assert.equal(ledger.version, 1);
  assert.deepEqual(ledger.events.map((e) => e.model), ['m1', 'm2']);
  assert.deepEqual(ledger.events[0], {
    at: raw.events[0].at,
    model: 'm1',
    providerId: 'p1',
    prompt: 10,
    completion: 5,
    cached: 3
  });
  assert.equal(ledger.events[1].cached, null, '缺字段保持 null，不冒充 0');
});

test('usage-ledger: 追加时裁剪 180 天以前的事件', async (t) => {
  const file = await freshFile(t);
  const now = Date.now();
  await seed(file, [
    { at: now - (RETENTION_DAYS + 20) * DAY_MS, model: 'old', providerId: 'p', prompt: 1, completion: 1, cached: null },
    { at: now - 30 * DAY_MS, model: 'mid', providerId: 'p', prompt: 2, completion: 2, cached: null }
  ]);
  await appendUsage({ at: now, model: 'new', providerId: 'p', prompt: 3, completion: 3, cached: null });
  const ledger = await readUsage();
  assert.equal(ledger.events.length, 2);
  assert.deepEqual(ledger.events.map((e) => e.model), ['mid', 'new']);
});

test('usage-ledger: 超过 5000 条时只留最近 5000 条', async (t) => {
  const file = await freshFile(t);
  const now = Date.now();
  const base = now - (MAX_EVENTS + 100) * 1000;
  const events = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => ({
    at: base + i * 1000,
    model: 'm',
    providerId: 'p',
    prompt: i,
    completion: 0,
    cached: null
  }));
  await seed(file, events);
  const result = await appendUsage({ at: now, model: 'm', providerId: 'p', prompt: 7, completion: 3, cached: null });
  assert.equal(result.count, MAX_EVENTS);
  const ledger = await readUsage();
  assert.equal(ledger.events.length, MAX_EVENTS);
  // 最旧两条被挤掉，第一条应为 seed 里的第 3 条
  assert.equal(ledger.events[0].at, base + 2000);
  assert.equal(ledger.events.at(-1).at, now);
});

test('usage-ledger: 坏文件回退空账本并 warning，随后仍可追加', async (t) => {
  const file = await freshFile(t);
  await writeFile(file, '{ definitely not json', 'utf8');
  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  let ledger;
  try {
    ledger = await readUsage();
    assert.deepEqual(ledger, { version: 1, events: [] });
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warned >= 1, '坏文件必须产生 warning');
  await appendUsage({ at: Date.now(), model: 'ok', providerId: 'p', prompt: 1, completion: 1, cached: null });
  const after = await readUsage();
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].model, 'ok');
});

test('usage-ledger: computeStats 的 total/peak/streak/days/models', async (t) => {
  const file = await freshFile(t);
  await seed(file, [
    { at: atOffsetDays(0), model: 'alpha', providerId: 'p', prompt: 100, completion: 50, cached: 40 },
    { at: atOffsetDays(-1), model: 'alpha', providerId: 'p', prompt: 200, completion: 100, cached: null },
    { at: atOffsetDays(-3), model: 'beta', providerId: 'p', prompt: 10, completion: 5, cached: null },
    { at: atOffsetDays(-6), model: 'alpha', providerId: 'p', prompt: 1, completion: 1, cached: null },
    { at: atOffsetDays(-40), model: 'gamma', providerId: 'p', prompt: 1000, completion: 0, cached: null }
  ]);
  const stats = await computeStats({ days: 7 });

  // total：全部历史（1467 = 150 + 300 + 15 + 2 + 1000）
  assert.equal(stats.totalTokens, 1467);
  // peak：单日最高（40 天前 gamma 1000）
  assert.equal(stats.peakTokens, 1000);
  // 今天 + 昨天连续；再往前断档
  assert.equal(stats.currentStreakDays, 2);
  assert.equal(stats.longestStreakDays, 2);
  assert.equal(stats.longestSessionMs, 0, '没有 sessions 入参时为 0');

  // days：7 天窗口补齐缺失日期，最新一天在末尾
  assert.equal(stats.days.length, 7);
  assert.equal(stats.days[0].date, atOffsetKey(-6));
  assert.equal(stats.days.at(-1).date, atOffsetKey(0));
  assert.deepEqual(stats.days.map((d) => d.total), [2, 0, 0, 15, 0, 300, 150]);
  assert.deepEqual(stats.days[3].byModel, { beta: 15 });
  assert.deepEqual(stats.days[6].byModel, { alpha: 150 });

  // models：全部历史降序 + share 0–1
  assert.deepEqual(stats.models.map((m) => m.model), ['gamma', 'alpha', 'beta']);
  assert.deepEqual(stats.models.map((m) => m.tokens), [1000, 452, 15]);
  const shareSum = stats.models.reduce((n, m) => n + m.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);
  assert.ok(Math.abs(stats.models[0].share - 1000 / 1467) < 1e-9);

  // 30 天窗口：-40 天事件不进 days，但仍计入 total
  const stats30 = await computeStats({ days: 30 });
  assert.equal(stats30.days.length, 30);
  assert.equal(stats30.days.reduce((n, d) => n + d.total, 0), 467);
  assert.equal(stats30.totalTokens, 1467);
});

test('usage-ledger: longestSessionMs 可由会话 updatedAt-createdAt 估计', async (t) => {
  await freshFile(t);
  await seed(usageFilePath(), [
    { at: atOffsetDays(0), model: 'm', providerId: 'p', prompt: 1, completion: 1, cached: null }
  ]);
  const stats = await computeStats({
    days: 7,
    sessions: [
      { createdAt: 1000, updatedAt: 61000 },
      { createdAt: 500, updatedAt: 2500 },
      { createdAt: 0, updatedAt: 0 }
    ]
  });
  assert.equal(stats.longestSessionMs, 60000);
});

test('usage-ledger: 并发 append 串行执行，不丢事件/不写坏文件', async (t) => {
  const file = await freshFile(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => appendUsage({
    at: Date.now() + i,
    model: 'm',
    providerId: 'p',
    prompt: i,
    completion: 0,
    cached: null
  })));
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, 1);
  const ledger = await readUsage();
  assert.equal(ledger.events.length, 20);
  assert.deepEqual(ledger.events.map((e) => e.prompt).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
});
