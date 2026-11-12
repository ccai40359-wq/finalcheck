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
  toolArgsFailurePayload,
  repairToolArgsJson,
  looksLikeWindowsPathJson,
  getSystemPromptParts,
  TOOLS_SCHEMA,
  AGENT_TOOLS_SCHEMA,
  PATH_JSON_HINT,
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

const AUDIT_SCHEMA = {
  type: 'function',
  function: {
    name: 'audit_project',
    description: '对项目跑验收',
    parameters: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] }
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

/* ---------- Windows 路径单反斜杠：先自动修复，修不了才重发 ---------- */
const WINDOWS_BAD_ARGS = String.raw`{"dir":"D:\rcw-geo\yanshou"}`;
const WINDOWS_BROKEN_ARGS = String.raw`{"dir":"D:\rcw-geo\yanshou"`; // 缺右括号，修复不完整
const RELATIVE_BAD_ARGS = String.raw`{"dir":"src\app.js"}`;

test('tool-args: Windows 路径单反斜杠自动修复为正斜杠（合法路径 + 相对路径 + 尾逗号）', () => {
  const win = repairToolArgsJson(WINDOWS_BAD_ARGS);
  assert.equal(win.ok, true);
  assert.deepEqual(win.value, { dir: 'D:/rcw-geo/yanshou' });
  assert.deepEqual(win.repairs, ['Windows 路径反斜杠→正斜杠']);

  const rel = repairToolArgsJson(RELATIVE_BAD_ARGS);
  assert.equal(rel.ok, true);
  assert.deepEqual(rel.value, { dir: 'src/app.js' });
  assert.deepEqual(rel.repairs, ['Windows 路径反斜杠→正斜杠']);

  const comma = repairToolArgsJson('{"dir":"D:/rcw-geo/yanshou",}');
  assert.equal(comma.ok, true);
  assert.deepEqual(comma.value, { dir: 'D:/rcw-geo/yanshou' });
  assert.deepEqual(comma.repairs, ['移除尾逗号']);

  const both = repairToolArgsJson(String.raw`{"dir":"D:\rcw-geo\yanshou",}`);
  assert.equal(both.ok, true);
  assert.deepEqual(both.value, { dir: 'D:/rcw-geo/yanshou' });
  assert.deepEqual(both.repairs, ['Windows 路径反斜杠→正斜杠', '移除尾逗号']);
});

test('tool-args: 模型多吐一个尾括号时自动移除，不触发重发', () => {
  const extra = repairToolArgsJson('{"question":"x","multiSelect":true}}');
  assert.equal(extra.ok, true);
  assert.deepEqual(extra.value, { question: 'x', multiSelect: true });
  assert.deepEqual(extra.repairs, ['移除多余尾括号']);

  // 前缀不是合法 JSON（缺右括号）不能靠删尾括号蒙混过关
  assert.equal(repairToolArgsJson('{"question":"x"').ok, false);
});

test('tool-args: 正常 JSON 不修（双反斜杠合法路径、\\n 等合法转义原样保留）', () => {
  const valid = repairToolArgsJson('{"dir":"D:/rcw-geo/yanshou"}');
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value, { dir: 'D:/rcw-geo/yanshou' });
  assert.deepEqual(valid.repairs, []);

  const doubleSlash = repairToolArgsJson(String.raw`{"dir":"D:\\rcw-geo\\yanshou"}`);
  assert.equal(doubleSlash.ok, true);
  assert.deepEqual(doubleSlash.value, { dir: String.raw`D:\rcw-geo\yanshou` }, '合法双反斜杠保持原语义');
  assert.deepEqual(doubleSlash.repairs, [], '合法 JSON 不产生修复记录');

  const newline = repairToolArgsJson(String.raw`{"text":"line1\nline2"}`);
  assert.equal(newline.ok, true);
  assert.equal(newline.value.text, 'line1\nline2', '合法 \\n 不能被改写成正斜杠');
  assert.deepEqual(newline.repairs, []);

  const mixed = repairToolArgsJson(String.raw`{"dir":"D:\rcw-geo\yanshou","note":"a\nb"}`);
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.value, { dir: 'D:/rcw-geo/yanshou', note: 'a\nb' }, '只修路径字符串，不碰合法转义');
});

