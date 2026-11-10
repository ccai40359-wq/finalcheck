import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runAgentTurn, pruneConvo, classifyTool, normalizeProviderLimits,
  providerFamily, resolveWorkflowStepModel, computeCrossFamilyWarnings,
  runSessionStartHook, injectSessionHookContext
} from '../desktop/src/main/agent-service.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sse(chunks) {
  const body = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const toolCallsChunk = (...calls) => sse([{ choices: [{ delta: { tool_calls: calls } }] }]);
const cfg = (extra = {}) => ({ baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm', ...extra });

test('agent: 未配置网关直接给人话错误', async () => {
  const out = await runAgentTurn({ config: {}, messages: [], tools: {} });
  assert.match(out.error, /未配置网关/);
});

test('agent: tool-use 循环——先调工具再作答', async () => {
  const bodies = [];
  const mockFetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'audit_project', arguments: '{"dir":"D:/x","tier":"L2"}' } }] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: '体检完成：🟢 过' } }] }]);
  };
  const fakeTools = { audit_project: async (args) => ({ verdict: '过', args }) };
  const tokens = [];
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [{ role: 'user', content: '帮我体检 D:/x' }],
    tools: fakeTools,
    onToken: (t) => tokens.push(t),
    fetchImpl: mockFetch
  });
  assert.equal(out.answer, '体检完成：🟢 过');
  assert.equal(out.trace[0].tool, 'audit_project');
  assert.equal(out.trace[0].result.verdict, '过');
  assert.ok(tokens.join('').includes('体检完成'));
  // 第二次请求的 messages 里应有 tool 结果回填
  const second = bodies[1].messages;
  assert.equal(second.filter((m) => m.role === 'tool').length, 1);
  assert.match(second[second.length - 1].content, /verdict/);
});

test('agent: 网关 500 返回人话错误', async () => {
  const mockFetch = async () => new Response('boom', { status: 500 });
  const out = await runAgentTurn({ config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' }, messages: [], tools: {}, fetchImpl: mockFetch });
  assert.match(out.error, /HTTP 500/);
});

test('agent: 达到工具轮次上限时自动收尾，不丢已有证据', async () => {
  const bodies = [];
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length <= 2) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c' + bodies.length, function: { name: 'probe_target', arguments: '{}' } }] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: '当前结论：已试 2 轮，证据在时间线。' } }] }]);
  };
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [],
    tools: { probe_target: async () => ({ ok: 1 }) },
    fetchImpl: mockFetch,
    maxTurns: 2
  });
  assert.equal(out.answer, '当前结论：已试 2 轮，证据在时间线。');
  assert.equal(out.trace.length, 2);
  assert.equal(bodies[2].tools, undefined, '收尾请求不应再带工具');
  assert.match(bodies[2].messages.at(-1).content, /不要再调用任何工具/);
});

test('agent: 多轮上下文预算——老工具结果压缩，最近 4 条保留原文', () => {
  const convo = [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }];
  for (let i = 0; i < 8; i++) convo.push({ role: 'tool', tool_call_id: 'c' + i, content: 'y'.repeat(30000) });
  assert.equal(pruneConvo(convo), true);
  const tools = convo.filter((m) => m.role === 'tool');
  assert.ok(tools.slice(0, 4).every((m) => m.content.length < 2000), '老结果应被压缩');
  assert.ok(tools.slice(4).every((m) => m.content.length === 30000), '最近 4 条应保持原文');
  assert.equal(pruneConvo([{ role: 'tool', content: 'small' }]), false, '预算内不应改动');
});

test('agent: 思考字段兼容 reasoning / reasoning_content / thinking', async () => {
  const events = [];
  const mockFetch = async () => sse([
    { choices: [{ delta: { reasoning: '先看目标。' } }] },
    { choices: [{ delta: { reasoning_content: '再读手册。' } }] },
    { choices: [{ delta: { content: '最终答案' } }] }
  ]);
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [],
    tools: {},
    fetchImpl: mockFetch,
    onEvent: (e) => { if (e.kind === 'reasoning') events.push(e.text); }
  });
  assert.equal(out.answer, '最终答案');
  assert.equal(out.reasoning, '先看目标。再读手册。');
  assert.deepEqual(events, ['先看目标。', '再读手册。']);
});

