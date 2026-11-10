import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-sessions-'));
process.env.FINALCHECK_SESSIONS_DIR = dir;
const sessions = await import('../desktop/src/main/sessions.mjs');

test('sessions: reasoning 落盘，重开仍能看到思考', async (t) => {
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await sessions.newSession();
  await sessions.appendTurn(s.id, '你好', {
    content: '结论：没问题',
    reasoning: '先看目录，再判断边界。',
    trace: [{ tool: 'read_file', args: '{}', result: { added: 1 } }]
  });
  const loaded = await sessions.loadSession(s.id);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[1].reasoning, '先看目录，再判断边界。');
  assert.equal(loaded.messages[1].trace[0].tool, 'read_file');
  const list = await sessions.listSessions();
  assert.ok(list.some((x) => x.id === s.id));
  await sessions.saveSummary(s.id, '早前聊过部署与端口。');
  await sessions.appendNotice(s.id, '上下文已压缩：100 → 20 字符', 'compact');
  const after = await sessions.loadSession(s.id);
  assert.equal(after.summary, '早前聊过部署与端口。');
  assert.ok(after.summaryAt > 0);
  assert.equal(after.messages.at(-1).role, 'notice');
  assert.match(after.messages.at(-1).content, /上下文已压缩/);
  await sessions.deleteSession(s.id);
  assert.equal((await sessions.listSessions()).length, 0);

  const s2 = await sessions.newSession();
  await sessions.appendTurn(s2.id, '看图\n\n[附件]\n- D:\\tmp\\a.png', { content: '好的' });
  assert.equal((await sessions.loadSession(s2.id)).title, '看图');
  await sessions.deleteSession(s2.id);
});

test('sessions: rewindToUserTurn 丢弃编辑点之后的回合（编辑重开用）', async (t) => {
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await sessions.newSession();
  await sessions.appendTurn(s.id, '第一问', { content: '第一答' });
  await sessions.appendTurn(s.id, '第二问', { content: '第二答' });
  const kept = await sessions.rewindToUserTurn(s.id, 1);
  assert.equal(kept.messages, 2);
  const loaded = await sessions.loadSession(s.id);
  assert.deepEqual(loaded.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(loaded.messages[0].content, '第一问');
  const empty = await sessions.rewindToUserTurn(s.id, 0);
  assert.equal(empty.messages, 0);
  assert.equal(empty.title, '新会话');
  await sessions.deleteSession(s.id);
});

test('sessions: 每个会话独立的模型配置（互不影响，且不改 updatedAt）', async (t) => {
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await sessions.newSession('A');
  const b = await sessions.newSession('B');
  const before = (await sessions.loadSession(a.id)).updatedAt;
  await sessions.setModelConfig(a.id, { providerId: 'prov-a', model: 'model-a', effort: 'max' });
  await sessions.setModelConfig(b.id, { providerId: 'prov-b', model: 'model-b', effort: 'low' });
  const la = await sessions.loadSession(a.id);
  const lb = await sessions.loadSession(b.id);
  assert.deepEqual(la.modelConfig, { providerId: 'prov-a', model: 'model-a', effort: 'max' });
  assert.deepEqual(lb.modelConfig, { providerId: 'prov-b', model: 'model-b', effort: 'low' });
  assert.equal(la.updatedAt, before, '改模型不该把会话顶到最前');
  await sessions.deleteSession(a.id);
  await sessions.deleteSession(b.id);
});

test('sessions: 发送即落盘（appendUserMessage 立刻可读，回答结束再补 assistant）', async (t) => {
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await sessions.newSession();
  await sessions.appendUserMessage(s.id, '帮我看一下这个仓库');
  const mid = await sessions.loadSession(s.id);
  assert.equal(mid.messages.length, 1, '还没回答时用户消息已经在盘里');
  assert.equal(mid.messages[0].role, 'user');
  assert.equal(mid.title, '帮我看一下这个仓库', '第一条用户消息决定标题');
  await sessions.appendAssistantMessage(s.id, { content: '好', interrupted: true });
  const done = await sessions.loadSession(s.id);
  assert.deepEqual(done.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(done.messages[1].interrupted, true);
  await sessions.deleteSession(s.id);
});

test('sessions: 先发后答交替写入顺序不变（两条消息成对）', async (t) => {
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await sessions.newSession();
  await sessions.appendUserMessage(s.id, '第一问');
  await sessions.appendAssistantMessage(s.id, { content: '第一答' });
  await sessions.appendUserMessage(s.id, '第二问');
  await sessions.appendAssistantMessage(s.id, { content: '第二答', error: null });
  const msgs = (await sessions.loadSession(s.id)).messages;
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(msgs.map((m) => m.content), ['第一问', '第一答', '第二问', '第二答']);
  await sessions.deleteSession(s.id);
});

test('sessions: setSessionUsage 持久化 usage 且不影响 messages/title', async (t) => {
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await sessions.newSession();
  await sessions.appendTurn(s.id, '问题', { content: '答复', reasoning: '想一想' });
  const usage = { prompt: 1000, completion: 20, cached: 900, cacheHit: 90, at: Date.now() };
  await sessions.setSessionUsage(s.id, usage);
  const loaded = await sessions.loadSession(s.id);
  assert.deepEqual(loaded.usage, usage, 'usage 落盘，重开仍在');
  assert.deepEqual(loaded.messages.map((m) => [m.role, m.content]), [['user', '问题'], ['assistant', '答复']]);
  assert.equal(loaded.messages[1].reasoning, '想一想');
  assert.equal(loaded.title, '问题');
  // 再写一次只覆盖 usage：消息不重复、不丢失
  await sessions.setSessionUsage(s.id, { ...usage, prompt: 2000 });
  const again = await sessions.loadSession(s.id);
  assert.equal(again.messages.length, 2);
  assert.equal(again.usage.prompt, 2000);
  await sessions.deleteSession(s.id);
});

test('sessions: 列表顺序按创建时间固定（活动/打开不重排，新会话在最上面）', async (t) => {
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await sessions.newSession('A');
  await new Promise((r) => setTimeout(r, 5));
  const b = await sessions.newSession('B');
  await new Promise((r) => setTimeout(r, 5));
  const c = await sessions.newSession('C');
  // 给最早的 A 追加一轮（updatedAt 变成最新）——顺序仍应按 createdAt：C, B, A
  await sessions.appendUserMessage(a.id, '旧会话里发了一条');
  await sessions.appendAssistantMessage(a.id, { content: 'ok' });
  const list = (await sessions.listSessions()).filter((x) => [a.id, b.id, c.id].includes(x.id));
  assert.deepEqual(list.map((x) => x.id), [c.id, b.id, a.id]);
  for (const x of [a, b, c]) await sessions.deleteSession(x.id);
});
