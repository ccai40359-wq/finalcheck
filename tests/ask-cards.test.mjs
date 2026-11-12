// ask 卡去重：同一个 callId 只能有一张（实时卡 vs 历史 trace 还原卡）。
// 策略断言：终态历史卡优先；运行中的实时卡优先（配合 hideAskTracesForCards 摘掉历史条目）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterAskCardsByTrace, hideAskTracesForCards, isSettledAskTrace
} from '../desktop/src/renderer/lib/ask-cards.mjs';

const live = (callId, extra = {}) => ({ callId, sessionId: 's1', status: 'pending', question: '继续吗？', ...extra });
const history = (callId, status = 'ok', extra = {}) => ({
  tool: 'ask_user', callId, status,
  args: JSON.stringify({ question: '继续吗？', options: [{ label: '是' }] }),
  result: status === 'ok' ? { answer: '是' } : null,
  error: null,
  ...extra
});
const askTraces = (messages) => (messages || []).flatMap((m) => (m.trace || []).filter((t) => t.tool === 'ask_user'));

test('ask-cards: 已答的历史 trace → 实时卡被过滤（历史卡优先，同 callId 只留一张）', () => {
  const messages = [{ role: 'assistant', trace: [history('ask-1')] }];
  const out = filterAskCardsByTrace([live('ask-1', { status: 'answered', answer: '是' })], messages);
  assert.equal(out.length, 0, '实时卡应被藏掉');
  // 配合反向过滤：历史 trace 保留 → 最终只有一张历史卡
  const display = hideAskTracesForCards(messages, out);
  assert.equal(askTraces(display).length, 1);
  assert.equal(askTraces(display)[0].callId, 'ask-1');
});

test('ask-cards: 不同 callId 都保留（历史一张 + 实时一张）', () => {
  const messages = [{ role: 'assistant', trace: [history('ask-1')] }];
  const out = filterAskCardsByTrace([live('ask-1'), live('ask-2')], messages);
  assert.deepEqual(out.map((c) => c.callId), ['ask-2']);
  const display = hideAskTracesForCards(messages, out);
  // 最终卡片：历史 ask-1 + 实时 ask-2，各一张
  assert.deepEqual(askTraces(display).map((t) => t.callId), ['ask-1']);
  assert.deepEqual(out.map((c) => c.callId), ['ask-2']);
});

test('ask-cards: trace 仍是 running → 实时卡优先，历史条目被摘掉（提问保持可回答）', () => {
  const messages = [{ role: 'assistant', trace: [history('ask-1', 'running', { result: null })] }];
  const out = filterAskCardsByTrace([live('ask-1')], messages);
  assert.deepEqual(out.map((c) => c.callId), ['ask-1'], '运行中的实时卡不能藏');
  const display = hideAskTracesForCards(messages, out);
  assert.equal(askTraces(display).length, 0, '历史 running 条目必须摘掉，避免第二张卡');
});

test('ask-cards: 无 trace / 非终态都不影响实时卡', () => {
  assert.deepEqual(filterAskCardsByTrace([live('ask-1')], []).map((c) => c.callId), ['ask-1']);
  assert.deepEqual(filterAskCardsByTrace([live('ask-1')], [{ role: 'user', content: 'hi' }]).map((c) => c.callId), ['ask-1']);
  // legacy：没有 status 但有 answer → 已答（终态）
  const legacy = { tool: 'ask_user', callId: 'ask-1', args: '{}', result: { answer: '是' } };
  assert.equal(isSettledAskTrace(legacy), true);
  assert.equal(isSettledAskTrace({ tool: 'ask_user', callId: 'ask-1', args: '{}', result: null }), false);
  assert.equal(isSettledAskTrace({ tool: 'run_command', callId: 'x' }), false);
});

test('ask-cards: hideAskTracesForCards 不误删别的 trace、无变化时保持引用', () => {
  const messages = [{
    role: 'assistant',
    trace: [
      { tool: 'run_command', args: '{}', result: { ok: true } },
      history('ask-1', 'running', { result: null }),
      { tool: 'ask_user', callId: null, status: 'running', args: '{}', result: null }
    ]
  }];
  const display = hideAskTracesForCards(messages, [live('ask-1')]);
  assert.equal(display[0].trace.length, 2, '只摘掉 callId 匹配的 ask_user');
  assert.equal(display[0].trace[0].tool, 'run_command');
  assert.equal(display[0].trace[1].callId, null);
  const same = hideAskTracesForCards(messages, [live('ask-2')]);
  assert.equal(same, messages, '没有匹配项时返回原数组');
  assert.equal(hideAskTracesForCards(messages, []), messages);
});

test('ask-cards: callId 归一成字符串再比较（数字/字符串混用不重复）', () => {
  const messages = [{ role: 'assistant', trace: [history(42)] }];
  const out = filterAskCardsByTrace([live('42')], messages);
  assert.equal(out.length, 0);
  const display = hideAskTracesForCards([{ role: 'assistant', trace: [history('7', 'running', { result: null })] }], [live(7)]);
  assert.equal(askTraces(display).length, 0);
});
