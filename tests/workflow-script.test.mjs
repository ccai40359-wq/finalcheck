// 受限脚本 DSL（script 模式）回归：用 fake callStep / fake runGate，不碰真实模型与网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../desktop/src/main/workflow.mjs';
import { interpolateScriptText, matchScriptCondition } from '../desktop/src/main/workflow-script.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-script-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const okStep = (content = '结果', toolCount = 1) => async () => ({ content, toolCount });
const reportText = [
  '## Conclusion',
  '最终报告：已汇总上游结果，未覆盖范围见 Not covered。',
  '## Findings',
  '- 证据见上游步骤，未复核结论均按疑似标注。',
  '## Verified',
  '- 无独立复核者覆盖的 claim 不写「已确认」。',
  '## Not covered',
  'None',
  '## Skipped',
  'None',
  '',
].join('\n');

// ---------- step ----------

test('script/step: 正常执行，prompt 带总目标，phases 按顶层 op 分组', async () => {
  const calls = [];
  const out = await runWorkflow({
    goal: '检查登录模块',
    script: [{ op: 'step', id: 'a', name: '扫描', role: '审查员', prompt: '检查 A' }],
    callStep: async (ctx) => {
      calls.push(ctx);
      return { content: '扫描完成', toolCount: 1 };
    },
  });
  assert.equal(out.error, undefined);
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.filter((r) => r.id !== '__verify__').map((r) => r.id), ['a']);
  assert.equal(calls.length, 2, 'step + 自动补的对抗复核（上游有正文就必须跑）');
  assert.equal(calls[0].id, 'a');
  assert.match(calls[0].prompt, /总目标：检查登录模块/);
  assert.match(calls[0].prompt, /检查 A/);
  assert.deepEqual(out.phases[0], ['a']);
});

test('script/step: 0 工具 + 审查类角色 → 空转硬闸 failed', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'step', id: 'r', role: '审查员', prompt: '审查配置' }],
    callStep: async () => ({ content: '代码看起来没问题。', toolCount: 0 }),
  });
  const row = out.results.find((r) => r.id === 'r');
  assert.equal(row.ok, false);
  assert.match(row.error, /未产生任何工具调用/);
});

// ---------- fanout ----------

test('script/fanout: 3 项生成 3 个节点，${file} 正确替换，未知插值原样保留', async () => {
  const seen = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [{
      op: 'fanout', id: 'fa', as: 'file',
      over: ['a.js', 'b.js', 'c.js'],
      step: { role: '审查员', prompt: '检查 ${file}；保留 ${unknown}' },
    }],
    callStep: async (ctx) => {
      seen.push({ id: ctx.id, prompt: ctx.prompt });
      return { content: `done ${ctx.id}`, toolCount: 1 };
    },
  });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.results.filter((r) => r.id.startsWith('fa#')).map((r) => r.id), ['fa#0', 'fa#1', 'fa#2']);
  const prompts = seen.filter((s) => s.id.startsWith('fa#')).map((s) => s.prompt);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /检查 a\.js/);
  assert.match(prompts[1], /检查 b\.js/);
  assert.match(prompts[2], /检查 c\.js/);
  assert.ok(prompts.every((p) => p.includes('${unknown}')), '不支持的插值必须原样保留');
  assert.deepEqual(out.phases[0], ['fa#0', 'fa#1', 'fa#2']);
});

test('script/fanout: 51 项 → 明确报错', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{
      op: 'fanout', id: 'fa', as: 'file',
      over: Array.from({ length: 51 }, (_, i) => `f${i}.js`),
      step: { prompt: '检查 ${file}' },
    }],
    callStep: okStep(),
  });
  assert.match(out.error, /最多 50 项/);
});

