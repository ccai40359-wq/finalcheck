// 回合中途提问（ask_user）：主进程 pending 台账 + 落库还原 + 子代理工具表隔离。
// 不调真模型：只测 registry / tool schema / sessions 的 tool part 还原。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createAskUserRegistry } from '../desktop/src/main/ask-user.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { AGENT_TOOLS_SCHEMA, SUBAGENT_TOOLS_SCHEMA } from '../desktop/src/main/agent-service.mjs';
import { askUserCardFromTrace } from '../desktop/src/renderer/lib/ask-user.mjs';

const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const Database = require('better-sqlite3');
const bs3Entry = require.resolve('better-sqlite3');
const nodeBinding = path.join(path.dirname(bs3Entry), '..', 'prebuilds-node', 'better_sqlite3.node');

process.env.FINALCHECK_SESSION_STORE = 'sqlite';
const root = await mkdtemp(path.join(os.tmpdir(), 'fc-ask-user-'));
process.env.FINALCHECK_SESSIONS_DIR = root;
const sessions = await import('../desktop/src/main/sessions.mjs');

after(async () => {
  sessions.closeAllSessionDatabases();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

const repoRoot = path.resolve(import.meta.dirname, '..');
const waitFor = async (fn, timeout = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function freshDir(t, prefix = 'fc-ask-one-') {
  const dir = await mkdtemp(path.join(root, prefix));
  process.env.FINALCHECK_SESSIONS_DIR = dir;
  t.after(async () => {
    sessions.closeAllSessionDatabases();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

/* ---------- ① 发问 → pending → 回答 resolve ---------- */
test('ask-user: 工具接线——发问挂起，回答后工具拿到 {answer} 并继续', async () => {
  const seen = [];
  const reg = createAskUserRegistry({ emit: (p) => seen.push(p) });
  reg.beginTurn('s-1');
  const tools = createAgentTools({
    repoRoot,
    permissions: { sessionAllowed: () => false },
    askUser: (args, ctx) => reg.ask({ ...args, sessionId: 's-1', signal: ctx?.signal })
  });
  const promise = tools.ask_user({
    question: '按 L2 还是 L3？',
    options: [{ label: 'L2', description: '标准验收' }, { label: 'L3', description: '含许可证/运维' }]
  }, { signal: null });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].question, '按 L2 还是 L3？');
  assert.equal(seen[0].options.length, 2);
  assert.equal(seen[0].multiSelect, false);
  assert.equal(seen[0].sessionId, 's-1');
  assert.equal(reg.pendingCount('s-1'), 1);

  const r = reg.answer({ callId: seen[0].callId, selected: ['L3'] });
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'L3');
  assert.deepEqual(await promise, { answer: 'L3' });
  assert.equal(reg.pendingCount(), 0);
  // 同一个 callId 不能回答两次
  assert.equal(reg.answer({ callId: seen[0].callId, answer: 'L2' }).ok, false);
});

/* ---------- ② 多选 + 自由输入 ---------- */
test('ask-user: multiSelect 回答合并选项与补充文本', async () => {
  const seen = [];
  const reg = createAskUserRegistry({ emit: (p) => seen.push(p) });
  const promise = reg.ask({ question: '要查哪几路？', options: [{ label: '鉴权' }, { label: '注入' }, { label: '依赖' }], multiSelect: true, sessionId: 's-m' });
  assert.equal(seen[0].multiSelect, true);
  const r = reg.answer({ callId: seen[0].callId, selected: ['鉴权', '注入'], text: '依赖先跳过' });
  assert.equal(r.ok, true);
  assert.match(r.answer, /鉴权 \/ 注入/);
  assert.match(r.answer, /依赖先跳过/);
  assert.deepEqual(await promise, { answer: r.answer });
});

/* ---------- ③ 用户停止 → cancelled:true ---------- */
test('ask-user: 停止回合时 pending 立即 resolve 为用户取消', async () => {
  const seen = [];
  const reg = createAskUserRegistry({ emit: (p) => seen.push(p) });
  reg.beginTurn('s-stop');
  const promise = reg.ask({ question: '继续吗？', sessionId: 's-stop' });
  assert.equal(reg.pendingCount('s-stop'), 1);
  assert.equal(reg.cancelSession('s-stop'), 1);
  const r = await promise;
  assert.equal(r.cancelled, true);
  assert.match(r.error, /用户取消/);
  assert.equal(reg.pendingCount(), 0);
  // 取消后再回答：已失效
  assert.equal(reg.answer({ callId: seen[0].callId, answer: '继续' }).ok, false);

  // 回合 abort 信号同样立即收尾（agent-cancel 之外的第二条保险）
  const ac = new AbortController();
  const reg2 = createAskUserRegistry({ emit: () => {} });
  const p2 = reg2.ask({ question: '还在吗？', sessionId: 's-stop', signal: ac.signal });
  ac.abort();
  const r2 = await p2;
  assert.equal(r2.cancelled, true);
  assert.equal(reg2.pendingCount(), 0);
});

/* ---------- ④ 重启后孤儿 pending → 未回答（已失效）---------- */
test('ask-user: 进行中的 tool part 重开会话后还原为「未回答（已失效）」；回答后还原为已回答', async (t) => {
  await freshDir(t);
  const s = await sessions.newSession('提问落库');
  await sessions.appendUserMessage(s.id, '按哪个档位？');
  const args = JSON.stringify({ question: '按 L2 还是 L3？', options: [{ label: 'L2' }, { label: 'L3' }], multiSelect: false });
  await sessions.appendToolStart(s.id, { callId: 'tc-ask', name: 'ask_user', args });

  // 模拟 App 重启：关闭连接后重新加载
  sessions.closeAllSessionDatabases();
  const mid = await sessions.loadSession(s.id);
  const assistant = mid.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant, '进行中的 assistant 行必须还在');
  assert.equal(assistant.interrupted, true, '中断的回合应标记 interrupted');
  const pendingTrace = assistant.trace.find((x) => x.tool === 'ask_user');
  assert.ok(pendingTrace, 'ask_user 的 tool part 必须能从 trace 还原');
  assert.equal(pendingTrace.status, 'running');
  const pendingCard = askUserCardFromTrace(pendingTrace);
  assert.equal(pendingCard.status, 'expired');
  assert.equal(pendingCard.question, '按 L2 还是 L3？');
  assert.equal(pendingCard.options.length, 2);

  // 回答落库（tool-end）：重开显示已回答
  await sessions.appendToolEnd(s.id, {
    callId: 'tc-ask', name: 'ask_user', status: 'ok', result: { answer: 'L3' }, error: null, ms: 1200
  });
  const done = await sessions.loadSession(s.id);
  const doneAssistant = done.messages.find((m) => m.role === 'assistant');
  const doneTrace = doneAssistant.trace.find((x) => x.tool === 'ask_user');
  const doneCard = askUserCardFromTrace(doneTrace);
  assert.equal(doneCard.status, 'answered');
  assert.equal(doneCard.answer, 'L3');

  // 原始库里的 running part 已更新为 ok（不是新插一条）
  const raw = new Database(path.join(process.env.FINALCHECK_SESSIONS_DIR, 'finalcheck.db'), { nativeBinding: nodeBinding });
  try {
    const rows = raw.prepare("SELECT data_json FROM part WHERE type = 'tool'").all();
    const parsed = rows.map((r) => JSON.parse(r.data_json)).filter((d) => d.name === 'ask_user');
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].status, 'ok');
  } finally {
    raw.close();
  }
});

