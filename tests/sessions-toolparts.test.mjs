// 第 2 步：工具调用级落库（SQLite 后端）
// - 开始执行写 part(type='tool', status='running')；结束更新同一条 part（ok/fail + result/error/ms）；
// - 崩溃（只写 running、没写结束）后重开库，loadSession 仍能看到该工具与「已中断」标记；
// - 所有外部输入走 ? 参数绑定，不注入、不截断；
// - 每个工具只在「开始/结束」两个点写，part 写入次数 ≤ 2。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const Database = require('better-sqlite3');
const bs3Entry = require.resolve('better-sqlite3');
const nodeBinding = path.join(path.dirname(bs3Entry), '..', 'prebuilds-node', 'better_sqlite3.node');

process.env.FINALCHECK_SESSION_STORE = 'sqlite';
const root = await mkdtemp(path.join(os.tmpdir(), 'fc-toolparts-'));
process.env.FINALCHECK_SESSIONS_DIR = root;
const sessions = await import('../desktop/src/main/sessions.mjs');

after(async () => {
  sessions.closeAllSessionDatabases();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

const dbIn = (dir) => path.join(dir, 'finalcheck.db');
const openRaw = (dir) => new Database(dbIn(dir), { nativeBinding: nodeBinding });

async function freshDir(t, prefix = 'fc-toolparts-one-') {
  const dir = await mkdtemp(path.join(root, prefix));
  process.env.FINALCHECK_SESSIONS_DIR = dir;
  t.after(async () => {
    sessions.closeAllSessionDatabases();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

const toolPartRows = (raw, messageId) => raw.prepare('SELECT * FROM part WHERE message_id = ? AND type = ? ORDER BY seq ASC').all(messageId, 'tool');

test('工具开始落 running；结束时同一 part 更新为 ok，result/error/ms 正确，收尾不重复插消息', async (t) => {
  const dir = await freshDir(t);
  const s = await sessions.newSession('工具落库');
  await sessions.appendUserMessage(s.id, '帮我跑命令');
  const args = '{"command":"dir /b"}';
  const started = await sessions.appendToolStart(s.id, { callId: 'call-1', name: 'run_command', args });
  assert.ok(started && started.partId && started.messageId, '开始执行必须返回进行中的 message/part');

  // 进行中：消息已可见（assistant 行懒建），trace 形状保持 {tool,args,result}
  const mid = await sessions.loadSession(s.id);
  assert.equal(mid.messages.length, 2);
  assert.equal(mid.messages[1].role, 'assistant');
  assert.deepEqual(mid.messages[1].trace, [{ tool: 'run_command', args, result: null }]);

  const raw0 = openRaw(dir);
  try {
    const part = raw0.prepare('SELECT * FROM part WHERE id = ?').get(started.partId);
    assert.ok(part, 'running part 必须已落库');
    const data = JSON.parse(part.data_json);
    assert.equal(data.status, 'running');
    assert.equal(data.name, 'run_command');
    assert.equal(data.args, args);
    assert.equal(data.result, null);
    assert.equal(data.ms, null);
    assert.equal(toolPartRows(raw0, started.messageId).length, 1);
  } finally { raw0.close(); }

  const ended = await sessions.appendToolEnd(s.id, {
    callId: 'call-1', name: 'run_command', status: 'ok', result: { stdout: 'a.txt' }, error: null, ms: 42,
  });
  assert.equal(ended.partId, started.partId, '结束必须更新同一条 part，而不是新插一条');

  const raw1 = openRaw(dir);
  try {
    const part = raw1.prepare('SELECT * FROM part WHERE id = ?').get(started.partId);
    const data = JSON.parse(part.data_json);
    assert.equal(data.status, 'ok');
    assert.deepEqual(data.result, { stdout: 'a.txt' });
    assert.equal(data.error, null);
    assert.equal(data.ms, 42);
    assert.equal(toolPartRows(raw1, started.messageId).length, 1, '同一个工具只能有一条 part');
  } finally { raw1.close(); }

  // 回合收尾：同一个 message id 补正文/耗时，不重复插入 assistant 消息
  await sessions.appendAssistantMessage(s.id, {
    content: '跑完了',
    reasoning: '先跑命令看输出。',
    trace: [{ tool: 'run_command', args, result: { stdout: 'a.txt' } }],
    workedMs: 99,
    interrupted: false,
    error: null,
  });
  const loaded = await sessions.loadSession(s.id);
  assert.equal(loaded.messages.length, 2, '收尾不能重复插入 assistant 消息');
  assert.equal(loaded.messages[1].content, '跑完了');
  assert.equal(loaded.messages[1].reasoning, '先跑命令看输出。');
  assert.equal(loaded.messages[1].workedMs, 99);
  assert.equal(loaded.messages[1].interrupted, false);
  assert.deepEqual(loaded.messages[1].trace, [{ tool: 'run_command', args, result: { stdout: 'a.txt' } }], 'trace 形状不变');

  const raw2 = openRaw(dir);
  try {
    assert.equal(raw2.prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?').get(s.id).n, 2);
    assert.equal(raw2.prepare('SELECT COUNT(*) AS n FROM part WHERE message_id = ?').get(started.messageId).n, 3, 'text/reasoning/tool 三段');
  } finally { raw2.close(); }
});

test('工具失败：同一 part 更新为 fail，error/result/ms 正确', async (t) => {
  const dir = await freshDir(t);
  const s = await sessions.newSession('工具失败');
  await sessions.appendUserMessage(s.id, '跑一个会失败的命令');
  const args = '{"command":"definitely-not-a-command"}';
  const started = await sessions.appendToolStart(s.id, { callId: 'call-bad', name: 'run_command', args });
  const ended = await sessions.appendToolEnd(s.id, {
    callId: 'call-bad', name: 'run_command', status: 'fail', result: { error: 'boom' }, error: 'boom', ms: 17,
  });
  assert.equal(ended.partId, started.partId);
  const raw = openRaw(dir);
  try {
    const data = JSON.parse(raw.prepare('SELECT data_json FROM part WHERE id = ?').get(started.partId).data_json);
    assert.equal(data.status, 'fail');
    assert.equal(data.error, 'boom');
    assert.deepEqual(data.result, { error: 'boom' });
    assert.equal(data.ms, 17);
    assert.equal(toolPartRows(raw, started.messageId).length, 1);
  } finally { raw.close(); }
});

test('崩溃语义：只写 running 就被杀，重开库 loadSession 仍能看到该工具与已中断标记', async (t) => {
  const dir = await freshDir(t, 'fc-toolparts-crash-');
  const s = await sessions.newSession('崩溃恢复');
  await sessions.appendUserMessage(s.id, '开始跑长工具');
  const args = '{"command":"node long-task.mjs"}';
  const started = await sessions.appendToolStart(s.id, { callId: 'call-crash', name: 'run_command', args });
  assert.ok(started?.messageId);

  const raw0 = openRaw(dir);
  try {
    const data = JSON.parse(raw0.prepare('SELECT data_json FROM part WHERE id = ?').get(started.partId).data_json);
    assert.equal(data.status, 'running', '进程内立即可见 running');
  } finally { raw0.close(); }

  sessions.closeAllSessionDatabases(); // 模拟进程被杀（WAL 由下次打开恢复）

  const reopened = await sessions.loadSession(s.id);
  assert.equal(reopened.messages.length, 2, '进行中的 assistant 行不能消失');
  assert.equal(reopened.messages[1].role, 'assistant');
  assert.equal(reopened.messages[1].interrupted, true, '等价「未完成」标记：已中断');
  assert.deepEqual(reopened.messages[1].trace, [{ tool: 'run_command', args, result: null }], 'trace 形状仍是原样数组');

  const raw1 = openRaw(dir);
  try {
    const data = JSON.parse(raw1.prepare('SELECT data_json FROM part WHERE id = ?').get(started.partId).data_json);
    assert.equal(data.status, 'running', '重启后 part 仍是 running（未完成证据保留）');
  } finally { raw1.close(); }

  // 下一轮用户消息到来：上一轮进行中行封口（still 可见），不能把新回合挂到旧 message 上
  await sessions.appendUserMessage(s.id, '继续排查');
  const afterNext = await sessions.loadSession(s.id);
  assert.equal(afterNext.messages.length, 3);
  assert.equal(afterNext.messages[1].interrupted, true);
  const raw2 = openRaw(dir);
  try {
    const msg = raw2.prepare('SELECT * FROM message WHERE id = ?').get(started.messageId);
    assert.equal(msg.interrupted, 1, '封口后的消息行持久标记中断');
    const data = JSON.parse(raw2.prepare('SELECT data_json FROM part WHERE id = ?').get(started.partId).data_json);
    assert.equal(data.status, 'fail', '封口后 running 不永远停在进行中');
    assert.match(String(data.error), /未完成/);
  } finally { raw2.close(); }
});

test('参数绑定：工具名/参数/结果里的引号、--、DROP 不注入也不截断', async (t) => {
  const dir = await freshDir(t, 'fc-toolparts-bind-');
  const s = await sessions.newSession("x'); DROP TABLE session; --");
  await sessions.appendUserMessage(s.id, "'; DELETE FROM message; --");
  const name = "run'); DROP TABLE part; --";
  const longPayload = 'a'.repeat(6000);
  const args = `{"command":"echo 'x'; DROP TABLE message; --\nSELECT * FROM part WHERE x='y'; --","payload":"${longPayload}"}`;
  const result = { text: "'; DELETE FROM session; --", sql: "SELECT * FROM part WHERE name = 'a'", payload: longPayload };
  const started = await sessions.appendToolStart(s.id, { callId: "c'); --", name, args });
  await sessions.appendToolEnd(s.id, { callId: "c'); --", name, status: 'ok', result, error: null, ms: 5 });
  await sessions.appendAssistantMessage(s.id, {
    content: "回答 'quoted' -- ;DROP",
    trace: [{ tool: name, args, result }],
  });

  const raw = openRaw(dir);
  try {
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(tables.sort(), ['message', 'part', 'session', 'session_meta'], '注入字符串不能删表');
    const part = raw.prepare('SELECT * FROM part WHERE id = ?').get(started.partId);
    const data = JSON.parse(part.data_json);
    assert.equal(data.name, name, '工具名原样保存');
    assert.equal(data.args, args, '参数不得截断（含 6000 字符 payload）');
    assert.deepEqual(data.result, result, '结果原样保存');
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?').get(s.id).n, 2);
  } finally { raw.close(); }

  const loaded = await sessions.loadSession(s.id);
  assert.equal(loaded.title, "'; DELETE FROM message; --", '首条用户消息成为标题，原样保存');
  assert.equal(loaded.messages[1].content, "回答 'quoted' -- ;DROP");
  assert.deepEqual(loaded.messages[1].trace, [{ tool: name, args, result }]);
});

test('写入频率：一次长工具全程只写 2 次 part（开始 INSERT + 结束 UPDATE）', async (t) => {
  const dir = await freshDir(t, 'fc-toolparts-freq-');
  const s = await sessions.newSession('频率');
  await sessions.appendUserMessage(s.id, '跑长工具');

  const proto = Database.prototype;
  const original = proto.prepare;
  const writes = [];
  proto.prepare = function patchedPrepare(sql) {
    const stmt = original.call(this, sql);
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value === 'function' && ['run', 'get', 'all', 'iterate'].includes(prop)) {
          return (...args) => {
            if (prop === 'run' && /INSERT\s+INTO\s+part|UPDATE\s+part/i.test(String(sql))) writes.push(String(sql));
            return value.apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try {
    const args = `{"command":"node long-task.mjs","note":"${'x'.repeat(3000)}"}`;
    const started = await sessions.appendToolStart(s.id, { callId: 'call-long', name: 'run_command', args });
    await new Promise((r) => setTimeout(r, 60)); // 模拟长工具：期间没有任何 delta 写
    await sessions.appendToolEnd(s.id, {
      callId: 'call-long', name: 'run_command', status: 'ok', result: { stdout: 'done' }, error: null, ms: 60,
    });
    assert.equal(writes.length, 2, '长工具期间 part 写入必须 ≤ 2：' + writes.join(' | '));
    const raw = openRaw(dir);
    try { assert.equal(toolPartRows(raw, started.messageId).length, 1); } finally { raw.close(); }
  } finally {
    proto.prepare = original;
  }
});

test('端到端（模拟 index 接线）：工具事件按队列落库，回合收尾复用同一 assistant 行', async (t) => {
  process.env.FINALCHECK_SESSION_STORE = 'sqlite';
  const dir = await freshDir(t, 'fc-toolparts-e2e-');
  const s = await sessions.newSession('端到端');
  await sessions.appendUserMessage(s.id, '跑一次命令');
  const { runAgentTurn } = await import('../desktop/src/main/agent-service.mjs');
  const sse = (chunks) => new Response(chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
  let round = 0;
  const mockFetch = async () => {
    round += 1;
    if (round === 1) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'e2e-1', function: { name: 'run_command', arguments: '{"command":"echo hi"}' } }] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: '命令已完成' } }] }]);
  };
  // 与 index.mjs 相同：回调里不 await（withQueue 保证 start→end→收尾的顺序）
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [{ role: 'user', content: '跑一次命令' }],
    tools: { run_command: async () => ({ stdout: 'hi' }) },
    fetchImpl: mockFetch,
    onToolLifecycle: (ev) => {
      const base = { callId: ev.id ?? null, name: ev.name ?? '', args: ev.args ?? '' };
      if (ev.phase === 'start') void sessions.appendToolStart(s.id, base);
      else if (ev.phase === 'end') void sessions.appendToolEnd(s.id, {
        ...base, status: ev.status, result: ev.result, error: ev.error, ms: ev.ms,
      });
    },
  });
  assert.equal(out.answer, '命令已完成');
  await sessions.appendAssistantMessage(s.id, {
    content: out.answer, trace: out.trace, workedMs: out.workedMs,
  });
  const loaded = await sessions.loadSession(s.id);
  assert.equal(loaded.messages.length, 2, '端到端只产生 user + assistant 两条消息');
  assert.deepEqual(loaded.messages[1].trace, out.trace, 'trace 与实际工具结果一致');
  const raw = openRaw(dir);
  try {
    const assistant = raw.prepare('SELECT id FROM message WHERE session_id = ? AND role = ?').get(s.id, 'assistant');
    const tools = toolPartRows(raw, assistant.id);
    assert.equal(tools.length, 1);
    const data = JSON.parse(tools[0].data_json);
    assert.equal(data.status, 'ok');
    assert.deepEqual(data.result, { stdout: 'hi' });
    assert.ok(Number.isFinite(data.ms));
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM part WHERE message_id = ?').get(assistant.id).n, 3);
    assert.equal(raw.prepare('SELECT value FROM session_meta WHERE key = ?').get('pending:' + s.id), undefined, '收尾后 pending meta 必须清掉');
  } finally { raw.close(); }
});

