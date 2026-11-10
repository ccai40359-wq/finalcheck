// 断点续跑的选择逻辑：同一目标、没跑完、还新鲜 → 自动复用；跑完的/别人的/过期的 → 不接管
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickResumableRun, RESUME_FRESH_MS } from '../desktop/src/main/workflow-journal.mjs';

const NOW = 1_800_000_000_000;
const mk = (runId, goal, patch = {}) => ({
  version: 1, runId, goal, startedAt: NOW - 60_000, finishedAt: null, stopped: false, steps: {}, ...patch
});

test('resume-pick: 中断（stopped）的同一目标 → 续跑它', () => {
  const journals = [mk('wf-a', '对 X 做 L3 验收', { stopped: true })];
  assert.equal(pickResumableRun(journals, '对 X 做 L3 验收', { now: NOW }), 'wf-a');
});

test('resume-pick: 有失败步骤的同一目标 → 续跑', () => {
  const journals = [mk('wf-b', 'goal', { finishedAt: NOW - 1000, steps: { s1: { status: 'success' }, s2: { status: 'failed' } } })];
  assert.equal(pickResumableRun(journals, 'goal', { now: NOW }), 'wf-b');
});

test('resume-pick: 完整跑完且无失败 → 不接管（全新运行）', () => {
  const journals = [mk('wf-c', 'goal', { finishedAt: NOW - 1000, steps: { s1: { status: 'success' } } })];
  assert.equal(pickResumableRun(journals, 'goal', { now: NOW }), null);
});

test('resume-pick: 目标不同 / 目标为空 → 不接管', () => {
  const journals = [mk('wf-d', '另一个目标', { stopped: true })];
  assert.equal(pickResumableRun(journals, 'goal', { now: NOW }), null);
  assert.equal(pickResumableRun(journals, '   ', { now: NOW }), null);
});

test('resume-pick: 超过新鲜期（7 天）→ 不接管', () => {
  const journals = [mk('wf-e', 'goal', { stopped: true, startedAt: NOW - RESUME_FRESH_MS - 1000 })];
  assert.equal(pickResumableRun(journals, 'goal', { now: NOW }), null);
});

test('resume-pick: 多个候选取最新的', () => {
  const journals = [
    mk('wf-old', 'goal', { stopped: true, startedAt: NOW - 600_000 }),
    mk('wf-new', 'goal', { stopped: true, startedAt: NOW - 60_000 })
  ];
  assert.equal(pickResumableRun(journals, 'goal', { now: NOW }), 'wf-new');
});
