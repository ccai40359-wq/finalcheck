// 模型切换分隔线回归：切厂商/切模型要像 ZCode 那样在消息流里显示出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withModelDividers } from '../desktop/src/renderer/lib/model-switch.mjs';

const A = 'legacy-default/deepseek-v4.1-flash';
const B = 'new-provider-6/deepseek-v4.1-flash-eco';

test('model-switch: 相邻 assistant 模型变化 → 插一条 notice 分隔线', () => {
  const out = withModelDividers([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'a1', model: A },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: 'a2', model: B }
  ]);
  assert.equal(out.length, 5, '原 4 条 + 1 条分隔线');
  const div = out.find((m) => m.kind === 'model-switch');
  assert.ok(div, '必须有 model-switch 行');
  assert.equal(div.role, 'notice');
  assert.match(div.content, /deepseek-v4\.1-flash →/);
  // 分隔线位置：在第二条 assistant 之前
  assert.equal(out.indexOf(div), 3);
});

test('model-switch: 模型没变 → 不插线', () => {
  const out = withModelDividers([
    { role: 'assistant', content: 'a1', model: A },
    { role: 'assistant', content: 'a2', model: A }
  ]);
  assert.equal(out.length, 2);
  assert.ok(!out.some((m) => m.kind === 'model-switch'));
});

test('model-switch: 旧历史没有 model 字段 → 不误报切换（首个带 model 的消息只做基准）', () => {
  const out = withModelDividers([
    { role: 'assistant', content: 'old1' }, // 无 model
    { role: 'assistant', content: 'old2', model: A }, // 第一个带 model：只是基准
    { role: 'assistant', content: 'a3', model: B } // 切换
  ]);
  assert.equal(out.filter((m) => m.kind === 'model-switch').length, 1);
});

test('model-switch: 同一厂商换模型也算切换（providerId 相同、model 不同）', () => {
  const out = withModelDividers([
    { role: 'assistant', content: 'a1', model: 'new-provider-6/deepseek-v4.1-flash' },
    { role: 'assistant', content: 'a2', model: 'new-provider-6/deepseek-v4.1-flash-eco' }
  ]);
  assert.equal(out.filter((m) => m.kind === 'model-switch').length, 1);
});

test('model-switch: 非数组/空列表安全返回', () => {
  assert.deepEqual(withModelDividers([]), []);
  assert.equal(withModelDividers(null), null);
});
