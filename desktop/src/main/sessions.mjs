// 会话持久化：DeepSeek 式多会话。
// 两种后端（对外签名 / 返回形状完全一致，渲染层无感）：
// - sqlite（生产默认，Electron 运行时）：<项目>/.finalcheck/finalcheck.db，WAL，参数绑定；
// - json（兼容旧测试 / FINALCHECK_SESSION_STORE=json）：<项目>/.finalcheck/sessions/session-<id>.json。
// 旧 JSON 只在 sqlite 后端首次打开该项目时「只读导入」，永不删除/覆盖。
import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// 双语：默认会话标题会写进库并显示在侧栏（zh 下 t() 原样返回，写库内容不变）
import { t } from '../renderer/i18n/core.mjs';

// 目录惰性解析：主进程在 app ready 后把 FINALCHECK_SESSIONS_DIR 指到「当前项目」，
// 这样打包版升级/重开都不会丢历史（仍兼容测试临时目录）。
// 会话级覆盖：主进程通过 setSessionDirResolver 注入「会话 → 它所属项目目录」的解析器，
// 切项目后旧会话的读写仍落在它自己的项目目录（ZCode 语义：切 Workspace 只切 UI 视角）。
const defaultDir = () => process.env.FINALCHECK_SESSIONS_DIR
  ? path.resolve(process.env.FINALCHECK_SESSIONS_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'sessions');
const OK_ID = /^[a-f0-9-]{8,64}$/;
const SESSION_FILE = /^session-([a-f0-9-]{8,64})\.json$/;
const DB_FILE = 'finalcheck.db';
const SCHEMA_VERSION = '1';

let sessionDirResolver = null;
export function setSessionDirResolver(fn) {
  sessionDirResolver = typeof fn === 'function' ? fn : null;
  return sessionDirResolver;
}

/** 会话实际落盘目录：已登记的按它所属项目，未登记/解析失败回退全局默认目录（不抛错） */
export function dirFor(sessionId = null) {
  if (sessionId) {
    try {
      const d = sessionDirResolver?.(sessionId);
      if (typeof d === 'string' && d.trim()) return path.resolve(d.trim());
    } catch { /* 解析器异常按默认目录，不能拖垮读写 */ }
  }
  return defaultDir();
}

// ---- 后端选择：Electron 生产默认 sqlite；纯 Node 单测默认 json（显式 env 优先） ----
function useSqliteStore() {
  const v = String(process.env.FINALCHECK_SESSION_STORE || '').trim().toLowerCase();
  if (v === 'sqlite') return true;
  if (v === 'json') return false;
  return !!process.versions.electron;
}

