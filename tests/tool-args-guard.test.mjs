// 「回合跑到一半突然中断」的真因回归（会话 ed8bc5d3：run_workflow 参数 4222 字符，
// 模型把 `{"id":"s6","summary","name":...}` 写成了键后缺冒号 → JSON.parse 抛错 → 旧逻辑把异常
// 直接当工具结果 → 卡片一条红条，用户读成「中断」）。
// 锁住四件事：
//  1. finish_reason=length 且带 tool_calls → 一个都不执行，整轮重发一次并明确要求「把参数拆小」；
//  2. 参数非法 JSON → 那一个调用不执行，错误（码 + 位置 + 前后各 80 字符，已脱敏）作为 tool 结果回给模型重发；
//  3. 两次都不合法 → 错误码 ARGS_INVALID_JSON / ARGS_TRUNCATED，且每个 tool part 都 start/end 成对闭合（不留 running）；
//  4. 合法 JSON 行为完全不变（照旧执行一次）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAgentTurn,
  inspectToolCallArgs,
  argsErrorExcerpt,
  redactArgSecrets,
  buildArgsRepairNotice,
  ARGS_INVALID_JSON_CODE,
  ARGS_TRUNCATED_CODE
} from '../desktop/src/main/agent-service.mjs';
import { errorCodeLabel } from '../desktop/src/main/swarm.mjs';

const TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'run_workflow',
    description: '跑多 agent 工作流',
    parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] }
  }
};

const sse = (chunks) => new Response(
  chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

const callChunk = (id, name, args, finishReason = 'tool_calls') => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] }, finish_reason: finishReason }]
});
const textChunk = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] });

// 现场原文：第 3964 字符附近 `"summary", "name"` —— 键后缺冒号（不是截断，JSON 结构是闭合的）
const BAD_ARGS = '{"goal": "体检", "steps": [{"id": "s1", "name": "SQL 安全面"}, {"id": "s6", "summary", "name": "汇总", "depends_on": ["s1"]}]}';
const GOOD_ARGS = '{"goal": "体检", "steps": [{"id": "s1", "name": "SQL 安全面"}]}';

function baseArgs(fetchImpl, extra = {}) {
  return {
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [{ role: 'user', content: '帮我做一次 L3 验收' }],
    systemPrompt: '你是主代理。',
    toolsSchema: [TOOL_SCHEMA],
    fetchImpl,
    retryBaseMs: 1,
    ...extra
  };
}

/** 用 lifecycle 事件复现 DB 里的 part 状态：start=running，end=ok/fail */
function makeLifecycleProbe() {
  const parts = new Map();
  const events = [];
  const onToolLifecycle = (ev) => {
    events.push(ev);
    if (ev.phase === 'start') parts.set(ev.id || `anon-${events.length}`, { status: 'running', name: ev.name });
    else parts.set(ev.id || `anon-${events.length}`, { status: ev.status, name: ev.name, error: ev.error, code: ev.code });
  };
  return { events, parts, onToolLifecycle };
}

test('tool-args: finish_reason=length 的 tool_calls 不执行，且只 nudge 一次（要求拆小参数）', async () => {
  const bodies = [];
  let executed = 0;
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sse([callChunk('call_big', 'run_workflow', '{"goal":"体检","steps":[{"id":"s1","name":"SQL', 'length')]);
    return sse([textChunk('好的，我把参数拆小：先只跑 SQL 面。')]);
  };
  const probe = makeLifecycleProbe();
  const out = await runAgentTurn(baseArgs(fetchImpl, {
    tools: { run_workflow: async () => { executed += 1; return { ok: true }; } },
    onToolLifecycle: probe.onToolLifecycle
  }));

  assert.equal(executed, 0, '截断的参数绝不能执行');
  assert.equal(bodies.length, 2, `应是 截断轮 + 重发轮，实际 ${bodies.length} 次请求`);
  const nudge = bodies[1].messages.filter((m) => m.role === 'user').at(-1);
  assert.match(String(nudge.content), /截断/, '重发请求必须说明上一轮被截断');
  assert.match(String(nudge.content), /拆小|缩短/, '重发请求必须要求把参数拆小');
  assert.match(String(nudge.content), new RegExp(ARGS_TRUNCATED_CODE));
  assert.equal(bodies[1].messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)), false,
    '半截 tool_calls 不能进 convo（否则重发请求会带着悬空 tool_call_id）');
  assert.equal(probe.parts.size, 0, '未执行的调用不该产生 part（也就不会停在 running）');
  assert.equal(out.error, undefined, String(out.error));
  assert.match(out.answer, /拆小/);
  assert.equal(out.roundsUsed, 2);
});