test('agent: 解析 usage（Context 指示器/缓存命中）', async () => {
  const mockFetch = async () => sse([
    { choices: [{ delta: { content: '好' } }] },
    { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } } }
  ]);
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [],
    tools: {},
    fetchImpl: mockFetch
  });
  assert.equal(out.answer, '好');
  assert.equal(out.usage.prompt_tokens, 1000);
  assert.equal(out.usage.prompt_tokens_details.cached_tokens, 900);
});

test('agent: 中断保留已流出内容（dsh 语义：中断不截断）', async () => {
  const enc = new TextEncoder();
  const mockFetch = async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '已经输出的前半段内容' } }] }) + String.fromCharCode(10, 10)));
      await new Promise((r) => setTimeout(r, 100)); // 挂一会再正常关闭（不 error，避免死锁）
      try { controller.close(); } catch { /* 已关闭 */ }
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const ac = new AbortController();
  const p = runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [], tools: {}, fetchImpl: mockFetch, signal: ac.signal
  });
  setTimeout(() => ac.abort(), 30); // 在流关闭前中断
  const out = await p;
  assert.equal(out.cancelled, true);
  assert.match(out.partialContent, /已经输出的前半段内容/); // 输出没丢
});

test('agent: 流式请求 body 带 stream_options.include_usage', async () => {
  let body = null;
  const mockFetch = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return sse([{ choices: [{ delta: { content: '好' } }] }]);
  };
  await runAgentTurn({ config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' }, messages: [], tools: {}, fetchImpl: mockFetch });
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('agent: 网关 4xx 拒绝 stream_options 时同一 attempt 去掉字段重试一次', async () => {
  const bodies = [];
  const mockFetch = async (_url, opts) => {
    const b = JSON.parse(opts.body);
    bodies.push(b);
    if (b.stream_options) return new Response('unsupported field', { status: 400 });
    return sse([{ choices: [{ delta: { content: '降级成功' } }] }]);
  };
  const out = await runAgentTurn({ config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' }, messages: [], tools: {}, fetchImpl: mockFetch });
  assert.equal(out.answer, '降级成功');
  assert.equal(bodies.length, 2, '只重试一次，不无限降级');
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });
  assert.equal(bodies[1].stream_options, undefined);
});

test('agent: 末行没有换行（流直接结束）也能取到 usage 和内容', async () => {
  const last = JSON.stringify({
    choices: [{ delta: { content: '结尾内容' } }],
    usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 800 } }
  });
  const mockFetch = async () => new Response('data: ' + last, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const out = await runAgentTurn({ config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' }, messages: [], tools: {}, fetchImpl: mockFetch });
  assert.equal(out.answer, '结尾内容');
  assert.equal(out.usage.prompt_tokens, 1000);
  assert.equal(out.usage.prompt_tokens_details.cached_tokens, 800);
});

test('agent: 中断返回也带上已收到的 usage', async () => {
  const enc = new TextEncoder();
  const chunk = 'data: ' + JSON.stringify({
    choices: [{ delta: { content: '中断前的输出' } }],
    usage: { prompt_tokens: 600, completion_tokens: 3, cached_tokens: 450 }
  }) + String.fromCharCode(10, 10);
  const mockFetch = async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(enc.encode(chunk));
      await new Promise((r) => setTimeout(r, 100));
      try { controller.close(); } catch { /* 已关闭 */ }
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const ac = new AbortController();
  const p = runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [], tools: {}, fetchImpl: mockFetch, signal: ac.signal
  });
  setTimeout(() => ac.abort(), 30);
  const out = await p;
  assert.equal(out.cancelled, true);
  assert.equal(out.usage.prompt_tokens, 600);
  assert.equal(out.usage.cached_tokens, 450);
});


// ---------- Wave 2：工具并行调度 ----------

test('agent: classifyTool——只有等待型工具并行，其余串行', () => {
  for (const name of ['read_file', 'read_playbook', 'probe_target', 'stress_target']) {
    assert.equal(classifyTool(name), 'parallel', name);
  }
  for (const name of ['run_command', 'edit_file', 'write_file', 'audit_project', 'download_gate', 'quality_gate', 'get_report', 'run_workflow', 'present_artifact', 'remember_project', 'list_playbooks', 'no_such_tool']) {
    assert.equal(classifyTool(name), 'serial', name);
  }
});

test('agent: 连续并行工具真的并发（第二个 tool-start 早于第一个 tool-end，总耗时 < 串行和）', async () => {
  const starts = [];
  const ends = [];
  const events = [];
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) {
      return toolCallsChunk(
        { index: 0, id: 'p1', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { index: 1, id: 'p2', function: { name: 'read_file', arguments: '{"path":"b"}' } }
      );
    }
    return sse([{ choices: [{ delta: { content: '并发完成' } }] }]);
  };
  const tools = {
    read_file: async (args) => {
      starts.push(Date.now());
      await sleep(100);
      ends.push(Date.now());
      return { path: args.path };
    }
  };
  const out = await runAgentTurn({
    config: cfg(),
    messages: [{ role: 'user', content: '并行读两个文件' }],
    tools,
    fetchImpl: mockFetch,
    onEvent: (e) => { if (e.kind === 'tool-start' || e.kind === 'tool-end') events.push(`${e.kind}:${e.name}`); }
  });
  assert.equal(out.answer, '并发完成');
  const seq = events.filter((e) => e.startsWith('tool-start') || e.startsWith('tool-end'));
  const firstEnd = seq.indexOf('tool-end:read_file');
  assert.ok(firstEnd >= 2, `第二个 tool-start 应在第一个 tool-end 之前，实际顺序 ${seq.join(',')}`);
  const span = Math.max(...ends) - Math.min(...starts);
  assert.ok(span < 180, `两个 100ms 工具并发总耗时应接近 100ms（实测 ${span}ms，串行为 ≥200ms）`);
});

test('agent: serial 工具不与并行批混跑——先等批完成再单独执行', async () => {
  const events = [];
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) {
      return toolCallsChunk(
        { index: 0, id: 's1', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { index: 1, id: 's2', function: { name: 'read_file', arguments: '{"path":"b"}' } },
        { index: 2, id: 's3', function: { name: 'audit_project', arguments: '{"dir":"D:/x"}' } },
        { index: 3, id: 's4', function: { name: 'read_file', arguments: '{"path":"c"}' } }
      );
    }
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  const tools = {
    read_file: async () => { await sleep(50); return { ok: true }; },
    audit_project: async () => { await sleep(50); return { verdict: '过' }; }
  };
  await runAgentTurn({
    config: cfg(),
    messages: [],
    tools,
    fetchImpl: mockFetch,
    onEvent: (e) => { if (e.kind === 'tool-start' || e.kind === 'tool-end') events.push(`${e.kind}:${e.name}`); }
  });
  assert.deepEqual(events, [
    'tool-start:read_file', 'tool-start:read_file', 'tool-end:read_file', 'tool-end:read_file',
    'tool-start:audit_project', 'tool-end:audit_project',
    'tool-start:read_file', 'tool-end:read_file'
  ]);
});

test('agent: convo 里 tool 消息与 trace 都按原始调用顺序追加（与完成先后无关）', async () => {
  const bodies = [];
  let calls = 0;
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    calls++;
    if (calls === 1) {
      return toolCallsChunk(
        { index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"slow"}' } },
        { index: 1, id: 'c2', function: { name: 'read_file', arguments: '{"path":"fast"}' } },
        { index: 2, id: 'c3', function: { name: 'read_file', arguments: '{"path":"mid"}' } }
      );
    }
    return sse([{ choices: [{ delta: { content: '好' } }] }]);
  };
  const delays = { slow: 80, fast: 10, mid: 40 };
  const tools = { read_file: async (args) => { await sleep(delays[args.path]); return { path: args.path }; } };
  const out = await runAgentTurn({ config: cfg(), messages: [], tools, fetchImpl: mockFetch });
  const toolMsgs = bodies[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['c1', 'c2', 'c3']);
  assert.deepEqual(toolMsgs.map((m) => JSON.parse(m.content).path), ['slow', 'fast', 'mid']);
  assert.deepEqual(out.trace.map((t) => t.result.path), ['slow', 'fast', 'mid']);
});

