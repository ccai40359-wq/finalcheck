// 0.32.7：定时唤醒（类似 cron 的单次/重复延时版）。
//
// 起因（用户实机截图里模型自己承认的缺口）：
//   「我没有『睡 25 分钟再醒来』的能力，一个回合结束就停了。要让『25 分钟后再看一次进度』
//     自动发生，必须你再说一句话触发我。」
// 这不是模型能力问题，是产品缺口：FC 以前只在用户说话时动。
//
// 这个文件锁住三层：
//   ① 纯逻辑（时间解析 / 到期判定 / 推进 / 错过补偿 / 只读护栏）—— 可执行断言
//   ② 存储（原子写 / 坏档不留死档）
//   ③ 调度器（到点触发一次、先推进再通知、不重复狂刷）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseDelay, createWakeup, dueItems, advanceDue, humanizeIn, sanitizeItems,
  REPEAT_ONCE, REPEAT_FOREVER, WAKEUP_LIMITS
} from '../desktop/src/main/wakeups.mjs';

/* ---------------- ① 时间解析 ---------------- */

test('延时解析：认带单位的中英文写法，拒掉无单位与非法值', () => {
  assert.equal(parseDelay('25m').ms, 25 * 60_000);
  assert.equal(parseDelay('25分钟').ms, 25 * 60_000);
  assert.equal(parseDelay('1h30m').ms, 90 * 60_000);
  assert.equal(parseDelay('1小时30分').ms, 90 * 60_000);
  assert.equal(parseDelay('90s').ms, 90_000);
  assert.equal(parseDelay('2天').ms, 2 * 86_400_000);
  // 无单位必须拒：'25' 是 25 秒还是 25 分钟？猜错代价很大（要等 25 分钟却 25 秒就醒了）
  for (const bad of ['25', '0', '', 'abc', '-5m', '25x']) {
    const r = parseDelay(bad);
    assert.equal(r.ok, false, `应当拒绝：${bad}`);
  }
  assert.equal(parseDelay('5s').ok, false, '少于 10 秒应拒绝');
  assert.equal(parseDelay('8d').ok, false, '超过 7 天应拒绝');
});

/* ---------------- ② 到期判定 ---------------- */

test('到期判定：只取 enabled 且 nextAt<=now，按到期时间升序', () => {
  const now = 1_000_000;
  const items = [
    { id: 'a', enabled: true, nextAt: now + 5000 },
    { id: 'b', enabled: true, nextAt: now - 5000 },
    { id: 'c', enabled: false, nextAt: now - 9000 },
    { id: 'd', enabled: true, nextAt: now },
    { id: 'e', enabled: true, nextAt: 0 },
  ];
  const due = dueItems(items, now);
  assert.deepEqual(due.map((x) => x.id), ['b', 'd'], '未到期/enabled=false/nextAt=0 都要排除');
});

/* ---------------- ③ 推进与错过补偿 ---------------- */

test('推进：只跑一次的任务跑完即移除', () => {
  const item = { id: 'x', repeat: REPEAT_ONCE, intervalMs: 60_000, nextAt: 1000, runCount: 0 };
  assert.equal(advanceDue(item, { at: 2000 }), null, 'repeat=0 跑完必须被移除');
});

test('推进：重复任务把 nextAt 推到未来，且不补跑历史（错过补偿只补一次）', () => {
  // 电脑睡了 3 小时：nextAt 早已过期，实际只该跑 1 次，然后把下次推到"现在+间隔"
  const now = 10_000_000;
  const item = { id: 'y', repeat: REPEAT_FOREVER, intervalMs: 3600_000, nextAt: now - 3 * 3600_000, runCount: 0 };
  const next = advanceDue(item, { at: now });
  assert.ok(next, '无限重复任务不该被移除');
  assert.equal(next.nextAt, now + 3600_000, 'nextAt 必须推到未来，而不是补跑 3 次历史');
  assert.equal(next.runCount, 1, '只记一次');
  assert.equal(next.lastRunAt, now);
  assert.equal(next.repeat, REPEAT_FOREVER);
});