test('tool-args: 非法 JSON 不执行该调用，把位置+片段回给模型后只重发这一个（第二次合法则继续）', async () => {
  const bodies = [];
  const executed = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sse([callChunk('call_bad', 'run_workflow', BAD_ARGS)]);
    if (bodies.length === 2) return sse([callChunk('call_fixed', 'run_workflow', GOOD_ARGS)]);
    return sse([textChunk('已按修正后的参数跑完工作流。')]);
  };
  const probe = makeLifecycleProbe();
  const out = await runAgentTurn(baseArgs(fetchImpl, {
    tools: { run_workflow: async (args) => { executed.push(args); return { ok: true, steps: args.steps?.length || 0 }; } },
    onToolLifecycle: probe.onToolLifecycle
  }));

  assert.equal(executed.length, 1, '非法参数不执行，修正后的参数执行一次');
  assert.equal(executed[0].steps.length, 1);
  assert.equal(bodies.length, 3);
  // 第一次请求之后：必须有一条 tool 消息覆盖 call_bad，且带原因码/位置/片段/重发要求
  const toolMsg = bodies[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_bad');
  assert.ok(toolMsg, '每个 tool_call_id 都必须有 tool 响应，否则下一轮请求会被网关拒绝');
  const payload = JSON.parse(toolMsg.content);
  assert.equal(payload.code, ARGS_INVALID_JSON_CODE);
  assert.equal(typeof payload.position, 'number');
  assert.match(String(payload.hint), /只重新发起这一个工具调用/);
  assert.match(String(payload.hint), /⟪错误位置⟫/);
  assert.equal(probe.parts.get('call_bad').status, 'fail', '被拦下的调用要以 fail 收尾，不能停在 running');
  assert.equal(probe.parts.get('call_bad').code, ARGS_INVALID_JSON_CODE);
  assert.equal(probe.parts.get('call_fixed').status, 'ok');
  assert.equal(out.error, undefined, String(out.error));
  assert.match(out.answer, /修正后的参数/);
  assert.ok(out.warnings.some((w) => String(w).includes(ARGS_INVALID_JSON_CODE)), '要留一条可供排障的 warning');
});

test('tool-args: 连续两次非法 JSON → 错误码 ARGS_INVALID_JSON，part 全部闭合不留 running', async () => {
  const bodies = [];
  let executed = 0;
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return sse([callChunk(`call_bad_${bodies.length}`, 'run_workflow', BAD_ARGS)]);
  };
  const probe = makeLifecycleProbe();
  const out = await runAgentTurn(baseArgs(fetchImpl, {
    tools: { run_workflow: async () => { executed += 1; return { ok: true }; } },
    onToolLifecycle: probe.onToolLifecycle
  }));

  assert.equal(executed, 0);
  assert.equal(bodies.length, 2, '只纠错一次，不无限重试');
  assert.equal(out.errorCode, ARGS_INVALID_JSON_CODE, JSON.stringify(out));
  assert.match(String(out.error), /ARGS_INVALID_JSON/);
  assert.equal(out.trace.length, 2, '两次未执行的调用都要进 trace（卡片可点开看原因）');
  assert.equal(probe.parts.get('call_bad_1').status, 'fail');
  assert.equal(probe.parts.get('call_bad_2').status, 'fail');
  for (const [, p] of probe.parts) assert.notEqual(p.status, 'running', '不能留悬空 running part');
  assert.equal(errorCodeLabel(ARGS_INVALID_JSON_CODE), '工具参数不是合法 JSON');
});