test('agent: 并行批里一个工具抛错不影响其它调用', async () => {
  let calls = 0;
  let sawOther = false;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) {
      return toolCallsChunk(
        { index: 0, id: 'e1', function: { name: 'read_file', arguments: '{"path":"bad"}' } },
        { index: 1, id: 'e2', function: { name: 'read_file', arguments: '{"path":"good"}' } }
      );
    }
    return sse([{ choices: [{ delta: { content: '其它调用照常完成' } }] }]);
  };
  const tools = {
    read_file: async (args) => {
      if (args.path === 'bad') throw new Error('炸了');
      sawOther = true;
      return { path: args.path };
    }
  };
  const out = await runAgentTurn({ config: cfg(), messages: [], tools, fetchImpl: mockFetch });
  assert.equal(out.answer, '其它调用照常完成');
  assert.match(out.trace[0].result.error, /炸了/);
  assert.equal(out.trace[1].result.path, 'good');
  assert.equal(out.trace.length, 2);
  assert.equal(sawOther, true);
});

// ---------- Wave 2：软预算 ----------

test('agent: 时间预算超限——跳出循环，走禁止调工具的收尾请求', async () => {
  const bodies = [];
  const events = [];
  let calls = 0;
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    calls++;
    if (calls === 1) {
      // 预算算的是「模型时间」：这里让模型调用本身变慢，而不是让工具变慢
      await sleep(200);
      return toolCallsChunk({ index: 0, id: 'b1', function: { name: 'audit_project', arguments: '{"dir":"D:/x"}' } });
    }
    return sse([{ choices: [{ delta: { content: '预算收尾结论' } }] }]);
  };
  const tools = { audit_project: async () => ({ verdict: '过' }) };
  const out = await runAgentTurn({
    config: cfg({ maxTurnMs: 150 }),
    messages: [],
    tools,
    fetchImpl: mockFetch,
    onEvent: (e) => events.push(e)
  });
  assert.equal(out.answer, '预算收尾结论');
  assert.equal(bodies.length, 2, '第二轮开始即超时，不应再发带工具的请求');
  assert.equal(bodies[1].tools, undefined, '收尾请求不应带工具');
  assert.match(bodies[1].messages.at(-1).content, /不要再调用任何工具/);
  const budget = events.find((e) => e.kind === 'budget');
  assert.equal(budget?.reason, 'time');
  assert.equal(typeof budget.tokens, 'number');
});

