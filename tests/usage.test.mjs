import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage, cacheHitOf } from '../desktop/src/main/usage.mjs';

test('usage: OpenAI 明细字段（prompt_tokens_details.cached_tokens）', () => {
  const u = extractUsage({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } });
  assert.equal(u.prompt, 1000);
  assert.equal(u.completion, 20);
  assert.equal(u.cached, 900);
  assert.equal(u.cacheRead, null);
  assert.equal(cacheHitOf(u), 90);
});

test('usage: OpenAI Responses 形状（input_tokens_details.cached_tokens）', () => {
  const u = extractUsage({ input_tokens: 500, output_tokens: 10, input_tokens_details: { cached_tokens: 400 } });
  assert.equal(u.prompt, 500);
  assert.equal(u.completion, 10);
  assert.equal(u.cached, 400);
  assert.equal(cacheHitOf(u), 80);
});

test('usage: DeepSeek 形状（prompt_cache_hit_tokens）', () => {
  const u = extractUsage({ prompt_tokens: 800, completion_tokens: 8, prompt_cache_hit_tokens: 600 });
  assert.equal(u.prompt, 800);
  assert.equal(u.cached, 600);
  assert.equal(cacheHitOf(u), 75);
});

test('usage: Anthropic 形状（cache_read_input_tokens）', () => {
  const u = extractUsage({ input_tokens: 1000, output_tokens: 12, cache_read_input_tokens: 750 });
  assert.equal(u.prompt, 1000);
  assert.equal(u.completion, 12);
  assert.equal(u.cached, 750);
  assert.equal(u.cacheRead, 750);
  assert.equal(cacheHitOf(u), 75);
});

test('usage: 顶层 cached_tokens', () => {
  const u = extractUsage({ prompt_tokens: 400, completion_tokens: 4, cached_tokens: 300 });
  assert.equal(u.cached, 300);
  assert.equal(cacheHitOf(u), 75);
});

test('usage: 顶层 cache_read_tokens', () => {
  const u = extractUsage({ prompt_tokens: 400, completion_tokens: 4, cache_read_tokens: 200 });
  assert.equal(u.cached, 200);
  assert.equal(u.cacheRead, 200);
  assert.equal(cacheHitOf(u), 50);
});

test('usage: 字段优先级——明细 > DeepSeek 命中 > 顶层', () => {
  const u = extractUsage({
    prompt_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 900 },
    prompt_cache_hit_tokens: 500,
    cached_tokens: 100
  });
  assert.equal(u.cached, 900);
});

test('usage: 网关没返回缓存字段时 cached 为 null（不是 0）', () => {
  const u = extractUsage({ prompt_tokens: 500, completion_tokens: 10 });
  assert.equal(u.prompt, 500);
  assert.equal(u.completion, 10);
  assert.equal(u.cached, null);
  assert.equal(cacheHitOf(u), null);
});

test('usage: 无 usage / 空对象 / 非对象返回 null', () => {
  assert.equal(extractUsage(null), null);
  assert.equal(extractUsage(undefined), null);
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage('nope'), null);
});

test('usage: cacheHitOf 三种情况（有缓存 / 缺字段 / prompt=0）', () => {
  assert.equal(cacheHitOf({ prompt: 200, cached: 50 }), 25);
  assert.equal(cacheHitOf({ prompt: 200, cached: null }), null);
  assert.equal(cacheHitOf({ prompt: 0, cached: 50 }), null);
  assert.equal(cacheHitOf(null), null);
});