// ---- SQLite 基础设施 ----
const DDL = `
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  pinned INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0,
  model_config_json TEXT
);
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  seq INTEGER,
  role TEXT,
  content TEXT,
  error TEXT,
  interrupted INTEGER,
  reasoning TEXT,
  worked_ms INTEGER,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_message_session_seq ON message(session_id, seq);
CREATE TABLE IF NOT EXISTS part (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  seq INTEGER,
  type TEXT,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_part_message_seq ON part(message_id, seq);
CREATE TABLE IF NOT EXISTS session_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

const SQL = {
  insertSession: 'INSERT INTO session(id, title, created_at, updated_at, pinned, archived, unread, model_config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  upsertSession: 'INSERT INTO session(id, title, created_at, updated_at, pinned, archived, unread, model_config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, created_at = excluded.created_at, updated_at = excluded.updated_at, pinned = excluded.pinned, archived = excluded.archived, unread = excluded.unread, model_config_json = excluded.model_config_json',
  sessionRow: 'SELECT * FROM session WHERE id = ?',
  sessionBrief: 'SELECT title FROM session WHERE id = ?',
  insertMessage: 'INSERT INTO message(id, session_id, seq, role, content, error, interrupted, reasoning, worked_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  insertMessageOrReplace: 'INSERT OR REPLACE INTO message(id, session_id, seq, role, content, error, interrupted, reasoning, worked_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  insertPart: 'INSERT INTO part(id, message_id, seq, type, data_json) VALUES (?, ?, ?, ?, ?)',
  insertPartOrReplace: 'INSERT OR REPLACE INTO part(id, message_id, seq, type, data_json) VALUES (?, ?, ?, ?, ?)',
  updateMessage: 'UPDATE message SET content = ?, error = ?, interrupted = ?, reasoning = ?, worked_ms = ? WHERE id = ?',
  messageById: 'SELECT * FROM message WHERE id = ?',
  partsOfMessage: 'SELECT * FROM part WHERE message_id = ? ORDER BY seq ASC',
  nextToolPartSeq: "SELECT COALESCE(MAX(seq), 1) + 1 AS seq FROM part WHERE message_id = ? AND type = 'tool'",
  partById: 'SELECT * FROM part WHERE id = ?',
  updatePartData: 'UPDATE part SET data_json = ? WHERE id = ?',
  maxSeqOfSession: 'SELECT COALESCE(MAX(seq), -1) AS seq FROM message WHERE session_id = ?',
  messagesOf: 'SELECT * FROM message WHERE session_id = ? ORDER BY seq ASC',
  partsOf: 'SELECT p.* FROM part p JOIN message m ON m.id = p.message_id WHERE m.session_id = ? ORDER BY p.message_id, p.seq ASC',
  countUsers: "SELECT COUNT(*) AS n FROM message WHERE session_id = ? AND role = 'user'",
  countMessages: 'SELECT COUNT(*) AS n FROM message WHERE session_id = ?',
  turnMeta: 'SELECT key, value FROM session_meta WHERE key LIKE ?',
  nextSeq: 'SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM message WHERE session_id = ?',
  touch: 'UPDATE session SET updated_at = ? WHERE id = ?',
  setTitleAndTouch: 'UPDATE session SET title = ?, updated_at = ? WHERE id = ?',
  deletePartBySessionFromSeq: 'DELETE FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ? AND seq >= ?)',
  deleteMessageFromSeq: 'DELETE FROM message WHERE session_id = ? AND seq >= ?',
  deletePartBySession: 'DELETE FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ?)',
  deleteMessageBySession: 'DELETE FROM message WHERE session_id = ?',
  deleteSession: 'DELETE FROM session WHERE id = ?',
  sessionMetaGet: 'SELECT value FROM session_meta WHERE key = ?',
  sessionMetaSet: 'INSERT INTO session_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  sessionMetaOnce: 'INSERT INTO session_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  sessionMetaDel: 'DELETE FROM session_meta WHERE key = ?',
  listSessions: 'SELECT id, title, created_at, updated_at, pinned, archived, unread, model_config_json FROM session',
  existsInSession: 'SELECT 1 AS ok FROM session WHERE id = ?',
  setFlags: 'UPDATE session SET pinned = CASE WHEN ? THEN ? ELSE pinned END, archived = CASE WHEN ? THEN ? ELSE archived END, unread = CASE WHEN ? THEN ? ELSE unread END, updated_at = ? WHERE id = ?',
  props: 'journal_mode = WAL',
  sync: 'synchronous = NORMAL',
  busy: 'busy_timeout = 5000',
};

const metaRequire = createRequire(import.meta.url);
let BetterSqlite = null;

async function databaseClass() {
  if (!BetterSqlite) {
    const mod = await import('better-sqlite3');
    BetterSqlite = mod && mod.default ? mod.default : mod;
  }
  return BetterSqlite;
}

function betterSqlitePackageDir() {
  try {
    return path.resolve(path.dirname(metaRequire.resolve('better-sqlite3')), '..');
  } catch {
    return null;
  }
}

function assertBindingAbi(binFile, { requireMarker = false } = {}) {
  if (!existsSync(binFile)) {
    throw new Error('better-sqlite3 原生二进制不存在（' + binFile + '）：请在 desktop 执行 npm run setup:sqlite');
  }
  const marker = binFile + '.fc-abi';
  if (!existsSync(marker)) {
    if (requireMarker) throw new Error('better-sqlite3 原生二进制未准备（缺少 ' + marker + '）：请在 desktop 执行 npm run setup:sqlite');
    return;
  }
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(marker, 'utf8')); } catch { return; }
  if (parsed && parsed.abi != null && String(parsed.abi) !== String(process.versions.modules)) {
    throw new Error('better-sqlite3 原生二进制 ABI=' + parsed.abi + ' 与当前运行时 ABI=' + process.versions.modules + ' 不匹配：请在 desktop 执行 npm run setup:sqlite');
  }
}

// Electron 用默认加载路径（build/Release，由安装脚本写入 Electron ABI 二进制）；
// 纯 Node 用 prebuilds-node（经 nativeBinding 显式加载 Node ABI 二进制），避免两套运行时抢同一个文件。
function sqliteBindingOptions() {
  const pkgDir = betterSqlitePackageDir();
  if (!pkgDir) throw new Error('better-sqlite3 未安装：请在 desktop 执行 npm install');
  if (process.versions.electron) {
    const bin = path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node');
    assertBindingAbi(bin);
    return {};
  }
  const bin = path.join(pkgDir, 'prebuilds-node', 'better_sqlite3.node');
  if (!existsSync(bin)) {
    throw new Error('找不到 Node 运行时用的 better-sqlite3 二进制（' + bin + '）：请在 desktop 执行 npm run setup:sqlite');
  }
  assertBindingAbi(bin);
  return { nativeBinding: bin };
}

function dbFileFor(sessionsDir) {
  const dir = path.resolve(sessionsDir);
  if (path.basename(dir).toLowerCase() === 'sessions') {
    const parent = path.dirname(dir);
    if (path.basename(parent).toLowerCase() === '.finalcheck') return path.join(parent, DB_FILE);
  }
  return path.join(dir, DB_FILE);
}

const dbs = new Map();      // dbPath → { db, dbPath, dir, ready }
const opening = new Map();  // dbPath → Promise<entry>

async function createEntry(dbPath, sessionsDir) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const Database = await databaseClass();
  const db = new Database(dbPath, sqliteBindingOptions());
  db.pragma(SQL.props);
  db.pragma(SQL.sync);
  db.pragma(SQL.busy);
  db.exec(DDL);
  db.prepare(SQL.sessionMetaOnce).run('schema_version', SCHEMA_VERSION);
  const entry = { db, dbPath, dir: path.resolve(sessionsDir), ready: null };
  dbs.set(dbPath, entry);
  return entry;
}

async function openDb(sessionsDir) {
  const dbPath = dbFileFor(sessionsDir);
  let entry = dbs.get(dbPath);
  if (!entry) {
    if (!opening.has(dbPath)) opening.set(dbPath, createEntry(dbPath, sessionsDir));
    entry = await opening.get(dbPath);
    opening.delete(dbPath);
  }
  if (!entry.ready) entry.ready = migrateLegacy(entry);
  await entry.ready;
  return entry;
}

/** 关闭全部 SQLite 连接（测试清理临时目录 / 退出前用；正常进程退出由系统回收） */
export function closeAllSessionDatabases() {
  for (const entry of dbs.values()) {
    try { entry.db.close(); } catch { /* 已关闭 */ }
  }
  dbs.clear();
  opening.clear();
}

function getMeta(db, key) {
  const row = db.prepare(SQL.sessionMetaGet).get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare(SQL.sessionMetaSet).run(key, String(value));
}

function delMeta(db, key) {
  db.prepare(SQL.sessionMetaDel).run(key);
}

function parseJson(text, fallback = null) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function requireSession(db, id) {
  const row = db.prepare(SQL.sessionRow).get(id);
  if (!row) throw new Error('会话不存在');
  return row;
}

function nextSeq(db, id) {
  const row = db.prepare(SQL.nextSeq).get(id);
  return Number(row?.seq || 0);
}

// 轮数只在写入时维护到 session_meta，listSessions 就不用再碰 message 表（更不会读消息体）
function refreshTurns(db, id, knownCount = null) {
  const n = knownCount == null ? Number(db.prepare(SQL.countMessages).get(id)?.n || 0) : Number(knownCount) || 0;
  setMeta(db, 'turns:' + id, String(Math.floor(n / 2)));
}

function traceToData(tr) {
  const obj = tr && typeof tr === 'object' ? tr : { tool: String(tr ?? '') };
  return {
    status: typeof obj.status === 'string' ? obj.status : (obj.error ? 'error' : 'success'),
    name: String(obj.tool ?? obj.name ?? ''),
    args: obj.args === undefined ? null : obj.args,
    result: obj.result === undefined ? null : obj.result,
    error: obj.error === undefined ? null : obj.error,
    ms: obj.ms === undefined ? null : obj.ms,
  };
}

function dataToTrace(data) {
  if (!data || typeof data !== 'object') return { tool: '', args: null, result: null };
  return { tool: data.name ?? '', args: data.args ?? null, result: data.result ?? null };
}

/* ---------- 工具调用级落库（第 2 步）：running → ok/fail，崩溃后仍可见 ----------
 * 关键约束：
 *  - 只写两个点：工具开始（INSERT 一条 running part）、工具结束（UPDATE 同一条 part）；
 *  - part 挂在 message_id 上，而 assistant 消息通常回合结束才写 → 第一次工具调用时
 *    惰性建一条「进行中的 assistant 消息行」，message 行 id 存进 session_meta（pending:<id>），
 *    回合结束时用同一个 id 补 content/reasoning/worked_ms 与 text/reasoning parts，绝不重复插入；
 *  - 进程崩溃/被杀后 pending 行与 running part 仍在 DB 里，loadSession 会把它还原成
 *    「已中断」的 assistant 消息（trace 形状不变），不丢；
 *  - 所有输入（工具名/参数/结果）一律 JSON.stringify 后走 ? 参数绑定。 */
const PENDING_KEY = 'pending:';
const TOOL_PENDING_ERROR = '未完成（进程中断）';

const safeJson = (value, fallback = 'null') => {
  try { return JSON.stringify(value); } catch { return fallback; }
};

function pendingKeyOf(id) {
  return PENDING_KEY + id;
}

/** 读取当前进行中的 assistant 行（meta 指向的行不存在/不属于本会话时顺手清掉脏 meta） */
function getPending(db, id) {
  const raw = getMeta(db, pendingKeyOf(id));
  if (raw == null) return null;
  const parsed = parseJson(raw, null);
  if (!parsed || typeof parsed.id !== 'string' || !parsed.id) { delMeta(db, pendingKeyOf(id)); return null; }
  const row = db.prepare(SQL.messageById).get(parsed.id);
  if (!row || row.session_id !== id || row.role !== 'assistant') {
    delMeta(db, pendingKeyOf(id));
    return null;
  }
  const startedAt = Number(parsed.startedAt);
  return {
    id: parsed.id,
    seq: Number(row.seq),
    startedAt: Number.isFinite(startedAt) ? startedAt : (Number(row.created_at) || 0),
  };
}

/** 把进行中的 assistant 行封口成「已中断」：消息标记 interrupted，仍在跑的 tool part 标 fail（保留证据） */
function sealPending(db, id) {
  const pending = getPending(db, id);
  if (!pending) return false;
  const row = db.prepare(SQL.messageById).get(pending.id);
  if (row) {
    db.prepare(SQL.updateMessage).run(
      row.content ?? '',
      row.error ?? null,
      1,
      row.reasoning ?? '',
      row.worked_ms ?? null,
      pending.id
    );
    for (const part of db.prepare(SQL.partsOfMessage).all(pending.id)) {
      if (part.type !== 'tool') continue;
      const data = parseJson(part.data_json, null);
      if (!data || typeof data !== 'object' || data.status !== 'running') continue;
      db.prepare(SQL.updatePartData).run(safeJson({
        ...data,
        status: 'fail',
        error: data.error == null ? TOOL_PENDING_ERROR : data.error,
      }), part.id);
    }
  }
  delMeta(db, pendingKeyOf(id));
  return true;
}

/** 当前回合里仍然 running 的 tool part（tool-end 按 tool_call id / 工具名找回同一条） */
function runningToolPart(db, messageId, { callId = null, name = '' } = {}) {
  const tools = db.prepare(SQL.partsOfMessage).all(messageId)
    .filter((p) => p.type === 'tool')
    .map((p) => ({ row: p, data: parseJson(p.data_json, null) }))
    .filter((x) => x.data && typeof x.data === 'object');
  const running = tools.filter((x) => x.data.status === 'running');
  if (callId) {
    const hit = running.find((x) => x.data.callId === callId) || tools.find((x) => x.data.callId === callId);
    if (hit) return hit;
  }
  if (name) {
    const hit = running.find((x) => x.data.name === name);
    if (hit) return hit;
  }
  return running[0] || null;
}

// text/reasoning part 用确定性 id（<message>:text / <message>:reasoning）：收尾重复调用也只更新不新增
function putPart(db, messageId, seq, type, data, partId) {
  const existing = db.prepare(SQL.partById).get(partId);
  if (existing) db.prepare(SQL.updatePartData).run(safeJson(data), partId);
  else db.prepare(SQL.insertPart).run(partId, messageId, seq, type, safeJson(data));
}

/** 收尾时对账已有 tool part 与 trace：正常路径（开始+结束都写过）一条都不再写；只修复漏收尾的 running */
function reconcileToolParts(db, messageId, trace) {
  const list = Array.isArray(trace) ? trace : [];
  const existing = db.prepare(SQL.partsOfMessage).all(messageId).filter((p) => p.type === 'tool');
  for (let i = 0; i < existing.length; i += 1) {
    const data = parseJson(existing[i].data_json, null);
    if (!data || typeof data !== 'object') continue;
    if (i < list.length) {
      if (data.status !== 'running') continue; // 结束点已写全：不重复写（频率约束）
      const tr = traceToData(list[i]);
      const err = tr.error ?? (tr.result && typeof tr.result === 'object' ? tr.result.error ?? null : null);
      db.prepare(SQL.updatePartData).run(safeJson({
        ...data,
        status: err ? 'fail' : 'ok',
        result: tr.result,
        error: err,
        ms: tr.ms,
      }), existing[i].id);
    } else if (data.status === 'running') {
      db.prepare(SQL.updatePartData).run(safeJson({
        ...data, status: 'fail', error: data.error == null ? TOOL_PENDING_ERROR : data.error,
      }), existing[i].id);
    }
  }
  // trace 比已有 part 多（start 写入缺失/旧路径）：补插，保持 trace 全量可还原
  for (let i = existing.length; i < list.length; i += 1) {
    const tr = traceToData(list[i]);
    db.prepare(SQL.insertPart).run(
      randomUUID(), messageId, 2 + i, 'tool',
      safeJson({ ...tr, status: tr.error ? 'fail' : 'ok', callId: null, startedAt: null })
    );
  }
}

/** 用同一个 message id 收尾：更新 content/reasoning/worked_ms + 写 text/reasoning parts，不重复插入消息行 */
function finalizePendingMessage(db, sessionId, pending, assistantMsg = {}) {
  const content = assistantMsg.content == null ? '' : String(assistantMsg.content);
  const error = assistantMsg.error == null ? null : String(assistantMsg.error);
  const interrupted = assistantMsg.interrupted ? 1 : 0;
  const reasoning = assistantMsg.reasoning == null ? '' : String(assistantMsg.reasoning);
  const workedMs = assistantMsg.workedMs == null ? null : (Number.isFinite(Number(assistantMsg.workedMs)) ? Number(assistantMsg.workedMs) : null);
  db.prepare(SQL.updateMessage).run(content, error, interrupted, reasoning, workedMs, pending.id);
  putPart(db, pending.id, 0, 'text', { text: content }, pending.id + ':text');
  putPart(db, pending.id, 1, 'reasoning', { text: reasoning }, pending.id + ':reasoning');
  reconcileToolParts(db, pending.id, assistantMsg.trace);
  delMeta(db, pendingKeyOf(sessionId));
  return pending.id;
}

function partsForMessage(role, msg) {
  if (role === 'assistant') {
    const parts = [
      { seq: 0, type: 'text', data: { text: String(msg.content ?? '') } },
      { seq: 1, type: 'reasoning', data: { text: String(msg.reasoning ?? '') } },
    ];
    let seq = 2;
    for (const item of Array.isArray(msg.trace) ? msg.trace : []) parts.push({ seq: seq++, type: 'tool', data: traceToData(item) });
    return parts;
  }
  if (role === 'notice') return [{ seq: 0, type: 'step', data: { kind: String(msg.kind ?? 'notice') } }];
  return [];
}

function insertMessageRow(db, sessionId, seq, msg, { orReplace = false } = {}) {
  const role = String(msg.role || 'user');
  const interrupted = msg.interrupted ? 1 : 0;
  const workedMs = msg.workedMs == null ? null : (Number.isFinite(Number(msg.workedMs)) ? Number(msg.workedMs) : null);
  const id = randomUUID();
  const sql = orReplace ? SQL.insertMessageOrReplace : SQL.insertMessage;
  db.prepare(sql).run(
    id,
    sessionId,
    seq,
    role,
    msg.content == null ? '' : String(msg.content),
    msg.error == null ? null : String(msg.error),
    interrupted,
    msg.reasoning == null ? '' : String(msg.reasoning),
    workedMs,
    Number.isFinite(Number(msg.at)) ? Number(msg.at) : Date.now()
  );
  for (const part of partsForMessage(role, msg)) {
    const partSql = orReplace ? SQL.insertPartOrReplace : SQL.insertPart;
    db.prepare(partSql).run(randomUUID(), id, part.seq, part.type, JSON.stringify(part.data));
  }
  return id;
}

function insertRawMessageRow(db, row) {
  db.prepare(SQL.insertMessageOrReplace).run(
    row.id, row.session_id, row.seq, row.role, row.content, row.error, row.interrupted,
    row.reasoning, row.worked_ms, row.created_at
  );
}

function insertRawPartRow(db, row) {
  db.prepare(SQL.insertPartOrReplace).run(row.id, row.message_id, row.seq, row.type, row.data_json);
}

function metaKeysOf(sessionId) {
  return ['usage:' + sessionId, 'summary:' + sessionId, 'summaryAt:' + sessionId, 'flags:' + sessionId, 'turns:' + sessionId, pendingKeyOf(sessionId)];
}

async function migrateLegacy(entry) {
  const { db, dir } = entry;
  let names;
  try { names = await readdir(dir); } catch (e) { if (e?.code === 'ENOENT') return; throw e; }
  for (const name of names) {
    const m = SESSION_FILE.exec(name);
    if (!m) continue;
    const id = m[1];
    if (getMeta(db, 'migrated:' + id) != null) continue; // 幂等：导入过就跳过（即使 DB 里后来删掉了也不复活）
    const existing = db.prepare(SQL.existsInSession).get(id);
    if (existing) { setMeta(db, 'migrated:' + id, 'existing'); continue; } // DB 已有 → 不移入旧数据
    let legacy;
    try {
      legacy = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    } catch { continue; } // 损坏的旧文件跳过，不影响其它会话
    try {
      importLegacy(db, id, legacy || {});
    } catch (e) {
      console.warn('[sessions] 旧会话导入失败，已跳过：' + name + '（' + (e?.message || e) + '）');
    }
  }
}

function importLegacy(db, id, legacy) {
  const now = Date.now();
  const createdAt = Number.isFinite(Number(legacy.createdAt)) ? Number(legacy.createdAt) : (Number.isFinite(Number(legacy.updatedAt)) ? Number(legacy.updatedAt) : now);
  const updatedAt = Number.isFinite(Number(legacy.updatedAt)) ? Number(legacy.updatedAt) : createdAt;
  const title = legacy.title == null ? '' : String(legacy.title);
  const pinned = legacy.pinned ? 1 : 0;
  const archived = legacy.archived ? 1 : 0;
  const unread = legacy.unread ? 1 : 0;
  let modelConfigJson = null;
  if (legacy.modelConfig && typeof legacy.modelConfig === 'object') {
    try { modelConfigJson = JSON.stringify(legacy.modelConfig); } catch { modelConfigJson = null; }
  }
  const messages = Array.isArray(legacy.messages) ? legacy.messages : [];
  const flags = {};
  for (const k of ['pinned', 'archived', 'unread']) if (k in legacy) flags[k] = !!legacy[k];
  const tx = db.transaction(() => {
    db.prepare(SQL.insertSession).run(id, title, createdAt, updatedAt, pinned, archived, unread, modelConfigJson);
    messages.forEach((msg, seq) => {
      insertMessageRow(db, id, seq, {
        role: msg?.role,
        content: msg?.content,
        error: msg?.error,
        interrupted: msg?.interrupted,
        reasoning: msg?.reasoning,
        trace: msg?.trace,
        workedMs: msg?.workedMs,
        kind: msg?.kind,
        at: msg?.at ?? updatedAt,
      });
    });
    if (Object.keys(flags).length) setMeta(db, 'flags:' + id, JSON.stringify(flags));
    setMeta(db, 'turns:' + id, String(Math.floor(messages.length / 2)));
    if ('usage' in legacy) setMeta(db, 'usage:' + id, JSON.stringify(legacy.usage && typeof legacy.usage === 'object' ? legacy.usage : null));
    if (legacy.summary != null) {
      setMeta(db, 'summary:' + id, String(legacy.summary));
      const summaryAt = Number(legacy.summaryAt);
      setMeta(db, 'summaryAt:' + id, String(Number.isFinite(summaryAt) ? summaryAt : now));
    }
    setMeta(db, 'migrated:' + id, 'json');
  });
  tx();
}

function buildMessage(row, parts) {
  const at = Number(row.created_at ?? 0);
  if (row.role === 'assistant') {
    const trace = parts.filter((p) => p.type === 'tool').map((p) => dataToTrace(parseJson(p.data_json, null)));
    return {
      role: 'assistant',
      content: row.content ?? '',
      error: row.error ?? null,
      interrupted: !!row.interrupted,
      reasoning: row.reasoning ?? '',
      trace,
      workedMs: row.worked_ms ?? null,
      at,
    };
  }
  if (row.role === 'notice') {
    const step = parts.find((p) => p.type === 'step');
    const data = step ? parseJson(step.data_json, null) : null;
    return { role: 'notice', kind: data && typeof data.kind === 'string' ? data.kind : 'notice', content: row.content ?? '', at };
  }
  return { role: row.role, content: row.content ?? '', at };
}

async function sqliteLoadSession(id) {
  const { db } = await openDb(dirFor(id));
  const row = requireSession(db, id);
  const messageRows = db.prepare(SQL.messagesOf).all(id);
  const partRows = db.prepare(SQL.partsOf).all(id);
  const partsBy = new Map();
  for (const p of partRows) {
    if (!partsBy.has(p.message_id)) partsBy.set(p.message_id, []);
    partsBy.get(p.message_id).push(p);
  }
  // 崩溃语义：进程在工具执行中被杀 → pending meta 仍在，把这一行还原成「已中断」的 assistant 消息，
  // trace（含 running/未完成的工具）照常返回，整段对话不丢。
  const pending = getPending(db, id);
  const messages = messageRows.map((m) => {
    const built = buildMessage(m, partsBy.get(m.id) || []);
    if (pending && pending.id === m.id) built.interrupted = true;
    return built;
  });
  const out = { id: row.id, title: row.title ?? '', createdAt: row.created_at, updatedAt: row.updated_at, messages };
  const flags = parseJson(getMeta(db, 'flags:' + id), null);
  if (flags && typeof flags === 'object') {
    if ('pinned' in flags) out.pinned = !!flags.pinned;
    if ('archived' in flags) out.archived = !!flags.archived;
    if ('unread' in flags) out.unread = !!flags.unread;
  }
  if (row.model_config_json) {
    const cfg = parseJson(row.model_config_json, null);
    if (cfg && typeof cfg === 'object') out.modelConfig = cfg;
  }
  const usage = getMeta(db, 'usage:' + id);
  if (usage != null) out.usage = parseJson(usage, null);
  const summary = getMeta(db, 'summary:' + id);
  if (summary != null) {
    out.summary = summary;
    out.summaryAt = Number(getMeta(db, 'summaryAt:' + id)) || 0;
  }
  return out;
}

async function sqliteNewSession(title = t('新会话')) {
  const { db } = await openDb(defaultDir());
  const now = Date.now();
  const id = randomUUID();
  const cleanTitle = String(title).slice(0, 60);
  const tx = db.transaction(() => {
    db.prepare(SQL.insertSession).run(id, cleanTitle, now, now, 0, 0, 0, null);
    setMeta(db, 'turns:' + id, '0');
  });
  tx();
  return { id, title: cleanTitle, createdAt: now, updatedAt: now, messages: [] };
}

async function sqliteListSessions(sessionsDir = defaultDir()) {
  const dir = path.resolve(sessionsDir);
  await mkdir(dir, { recursive: true });
  const { db, dbPath } = await openDb(dir);
  const rows = db.prepare(SQL.listSessions).all();
  const turns = new Map();
  for (const r of db.prepare(SQL.turnMeta).all('turns:%')) {
    turns.set(String(r.key).slice('turns:'.length), Number(r.value) || 0);
  }
  // 极端兼容：更早的 DB 没有 turns 元数据时才回退到计数（正常写入路径都会维护 turns）
  for (const s of rows) {
    if (turns.has(s.id)) continue;
    const n = Number(db.prepare(SQL.countMessages).get(s.id)?.n || 0);
    turns.set(s.id, Math.floor(n / 2));
  }
  const out = rows.map((s) => ({
    id: s.id,
    title: String(s.title || '').replace(/\n\n\[附件\][\s\S]*$/, '').trim() || t('新会话'),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    turns: turns.get(s.id) || 0,
    pinned: !!s.pinned,
    archived: !!s.archived,
    unread: !!s.unread,
    modelConfig: parseJson(s.model_config_json, null) || null,
    path: dbPath,
  }));
  return out.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (Number(a.archived) - Number(b.archived)) || ((b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt)));
}

async function sqliteAppendUserMessage(id, userMsg) {
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    const row = requireSession(db, id);
    const now = Date.now();
    const users = Number(db.prepare(SQL.countUsers).get(id)?.n || 0);
    const title = users === 0 ? (prettyTitle(userMsg) || t('新会话')) : row.title;
    const seq = nextSeq(db, id);
    const tx = db.transaction(() => {
      // 新用户消息 = 新回合：上一轮若崩在工具执行中，先把进行中的 assistant 行封口（不复活）
      sealPending(db, id);
      insertMessageRow(db, id, seq, { role: 'user', content: userMsg, at: now });
      refreshTurns(db, id);
      db.prepare(SQL.setTitleAndTouch).run(title, now, id);
    });
    tx();
    return { id, title, updatedAt: now };
  });
}

/** 工具开始执行：懒建「进行中的 assistant 行」（若同回合已有就复用），插一条 status=running 的 tool part */
async function sqliteAppendToolStart(id, tool = {}) {
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    requireSession(db, id);
    const now = Date.now();
    const name = String(tool.name || 'unknown');
    const callId = tool.callId == null || tool.callId === '' ? null : String(tool.callId);
    const args = typeof tool.args === 'string' ? tool.args : (tool.args == null ? '' : safeJson(tool.args));
    const tx = db.transaction(() => {
      // 旧回合残留的 pending（后面已有新消息）：先封口，新工具不能挂到旧回合上
      const stale = getPending(db, id);
      if (stale) {
        const maxSeq = Number(db.prepare(SQL.maxSeqOfSession).get(id)?.seq ?? -1);
        if (stale.seq < maxSeq) sealPending(db, id);
      }
      let pending = getPending(db, id);
      if (!pending) {
        const seq = nextSeq(db, id);
        const messageId = randomUUID();
        db.prepare(SQL.insertMessage).run(messageId, id, seq, 'assistant', '', null, 0, '', null, now);
        pending = { id: messageId, seq, startedAt: now };
        setMeta(db, pendingKeyOf(id), safeJson({ id: messageId, seq, startedAt: now }));
        refreshTurns(db, id);
      }
      const partSeq = Number(db.prepare(SQL.nextToolPartSeq).get(pending.id)?.seq ?? 2);
      const partId = randomUUID();
      db.prepare(SQL.insertPart).run(partId, pending.id, partSeq, 'tool', safeJson({
        status: 'running',
        name,
        callId,
        args,
        result: null,
        error: null,
        ms: null,
        startedAt: now,
      }));
      db.prepare(SQL.touch).run(now, id);
      return { messageId: pending.id, partId, seq: partSeq };
    });
    return tx();
  });
}

/** 工具结束：按 tool_call id（没有则工具名/FIFO）找回同一条 running part，补 status/result/error/ms */
async function sqliteAppendToolEnd(id, tool = {}) {
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    requireSession(db, id);
    const pending = getPending(db, id);
    if (!pending) return null; // 回合已收尾/无进行中消息：没东西可更新
    const callId = tool.callId == null || tool.callId === '' ? null : String(tool.callId);
    const name = String(tool.name || '');
    const hit = runningToolPart(db, pending.id, { callId, name });
    if (!hit) return null;
    const prev = hit.data;
    const status = tool.status === 'ok' || tool.status === 'fail'
      ? tool.status
      : (tool.error ? 'fail' : 'ok');
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare(SQL.updatePartData).run(safeJson({
        status,
        name: prev.name || name || 'unknown',
        callId: prev.callId ?? callId,
        args: prev.args ?? (typeof tool.args === 'string' ? tool.args : null),
        result: tool.result === undefined ? null : tool.result,
        error: tool.error == null ? null : String(tool.error),
        ms: Number.isFinite(Number(tool.ms)) ? Number(tool.ms) : null,
        startedAt: prev.startedAt ?? null,
      }), hit.row.id);
      db.prepare(SQL.touch).run(now, id);
    });
    tx();
    return { messageId: pending.id, partId: hit.row.id, status };
  });
}

async function sqliteAppendAssistantMessage(id, assistantMsg = {}) {
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    const row = requireSession(db, id);
    const now = Date.now();
    const tx = db.transaction(() => {
      // 有进行中的 assistant 行（本回合已落过工具）→ 同 id 收尾，绝不重复插入
      const pending = getPending(db, id);
      if (pending && db.prepare(SQL.messageById).get(pending.id)) {
        finalizePendingMessage(db, id, pending, assistantMsg);
        refreshTurns(db, id);
        db.prepare(SQL.touch).run(now, id);
        return;
      }
      const seq = nextSeq(db, id);
      insertMessageRow(db, id, seq, {
        role: 'assistant',
        content: assistantMsg.content ?? '',
        error: assistantMsg.error ?? null,
        interrupted: !!assistantMsg.interrupted,
        reasoning: assistantMsg.reasoning ?? '',
        trace: assistantMsg.trace ?? [],
        workedMs: assistantMsg.workedMs ?? null,
        at: now,
      });
      refreshTurns(db, id);
      db.prepare(SQL.touch).run(now, id);
    });
    tx();
    return { id, title: row.title, updatedAt: now };
  });
}

async function sqliteAppendTurn(id, userMsg, assistantMsg) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    const row = requireSession(db, id);
    const now = Date.now();
    const users = Number(db.prepare(SQL.countUsers).get(id)?.n || 0);
    const title = users === 0 ? (prettyTitle(userMsg) || t('新会话')) : row.title;
    const seq = nextSeq(db, id);
    const tx = db.transaction(() => {
      sealPending(db, id); // appendTurn 是显式新回合：旧回合残留的进行中消息先封口
      insertMessageRow(db, id, seq, { role: 'user', content: userMsg, at: now });
      insertMessageRow(db, id, seq + 1, {
        role: 'assistant',
        content: assistantMsg.content ?? '',
        error: assistantMsg.error ?? null,
        interrupted: !!assistantMsg.interrupted,
        reasoning: assistantMsg.reasoning ?? '',
        trace: assistantMsg.trace ?? [],
        at: now,
      });
      refreshTurns(db, id);
      db.prepare(SQL.setTitleAndTouch).run(title, now, id);
    });
    tx();
    return { id, title, updatedAt: now };
  });
}

async function sqliteSetModelConfig(id, cfg = {}) {
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    const row = requireSession(db, id);
    const prev = parseJson(row.model_config_json, null) || {};
    const modelConfig = {
      providerId: String(cfg.providerId ?? prev.providerId ?? ''),
      model: String(cfg.model ?? prev.model ?? ''),
      effort: String(cfg.effort ?? prev.effort ?? ''),
    };
    db.prepare('UPDATE session SET model_config_json = ? WHERE id = ?').run(JSON.stringify(modelConfig), id);
    return { id, modelConfig };
  });
}

async function sqliteSetSessionUsage(id, usage) {
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    requireSession(db, id);
    const value = usage && typeof usage === 'object' ? usage : null;
    const now = Date.now();
    const tx = db.transaction(() => {
      setMeta(db, 'usage:' + id, JSON.stringify(value));
      db.prepare(SQL.touch).run(now, id);
    });
    tx();
    return { id, usage: value };
  });
}

async function sqliteRewindToUserTurn(id, keepUserTurns) {
  const keep = Math.max(0, Math.floor(Number(keepUserTurns) || 0));
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    const row = requireSession(db, id);
    const messages = db.prepare(SQL.messagesOf).all(id);
    let seen = 0;
    let kept = 0;
    let cutSeq = null;
    for (const m of messages) {
      if (m.role === 'user') {
        if (seen >= keep) { cutSeq = m.seq; break; }
        seen += 1;
      }
      kept += 1;
    }
    const now = Date.now();
    const title = kept === 0 ? t('新会话') : row.title;
    const pending = getPending(db, id);
    const pendingCut = pending && cutSeq != null && pending.seq >= cutSeq;
    const tx = db.transaction(() => {
      if (pendingCut) delMeta(db, pendingKeyOf(id)); // 进行中行被回退删掉：meta 不能留脏指向
      if (cutSeq != null) {
        db.prepare(SQL.deletePartBySessionFromSeq).run(id, cutSeq);
        db.prepare(SQL.deleteMessageFromSeq).run(id, cutSeq);
      }
      refreshTurns(db, id, kept);
      db.prepare(SQL.setTitleAndTouch).run(title, now, id);
    });
    tx();
    return { id, messages: kept, title };
  });
}

async function sqliteSaveSummary(id, summary) {
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    requireSession(db, id);
    const now = Date.now();
    const tx = db.transaction(() => {
      setMeta(db, 'summary:' + id, String(summary || ''));
      setMeta(db, 'summaryAt:' + id, String(now));
      db.prepare(SQL.touch).run(now, id);
    });
    tx();
    return { id, summaryAt: now };
  });
}

async function sqliteAppendNotice(id, content, kind = 'notice') {
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    requireSession(db, id);
    const now = Date.now();
    const seq = nextSeq(db, id);
    const tx = db.transaction(() => {
      sealPending(db, id); // notice 也是回合边界后的新消息，旧进行中行不能悬在它前面
      insertMessageRow(db, id, seq, { role: 'notice', kind, content: String(content || ''), at: now });
      refreshTurns(db, id);
      db.prepare(SQL.touch).run(now, id);
    });
    tx();
    return { id, updatedAt: now };
  });
}

async function sqliteRenameSession(id, title) {
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    requireSession(db, id);
    const clean = String(title || '').replace(/\n\n\[附件\][\s\S]*$/, '').trim().slice(0, 80) || t('新会话');
    const now = Date.now();
    db.prepare(SQL.setTitleAndTouch).run(clean, now, id);
    return { id, title: clean };
  });
}

async function sqliteSetSessionFlags(id, flags = {}) {
  return withQueue(id, async () => {
    const { db } = await openDb(dirFor(id));
    requireSession(db, id);
    const touched = { pinned: 'pinned' in flags, archived: 'archived' in flags, unread: 'unread' in flags };
    const current = parseJson(getMeta(db, 'flags:' + id), null) || {};
    for (const k of ['pinned', 'archived', 'unread']) if (touched[k]) current[k] = !!flags[k];
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare(SQL.setFlags).run(
        touched.pinned ? 1 : 0, current.pinned ? 1 : 0,
        touched.archived ? 1 : 0, current.archived ? 1 : 0,
        touched.unread ? 1 : 0, current.unread ? 1 : 0,
        now, id
      );
      if (Object.keys(current).length) setMeta(db, 'flags:' + id, JSON.stringify(current));
    });
    tx();
    const after = requireSession(db, id);
    return { id, pinned: !!after.pinned, archived: !!after.archived, unread: !!after.unread };
  });
}

async function sqliteMoveSessionTo(id, targetDir) {
  return withQueue(id, async () => {
    const src = await openDb(dirFor(id));
    const row = requireSession(src.db, id);
    const target = await openDb(path.resolve(String(targetDir || '')));
    const now = Date.now();
    if (target.dbPath === src.dbPath) {
      src.db.prepare(SQL.touch).run(now, id);
      return { id, path: target.dbPath };
    }
    const messages = src.db.prepare(SQL.messagesOf).all(id);
    const parts = src.db.prepare(SQL.partsOf).all(id);
    const metaKeys = metaKeysOf(id);
    const migratedKey = 'migrated:' + id;
    const metas = metaKeys.map((k) => [k, getMeta(src.db, k)]).filter(([, v]) => v != null);
    const migrated = getMeta(src.db, migratedKey);
    const tx = target.db.transaction(() => {
      target.db.prepare(SQL.upsertSession).run(row.id, row.title, row.created_at, now, row.pinned, row.archived, row.unread, row.model_config_json);
      target.db.prepare(SQL.deletePartBySession).run(id);
      target.db.prepare(SQL.deleteMessageBySession).run(id);
      for (const m of messages) insertRawMessageRow(target.db, m);
      for (const p of parts) insertRawPartRow(target.db, p);
      for (const [k, v] of metas) setMeta(target.db, k, v);
      setMeta(target.db, 'turns:' + id, String(Math.floor(messages.length / 2)));
      setMeta(target.db, migratedKey, migrated == null ? 'moved' : migrated);
    });
    tx();
    const srcTx = src.db.transaction(() => {
      src.db.prepare(SQL.deletePartBySession).run(id);
      src.db.prepare(SQL.deleteMessageBySession).run(id);
      src.db.prepare(SQL.deleteSession).run(id);
      for (const k of metaKeys) delMeta(src.db, k);
    });
    srcTx();
    return { id, path: target.dbPath };
  });
}

async function sqliteDeleteSession(id) {
  const { db } = await openDb(dirFor(id));
  const exists = db.prepare(SQL.existsInSession).get(id);
  if (!exists) return true;
  const tx = db.transaction(() => {
    db.prepare(SQL.deletePartBySession).run(id);
    db.prepare(SQL.deleteMessageBySession).run(id);
    db.prepare(SQL.deleteSession).run(id);
    for (const k of metaKeysOf(id)) delMeta(db, k);
    // migrated:<id> 保留：旧 JSON 只读导入过，删会话后不能因为旧文件还在而复活
  });
  tx();
  return true;
}

/**
 * 跨项目发现用：某个会话目录对应的 DB 里是否有该会话。
 * 只查 session 表；不创建 DB、不解析消息体。json 后端下返回 false（沿用文件名扫描）。
 */
export async function sessionExistsInDir(id, sessionsDir) {
  if (!OK_ID.test(id)) return false;
  if (!useSqliteStore()) return false;
  const dbPath = dbFileFor(sessionsDir);
  if (!existsSync(dbPath)) return false;
  let db = null;
  try {
    const Database = await databaseClass();
    db = new Database(dbPath, { fileMustExist: true, ...sqliteBindingOptions() });
    return !!db.prepare(SQL.existsInSession).get(id);
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// ---- JSON 后端（保留给单测 / FINALCHECK_SESSION_STORE=json；生产不再走这里） ----
async function ensureDir() { await mkdir(defaultDir(), { recursive: true }); }
const fileOf = (id) => path.join(dirFor(id), `session-${id}.json`);

// 终审 P2#8：同 id 并发 appendTurn 串行化（进程内 Promise 队列），防读改写丢更新
const queues = new Map();
const withQueue = (id, fn) => {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(id, next);
  return next;
};

// 终审 P2#7：tmp+rename 原子写，防写盘中途截断导致会话丢失
async function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  await writeFile(tmp, data, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, file);
}

// 会话标题只取可读形式：技能展开段折成「✦ 名称」，工作流模板折成「Workflow · 任务」
export function prettyTitle(text) {
  const s = String(text || '').replace(/\n\n\[附件\][\s\S]*$/, '').trim();
  const skill = s.match(/^\[技能\]\s*([^（(]+)/);
  if (skill) return `✦ ${skill[1].trim().slice(0, 24)}`;
  if (s.startsWith('请用 run_workflow')) {
    const task = s.match(/\n任务：([^\n]+)/);
    return `Workflow · ${(task?.[1] || '多 agent 工作流').trim().slice(0, 24)}`;
  }
  return s.slice(0, 40);
}

async function jsonNewSession(title = t('新会话')) {
  await ensureDir();
  const now = Date.now();
  const s = { id: randomUUID(), title: String(title).slice(0, 60), createdAt: now, updatedAt: now, messages: [] };
  await writeFile(fileOf(s.id), JSON.stringify(s), 'utf8');
  return s;
}

async function jsonListSessions(sessionsDir = defaultDir()) {
  const base = path.resolve(sessionsDir); // 默认「当前项目」；显式传入时才列别的项目目录
  await mkdir(base, { recursive: true });
  const files = (await readdir(base)).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(await readFile(path.join(base, f), 'utf8'));
      out.push({
        id: s.id,
        title: String(s.title || '').replace(/\n\n\[附件\][\s\S]*$/, '').trim() || t('新会话'),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        turns: Math.floor((s.messages || []).length / 2),
        pinned: !!s.pinned,
        archived: !!s.archived,
        unread: !!s.unread,
        modelConfig: s.modelConfig || null,
        path: path.join(base, f)
      });
    } catch { /* 损坏文件跳过 */ }
  }
  // 顺序固定：新建的排在最上面；点开/发消息只更新 updatedAt，不参与排序（旧数据没有 createdAt 时退回 updatedAt）
  return out.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (Number(a.archived) - Number(b.archived)) || ((b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt)));
}

async function jsonLoadSession(id) {
  return JSON.parse(await readFile(fileOf(id), 'utf8'));
}

async function jsonAppendTurn(id, userMsg, assistantMsg) {
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    s.messages.push({ role: 'user', content: userMsg, at: Date.now() });
    s.messages.push({ role: 'assistant', content: assistantMsg.content ?? '', error: assistantMsg.error ?? null, interrupted: !!assistantMsg.interrupted, reasoning: assistantMsg.reasoning ?? '', trace: assistantMsg.trace ?? [], at: Date.now() });
    const firstUser = s.messages.find((m) => m.role === 'user');
    if (s.messages.filter((m) => m.role === 'user').length === 1 && firstUser) {
      s.title = prettyTitle(firstUser.content) || t('新会话');
    }
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, title: s.title, updatedAt: s.updatedAt };
  });
}

async function jsonAppendUserMessage(id, userMsg) {
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    s.messages.push({ role: 'user', content: userMsg, at: Date.now() });
    const firstUser = s.messages.find((m) => m.role === 'user');
    if (s.messages.filter((m) => m.role === 'user').length === 1 && firstUser) {
      s.title = prettyTitle(firstUser.content) || t('新会话');
    }
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, title: s.title, updatedAt: s.updatedAt };
  });
}

async function jsonAppendAssistantMessage(id, assistantMsg) {
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    s.messages.push({
      role: 'assistant',
      content: assistantMsg.content ?? '',
      error: assistantMsg.error ?? null,
      interrupted: !!assistantMsg.interrupted,
      reasoning: assistantMsg.reasoning ?? '',
      trace: assistantMsg.trace ?? [],
      workedMs: assistantMsg.workedMs ?? null,
      at: Date.now()
    });
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, title: s.title, updatedAt: s.updatedAt };
  });
}

async function jsonSetModelConfig(id, cfg = {}) {
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    const prev = s.modelConfig || {};
    s.modelConfig = {
      providerId: String(cfg.providerId ?? prev.providerId ?? ''),
      model: String(cfg.model ?? prev.model ?? ''),
      effort: String(cfg.effort ?? prev.effort ?? ''),
    };
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, modelConfig: s.modelConfig };
  });
}

async function jsonSetSessionUsage(id, usage) {
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    s.usage = usage && typeof usage === 'object' ? usage : null;
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, usage: s.usage };
  });
}

async function jsonRewindToUserTurn(id, keepUserTurns) {
  const keep = Math.max(0, Math.floor(Number(keepUserTurns) || 0));
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    const out = [];
    let seen = 0;
    for (const m of s.messages || []) {
      if (m.role === 'user') {
        if (seen >= keep) break;
        seen += 1;
      }
      out.push(m);
    }
    s.messages = out;
    if (!out.length) s.title = t('新会话');
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, messages: out.length, title: s.title };
  });
}

async function jsonSaveSummary(id, summary) {
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    s.summary = String(summary || '');
    s.summaryAt = Date.now();
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, summaryAt: s.summaryAt };
  });
}

async function jsonAppendNotice(id, content, kind = 'notice') {
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    s.messages.push({ role: 'notice', kind, content: String(content || ''), at: Date.now() });
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, updatedAt: s.updatedAt };
  });
}

async function jsonRenameSession(id, title) {
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    s.title = String(title || '').replace(/\n\n\[附件\][\s\S]*$/, '').trim().slice(0, 80) || t('新会话');
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, title: s.title };
  });
}

async function jsonSetSessionFlags(id, flags = {}) {
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    for (const k of ['pinned', 'archived', 'unread']) if (k in flags) s[k] = !!flags[k];
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, pinned: !!s.pinned, archived: !!s.archived, unread: !!s.unread };
  });
}

async function jsonMoveSessionTo(id, targetDir) {
  return withQueue(id, async () => {
    const s = await jsonLoadSession(id);
    s.updatedAt = Date.now();
    const destDir = path.resolve(String(targetDir || ''));
    await mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, `session-${s.id}.json`);
    await atomicWrite(dest, JSON.stringify(s));
    await unlink(fileOf(id)).catch(() => {});
    return { id: s.id, path: dest };
  });
}

async function jsonDeleteSession(id) {
  await unlink(fileOf(id)).catch(() => {});
  return true;
}

// ---- 对外导出：签名与返回形状保持不变 ----
export async function newSession(title = t('新会话')) {
  return useSqliteStore() ? sqliteNewSession(title) : jsonNewSession(title);
}

export async function listSessions() {
  return useSqliteStore() ? sqliteListSessions() : jsonListSessions();
}

/**
 * 只读列表：按显式会话目录列出会话（不读/不改 FINALCHECK_SESSIONS_DIR，也不碰当前项目）。
 * 侧栏「同时展开多个 Workspace」用它列别的项目；返回形状与 listSessions() 完全一致。
 * projectId → 目录的解析由调用方（project-sessions.mjs）完成，这里只管目录。
 */
export async function listSessionsIn(sessionsDir) {
  if (typeof sessionsDir !== 'string' || !sessionsDir.trim()) throw new Error('非法会话目录');
  const dir = path.resolve(sessionsDir.trim());
  return useSqliteStore() ? sqliteListSessions(dir) : jsonListSessions(dir);
}

export async function loadSession(id) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteLoadSession(id) : jsonLoadSession(id);
}

export async function appendTurn(id, userMsg, assistantMsg) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteAppendTurn(id, userMsg, assistantMsg) : jsonAppendTurn(id, userMsg, assistantMsg);
}

export async function appendUserMessage(id, userMsg) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteAppendUserMessage(id, userMsg) : jsonAppendUserMessage(id, userMsg);
}

export async function appendAssistantMessage(id, assistantMsg) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteAppendAssistantMessage(id, assistantMsg) : jsonAppendAssistantMessage(id, assistantMsg);
}

/**
 * 工具调用级别落库（只 SQLite 后端；JSON 后端保持现状，直接 no-op）。
 * 调用点：agent-service 的 onToolLifecycle（index.mjs 接线）——开始一次、结束一次，不做流式逐 delta 写。
 */
export async function appendToolStart(id, tool = {}) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteAppendToolStart(id, tool) : null;
}

export async function appendToolEnd(id, tool = {}) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteAppendToolEnd(id, tool) : null;
}

export async function setModelConfig(id, cfg = {}) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteSetModelConfig(id, cfg) : jsonSetModelConfig(id, cfg);
}

export async function setSessionUsage(id, usage) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteSetSessionUsage(id, usage) : jsonSetSessionUsage(id, usage);
}

export async function rewindToUserTurn(id, keepUserTurns) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteRewindToUserTurn(id, keepUserTurns) : jsonRewindToUserTurn(id, keepUserTurns);
}

export async function saveSummary(id, summary) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteSaveSummary(id, summary) : jsonSaveSummary(id, summary);
}

export async function appendNotice(id, content, kind = 'notice') {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteAppendNotice(id, content, kind) : jsonAppendNotice(id, content, kind);
}

export async function renameSession(id, title) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteRenameSession(id, title) : jsonRenameSession(id, title);
}

export async function setSessionFlags(id, flags = {}) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteSetSessionFlags(id, flags) : jsonSetSessionFlags(id, flags);
}

export async function markRead(id) {
  try { return await setSessionFlags(id, { unread: false }); } catch { return null; }
}

export async function moveSessionTo(id, targetDir) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteMoveSessionTo(id, targetDir) : jsonMoveSessionTo(id, targetDir);
}

export async function deleteSession(id) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return useSqliteStore() ? sqliteDeleteSession(id) : jsonDeleteSession(id);
}