test('agent: token 预算超限——累计 usage 超限后走收尾请求', async () => {
  const bodies = [];
  const events = [];
  let calls = 0;
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    calls++;
    if (calls === 1) {
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'audit_project', arguments: '{"dir":"D:/x"}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 900, completion_tokens: 200 } }
      ]);
    }
    return sse([{ choices: [{ delta: { content: 'token 预算收尾' } }] }]);
  };
  const out = await runAgentTurn({
    config: cfg({ maxTurnTokens: 1000 }),
    messages: [],
    tools: { audit_project: async () => ({ verdict: '过' }) },
    fetchImpl: mockFetch,
    onEvent: (e) => events.push(e)
  });
  assert.equal(out.answer, 'token 预算收尾');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].tools, undefined);
  const budget = events.find((e) => e.kind === 'budget');
  assert.equal(budget?.reason, 'tokens');
  assert.ok(budget.tokens >= 1000, `累计 token 应 ≥1000，实际 ${budget?.tokens}`);
});

/* ---------- B 档：回合级 hooks（UserPromptSubmit / Stop） ---------- */

const hookConfig = (events) => ({ enabled: true, events });

test('agent: UserPromptSubmit deny → 本轮不调用模型', async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    return sse([{ choices: [{ delta: { content: '不应出现' } }] }]);
  };
  const out = await runAgentTurn({
    config: cfg(),
    messages: [{ role: 'user', content: '帮我查一下' }],
    tools: {},
    fetchImpl: mockFetch,
    hooksConfig: hookConfig({ UserPromptSubmit: [{ command: 'prompt-gate' }] }),
    hooksRunner: async () => ({ code: 0, stdout: JSON.stringify({ decision: 'deny', message: '提示词被策略拦截' }), stderr: '' })
  });
  assert.equal(calls, 0, '模型请求应为 0 次');
  assert.match(out.error, /被 hook 拦截：提示词被策略拦截/);
  assert.equal(out.hookDenied, true);
});

