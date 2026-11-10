// 运行中切换模型/供应商：不用等「下一条消息」才生效。
// 覆盖三条生效路径：① 工作流第 N 步开始时重读配置；② 排队消息出队（新一轮回合）按最新配置解析；
// ③ set-model 落盘后重读能拿到新值。外加主 agent 回合内「下一次模型请求」的实时路由。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

const sessionsDir = await mkdtemp(path.join(os.tmpdir(), 'fc-live-model-'));
process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;

const { runWorkflow } = await import('../desktop/src/main/workflow.mjs');
const { runAgentTurn, resolveWorkflowStepModel } = await import('../desktop/src/main/agent-service.mjs');
const { createLiveModelResolver } = await import('../desktop/src/main/ipc/ipc-agent.mjs');
const { resolveTurnTarget } = await import('../desktop/src/main/model-config.mjs');
const sessions = await import('../desktop/src/main/sessions.mjs');

const sse = (chunks) => new Response(
  chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);
const toolCall = (id) => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'noop_tool', arguments: '{}' } }] } }] }]);
const answer = (text) => sse([{ choices: [{ delta: { content: text } }] }]);

const provider = (id, name, baseUrl, apiKey, models) => ({ id, name, baseUrl, apiKey, models, enabled: true, apiFormat: 'chat-completions' });
const pA = () => provider('p-a', 'Provider A', 'https://a.example/v1', 'key-a', ['model-a1', 'model-a2']);
const pB = () => provider('p-b', 'Provider B', 'https://b.example/v1', 'key-b', ['model-b1']);

test('resolveTurnTarget: 会话指定的 provider+model 命中就用；不在列表回落 activeModel', () => {
  const cfg = { providers: [pA(), pB()], activeProviderId: 'p-a', activeModel: 'model-a2' };
  const hit = resolveTurnTarget({ cfg, modelConfig: { providerId: 'p-b', model: 'model-b1' } });
  assert.equal(hit.provider.id, 'p-b');
  assert.equal(hit.model, 'model-b1');
  assert.equal(hit.reason, null);

  const miss = resolveTurnTarget({ cfg, modelConfig: { providerId: 'p-a', model: 'gone-model' } });
  assert.equal(miss.provider.id, 'p-a');
  assert.equal(miss.model, 'model-a2', '模型不在列表时回落全局 activeModel');

  const disabled = { ...pB(), enabled: false };
  const fallback = resolveTurnTarget({ cfg: { providers: [pA(), disabled], activeProviderId: 'p-b' }, modelConfig: { providerId: 'p-b', model: 'model-b1' } });
  assert.equal(fallback.provider.id, 'p-a', '被禁用的会话供应商回落全局可用供应商');

  const none = resolveTurnTarget({ cfg: { providers: [] }, modelConfig: {} });
  assert.equal(none.provider, null);
  assert.equal(none.reason, 'no-provider');
});

