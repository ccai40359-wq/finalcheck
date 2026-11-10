// fanout 并发回归：证明子节点真的同时在跑（不是顺序执行）、并发上限被遵守，
// 以及并发之后语义不变：结果顺序按声明顺序、失败节点不连坐兄弟、停止/暂停仍生效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../desktop/src/main/workflow.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 自动补的终局 report 需要一份合格的五段报告（<80 字会被判「汇总为空」）。
const reportText = [
  '## Conclusion', '并发测试汇总：全部子项已完成。', '## Findings', '- 见上游子项结果。',
  '## Verified', 'None', '## Not covered', 'None', '## Skipped', 'None', '',
].join('\n');

const fanoutScript = (over) => [{
  op: 'fanout', id: 'fa', as: 'file', over,
  step: { role: '审查员', prompt: '检查 ${file}' },
}];

/** 记录「同时在跑」的峰值——这是「真并发」的唯一硬判据（串行时峰值恒为 1） */
function tracker({ ms = 80, content = (id) => `${id} 完成：1 条发现`, tools = 2 } = {}) {
  const t = { inflight: 0, peak: 0, order: [] };
  t.step = async (ctx) => {
    if (ctx.id === '__report__') return { content: reportText, toolCount: 0 };
    t.inflight += 1;
    t.peak = Math.max(t.peak, t.inflight);
    t.order.push(ctx.id);
    try {
      await sleep(ms);
      return { content: content(ctx.id), toolCount: tools };
    } finally {
      t.inflight -= 1;
    }
  };
  return t;
}

test('script/fanout: 默认并发 4，4 个子节点同时起跑（峰值 ≥ 2）', async () => {
  const t = tracker();
  const out = await runWorkflow({
    goal: 'g',
    script: fanoutScript(['a.js', 'b.js', 'c.js', 'd.js']),
    callStep: t.step,
  });
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.results.filter((r) => r.id.startsWith('fa#')).length, 4);
  assert.ok(out.results.some((r) => r.id === '__verify__' && r.ok), '上游有正文时自动补验也要真跑');
  assert.ok(t.peak >= 2, `峰值并发 ${t.peak}：说明仍然是串行跑`);
  assert.ok(t.peak <= 4, `峰值并发 ${t.peak}：超过默认上限 4`);
});

test('script/fanout: concurrency=1 仍是串行（峰值恰好 1）', async () => {
  const t = tracker();
  const out = await runWorkflow({
    goal: 'g',
    script: fanoutScript(['a.js', 'b.js', 'c.js']),
    callStep: t.step,
    concurrency: 1,
  });
  assert.equal(out.ok, true);
  assert.equal(t.peak, 1);
});

test('script/fanout: concurrency=3 时 6 项不超过 3 路', async () => {
  const t = tracker();
  const out = await runWorkflow({
    goal: 'g',
    script: fanoutScript(Array.from({ length: 6 }, (_, i) => `f${i}.js`)),
    callStep: t.step,
    concurrency: 3,
  });
  assert.equal(out.ok, true);
  assert.equal(out.results.filter((r) => r.id.startsWith('fa#')).length, 6);
  assert.ok(t.peak >= 2 && t.peak <= 3, `峰值并发 ${t.peak}`);
});

test('script/fanout: 快照里的 concurrency 是真实上限（默认 4 / 可降到 3）', async () => {
  const shots = [];
  const t = tracker();
  await runWorkflow({
    goal: 'g',
    script: fanoutScript(['a.js', 'b.js', 'c.js', 'd.js']),
    callStep: t.step,
    onUpdate: (s) => shots.push(s),
  });
  assert.ok(shots.length > 0);
  assert.equal(shots[shots.length - 1].concurrency, 4);
  assert.equal(shots[shots.length - 1].running, false);

  const shots3 = [];
  await runWorkflow({
    goal: 'g',
    script: fanoutScript(['a.js', 'b.js', 'c.js']),
    callStep: tracker().step,
    concurrency: 3,
    onUpdate: (s) => shots3.push(s),
  });
  assert.equal(shots3[shots3.length - 1].concurrency, 3);
});

test('script/fanout: 并发跑但结果顺序仍按声明顺序（不被完成顺序打乱）', async () => {
  const delays = { 'a.js': 90, 'b.js': 10, 'c.js': 60, 'd.js': 30 };
  const out = await runWorkflow({
    goal: 'g',
    script: [{
      op: 'fanout', id: 'fa', as: 'file', over: ['a.js', 'b.js', 'c.js', 'd.js'],
      step: { role: '审查员', prompt: '检查 ${file}' },
    }],
    callStep: async (ctx) => {
      if (ctx.id === '__report__') return { content: reportText, toolCount: 0 };
      await sleep(delays[ctx.item] ?? 0);
      return { content: `${ctx.id} 完成：1 条发现`, toolCount: 2 };
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.filter((r) => r.id.startsWith('fa#')).map((r) => r.id), ['fa#0', 'fa#1', 'fa#2', 'fa#3']);
  assert.deepEqual(out.phases[0], ['fa#0', 'fa#1', 'fa#2', 'fa#3']);
});

test('script/fanout: 一个子节点失败（0 工具）不连坐兄弟节点', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: fanoutScript(['bad.js', 'b.js', 'c.js']),
    callStep: async (ctx) => ({
      content: ctx.id === 'fa#0' ? '代码看起来没问题。' : `${ctx.id} 完成：1 条发现`,
      toolCount: ctx.id === 'fa#0' ? 0 : 2,
    }),
  });
  assert.equal(out.results.filter((r) => r.id.startsWith('fa#')).length, 3);
  const bad = out.results.find((r) => r.id === 'fa#0');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /未产生任何工具调用/);
  assert.deepEqual(out.results.filter((r) => r.ok && r.id.startsWith('fa#')).map((r) => r.id), ['fa#1', 'fa#2']);
});

test('script/fanout: 控制台把并发降到 1（ctl.maxConcurrency 覆盖参数）', async () => {
  const t = tracker();
  const out = await runWorkflow({
    goal: 'g',
    script: fanoutScript(['a.js', 'b.js', 'c.js']),
    callStep: t.step,
    concurrency: 4,
    control: { paused: false, aborted: false, maxConcurrency: 1 },
  });
  assert.equal(out.ok, true);
  assert.equal(t.peak, 1);
});

test('script/fanout: depends_on 引用别名在并发下仍拿到全部子项', async () => {
  let sumPrompt = '';
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'fanout', id: 'fa', as: 'file', over: ['a.js', 'b.js', 'c.js'], step: { role: '审查员', prompt: '检查 ${file}' } },
      { op: 'step', id: 'sum', role: '审查员', prompt: '汇总', depends_on: ['fa'] },
    ],
    callStep: async (ctx) => {
      if (ctx.id === '__report__') return { content: reportText, toolCount: 0 };
      if (ctx.id === 'sum') {
        sumPrompt = ctx.prompt;
        return { content: '汇总完成', toolCount: 1 };
      }
      await sleep(40);
      return { content: `${ctx.id} 完成`, toolCount: 1 };
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.filter((r) => r.id !== '__verify__' && r.id !== '__report__').map((r) => r.id), ['fa#0', 'fa#1', 'fa#2', 'sum']);
  for (const id of ['fa#0', 'fa#1', 'fa#2']) assert.match(sumPrompt, new RegExp(id));
});