test('agent: Stop deny → 回答不变，只返回 hookNotice', async () => {
  const mockFetch = async () => sse([{ choices: [{ delta: { content: '本轮最终回答' } }] }]);
  const out = await runAgentTurn({
    config: cfg(),
    messages: [],
    tools: {},
    fetchImpl: mockFetch,
    hooksConfig: hookConfig({ Stop: [{ command: 'stop-gate' }] }),
    hooksRunner: async () => ({ code: 0, stdout: JSON.stringify({ decision: 'deny', message: '还没收完证据' }), stderr: '' })
  });
  assert.equal(out.answer, '本轮最终回答');
  assert.equal(out.hookNotice, '还没收完证据');
});

test('agent: 未启用 hooks 时不产生任何 hook 调用/通知', async () => {
  let hookCalls = 0;
  const mockFetch = async () => sse([{ choices: [{ delta: { content: '正常回答' } }] }]);
  const out = await runAgentTurn({
    config: cfg(),
    messages: [],
    tools: {},
    fetchImpl: mockFetch,
    hooksConfig: { enabled: false, events: { Stop: [{ command: 'stop-gate' }] } },
    hooksRunner: async () => { hookCalls++; return { code: 0, stdout: '' }; }
  });
  assert.equal(out.answer, '正常回答');
  assert.equal(out.hookNotice, undefined);
  assert.equal(hookCalls, 0);
});

/* ---------- C 档：provider 配置字段透传 ---------- */

test('agent: normalizeProviderLimits 保留三个字段，缺省/非法值不写入', () => {
  assert.deepEqual(
    normalizeProviderLimits({ contextWindow: 200000, maxOutputTokens: 32000, toolConcurrency: 4 }),
    { contextWindow: 200000, maxOutputTokens: 32000, toolConcurrency: 4 }
  );
  assert.deepEqual(normalizeProviderLimits({}), {}, '缺省不应出现任何字段');
  assert.deepEqual(
    normalizeProviderLimits({ contextWindow: 0, maxOutputTokens: -1, toolConcurrency: 'x' }),
    {},
    '非法值不应写入'
  );
  assert.equal(normalizeProviderLimits({ contextWindow: 1 }).contextWindow, 8000, '窗口下限与旧行为一致');
  assert.equal(normalizeProviderLimits({ toolConcurrency: 99 }).toolConcurrency, 16);
});

/* ---------- 工作流 per-step 模型 / 跨家族复核 ---------- */

const stepProviders = [
  { id: 'p-a', name: '甲', baseUrl: 'https://a.example/v1', apiKey: 'ka', models: ['ma1', 'ma2'], enabled: true },
  { id: 'p-b', name: '乙', baseUrl: 'https://b.example/v1', apiKey: 'kb', models: ['mb1'], enabled: true, family: 'fam-b' }
];
const fallbackSub = { providerId: 'p-a', baseUrl: 'https://a.example/v1', apiKey: 'ka', model: 'ma1' };

