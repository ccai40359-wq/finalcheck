// 流式 tool_calls 拼装回归（会话 fcc4d705）：网关把两个并行调用的 index 都写成 0，
// 旧逻辑按 index `name +=` / `arguments +=`，产出 `audit_projectdownload_gate` +
// 两段 JSON 首尾相接 → 参数必然非法、工具连续两次不执行。
// 锁住：id 是权威键；同 index 的新 id / 已有 name 再出现 name 必须新建 entry；
// 标准 index 0/1 与同 id 分片行为不变。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeStream } from '../desktop/src/main/agent-service.mjs';

const ARGS = String.raw`{"dir":"D:\\rcw-geo\\yanshou"}`;
const ARGS_TAIL = String.raw`"D:\\rcw-geo\\yanshou"}`;

const sse = (chunks) => new Response(
  chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

const deltaChunk = (toolCalls) => ({
  choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: 'tool_calls' }]
});

const tc = (id, name, args, index = 0) => ({
  index,
  ...(id ? { id } : {}),
  type: 'function',
  function: {
    ...(name ? { name } : {}),
    ...(args == null ? {} : { arguments: args })
  }
});

const runStream = (chunks) => consumeStream(sse(chunks), () => {}, () => {}, null);

test('stream: 同一 chunk 两个调用（同 index 不同 id）→ 2 条独立调用，不拼 name/args', async () => {
  const out = await runStream([deltaChunk([
    tc('call_a', 'audit_project', ARGS, 0),
    tc('call_b', 'download_gate', ARGS, 0)
  ])]);

  assert.equal(out.toolCalls.length, 2, `实际：${JSON.stringify(out.toolCalls)}`);
  assert.deepEqual(out.toolCalls.map((c) => c.id), ['call_a', 'call_b']);
  assert.deepEqual(out.toolCalls.map((c) => c.function.name), ['audit_project', 'download_gate']);
  for (const call of out.toolCalls) {
    assert.equal(call.function.arguments, ARGS);
    assert.doesNotThrow(() => JSON.parse(call.function.arguments));
  }
});

test('stream: 连续 chunk 同 index 不同 id（流式交错）→ 2 条独立调用', async () => {
  const out = await runStream([
    deltaChunk([tc('call_a', 'audit_project', '{"dir":', 0)]),
    deltaChunk([tc('call_b', 'download_gate', '{"dir":', 0)]),
    deltaChunk([tc('call_a', null, ARGS_TAIL, 0)]),
    deltaChunk([tc('call_b', null, ARGS_TAIL, 0)])
  ]);

  assert.equal(out.toolCalls.length, 2, `实际：${JSON.stringify(out.toolCalls)}`);
  assert.deepEqual(out.toolCalls.map((c) => c.function.name), ['audit_project', 'download_gate']);
  assert.equal(out.toolCalls[0].function.arguments, ARGS);
  assert.equal(out.toolCalls[1].function.arguments, ARGS);
  for (const call of out.toolCalls) assert.doesNotThrow(() => JSON.parse(call.function.arguments));
});

test('stream: 标准 index 0/1 分片仍各归各（不因新逻辑拆错）', async () => {
  const out = await runStream([
    deltaChunk([tc('call_a', 'audit_project', '{"dir":', 0)]),
    deltaChunk([tc('call_b', 'download_gate', '{"dir":', 1)]),
    deltaChunk([tc('call_a', null, ARGS_TAIL, 0)]),
    deltaChunk([tc('call_b', null, ARGS_TAIL, 1)])
  ]);

  assert.equal(out.toolCalls.length, 2);
  assert.deepEqual(out.toolCalls.map((c) => c.id), ['call_a', 'call_b']);
  assert.deepEqual(out.toolCalls.map((c) => c.function.name), ['audit_project', 'download_gate']);
  for (const call of out.toolCalls) assert.deepEqual(JSON.parse(call.function.arguments), { dir: String.raw`D:\rcw-geo\yanshou` });
});

test('stream: 同 id 的 name/arguments 分片继续合并成一条（不误拆）', async () => {
  const out = await runStream([
    deltaChunk([tc('call_a', 'audit_', '{"di', 0)]),
    deltaChunk([tc('call_a', 'project', 'r":"D:/x"}', 0)])
  ]);

  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].id, 'call_a');
  assert.equal(out.toolCalls[0].function.name, 'audit_project');
  assert.deepEqual(JSON.parse(out.toolCalls[0].function.arguments), { dir: 'D:/x' });
});

test('stream: 无 id 但同 index 已有 name 又出现新 name → 新建 entry（旧合并 bug 的兜底）', async () => {
  const out = await runStream([
    deltaChunk([tc(null, 'audit_project', ARGS, 0)]),
    deltaChunk([tc(null, 'download_gate', ARGS, 0)])
  ]);

  assert.equal(out.toolCalls.length, 2, `无 id 时也必须按 name 拆开：${JSON.stringify(out.toolCalls)}`);
  assert.deepEqual(out.toolCalls.map((c) => c.function.name), ['audit_project', 'download_gate']);
  for (const call of out.toolCalls) assert.equal(call.function.arguments, ARGS);
});

test('stream: 网关完全省略 index 时，参数续片仍合并到同一条', async () => {
  const out = await runStream([
    deltaChunk([tc('call_a', 'audit_project', '{"dir":', null)]),
    deltaChunk([tc(null, null, ARGS_TAIL, null)])
  ]);

  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].function.name, 'audit_project');
  assert.equal(out.toolCalls[0].function.arguments, ARGS);
});