test('script/step: depends_on 引用 fanout 别名 → 注入全部子项结果', async () => {
  const prompts = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'fanout', id: 'fa', as: 'file', over: ['a.js', 'b.js'], step: { role: '审查员', prompt: '检查 ${file}' } },
      { op: 'step', id: 'sum', role: '审查员', prompt: '汇总', depends_on: ['fa'] },
    ],
    callStep: async (ctx) => {
      prompts.push([ctx.id, ctx.prompt, ctx.depends_on]);
      return { content: `${ctx.id} ok`, toolCount: 1 };
    },
  });
  assert.equal(out.ok, true);
  const sum = prompts.find(([id]) => id === 'sum');
  assert.deepEqual(sum[2], ['fa#0', 'fa#1']);
  assert.match(sum[1], /fa#0 ok/);
  assert.match(sum[1], /fa#1 ok/);
});

test('script/gate: 只有程序节点时可省略 callStep', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'gate', id: 'g1', tool: 'review_diff', args: { dir: 'D:/tmp' } }],
    runGate: async () => ({ changed: 0 }),
  });
  assert.equal(out.error, undefined);
  assert.equal(out.ok, true);
  assert.equal(out.results[0].source, 'program');
});

// ---------- if ----------

test('script/if: contains 命中走 then，不命中走 else', async () => {
  const calls = [];
  const script = [{
    op: 'if', id: 'cond', when: { ref: 'scan', test: { contains: 'VULN' } },
    then: [{ op: 'step', id: 't1', prompt: '处理漏洞' }],
    else: [{ op: 'step', id: 'e1', prompt: '无需处理' }],
  }];
  const base = { op: 'step', id: 'scan', role: '审查员', prompt: '扫描' };
  const hit = await runWorkflow({
    goal: 'g',
    script: [base, ...script],
    callStep: async (ctx) => {
      calls.push(ctx.id);
      return { content: ctx.id === 'scan' ? 'VULN_FOUND' : '已处理', toolCount: 1 };
    },
  });
  assert.ok(hit.results.some((r) => r.id === 'cond.then.0' && r.ok));
  assert.ok(!hit.results.some((r) => r.id === 'cond.else.0'));
  assert.deepEqual(hit.phases.slice(0, 2), [['scan'], ['cond.then.0']]);

  const missCalls = [];
  const miss = await runWorkflow({
    goal: 'g',
    script: [base, ...script],
    callStep: async (ctx) => {
      missCalls.push(ctx.id);
      return { content: ctx.id === 'scan' ? 'CLEAN' : '无需处理', toolCount: 1 };
    },
  });
  assert.ok(miss.results.some((r) => r.id === 'cond.else.0' && r.ok));
  assert.ok(!miss.results.some((r) => r.id === 'cond.then.0'));
});

// ---------- gate ----------

test('script/gate: 不调 callStep，source=program 且 verified', async () => {
  let stepCalls = 0;
  let gateCalls = 0;
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'gate', id: 'g1', tool: 'audit_project', args: { dir: 'D:/tmp/project' } }],
    runGate: async (tool, args) => {
      gateCalls += 1;
      return { verdict: 'pass', findings: [], echo: { tool, args } };
    },
    callStep: async () => {
      stepCalls += 1;
      return { content: 'x', toolCount: 1 };
    },
  });
  const row = out.results.find((r) => r.id === 'g1');
  assert.equal(stepCalls, 0, 'gate 节点不得调用模型');
  assert.equal(gateCalls, 1);
  assert.equal(row.ok, true);
  assert.equal(row.source, 'program');
  assert.equal(row.verified, true);
  assert.equal(row.gate, 'audit_project');
  assert.match(row.content, /"verdict":"pass"/);
});

// ---------- report ----------

