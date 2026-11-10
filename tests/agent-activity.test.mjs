// 活动提示（WorkingStatus 实时文案）：真事件驱动、节流、重试与 workflow 骨架
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';
import { activityText, activityTone, retryLabel, DEFAULT_WORKING_LABEL } from '../desktop/src/renderer/chat/activity.mjs';

const cfg = (extra = {}) => ({ baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm', ...extra });
const sse = (chunks) => new Response(
  chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);
const toolCallChunk = (name, args, id = 'c1') => sse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] }
]);

test('activity: 第一个 content token 只发一次 Writing…', async () => {
  const events = [];
  const mockFetch = async () => sse([
    { choices: [{ delta: { content: '你' } }] },
    { choices: [{ delta: { content: '好' } }] },
    { choices: [{ delta: { content: '呀' } }] }
  ]);
  const out = await runAgentTurn({
    config: cfg(), messages: [], tools: {}, fetchImpl: mockFetch,
    onEvent: (e) => events.push(e)
  });
  assert.equal(out.answer, '你好呀');
  const writing = events.filter((e) => e.kind === 'activity' && e.label === 'Writing…');
  assert.equal(writing.length, 1, '多个 content token 只应提示一次 Writing…');
});

test('activity: tool_calls 增量 → Writing <tool>…，500ms 内多次增量只发一条', async () => {
  const events = [];
  const longArgs = JSON.stringify({ dir: 'D:/x', pad: 'a'.repeat(1000) });
  const chunks = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'p1', function: { name: 'probe_target', arguments: longArgs.slice(0, 60) } }] } }] }];
  for (let i = 60; i < longArgs.length; i += 200) {
    chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: longArgs.slice(i, i + 200) } }] } }] });
  }
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) return sse(chunks);
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  await runAgentTurn({
    config: cfg(), messages: [], tools: { probe_target: async () => ({ ok: 1 }) },
    fetchImpl: mockFetch, onEvent: (e) => events.push(e)
  });
  const writing = events.filter((e) => e.kind === 'activity' && e.tool === 'probe_target' && /^Writing/.test(e.label || ''));
  assert.equal(writing.length, 1, `参数流应只提示一条（节流 500ms），实际 ${writing.length} 条`);
  assert.equal(writing[0].label, 'Writing probe_target…');
  assert.equal(typeof writing[0].chars, 'number');
});

test('activity: 同一响应里先流工具参数再流正文 → Writing script…', async () => {
  const events = [];
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) {
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'p1', function: { name: 'probe_target', arguments: '{"url":"http://x"}' } }] } }] },
        { choices: [{ delta: { content: '先查一下' } }] }
      ]);
    }
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  await runAgentTurn({
    config: cfg(), messages: [], tools: { probe_target: async () => ({ ok: 1 }) },
    fetchImpl: mockFetch, onEvent: (e) => events.push(e)
  });
  assert.ok(events.some((e) => e.kind === 'activity' && e.label === 'Writing script…'));
});

test('activity: 工具开始执行 → Calling <tool>…（在 tool-start 之前）', async () => {
  const events = [];
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) return toolCallChunk('audit_project', '{"dir":"D:/x"}');
    return sse([{ choices: [{ delta: { content: '体检完成' } }] }]);
  };
  await runAgentTurn({
    config: cfg(), messages: [], tools: { audit_project: async () => ({ verdict: '过' }) },
    fetchImpl: mockFetch, onEvent: (e) => events.push(e)
  });
  const calling = events.findIndex((e) => e.kind === 'activity' && e.label === 'Calling audit_project…');
  const started = events.findIndex((e) => e.kind === 'tool-start' && e.name === 'audit_project');
  assert.ok(calling >= 0, '应有 Calling audit_project…');
  assert.ok(started >= 0, '应有 tool-start');
  assert.ok(calling < started, 'Calling 提示应在工具开始之前');
});

test('activity: 网关超时自动重试 → retry 事件 attempt=2/5', async () => {
  const events = [];
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) {
      const err = new Error('fetch failed');
      err.name = 'TimeoutError';
      throw err;
    }
    return sse([{ choices: [{ delta: { content: '重连后的回答' } }] }]);
  };
  const out = await runAgentTurn({
    config: cfg(), messages: [], tools: {}, fetchImpl: mockFetch,
    onEvent: (e) => events.push(e)
  });
  assert.equal(out.answer, '重连后的回答');
  const retry = events.find((e) => e.kind === 'retry');
  assert.ok(retry, '应发出 retry 事件');
  assert.equal(retry.attempt, 2, '1 次失败后重试的是第 2 次尝试');
  assert.equal(retry.max, 5);
  assert.match(retry.reason, /超时|timeout/i);
});

test('activity: run_workflow 开始 → workflow-start + Calling run_workflow…', async () => {
  const events = [];
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) return toolCallChunk('run_workflow', JSON.stringify({ goal: '并行调研', steps: [{ id: 's1', prompt: '查 A' }] }));
    return sse([{ choices: [{ delta: { content: '工作流完成' } }] }]);
  };
  await runAgentTurn({
    config: cfg(), messages: [],
    tools: { run_workflow: async () => ({ ok: true, results: [] }) },
    fetchImpl: mockFetch, onEvent: (e) => events.push(e)
  });
  const wf = events.find((e) => e.kind === 'workflow-start');
  assert.ok(wf, '应发出 workflow-start（卡片先出骨架）');
  assert.equal(wf.tool, 'run_workflow');
  assert.ok(events.some((e) => e.kind === 'activity' && e.label === 'Calling run_workflow…'));
});

test('activity: 没有事件时 WorkingStatus 默认文案不变（不回归）', () => {
  assert.equal(DEFAULT_WORKING_LABEL, 'Working');
  assert.equal(activityText(null), 'Working');
  assert.equal(activityText({}), 'Working');
  assert.equal(activityText({ label: '  ' }), 'Working');
  assert.equal(activityText({ label: 'Thinking…' }), 'Thinking…');
  assert.equal(activityTone(null), 'activity');
  assert.equal(activityTone({ kind: 'retry' }), 'retry');
  // retry 文案：重试 2/5 · <原因截 40>；网关 5xx/网络错误统一说「网关无响应」
  assert.equal(retryLabel({ attempt: 2, max: 5, reason: 'HTTP 503 Service Unavailable' }), '重试 2/5 · 网关无响应');
  assert.equal(retryLabel({ attempt: 2, max: 5, reason: 'connection reset by peer' }), '重试 2/5 · 网关无响应');
  const long = retryLabel({ attempt: 2, max: 5, reason: 'x'.repeat(60) });
  assert.ok(long.startsWith('重试 2/5 · '));
  assert.ok(long.endsWith('…'));
  assert.ok(long.length <= '重试 2/5 · '.length + 41);
});
