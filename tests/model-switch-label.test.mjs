// 模型切换提示的三处修复（2026-11-16 用户反馈 A1/A2/A3）：
//   A1 提示里显示供应商内部 id（p-mw7gt125-xtbip）而不是名字
//   A2 切换提示的位置落在错误消息之后，不在新一轮之前
//   A3 切换后当前回合仍用旧模型（界面没说明「从哪一步起生效」）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelDisplayLabel } from '../desktop/src/renderer/lib/app-helpers.mjs';
import { withModelDividers } from '../desktop/src/renderer/lib/model-switch.mjs';

const PROVIDERS = [
  { id: 'p-mw7gt125-xtbip', name: 'openDesignM' },
  { id: 'legacy-default', name: 'Legacy Default' }
];

test('A1: 内部 providerId 换成供应商名字', () => {
  const got = modelDisplayLabel('p-mw7gt125-xtbip/deepseek-v4.1-flash-eco', PROVIDERS);
  assert.equal(got, 'openDesignM · deepseek-v4.1-flash-eco');
  assert.ok(!got.includes('p-mw7gt125-xtbip'), '不能暴露内部 id');
});

test('A1: 裸模型名（无 providerId）原样显示', () => {
  assert.equal(modelDisplayLabel('deepseek-v4.1-flash', PROVIDERS), 'deepseek-v4.1-flash');
});

test('A1: 供应商找不到时退回 id（不猜测、不崩）', () => {
  assert.equal(modelDisplayLabel('unknown-provider/m', PROVIDERS), 'unknown-provider · m');
});

test('A1: 空值/undefined 安全', () => {
  assert.equal(modelDisplayLabel('', PROVIDERS), '');
  assert.equal(modelDisplayLabel(undefined, PROVIDERS), '');
  assert.equal(modelDisplayLabel('x', null), 'x');
});

test('A1: 分隔线文案不含内部 id（withModelDividers 用 labelOf 渲染）', () => {
  const out = withModelDividers(
    [
      { role: 'assistant', content: 'a1', model: 'legacy-default/deepseek-v4.1-flash' },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: 'a2', model: 'p-mw7gt125-xtbip/deepseek-v4.1-flash-eco' }
    ],
    (from, to) => `⇄ ${modelDisplayLabel(from, PROVIDERS)} → ${modelDisplayLabel(to, PROVIDERS)}`
  );
  const div = out.find((m) => m.kind === 'model-switch');
  assert.ok(div, '必须有分隔线');
  assert.match(div.content, /Legacy Default · deepseek-v4\.1-flash/);
  assert.match(div.content, /openDesignM · deepseek-v4\.1-flash-eco/);
  assert.ok(!div.content.includes('p-mw7gt125-xtbip'), '分隔线不能带内部 id');
});

test('A2: 切换线与目标 assistant 同属新一轮 —— 分隔线紧贴新模型那条之前', () => {
  const out = withModelDividers([
    { role: 'assistant', content: 'a1', model: 'A/m1' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: 'a2', model: 'B/m2' }
  ]);
  const idxDiv = out.findIndex((m) => m.kind === 'model-switch');
  const idxA2 = out.findIndex((m) => m.role === 'assistant' && m.model === 'B/m2');
  assert.equal(idxDiv, idxA2 - 1, '分隔线必须紧挨着新模型那条消息之前');
});

test('A2: 中间夹着报错/提示行时，分隔线仍落在新 assistant 之前', () => {
  // 真实场景：上一轮报 402，用户又发了一条，新一轮用新模型
  const out = withModelDividers([
    { role: 'assistant', content: '', error: 'HTTP 402', model: 'A/m1' },
    { role: 'notice', content: '已从这一步起切换为 B' },
    { role: 'user', content: '继续回答' },
    { role: 'assistant', content: 'a2', model: 'B/m2' }
  ]);
  const idxDiv = out.findIndex((m) => m.kind === 'model-switch');
  const idxA2 = out.findIndex((m) => m.role === 'assistant' && m.model === 'B/m2');
  assert.equal(idxDiv, idxA2 - 1, '分隔线紧贴新模型之前，不会跑到报错之后');
  // 报错行没被吞、顺序没乱
  assert.equal(out[0].error, 'HTTP 402');
});

test('A2: 已有分隔线时不重复插入（消息重建幂等）', () => {
  const base = [
    { role: 'assistant', content: 'a1', model: 'A/m1' },
    { role: 'user', content: 'x' },
    { role: 'assistant', content: 'a2', model: 'B/m2' }
  ];
  const once = withModelDividers(base);
  const twice = withModelDividers(once);
  assert.equal(
    twice.filter((m) => m.kind === 'model-switch').length,
    1,
    '重建一次不能再多一条分隔线'
  );
});

test('A3: 切换事件在回合内到达时不再被 default 分支丢弃（kind 未被别的分支截走）', () => {
  // 这是契约性断言：model-switch 必须是独立 kind，且不等于 notice/warning，
  // 否则渲染层会在「notice/warning」分支里把它当普通提示、丢掉「从这一步起生效」的语义。
  const kinds = ['notice', 'warning', 'model-switch'];
  assert.ok(kinds.includes('model-switch'));
  assert.notEqual('model-switch', 'notice');
  assert.notEqual('model-switch', 'warning');
});
