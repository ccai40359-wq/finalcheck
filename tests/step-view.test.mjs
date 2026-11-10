// 门禁/汇总节点不该去轮询子代理 transcript：判定要认得出 DSL 与旧卡片两种字段形状
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProgramStep } from '../desktop/src/renderer/lib/step-view.mjs';

test('step-view: DSL 快照的 op=gate / aggregate 认定是程序节点', () => {
  assert.equal(isProgramStep({ id: 'g', op: 'gate' }), true);
  assert.equal(isProgramStep({ id: 'a', op: 'aggregate' }), true);
});

test('step-view: 旧字段 opType / kind / role 也认', () => {
  assert.equal(isProgramStep({ opType: 'gate' }), true);
  assert.equal(isProgramStep({ kind: 'gate' }), true);
  assert.equal(isProgramStep({ role: '程序检查' }), true);
});

test('step-view: 普通子代理步骤不是程序节点', () => {
  assert.equal(isProgramStep({ id: 'f1', op: 'step', kind: 'find', role: '代码安全审查员' }), false);
  assert.equal(isProgramStep({ id: 'r', op: 'report', role: '汇总' }), false);
  assert.equal(isProgramStep(null), false);
  assert.equal(isProgramStep({}), false);
});
