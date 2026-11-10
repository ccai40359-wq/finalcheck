// 静默看门狗回归：只判「连续 N 秒零字节」，不是工作时长上限。
//  - 网关一个字节都不回 → 按 attempt 超时、重试，最终给人话错误，且测试不能挂住
//  - 每 100ms 有字节但总时长超过 N 秒 → 正常完成，证明「有字节就不算静默」
//  - 错误码映射：静默 → STALL；label 为人话
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentTurn, runSubagentTurn } from '../desktop/src/main/agent-service.mjs';
import { deriveNodeErrorCode, errorCodeLabel } from '../desktop/src/main/swarm.mjs';

const cfg = (extra = {}) => ({ baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm', ...extra });

const abortError = () => new DOMException('Aborted', 'AbortError');

/** 永不 enqueue 的 SSE 流；signal abort 时像真实 fetch 一样让读取 reject（否则测试会挂住） */
function silentSseResponse(signal) {
  const stream = new ReadableStream({
    start(controller) {
      const onAbort = () => {
        try { controller.error(abortError()); } catch { /* 已关闭/已出错 */ }
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 每 gapMs 吐一个 SSE 分片的慢流；signal abort 时中断读取 */
function slowSseResponse(chunks, gapMs, signal) {
  const encoder = new TextEncoder();
  let timer = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer); timer = null;
  };
  const stream = new ReadableStream({
    start(controller) {
      let i = 0;
      const push = () => {
        if (stopped) return;
        if (i >= chunks.length) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunks[i]) + '\n\n'));
        i += 1;
        timer = setTimeout(push, gapMs);
      };
      timer = setTimeout(push, gapMs);
      const onAbort = () => {
        stop();
        try { controller.error(abortError()); } catch { /* 已关闭/已出错 */ }
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    },
    cancel() { stop(); }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('silence: 网关零字节 → 按 attempt 超时重试，5 次后失败且不挂死', async () => {
  let calls = 0;
  const events = [];
  const fetchImpl = async (_url, opts) => {
    calls += 1;
    return silentSseResponse(opts?.signal);
  };
  const t0 = Date.now();
  const out = await runAgentTurn({
    config: cfg({ silenceTimeoutMs: 150 }),
    messages: [],
    tools: {},
    fetchImpl,
    retryBaseMs: 10, // 测试专用：生产退避仍是 600ms 指数
    onEvent: (ev) => events.push(ev)
  });
  const elapsed = Date.now() - t0;
  assert.equal(calls, 5, '应沿用 MAX_ATTEMPTS=5 次尝试');
  assert.match(out.error, /静默/, '错误文案要说清「静默」');
  assert.match(out.error, /已重试 5 次/);
  assert.doesNotMatch(out.error, /at .*agent-service\.mjs|stack/i, '错误文案不带栈');
  assert.ok(elapsed < 5000, `静默失败应在 5s 内结束，实际 ${elapsed}ms`);
  const retries = events.filter((e) => e.kind === 'retry');
  assert.equal(retries.length, 4, '4 次重试事件（第 5 次尝试后放弃）');
  assert.match(retries[0].reason, /静默/);
  assert.equal(events.filter((e) => e.kind === 'activity' && /等待网关响应/.test(e.label || '')).length, 5);
});

test('silence: 每 100ms 有字节的 1.2s 慢流 → 不被中止，正常完成', async () => {
  const chunks = Array.from({ length: 12 }, () => ({ choices: [{ delta: { content: 'x' } }] }));
  let calls = 0;
  const events = [];
  const fetchImpl = async (_url, opts) => {
    calls += 1;
    return slowSseResponse(chunks, 100, opts?.signal);
  };
  const t0 = Date.now();
  const out = await runAgentTurn({
    config: cfg({ silenceTimeoutMs: 300 }),
    messages: [],
    tools: {},
    fetchImpl,
    onEvent: (ev) => events.push(ev)
  });
  const elapsed = Date.now() - t0;
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  assert.equal(out.answer, 'x'.repeat(12), '全部增量都要收到');
  assert.equal(calls, 1, '有字节流动就不该重试');
  assert.equal(events.filter((e) => e.kind === 'retry').length, 0);
  assert.ok(elapsed >= 1000, `慢流应真实跑满约 1.2s（证明不是按总时长杀），实际 ${elapsed}ms`);
});

test('silence: 子代理 noLimits 同样启用静默看门狗', async () => {
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    calls += 1;
    return silentSseResponse(opts?.signal);
  };
  const t0 = Date.now();
  const out = await runSubagentTurn({
    config: cfg({ silenceTimeoutMs: 120 }),
    systemPrompt: '你是子代理',
    prompt: '查一下 D:/x',
    tools: {},
    toolsSchema: [],
    requiresTools: false,
    forceFirstToolChoice: false,
    fetchImpl,
    retryBaseMs: 10,
    onTranscript: () => {}
  });
  const elapsed = Date.now() - t0;
  assert.equal(calls, 5);
  assert.match(String(out.error || ''), /静默|网关无响应/);
  assert.ok(elapsed < 5000, `子代理静默失败也应快速结束，实际 ${elapsed}ms`);
});

test('silence: deriveNodeErrorCode/errorCodeLabel 把静默映射成 STALL', () => {
  assert.equal(deriveNodeErrorCode({ errorText: '网关静默 180s 无任何响应（已重试 5 次）' }), 'STALL');
  assert.equal(deriveNodeErrorCode({ errorText: '网关静默 180s 无任何响应（HTTP 504）', program: true }), 'HTTP 504', '更具体的 HTTP 码优先');
  assert.equal(errorCodeLabel('STALL'), '网关无响应（静默超时）');
  assert.equal(errorCodeLabel('HTTP 504'), '网关超时', '已有映射不回归');
});
