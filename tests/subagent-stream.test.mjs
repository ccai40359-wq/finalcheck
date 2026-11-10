// 工作流子代理走主 agent 引擎（runSubagentTurn → runAgentTurn）的回归：
// 用本地假 HTTP SSE provider，不烧真实 key。锁住四件事：
//  1. 流式：onToken 收到逐段增量，transcript 里拼回完整 assistant 正文（SubagentPanel 形状不变）
//  2. toolsSchema 覆盖：请求体 tools 只带传入的 schema（子代理 14 个工具，无 run_workflow / remember_project）
//  3. 空转硬闸：0 次工具 + 取证角色 → failed（文案与旧版一致）
//  4. finish_reason=length → truncated + 截断 warning
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runSubagentTurn, SUBAGENT_TOOLS_SCHEMA } from '../desktop/src/main/agent-service.mjs';

const READ_FILE_SCHEMA = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取本机文本文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};

/** 假 provider：按请求序号返回 SSE 分片，记录所有请求体 */
async function startFakeProvider(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 坏 JSON 按空对象 */ }
      requests.push(body);
      const out = handler(body, requests.length) || {};
      const status = Array.isArray(out) ? 200 : (Number(out.status) || 200);
      res.statusCode = status;
      if (status !== 200) {
        // 网关拒绝：返回 JSON 错误体（runAgentTurn 只看 status）
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: out.error || 'unsupported field' } }));
        return;
      }
      const chunks = Array.isArray(out) ? out : (out.chunks || []);
      const gapMs = Array.isArray(out) ? 0 : (Number(out.gapMs) || 0);
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      const write = (chunk) => res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      if (!gapMs) {
        for (const chunk of chunks) write(chunk);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      // 分段慢慢吐：让上层有时间按节流真正落盘中间态
      let i = 0;
      const tick = () => {
        if (i >= chunks.length) {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        write(chunks[i]);
        i += 1;
        setTimeout(tick, gapMs);
      };
      tick();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    baseUrl,
    requests,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(r);
    })
  };
}

const delta = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finalText = (content, finishReason = 'stop') => ({
  choices: [{ index: 0, delta: { content }, finish_reason: finishReason }]
});
const toolCallChunk = (id, name, args, finishReason = 'tool_calls') => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] }, finish_reason: finishReason }]
});

test('subagent-stream: onToken 收到 3 段增量，transcript 拼回完整正文与工具行', async (t) => {
  const fake = await startFakeProvider((_body, n) => (n === 1
    ? [
        delta('第一段'),
        delta('第二段'),
        delta('第三段'),
        toolCallChunk('call_1', 'read_file', '{"path":"README.md"}')
      ]
    : [delta('最终'), finalText('结论')]));
  t.after(() => fake.close());

  const tokens = [];
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理，必须用工具取证。',
    prompt: '读 README',
    kind: 'recon',
    tools: { read_file: async (args) => ({ path: args.path, text: 'README 内容' }) },
    toolsSchema: [READ_FILE_SCHEMA],
    onToken: (text) => tokens.push(text)
  });

  // 流是真流：每个 SSE 分片各自触发一次 onToken
  assert.equal(tokens.length, 5, `应收到 5 个增量，实际 ${JSON.stringify(tokens)}`);
  assert.equal(tokens.slice(0, 3).join(''), '第一段第二段第三段');

  // 第一次请求：system 是子代理提示（不是主 agent 全局提示），tools 只带传入的 schema
  const first = fake.requests[0];
  assert.equal(first.stream, true, '子代理请求必须走 SSE 流式');
  assert.equal(first.messages[0].role, 'system');
  assert.equal(first.messages[0].content, '你是子代理，必须用工具取证。');
  assert.deepEqual(first.messages[1], { role: 'user', content: '读 README' });
  assert.deepEqual(first.tools.map((x) => x.function.name), ['read_file']);
  assert.equal(fake.requests.length, 2, '工具调用后应继续第二轮（同一引擎多轮循环）');

  // SubagentPanel 兼容形状：system → user → assistant(toolCalls) → tool → assistant(final)
  const msgs = result.transcript;
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
  assert.equal(msgs[2].content, '第一段第二段第三段', 'assistant 正文应为三次 token 拼接结果');
  assert.deepEqual(msgs[2].toolCalls.map((c) => c.name), ['read_file']);
  assert.equal(msgs[3].name, 'read_file');
  assert.equal(msgs[3].pending, false);
  assert.equal(msgs[3].ok, true);
  assert.match(msgs[3].content, /README 内容/);
  assert.equal(msgs[4].content, '最终结论');
  assert.equal(msgs[4].final, true);

  assert.equal(result.error, undefined);
  assert.equal(result.content, '最终结论');
  assert.equal(result.toolCount, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.finishReason, 'stop');
});

