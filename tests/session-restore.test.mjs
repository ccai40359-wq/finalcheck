// 切会话后「正在跑的工作流卡片消失」的回归：恢复实时回合时必须把 workflow 快照带回来
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRunningRun } from '../desktop/src/renderer/lib/session-restore.mjs';

const snapshot = {
  kind: 'workflow', script: true, running: true, goal: 'g', startedAt: 1, ms: 12000, concurrency: 4,
  phases: [['g1'], ['fa#0', 'fa#1']],
  steps: [{ id: 'g1', name: 'L3 硬闸', op: 'gate', status: 'success' }]
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

test('session-restore: 用户消息没落盘时补上；已落盘不重复', () => {
  const loaded = [{ role: 'user', content: '跑' }];
  const same = mergeRunningRun(loaded, { content: 'x', events: [], startedAt: 5, userMessage: '跑' });
  assert.equal(same.messages.filter((m) => m.role === 'user').length, 1);
  const stale = mergeRunningRun([], { content: 'x', events: [], startedAt: 5, userMessage: '跑' });
  assert.deepEqual(stale.messages[0], { role: 'user', content: '跑' });
});

test('session-restore: 已手动停止 → 不是 streaming，标 interrupted', () => {
  const r = mergeRunningRun([], { content: 'x', events: [], startedAt: 5 }, { stopped: true });
  assert.equal(r.messages[0].streaming, false);
  assert.equal(r.messages[0].interrupted, true);
});