test('agent: 工作流 per-step 模型——命中 provider/model，缺失/禁用/不在列表时回退全局并记 warning', () => {
  const hit = resolveWorkflowStepModel({ step: { id: 's1', providerId: 'p-b', model: 'mb1' }, providers: stepProviders, fallback: fallbackSub });
  assert.deepEqual(hit.override, { baseUrl: 'https://b.example/v1', apiKey: 'kb', model: 'mb1', providerId: 'p-b' });
  assert.equal(hit.warning, null);

  const hitDefaultModel = resolveWorkflowStepModel({ step: { id: 's2', providerId: 'p-a' }, providers: stepProviders, fallback: fallbackSub });
  assert.equal(hitDefaultModel.override.model, 'ma1', '只给 providerId 时用该 provider 的第一个模型');

  const modelMiss = resolveWorkflowStepModel({ step: { id: 's3', providerId: 'p-b', model: 'ma1' }, providers: stepProviders, fallback: fallbackSub });
  assert.deepEqual(modelMiss.override, fallbackSub, 'model 不在 provider 列表 → 回退全局子代理模型');
  assert.match(modelMiss.warning, /model ma1 不在 provider p-b 的模型列表/);
  assert.match(modelMiss.warning, /回退全局子代理模型/);

  const providerMiss = resolveWorkflowStepModel({ step: { id: 's4', providerId: 'p-x', model: 'ma1' }, providers: stepProviders, fallback: fallbackSub });
  assert.deepEqual(providerMiss.override, fallbackSub);
  assert.match(providerMiss.warning, /provider p-x 不存在/);

  const disabled = resolveWorkflowStepModel({
    step: { id: 's5', providerId: 'p-b', model: 'mb1' },
    providers: [{ ...stepProviders[1], enabled: false }],
    fallback: fallbackSub
  });
  assert.deepEqual(disabled.override, fallbackSub);
  assert.match(disabled.warning, /不可用/);

  const none = resolveWorkflowStepModel({ step: { id: 's6' }, providers: stepProviders, fallback: fallbackSub });
  assert.equal(none.override, null);
  assert.equal(none.warning, null);
});

test('agent: providerFamily 判定顺序 family > name > baseUrl host', () => {
  assert.equal(providerFamily({ family: 'fam', name: '名', baseUrl: 'https://h.example/v1' }), 'fam');
  assert.equal(providerFamily({ name: '名', baseUrl: 'https://h.example/v1' }), '名');
  assert.equal(providerFamily({ baseUrl: 'https://h.example/v1' }), 'h.example');
  assert.equal(providerFamily(null), '');
});

test('agent: verify/arbitrate 与 find 同 family 产生 warning；不同 family 不产生', () => {
  const same = [
    { id: 's2', kind: 'find', providerId: 'p-a', ok: true },
    { id: 's3', kind: 'verify', providerId: 'p-a', ok: true },
    { id: 's4', kind: 'arbitrate', providerId: 'p-a', ok: true }
  ];
  const warnings = computeCrossFamilyWarnings({ results: same, providers: stepProviders });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /跨家族复核未满足：verify\(s3\)=甲 与 find\(s2\)=甲 相同/);
  assert.match(warnings[1], /跨家族复核未满足：arbitrate\(s4\)=甲 与 find\(s2\)=甲 相同/);

  const different = [
    { id: 's2', kind: 'find', providerId: 'p-a', ok: true },
    { id: 's3', kind: 'verify', providerId: 'p-b', ok: true }
  ];
  assert.deepEqual(computeCrossFamilyWarnings({ results: different, providers: stepProviders }), []);

  const noKind = [{ id: 's1', providerId: 'p-a' }];
  assert.deepEqual(computeCrossFamilyWarnings({ results: noKind, providers: stepProviders }), []);
});

/* ---------- SessionStart hook（fail-open + context 注入） ---------- */