test('纯 Node JSON 后端：工具生命周期 no-op，行为保持现状', async (t) => {
  process.env.FINALCHECK_SESSION_STORE = 'json';
  const dir = await mkdtemp(path.join(root, 'fc-toolparts-json-'));
  process.env.FINALCHECK_SESSIONS_DIR = dir;
  t.after(async () => {
    process.env.FINALCHECK_SESSION_STORE = 'sqlite';
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  const s = await sessions.newSession('JSON 后端');
  await sessions.appendUserMessage(s.id, '问');
  assert.equal(await sessions.appendToolStart(s.id, { callId: 'c1', name: 'run_command', args: '{}' }), null);
  assert.equal(await sessions.appendToolEnd(s.id, { callId: 'c1', name: 'run_command', status: 'ok', result: { ok: 1 }, ms: 3 }), null);
  const loaded = await sessions.loadSession(s.id);
  assert.equal(loaded.messages.length, 1, 'JSON 后端不能被工具生命周期改动');
});

test('agent-service：onToolLifecycle 发出开始/结束（不进 onEvent 的渲染层事件流）', async () => {
  const { runAgentTurn } = await import('../desktop/src/main/agent-service.mjs');
  const sse = (chunks) => new Response(chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
  const fullArgs = JSON.stringify({ path: 'D:/x', note: 'y'.repeat(3000) });
  const bodies = [];
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return sse([{ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'id-ok', function: { name: 'read_file', arguments: fullArgs } },
        { index: 1, id: 'id-bad', function: { name: 'run_command', arguments: '{"command":"bad"}' } },
      ] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: '完成' } }] }]);
  };
  const lifecycle = [];
  const renderEvents = [];
  const out = await runAgentTurn({
    config: { baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' },
    messages: [{ role: 'user', content: '跑工具' }],
    tools: {
      read_file: async () => ({ ok: true }),
      run_command: async () => ({ error: 'boom' }),
    },
    fetchImpl: mockFetch,
    onEvent: (ev) => renderEvents.push(ev),
    onToolLifecycle: (ev) => lifecycle.push(ev),
  });
  assert.equal(out.answer, '完成');
  const starts = lifecycle.filter((e) => e.phase === 'start');
  const ends = lifecycle.filter((e) => e.phase === 'end');
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.equal(starts[0].args, fullArgs, '生命周期钩子拿到完整参数（不是渲染层 2000 字截断）');
  const endOk = ends.find((e) => e.id === 'id-ok');
  const endBad = ends.find((e) => e.id === 'id-bad');
  assert.equal(endOk.status, 'ok');
  assert.deepEqual(endOk.result, { ok: true });
  assert.ok(Number.isFinite(endOk.ms));
  assert.equal(endBad.status, 'fail');
  assert.equal(endBad.error, 'boom');
  assert.deepEqual(endBad.result, { error: 'boom' });
  // 渲染层事件：tool-start 带 at（运行中显示已耗时）；tool-end 带裁剪后的 result 摘要
  // （F5：没有 result，「已转后台 PID xxx」这类 note 就到不了界面；但不允许把大对象塞进 IPC）
  const rendered = renderEvents.filter((e) => e.kind === 'tool-start' || e.kind === 'tool-end');
  assert.equal(rendered.length, 4);
  assert.ok(rendered.filter((e) => e.kind === 'tool-start').every((e) => Number.isFinite(e.at)), 'tool-start 要带开始时刻');
  const renderedEnds = rendered.filter((e) => e.kind === 'tool-end');
  assert.ok(renderedEnds.every((e) => 'result' in e), 'tool-end 必须带摘要，界面才能显示 note');
  assert.ok(renderedEnds.every((e) => JSON.stringify(e.result ?? null).length <= 600), '摘要必须裁剪，不能把大对象塞进事件流');
  assert.deepEqual(renderedEnds.find((e) => e.id === 'id-ok').result, { ok: true }, '小结果原样保留');
});

