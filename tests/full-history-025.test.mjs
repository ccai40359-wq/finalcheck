// 0.25：对齐 Claude Code 的上下文——跨轮带完整工具过程、默认不设速度上限、以网关真实用量判断压缩。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';
import { expandToolHistory, turnToolMessages } from '../desktop/src/main/full-history.mjs';

const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const call = (id, name, args) => ({ index: 0, id, function: { name, arguments: JSON.stringify(args) } });

test('跨轮：下一轮带上的历史与上一轮真实发出的消息逐字节一致（前缀缓存能接着命中）', async () => {
  const bodies = [];
  let n = 0;
  const fetchImpl = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    n++;
    if (n === 1) return sse([{ choices: [{ delta: { content: '先看两个文件。' } }] }, { choices: [{ delta: { tool_calls: [call('c1', 'read_file', { path: 'a.ts' }), { ...call('c2', 'read_file', { path: 'b.ts' }), index: 1 }] } }] }]);
    if (n === 2) return sse([{ choices: [{ delta: { tool_calls: [call('c3', 'run_command', { command: 'npm test' })] } }] }]);
    return sse([{ choices: [{ delta: { content: '改好了，测试通过。' } }] }]);
  };
  const tools = {
    read_file: async ({ path }) => ({ path, content: `// ${path}\nexport const x = 1;` }),
    run_command: async () => ({ code: 0, stdout: 'ok' }),
  };
  const turn1 = [{ role: 'user', content: '修一下 a.ts 和 b.ts' }];
  const out1 = await runAgentTurn({ config: { baseUrl: 'https://mock/v1', apiKey: 'k', model: 'm', contextWindow: 1000000 }, messages: turn1, tools, fetchImpl, systemPrompt: 'sys' });
  assert.equal(out1.answer, '改好了，测试通过。');
  const lastSentTurn1 = bodies.at(-1).messages; // [sys, user, assistant(tool_calls x2), tool, tool, assistant(tool_calls), tool]

  // 下一轮：渲染层只送「用户原话 + 最终回答」，主进程用库里的 trace 展开
  const db = [{ role: 'user', content: turn1[0].content }, { role: 'assistant', content: out1.answer, trace: out1.trace }];
  const wire = [...turn1, { role: 'assistant', content: out1.answer }, { role: 'user', content: '再加个测试' }];
  const ex = expandToolHistory(wire, db);
  assert.equal(ex.expanded, 1);
  assert.equal(ex.steps, 3);
  const turn2Prefix = [{ role: 'system', content: 'sys' }, ...ex.messages];
  const norm = (m) => JSON.parse(JSON.stringify({ role: m.role, content: m.content ?? null, ...(m.tool_calls ? { tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: c.type || 'function', function: c.function })) } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) }));
  assert.deepEqual(turn2Prefix.slice(0, lastSentTurn1.length).map(norm), lastSentTurn1.map(norm), '上一轮发过的部分一字不差');
  // 并发的两个 read_file 在同一条 assistant 里（同一 round）
  const firstAsst = ex.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(firstAsst.tool_calls.length, 2);
  assert.equal(firstAsst.content, '先看两个文件。');
  // 最终回答和本轮用户消息在最后
  assert.deepEqual(ex.messages.slice(-2), [{ role: 'assistant', content: out1.answer }, { role: 'user', content: '再加个测试' }]);
});

test('expandToolHistory：中断/出错的回合不展开（交给中断回放）；没有工具的回合原样', () => {
  const db = [
    { role: 'assistant', content: '你好', trace: [] },
    { role: 'assistant', content: '半句', interrupted: true, trace: [{ tool: 'read_file', args: '{}', result: { ok: 1 } }] },
  ];
  const ctx = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '你好' }, { role: 'user', content: '继续' }];
  const ex = expandToolHistory(ctx, db);
  assert.equal(ex.expanded, 0);
  assert.deepEqual(ex.messages, ctx);
});

test('turnToolMessages：老数据没有 round 时按「带 say 的步骤开新一轮」；超长落盘结果按落盘提示还原', () => {
  const msgs = turnToolMessages([
    { tool: 'read_file', args: '{"path":"a"}', result: { content: 'A' }, say: '先读 a', callId: 'x1' },
    { tool: 'read_file', args: '{"path":"b"}', result: { content: 'B' }, callId: 'x2' },
    { tool: 'run_command', args: '{"command":"ls"}', result: { truncated: true, spillFile: 'D:/spill/1.json', chars: 90000, preview: 'head…' }, say: '再跑命令', callId: 'x3' },
  ]);
  assert.equal(msgs.filter((m) => m.role === 'assistant').length, 2);
  assert.equal(msgs[0].tool_calls.length, 2);
  const spilled = msgs.find((m) => m.tool_call_id === 'x3');
  assert.match(spilled.content, /已完整落盘/);
  assert.match(spilled.content, /D:\/spill\/1\.json/);
});

test('默认不设速度上限：1M 窗口下上下文涨到 20 多万也不折叠任何工具结果', async () => {
  const bodies = [];
  let n = 0;
  const ROUNDS = 30;
  const fetchImpl = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    n++;
    if (n <= ROUNDS) return sse([{ choices: [{ delta: { tool_calls: [call(`r${n}`, 'big', { n })] } }] }]);
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  await runAgentTurn({
    config: { baseUrl: 'https://mock/v1', apiKey: 'k', model: 'm', contextWindow: 1000000 },
    messages: [{ role: 'user', content: 't' }],
    tools: { big: async ({ n: k }) => ({ k, content: 'x'.repeat(32000) }) }, // 每条约 8k token（不超 2 万字符内联上限的话会落盘，这里只看折叠）
    fetchImpl,
    systemPrompt: 'sys',
  });
  const last = bodies.at(-1).messages;
  assert.ok(!last.some((m) => m.role === 'tool' && /^\[索引\]/.test(String(m.content))), '不应有任何折叠');
});

test('以网关真实用量判断：本地估算很小，但网关报 99 万 prompt token → 触发压缩', async () => {
  const events = [];
  let n = 0;
  let summaries = 0;
  const fetchImpl = async () => {
    n++;
    const usage = { prompt_tokens: n === 1 ? 5000 : 990000, completion_tokens: 10 };
    if (n <= 12) return sse([{ choices: [{ delta: { tool_calls: [call(`u${n}`, 'noop', { n })] } }] }, { choices: [], usage }]);
    return sse([{ choices: [{ delta: { content: '完成' } }] }, { choices: [], usage }]);
  };
  await runAgentTurn({
    config: { baseUrl: 'https://mock/v1', apiKey: 'k', model: 'm', contextWindow: 1000000 },
    messages: [{ role: 'user', content: '任务' }],
    tools: { noop: async ({ n: k }) => ({ ok: k }) },
    fetchImpl,
    systemPrompt: 'sys',
    onEvent: (e) => events.push(e),
    summarize: async () => { summaries++; return '## 当前进度\nx'; },
  });
  assert.ok(events.some((e) => e.kind === 'compact-start'), '按真实用量触发了压缩（界面显示「正在压缩」）');
  assert.ok(summaries >= 1, '由模型写交接摘要');
});