test('tool-args: 修不了（缺右括号/截断）保持 fail-closed，不以半截参数执行', () => {
  assert.equal(repairToolArgsJson(WINDOWS_BROKEN_ARGS).ok, false);
  assert.equal(repairToolArgsJson('{"dir":"D:/rcw-geo/yanshou"').ok, false);
  const { invalid } = inspectToolCallArgs([{ id: 'broken', function: { name: 'audit_project', arguments: WINDOWS_BROKEN_ARGS } }]);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].windowsPath, true);
});

test('tool-args: inspect 自动修复后改写 arguments 并移出 invalid（执行用修复值）', () => {
  const calls = [{ id: 'win', function: { name: 'audit_project', arguments: WINDOWS_BAD_ARGS } }];
  const inspected = inspectToolCallArgs(calls);
  assert.equal(inspected.invalid.length, 0);
  assert.equal(inspected.repaired.length, 1);
  assert.deepEqual(inspected.repaired[0].repairs, ['Windows 路径反斜杠→正斜杠']);
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { dir: 'D:/rcw-geo/yanshou' });
});

test('tool-args: Windows 路径错误 payload 带 PATH_JSON_HINT（无法修复时）', () => {
  const { invalid } = inspectToolCallArgs([{ id: 'win', function: { name: 'audit_project', arguments: WINDOWS_BROKEN_ARGS } }]);
  const payload = toolArgsFailurePayload(invalid[0]);
  assert.equal(payload.hint, PATH_JSON_HINT);
  assert.match(payload.hint, /正斜杠/);
  assert.match(payload.hint, /双反斜杠/);
  assert.equal(payload.code, ARGS_INVALID_JSON_CODE);

  const byMessage = toolArgsFailurePayload({ message: 'Bad escaped character in JSON at position 19', position: 19, chars: 30, excerpt: '' });
  assert.equal(byMessage.hint, PATH_JSON_HINT, 'Bad escaped character 也要给路径提示');
  assert.equal(looksLikeWindowsPathJson('Unexpected token } in JSON at position 5', '{"a":1}'), false, '非路径错误不加噪声');
  const noHint = toolArgsFailurePayload({ message: 'Unexpected token } in JSON at position 5', position: 5, chars: 8, excerpt: '' });
  assert.equal(noHint.hint, undefined);
});

test('tool-args: schema 里所有路径参数都带 PATH_JSON_HINT', () => {
  const byName = new Map(AGENT_TOOLS_SCHEMA.map((tool) => [tool.function.name, tool.function.parameters?.properties || {}]));
  const cases = [
    ['audit_project', 'dir'], ['quality_gate', 'dir'], ['download_gate', 'dir'], ['get_report', 'dir'],
    ['review_diff', 'dir'], ['read_file', 'path'], ['edit_file', 'path'], ['write_file', 'path'],
    ['present_artifact', 'path'], ['run_command', 'cwd']
  ];
  for (const [tool, prop] of cases) {
    const desc = String(byName.get(tool)?.[prop]?.description || '');
    assert.ok(desc.includes(PATH_JSON_HINT), `${tool}.${prop} 缺 JSON 路径转义提示：${desc}`);
  }
  // MCP 通道共用 TOOLS_SCHEMA（review_diff 除外），核心三件套必须都在
  for (const name of ['audit_project', 'download_gate', 'get_report']) {
    const tool = TOOLS_SCHEMA.find((x) => x.function.name === name);
    assert.ok(String(tool?.function?.parameters?.properties?.dir?.description || '').includes(PATH_JSON_HINT));
  }
});