test('script/report: 后续 step 失败也保留 report，且立即写 journal', async () => {
  await withTempDir(async (dir) => {
    const out = await runWorkflow({
      goal: 'g',
      journalDir: dir,
      script: [
        { op: 'step', id: 's1', role: '审查员', prompt: '取证' },
        { op: 'report', id: 'rep', from: 's1', ask: '汇总' },
        { op: 'step', id: 'boom', role: '审查员', prompt: '再审' },
      ],
      callStep: async (ctx) => {
        if (ctx.id === 's1') return { content: '证据 A', toolCount: 1 };
        if (ctx.id === 'rep') return { content: reportText, toolCount: 0 };
        // 自动补的对抗复核也要成功，否则它会成为洞，报告必须点名它才可交付
        if (ctx.id === '__verify__') return { content: JSON.stringify({ verdicts: [] }), toolCount: 1 };
        return { error: '人为失败' };
      },
    });
    assert.equal(out.ok, false, '后续节点失败 → 整体失败');
    const rep = out.results.find((r) => r.id === 'rep');
    assert.equal(rep.ok, true);
    assert.equal(rep.delivered, true);
    assert.ok(out.delivered.includes('rep'));
    const journal = JSON.parse(await readFile(join(dir, `${out.runId}.json`), 'utf8'));
    assert.equal(journal.steps.rep.status, 'success');
    assert.ok(String(journal.steps.rep.content || '').length >= 80);
    assert.equal(journal.steps.boom.status, 'failed');
  });
});

// ---------- 校验/上限 ----------

test('script/校验: 未知 op 与 steps+script 同时给都明确报错', async () => {
  const unknown = await runWorkflow({
    goal: 'g',
    script: [{ op: 'nope', id: 'a' }],
    callStep: okStep(),
  });
  assert.match(unknown.error, /未知脚本 op：nope/);
  const both = await runWorkflow({
    goal: 'g',
    steps: [{ id: 's', prompt: 'x' }],
    script: [{ op: 'step', id: 'a', prompt: 'x' }],
    callStep: okStep(),
  });
  assert.match(both.error, /steps 与 script 互斥/);
});

test('script/校验: if 嵌套超过 8 层 → 报错', async () => {
  const nest = (n) => (n === 0
    ? [{ op: 'step', id: 'leaf', prompt: 'x' }]
    : [{ op: 'if', id: `if${n}`, when: { ref: 'base', test: { notEmpty: true } }, then: nest(n - 1) }]);
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'step', id: 'base', prompt: 'x' }, ...nest(9)],
    callStep: okStep(),
  });
  assert.match(out.error, /if 嵌套超过 8 层/);
});

// ---------- verify ----------

test('script/verify: 走 callStep 的 blind verify，verdict 应用到上游 claims', async () => {
  const seen = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 'scan', role: '审查员', prompt: '取证' },
      { op: 'verify', id: 'v', from: 'scan' },
    ],
    callStep: async (ctx) => {
      seen.push(ctx);
      if (ctx.id === 'scan') {
        return {
          content: JSON.stringify({ findings: [{ id: 'f1', claim: '有注入', evidence: 'a.js:1', severity: 'high', reproduced: true }] }),
          toolCount: 1,
        };
      }
      return { content: JSON.stringify({ verdicts: [{ claimId: 'f1', verdict: 'confirmed', evidence: 'a.js:1' }] }), toolCount: 1 };
    },
  });
  const verify = out.results.find((r) => r.id === 'v');
  assert.equal(verify.ok, true);
  assert.equal(seen.find((c) => c.id === 'v').kind, 'verify');
  assert.equal(seen.find((c) => c.id === 'v').blind, true);
  assert.equal(verify.verdicts.length, 1);
  assert.equal(verify.claims[0].status, 'confirmed');
  assert.equal(out.claims[0].status, 'confirmed');
});

// ---------- 复用 ----------

test('script/复用: 同 script + journal 第二次运行直接复用，不调 callStep', async () => {
  await withTempDir(async (dir) => {
    const script = [
      { op: 'step', id: 'a', role: '审查员', prompt: '检查 A' },
      { op: 'report', id: 'rep', from: 'a', ask: '汇总' },
    ];
    const first = await runWorkflow({
      goal: 'G',
      journalDir: dir,
      script,
      callStep: async (ctx) => ({ content: ctx.id === 'rep' ? reportText : '证据 A', toolCount: ctx.id === 'rep' ? 0 : 1 }),
    });
    assert.equal(first.ok, true);
    let secondCalls = 0;
    const second = await runWorkflow({
      goal: 'G',
      journalDir: dir,
      resumeFrom: first.runId,
      script,
      callStep: async () => { secondCalls += 1; return { content: '不该被调用', toolCount: 1 }; },
    });
    assert.equal(second.ok, true);
    assert.equal(secondCalls, 0);
    assert.ok(second.results.every((r) => r.reused), '两个节点都应复用');
  });
});

