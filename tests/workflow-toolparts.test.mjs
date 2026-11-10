// 工作流子代理的工具调用落库（SQLite part 表 + 合成 message_id）
// - 合成 message_id = wf:<runId>:<stepId>，不写 message 表 → loadSession 永远读不到（聊天记录不被污染）；
// - 开始一次写 running、结束一次按 callId 更新同一条（ok/fail + result/error/ms），每工具只写 2 次；
// - 进程被杀后 DB 留下 running 的 part，重开库 listWorkflowToolParts 仍能看到；
// - JSON 后端 no-op（返回 false/[]），不抛错。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const Database = require('better-sqlite3');
const bs3Entry = require.resolve('better-sqlite3');
const nodeBinding = path.join(path.dirname(bs3Entry), '..', 'prebuilds-node', 'better_sqlite3.node');

process.env.FINALCHECK_SESSION_STORE = 'sqlite';
const root = await mkdtemp(path.join(os.tmpdir(), 'fc-wftoolparts-'));
process.env.FINALCHECK_SESSIONS_DIR = root;
const sessions = await import('../desktop/src/main/sessions.mjs');

after(async () => {
  sessions.closeAllSessionDatabases();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

const openRaw = (dir) => new Database(path.join(dir, 'finalcheck.db'), { nativeBinding: nodeBinding });

async function freshDir(t, prefix = 'fc-wfp-one-') {
  const dir = await mkdtemp(path.join(root, prefix));
  process.env.FINALCHECK_SESSIONS_DIR = dir;
  process.env.FINALCHECK_SESSION_STORE = 'sqlite';
  t.after(async () => {
    sessions.closeAllSessionDatabases();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

const tool = (over = {}) => ({ callId: 'c1', name: 'read_file', args: '{"path":"a.js"}', ...over });

test('start 写 running；end 更新同一条为 ok（含 result/ms）', async (t) => {
  const dir = await freshDir(t);
  const s = await sessions.newSession('工作流工具');
  const t0 = tool();
  const started = await sessions.appendWorkflowToolStart(s.id, { runId: 'run-abc', stepId: 's1', tool: t0 });
  assert.ok(started && started.partId, '开始必须返回 part');
  assert.equal(started.messageId, 'wf:run-abc:s1', '合成 message_id 规则');
  assert.equal(started.status, 'running');

  const mid = await sessions.listWorkflowToolParts(s.id, 'run-abc');
  assert.equal(mid.length, 1);
  assert.equal(mid[0].status, 'running');
  assert.equal(mid[0].name, 'read_file');
  assert.equal(mid[0].args, t0.args);
  assert.equal(mid[0].result, null);
  assert.equal(mid[0].ms, null);
  assert.equal(mid[0].stepId, 's1');

  const ended = await sessions.appendWorkflowToolEnd(s.id, {
    runId: 'run-abc',
    stepId: 's1',
    tool: tool({ status: 'ok', result: { text: 'hello' }, error: null, ms: 12 }),
  });
  assert.equal(ended.partId, started.partId, '结束必须更新同一条 part');
  assert.equal(ended.status, 'ok');

  const done = await sessions.listWorkflowToolParts(s.id, 'run-abc');
  assert.equal(done.length, 1, '同一工具只能有一条 part');
  assert.equal(done[0].status, 'ok');
  assert.deepEqual(done[0].result, { text: 'hello' });
  assert.equal(done[0].error, null);
  assert.equal(done[0].ms, 12);
  assert.equal(done[0].partId, started.partId);

  // 第二个工具（同一步）seq 递增，而不是覆盖
  const second = await sessions.appendWorkflowToolStart(s.id, { runId: 'run-abc', stepId: 's1', tool: tool({ callId: 'c2', name: 'run_command', args: '{}' }) });
  assert.equal(second.seq, started.seq + 1, 'seq 走 wfseq 计数器');

  // runId/stepId 缺失：退化 no-op，不抛错、不写脏行
  assert.equal(await sessions.appendWorkflowToolStart(s.id, { stepId: 's1', tool: t0 }), false);
  assert.equal(await sessions.appendWorkflowToolEnd(s.id, { runId: 'run-abc', tool: t0 }), false);

  const raw = openRaw(dir);
  try {
    // 只多出第二条的 running，没有因缺 runId 多写
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM part WHERE message_id LIKE 'wf:%'").get().n, 2);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM message WHERE id LIKE 'wf:%'").get().n, 0, '合成 id 不得写 message 表');
  } finally { raw.close(); }
});

test('失败工具：status=fail 且 error/result/ms 正确', async (t) => {
  await freshDir(t);
  const s = await sessions.newSession('工作流工具失败');
  const started = await sessions.appendWorkflowToolStart(s.id, { runId: 'run-bad', stepId: 's2', tool: tool({ callId: 'c-bad', name: 'run_command', args: '{"command":"nope"}' }) });
  const ended = await sessions.appendWorkflowToolEnd(s.id, {
    runId: 'run-bad',
    stepId: 's2',
    tool: { callId: 'c-bad', name: 'run_command', status: 'fail', result: { error: 'boom' }, error: 'boom', ms: 7 },
  });
  assert.equal(ended.partId, started.partId);
  const list = await sessions.listWorkflowToolParts(s.id, 'run-bad');
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'fail');
  assert.equal(list[0].error, 'boom');
  assert.deepEqual(list[0].result, { error: 'boom' });
  assert.equal(list[0].ms, 7);
});

test('崩溃语义：只有 start 没有 end，重开库仍是 running', async (t) => {
  const dir = await freshDir(t, 'fc-wfp-crash-');
  const s = await sessions.newSession('工作流崩溃');
  const started = await sessions.appendWorkflowToolStart(s.id, { runId: 'run-crash', stepId: 's3', tool: tool({ callId: 'c-crash' }) });
  assert.ok(started?.partId);

  sessions.closeAllSessionDatabases(); // 模拟进程被杀

  const reopened = await sessions.listWorkflowToolParts(s.id, 'run-crash');
  assert.equal(reopened.length, 1, '重开后仍然查得到');
  assert.equal(reopened[0].status, 'running', '未收尾的工具保持 running（未完成证据保留）');
  assert.equal(reopened[0].result, null);

  const raw = openRaw(dir);
  try {
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM session WHERE id = ?').get(s.id).n, 1);
    const row = raw.prepare('SELECT * FROM part WHERE id = ?').get(started.partId);
    assert.equal(JSON.parse(row.data_json).status, 'running');
  } finally { raw.close(); }
});

test('聊天记录不被污染：loadSession 不包含工作流工具 part', async (t) => {
  await freshDir(t, 'fc-wfp-load-');
  const s = await sessions.newSession('不污染');
  await sessions.appendUserMessage(s.id, '跑工作流');
  await sessions.appendWorkflowToolStart(s.id, { runId: 'run-x', stepId: 's1', tool: tool() });
  await sessions.appendWorkflowToolEnd(s.id, { runId: 'run-x', stepId: 's1', tool: tool({ status: 'ok', result: { ok: 1 }, ms: 3 }) });
  await sessions.appendWorkflowToolStart(s.id, { runId: 'run-x', stepId: 's2', tool: tool({ callId: 'c9', name: 'grep' }) });

  const loaded = await sessions.loadSession(s.id);
  assert.equal(loaded.messages.length, 1, '只有用户消息，没有合成 assistant 消息');
  assert.equal(loaded.messages[0].role, 'user');
  assert.equal(loaded.messages[0].trace, undefined, '没有 trace 被注入');
  assert.ok(!JSON.stringify(loaded).includes('wf:'), '工作流 part 的合成 id 不得出现在 loadSession 结果里');

  const summary = (await sessions.listSessions()).find((x) => x.id === s.id);
  assert.equal(summary.turns, 0, '工作流工具不占对话轮数');
});

test('写入频率：每工具最多 2 次（start INSERT + end UPDATE），runSubagentTurn 原样转发钩子', async (t) => {
  const dir = await freshDir(t, 'fc-wfp-freq-');
  const s = await sessions.newSession('频率');
  // 同一批两个工具交错：start A, start B, end B, end A
  const a = await sessions.appendWorkflowToolStart(s.id, { runId: 'run-f', stepId: 's1', tool: tool({ callId: 'a', name: 'read_file' }) });
  const b = await sessions.appendWorkflowToolStart(s.id, { runId: 'run-f', stepId: 's1', tool: tool({ callId: 'b', name: 'grep' }) });
  const endB = await sessions.appendWorkflowToolEnd(s.id, { runId: 'run-f', stepId: 's1', tool: { callId: 'b', name: 'grep', status: 'ok', result: { hits: 2 }, ms: 4 } });
  const endA = await sessions.appendWorkflowToolEnd(s.id, { runId: 'run-f', stepId: 's1', tool: { callId: 'a', name: 'read_file', status: 'ok', result: { text: 'x' }, ms: 6 } });
  assert.equal(endB.partId, b.partId);
  assert.equal(endA.partId, a.partId);
  const list = await sessions.listWorkflowToolParts(s.id, 'run-f');
  assert.equal(list.length, 2, '两个工具两条 part（不是每个事件一条）');

  const raw = openRaw(dir);
  try {
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM part WHERE message_id = ?").get('wf:run-f:s1').n, 2);
    // session_meta 的 seq 计数器停在最后一条（2 条工具 → 3）
    assert.equal(raw.prepare('SELECT value FROM session_meta WHERE key = ?').get('wfseq:wf:run-f:s1').value, '3');
  } finally { raw.close(); }

  // agent-service：runSubagentTurn 把 onToolLifecycle 透传给引擎，每个工具恰好 start/end 各一次
  const { runSubagentTurn } = await import('../desktop/src/main/agent-service.mjs');
  const sse = (chunks) => new Response(chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
  let call = 0;
  const mockFetch = async () => {
    call += 1;
    if (call === 1) {
      return sse([{ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'id-1', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { index: 1, id: 'id-2', function: { name: 'grep', arguments: '{"q":"x"}' } },
      ] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  const events = [];
  const out = await runSubagentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    systemPrompt: 'sys',
    prompt: '去读文件',
    name: 'step',
    tools: { read_file: async () => ({ ok: 1 }), grep: async () => ({ hits: 1 }) },
    fetchImpl: mockFetch,
    onToolLifecycle: (ev) => events.push(ev),
  });
  assert.equal(out.content, '完成');
  assert.equal(events.filter((e) => e.phase === 'start').length, 2, '每个工具开始只报一次');
  assert.equal(events.filter((e) => e.phase === 'end').length, 2, '每个工具结束只报一次');
  for (const id of ['id-1', 'id-2']) {
    assert.equal(events.filter((e) => e.phase === 'start' && e.id === id).length, 1);
    assert.equal(events.filter((e) => e.phase === 'end' && e.id === id).length, 1);
  }
});

test('JSON 后端：no-op 不抛错（返回 false / []）', async (t) => {
  await freshDir(t, 'fc-wfp-json-');
  t.after(() => { process.env.FINALCHECK_SESSION_STORE = 'sqlite'; });
  process.env.FINALCHECK_SESSION_STORE = 'json';
  const s = await sessions.newSession('JSON 后端');
  await sessions.appendUserMessage(s.id, '问');
  assert.equal(await sessions.appendWorkflowToolStart(s.id, { runId: 'run-j', stepId: 's1', tool: tool() }), false);
  assert.equal(await sessions.appendWorkflowToolEnd(s.id, { runId: 'run-j', stepId: 's1', tool: tool({ status: 'ok', ms: 1 }) }), false);
  assert.deepEqual(await sessions.listWorkflowToolParts(s.id, 'run-j'), []);
  const loaded = await sessions.loadSession(s.id);
  assert.equal(loaded.messages.length, 1, 'JSON 后端聊天记录不受影响');
});