test('agent: SessionStart deny/allow 都不影响会话打开，messages/context 被收集', async () => {
  for (const decision of ['deny', 'allow']) {
    const seen = [];
    const r = await runSessionStartHook({
      sessionId: 's1',
      cwd: 'D:/proj',
      projectPath: 'D:/proj',
      hooksConfig: hookConfig({ SessionStart: [{ command: 'start-hook' }] }),
      hooksRunner: async (_cmd, { input }) => {
        seen.push(input);
        return { code: 0, stdout: JSON.stringify({ decision, message: `msg-${decision}`, context: '启动上下文' }), stderr: '' };
      }
    });
    assert.equal(r.decision, decision);
    assert.deepEqual(r.messages, [`msg-${decision}`]);
    assert.equal(r.context, '启动上下文');
    assert.equal(r.error, undefined, 'deny 也不能作为错误抛出/阻断打开');
    assert.equal(seen[0].event, 'SessionStart');
    assert.equal(seen[0].sessionId, 's1');
    assert.equal(seen[0].cwd, 'D:/proj');
    assert.equal(seen[0].projectPath, 'D:/proj');
  }
});

test('agent: SessionStart 未启用 hooks 时直接 allow，不跑 hook', async () => {
  let calls = 0;
  const r = await runSessionStartHook({
    sessionId: 's',
    hooksConfig: { enabled: false, events: {} },
    hooksRunner: async () => { calls++; return { code: 0, stdout: '', stderr: '' }; }
  });
  assert.equal(r.decision, 'allow');
  assert.equal(r.context, '');
  assert.equal(calls, 0);
});

test('agent: SessionStart context 注入到下一轮 messages，位置在项目记忆之后', () => {
  const memory = { role: 'system', content: '【项目记忆 · AGENTS.md（D:/p/AGENTS.md）】\n约定' };
  const messages = [memory, { role: 'system', content: '【当前工作区】' }, { role: 'user', content: '继续' }];
  const out = injectSessionHookContext(messages, '启动上下文');
  assert.equal(out.length, messages.length + 1);
  assert.equal(out[0], memory, '项目记忆保持在最前');
  assert.equal(out[1].role, 'system');
  assert.match(out[1].content, /【会话启动上下文（SessionStart hook）】/);
  assert.match(out[1].content, /启动上下文/);
  assert.equal(out[2].content, '【当前工作区】');
  assert.equal(out[3].role, 'user');
  assert.equal(messages.length, 3, '不应改原数组');
  // 没有项目记忆时放最前
  const front = injectSessionHookContext([{ role: 'user', content: 'q' }], 'ctx');
  assert.equal(front[0].role, 'system');
  assert.match(front[0].content, /ctx/);
  // 空 context 不注入
  assert.deepEqual(injectSessionHookContext(messages, '  '), messages);
});

test('agent: 轮次到 80% 时只发一次 budget-warning（不刷屏）', async () => {
  const events = [];
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls <= 3) {
      return toolCallsChunk({ index: 0, id: 'w' + calls, function: { name: 'probe_target', arguments: '{}' } });
    }
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  await runAgentTurn({
    config: cfg(),
    messages: [],
    tools: { probe_target: async () => ({ ok: 1 }) },
    fetchImpl: mockFetch,
    maxTurns: 3,
    onEvent: (e) => events.push(e)
  });
  const warnings = events.filter((e) => e.kind === 'budget-warning');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].turnsLeft, 1);
  assert.ok(warnings[0].tokensLeft > 0);
});

test('agent: config 透传的跨轮 token 预算生效（摘要 + 最近 4 条原文）', async () => {
  const bodies = [];
  const mockFetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  const messages = [0, 1, 2, 3, 4, 5].map((i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `m${i}-` + 'x'.repeat(196)
  }));
  const out = await runAgentTurn({
    config: cfg({ crossTurnBudgetTokens: 100 }),
    messages,
    summarize: async () => '跨轮摘要',
    fetchImpl: mockFetch,
    tools: {}
  });
  assert.equal(out.answer, '完成');
  const sent = bodies[0].messages;
  assert.equal(sent[0].role, 'system');
  assert.deepEqual(sent[1], { role: 'user', content: '[历史摘要]\n跨轮摘要' });
  assert.equal(sent.length, 6); // system + 摘要 + 最近 4 条
  assert.equal(sent[2].content, messages[2].content);
  assert.equal(sent[5].content, messages[5].content);
});

