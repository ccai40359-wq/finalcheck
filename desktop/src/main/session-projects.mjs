// 会话 → 项目目录注册表（ZCode 语义：会话属于它创建时的项目，切 Workspace 只切 UI 视角）。
// 主进程内存里维护 sessionId → <project>/.finalcheck/sessions；启动时扫一遍已知项目目录，
// 运行中在 sessions:list / open / new / move 时登记。只读写文件名，不解析会话内容。
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { sessionExistsInDir } from './sessions.mjs';

// 与 sessions.mjs 的 OK_ID 保持一致：会话 id 全局唯一（UUID）
const OK_SESSION_ID = /^[a-f0-9-]{8,64}$/;
const SESSION_FILE = /^session-([a-f0-9-]{8,64})\.json$/;

const dirs = new Map(); // sessionId → 绝对目录

export const isValidSessionId = (id) => typeof id === 'string' && OK_SESSION_ID.test(id);

const normalizeDir = (d) => (typeof d === 'string' && d.trim() ? path.resolve(d.trim()) : null);

/** 登记/更新某个会话所在目录（move / 新建时用 overwrite=true 覆盖旧登记） */
export function registerSessionDir(sessionId, sessionsDir, { overwrite = true } = {}) {
  if (!isValidSessionId(sessionId)) return null;
  const d = normalizeDir(sessionsDir);
  if (!d) return null;
  if (overwrite || !dirs.has(sessionId)) dirs.set(sessionId, d);
  return dirs.get(sessionId);
}

/** 已登记返回目录，未登记返回 null（sessions.mjs 的 dirFor 据此回退全局目录） */
export function getSessionDir(sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  return dirs.get(sessionId) || null;
}

export function unregisterSessionDir(sessionId) {
  if (isValidSessionId(sessionId)) dirs.delete(sessionId);
}

/** 仅测试/重启用：清空进程内登记 */
export function resetSessionDirs() {
  dirs.clear();
}

export function registeredSessionDirs() {
  return [...dirs.entries()];
}

/**
 * 从 <project>/.finalcheck/sessions 反推项目根。全局默认目录（userData/sessions）返回 null，
 * 调用方据此回退「当前 UI 项目」。
 */
export function projectRootOfSessionsDir(sessionsDir) {
  const d = normalizeDir(sessionsDir);
  if (!d) return null;
  if (path.basename(d).toLowerCase() !== 'sessions') return null;
  const dataDir = path.dirname(d);
  if (path.basename(dataDir).toLowerCase() !== '.finalcheck') return null;
  return path.dirname(dataDir);
}

/**
 * 扫描一个会话目录：只 readdir 文件名并登记，不读文件内容（大会话也不会拖慢启动）。
 * overwrite=false 时保留已有登记（启动扫描用），move/新建用 true。
 */
export async function scanSessionsDir(sessionsDir, { overwrite = false } = {}) {
  const d = normalizeDir(sessionsDir);
  if (!d) return { dir: null, files: 0, registered: 0 };
  let entries = [];
  try {
    entries = await readdir(d, { withFileTypes: true });
  } catch { return { dir: d, files: 0, registered: 0 }; } // 目录不存在（新加项目还没会话）不报错
  let files = 0;
  let registered = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue; // 只认真实文件（同名的目录/链接不登记）
    const m = SESSION_FILE.exec(ent.name);
    if (!m) continue;
    files += 1;
    if (registerSessionDir(m[1], d, { overwrite })) registered += 1;
  }
  return { dir: d, files, registered };
}

/**
 * 在当前项目 + 所有已知项目目录里找一个会话（用于 open 未登记的会话）。
 * 先 stat 旧 JSON 文件；sqlite 后端下再查该目录的 finalcheck.db（只查 session 表，不读消息体）。
 */
export async function findSessionDir(sessionId, candidateDirs = []) {
  if (!isValidSessionId(sessionId)) return null;
  for (const raw of candidateDirs) {
    const d = normalizeDir(raw);
    if (!d) continue;
    try {
      const st = await stat(path.join(d, `session-${sessionId}.json`));
      if (st.isFile()) return d;
    } catch { /* 不在这个目录，继续找 */ }
  }
  // DB 会话（迁移后旧 JSON 只读存在；新会话根本没有 JSON 文件）
  for (const raw of candidateDirs) {
    const d = normalizeDir(raw);
    if (!d) continue;
    if (await sessionExistsInDir(sessionId, d)) return d;
  }
  return null;
}
