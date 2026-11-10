// SQLite 会话存储层测试（生产后端）：
// FINALCHECK_SESSION_STORE=sqlite 时，sessions.mjs 使用 <sessionsDir>/finalcheck.db
// （sessionsDir = <project>/.finalcheck/sessions 时 DB 落在 <project>/.finalcheck/finalcheck.db）。
// 纯 Node 运行时通过 prebuilds-node 里的 Node ABI 二进制加载（Electron 用 build/Release）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const Database = require('better-sqlite3');
const bs3Entry = require.resolve('better-sqlite3');
const nodeBinding = path.join(path.dirname(bs3Entry), '..', 'prebuilds-node', 'better_sqlite3.node');

process.env.FINALCHECK_SESSION_STORE = 'sqlite';
const root = await mkdtemp(path.join(os.tmpdir(), 'fc-sessions-sqlite-'));
process.env.FINALCHECK_SESSIONS_DIR = root;
const sessions = await import('../desktop/src/main/sessions.mjs');

const openRaw = (dbFile) => new Database(dbFile, { nativeBinding: nodeBinding });
const exists = (file) => access(file).then(() => true, () => false);
const dbIn = (dir) => path.join(dir, 'finalcheck.db');
const projectDbIn = (projectRoot) => path.join(projectRoot, '.finalcheck', 'finalcheck.db');