test('tool-args: SYSTEM_BASE 硬规则要求 Windows 路径正斜杠优先/反斜杠双写', async () => {
  const { base } = await getSystemPromptParts();
  assert.match(base, /JSON 参数里的 Windows 路径/);
  assert.match(base, /双写/);
  assert.ok(base.includes('工具不会执行'));
});

test('tool-args: 单反斜杠路径自动修复后直接执行（不重发，fake tool 收到正斜杠）', async () => {
  const bodies = [];
  const executed = [];
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sse([callChunk('call_win', 'audit_project', WINDOWS_BAD_ARGS)]);
    return sse([textChunk('体检完成。')]);
  };
  const out = await runAgentTurn(baseArgs(fetchImpl, {
    toolsSchema: [AUDIT_SCHEMA],
    tools: { audit_project: async (args) => { executed.push(args); return { ok: true }; } }
  }));

  assert.equal(executed.length, 1, '修复成功就应执行一次');
  assert.deepEqual(executed[0], { dir: 'D:/rcw-geo/yanshou' });
  assert.equal(bodies.length, 2, '不应让模型重发');
  const assistant = bodies[1].messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { dir: 'D:/rcw-geo/yanshou' },
    '回填给网关的 assistant 参数也必须是修复后的');
  assert.equal(out.trace[0].args, '{"dir":"D:/rcw-geo/yanshou"}');
  assert.deepEqual(out.trace[0].repaired, ['Windows 路径反斜杠→正斜杠']);
  assert.ok(out.warnings.some((w) => /已自动修复工具参数/.test(String(w))));
  assert.equal(out.error, undefined, String(out.error));
});

test('tool-args: 修复不了（缺右括号）不执行，走原来的重发路径', async () => {
  const bodies = [];
  let executed = 0;
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return sse([callChunk('call_broken', 'audit_project', WINDOWS_BROKEN_ARGS)]);
    return sse([textChunk('参数还不完整，我先补全。')]);
  };
  const out = await runAgentTurn(baseArgs(fetchImpl, {
    toolsSchema: [AUDIT_SCHEMA],
    tools: { audit_project: async () => { executed += 1; return { ok: true }; } }
  }));

  assert.equal(executed, 0, '半截参数绝不能执行');
  assert.equal(bodies.length, 2);
  const toolMsg = bodies[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_broken');
  assert.ok(toolMsg);
  const payload = JSON.parse(toolMsg.content);
  assert.equal(payload.code, ARGS_INVALID_JSON_CODE);
  assert.match(String(payload.hint), /只重新发起这一个工具调用/);
  assert.match(String(payload.hint), /正斜杠/);
  assert.equal(out.error, undefined, String(out.error));
});

test('tool-args: 连续两次非法 Windows 路径 → 终局文案含常见原因，错误码不变', async () => {
  const bodies = [];
  let executed = 0;
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return sse([callChunk(`call_win_bad_${bodies.length}`, 'audit_project', WINDOWS_BROKEN_ARGS)]);
  };
  const probe = makeLifecycleProbe();
  const out = await runAgentTurn(baseArgs(fetchImpl, {
    toolsSchema: [AUDIT_SCHEMA],
    tools: { audit_project: async () => { executed += 1; return { ok: true }; } },
    onToolLifecycle: probe.onToolLifecycle
  }));

  assert.equal(executed, 0);
  assert.equal(bodies.length, 2, '只纠错一次，不无限重试');
  assert.equal(out.errorCode, ARGS_INVALID_JSON_CODE);
  assert.match(String(out.error), /常见原因：Windows 路径写成单反斜杠/);
  assert.match(String(out.error), /D:\/\.\.\./);
  const lastTool = bodies[1].messages.filter((m) => m.role === 'tool').at(-1);
  const payload = JSON.parse(lastTool.content);
  assert.match(String(payload.hint), /Windows 路径请用正斜杠/);
  for (const p of probe.parts.values()) assert.notEqual(p.status, 'running', '不能留悬空 running part');
});
