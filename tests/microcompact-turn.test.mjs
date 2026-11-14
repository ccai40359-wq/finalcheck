// 回合内 microcompact 接入主循环的回归测试：
// 1) 纯函数：12 条 tool 消息 → 旧 7 条变占位符、最近 5 条原文保留、assistant tool_calls ↔ tool 配对完整；
// 2) system / assistant 消息内容零改动；
// 3) 幂等：跑两次不重复改写；
// 4) 集成：runAgentTurn 主循环每步工具结果落地后立即折叠，notice 同一回合只发一次。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microcompact, countToolsToClean } from '../desktop/src/main/context.mjs';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';

const PLACEHOLDER = (name) => `[旧工具结果已清理：${name}；需要时用更小参数重跑或读 spill 文件]`;

// 构造一条 system + user + 12 轮 (assistant tool_calls + tool 结果) 的对话
function buildConvo() {
  const convo = [
    { role: 'system', content: '【系统】审计基准提示词' },
    { role: 'user', content: '请体检 D:/demo' }
  ];
  for (let i = 0; i < 12; i++) {
    const name = i % 2 ? 'audit_project' : 'read_file';
    convo.push({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c' + i, type: 'function', function: { name, arguments: '{"path":"D:/demo/f' + i + '"}' } }]
    });
    convo.push({ role: 'tool', tool_call_id: 'c' + i, content: `result-${i}-` + 'x'.repeat(2000) });
  }
  return convo;
}

test('microcompact: 12 条 tool 消息——旧 7 条变占位符、最近 5 条原文保留、配对完整', () => {
  const convo = buildConvo();
  const originals = convo.filter((m) => m.role === 'tool').map((m) => m.content);

  assert.equal(countToolsToClean(convo, { keepRecentTool: 5 }), 7, '折叠前应统计出 7 条待清理');
  assert.equal(microcompact(convo, { keepRecentTool: 5 }), true);

  const tools = convo.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 12, 'tool 消息条数不变（只换 content，不删消息）');
  // 最近 5 条（c7..c11）保持原文
  assert.deepEqual(tools.slice(-5).map((m) => m.content), originals.slice(-5), '最近 5 条必须原文保留');
  // 更早的 7 条换成占位符，且占位符里点名对应工具（按 tool_call_id 回查 assistant 的调用名）
  const callNames = new Map(
    convo.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls.map((tc) => [tc.id, tc.function.name]))
  );
  tools.slice(0, 7).forEach((m, k) => {
    assert.equal(m.content, PLACEHOLDER(callNames.get(m.tool_call_id)), `第 ${k} 条旧结果应为带工具名的占位符`);
  });
  // 配对完整：assistant tool_calls 与 tool 消息一一对应，无孤儿
  const callIds = convo.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls.map((tc) => tc.id));
  const toolIds = tools.map((m) => m.tool_call_id);
  assert.deepEqual(toolIds, callIds, 'tool 消息与 assistant tool_calls 顺序与数量一致');
  assert.equal(new Set(toolIds).size, callIds.length, '无重复/缺失的 tool_call_id');
  assert.equal(countToolsToClean(convo, { keepRecentTool: 5 }), 0, '折叠后没有待清理项');
});

test('microcompact: system / assistant 消息零改动', () => {
  const convo = buildConvo();
  const before = convo.filter((m) => m.role === 'system' || m.role === 'assistant').map((m) => JSON.stringify(m));
  microcompact(convo, { keepRecentTool: 5 });
  const after = convo.filter((m) => m.role === 'system' || m.role === 'assistant').map((m) => JSON.stringify(m));
  assert.deepEqual(after, before, 'system 与 assistant 消息（含 tool_calls 参数）必须逐字节不变');
});

test('microcompact: 幂等——跑两次不重复改写', () => {
  const convo = buildConvo();
  assert.equal(microcompact(convo, { keepRecentTool: 5 }), true, '第一次发生折叠');
  const snapshot = convo.map((m) => JSON.stringify(m));
  assert.equal(microcompact(convo, { keepRecentTool: 5 }), false, '第二次应识别占位符并跳过，返回 false');
  assert.deepEqual(convo.map((m) => JSON.stringify(m)), snapshot, '第二次不得再改动任何消息');
  // 占位符不嵌套（没有「已清理：[旧工具结果已清理…」这类二次包装）
  for (const m of convo) {
    if (m.role === 'tool' && String(m.content).startsWith('[旧工具结果已清理：')) {
      assert.equal(String(m.content).split('旧工具结果已清理').length - 1, 1);
    }
  }
});

