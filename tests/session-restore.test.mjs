// 切会话后「正在跑的工作流卡片消失」的回归：恢复实时回合时必须把 workflow 快照带回来
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunningRun, shouldReloadSessionFromDisk } from '../desktop/src/renderer/lib/session-restore.mjs';

const snapshot = {
  kind: 'workflow', script: true, running: true, goal: 'g', startedAt: 1, ms: 12000, concurrency: 4,
  phases: [['g1'], ['fa#0', 'fa#1']],
  steps: [{ id: 'g1', name: 'L3 硬闸', op: 'gate', status: 'success' }]
};

const askTrace = {
  tool: 'ask_user', callId: 'ask-1', status: 'ok',
  args: JSON.stringify({ question: '按 L2 还是 L3？', options: [{ label: 'L2' }, { label: 'L3' }] }),
  result: { answer: 'L2' }
};

test('session-restore: 没有在跑的回合 → 原样返回', () => {
  const loaded = [{ role: 'user', content: 'hi' }];
  const r = mergeRunningRun(loaded, null);
  assert.equal(r.appended, false);
  assert.deepEqual(r.messages, loaded);
});

test('session-restore: 恢复实时回合时带上 workflow 快照（卡片不消失）', () => {
  const loaded = [{ role: 'user', content: '跑 L3' }];
  const r = mergeRunningRun(loaded, { content: '我先探查…', events: [], startedAt: 5, workflow: snapshot });
  assert.equal(r.appended, true);
  const last = r.messages[r.messages.length - 1];
  assert.equal(last.role, 'assistant');
  assert.equal(last.streaming, true);
  assert.equal(last.workflow.goal, 'g');
  assert.deepEqual(last.workflow.steps, snapshot.steps);
  assert.equal(last.workflow.concurrency, 4);
});

test('session-restore: workflow-start 骨架也恢复（首个快照还没到的情况）', () => {
  const loaded = [{ role: 'user', content: '跑' }];
  const r = mergeRunningRun(loaded, { content: '', events: [], startedAt: 5, workflowStarting: true });
  assert.equal(r.messages[r.messages.length - 1].workflowStarting, true);
});

test('session-restore: 用户消息没落盘时补上；已落盘不重复（末尾是 user 的旧用例）', () => {
  const loaded = [{ role: 'user', content: '跑' }];
  const same = mergeRunningRun(loaded, { content: 'x', events: [], startedAt: 5, userMessage: '跑' });
  assert.equal(same.messages.filter((m) => m.role === 'user').length, 1);
  const stale = mergeRunningRun([], { content: 'x', events: [], startedAt: 5, userMessage: '跑' });
  assert.deepEqual(stale.messages[0], { role: 'user', content: '跑' });
});

test('session-restore: 磁盘末尾是 pending assistant（user 在它前面）→ user 不重复、assistant 不重复', () => {
  const loaded = [
    { role: 'user', content: '对 rcw-ai-chatbot 按 L2 体检' },
    { role: 'assistant', content: '我先看目录…', interrupted: true, trace: [askTrace] }
  ];
  const r = mergeRunningRun(loaded, {
    content: '我先看目录…继续输出', events: [{ kind: 'tool' }], startedAt: 7,
    userMessage: '对 rcw-ai-chatbot 按 L2 体检'
  });
  assert.equal(r.appended, true);
  assert.equal(r.messages.filter((m) => m.role === 'user').length, 1, 'user 只能有一条');
  assert.equal(r.messages.filter((m) => m.role === 'assistant').length, 1, 'assistant 只能有一条');
  const live = r.messages[r.messages.length - 1];
  assert.equal(live.streaming, true);
  assert.equal(live.interrupted, undefined, '正在跑的回合不能误标「已停止」');
  assert.equal(live.content, '我先看目录…继续输出');
  assert.deepEqual(live.trace, [askTrace], '本回合已落盘的 trace 要保留（历史卡仍可还原）');
});

test('session-restore: 磁盘末尾是别的回合的 assistant → 不误删，实时副本照常追加', () => {
  const loaded = [
    { role: 'user', content: '上一轮' },
    { role: 'assistant', content: '上一轮答案', interrupted: true, trace: [] }
  ];
  const r = mergeRunningRun(loaded, {
    content: '新回答', events: [], startedAt: 9, userMessage: '这一轮'
  });
  assert.equal(r.messages.length, 4);
  assert.equal(r.messages[2].content, '这一轮');
  assert.equal(r.messages[3].content, '新回答');
});

test('session-restore: 真崩溃重启（无实时回合）→ 磁盘 interrupted 语义原样保留', () => {
  const loaded = [
    { role: 'user', content: '跑' },
    { role: 'assistant', content: '半句', interrupted: true, trace: [askTrace] }
  ];
  const r = mergeRunningRun(loaded, null);
  assert.equal(r.appended, false);
  assert.equal(r.messages[1].interrupted, true);
  assert.deepEqual(r.messages[1].trace, [askTrace]);
});

test('session-restore: 已手动停止 → 不是 streaming，标 interrupted', () => {
  const r = mergeRunningRun([], { content: 'x', events: [], startedAt: 5 }, { stopped: true });
  assert.equal(r.messages[0].streaming, false);
  assert.equal(r.messages[0].interrupted, true);
});

test('session-restore: openSession 守卫 —— 同 id 正在跑/在 send 中 → 不从磁盘重建', () => {
  assert.equal(shouldReloadSessionFromDisk({ activeId: 's1', sessionId: 's1', liveRun: true }), false);
  assert.equal(shouldReloadSessionFromDisk({ activeId: 's1', sessionId: 's1', inflight: true }), false);
});

test('session-restore: openSession 守卫 —— 不同 id / 已结束 → 正常重建', () => {
  assert.equal(shouldReloadSessionFromDisk({ activeId: 's1', sessionId: 's2', liveRun: true }), true);
  assert.equal(shouldReloadSessionFromDisk({ activeId: 's1', sessionId: 's1', liveRun: false, inflight: false }), true);
  assert.equal(shouldReloadSessionFromDisk({ activeId: null, sessionId: 's1', liveRun: true }), true);
});