test('subagent-stream: 节流落盘——运行中 onTranscript 已能看到逐字输出', async (t) => {
  // 每个分片间隔 40ms，节流 20ms：中间态必须被落盘，面板才能边跑边长
  const fake = await startFakeProvider(() => ({
    gapMs: 40,
    chunks: [delta('甲'), delta('乙'), finalText('丙')]
  }));
  t.after(() => fake.close());
  const snapshots = [];
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '给结论',
    tools: {},
    toolsSchema: [READ_FILE_SCHEMA],
    saveIntervalMs: 20,
    onTranscript: (messages, meta = {}) => snapshots.push({ messages, done: !!meta.done })
  });
  const partial = snapshots.filter((s) => !s.done);
  assert.ok(partial.length >= 1, '运行中至少落盘一次');
  assert.ok(
    partial.some((s) => {
      const a = s.messages.find((m) => m.role === 'assistant');
      return a && a.content && a.content !== '甲乙丙';
    }),
    `应有未写完的中间态，实际 ${JSON.stringify(partial.map((s) => s.messages.find((m) => m.role === 'assistant')?.content))}`
  );
  assert.equal(result.content, '甲乙丙');
  assert.equal(snapshots.at(-1).done, true);
});

test('subagent-stream: toolsSchema 覆盖——只读 schema 的请求体里没有 run_command', async (t) => {
  const fake = await startFakeProvider(() => [finalText('汇总完成，没有发现新问题。')]);
  t.after(() => fake.close());
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '汇总一下',
    tools: {},
    toolsSchema: [READ_FILE_SCHEMA]
  });
  const body = fake.requests[0];
  assert.deepEqual(body.tools.map((x) => x.function.name), ['read_file']);
  assert.ok(!body.tools.some((x) => x.function.name === 'run_command'));
  assert.equal(body.stream, true);
  assert.equal(result.error, undefined);
});

test('subagent-stream: 子代理工具集固定 14 个（无 run_workflow / remember_project）', () => {
  assert.equal(SUBAGENT_TOOLS_SCHEMA.length, 14);
  const names = SUBAGENT_TOOLS_SCHEMA.map((t) => t.function.name);
  assert.deepEqual(names.filter((n) => n === 'run_workflow' || n === 'remember_project'), []);
  assert.ok(names.includes('review_diff'), 'review_diff 是子代理可用工具（只在 AGENT_ONLY_TOOLS_SCHEMA）');
  assert.ok(names.includes('run_command'), '只读/命令行工具仍对子代理开放');
});

test('subagent-stream: 0 工具 + 审查角色 → failed（空转硬闸文案不变）', async (t) => {
  const fake = await startFakeProvider(() => [finalText('代码看起来没问题，没有发现风险。')]);
  t.after(() => fake.close());
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '请审查这个项目的安全性',
    role: '审查员',
    tools: { read_file: async () => ({ ok: true }) },
    toolsSchema: [READ_FILE_SCHEMA]
  });
  assert.equal(result.toolCount, 0);
  assert.match(result.error, /未产生任何工具调用：该步没有取证（疑似空转）/);
  // 取证角色会先强制首轮工具，空转后再提醒重试一次（共 2 次请求），仍无工具才判失败
  assert.equal(fake.requests.length, 2, '空转判定前应有一次 system 提醒重试');
  assert.equal(fake.requests[0].tool_choice, 'required');
  assert.ok(fake.requests[1].messages.some((m) => m.role === 'system' && /你还没有调用任何工具/.test(String(m.content))));
});

