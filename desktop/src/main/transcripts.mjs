// 子代理 transcript 落盘（ZCode 的实证做法：对话随工具调用流式写入，缓存命中的步骤只留结果不建会话）。
// 目的：重开 App 后点旧工作流卡片里的 chip 还能看到当时的对话，而不是「上下文没有留下」。
// 布局：<root>/<runId>/<stepId>.json；超长工具结果按 maxToolChars 截断，防单文件爆掉。
// 保留策略：只留最近 N 个 run 目录（pruneRuns），默认 5。
import fs from 'node:fs/promises';
import path from 'node:path';

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;

export function isValidRunIdForFile(runId) {
  return typeof runId === 'string' && RUN_ID_RE.test(runId);
}

/** 步骤 id 可能带 # / 空格 / 盘符：压成安全文件名（保留可读性） */
export function safeStepId(stepId) {
  const s = String(stepId ?? '').replace(/[^A-Za-z0-9._#-]/g, '_').slice(0, 120);
  return s || '_';
}

export function runDirOf(root, runId) {
  if (!isValidRunIdForFile(runId)) throw new Error(`runId 非法：${runId}`);
  return path.join(String(root), runId);
}

export function stepFileOf(root, runId, stepId) {
  return path.join(runDirOf(root, runId), `${safeStepId(stepId)}.json`);
}

/** 写一份 step transcript（原子写：tmp + rename，Windows 上是删旧再 rename 的退路）；工具输出自动截断 */
export async function writeStepTranscript(root, runId, stepId, payload, { maxToolChars = 2000 } = {}) {
  if (!isValidRunIdForFile(runId)) return null;
  const file = stepFileOf(root, runId, stepId);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const data = payload && typeof payload === 'object' && Array.isArray(payload.messages)
    ? { ...payload, messages: trimTranscriptMessages(payload.messages, { maxToolChars }) }
    : payload;
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    if (e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES')) {
      await fs.rm(file, { force: true });
      await fs.rename(tmp, file);
    } else {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  return file;
}

/** 读 step transcript：给了 runId 直接读该目录；没给就按目录 mtime 从新到旧扫（跨 run 找最新一份） */
export async function readStepTranscript(root, stepId, { runId = null } = {}) {
  const name = `${safeStepId(stepId)}.json`;
  const tryRead = async (file) => {
    try {
      const text = await fs.readFile(file, 'utf8');
      const data = JSON.parse(text);
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  };
  if (runId) {
    if (!isValidRunIdForFile(runId)) return null;
    return tryRead(stepFileOf(root, runId, stepId));
  }
  let dirs = [];
  try {
    dirs = (await fs.readdir(String(root))).filter((d) => isValidRunIdForFile(d));
  } catch {
    return null;
  }
  const stamped = [];
  for (const d of dirs) {
    try { stamped.push({ d, mtime: (await fs.stat(path.join(String(root), d))).mtimeMs }); } catch { /* 忽略 */ }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  for (const { d } of stamped) {
    const hit = await tryRead(path.join(String(root), d, name));
    if (hit) return { ...hit, runId: d };
  }
  return null;
}

/** 只留最近 keep 个 run 目录（按 mtime），其余删掉；不存在的目录直接返回 0 */
export async function pruneRuns(root, keep = 5) {
  let dirs = [];
  try { dirs = await fs.readdir(String(root)); } catch { return 0; }
  const valid = dirs.filter((d) => isValidRunIdForFile(d));
  const stamped = [];
  for (const d of valid) {
    try { stamped.push({ d, mtime: (await fs.stat(path.join(String(root), d))).mtimeMs }); } catch { /* 忽略 */ }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const { d } of stamped.slice(Math.max(0, keep))) {
    try { await fs.rm(path.join(String(root), d), { recursive: true, force: true }); removed += 1; } catch { /* 单个删失败不影响其它 */ }
  }
  return removed;
}

/** 工具输出截断：每条 tool 消息的 content 最多 maxToolChars（默认 2000），保住结构不丢 */
export function trimTranscriptMessages(messages, { maxToolChars = 2000 } = {}) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const content = m.content == null ? '' : String(m.content);
    if (m.role === 'tool' && content.length > maxToolChars) {
      return { ...m, content: `${content.slice(0, maxToolChars)}…[已截断 ${content.length - maxToolChars} 字]` };
    }
    return m;
  });
}