test('script/复用: report 的 from 是 fanout 别名时同样可复用', async () => {
  await withTempDir(async (dir) => {
    const script = [
      { op: 'fanout', id: 'fa', as: 'file', over: ['a.js', 'b.js'], step: { role: '审查员', prompt: '检查 ${file}' } },
      { op: 'report', id: 'rep', from: 'fa', ask: '汇总' },
    ];
    const first = await runWorkflow({
      goal: 'G',
      journalDir: dir,
      script,
      callStep: async (ctx) => ({ content: ctx.id === 'rep' ? reportText : '子项结果', toolCount: ctx.id === 'rep' ? 0 : 1 }),
    });
    assert.equal(first.ok, true);
    let secondCalls = 0;
    const second = await runWorkflow({
      goal: 'G',
      journalDir: dir,
      resumeFrom: first.runId,
      script,
      callStep: async () => { secondCalls += 1; return { content: '不该被调用', toolCount: 1 }; },
    });
    assert.equal(second.ok, true);
    assert.equal(secondCalls, 0);
    assert.ok(second.results.every((r) => r.reused));
  });
});

test('script/复用: 旧 report 未点名本次失败节点 → 不复用，重跑并带着洞清单交付', async () => {
  await withTempDir(async (dir) => {
    const script = [
      { op: 'step', id: 'a', role: '记录员', prompt: '记录 A' },
      { op: 'step', id: 'b', role: '记录员', prompt: '记录 B' },
      { op: 'report', id: 'rep', from: 'a', ask: '汇总' },
    ];
    const first = await runWorkflow({
      goal: 'G',
      journalDir: dir,
      script,
      callStep: async (ctx) => {
        if (ctx.id === 'a') return { content: '证据 A', toolCount: 1 };
        if (ctx.id === '__verify__') return { content: JSON.stringify({ verdicts: [] }), toolCount: 1 };
        if (ctx.id === 'b') return { content: '' }; // 空回复 → salvage 成洞
        return { content: reportText, toolCount: 0 }; // 旧报告漏点 b
      },
    });
    assert.equal(first.ok, false);
    const firstRep = first.results.find((r) => r.id === 'rep');
    assert.equal(firstRep.delivered, false, '首次报告漏点 b，不应交付');
    assert.ok(firstRep.content.startsWith('## Conclusion'), '报告正文仍保留，不能吞掉');

    const secondCalls = [];
    const second = await runWorkflow({
      goal: 'G',
      journalDir: dir,
      resumeFrom: first.runId,
      script,
      callStep: async (ctx) => {
        secondCalls.push(ctx.id);
        if (ctx.id === '__verify__') return { content: JSON.stringify({ verdicts: [] }), toolCount: 1 };
        if (ctx.id === 'b') return { content: '' };
        if (ctx.id === 'rep') {
          return { content: reportText.replace('None', '- [b] 审查 B：无最终结论，未覆盖。'), toolCount: 0 };
        }
        return { content: '不该被调用', toolCount: 1 };
      },
    });
    const rep = second.results.find((r) => r.id === 'rep');
    assert.ok(secondCalls.includes('rep'), '旧报告未点名洞 → 必须重跑 report');
    assert.equal(rep.reused, false, '不能把旧报告标记为复用');
    assert.deepEqual(rep.holes, ['b']);
    assert.equal(rep.reportLintOk, true);
    assert.equal(rep.delivered, true);
    assert.ok(second.delivered.includes('rep'));
  });
});

// ---------- loop ----------

