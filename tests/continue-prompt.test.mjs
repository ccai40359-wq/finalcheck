// 「继续」按钮要把上一轮工作流的证据带进新回合（会话重建不会带 tool trace）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContinueText } from '../desktop/src/renderer/lib/continue-prompt.mjs';

const runResult = {
  goal: '对 X 做 L3 验收',
  results: [
    { id: 'g1', name: 'L3 硬闸', ok: true, ms: 21000, tools: 0, content: 'verdict=待授权' },
    { id: 'r1', name: '审查 src/auth.mjs', ok: true, ms: 1331000, tools: 68, content: '3 条高危' },
    { id: 'rp', name: 'L3 汇总', kind: 'report', ok: true, ms: 765000, tools: 64, content: '## 汇总\n- H1 src/settings.mjs:409 明文 Key\n- Q1 未跑' }
  ]
};

test('continue-prompt: 有 run_workflow 结果 → 带目标/节点账/汇总正文', () => {
  const msg = { trace: [{ tool: 'run_workflow', result: runResult }] };
  const t = buildContinueText(msg);
  assert.match(t, /对 X 做 L3 验收/);
  assert.match(t, /L3 硬闸：成功，21s，0 次工具/);
  assert.match(t, /审查 src\/auth\.mjs：成功，1331s，68 次工具/);
  assert.match(t, /src\/settings\.mjs:409/);
  assert.match(t, /不要再调用任何工具/);
});

test('continue-prompt: 失败节点带 errorCode', () => {
  const msg = { trace: [{ tool: 'run_workflow', result: { goal: 'g', results: [{ id: 'r1', name: '审查 a.mjs', ok: false, errorCode: 'HTTP 429', ms: 5000, tools: 3 }] } }] };
  const t = buildContinueText(msg);
  assert.match(t, /审查 a\.mjs：失败（HTTP 429）/i);
});

test('continue-prompt: 没有工作流结果/结果是错误 → 回落到普通继续指令', () => {
  assert.match(buildContinueText({ trace: [] }), /不要重复已经跑过的步骤/);
  assert.match(buildContinueText({ trace: [{ tool: 'run_workflow', result: { error: 'boom' } }] }), /不要重复已经跑过的步骤/);
  assert.match(buildContinueText(null), /不要重复已经跑过的步骤/);
});
