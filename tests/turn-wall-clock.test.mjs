// 0.29.2 回归：回合墙钟（显式 maxTurnMs）必须在「卡在单个网关请求里」时也生效。
// 基准实测教训：maxTurnMs 原来只在回合间隙检查，网关请求挂住/慢思考时 46-51 分钟都到不了检查点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';

const BASE = { baseUrl: 'http://127.0.0.1:9', apiKey: 'test-key', model: 'test-model' };

test('wall-clock: maxTurnMs caps a turn even when the gateway never responds', async () => {
  // 假网关必须像真 fetch 一样响应 signal：deadline 触发 ctl.abort() 后，请求要能被reject
  const hang = (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
  });
  const t0 = Date.now();
  const out = await runAgentTurn({
    config: BASE,
    messages: [{ role: 'user', content: 'hi' }],
    tools: {},
    toolsSchema: [],
    maxTurnMs: 300,
    fetchImpl: hang,
  });
  const elapsed = Date.now() - t0;
  assert.equal(out.deadlineHit, true, 'turn must be marked deadlineHit');
  assert.ok(elapsed < 5000, `turn must end near the deadline, took ${elapsed}ms`);
});

test('wall-clock: normal fast turns are unaffected (no deadlineHit)', async () => {
  const sse = (text) => new Response(
    `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  );
  const out = await runAgentTurn({
    config: BASE,
    messages: [{ role: 'user', content: 'hi' }],
    tools: {},
    toolsSchema: [],
    maxTurnMs: 30000,
    fetchImpl: () => Promise.resolve(sse('你好')),
  });
  assert.notEqual(out.deadlineHit, true);
  assert.ok((out.answer || '').includes('你好'));
});

test('wall-clock: deadline fires mid-stream and preserves partial content', async () => {
  const t0 = Date.now();
  const out = await runAgentTurn({
    config: BASE,
    messages: [{ role: 'user', content: 'hi' }],
    tools: {},
    toolsSchema: [],
    maxTurnMs: 400,
    // 慢思考场景：先流出一段正文，然后网关静默挂住（流体在 signal abort 时 error）
    fetchImpl: (url, init) => Promise.resolve(new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial-answer"}}]}\n\n'));
        init.signal.addEventListener('abort', () => c.error(new Error('aborted')), { once: true });
        // 之后不再产出任何字节
      }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })),
  });
  const elapsed = Date.now() - t0;
  assert.equal(out.deadlineHit, true, 'mid-stream deadline must be marked');
  assert.ok((out.partialContent || '').includes('partial-answer'), `partial content preserved, got ${JSON.stringify(out.partialContent)}`);
  assert.ok(elapsed < 5000, `turn must end near the deadline, took ${elapsed}ms`);
});