test('script/loop: 第 1 轮命中 until → 停止，只生成 r1 节点', async () => {
  const calls = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [{
      op: 'loop', id: 'lp', maxRounds: 3,
      body: [{ op: 'step', id: 'check', role: '审查员', prompt: '检查' }],
      until: { ref: 'check', test: { contains: 'DONE' } },
    }],
    callStep: async (ctx) => {
      calls.push(ctx.id);
      return { content: ctx.id === 'lp.r1.0' ? 'DONE' : 'NO', toolCount: 1 };
    },
  });
  assert.equal(out.error, undefined);
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.map((r) => r.id), ['lp.r1.0', 'lp']);
  assert.ok(!out.results.some((r) => r.id === 'lp.r2.0'), '命中后不再执行后续轮次');
  const lp = out.results.find((r) => r.id === 'lp');
  assert.equal(lp.ok, true);
  assert.equal(lp.rounds, 1);
  assert.equal(lp.matched, true);
  assert.ok(out.phases[0].includes('lp'));
  assert.ok(out.phases[0].includes('lp.r1.0'));
});

test('script/loop: 触顶 maxRounds 仍不满足 → loop 节点 failed，错误文案固定', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{
      op: 'loop', id: 'lp', maxRounds: 2,
      body: [{ op: 'step', id: 'check', role: '审查员', prompt: '检查' }],
      until: { ref: 'check', test: { contains: 'DONE' } },
    }],
    callStep: async () => ({ content: 'NO', toolCount: 1 }),
  });
  assert.equal(out.ok, false);
  const lp = out.results.find((r) => r.id === 'lp');
  assert.equal(lp.ok, false);
  assert.equal(lp.error, '循环达到上限仍不满足条件');
  assert.deepEqual(out.results.filter((r) => r.id.startsWith('lp.r')).map((r) => r.id), ['lp.r1.0', 'lp.r2.0']);
});

test('script/loop: 20 轮×11 节点计入全局 200 上限 → 明确报错', async () => {
  const body = Array.from({ length: 11 }, (_, i) => ({ op: 'step', id: `s${i}`, prompt: 'x' }));
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'loop', id: 'lp', maxRounds: 20, body, until: { ref: 's0', test: { contains: 'x' } } }],
    callStep: okStep(),
  });
  assert.match(out.error, /最多 200 个/);
});

// ---------- recurse ----------

test('script/recurse: 沿列表展开到 maxDepth，${as} 可用，节点 id 按深度生成', async () => {
  const prompts = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [{
      op: 'recurse', id: 'rc', over: ['root'], as: 'item', maxDepth: 2,
      body: [{ op: 'step', id: 'walk', role: '审查员', prompt: '处理 ${item}' }],
    }],
    callStep: async (ctx) => {
      prompts.push([ctx.id, ctx.prompt]);
      if (ctx.id === 'rc.d1.i0.0') return { content: JSON.stringify(['child']), toolCount: 1 };
      return { content: '[]', toolCount: 1 };
    },
  });
  assert.equal(out.error, undefined);
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.map((r) => r.id), ['rc.d1.i0.0', 'rc.d2.i0.0', 'rc']);
  assert.match(prompts[0][1], /处理 root/);
  assert.match(prompts[1][1], /处理 child/);
  const rc = out.results.find((r) => r.id === 'rc');
  assert.equal(rc.ok, true);
  assert.equal(rc.branches, 2);
  assert.ok(out.phases[0].includes('rc.d1.i0.0'));
  assert.ok(out.phases[0].includes('rc.d2.i0.0'));
});

test('script/recurse: maxDepth 触顶后停止展开（不静默越界）', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{
      op: 'recurse', id: 'rc', over: ['root'], as: 'item', maxDepth: 1,
      body: [{ op: 'step', id: 'walk', role: '审查员', prompt: '处理 ${item}' }],
    }],
    callStep: async () => ({ content: JSON.stringify(['child']), toolCount: 1 }),
  });
  assert.equal(out.ok, true);
  assert.ok(!out.results.some((r) => r.id.startsWith('rc.d2.')), '超过 maxDepth 的节点不得执行');
  const rc = out.results.find((r) => r.id === 'rc');
  assert.equal(rc.ok, true);
  assert.equal(rc.branches, 1);
  assert.equal(rc.depthLimited, 1);
});