test('工作流：第 2 步开始前改配置 → 第 2 步用新模型，第 1 步不受影响', async (t) => {
  t.after(() => rm(sessionsDir, { recursive: true, force: true }));
  let cfgNow = { providers: [pA(), pB()], activeProviderId: 'p-a', activeModel: 'model-a1' };
  let mcNow = { providerId: 'p-a', model: 'model-a1', effort: 'max' };
  const live = createLiveModelResolver({
    store: { loadConfig: async () => cfgNow },
    sessionsStore: { getModelConfig: async () => mcNow },
    sessionId: 's-live',
    initial: { provider: cfgNow.providers[0], model: 'model-a1' }
  });

  const seen = [];
  // 与 ipc-agent 的 callStep 同构：每步开始时 live.resolve()，再走 per-step 解析
  const callStep = async (ctx) => {
    const l = await live.resolve();
    const providersNow = Array.isArray(l.cfg?.providers) ? l.cfg.providers : [];
    const fallback = { baseUrl: l.provider.baseUrl, apiKey: l.provider.apiKey, model: l.model, providerId: l.provider.id };
    const r = resolveWorkflowStepModel({
      step: { id: ctx?.id, providerId: ctx?.providerId, model: ctx?.model },
      providers: providersNow,
      fallback
    });
    const used = r.override || fallback;
    seen.push({ id: ctx.id, model: used.model, providerId: used.providerId, fellBack: l.fellBack });
    // 第 1 步执行期间用户切了供应商 + 模型
    if (ctx.id === 's1') {
      cfgNow = { providers: [pA(), pB()], activeProviderId: 'p-b', activeModel: 'model-b1' };
      mcNow = { providerId: 'p-b', model: 'model-b1', effort: 'max' };
    }
    return { content: `${ctx.id} 完成`, toolCount: 1, providerId: used.providerId, model: used.model };
  };

  const out = await runWorkflow({
    goal: 'live-switch',
    steps: [
      { id: 's1', prompt: 'first note' },
      { id: 's2', prompt: 'second note', depends_on: ['s1'] }
    ],
    callStep
  });
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.deepEqual(seen.map((s) => s.id), ['s1', 's2']);
  assert.equal(seen[0].providerId, 'p-a', '第 1 步用的还是启动时的供应商');
  assert.equal(seen[0].model, 'model-a1', '已跑完的步骤不回滚');
  assert.equal(seen[1].providerId, 'p-b', '第 2 步开始时已读到新供应商');
  assert.equal(seen[1].model, 'model-b1', '第 2 步用新模型');
  assert.equal(seen.every((s) => !s.fellBack), true);
  // 回填的是「实际使用」的供应商/模型（跨家族复核按它判 family）
  assert.equal(out.results.find((r) => r.id === 's2').providerId, 'p-b');
  assert.equal(out.results.find((r) => r.id === 's2').model, 'model-b1');
});

test('工作流：最新配置解析不到供应商 → 沿用上一目标（fellBack 供 callStep 记回退 warning）', async () => {
  let cfgNow = { providers: [pA()], activeProviderId: 'p-a', activeModel: 'model-a1' };
  let mcNow = { providerId: 'p-a', model: 'model-a1' };
  const live = createLiveModelResolver({
    store: { loadConfig: async () => cfgNow },
    sessionsStore: { getModelConfig: async () => mcNow },
    sessionId: 's-fb',
    initial: { provider: cfgNow.providers[0], model: 'model-a1' }
  });
  // 用户把唯一供应商禁用/删光
  cfgNow = { providers: [{ ...pA(), enabled: false }], activeProviderId: 'p-a', activeModel: 'model-a1' };
  const l = await live.resolve();
  assert.equal(l.fellBack, true);
  assert.equal(l.reason, 'no-provider');
  assert.equal(l.provider.id, 'p-a', '上一可用目标继续可用，不交白卷');
  assert.equal(l.model, 'model-a1');
});

test('排队消息：出队（新回合）按最新配置解析，而不是入队时的快照', async () => {
  let cfgNow = { providers: [pA(), pB()], activeProviderId: 'p-a', activeModel: 'model-a1' };
  let mcNow = { providerId: 'p-a', model: 'model-a1' };
  const store = { loadConfig: async () => cfgNow };
  const sess = { getModelConfig: async () => mcNow };

  // 入队时（旧回合）解析到的是 A
  const beforeEnqueue = await createLiveModelResolver({ store, sessionsStore: sess, sessionId: 's-q', initial: { provider: cfgNow.providers[0], model: 'model-a1' } }).resolve();
  assert.equal(beforeEnqueue.model, 'model-a1');

  // 回合运行期间用户改成 B
  mcNow = { providerId: 'p-b', model: 'model-b1' };

  // 出队执行时创建一个新的 resolver（= 新一轮回合的解析）
  const atDequeue = await createLiveModelResolver({ store, sessionsStore: sess, sessionId: 's-q', initial: { provider: cfgNow.providers[0], model: 'model-a1' } }).resolve();
  assert.equal(atDequeue.provider.id, 'p-b');
  assert.equal(atDequeue.model, 'model-b1');
});