// 启动收尾（P1，2026-11-11）：进程崩溃/被强杀遗留的 running 工具必须变成 interrupted，
// 否则卡片永远显示「运行中」，工作流恢复入口也没有明确的中断状态。
test('启动收尾：遗留 running 工具 → interrupted（幂等，已结束的不动）', async (t) => {
  const dir = await freshDir(t, 'fc-interrupted-');
  const s = await sessions.newSession('崩溃收尾');
  await sessions.appendToolStart(s.id, { callId: 'call-crash', name: 'run_command', args: { cmd: 'sleep 999' } });
  await sessions.appendToolStart(s.id, { callId: 'call-done', name: 'read_file', args: { path: 'a.txt' } });
  await sessions.appendToolEnd(s.id, { callId: 'call-done', name: 'read_file', result: { ok: true } });

  const n = await sessions.markInterruptedRunningParts(dir);
  assert.equal(n, 1, '只应该改那一条还挂着 running 的');

  const raw = openRaw(dir);
  try {
    const rows = raw.prepare("SELECT data_json FROM part WHERE type='tool' ORDER BY seq ASC").all();
    const parsed = rows.map((r) => JSON.parse(r.data_json));
    const crashed = parsed.find((p) => p.callId === 'call-crash');
    const done = parsed.find((p) => p.callId === 'call-done');
    assert.equal(crashed.status, 'interrupted', '崩溃的工具必须落成 interrupted，不是 running/fail');
    assert.equal(crashed.interrupted, true);
    assert.equal(crashed.interruptReason, 'APP_RESTART', '只存原因码，文案由界面渲染');
    assert.notEqual(done.status, 'interrupted', '正常结束的工具不能被改');
  } finally { raw.close(); }

  // 幂等：再跑一次不应该再改任何东西
  assert.equal(await sessions.markInterruptedRunningParts(dir), 0);
});

