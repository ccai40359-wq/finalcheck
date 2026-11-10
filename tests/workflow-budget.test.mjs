// 工作流单步预算回归（L3 实测两个真实问题：拆步不并行 / 单步硬断掐死子代理）：
// 用户最终口径：子代理与工作流不设任何墙钟超时（默认 maxStepMs=0），只保留「模型轮次 40 轮」；
// 用户停止 / 父级 abort 仍然立即取消；显式 budget.maxStepMs 正数才按墙钟中断（留给以后需要的人）。
//  1. 默认值 0（不限制），steps 未写 budget 时 callStep 收到 maxStepMs: 0
//  2. 不设超时时，500ms 长任务不会被自动 abort
//  3. 显式 maxStepMs=300 才 abort，error 含「单步超时」，partial content 保留
//  4. 用户/父级 abort 立即取消（不等任何计时器）
//  5. 子代理不再按 300s/时间预算自动收尾（config.maxTurnMs 被忽略，工具轮次继续）
//  6. SYSTEM_BASE / run_workflow 描述教模型用空 depends_on 并行拆步
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow, resolveMaxStepMs, stepTimeoutText, withStepDeadline, SUBAGENT_STEP_TIMEOUT_MS } from '../desktop/src/main/workflow.mjs';
import { getSystemPromptParts, runSubagentTurn, TOOLS_SCHEMA } from '../desktop/src/main/agent-service.mjs';

const READ_FILE_SCHEMA = {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取本机文本文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sseBody = (chunks) => chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
const sseResponse = (chunks) => new Response(sseBody(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const toolCallChunk = (id, path) => ({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] }, finish_reason: 'tool_calls' }]
});

test('budget: 默认 0 = 不限制（steps 未写 budget 时 callStep 收到 maxStepMs: 0）', async () => {
  const seen = [];
  const out = await runWorkflow({
    goal: '默认预算',
    steps: [{ id: 'a', prompt: '写下第一段说明' }],
    callStep: async (ctx) => {
      seen.push(ctx.budget);
      return { content: 'ok' };
    }
  });
  assert.equal(out.ok, true);
  assert.equal(seen[0].maxStepMs, 0);
  assert.equal(SUBAGENT_STEP_TIMEOUT_MS, 0);
  assert.equal(resolveMaxStepMs(null), 0);
  assert.equal(resolveMaxStepMs({ maxStepMs: 0 }), 0);
  assert.equal(resolveMaxStepMs({ maxStepMs: 999999 }), 600000, '显式正数仍按上限 600000 clamp');
});

test('budget: 不设超时时，500ms 长任务不会被自动 abort', async () => {
  let abortedDuringRun = null;
  const t0 = Date.now();
  const out = await runWorkflow({
    goal: '长任务',
    steps: [{ id: 'long', prompt: '整理材料' }],
    callStep: async ({ signal }) => {
      await sleep(500);
      abortedDuringRun = signal?.aborted ?? false;
      return { content: '长任务完整产出的材料' };
    }
  });
  assert.equal(abortedDuringRun, false, '无 maxStepMs 时绝不能用墙钟打断子代理');
  assert.equal(out.ok, true);
  assert.ok(Date.now() - t0 >= 480, '500ms 任务应真的跑完');
  assert.equal(out.results[0].content, '长任务完整产出的材料');
});

test('budget: 显式 maxStepMs=300 才 abort，error 含「单步超时」且保留 partial content', async () => {
  let aborted = false;
  const out = await runWorkflow({
    goal: '显式超时',
    steps: [{ id: 'slow', prompt: '整理材料', budget: { maxStepMs: 300 } }],
    callStep: ({ signal }) => new Promise((resolve) => {
      // 模拟真实子代理：收到引擎中断信号后把已写到的正文交回
      signal.addEventListener('abort', () => {
        aborted = true;
        resolve({ content: '已经整理到一半的材料', toolCount: 3, warnings: ['外部警告'] });
      }, { once: true });
    })
  });
  assert.equal(aborted, true, '显式正数到点必须 abort');
  const r = out.results.find((x) => x.id === 'slow');
  assert.equal(r.ok, false);
  assert.match(r.error, /单步超时（/);
  assert.match(r.error, /产出可能不完整/);
  assert.equal(r.content, '已经整理到一半的材料', '失败步骤的 partial content 不能丢');
  assert.equal(out.ok, false);
});