test('主 agent 回合内：下一次模型请求就换模型/供应商（已输出的那条不重跑）', async () => {
  const bodies = [];
  const auths = [];
  let turn = 0;
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    auths.push(opts.headers.authorization);
    turn += 1;
    if (turn === 1) return toolCall('call-1');
    return answer('最终结论');
  };
  const out = await runAgentTurn({
    config: { baseUrl: 'https://a.example/v1', apiKey: 'key-a', model: 'model-a1' },
    messages: [{ role: 'user', content: '跑一个任务' }],
    tools: { noop_tool: async () => ({ ok: true }) },
    fetchImpl: mockFetch,
    maxTurns: 2,
    // 第 1 次请求发出时还没改；用户在其流式输出期间切到了 B（第 2 次请求起生效）
    resolveConfig: async () => (turn === 0
      ? { baseUrl: 'https://a.example/v1', apiKey: 'key-a', model: 'model-a1' }
      : { baseUrl: 'https://b.example/v1', apiKey: 'key-b', model: 'model-b1', providerId: 'p-b' })
  });
  assert.equal(out.answer, '最终结论');
  assert.ok(bodies.length >= 2, '至少两次模型请求（工具轮 + 作答轮）');
  assert.equal(bodies[0].model, 'model-a1', '第一次请求发出时还是旧模型');
  assert.equal(auths[0], 'Bearer key-a');
  assert.equal(bodies[1].model, 'model-b1', '下一次请求起用新模型');
  assert.equal(auths[1], 'Bearer key-b', '新供应商的 key 也同时生效');
  // 工具轮的结果仍保留在第二次请求的上下文里（切换不丢已经做过的工作）
  assert.equal(bodies[1].messages.filter((m) => m.role === 'tool').length, 1);
});

test('主 agent 回合内：解析失败时不打断，继续用当前配置', async () => {
  const bodies = [];
  let turn = 0;
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    turn += 1;
    if (turn === 1) return toolCall('call-1');
    return answer('完成');
  };
  const out = await runAgentTurn({
    config: { baseUrl: 'https://a.example/v1', apiKey: 'key-a', model: 'model-a1' },
    messages: [],
    tools: { noop_tool: async () => ({ ok: true }) },
    fetchImpl: mockFetch,
    maxTurns: 2,
    resolveConfig: async () => null
  });
  assert.equal(out.answer, '完成');
  assert.equal(bodies[1].model, 'model-a1', '解析不到就沿用当前模型，不报错不空转');
});

test('set-model 落盘后重读能拿到新值（重开 App 仍生效）', async (t) => {
  t.after(() => rm(sessionsDir, { recursive: true, force: true }));
  const s = await sessions.newSession('live-model');
  await sessions.setModelConfig(s.id, { providerId: 'p-a', model: 'model-a1', effort: 'max' });
  assert.deepEqual(await sessions.getModelConfig(s.id), { providerId: 'p-a', model: 'model-a1', effort: 'max' });

  // 运行中切换：写入后立刻重读（模拟主进程下一步/下一轮重新解析）
  await sessions.setModelConfig(s.id, { providerId: 'p-b', model: 'model-b1', effort: 'high' });
  assert.deepEqual(await sessions.getModelConfig(s.id), { providerId: 'p-b', model: 'model-b1', effort: 'high' });
  const full = await sessions.loadSession(s.id);
  assert.equal(full.modelConfig.model, 'model-b1', 'loadSession 与轻量读取口径一致');
  // 未给的字段沿用旧值（select 只改模型，不把供应商清掉）
  await sessions.setModelConfig(s.id, { model: 'model-b2' });
  assert.equal((await sessions.getModelConfig(s.id)).providerId, 'p-b');
});