/* ---------- ⑤ 子代理工具表里没有 ask_user ---------- */
test('ask-user: 子代理 schema 不含 ask_user；只有主 agent 的 createAgentTools 注册实现', async () => {
  const subNames = SUBAGENT_TOOLS_SCHEMA.map((x) => x.function.name);
  assert.ok(!subNames.includes('ask_user'), '子代理 schema 不得有 ask_user');
  assert.equal(SUBAGENT_TOOLS_SCHEMA.length, 14);
  const agentNames = AGENT_TOOLS_SCHEMA.map((x) => x.function.name);
  assert.ok(agentNames.includes('ask_user'), '主 agent schema 必须有 ask_user');

  const noAsk = createAgentTools({ repoRoot, permissions: { sessionAllowed: () => false } });
  assert.equal(typeof noAsk.ask_user, 'undefined', '没传 askUser 时工具表不出现 ask_user');

  const withAsk = createAgentTools({ repoRoot, permissions: { sessionAllowed: () => false }, askUser: async (args) => ({ answer: `echo:${args.question}` }) });
  assert.equal(typeof withAsk.ask_user, 'function');
  assert.deepEqual(await withAsk.ask_user({ question: '在吗' }, {}), { answer: 'echo:在吗' });
});

/* ---------- ⑥ 一回合第 4 次提问被拒 ---------- */
test('ask-user: 一回合最多 3 次，第 4 次返回上限错误', async () => {
  const seen = [];
  const reg = createAskUserRegistry({ emit: (p) => seen.push(p) });
  reg.beginTurn('s-limit');
  const p1 = reg.ask({ question: 'q1', sessionId: 's-limit' });
  const p2 = reg.ask({ question: 'q2', sessionId: 's-limit' });
  const p3 = reg.ask({ question: 'q3', sessionId: 's-limit' });
  assert.equal(seen.length, 3);
  const p4 = await reg.ask({ question: 'q4', sessionId: 's-limit' });
  assert.match(p4.error, /本次回合提问次数已达上限/);
  assert.equal(seen.length, 3, '第 4 次不弹卡');
  reg.cancelAll();
  await Promise.all([p1, p2, p3]);

  // 新回合重置计数
  reg.beginTurn('s-limit');
  const next = reg.ask({ question: 'again', sessionId: 's-limit' });
  assert.equal(seen.length, 4);
  reg.cancelAll();
  await next;
});

