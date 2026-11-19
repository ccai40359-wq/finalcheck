// 上下文预算压缩（context.mjs）+ 项目档案记忆（memory.mjs）测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleContext, estimateTokens, estimateMessagesTokens, microcompact, fullCompact, contextBudget } from '../desktop/src/main/context.mjs';
import { recordAudit, projectContext, extractPaths } from '../desktop/src/main/memory.mjs';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';

// ---------- context.mjs ----------

test('context: 预算内原样返回（不触发压缩、不调 summarize）', async () => {
  const messages = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，需要体检哪个项目？' }
  ];
  let called = 0;
  const out = await assembleContext(messages, { budgetChars: 80000, summarize: async () => { called++; return 'X'; } });
  assert.equal(out.compacted, false);
  assert.equal(out.messages, messages); // 原样：同一引用
  assert.equal(called, 0);
});

test('context: 超预算触发 LLM 摘要——replace 语义、尾部 4 条原文保留、不改输入', async () => {
  const mk = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: `消息${i}-` + 'x'.repeat(196) });
  const messages = [0, 1, 2, 3, 4, 5].map(mk); // 总 1200 字符
  const snapshot = JSON.stringify(messages);
  const argsSeen = [];
  const out = await assembleContext(messages, {
    budgetChars: 700,
    summarize: async (text) => { argsSeen.push(text); return 'SUM文本'; }
  });
  assert.equal(out.compacted, true);
  // 2026-11-17 步 9：末尾多一条【当前任务】system（规格 §3.3 硬规则：任务包置底）
  assert.equal(out.messages.length, 6, '摘要 1 + 保留 4 + 任务包 1');
  assert.deepEqual(out.messages[0], { role: 'user', content: '[历史摘要]\nSUM文本' });
  assert.deepEqual(out.messages.slice(1, -1), messages.slice(2), '尾部 4 条原文保留（去掉末尾任务包）');
  const pack = out.messages[out.messages.length - 1];
  assert.equal(pack.role, 'system', '任务包必须是 system');
  assert.match(pack.content, /当前任务/);
  assert.match(pack.content, /消息4-/, '任务包引用最后一条 user 原文');
  assert.equal(argsSeen.length, 1); // 只总结被压缩区
  assert.ok(argsSeen[0].includes('消息0-'));
  assert.ok(argsSeen[0].includes('消息1-'));
  assert.ok(!argsSeen[0].includes('消息5-')); // 保留区内容不进摘要
  assert.equal(JSON.stringify(messages), snapshot); // 输入历史未被改动（审计可回放）
});