test('subagent-stream: 显式 maxTurns=40 时，第 41 次是不带工具的收尾请求（默认已不限轮数）', async (t) => {
  const fake = await startFakeProvider((body) => (Array.isArray(body.tools)
    ? [toolCallChunk('c' + Math.random(), 'read_file', '{"path":"a.txt"}')]
    : [finalText('40 轮后收尾结论')]));
  t.after(() => fake.close());
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '读文件',
    kind: 'recon',
    tools: { read_file: async () => ({ ok: true }) },
    toolsSchema: [READ_FILE_SCHEMA],
    maxTurns: 40
  });
  assert.equal(fake.requests.length, 41, `应为 40 轮工具 + 1 次收尾，实际 ${fake.requests.length}`);
  assert.equal(fake.requests[40].tools, undefined, '收尾请求不应再带工具');
  assert.equal(fake.requests.slice(0, 40).every((b) => b.stream === true), true, '每一轮都必须走 SSE 流式');
  assert.equal(result.toolCount, 40);
  assert.equal(result.content, '40 轮后收尾结论');
});

test('subagent-stream: 默认不限轮数（长时间自主工作）——连跑 6 轮工具不触发预算/收尾', async (t) => {
  let calls = 0;
  const events = [];
  const fake = await startFakeProvider((body) => {
    calls += 1;
    if (calls <= 6) return [toolCallChunk('c' + calls, 'read_file', '{"path":"a.txt"}')];
    return [finalText('6 轮后自己收尾')];
  });
  t.after(() => fake.close());
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '读文件',
    kind: 'recon',
    tools: { read_file: async () => ({ ok: true }) },
    toolsSchema: [READ_FILE_SCHEMA],
    onEvent: (ev) => events.push(ev)
  });
  assert.equal(fake.requests.length, 7, `6 轮工具 + 1 次最终回答，实际 ${fake.requests.length}`);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.content, '6 轮后自己收尾');
  assert.equal(events.filter((e) => e.kind === 'budget').length, 0, '默认不应有预算事件');
});

test('subagent-stream: forceFirstToolChoice=true → 首轮 tool_choice=required，第二轮省略', async (t) => {
  const fake = await startFakeProvider((body) => (body.tool_choice
    ? [toolCallChunk('call_f1', 'read_file', '{"path":"a.txt"}')]
    : [finalText('最终结论')]));
  t.after(() => fake.close());
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '审查并取证',
    kind: 'recon',
    tools: { read_file: async () => ({ ok: true }) },
    toolsSchema: [READ_FILE_SCHEMA],
    requiresTools: true,
    forceFirstToolChoice: true
  });
  assert.equal(fake.requests[0].tool_choice, 'required', '首轮必须强制工具');
  assert.equal(fake.requests.at(-1).tool_choice, undefined, '后续轮不应继续强制 required');
  assert.equal(result.error, undefined);
  assert.equal(result.content, '最终结论');
  assert.equal(result.toolCount, 1);
});