test('agent: HTTP 402 给账单说明，不再让人去查 Base URL', async () => {
  const out = await runAgentTurn({
    config: cfg(),
    messages: [{ role: 'user', content: 'hi' }],
    tools: {},
    fetchImpl: async () => new Response('{"error":{"message":"Payment Required"}}', {
      status: 402,
      headers: { 'content-type': 'application/json' }
    })
  });
  assert.match(out.error, /HTTP 402/);
  assert.match(out.error, /余额|额度/);
  assert.doesNotMatch(out.error, /Base URL 是否含/);
});

test('agent: 工具执行时间不计入时间预算（工作流跑很久也不会被判超时）', async () => {
  const events = [];
  let calls = 0;
  const mockFetch = async () => {
    calls += 1;
    if (calls === 1) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'slow_tool', arguments: '{}' } }] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  const out = await runAgentTurn({
    config: cfg({ maxTurnMs: 300 }),
    messages: [{ role: 'user', content: '跑' }],
    tools: { slow_tool: async () => { await sleep(700); return { ok: true }; } },
    fetchImpl: mockFetch,
    onEvent: (ev) => events.push(ev)
  });
  assert.equal(out.error, undefined);
  assert.equal(out.budgetStop, undefined, '工具耗时不该触发时间预算');
  assert.equal(events.filter((e) => e.kind === 'budget').length, 0);
});

test('agent: 收尾请求遇到 503 会重试，已有证据不丢', async () => {
  const events = [];
  let calls = 0;
  const mockFetch = async () => {
    calls += 1;
    if (calls === 1) {
      return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'fake_tool', arguments: '{}' } }] } }] },
        { choices: [], usage: { prompt_tokens: 5000, completion_tokens: 20 } }
      ]);
    }
    if (calls <= 3) {
      return new Response('{"error":{"message":"overloaded"}}', { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return sse([{ choices: [{ delta: { content: '结论：证据已在时间线里' } }] }]);
  };
  const out = await runAgentTurn({
    config: cfg({ maxTurnTokens: 10 }),
    messages: [{ role: 'user', content: '跑' }],
    tools: { fake_tool: async () => ({ ok: true }) },
    fetchImpl: mockFetch,
    onEvent: (ev) => events.push(ev)
  });
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  assert.match(out.answer, /结论/);
  const retries = events.filter((e) => e.kind === 'retry');
  assert.ok(retries.length >= 2, `应至少重试 2 次，实际 ${retries.length}`);
  assert.match(retries[0].reason, /收尾请求/);
});

test('agent: 空回复补救——第一次空正文会催一次，第二次拿到结论', async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls += 1;
    if (calls === 1) return sse([{ choices: [{ delta: {} }] }]); // 只有 finish，没有任何正文/工具
    return sse([{ choices: [{ delta: { content: '补交结论：基于已跑过的工具结果' } }] }]);
  };
  const out = await runAgentTurn({
    config: cfg(),
    messages: [{ role: 'user', content: '查一下' }],
    tools: {},
    fetchImpl: mockFetch
  });
  assert.equal(out.error, undefined);
  assert.equal(calls, 2, '空回复应当只催一次');
  assert.match(out.answer, /补交结论/);
});

test('agent: 空回复补救最多两次——第二次仍空就认输，不无限循环', async () => {
  let calls = 0;
  const mockFetch = async () => {
    calls += 1;
    return sse([{ choices: [{ delta: {} }] }]);
  };
  const out = await runAgentTurn({
    config: cfg(),
    messages: [{ role: 'user', content: '查一下' }],
    tools: {},
    fetchImpl: mockFetch
  });
  assert.equal(calls, 3, `最多补交两次（首次 + 2 次催促），实际发了 ${calls} 次`);
  assert.equal(out.answer, '(空回复)');
  assert.equal(out.emptyReply, true, '空回复要带显式标记，上层据此归因 EMPTY_CONTENT');
  assert.equal(out.roundsUsed, 3, '记录主循环轮数，便于定位 length 截断 / 模型自己停');
});
