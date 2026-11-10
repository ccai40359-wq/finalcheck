// 工作流表示方式（DAG / 受限脚本）的结论字段：新增的 mode / modeReason 是加法，
// 用 fake callStep 直接跑引擎，不接触真实模型与网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../desktop/src/main/workflow.mjs';

test('workflow/mode: DAG 结果带 mode=dag 与步骤数/层数的人话', async () => {
  const out = await runWorkflow({
    goal: '写点东西',
    steps: [
      { id: 'a', name: '起草', prompt: '写一段介绍文字' },
      { id: 'b', name: '翻译', prompt: '把一段话译成英文' },
      { id: 'c', name: '整理', prompt: '把内容整理成清单', depends_on: ['a'] },
    ],
    callStep: async ({ id }) => ({ content: `content-${id}` }),
  });
  assert.equal(out.error, undefined);
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'dag');
  assert.match(out.modeReason, /3 个步骤/);
  assert.match(out.modeReason, /2 层/);
  assert.deepEqual(out.steps.map((s) => s.id), ['a', 'b', 'c']);
});

test('workflow/mode: script 结果带 mode=script 与 fanout/loop 描述', async () => {
  const script = [
    { op: 'fanout', id: 'fa', over: ['x', 'y', 'z'], as: 'item', step: { name: '处理', prompt: '处理 ${item}' } },
    { op: 'loop', id: 'lp', maxRounds: 3, until: { ref: 's', test: { notEmpty: true } }, body: [{ op: 'step', id: 's', name: '继续', prompt: '继续完善' }] },
  ];
  const out = await runWorkflow({
    goal: '逐个处理并循环收敛',
    script,
    callStep: async ({ id }) => ({ content: `ok-${id}`, toolCount: 1 }),
  });
  assert.equal(out.error, undefined);
  assert.equal(out.mode, 'script');
  assert.equal(out.script, true);
  assert.match(out.modeReason, /按 3 项扇出/);
  assert.match(out.modeReason, /最多 3 轮循环/);
  assert.deepEqual(out.results.filter((r) => r.id.startsWith('fa#')).map((r) => r.id), ['fa#0', 'fa#1', 'fa#2']);
});
