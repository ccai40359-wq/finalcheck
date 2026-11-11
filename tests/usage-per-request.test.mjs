// Bug B 回归 1：用量按「请求」记账，而不是回合结束只记一条最后一次请求。
// runAgentTurn 每完成一次模型请求就回调 onUsage（provider/model 取该次请求的实际值）；
// ipc-agent 侧不再在回合结束用 out.usage 补账（否则总数翻倍）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sse(chunks) {
  const body = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const toolCallAndUsage = (id, usage) => sse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'noop_tool', arguments: '{}' } }] } }] },
  { choices: [], usage }
]);

test('每完成一次请求就回调一次 onUsage：3 次请求 → 3 条，总量 = 各次之和', async () => {
  let n = 0;
  const mockFetch = async () => {
    n += 1;
    if (n === 1) return toolCallAndUsage('c1', { prompt_tokens: 100, completion_tokens: 10 });
    if (n === 2) return toolCallAndUsage('c2', { prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } });
    return sse([
      { choices: [{ delta: { content: '完成' } }] },
      { choices: [], usage: { prompt_tokens: 300, completion_tokens: 30 } }
    ]);
  };
  const usageLog = [];
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm', providerId: 'p1' },
    messages: [{ role: 'user', content: '跑一个多轮任务' }],
    tools: { noop_tool: async () => ({ ok: true }) },
    fetchImpl: mockFetch,
    onUsage: (u) => usageLog.push(u)
  });

  assert.equal(n, 3, '确实发了 3 次请求');
  assert.equal(usageLog.length, 3, '账本行数 = 请求数（不是 1）');
  const sum = usageLog.reduce((acc, u) => ({
    prompt: acc.prompt + (u.prompt || 0),
    completion: acc.completion + (u.completion || 0),
    cached: acc.cached + (u.cached || 0)
  }), { prompt: 0, completion: 0, cached: 0 });
  assert.deepEqual(sum, { prompt: 600, completion: 60, cached: 50 }, '总量等于各次之和');
  // Context 指示器口径不变：out.usage 仍是「最后一次请求」
  assert.equal(out.usage.prompt_tokens, 300);
  assert.equal(out.usageTotal.requests, 3);
  assert.equal(out.usageTotal.prompt, 600);
});

test('运行中切模型：每次请求的 provider/model 记该次实际使用的值', async () => {
  let n = 0;
  let resolveCalls = 0;
  const mockFetch = async () => {
    n += 1;
    if (n === 1) return toolCallAndUsage('c1', { prompt_tokens: 10, completion_tokens: 1 });
    return sse([
      { choices: [{ delta: { content: '完成' } }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2 } }
    ]);
  };
  const usageLog = [];
  await runAgentTurn({
    config: { baseUrl: 'https://a.example/v1', apiKey: 'k', model: 'model-a', providerId: 'p-a' },
    messages: [{ role: 'user', content: '切模型' }],
    tools: { noop_tool: async () => ({ ok: true }) },
    fetchImpl: mockFetch,
    // 第 1 次解析保持原样，之后切到 provider B / model-b
    resolveConfig: async () => {
      resolveCalls += 1;
      if (resolveCalls < 2) return null;
      return { baseUrl: 'https://b.example/v1', apiKey: 'k', model: 'model-b', providerId: 'p-b' };
    },
    onUsage: (u) => usageLog.push(u)
  });

  assert.equal(usageLog.length, 2);
  assert.equal(usageLog[0].model, 'model-a');
  assert.equal(usageLog[0].providerId, 'p-a');
  assert.equal(usageLog[1].model, 'model-b', '切模型后的请求按新模型记');
  assert.equal(usageLog[1].providerId, 'p-b', '不会把新模型的消耗记到旧供应商名下');
});

test('onUsage 回调抛错不影响回合完成', async () => {
  const mockFetch = async () => sse([
    { choices: [{ delta: { content: '好了' } }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }
  ]);
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [],
    tools: {},
    fetchImpl: mockFetch,
    onUsage: () => { throw new Error('ledger down'); }
  });
  assert.equal(out.answer, '好了');
  assert.equal(out.error, undefined);
});

test('ipc-agent: 回合结束不再用 out.usage 补记账本（只保留 sessionUsage）', async () => {
  const src = await readFile(path.join(ROOT, 'desktop/src/main/ipc/ipc-agent.mjs'), 'utf8');
  const idx = src.indexOf('const usageRec = extractUsage(out.usage)');
  assert.ok(idx > 0, '仍有 sessionUsage 收尾块');
  const tail = src.slice(idx, idx + 800);
  assert.doesNotMatch(tail, /appendUsage/, '回合结束的 out.usage 块不能再写账本（会与按请求记账重复）');
  assert.match(tail, /state\.sessionUsage\.set\(sessionId, rec\)/, 'Context 指示器的「最后一次请求」语义保留');
  assert.doesNotMatch(src, /subagentUsageLog/, '子代理用量不再攒到回合结束后批量补记');
  // 主回合与子代理都注入按请求回调
  const onUsageHooks = src.match(/onUsage: \(u\) => \{\s*\n\s*void appendUsage\(/g) || [];
  assert.equal(onUsageHooks.length, 2, '主 agent 与子代理各注入一个 onUsage → appendUsage');
});
