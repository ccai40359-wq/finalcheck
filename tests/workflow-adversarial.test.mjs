// 强制对抗复核（红队）回归：用 fake callStep，不烧真实 key、不碰网络。
// 覆盖：DAG 自动补验 / script 自动补验 / 只有 gate+report 不补 / 复核失败 fail-closed / confirmed 缺 verifier 降级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAdversarialGate, runWorkflow } from '../desktop/src/main/workflow.mjs';

const reportText = '## Conclusion\n最终报告：已汇总上游结果。\n## Findings\n- 见 claim\n## Verified\n- 独立复现\n## Not covered\nNone\n## Skipped\nNone\n';

const findContent = (id, extra = {}) => JSON.stringify({
  findings: [{
    id,
    claim: `claim-${id}`,
    evidence: `node repro-${id}.mjs -> hit`,
    severity: 'high',
    file: 'a.mjs',
    line: 10,
    reproduced: true,
    ...extra,
  }],
});

test('对抗复核：DAG 三个 find 无 verify → 自动插入 __verify__（盲验，依赖全部 find）', async () => {
  const calls = [];
  const out = await runWorkflow({
    goal: '审查输入校验',
    steps: [
      { id: 'f1', name: '取证1', kind: 'find', prompt: '逐条取证 A' },
      { id: 'f2', name: '取证2', kind: 'find', prompt: '逐条取证 B' },
      { id: 'f3', name: '取证3', kind: 'find', prompt: '逐条取证 C' },
    ],
    callStep: async (ctx) => {
      calls.push(ctx);
      if (ctx.kind === 'find') return { content: findContent(ctx.id), toolCount: 1 };
      if (ctx.kind === 'verify') {
        return {
          content: JSON.stringify({
            verdicts: ['f1', 'f2', 'f3'].map((claimId) => ({
              claimId,
              verdict: 'confirmed',
              evidence: `亲自复现 ${claimId}`,
            })),
          }),
          toolCount: 1,
          model: 'red-team-1',
        };
      }
      return { content: 'ok', toolCount: 1 };
    },
  });

  assert.equal(out.error, undefined);
  assert.equal(calls.length, 4, '3 个 find + 1 个自动 verify');
  const auto = calls.at(-1);
  assert.equal(auto.id, '__verify__');
  assert.equal(auto.kind, 'verify');
  assert.equal(auto.blind, true, '自动补验必须盲验');
  assert.deepEqual(auto.depends_on.slice().sort(), ['f1', 'f2', 'f3']);
  assert.match(auto.prompt, /默认怀疑/);
  assert.match(auto.prompt, /复现不了.*rejected 或 uncertain/);
  const row = out.results.find((r) => r.id === '__verify__');
  assert.equal(row.autoInserted, true);
  assert.equal(out.steps.find((s) => s.id === '__verify__').autoInserted, true);
  assert.ok(out.claims.every((c) => c.status === 'confirmed'), '有有效 verdict 时 confirmed 保留');
});

test('对抗复核：script 有 fanout 无 verify → 自动插入 verify，from 指向 fanout 节点', async () => {
  const calls = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [{
      op: 'fanout', id: 'fa', as: 'file', over: ['a.js', 'b.js'],
      step: { role: '审查员', prompt: '检查 ${file}' },
    }],
    callStep: async (ctx) => {
      calls.push(ctx);
      if (ctx.id === 'fa#0') return { content: findContent('c1'), toolCount: 1 };
      if (ctx.id === 'fa#1') return { content: findContent('c2'), toolCount: 1 };
      if (ctx.kind === 'verify') {
        return {
          content: JSON.stringify({
            verdicts: [
              { claimId: 'c1', verdict: 'confirmed', evidence: '亲自复现 c1' },
              { claimId: 'c2', verdict: 'confirmed', evidence: '亲自复现 c2' },
            ],
          }),
          toolCount: 1,
        };
      }
      return { content: 'ok', toolCount: 1 };
    },
  });

  assert.equal(out.error, undefined);
  const verifyCalls = calls.filter((c) => c.kind === 'verify');
  assert.equal(verifyCalls.length, 1, '必须自动补一个 verify');
  assert.equal(verifyCalls[0].blind, true);
  assert.deepEqual(verifyCalls[0].depends_on.slice().sort(), ['fa#0', 'fa#1'], '运行时 from 展开到 fanout 子节点');
  const step = out.steps.find((s) => s.id === '__verify__');
  assert.ok(step, '自动补验节点必须出现在 steps 里');
  assert.equal(step.autoInserted, true);
  assert.deepEqual(step.depends_on, ['fa'], '声明的 from 指向 fanout 节点');
  assert.deepEqual(step.from, ['fa']);
  assert.ok(out.results.some((r) => r.id === '__verify__' && r.autoInserted === true));
  assert.ok(out.phases.some((p) => p.includes('__verify__')), '补验阶段要进入阶段轨道');
  assert.ok(out.claims.every((c) => c.status === 'confirmed'));
});