test('tool-args: 连续两次被截断 → 错误码 ARGS_TRUNCATED，未执行的调用也要 start/end 成对', async () => {
  const bodies = [];
  let executed = 0;
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return sse([callChunk(`call_trunc_${bodies.length}`, 'run_workflow', '{"goal":"体检","steps":[{"id":"s1","na', 'length')]);
  };
  const probe = makeLifecycleProbe();
  const out = await runAgentTurn(baseArgs(fetchImpl, {
    tools: { run_workflow: async () => { executed += 1; return { ok: true }; } },
    onToolLifecycle: probe.onToolLifecycle
  }));

  assert.equal(executed, 0);
  assert.equal(bodies.length, 2);
  assert.equal(out.errorCode, ARGS_TRUNCATED_CODE, JSON.stringify(out));
  // 第一轮是自动重发（不进 trace）；第二轮仍截断才落一条 fail part
  assert.equal(out.trace.length, 1);
  assert.equal(probe.parts.get('call_trunc_2').status, 'fail');
  for (const [, p] of probe.parts) assert.notEqual(p.status, 'running');
  assert.equal(errorCodeLabel(ARGS_TRUNCATED_CODE), '工具参数被输出上限截断');
});

test('tool-args: 合法 JSON 行为不变（直接执行一次，不产生 warning）', async () => {
  const bodies = [];
  const executed = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sse([callChunk('call_ok', 'run_workflow', GOOD_ARGS)]);
    return sse([textChunk('工作流已完成。')]);
  };
  const probe = makeLifecycleProbe();
  const out = await runAgentTurn(baseArgs(fetchImpl, {
    tools: { run_workflow: async (args) => { executed.push(args); return { ok: true }; } },
    onToolLifecycle: probe.onToolLifecycle
  }));

  assert.equal(executed.length, 1);
  assert.equal(bodies.length, 2);
  assert.equal(out.trace.length, 1);
  assert.equal(out.trace[0].tool, 'run_workflow');
  assert.equal(probe.parts.get('call_ok').status, 'ok');
  assert.equal((out.warnings || []).some((w) => /ARGS_/.test(String(w))), false);
});

test('tool-args: 检查器与片段工具（位置/脱敏/纠错文案）', () => {
  const { invalid } = inspectToolCallArgs([
    { id: 'a', function: { name: 'run_command', arguments: '{"command":"ls"}' } },
    { id: 'b', function: { name: 'run_workflow', arguments: BAD_ARGS } }
  ]);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].id, 'b');
  assert.equal(invalid[0].index, 1);
  assert.ok(invalid[0].position > 0);

  const excerpt = argsErrorExcerpt(BAD_ARGS, invalid[0].position);
  assert.match(excerpt, /⟪错误位置⟫/);
  assert.ok(excerpt.length <= 400, '片段不能把整段参数回灌');

  const leaked = argsErrorExcerpt('{"apiKey": "sk-abcdefghijklmnop", "x": 1,', 10);
  assert.equal(leaked.includes('sk-abcdefghijklmnop'), false, '疑似密钥必须打码');
  assert.match(redactArgSecrets('Authorization: Bearer abcdefghijklmnop'), /\*\*\*/);

  const notice = buildArgsRepairNotice('run_workflow', { position: 3964, chars: 4222, excerpt: 'x' });
  assert.match(notice, /ARGS_INVALID_JSON/);
  assert.match(notice, /3964/);
  assert.match(notice, /只重新发起这一个工具调用/);
});
