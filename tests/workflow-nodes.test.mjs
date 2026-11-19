// 0.26 统一工作流写法：nodes 一张流程图，depends_on 决定先后，互不依赖的一起跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileNodes } from '../desktop/src/main/workflow-nodes.mjs';
import { runWorkflow } from '../desktop/src/main/workflow.mjs';

test('compileNodes：全是普通节点 → 交给 DAG 引擎（steps），prompt 里的 ${x.content} 也算依赖', () => {
  const c = compileNodes([
    { id: 'a', name: '甲审查员', prompt: '查 A', depends_on: [] },
    { id: 'b', name: '乙审查员', prompt: '查 B', depends_on: [] },
    { id: 'c', name: '汇总主编', prompt: '汇总 ${a.content} 和 b', depends_on: ['b'] },
  ]);
  assert.equal(c.mode, 'steps');
  assert.deepEqual(c.steps.find((s) => s.id === 'c').depends_on.sort(), ['a', 'b']);
  assert.ok(!('type' in c.steps[0]));
});

test('compileNodes：含 fanout → DSL + 依赖图；数组顺序乱写也按拓扑排好', () => {
  const c = compileNodes([
    { id: 'rep', type: 'report', from: ['each'] },
    { id: 'each', type: 'fanout', name: '接口审查员', over: 'list', as: 'route', step: { prompt: '审查 ${route}' } },
    { id: 'list', name: '接口侦察员', prompt: '列出路由，只输出 JSON 字符串数组', depends_on: [] },
  ]);
  assert.equal(c.mode, 'script');
  assert.deepEqual(c.order, ['list', 'each', 'rep']);
  assert.equal(c.script[1].op, 'fanout');
  assert.deepEqual(c.dag.deps.each, ['list']);
  assert.deepEqual(c.dag.deps.rep, ['each']);
});

test('compileNodes：成环 / 引用不存在 / id 重复 / 不认识的 type 都在开跑前报清楚', () => {
  assert.match(compileNodes([{ id: 'a', prompt: 'x', depends_on: ['b'] }, { id: 'b', prompt: 'y', depends_on: ['a'] }]).error, /成环/);
  assert.match(compileNodes([{ id: 'a', prompt: 'x', depends_on: ['zzz'] }]).error, /不存在的节点：zzz/);
  assert.match(compileNodes([{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }]).error, /重复/);
  assert.match(compileNodes([{ id: 'a', type: 'parallel', prompt: 'x' }]).error, /不认识/);
  assert.match(compileNodes([]).error, /不能为空/);
  assert.match(compileNodes('[{').error, /JSON/);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('DSL 依赖图模式：互不依赖的顶层节点同时跑，有依赖的等上游；全局并发闸生效', async () => {
  const spans = {};
  let live = 0;
  let peak = 0;
  const callStep = async (ctx) => {
    live++; peak = Math.max(peak, live);
    const id = String(ctx.id);
    spans[id] = { start: Date.now() };
    await sleep(id.startsWith('list') ? 40 : 60);
    spans[id].end = Date.now();
    live--;
    if (id === 'list') return { content: '["/a","/b","/c"]', toolCount: 1 };
    return { content: `查完 ${id}：无问题（证据 src/x.js:1）`, toolCount: 1 };
  };
  const c = compileNodes([
    { id: 'list', name: '接口侦察员', prompt: '列出路由，只输出 JSON 字符串数组', depends_on: [] },
    { id: 'deps', name: '依赖审查员', prompt: '查依赖', depends_on: [] },
    { id: 'each', type: 'fanout', name: '接口审查员', over: 'list', as: 'route', step: { prompt: '审查 ${route}' } },
    { id: 'rep', type: 'report', from: ['each', 'deps'] },
  ]);
  assert.equal(c.mode, 'script');
  const r = await runWorkflow({ goal: '审查', script: c.script, dag: c.dag, callStep, control: { maxConcurrency: 3 } });
  assert.ok(!r.error, r.error);
  // list 与 deps 互不依赖 → 重叠执行
  assert.ok(spans.list.start < spans.deps.end && spans.deps.start < spans.list.end, 'list 与 deps 应并行');
  // 扇出子节点等 list 跑完才开始
  const kids = Object.keys(spans).filter((k) => k.startsWith('each#'));
  assert.equal(kids.length, 3);
  for (const k of kids) assert.ok(spans[k].start >= spans.list.end, `${k} 应在 list 之后`);
  // 报告等所有上游
  const repKey = Object.keys(spans).find((k) => /rep|report/.test(k));
  assert.ok(repKey, '应有报告节点');
  for (const k of [...kids, 'deps']) assert.ok(spans[repKey].start >= spans[k].end, `报告应在 ${k} 之后`);
  assert.ok(peak <= 3, `同时在跑的子代理不超过并发上限（实际峰值 ${peak}）`);
});

test('旧 script 写法仍按数组顺序执行（兼容）', async () => {
  const order = [];
  const callStep = async (ctx) => { order.push(String(ctx.id)); await sleep(10); return { content: `结果 ${ctx.id}（证据 a.js:1）`, toolCount: 1 }; };
  const r = await runWorkflow({
    goal: '旧脚本',
    script: [
      { op: 'step', id: 'x', prompt: '查 x' },
      { op: 'step', id: 'y', prompt: '查 y' },
      { op: 'report', id: 'r', from: ['x', 'y'] },
    ],
    callStep,
  });
  assert.ok(!r.error, r.error);
  assert.deepEqual(order.slice(0, 2), ['x', 'y']);
});
