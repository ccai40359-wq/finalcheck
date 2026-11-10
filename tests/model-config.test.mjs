// 每模型上下文窗口 / 长上下文预算解析（model-config.mjs）单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeModelEntry, resolveModel, effectiveWindow, effectiveMaxOutputTokens, crossTurnBudgetTokens,
  DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS
} from '../desktop/src/main/model-config.mjs';

const provider = { id: 'p1', name: 'P1', contextWindow: 200000, maxOutputTokens: 32000, vision: true };

test('model-config: 字符串条目按 provider 窗口/输出解释且标记 legacy', () => {
  const m = normalizeModelEntry('  deepseek-v4  ', provider);
  assert.deepEqual(m, {
    id: 'deepseek-v4',
    contextWindow: 200000,
    maxOutputTokens: 32000,
    vision: true,
    legacy: true
  });
});

test('model-config: 字符串条目在 provider 缺字段时窗口/输出为 undefined（消费方回落默认）', () => {
  const m = normalizeModelEntry('m', {});
  assert.equal(m.contextWindow, undefined);
  assert.equal(m.maxOutputTokens, undefined);
  assert.equal(m.vision, false);
  assert.equal(m.legacy, true);
});

test('model-config: 对象条目自带字段优先于 provider', () => {
  const m = normalizeModelEntry({ id: 'big', contextWindow: 1000000, maxOutputTokens: 64000, vision: false }, provider);
  assert.equal(m.id, 'big');
  assert.equal(m.contextWindow, 1000000);
  assert.equal(m.maxOutputTokens, 64000);
  assert.equal(m.vision, false); // 显式 false 覆盖 provider true
  assert.equal(m.legacy, false);
});

test('model-config: 对象缺字段回落 provider；非法值视为缺字段', () => {
  const missing = normalizeModelEntry({ id: 'x' }, provider);
  assert.equal(missing.contextWindow, 200000);
  assert.equal(missing.maxOutputTokens, 32000);
  assert.equal(missing.vision, true);

  for (const bad of [0, -1, 'abc', null, Infinity, NaN]) {
    const m = normalizeModelEntry({ id: 'x', contextWindow: bad, maxOutputTokens: bad }, provider);
    assert.equal(m.contextWindow, 200000, `contextWindow=${String(bad)} 应回落到 provider`);
    assert.equal(m.maxOutputTokens, 32000, `maxOutputTokens=${String(bad)} 应回落到 provider`);
  }
});

test('model-config: 非字符串/对象条目归一为无效 id', () => {
  const m = normalizeModelEntry(42, provider);
  assert.equal(m.id, '');
  assert.equal(m.legacy, false);
});

test('model-config: resolveModel 命中指定模型', () => {
  const p = { models: ['a', { id: 'b', contextWindow: 400000 }], contextWindow: 128000 };
  const hit = resolveModel(p, 'b');
  assert.equal(hit.id, 'b');
  assert.equal(hit.contextWindow, 400000);
  assert.equal(hit.legacy, false);
});

test('model-config: resolveModel 未命中回退第一个（含对象形状）', () => {
  const p = { models: [{ id: 'a', contextWindow: 500000 }, 'b'] };
  const fallback = resolveModel(p, 'nope');
  assert.equal(fallback.id, 'a');
  assert.equal(fallback.contextWindow, 500000);
  assert.equal(resolveModel(p, '').id, 'a');
});

test('model-config: resolveModel 空 models / 全非法返回 null', () => {
  assert.equal(resolveModel({ models: [] }, 'x'), null);
  assert.equal(resolveModel({}, 'x'), null);
  assert.equal(resolveModel(null, 'x'), null);
  assert.equal(resolveModel({ models: [{ id: '' }, 3, null] }, 'x'), null);
});

test('model-config: effectiveWindow 优先级 model > provider > 1M', () => {
  assert.equal(effectiveWindow({ contextWindow: 400000 }, provider), 400000);
  assert.equal(effectiveWindow({}, provider), 200000);
  assert.equal(effectiveWindow({}, { contextWindow: 'abc' }), DEFAULT_CONTEXT_WINDOW);
  assert.equal(effectiveWindow(null, null), DEFAULT_CONTEXT_WINDOW);
});

test('model-config: effectiveMaxOutputTokens 优先级 model > provider > 32k', () => {
  assert.equal(effectiveMaxOutputTokens({ maxOutputTokens: 64000 }, provider), 64000);
  assert.equal(effectiveMaxOutputTokens({}, provider), 32000);
  assert.equal(effectiveMaxOutputTokens({}, {}), DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(effectiveMaxOutputTokens(null, null), DEFAULT_MAX_OUTPUT_TOKENS);
});

test('model-config: crossTurnBudgetTokens 1M 窗口封顶 400k', () => {
  assert.equal(crossTurnBudgetTokens(1000000, 32000), 400000);
  assert.equal(crossTurnBudgetTokens(1000000, 21000), 400000);
});

test('model-config: crossTurnBudgetTokens 200k 窗口约 107k', () => {
  assert.equal(crossTurnBudgetTokens(200000, 32000), Math.floor(0.6 * (200000 - 21000))); // 107400
});

test('model-config: crossTurnBudgetTokens 最小 30k、输出预留封顶 21k 且取整', () => {
  assert.equal(crossTurnBudgetTokens(60000, 32000), 30000); // 0.6*(60000-21000)=23400 → 30k
  assert.equal(crossTurnBudgetTokens(1000000, 500000), 400000); // 只扣 21k
  assert.ok(Number.isInteger(crossTurnBudgetTokens(250000, 12000))); // 0.6*238000=142800
  assert.equal(crossTurnBudgetTokens(250000, 12000), 142800);
});

test('model-config: crossTurnBudgetTokens 非法入参回落默认窗口/输出', () => {
  assert.equal(crossTurnBudgetTokens(undefined, undefined), 400000); // 1M/32k
  assert.equal(crossTurnBudgetTokens(-5, -5), 400000); // 回落到 1M + 32k
});