/* ---------- 历史卡状态还原 ---------- */
test('ask-user: 历史卡状态还原（answered / cancelled / expired / rejected）', () => {
  const args = JSON.stringify({ question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] });
  const answered = askUserCardFromTrace({ tool: 'ask_user', args, status: 'ok', result: { answer: 'A' } });
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, 'A');

  const cancelled = askUserCardFromTrace({ tool: 'ask_user', args, status: 'fail', error: '用户取消', result: { error: '用户取消', cancelled: true } });
  assert.equal(cancelled.status, 'cancelled');

  const orphan = askUserCardFromTrace({ tool: 'ask_user', args, status: 'running', result: null });
  assert.equal(orphan.status, 'expired');

  // 进程被杀：sealPending 写的是「未完成（进程中断）」→ 仍是未回答，不冒充用户取消
  const killed = askUserCardFromTrace({ tool: 'ask_user', args, status: 'fail', error: '未完成（进程中断）', result: null });
  assert.equal(killed.status, 'expired');

  const rejected = askUserCardFromTrace({ tool: 'ask_user', args, status: 'fail', error: '本次回合提问次数已达上限', result: { error: '本次回合提问次数已达上限' } });
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.error, /次数已达上限/);
});

/* ---------- 无 UI 通道 fail-closed（不挂死） ---------- */
test('ask-user: 没有 emit 通道时立即返回错误，不挂起', async () => {
  const reg = createAskUserRegistry();
  const r = await reg.ask({ question: '在吗' });
  assert.match(r.error, /没有可用的界面通道/);
  assert.equal(reg.pendingCount(), 0);
});

/* ---------- 参数校验 ---------- */
test('ask-user: 空问题/空回答被拒，选项最多 6 个', async () => {
  const seen = [];
  const reg = createAskUserRegistry({ emit: (p) => seen.push(p) });
  assert.match((await reg.ask({ question: '   ' })).error, /提问内容不能为空/);
  const p = reg.ask({ question: '列一下', options: Array.from({ length: 9 }, (_, i) => ({ label: `op${i}` })) });
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0].options.length, 6);
  assert.match(reg.answer({ callId: seen[0].callId, text: '   ' }).error, /回答不能为空/);
  reg.cancelAll();
  await p;
});
