// 上下文压缩的「进行中」状态：状态机（renderer/lib/compaction.mjs）+ 主进程开始/结束事件
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, IDLE, isRunning, isFailed } from '../desktop/src/renderer/lib/compaction.mjs';
import { needsCompaction, assembleContext } from '../desktop/src/main/context.mjs';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';

const cfg = (extra = {}) => ({ baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm', ...extra });
const sse = (chunks) => new Response(
  chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

// ---------- 状态机 ----------

test('compaction: idle → running → done（保留 before/after）', () => {
  assert.equal(IDLE.phase, 'idle');

  const running = reduce(IDLE, { kind: 'compact-start', scope: 'manual', before: 460, at: 1000 });
  assert.equal(running.phase, 'running');
  assert.equal(running.scope, 'manual');
  assert.equal(running.startedAt, 1000);
  assert.equal(running.before, 460);
  assert.ok(isRunning(running));
  assert.ok(!isFailed(running));

  const done = reduce(running, { kind: 'compact-end', scope: 'manual', before: 460, after: 522 });
  assert.equal(done.phase, 'done');
  assert.equal(done.after, 522);
  assert.equal(done.error, '');
  assert.ok(!isRunning(done));
  assert.ok(!isFailed(done));
});

test('compaction: 重复 start 保留首帧（计时/起点不重置），不会被反复点亮', () => {
  const running = reduce(IDLE, { kind: 'compact-start', scope: 'auto', before: 10, at: 500 });
  const again = reduce(running, { kind: 'compact-start', scope: 'auto', before: 99, at: 9000 });
  assert.equal(again, running); // 同一引用：连重渲染都省了
  assert.equal(again.startedAt, 500);
  assert.equal(again.before, 10);
});

test('compaction: 失败分支只留原因，不再转圈', () => {
  const running = reduce(IDLE, { kind: 'compact-start', scope: 'manual' });
  const failed = reduce(running, { kind: 'compact-end', scope: 'manual', error: 'HTTP 500' });
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.error, 'HTTP 500');
  assert.ok(isFailed(failed));
  assert.ok(!isRunning(failed));
});

test('compaction: 重复/迟到 end 幂等——done 不会被后到的 error 翻成 failed', () => {
  const running = reduce(IDLE, { kind: 'compact-start', scope: 'manual' });
  const done = reduce(running, { kind: 'compact-end', scope: 'manual', after: 100 });
  const late = reduce(done, { kind: 'compact-end', scope: 'manual', error: 'late error' });
  assert.equal(late.phase, 'done');
  assert.equal(late.error, '');
  const again = reduce(late, { kind: 'compact-end', scope: 'manual', after: 999 });
  assert.equal(again.after, 100);
});

test('compaction: 另一作用域的结束不能收掉本次（auto 收尾不影响 manual 运行中）', () => {
  const running = reduce(IDLE, { kind: 'compact-start', scope: 'manual', at: 1 });
  const stillRunning = reduce(running, { kind: 'compact-end', scope: 'auto', after: 1 });
  assert.equal(stillRunning.phase, 'running');
  assert.equal(stillRunning.scope, 'manual');
});

test('compaction: 用户取消 → done + cancelled，不当作失败提示', () => {
  const running = reduce(IDLE, { kind: 'compact-start', scope: 'manual' });
  const done = reduce(running, { kind: 'compact-end', scope: 'manual', cancelled: true });
  assert.equal(done.phase, 'done');
  assert.equal(done.cancelled, true);
  assert.equal(done.error, '');
});

test('compaction: 未知事件/畸形输入不改变状态；reset 回 idle', () => {
  const running = reduce(IDLE, { kind: 'compact-start', scope: 'auto', at: 7 });
  assert.equal(reduce(running, { kind: 'some-new-event', x: 1 }), running);
  assert.equal(reduce(running, null), running);
  assert.equal(reduce(undefined, null), IDLE);          // 非对象 → idle
  assert.equal(reduce(running, 'nope'), running);
  assert.equal(reduce(running, { kind: 'compact-reset' }), IDLE);
  assert.equal(reduce({ phase: 'bogus' }, { kind: 'compact-end' }), IDLE);
});

test('compaction: end 不带 scope 时照常收尾（兼容旧事件）', () => {
  const running = reduce(IDLE, { kind: 'compact-start', scope: 'auto', before: 5 });
  const done = reduce(running, { kind: 'compact-end', after: 3 });
  assert.equal(done.phase, 'done');
  assert.equal(done.after, 3);
});

// ---------- 主进程：needsCompaction 与 assembleContext 同一口径 ----------

test('compaction: needsCompaction 与 assembleContext 的入口判断一致（token/字符两种口径）', async () => {
  const big = [
    { role: 'user', content: 'A'.repeat(85000) },
    { role: 'user', content: 'B'.repeat(85000) },
    { role: 'assistant', content: 's1' },
    { role: 'user', content: 's2' },
    { role: 'assistant', content: 's3' }
  ];
  assert.equal(needsCompaction(big), true);
  assert.equal((await assembleContext(big, { summarize: async () => 'S' })).compacted, true);

  const small = [{ role: 'user', content: '你好' }];
  assert.equal(needsCompaction(small), false);
  assert.equal((await assembleContext(small, { summarize: async () => 'S' })).compacted, false);

  // token 口径：给 budgetTokens 时字符口径被忽略
  assert.equal(needsCompaction(small, { budgetTokens: 1 }), true);
  assert.equal(needsCompaction(big, { budgetTokens: 100000 }), false);
});

// ---------- 主进程：自动压缩开始/结束事件 ----------

test('compaction: runAgentTurn 超预算 → 先发 compact-start、收尾发 compact-end（scope auto）', async () => {
  const events = [];
  const messages = [
    { role: 'user', content: 'A'.repeat(85000) },
    { role: 'user', content: 'B'.repeat(85000) },
    { role: 'assistant', content: 's1' },
    { role: 'user', content: 's2' },
    { role: 'assistant', content: 's3' }
  ];
  const out = await runAgentTurn({
    config: cfg(),
    messages,
    summarize: async () => '压缩摘要OK',
    fetchImpl: async () => sse([{ choices: [{ delta: { content: '收到' } }] }]),
    onEvent: (ev) => events.push(ev)
  });
  assert.equal(out.answer, '收到');
  const idxStart = events.findIndex((e) => e.kind === 'compact-start');
  const idxEnd = events.findIndex((e) => e.kind === 'compact-end');
  assert.ok(idxStart >= 0, '应发 compact-start');
  assert.ok(idxEnd > idxStart, 'compact-end 必须在 start 之后');
  assert.equal(events[idxStart].scope, 'auto');
  assert.equal(events[idxEnd].scope, 'auto');
  assert.equal(events[idxEnd].error, undefined);
  assert.ok(events[idxStart].before > 0);
  assert.ok(events[idxEnd].after < events[idxStart].before, '压缩后应小于压缩前');

  // 渲染层状态机串起来就是一次完整的「进行中 → 收起」
  let st = IDLE;
  for (const ev of events) st = reduce(st, ev);
  assert.equal(st.phase, 'done');
});

test('compaction: runAgentTurn 预算内不发压缩事件（不闪一下）', async () => {
  const events = [];
  await runAgentTurn({
    config: cfg(),
    messages: [{ role: 'user', content: '你好' }],
    summarize: async () => 'S',
    fetchImpl: async () => sse([{ choices: [{ delta: { content: '好' } }] }]),
    onEvent: (ev) => events.push(ev)
  });
  assert.equal(events.filter((e) => e.kind === 'compact-start' || e.kind === 'compact-end').length, 0);
});