test('对抗复核：只有 gate + report 的脚本不插入 verify', async () => {
  const calls = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'gate', id: 'g', tool: 'audit_project', args: {} },
      { op: 'report', id: 'rep', from: 'g', ask: '汇总' },
    ],
    runGate: async () => ({ verdict: 'pass', text: '程序闸通过 ' + 'x'.repeat(100) }),
    callStep: async (ctx) => {
      calls.push(ctx);
      return { content: reportText, toolCount: 0 };
    },
  });

  assert.equal(out.error, undefined);
  assert.equal(calls.length, 1, '只应调用 report');
  assert.ok(!out.steps.some((s) => s.id === '__verify__'), 'gate 已是确定性证据，不补 LLM 复核');
  assert.ok(!out.results.some((r) => r.kind === 'verify'));
});

test('对抗复核：verify 失败/空 verdict → claim 不得 confirmed，warnings 含「对抗复核未完成」，报告带未复核脚注', async () => {
  const reportPrompts = [];
  const out = await runWorkflow({
    goal: 'g',
    steps: [
      { id: 'f', kind: 'find', prompt: '逐条取证' },
      { id: 'rep', kind: 'report', prompt: '汇总五段' },
    ],
    callStep: async (ctx) => {
      if (ctx.kind === 'find') return { content: findContent('c1'), toolCount: 1 };
      if (ctx.kind === 'verify') return { error: '复核节点挂了' };
      if (ctx.kind === 'report') {
        reportPrompts.push(ctx.prompt);
        return { content: reportText, toolCount: 0 };
      }
      return { content: 'ok', toolCount: 1 };
    },
  });

  assert.ok(out.results.some((r) => r.id === '__verify__' && r.ok === false));
  assert.ok(out.claims.every((c) => c.status !== 'confirmed'), '复核失败时任何 claim 都不得 confirmed');
  assert.ok((out.warnings || []).some((w) => w.includes('对抗复核未完成')), '必须给出对抗复核未完成 warning');
  const rep = out.results.find((r) => r.id === 'rep');
  assert.match(rep.content, /未经对抗复核/, '报告正文必须出现未复核字样');
  assert.match(reportPrompts[0], /带复核者/, 'report prompt 必须带「只有带 verifier 的 claim 才能写已确认」硬规则');
});

test('对抗复核：confirmed 但没有 verifier（model/stepId）→ 直接降级为 lead 并告警', () => {
  const { claims, warnings } = applyAdversarialGate({
    claims: [{
      id: 'c1',
      claim: '未复核结论',
      evidence: 'e',
      status: 'confirmed',
      verifiedBy: null,
      verdicts: [{ verdict: 'confirmed', evidence: '自称确认' }],
    }],
    results: [],
    verifySteps: [],
  });
  assert.equal(claims[0].status, 'lead');
  assert.ok(claims[0].gate.includes('missing-verifier'));
  assert.ok(warnings.some((w) => /缺少复核者/.test(w)));
});

test('对抗复核：有 verifier 的 confirmed 不被误降级', () => {
  const { claims, warnings } = applyAdversarialGate({
    claims: [{
      id: 'c1',
      status: 'confirmed',
      verifiedBy: { model: 'red-team-1', stepId: 'v1' },
      verdicts: [{ verdict: 'confirmed', model: 'red-team-1', stepId: 'v1', evidence: '亲自复现' }],
    }],
    results: [{ kind: 'verify', ok: true, verdicts: [{ claimId: 'c1', verdict: 'confirmed' }] }],
    verifySteps: [{ kind: 'verify' }],
  });
  assert.equal(claims[0].status, 'confirmed');
  assert.deepEqual(warnings, []);
});
