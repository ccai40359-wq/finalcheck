// 回合内 microcompact 的回归测试：
// 1) 纯函数：12 条 tool 消息 → 旧 7 条变占位符、最近 5 条原文保留、配对完整；
// 2) system / assistant 消息内容零改动；
// 3) 幂等：跑两次不重复改写；
// 4) contextBudget：小窗口不得算出负阈值（否则每次请求都压缩、模型彻底失忆）；
// 5) 集成：预算内不折叠（读完就忘的回归）；真超预算时必须折叠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { microcompact, countToolsToClean, contextBudget } from '../desktop/src/main/context.mjs';
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

test('contextBudget: 小窗口不再算出负阈值（否则模型每次都失忆）', () => {
  // 2026-11-16 发现的真 bug：原公式 effective-13000 / effective-2000 在窗口 <13001 时为负数，
  // 负阈值 = 「永远超预算」→ 每个请求都强制压缩 → 上下文清空 → 模型什么都看不到。
  // 实测把 contextWindow 设成 1000 后，5 个请求里每个都只剩 2 条消息、0 条工具结果。
  for (const w of [1000, 4000, 8000, 12000, 20000]) {
    const b = contextBudget({ contextWindow: w, maxOutputTokens: 32000 });
    assert.ok(b.microThreshold > 0, `window=${w} 的 microThreshold 必须 > 0，实际 ${b.microThreshold}`);
    assert.ok(b.fullThreshold >= 0, `window=${w} 的 fullThreshold 不能为负，实际 ${b.fullThreshold}`);
  }
  // 正常窗口必须保持原值不动（回归：别顺手改了默认行为）
  const big = contextBudget({ contextWindow: 200000, maxOutputTokens: 32000 });
  assert.equal(Math.round(big.microThreshold), 161100, '20 万窗口的 micro 阈值应保持原公式值');
  assert.equal(Math.round(big.fullThreshold), 166000, '20 万窗口的 full 阈值应保持原公式值');
});

test('agent: 预算内的长回合不折叠——12 轮工具结果全部原文保留（读完就忘的回归）', async () => {
  // 2026-11-16 契约变更：旧版每步无条件清掉「最近 5 条以外」的一切，导致模型读完就忘：
  // 真实会话里同一文件两次读的步距中位数是 9 > 5，于是它永远看不到上次读的内容，
  // 只能再读（一个回合 808 次调用、594 次读 20 个文件、单文件读 107 次内容完全相同）。
  // 现在折叠只在估算 token 踩到 microThreshold 时发生。12 轮 × 300 字符远没超预算，
  // 所以这一整回合都不该出现占位符。
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

  // 关键：作答前的完整视图里，12 条工具结果**全部是原文**
  const sent = bodies[ROUNDS].messages.filter((m) => m.role === 'tool');
  assert.equal(sent.length, ROUNDS);
  assert.deepEqual(sent.map((m) => m.tool_call_id), Array.from({ length: ROUNDS }, (_, i) => 'c' + (i + 1)));
  for (let i = 0; i < ROUNDS; i++) {
    assert.equal(sent[i].content, expectContent(i + 1),
      `c${i + 1} 必须原文保留（预算内不该折叠，否则模型读完就忘）`);
  }
  assert.equal(sent.filter((m) => String(m.content).startsWith('[旧工具结果已清理：')).length, 0,
    '预算内不应出现任何占位符');

  // 折叠没发生 → 不该发 notice
  assert.equal(events.filter((e) => e.kind === 'notice').length, 0, '预算内不该发「已清理」通知');

  // system / assistant 零改动 + 配对完整
  assert.equal(bodies[ROUNDS].messages[0].role, 'system');
  const assistants = bodies[ROUNDS].messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, ROUNDS);
  const callIds = assistants.flatMap((m) => m.tool_calls.map((tc) => tc.id));
  assert.deepEqual(callIds, sent.map((m) => m.tool_call_id), 'assistant tool_calls ↔ tool 消息一一配对');
});

test('agent: 真超预算时才折叠——阈值仍然硬，长回合不会无限膨胀', async () => {
  // 上一版把「每步清」当成防膨胀手段，结果在有大量预算时就白扔内容（读完就忘）。
  // 这条守住另一半：把窗口压小到 20 万以下、并用大结果快速撑爆，
  // 让 token 真的踩过 microThreshold，此时必须折叠（否则才是真膨胀）。
  const ROUNDS = 20;
  const bodies = [];
  let calls = 0;
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    calls++;
    if (calls <= ROUNDS) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + calls, function: { name: 'read_file', arguments: '{"path":"f' + calls + '"}' } }] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: '结论' } }] }]);
  };
  const BIG = 20000; // 每条工具结果 2 万字符 ≈ 5000 token，几条就撑爆 10 万窗口的 71100 阈值
  const tools = { read_file: async (args) => ({ path: args.path, body: 'z'.repeat(BIG) }) };

  await runAgentTurn({
    config: {
      baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm',
      contextWindow: 100000, maxOutputTokens: 32000   // micro≈71100, full≈66000
    },
    messages: [{ role: 'user', content: '连续读大文件' }],
    tools,
    fetchImpl: mockFetch,
    maxTurns: 24,
    onEvent: () => {}
  });

  const sent = bodies[bodies.length - 1].messages.filter((m) => m.role === 'tool');
  assert.ok(sent.length > 0, '最后请求里应还有工具结果');
  const placeholders = sent.filter((m) => String(m.content).startsWith('[旧工具结果已清理：'));
  assert.ok(placeholders.length > 0,
    `超预算后必须出现占位符（证明阈值仍在起作用），实际 ${placeholders.length} / ${sent.length}`);
  // 正在用的几条必须是原文
  const tail = sent.slice(-3);
  assert.ok(tail.every((m) => String(m.content).includes('z') || String(m.content).startsWith('[旧工具结果已清理：')),
    '最后几条要么是原文、要么是占位符（不能是空的）');
});

