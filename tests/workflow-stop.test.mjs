// 「停止工作流」必须能打断正在跑的子代理（不只是置位、等它自己跑完）。
// 这是实测踩到的 bug：DSL 模式点停止后，report 节点继续跑了 10+ 分钟（ctl.aborted 只置位，
// 没有接到 runAbort 的信号上）。现在 workflow.mjs 用一个 200ms 轮询把信号接到 runAbort。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../desktop/src/main/workflow.mjs';

function hangingStep() {
  const seen = { aborted: false };
  const step = async ({ signal }) => {
    await new Promise((resolve) => {
      if (signal?.aborted) { seen.aborted = true; resolve(); return; }
      signal?.addEventListener('abort', () => { seen.aborted = true; resolve(); }, { once: true });
      setTimeout(resolve, 8000); // 兜底，避免测试挂死
    });
    return { content: '', toolCount: 0 };
  };
  return { step, seen };
}

test('stop: DSL 模式 ctl.aborted → 在跑的子代理收到 abort，工作流立刻停', async () => {
  const { step, seen } = hangingStep();
  const ctl = { paused: false, aborted: false, maxConcurrency: 2 };
  setTimeout(() => { ctl.aborted = true; }, 200);
  const t0 = Date.now();
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'step', id: 's1', role: '汇总员', prompt: '汇总' }],
    callStep: step,
    control: ctl
  });
  const ms = Date.now() - t0;
  assert.equal(out.stopped, true);
  assert.equal(seen.aborted, true, '子代理必须收到 abort 信号');
  assert.ok(ms < 3000, `应当立刻停（实际 ${ms}ms）`);
});

test('stop: DAG(steps) 模式同样能打断在跑的步骤', async () => {
  const { step, seen } = hangingStep();
  const ctl = { paused: false, aborted: false, maxConcurrency: 2 };
  setTimeout(() => { ctl.aborted = true; }, 200);
  const t0 = Date.now();
  const out = await runWorkflow({
    goal: 'g',
    steps: [{ id: 's1', name: '汇总', role: '汇总员', prompt: '汇总', depends_on: [] }],
    callStep: step,
    control: ctl
  });
  const ms = Date.now() - t0;
  assert.equal(out.stopped, true);
  assert.equal(seen.aborted, true, '子代理必须收到 abort 信号');
  assert.ok(ms < 3000, `应当立刻停（实际 ${ms}ms）`);
});