test('script/recurse: stopWhen 命中 → 该分支停止，不再向下展开', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{
      op: 'recurse', id: 'rc', over: ['root'], as: 'item', maxDepth: 2,
      stopWhen: { ref: 'walk', test: { contains: 'STOP' } },
      body: [{ op: 'step', id: 'walk', role: '审查员', prompt: '处理 ${item}' }],
    }],
    callStep: async () => ({ content: 'STOP ["child"]', toolCount: 1 }),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.map((r) => r.id), ['rc.d1.i0.0', 'rc']);
  const rc = out.results.find((r) => r.id === 'rc');
  assert.equal(rc.stopWhenMatched, 1);
  assert.equal(rc.branches, 1);
});

test('script/recurse: 静态 over 展开后总节点超过 200 → 明确报错', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{
      op: 'recurse', id: 'rc',
      over: Array.from({ length: 200 }, (_, i) => `item${i}`),
      as: 'item', maxDepth: 2,
      body: [{ op: 'step', id: 'walk', prompt: 'x' }],
    }],
    callStep: okStep(),
  });
  assert.match(out.error, /最多 200 个/);
});

// ---------- aggregate ----------

test('script/aggregate: 从上游 findings 聚合，top 截断，且不调 callStep', async () => {
  const called = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 'scan', role: '审查员', prompt: '扫描' },
      { op: 'aggregate', id: 'agg', from: 'scan', by: 'severity', top: 2 },
    ],
    callStep: async (ctx) => {
      called.push(ctx.id);
      return {
        content: JSON.stringify({ findings: [
          { severity: 'high', rule: 'r1' },
          { severity: 'high', rule: 'r2' },
          { severity: 'low', rule: 'r3' },
          { severity: 'medium', rule: 'r4' },
        ] }),
        toolCount: 1,
      };
    },
  });
  assert.ok(!called.includes('agg'), 'aggregate 节点不得调用模型');
  const agg = out.results.find((r) => r.id === 'agg');
  assert.equal(agg.ok, true);
  assert.equal(agg.source, 'program');
  assert.deepEqual(agg.groups, [
    { key: 'high', count: 2 },
    { key: 'low', count: 1 },
    { key: 'medium', count: 1 },
  ]);
  assert.deepEqual(agg.top, [{ key: 'high', count: 2 }, { key: 'low', count: 1 }]);
  assert.equal(out.results.filter((r) => r.id !== '__verify__').length, 2);
});

test('script/aggregate: 空输入不炸，groups/top 为空数组', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 'scan', role: '审查员', prompt: '扫描' },
      { op: 'aggregate', id: 'agg', from: 'scan', by: 'file' },
    ],
    callStep: async () => ({ content: '没有发现任何问题。', toolCount: 1 }),
  });
  assert.equal(out.ok, true);
  const agg = out.results.find((r) => r.id === 'agg');
  assert.equal(agg.ok, true);
  assert.deepEqual(agg.groups, []);
  assert.deepEqual(agg.top, []);
});

test('script/aggregate: top 超过 20 → 明确报错', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 'scan', role: '审查员', prompt: '扫描' },
      { op: 'aggregate', id: 'agg', from: 'scan', by: 'file', top: 21 },
    ],
    callStep: okStep(),
  });
  assert.match(out.error, /top 必须是 1..20 的整数/);
});

// ---------- 插值安全 ----------

test('script/插值: 只支持 ${name} 与 ${nodeId.content}，其他语法原样保留', () => {
  const results = new Map([['a', { ok: true, content: 'A 的正文' }], ['b', { ok: false, error: '失败原因' }]]);
  assert.equal(interpolateScriptText('${file}', { file: 'x.js' }), 'x.js');
  assert.equal(interpolateScriptText('${a.content}', {}, results), 'A 的正文');
  assert.equal(interpolateScriptText('${b.content}', {}, results), '[失败] 失败原因');
  assert.equal(interpolateScriptText('${1+1} ${a.b} ${env.PATH}', {}, results), '${1+1} ${a.b} ${env.PATH}');
  assert.equal(matchScriptCondition({ test: { contains: 'A', notEmpty: true } }, { content: 'A' }), true);
  assert.equal(matchScriptCondition({ test: { equals: 'A' } }, { content: 'B' }), false);
});