test('context: summarize 抛错走抽取式（user 前 60 字 + 工具调用名）', async () => {
  const question = 'Q'.repeat(200);
  const messages = [
    { role: 'user', content: question },
    { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'audit_project', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r'.repeat(3000) },
    { role: 'user', content: '第二条' },
    { role: 'assistant', content: '回答' },
    { role: 'user', content: '最新问题' }
  ];
  const out = await assembleContext(messages, { budgetChars: 500, summarize: async () => { throw new Error('网关挂了'); } });
  assert.equal(out.compacted, true);
  const head = out.messages[0];
  assert.equal(head.role, 'user');
  assert.ok(head.content.startsWith('[历史摘要]\n'));
  assert.ok(head.content.includes('- 用户：' + 'Q'.repeat(60))); // 前 60 字
  assert.ok(!head.content.includes('Q'.repeat(70))); // 不超 60 字
  // 2026-11-19：保留区不能以 tool 结果开头——audit_project 的调用和结果一起留在保留区（不再被压进摘要后留下悬空结果）
  const keptCall = out.messages.findIndex((m) => (m.tool_calls || []).some((c) => c.id === 'c1'));
  assert.ok(keptCall > 0 && out.messages[keptCall + 1]?.tool_call_id === 'c1');
});

test('context: 保留区 role=tool 长消息截为头 1200 字 + 截断标注，短 tool 原样', async () => {
  const messages = [
    { role: 'user', content: 'U'.repeat(3000) },
    { role: 'user', content: 'V'.repeat(3000) },
    { role: 'tool', tool_call_id: 't1', content: 'S'.repeat(100) },
    { role: 'assistant', content: 'A'.repeat(50) },
    { role: 'tool', tool_call_id: 't2', content: 'T'.repeat(2000) },
    { role: 'user', content: '最新问题' }
  ];
  const out = await assembleContext(messages, { budgetChars: 600, summarize: async () => 'SUM' });
  assert.equal(out.compacted, true);
  const long = out.messages.find((m) => m.role === 'tool' && m.tool_call_id === 't2');
  assert.equal(long.content, 'T'.repeat(1200) + '…[截断 800 字符]');
  const short = out.messages.find((m) => m.role === 'tool' && m.tool_call_id === 't1');
  assert.equal(short.content, 'S'.repeat(100)); // ≤1500 不截
  // 2026-11-17 步 9：末尾是【当前任务】system 包，原文在倒数第二条
  assert.equal(out.messages[out.messages.length - 1].role, 'system');
  assert.match(out.messages[out.messages.length - 1].content, /最新问题/, '任务包引用最后一条 user');
  assert.equal(out.messages[out.messages.length - 2].content, '最新问题');
});

test('context: 不足 4 条也超预算——无压缩区，仅做保留区 tool 截断', async () => {
  const messages = [
    { role: 'user', content: 'help' },
    { role: 'tool', tool_call_id: 't9', content: 'Z'.repeat(2000) },
    { role: 'assistant', content: 'done' }
  ];
  const out = await assembleContext(messages, { budgetChars: 100 });
  assert.equal(out.compacted, true);
  // 2026-11-17 步 9：3 条原文 + 1 条任务包
  assert.equal(out.messages.length, 4);
  assert.equal(out.messages[0], messages[0]);
  assert.equal(out.messages[1].content, 'Z'.repeat(1200) + '…[截断 800 字符]');
  assert.equal(out.messages[2], messages[2]);
  assert.equal(out.messages[3].role, 'system');
});

test('context: token 预算模式——超预算走摘要、保留最近 4 条原文', async () => {
  const mk = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}-` + 'x'.repeat(996) }); // 999 字符≈250 token
  const messages = [0, 1, 2, 3, 4, 5].map(mk);
  const snapshot = JSON.stringify(messages);
  let summarized = 0;
  const out = await assembleContext(messages, {
    budgetTokens: 600,
    summarize: async () => { summarized++; return 'TOKSUM'; }
  });
  assert.equal(out.compacted, true);
  assert.equal(summarized, 1);
  assert.deepEqual(out.messages[0], { role: 'user', content: '[历史摘要]\nTOKSUM' });
  assert.deepEqual(out.messages.slice(1, -1), messages.slice(2), '最近 4 条原文保留（去掉末尾任务包）');
  assert.equal(out.messages[out.messages.length - 1].role, 'system', '末尾是任务包');
  assert.equal(JSON.stringify(messages), snapshot); // 不改输入
});

test('context: token 预算模式——预算内原样返回，budgetChars 被忽略', async () => {
  const messages = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '需要体检哪个项目？' }
  ];
  let called = 0;
  const out = await assembleContext(messages, {
    budgetTokens: 100000,
    budgetChars: 1,
    summarize: async () => { called++; return 'X'; }
  });
  assert.equal(out.compacted, false);
  assert.equal(out.messages, messages);
  assert.equal(called, 0);
});

test('context: token 预算模式——summarize 失败退抽取式，保留区 tool 保持原文（0.25 对齐 Claude Code）', async () => {
  const messages = [
    { role: 'user', content: 'Q'.repeat(100) },
    { role: 'assistant', content: 'A'.repeat(100) },
    { role: 'tool', tool_call_id: 't1', content: 'T'.repeat(2000) },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' }
  ];
  const out = await assembleContext(messages, {
    budgetTokens: 200,
    summarize: async () => { throw new Error('网关挂了'); }
  });
  assert.equal(out.compacted, true);
  assert.equal(out.messages.length, 7); // 摘要 + 5 条保留（tool 前面那条 assistant 一起保留，2026-11-19）+ 任务包
  assert.ok(out.messages[0].content.startsWith('[历史摘要]\n'));
  assert.ok(out.messages[0].content.includes('- 用户：' + 'Q'.repeat(60)));
  const tool = out.messages.find((m) => m.role === 'tool' && m.tool_call_id === 't1');
  assert.equal(tool.content, 'T'.repeat(2000));
});

test('context: runAgentTurn 集成——发给网关的是压缩视图，存储历史不受影响', async () => {
  const bodies = [];
  const mockFetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return sse([{ choices: [{ delta: { content: '收到' } }] }]);
  };
  const messages = [
    { role: 'user', content: 'A'.repeat(85000) },
    { role: 'user', content: 'B'.repeat(85000) },
    { role: 'assistant', content: 's1' },
    { role: 'user', content: 's2' },
    { role: 'assistant', content: 's3' }
  ];
  const before = JSON.stringify(messages);
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages,
    summarize: async () => '压缩摘要OK',
    fetchImpl: mockFetch
  });
  assert.equal(out.answer, '收到');
  const sent = bodies[0].messages;
  assert.equal(sent[0].role, 'system');
  assert.deepEqual(sent[1], { role: 'user', content: '[历史摘要]\n压缩摘要OK' });
  assert.equal(sent[2].content, 'B'.repeat(85000)); // 尾部 4 条原样进请求
  // 2026-11-17 步 9：system(1) + 摘要(1) + 保留 4 条 + 任务包(1) = 7
  assert.equal(sent.length, 7);
  assert.equal(sent[sent.length - 1].role, 'system', '末尾是【当前任务】包');
  assert.equal(JSON.stringify(messages), before); // 传入的历史数组不变
});

// ---------- memory.mjs ----------

// 每个用例独立临时目录，互不污染（memory.mjs 每次调用都读环境变量）
function newMemDir(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'fc-mem-'));
  process.env.FINALCHECK_MEMORY_DIR = d;
  t.after(() => { delete process.env.FINALCHECK_MEMORY_DIR; rmSync(d, { recursive: true, force: true }); });
  return d;
}
const AUDIT = { tier: { effective: 'L2' }, verdict: '过', findings: [
  { severity: 'high' }, { severity: 'high' }, { severity: 'medium' }, { severity: 'low' }, { severity: 'low' }, { severity: 'low' }
] };

test('memory: 录取后精确命中，projects.json 形状正确', async (t) => {
  const dir = newMemDir(t);
  const proj = path.join(tmpdir(), 'fc-demo-proj');
  const entry = await recordAudit(proj, AUDIT);
  assert.equal(entry.tier, 'L2');
  assert.equal(entry.verdict, '过');
  assert.equal(entry.high, 2);
  assert.equal(entry.medium, 1);
  assert.equal(entry.low, 3);
  assert.equal(typeof entry.at, 'number');
  const line = await projectContext(proj);
  assert.ok(line, '应命中');
  assert.ok(line.includes('fc-demo-proj'));
  assert.ok(line.includes('L2'));
  assert.ok(line.includes('过'));
  assert.ok(line.includes('高危 2'));
  const stored = JSON.parse(readFileSync(path.join(dir, 'projects.json'), 'utf8'));
  const rec = stored[proj.toLowerCase().replace(/\\/g, '/')];
  assert.equal(rec.path, proj);
  assert.equal(rec.name, 'fc-demo-proj');
  assert.equal(rec.audits.length, 1);
  assert.equal(rec.lastAt, rec.audits[0].at);
  assert.equal(rec.audits[0].verdict, '过');
});

test('memory: 子路径命中 + 无档案返回 null', async (t) => {
  newMemDir(t);
  const proj = path.join(tmpdir(), 'fc-sub-proj');
  await recordAudit(proj, AUDIT);
  const child = await projectContext(path.join(proj, 'src', 'main'));
  assert.ok(child, '子路径应命中');
  assert.ok(child.includes('fc-sub-proj'));
  const stranger = path.join(tmpdir(), 'fc-unrelated');
  assert.equal(await projectContext(stranger), null);
});

test('memory: 损坏 JSON 不崩——读档得 null，重录后恢复可用', async (t) => {
  const dir = newMemDir(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'projects.json'), 'not-json{{{', 'utf8');
  const proj = path.join(tmpdir(), 'fc-corrupt-proj');
  assert.equal(await projectContext(proj), null); // 损坏也不抛
  await recordAudit(proj, AUDIT); // 空档案起步重录
  assert.ok(await projectContext(proj), '重录后命中');
  assert.ok(existsSync(path.join(dir, 'projects.json')));
});

test('memory: 大小写/斜杠规范化命中（Windows 路径差异）', async (t) => {
  newMemDir(t);
  await recordAudit('D:\\Foo\\Bar', { verdict: '拦', findings: [{ severity: 'high' }] });
  assert.ok(await projectContext('d:/foo/bar'), '小写正斜杠应命中');
  assert.ok(await projectContext('D:/Foo/Bar/src'), '子路径应命中');
  assert.equal(await projectContext('d:/foo/baz'), null);
});

test('memory: extractPaths 提取用户消息中的路径', () => {
  const got = extractPaths('帮我体检 D:\\work\\myapp 和 /home/u/proj，谢谢');
  assert.ok(got.some((p) => /^D:[\\/]work[\\/]myapp$/i.test(p)), JSON.stringify(got));
  assert.ok(got.includes('/home/u/proj'));
  assert.equal(extractPaths('没有路径的一句话').length, 0);
});

// ---------- 共用 SSE 假网关（与 agent-service.test.mjs 同款） ----------
function sse(chunks) {
  const body = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

// ---------- Wave 2：token 估算与两级压缩 ----------

test('context: estimateTokens——CJK 1 字符≈1 token，其他 4 字符≈1 token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('中文测试'), 4);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('abcde'), 2); // 不足 4 字符也进 1 token
  // 同样信息量：400 个英文字符 ≈ 100 token，100 个汉字 ≈ 100 token
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.equal(estimateTokens('中'.repeat(100)), 100);
  // 混排：100 汉字 + 100 英文字符 = 100 + 25
  assert.equal(estimateTokens('中a'.repeat(100)), 125);
  // tool_calls 的 JSON 长度也计入消息 token
  const calls = [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"D:/x"}' } }];
  assert.equal(estimateMessagesTokens([{ role: 'assistant', content: null, tool_calls: calls }]), estimateTokens(JSON.stringify(calls)));
});

test('context: contextBudget 公式——单阈值（2026-11-17 步 2 重构）', () => {
  // 旧版是 effective/fullThreshold/microThreshold 三个值、两档压缩；
  // 新口径只有一个 compactThreshold = effective（窗口减输出预留）。
  // 兼容字段 micro/full 仍存在但同值，语义是「到线就压」，不再分两级。
  const b = contextBudget({ contextWindow: 200000, maxOutputTokens: 32000 });
  assert.equal(b.effective, 200000 - 21000);
  assert.equal(b.compactThreshold, b.effective, '唯一阈值 = effective');
  assert.equal(b.microThreshold, b.compactThreshold, '兼容字段与主阈值同值');
  assert.equal(b.fullThreshold, b.compactThreshold);
  const d = contextBudget({});
  assert.equal(d.contextWindow, 200000);
  assert.equal(d.maxOutputTokens, 32000);
  assert.equal(d.compactThreshold, 179000);
});

test('context: microcompact——最近 5 条工具结果保留原文，旧的换占位且配对不破', () => {
  const convo = [{ role: 'system', content: 's' }];
  const originals = [];
  for (let i = 0; i < 8; i++) {
    convo.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    const text = `result-${i}-` + 'x'.repeat(5000);
    originals.push(text);
    convo.push({ role: 'tool', tool_call_id: 'c' + i, content: text });
  }
  assert.equal(microcompact(convo), true);
  const tools = convo.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 8);
  // 最近 5 条（下标 3..7）保持原文
  assert.deepEqual(tools.slice(-5).map((m) => m.content), originals.slice(-5));
  // 2026-11-17 步 3：旧的 3 条被压成**索引行**（不再是零信息量占位符）。
  // 索引行必须保留「工具名 + 目标 + 结果大小」，让模型仍然知道读过什么。
  for (let i = 0; i < 3; i++) {
    assert.equal(tools[i].tool_call_id, 'c' + i, 'tool_call_id 必须保留（配对不能破）');
    assert.match(tools[i].content, /^\[索引\] \S+ read_file/, '索引行必须点名工具');
    assert.match(tools[i].content, /~\d+ tok/, '索引行必须带结果大小');
    assert.doesNotMatch(tools[i].content, /旧工具结果已清理/, '不能再是旧占位符');
  }
  // assistant tool_calls 全部还在（配对没破）
  const callIds = convo.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls.map((tc) => tc.id));
  assert.deepEqual(callIds, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
});

test('context: fullCompact——生成 [历史摘要]、保留最近 6 条、正文丢失但工具对完整', () => {
  const user1 = '第一轮问题：' + 'Q'.repeat(100);
  const conclusion = '第一轮结论：' + 'C'.repeat(100);
  const convo = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: user1 },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'tool-result-1' },
    { role: 'assistant', content: conclusion },
    { role: 'user', content: '第二轮问题' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'audit_project', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'tool-result-2' },
    { role: 'user', content: '第三轮问题' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'probe_target', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c3', content: 'tool-result-3' },
    { role: 'assistant', content: '最终结论' }
  ];
  assert.equal(fullCompact(convo), true);
  // system + 摘要 + 最近 6 条
  assert.equal(convo.length, 8);
  assert.equal(convo[0].role, 'system');
  assert.equal(convo[1].role, 'user');
  assert.ok(convo[1].content.startsWith('[历史摘要]\n'));
  assert.ok(convo[1].content.includes('- 用户：' + user1.slice(0, 60)));
  assert.ok(convo[1].content.includes('- 助手调用工具：read_file'));
  assert.ok(convo[1].content.includes('- 结论：' + conclusion.slice(0, 80)));
  // 保留区第一条不是 tool
  assert.notEqual(convo[2].role, 'tool');
  // 老正文被摘要顶替（正文丢失）
  assert.ok(!convo.some((m) => m.role === 'user' && m.content === user1));
  assert.ok(!convo.some((m) => m.role === 'assistant' && m.content === conclusion));
  assertNoOrphanTool(convo);
});

test('context: fullCompact——保留区以 tool 开头时连同 assistant tool_calls 回退保留，不产生孤立 tool', () => {
  const convo = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '较早的问题' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r1' }, // 原始边界正好落在这里
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'audit_project', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: 'r2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: '最终结论' }
  ];
  assert.equal(fullCompact(convo), true);
  // 回退保留 1 条 assistant → system + 摘要 + 7 条保留
  assert.equal(convo.length, 9);
  assert.equal(convo[2].role, 'assistant');
  assert.deepEqual(convo[2].tool_calls.map((tc) => tc.id), ['c1']);
  assertNoOrphanTool(convo);
});

// 断言：任何 tool 消息都能在其前面找到对应的 assistant tool_calls（API 不会因孤立 tool 返回 400）
function assertNoOrphanTool(list) {
  const declared = new Set();
  for (const m of list) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) declared.add(tc.id);
    } else if (m?.role === 'tool') {
      assert.ok(declared.has(m.tool_call_id), `孤立 tool 消息：${m.tool_call_id}`);
    }
  }
}

/* ---------- 保留预算精修（2026-11-14 用户拍板）：压缩后不贴线 ---------- */

test('context: 压缩后保留区 ≈ 阈值 37.5%——不再贴线反复触发', async () => {
  // 500k 字符历史，阈值 400k → 触发压缩；keep 预算 = 400k × 0.375 = 150k
  const messages = [];
  for (let i = 0; i < 250; i++) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i + '-' + 'x'.repeat(1990) });
  }
  const limit = 400000;
  const out = await assembleContext(messages, { budgetChars: limit, summarize: async () => 'SUM' });
  assert.equal(out.compacted, true);
  const kept = out.messages.filter((m) => !String(m.content || '').startsWith('[历史摘要]'));
  const keptChars = kept.reduce((n, m) => n + String(m.content || '').length, 0);
  assert.ok(keptChars <= 160000, `保留区 ${keptChars} 应 ≤ ~160k（0.375 × 阈值 + 余量）`);
  assert.ok(keptChars >= 140000, `保留区 ${keptChars} 应接近 150k（预算被用满）`);
  const totalAfter = out.messages.reduce((n, m) => n + String(m.content || '').length, 0);
  assert.ok(totalAfter < limit * 0.6, `压缩后总占用 ${totalAfter} 应明显低于阈值 ${limit}——不再贴线`);
});