async function freshDir(t, prefix = 'fc-sqlite-one-') {
  const dir = await mkdtemp(path.join(root, prefix));
  process.env.FINALCHECK_SESSIONS_DIR = dir;
  t.after(async () => {
    sessions.closeAllSessionDatabases();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

test('SQLite 往返：message/part 落库，trace 可原样还原，schema/WAL 正确', async (t) => {
  const dir = await freshDir(t);
  const s = await sessions.newSession('往返');
  await sessions.appendUserMessage(s.id, '第一问');
  const trace = [
    { tool: 'read_file', args: '{"file":"a.mjs"}', result: { added: 1, removed: 0 } },
    { tool: 'grep', args: '{"q":"needle"}', result: [{ line: 3, text: 'needle' }] },
  ];
  await sessions.appendAssistantMessage(s.id, {
    content: '第一答',
    reasoning: '先取证再下结论。',
    trace,
    workedMs: 1234,
    interrupted: false,
    error: null,
  });
  const loaded = await sessions.loadSession(s.id);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].role, 'user');
  assert.equal(loaded.messages[0].content, '第一问');
  assert.equal(loaded.messages[1].reasoning, '先取证再下结论。');
  assert.equal(loaded.messages[1].workedMs, 1234);
  assert.deepEqual(loaded.messages[1].trace, trace, 'trace 经 part 表原样还原');
  const list = await sessions.listSessions();
  assert.equal(list.find((x) => x.id === s.id).turns, 1);
  const beforeModel = (await sessions.loadSession(s.id)).updatedAt;
  await sessions.setModelConfig(s.id, { providerId: 'prov-a', model: 'model-a', effort: 'max' });
  const withModel = await sessions.loadSession(s.id);
  assert.deepEqual(withModel.modelConfig, { providerId: 'prov-a', model: 'model-a', effort: 'max' });
  assert.equal(withModel.updatedAt, beforeModel, '改模型配置不能把会话顶到最前');

  const raw = openRaw(dbIn(dir));
  try {
    assert.equal(raw.pragma('journal_mode', { simple: true }), 'wal');
    const cols = (table) => raw.pragma('table_info(' + table + ')').map((c) => c.name);
    assert.deepEqual(cols('session'), ['id', 'title', 'created_at', 'updated_at', 'pinned', 'archived', 'unread', 'model_config_json']);
    assert.deepEqual(cols('message'), ['id', 'session_id', 'seq', 'role', 'content', 'error', 'interrupted', 'reasoning', 'worked_ms', 'created_at']);
    assert.deepEqual(cols('part'), ['id', 'message_id', 'seq', 'type', 'data_json']);
    assert.deepEqual(cols('session_meta'), ['key', 'value']);
    const schemaVersion = raw.prepare('SELECT value FROM session_meta WHERE key = ?').get('schema_version');
    assert.equal(schemaVersion.value, '1');
    const assistant = raw.prepare('SELECT * FROM message WHERE session_id = ? AND role = ?').get(s.id, 'assistant');
    const parts = raw.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY seq ASC').all(assistant.id);
    assert.deepEqual(parts.map((p) => p.type), ['text', 'reasoning', 'tool', 'tool']);
    const toolData = JSON.parse(parts[2].data_json);
    assert.deepEqual(Object.keys(toolData).sort(), ['args', 'error', 'ms', 'name', 'result', 'status']);
    assert.equal(toolData.status, 'success');
    assert.equal(toolData.name, 'read_file');
  } finally {
    raw.close();
  }
});

test('listSessions 只查 session/索引计数，不读消息体（SQL 捕获断言）', async (t) => {
  await freshDir(t);
  const s = await sessions.newSession('大会话');
  await sessions.appendUserMessage(s.id, '问');
  await sessions.appendAssistantMessage(s.id, { content: 'x'.repeat(1024 * 1024), reasoning: 'y'.repeat(2048) });
  await sessions.listSessions(); // 预热 schema / 迁移，不参与本次断言

  const proto = Database.prototype;
  const original = proto.prepare;
  const calls = [];
  proto.prepare = function patchedPrepare(sql) {
    const stmt = original.call(this, sql);
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value === 'function' && ['get', 'all', 'run', 'iterate', 'pluck', 'expand'].includes(prop)) {
          return (...args) => { calls.push(String(sql)); return value.apply(target, args); };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try {
    const list = await sessions.listSessions();
    assert.equal(list.find((x) => x.id === s.id).turns, 1);
  } finally {
    proto.prepare = original;
  }
  assert.ok(calls.length >= 2, '列表至少执行 session 查询与轮数查询');
  for (const sql of calls) {
    assert.doesNotMatch(sql, /\bcontent\b|\breasoning\b|\btrace\b|\berror\b|\bdata_json\b/i, '列表 SQL 不应读取消息体列：' + sql);
    assert.doesNotMatch(sql, /FROM\s+part\b/i, '列表不应扫描 part 表：' + sql);
    assert.doesNotMatch(sql, /FROM\s+message\b/i, '列表不应扫描 message 表：' + sql);
  }
});

test('旧 JSON 迁移：只读导入、幂等、DB 落在 .finalcheck/finalcheck.db', async (t) => {
  const project = await mkdtemp(path.join(root, 'fc-sqlite-mig-'));
  const sessionsDir = path.join(project, '.finalcheck', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
  t.after(async () => {
    sessions.closeAllSessionDatabases();
    await rm(project, { recursive: true, force: true }).catch(() => {});
  });

  const id = randomUUID();
  const legacy = {
    id,
    title: '旧会话',
    createdAt: 1000,
    updatedAt: 2000,
    pinned: true,
    usage: { prompt: 9, cached: 5 },
    summary: '旧摘要',
    summaryAt: 1500,
    messages: [
      { role: 'user', content: '旧问题', at: 1100 },
      {
        role: 'assistant', content: '旧回答', error: null, interrupted: false,
        reasoning: '旧思考', trace: [{ tool: 'read_file', args: '{}', result: { added: 2 } }],
        workedMs: 66, at: 1200,
      },
      { role: 'notice', kind: 'compact', content: '压缩过', at: 1300 },
    ],
  };
  const legacyFile = path.join(sessionsDir, 'session-' + id + '.json');
  await writeFile(legacyFile, JSON.stringify(legacy), 'utf8');

  const first = await sessions.listSessions();
  assert.equal(first.filter((x) => x.id === id).length, 1);
  const loaded = await sessions.loadSession(id);
  assert.equal(loaded.title, '旧会话');
  assert.equal(loaded.pinned, true);
  assert.deepEqual(loaded.usage, legacy.usage);
  assert.equal(loaded.summary, '旧摘要');
  assert.equal(loaded.messages.length, 3);
  assert.equal(loaded.messages[1].trace[0].tool, 'read_file');

  const dbFile = projectDbIn(project);
  assert.equal(await exists(dbFile), true, 'DB 必须落在 <project>/.finalcheck/finalcheck.db');
  assert.equal(await readFile(legacyFile, 'utf8'), JSON.stringify(legacy), '旧 JSON 不允许被改写');

  const countRaw = () => {
    const raw = openRaw(dbFile);
    try {
      return {
        sessions: raw.prepare('SELECT COUNT(*) AS n FROM session').get().n,
        messages: raw.prepare('SELECT COUNT(*) AS n FROM message').get().n,
        parts: raw.prepare('SELECT COUNT(*) AS n FROM part').get().n,
      };
    } finally { raw.close(); }
  };
  assert.deepEqual(countRaw(), { sessions: 1, messages: 3, parts: 4 });
  sessions.closeAllSessionDatabases(); // 模拟下次启动
  await sessions.listSessions();
  await sessions.loadSession(id);
  sessions.closeAllSessionDatabases();
  assert.deepEqual(countRaw(), { sessions: 1, messages: 3, parts: 4 }, '重复导入不能产生重复消息');
  assert.equal(await exists(legacyFile), true, '旧 JSON 不允许删除');
});

test('崩溃语义：appendUserMessage 立即可见，关闭连接重开后仍在（WAL）', async (t) => {
  await freshDir(t);
  const s = await sessions.newSession();
  await sessions.appendUserMessage(s.id, '发送即落盘');
  const mid = await sessions.loadSession(s.id);
  assert.equal(mid.messages.length, 1, '同一连接立即可读');
  assert.equal(mid.title, '发送即落盘');

  sessions.closeAllSessionDatabases(); // 相当于进程退出（未 checkpoint 的 WAL 由下次打开恢复）
  const reopened = await sessions.loadSession(s.id);
  assert.equal(reopened.messages.length, 1);
  assert.equal(reopened.messages[0].content, '发送即落盘');

  await sessions.appendAssistantMessage(s.id, { content: '回答' });
  sessions.closeAllSessionDatabases();
  const pm = await sessions.loadSession(s.id);
  assert.deepEqual(pm.messages.map((m) => m.role), ['user', 'assistant']);
});

test('参数绑定：标题/内容里的引号、注释、DROP 不会注入或被截断', async (t) => {
  const dir = await freshDir(t);
  const evilTitle = "x'); DROP TABLE session; --";
  const evilBody = "'; DELETE FROM message; --\n第二行 'quoted'";
  const s = await sessions.newSession(evilTitle);
  const loadedNew = await sessions.loadSession(s.id);
  assert.equal(loadedNew.title, evilTitle);

  await sessions.appendUserMessage(s.id, evilBody);
  await sessions.renameSession(s.id, "'); DELETE FROM session_meta; --");
  const loaded = await sessions.loadSession(s.id);
  assert.equal(loaded.title, "'); DELETE FROM session_meta; --");
  assert.equal(loaded.messages[0].content, evilBody);

  const raw = openRaw(dbIn(dir));
  try {
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(tables.sort(), ['message', 'part', 'session', 'session_meta']);
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM session').get().n, 1);
    const meta = raw.prepare('SELECT value FROM session_meta WHERE key = ?').get('schema_version');
    assert.equal(meta.value, '1');
  } finally { raw.close(); }
  const another = await sessions.newSession('注入后仍可用');
  assert.equal((await sessions.loadSession(another.id)).title, '注入后仍可用');
});

test('moveSessionTo 跨 DB 搬运（target upsert），deleteSession 只删记录保留 DB 文件', async (t) => {
  const projA = await mkdtemp(path.join(root, 'fc-sqlite-proj-a-'));
  const projB = await mkdtemp(path.join(root, 'fc-sqlite-proj-b-'));
  const dirA = path.join(projA, '.finalcheck', 'sessions');
  const dirB = path.join(projB, '.finalcheck', 'sessions');
  await mkdir(dirA, { recursive: true });
  await mkdir(dirB, { recursive: true });
  process.env.FINALCHECK_SESSIONS_DIR = dirA;
  sessions.setSessionDirResolver(null);
  t.after(async () => {
    sessions.setSessionDirResolver(null);
    sessions.closeAllSessionDatabases();
    await rm(projA, { recursive: true, force: true }).catch(() => {});
    await rm(projB, { recursive: true, force: true }).catch(() => {});
  });

  const s = await sessions.newSession('搬家');
  await sessions.appendUserMessage(s.id, '旧消息');
  await sessions.appendAssistantMessage(s.id, { content: '旧回答' });

  const moved = await sessions.moveSessionTo(s.id, dirB);
  assert.equal(moved.path, projectDbIn(projB));
  assert.equal(await exists(projectDbIn(projA)), true, '源 DB 文件保留');
  assert.equal(await exists(projectDbIn(projB)), true, '目标 DB 文件创建');

  sessions.setSessionDirResolver((sid) => (sid === s.id ? dirB : null));
  const loaded = await sessions.loadSession(s.id);
  assert.deepEqual(loaded.messages.map((m) => m.content), ['旧消息', '旧回答']);
  await sessions.appendAssistantMessage(s.id, { content: '搬家后继续写' });

  const rawA = openRaw(projectDbIn(projA));
  try { assert.equal(rawA.prepare('SELECT COUNT(*) AS n FROM session').get().n, 0, '源 DB 记录已移除'); } finally { rawA.close(); }
  const rawB = openRaw(projectDbIn(projB));
  try {
    assert.equal(rawB.prepare('SELECT COUNT(*) AS n FROM session').get().n, 1);
    assert.equal(rawB.prepare('SELECT COUNT(*) AS n FROM message').get().n, 3);
  } finally { rawB.close(); }

  await sessions.deleteSession(s.id);
  assert.equal(await exists(projectDbIn(projB)), true, '删会话不删 DB 文件');
  const rawB2 = openRaw(projectDbIn(projB));
  try {
    assert.equal(rawB2.prepare('SELECT COUNT(*) AS n FROM session').get().n, 0);
    assert.equal(rawB2.prepare('SELECT COUNT(*) AS n FROM message').get().n, 0);
  } finally { rawB2.close(); }
});

test('旧的空 DB（缺表）打开时幂等补建 schema', async (t) => {
  const dir = await freshDir(t);
  const dbFile = dbIn(dir);
  const empty = new Database(dbFile, { nativeBinding: nodeBinding });
  empty.close();
  assert.equal(await exists(dbFile), true);
  const s = await sessions.newSession('补建');
  assert.equal((await sessions.loadSession(s.id)).title, '补建');
  const raw = openRaw(dbFile);
  try {
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(tables.sort(), ['message', 'part', 'session', 'session_meta']);
    assert.equal(raw.prepare('SELECT value FROM session_meta WHERE key = ?').get('schema_version').value, '1');
  } finally { raw.close(); }
});

test('跨项目发现：findSessionDir 能按 DB 查到没有 JSON 文件的会话', async (t) => {
  const project = await mkdtemp(path.join(root, 'fc-sqlite-find-'));
  const sessionsDir = path.join(project, '.finalcheck', 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
  t.after(async () => {
    sessions.closeAllSessionDatabases();
    await rm(project, { recursive: true, force: true }).catch(() => {});
  });
  const s = await sessions.newSession('跨项目');
  await sessions.appendUserMessage(s.id, '只存在 DB 里');
  assert.equal(await exists(path.join(sessionsDir, 'session-' + s.id + '.json')), false);
  sessions.closeAllSessionDatabases();
  const reg = await import('../desktop/src/main/session-projects.mjs');
  reg.resetSessionDirs();
  assert.equal(await reg.findSessionDir(s.id, [sessionsDir]), path.resolve(sessionsDir));
  assert.equal(await reg.findSessionDir(randomUUID(), [sessionsDir]), null);
});