test('启动收尾：没有库的项目目录不会凭空建库', async (t) => {
  const dir = await freshDir(t, 'fc-interrupted-empty-');
  const n = await sessions.markInterruptedRunningParts(dir);
  assert.equal(n, 0);
  assert.equal(existsSync(dbIn(dir)), false, '没跑过会话的项目不该被建一个空库');
});

// 生产调用语义（P1，2026-11-11）：index.mjs 传给收尾函数的是「项目根」。
// 库在 <项目>/.finalcheck/finalcheck.db，如果不识别项目根，就会去查 <项目>/finalcheck.db（不存在）
// → 永远 return 0，遗留 running 工具跨重启一直转圈。
test('启动收尾：传项目根（生产调用语义）也能清掉遗留 running，且库在 .finalcheck 下', async (t) => {
  const proj = await freshDir(t, 'fc-interrupted-root-');
  const sessDir = path.join(proj, '.finalcheck', 'sessions');
  process.env.FINALCHECK_SESSIONS_DIR = sessDir; // 和 index.mjs 的 sessionDirOf 一致
  const s = await sessions.newSession('项目根收尾');
  await sessions.appendToolStart(s.id, { callId: 'call-root', name: 'run_command', args: { cmd: 'sleep 999' } });

  const projectDb = path.join(proj, '.finalcheck', 'finalcheck.db');
  assert.ok(existsSync(projectDb), '会话库必须落在 <项目>/.finalcheck/finalcheck.db');

  const n = await sessions.markInterruptedRunningParts(proj); // ← 传项目根，不是 sessions 目录
  assert.equal(n, 1, '传项目根也必须收尾，不能静默 no-op');

  const raw = openRaw(path.join(proj, '.finalcheck'));
  try {
    const row = raw.prepare("SELECT data_json FROM part WHERE type='tool'").get();
    assert.equal(JSON.parse(row.data_json).status, 'interrupted');
  } finally { raw.close(); }
});

test('启动收尾：项目根下没有 .finalcheck 库时不建库（不污染项目目录）', async (t) => {
  const proj = await freshDir(t, 'fc-interrupted-root-empty-');
  assert.equal(await sessions.markInterruptedRunningParts(proj), 0);
  assert.equal(existsSync(path.join(proj, 'finalcheck.db')), false, '不能在项目根建库');
  assert.equal(existsSync(path.join(proj, '.finalcheck', 'finalcheck.db')), false, '没跑过会话就不该建库');
});