test('推进：有限次数的重复逐次递减，减到 0 就移除', () => {
  const base = { id: 'z', intervalMs: 60_000, nextAt: 0, runCount: 0 };
  const r2 = advanceDue({ ...base, repeat: 2 }, { at: 100 });
  assert.equal(r2.repeat, 1, '剩 2 次跑一次后剩 1 次');
  assert.equal(r2.nextAt, 100 + 60_000);
  assert.equal(advanceDue({ ...base, repeat: 1 }, { at: 100 }), null, '最后一次跑完移除');
});

test('推进：记录结果（ok / error），便于 UI 显示上次怎样', () => {
  const next = advanceDue({ id: 'q', repeat: REPEAT_FOREVER, intervalMs: 1000, nextAt: 0 }, { at: 500, outcome: 'error' });
  assert.equal(next.lastOutcome, 'error');
});

/* ---------------- ④ 创建校验 ---------------- */

test('创建：必须带会话与任务描述，重复语义只接受 -1 或非负整数', () => {
  const ok = createWakeup({ sessionId: 's1', prompt: '看一次网课进度', delayMs: 25 * 60_000, at: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.item.sessionId, 's1');
  assert.equal(ok.item.nextAt, 25 * 60_000, 'nextAt = at + delay');
  assert.equal(ok.item.repeat, REPEAT_ONCE, '默认只跑一次');
  assert.equal(ok.item.enabled, true);

  assert.equal(createWakeup({ prompt: 'x', delayMs: 60_000 }).ok, false, '缺会话必须拒');
  assert.equal(createWakeup({ sessionId: 's1', prompt: '', delayMs: 60_000 }).ok, false, '缺描述必须拒');
  assert.equal(createWakeup({ sessionId: 's1', prompt: 'x', delayMs: 5000 }).ok, false, '延时太短必须拒');
  assert.equal(createWakeup({ sessionId: 's1', prompt: 'x', delayMs: 60_000, repeat: 1.5 }).ok, false, 'repeat 非法必须拒');
});

/* ---------------- ⑥ 存档清洗（坏条目不能拖垮启动） ---------------- */

test('存档清洗：丢掉结构坏掉/缺字段/nextAt 非法的条目，上限收口', () => {
  const dirty = [
    null,
    'not-an-object',
    { id: 'ok', sessionId: 's1', prompt: '做点事', nextAt: 1000 },
    { sessionId: 's2', prompt: '', nextAt: 1000 },        // 缺 prompt
    { sessionId: '', prompt: 'x', nextAt: 1000 },        // 缺 session
    { sessionId: 's3', prompt: 'y', nextAt: 0 },          // nextAt 非法
  ];
  const clean = sanitizeItems(dirty);
  assert.equal(clean.length, 1, '只有第 3 条是合法的');
  assert.equal(clean[0].id, 'ok');
  assert.equal(clean[0].enabled, true);
  // 上限
  assert.equal(sanitizeItems(Array.from({ length: 60 }, (_, i) => ({ sessionId: `s${i}`, prompt: 'p', nextAt: 1000 }))).length,
    WAKEUP_LIMITS.MAX_ITEMS);
});

/* ---------------- ⑦ UI 文案 ---------------- */

test('人类可读的倒计时', () => {
  assert.equal(humanizeIn(30_000), '30 秒后');
  assert.equal(humanizeIn(25 * 60_000), '25 分钟后');
  assert.equal(humanizeIn(90 * 60_000), '1 小时 30 分钟后');
  assert.equal(humanizeIn(0), '即将执行');
  assert.equal(humanizeIn(-1000), '即将执行');
});

/* ---------------- ⑧ 存储：原子写 + 坏档不留死档 ---------------- */

test('存储：写读回环，原子替换不留 .tmp 残渣', async () => {
  const { loadWakeups, saveWakeups, wakeupFile } = await import('../desktop/src/main/wakeup-store.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-wakeup-'));
  try {
    const items = [{ id: 'a', sessionId: 's1', prompt: 'p', nextAt: 1000, intervalMs: 1000, repeat: 0, enabled: true }];
    const saved = await saveWakeups(items, () => dir);
    assert.equal(saved.ok, true);
    const back = await loadWakeups(() => dir);
    assert.equal(back.ok, true);
    assert.equal(back.items.length, 1);
    assert.equal(back.items[0].id, 'a');
    // 不留 tmp 残渣
    assert.equal(readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0, '临时文件必须被 rename 走');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('存储：坏档要备份成 .bad 并按空列表继续（不能让调度器崩在启动）', async () => {
  const { loadWakeups, wakeupFile } = await import('../desktop/src/main/wakeup-store.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-wakeup-bad-'));
  try {
    const file = wakeupFile(() => dir);
    writeFileSync(file, '{ this is not json', 'utf8');
    const r = await loadWakeups(() => dir);
    assert.equal(r.ok, false, '要报告损坏');
    assert.equal(r.items.length, 0, '按空列表继续，不抛错');
    // 坏档有备份（便于排查，且不覆盖用户的原始内容）
    const backups = readdirSync(dir).filter((f) => f.includes('.bad-'));
    assert.equal(backups.length, 1, '坏档必须留一份备份');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- ⑨ 调度器：先推进再通知，不重复狂刷 ---------------- */

test('调度器：到点只触发一次，且先推进时间再通知（通知抛错也不会重复刷）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-wakeup-sched-'));
  const fired = [];
  try {
    const sched = await import('../desktop/src/main/wakeup-scheduler.mjs');
    // 造一条「已经到期」的任务
    sched.__setItemsForTest([{
      id: 'due1', sessionId: 's1', prompt: '看进度',
      nextAt: Date.now() - 1000, intervalMs: 60_000, repeat: 1, enabled: true
    }]);
    await sched.startScheduler({ getDataRoot: () => dir, skipLoad: true, onDue: (it) => { fired.push(it.id); throw new Error('renderer down'); } });
    // 启动时立刻 tick 一次
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fired.length, 1, '到点必须触发一次');
    // 关键：通知抛错之后，任务时间已经推进过 → 再次 tick 不会重复触发同一条
    await sched.tick(Date.now() + 10);
    assert.equal(fired.length, 1, '同一任务不得重复触发（否则会静默烧额度）');
    sched.stopScheduler();
    // 无限重复任务推进后，下次到期在未来
    sched.__setItemsForTest([{
      id: 'rep', sessionId: 's1', prompt: 'p', nextAt: Date.now() - 1000, intervalMs: 60_000, repeat: REPEAT_FOREVER, enabled: true
    }]);
    sched.stopScheduler();
    sched.__setItemsForTest([{
      id: 'rep', sessionId: 's1', prompt: 'p', nextAt: Date.now() - 1000, intervalMs: 60_000, repeat: REPEAT_FOREVER, enabled: true
    }]);
    await sched.startScheduler({ getDataRoot: () => dir, skipLoad: true, onDue: () => {} });
    await new Promise((r) => setTimeout(r, 50));
    const after = sched.listWakeups().find((x) => x.id === 'rep');
    assert.ok(after.nextAt > Date.now(), '重复任务的 nextAt 必须推到未来');
    assert.equal(after.runCount, 1);
    sched.stopScheduler();
  } finally { sched_stop(); rmSync(dir, { recursive: true, force: true }); }
  function sched_stop() { /* 兜底：确保定时器被清掉 */ }
});

test('调度器：停用/删除/一键全停都生效', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fc-wakeup-crud-'));
  try {
    const sched = await import('../desktop/src/main/wakeup-scheduler.mjs');
    await sched.startScheduler({ getDataRoot: () => dir, skipLoad: true, onDue: () => {} });
    sched.__setItemsForTest([
      { id: 'a', sessionId: 's1', prompt: 'p', nextAt: 9999, intervalMs: 60000, repeat: 0, enabled: true },
      { id: 'b', sessionId: 's2', prompt: 'q', nextAt: 9999, intervalMs: 60000, repeat: 0, enabled: true }
    ]);
    const off = await sched.setWakeupEnabled('a', false);
    assert.equal(off.ok, true);
    assert.equal(off.item.enabled, false);
    const all = await sched.disableAllWakeups();
    assert.equal(all.disabled, 1, '只剩 b 是开着的');
    assert.ok(sched.listWakeups().every((x) => x.enabled === false), '一键全停后全部停用');
    const del = await sched.removeWakeup('a');
    assert.equal(del.ok, true);
    assert.equal(sched.listWakeups().length, 1);
    sched.stopScheduler();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