test('subagent-stream: 首轮无 tool_calls → system 提醒再试一次；仍无 → failed「未产生任何工具调用」', async (t) => {
  const fake = await startFakeProvider(() => [finalText('我先看看，稍后给结论。')]);
  t.after(() => fake.close());
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '请审查这个项目的安全性',
    role: '审查员',
    tools: { read_file: async () => ({ ok: true }) },
    toolsSchema: [READ_FILE_SCHEMA],
    requiresTools: true,
    forceFirstToolChoice: true
  });
  assert.equal(fake.requests.length, 2, '首轮空转后只提醒重试一次');
  assert.equal(fake.requests[0].tool_choice, 'required');
  assert.equal(fake.requests[1].tool_choice, undefined);
  assert.ok(
    fake.requests[1].messages.some((m) => m.role === 'system' && /你还没有调用任何工具/.test(String(m.content))),
    '第二次请求必须带空转提醒 system'
  );
  // 面板 transcript 也要能看到这条提醒（role=system，按发生顺序）
  assert.ok(result.transcript.some((m) => m.role === 'system' && /你还没有调用任何工具/.test(String(m.content))));
  assert.equal(result.toolCount, 0);
  assert.match(result.error, /未产生任何工具调用：该步没有取证（疑似空转）/);
});

test('subagent-stream: tool_choice 返回 400 → 自动去掉字段重试，流程不整体硬失败', async (t) => {
  const fake = await startFakeProvider((body) => {
    if (body.tool_choice) return { status: 400, error: 'tool_choice unsupported' };
    const hasToolResult = Array.isArray(body.messages) && body.messages.some((m) => m.role === 'tool');
    if (Array.isArray(body.tools) && !hasToolResult) return [toolCallChunk('call_400', 'read_file', '{"path":"a.txt"}')];
    return [finalText('降级后拿到结论')];
  });
  t.after(() => fake.close());
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '审查并取证',
    kind: 'recon',
    tools: { read_file: async () => ({ ok: true }) },
    toolsSchema: [READ_FILE_SCHEMA],
    requiresTools: true,
    forceFirstToolChoice: true
  });
  assert.equal(fake.requests[0].tool_choice, 'required');
  assert.ok(fake.requests.length >= 3, `应发生降级重试，实际 ${fake.requests.length} 次`);
  // 降级后成功的那次请求不再带 tool_choice，但仍是 tools 请求
  const recovered = fake.requests.find((b, i) => i > 0 && b.tool_choice === undefined && Array.isArray(b.tools));
  assert.ok(recovered, '应有一次去掉 tool_choice 后成功的请求');
  assert.equal(result.error, undefined, '不应整体硬失败');
  assert.equal(result.content, '降级后拿到结论');
  assert.equal(result.toolCount, 1);
  assert.ok(result.warnings.some((w) => w.includes('tool_choice')), `warnings=${JSON.stringify(result.warnings)}`);
});

test('subagent-stream: usageTotal 累计多轮请求的 token（工作流用量账本口径）', async (t) => {
  const usage = (prompt, completion) => ({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });
  const fake = await startFakeProvider((_body, n) => (n === 1
    ? [
        delta('先查'),
        toolCallChunk('call_u', 'read_file', '{"path":"a.txt"}'),
        usage(100, 10)
      ]
    : [delta('好了'), finalText('结论'), usage(200, 20)]));
  t.after(() => fake.close());
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '读文件',
    kind: 'recon',
    tools: { read_file: async () => ({ ok: true }) },
    toolsSchema: [READ_FILE_SCHEMA]
  });
  assert.deepEqual(
    { prompt: result.usageTotal.prompt, completion: result.usageTotal.completion, requests: result.usageTotal.requests },
    { prompt: 300, completion: 30, requests: 2 }
  );
});

test('subagent-stream: finish_reason=length → truncated 标记与截断 warning', async (t) => {
  const fake = await startFakeProvider(() => [
    { choices: [{ index: 0, delta: { content: '结论写到一半' }, finish_reason: 'length' }] }
  ]);
  t.after(() => fake.close());
  const result = await runSubagentTurn({
    config: { baseUrl: fake.baseUrl, apiKey: 'k', model: 'm' },
    systemPrompt: '你是子代理。',
    prompt: '整理一下目前的信息',
    tools: {},
    toolsSchema: [READ_FILE_SCHEMA]
  });
  assert.equal(result.finishReason, 'length');
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.some((w) => w.includes('输出被截断')), `warnings=${JSON.stringify(result.warnings)}`);
});