test('budget: 用户/父级 abort 立即取消（不等任何计时器，保留半成品）', async () => {
  const outer = new AbortController();
  const wrapped = withStepDeadline(({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ content: '停下前的半成品' }), { once: true });
  }), { signal: outer.signal });
  const t0 = Date.now();
  const pending = wrapped({ id: 'a', prompt: '整理材料', budget: { maxStepMs: 0 } });
  setTimeout(() => outer.abort(), 20);
  const out = await pending;
  assert.ok(Date.now() - t0 < 1000, '父级 abort 必须立即取消，而不是等超时');
  assert.match(out.error, /用户停止/);
  assert.equal(out.content, '停下前的半成品');
});

test('subagent: 不再按 300s/时间预算自动收尾（config.maxTurnMs 被忽略，工具轮次继续）', async () => {
  const bodies = [];
  let calls = 0;
  const fetchImpl = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    calls += 1;
    if (calls <= 2) {
      await sleep(120); // 单轮就超过 config.maxTurnMs，旧逻辑会在这里强制收尾
      return sseResponse([toolCallChunk(`c${calls}`, `file${calls}.txt`)]);
    }
    return sseResponse([{ choices: [{ index: 0, delta: { content: '两个文件都读完了' }, finish_reason: 'stop' }] }]);
  };
  const result = await runSubagentTurn({
    config: { baseUrl: 'http://fake.local/v1', apiKey: 'k', model: 'm', maxTurnMs: 50 },
    prompt: '读两个文件并给出说明',
    kind: 'recon',
    tools: { read_file: async () => ({ ok: true }) },
    toolsSchema: [READ_FILE_SCHEMA],
    fetchImpl
  });
  assert.equal(bodies.length, 3, '两轮工具 + 一次最终结论：不应因时间预算提前收尾');
  assert.ok(bodies[1].tools, '第二轮仍应带工具（时间预算不再中止）');
  assert.equal(result.error, undefined);
  assert.equal(result.content, '两个文件都读完了');
  assert.equal(result.toolCount, 2);
});

test('budget: 工作流「停止」（control.aborted）立即中断正在跑的子代理', async () => {
  const control = { paused: false, aborted: false, maxConcurrency: 1 };
  let aborted = false;
  const pending = runWorkflow({
    goal: '停止工作流',
    steps: [{ id: 'a', prompt: '整理材料' }],
    control,
    callStep: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        resolve({ content: '停止前的半成品' });
      }, { once: true });
    })
  });
  setTimeout(() => { control.aborted = true; }, 50);
  const out = await pending;
  await sleep(50); // 让在飞的 runOne 收尾
  assert.equal(aborted, true, 'control.aborted 必须传到在跑步骤的 signal');
  assert.equal(out.stopped, true);
});

test('prompts: SYSTEM_BASE 教「先问是否需要上游」并用空 depends_on 并行，run_workflow 描述同步', async () => {
  const parts = await getSystemPromptParts();
  assert.ok(parts.base.includes('depends_on: []'), 'SYSTEM_BASE 必须给出空 depends_on 的写法');
  assert.ok(parts.base.includes('并行'), 'SYSTEM_BASE 必须提到并行');
  assert.ok(parts.base.includes('这一步真的需要上一步的结果吗'), 'SYSTEM_BASE 必须有先自问的硬规则');
  const wf = TOOLS_SCHEMA.find((t) => t?.function?.name === 'run_workflow');
  assert.match(wf.function.description, /空 depends_on/);
  assert.match(wf.function.description, /不要为了「看起来有顺序」/);
  assert.match(stepTimeoutText(300), /单步超时/);
});