// ---------- 集成：runAgentTurn 主循环每步折叠 ----------

function sse(chunks) {
  const body = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('agent: 回合内每步折叠——12 轮工具后请求里是占位符+最近 5 条原文，notice 只发一次', async () => {
  const ROUNDS = 12;
  const bodies = [];
  const events = [];
  let calls = 0;
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    calls++;
    if (calls <= ROUNDS) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + calls, function: { name: 'read_file', arguments: '{"path":"f' + calls + '"}' } }] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: '最终结论' } }] }]);
  };
  const tools = { read_file: async (args) => ({ path: args.path, body: 'r'.repeat(300) }) };
  const expectContent = (n) => JSON.stringify({ path: 'f' + n, body: 'r'.repeat(300) });

  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [{ role: 'user', content: '连续读 12 个文件' }],
    tools,
    fetchImpl: mockFetch,
    maxTurns: 15,
    onEvent: (e) => events.push(e)
  });

  assert.equal(out.answer, '最终结论');
  assert.equal(bodies.length, ROUNDS + 1, '12 轮工具 + 1 次作答');
  assert.ok(Array.isArray(bodies[ROUNDS].tools), '作答发生在主循环内，仍带工具表（非预算熔断的收尾请求）');

  // 折叠时机：第 6 条工具结果落地前请求里 5 条全原文；落地后下一次请求出现第一个占位符
  const toolsOf = (b) => b.messages.filter((m) => m.role === 'tool');
  assert.equal(toolsOf(bodies[5]).length, 5, '第 6 次请求时恰好 5 条 tool 结果');
  assert.deepEqual(toolsOf(bodies[5]).map((m) => m.content), [1, 2, 3, 4, 5].map(expectContent), '恰好 5 条（保留区内）时全部原文保留，不折叠');
  const first = toolsOf(bodies[6]);
  assert.equal(first.length, 6);
  assert.match(first[0].content, /^\[旧工具结果已清理：read_file；/, '第 6 条落地后，最旧的 c1 应在下一次请求前被折叠');

  // 第 13 次请求（作答前）的完整视图：12 条 tool = 前 7 条占位符 + 最近 5 条原文
  const sent = toolsOf(bodies[ROUNDS]);
  assert.equal(sent.length, ROUNDS);
  assert.deepEqual(sent.map((m) => m.tool_call_id), Array.from({ length: ROUNDS }, (_, i) => 'c' + (i + 1)));
  for (let i = 0; i < ROUNDS - 5; i++) {
    assert.equal(sent[i].content, PLACEHOLDER('read_file'), `c${i + 1} 应为占位符`);
  }
  for (let i = ROUNDS - 5; i < ROUNDS; i++) {
    assert.equal(sent[i].content, expectContent(i + 1), `c${i + 1} 应保持原文`);
  }

  // system / assistant 零改动 + 配对完整（作答请求视图）
  assert.equal(bodies[ROUNDS].messages[0].role, 'system');
  const assistants = bodies[ROUNDS].messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, ROUNDS);
  const callIds = assistants.flatMap((m) => m.tool_calls.map((tc) => tc.id));
  assert.deepEqual(callIds, sent.map((m) => m.tool_call_id), 'assistant tool_calls ↔ tool 消息一一配对');
  for (const a of assistants) {
    assert.equal(a.tool_calls.length, 1);
    assert.equal(a.tool_calls[0].function.name, 'read_file');
    assert.match(a.tool_calls[0].function.arguments, /^\{"path":"f\d+"\}$/, 'assistant 的调用参数不得被折叠改动');
  }

  // 可观测性：整个回合 notice 恰好一次（折叠实际发生了 7 次，只提示第一次）
  const notices = events.filter((e) => e.kind === 'notice');
  assert.equal(notices.length, 1, `应只发一次 notice，实际 ${notices.length}`);
  assert.match(notices[0].message, /上下文折叠：已清理 1 条旧工具结果（原文可重跑获取）/);

  // 幂等：占位符不嵌套（compactNow 每轮开头还会再跑一次 microcompact）
  for (const m of sent) {
    if (String(m.content).startsWith('[旧工具结果已清理：')) {
      assert.equal(String(m.content).split('旧工具结果已清理').length - 1, 1);
    }
  }
});
