// 会话持久化：DeepSeek 式多会话（desktop/sessions/<id>.json，已 gitignore）
import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 目录惰性解析：主进程在 app ready 后把 FINALCHECK_SESSIONS_DIR 指到「当前项目」，
// 这样打包版升级/重开都不会丢历史（仍兼容测试临时目录）。
// 会话级覆盖：主进程通过 setSessionDirResolver 注入「会话 → 它所属项目目录」的解析器，
// 切项目后旧会话的读写仍落在它自己的项目目录（ZCode 语义：切 Workspace 只切 UI 视角）。
const defaultDir = () => process.env.FINALCHECK_SESSIONS_DIR
  ? path.resolve(process.env.FINALCHECK_SESSIONS_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'sessions');
const OK_ID = /^[a-f0-9-]{8,64}$/;

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

async function ensureDir() { await mkdir(defaultDir(), { recursive: true }); }
const fileOf = (id) => path.join(dirFor(id), `session-${id}.json`);

export async function newSession(title = '新会话') {
  await ensureDir();
  const now = Date.now();
  const s = { id: randomUUID(), title: String(title).slice(0, 60), createdAt: now, updatedAt: now, messages: [] };
  await writeFile(fileOf(s.id), JSON.stringify(s), 'utf8');
  return s;
}

export async function listSessions() {
  await ensureDir();
  const base = defaultDir(); // 列表永远只列「当前项目」的会话目录
  const files = (await readdir(base)).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(await readFile(path.join(base, f), 'utf8'));
      out.push({
        id: s.id,
        title: String(s.title || '').replace(/\n\n\[附件\][\s\S]*$/, '').trim() || '新会话',
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

export async function loadSession(id) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return JSON.parse(await readFile(fileOf(id), 'utf8'));
}

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

export async function appendTurn(id, userMsg, assistantMsg) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const s = await loadSession(id);
    s.messages.push({ role: 'user', content: userMsg, at: Date.now() });
    s.messages.push({ role: 'assistant', content: assistantMsg.content ?? '', error: assistantMsg.error ?? null, interrupted: !!assistantMsg.interrupted, reasoning: assistantMsg.reasoning ?? '', trace: assistantMsg.trace ?? [], at: Date.now() });
    const firstUser = s.messages.find((m) => m.role === 'user');
    if (s.messages.filter((m) => m.role === 'user').length === 1 && firstUser) {
      s.title = prettyTitle(firstUser.content) || '新会话';
    }
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, title: s.title, updatedAt: s.updatedAt };
  });
}

// 用户在「发送那一刻」就落盘（不等 AI 回答）：中途切会话 / 关窗 / 崩溃都不会丢这条消息
export async function appendUserMessage(id, userMsg) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const s = await loadSession(id);
    s.messages.push({ role: 'user', content: userMsg, at: Date.now() });
    const firstUser = s.messages.find((m) => m.role === 'user');
    if (s.messages.filter((m) => m.role === 'user').length === 1 && firstUser) {
      s.title = prettyTitle(firstUser.content) || '新会话';
    }
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, title: s.title, updatedAt: s.updatedAt };
  });
}

// 回答结束（正常 / 报错 / 中断都算）再补 assistant 部分，与上面成对
export async function appendAssistantMessage(id, assistantMsg) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const s = await loadSession(id);
    s.messages.push({
      role: 'assistant',
      content: assistantMsg.content ?? '',
      error: assistantMsg.error ?? null,
      interrupted: !!assistantMsg.interrupted,
      reasoning: assistantMsg.reasoning ?? '',
      trace: assistantMsg.trace ?? [],
      workedMs: assistantMsg.workedMs ?? null, // 重开会话也能显示「Worked for 2m 15s」
      at: Date.now()
    });
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, title: s.title, updatedAt: s.updatedAt };
  });
}

// 每个会话独立的模型配置（供应商/模型/思考强度）——切换会话不互相影响
export async function setModelConfig(id, cfg = {}) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const s = await loadSession(id);
    const prev = s.modelConfig || {};
    s.modelConfig = {
      providerId: String(cfg.providerId ?? prev.providerId ?? ''),
      model: String(cfg.model ?? prev.model ?? ''),
      effort: String(cfg.effort ?? prev.effort ?? ''),
    };
    await atomicWrite(fileOf(s.id), JSON.stringify(s)); // 只改模型配置，不动 updatedAt（避免会话跳到最前）
    return { id: s.id, modelConfig: s.modelConfig };
  });
}

// 最近一次请求的真实 usage（重启后 Context 指示器仍能显示实测/缓存命中）
export async function setSessionUsage(id, usage) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const s = await loadSession(id);
    s.usage = usage && typeof usage === 'object' ? usage : null; // 只覆盖 usage，messages/title 等原样保留
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, usage: s.usage };
  });
}

// 编辑历史消息后从该条重开：保留前 keepUserTurns 个用户回合，其余（含被编辑那条）丢弃
export async function rewindToUserTurn(id, keepUserTurns) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  const keep = Math.max(0, Math.floor(Number(keepUserTurns) || 0));
  return withQueue(id, async () => {
    const s = await loadSession(id);
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
    if (!out.length) s.title = '新会话';
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, messages: out.length, title: s.title };
  });
}

export async function saveSummary(id, summary) {  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const s = await loadSession(id);
    s.summary = String(summary || '');
    s.summaryAt = Date.now();
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, summaryAt: s.summaryAt };
  });
}

export async function appendNotice(id, content, kind = 'notice') {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const s = await loadSession(id);
    s.messages.push({ role: 'notice', kind, content: String(content || ''), at: Date.now() });
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, updatedAt: s.updatedAt };
  });
}

export async function renameSession(id, title) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const s = await loadSession(id);
    s.title = String(title || '').replace(/\n\n\[附件\][\s\S]*$/, '').trim().slice(0, 80) || '新会话';
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, title: s.title };
  });
}

export async function setSessionFlags(id, flags = {}) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const s = await loadSession(id);
    for (const k of ['pinned', 'archived', 'unread']) if (k in flags) s[k] = !!flags[k];
    s.updatedAt = Date.now();
    await atomicWrite(fileOf(s.id), JSON.stringify(s));
    return { id: s.id, pinned: !!s.pinned, archived: !!s.archived, unread: !!s.unread };
  });
}

export async function markRead(id) {
  try { return await setSessionFlags(id, { unread: false }); } catch { return null; }
}

export async function moveSessionTo(id, targetDir) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  return withQueue(id, async () => {
    const s = await loadSession(id);
    s.updatedAt = Date.now();
    const destDir = path.resolve(String(targetDir || ''));
    await mkdir(destDir, { recursive: true });
    const dest = path.join(destDir, `session-${s.id}.json`);
    await atomicWrite(dest, JSON.stringify(s));
    await unlink(fileOf(id)).catch(() => {});
    return { id: s.id, path: dest };
  });
}

export async function deleteSession(id) {
  if (!OK_ID.test(id)) throw new Error('非法会话 ID');
  await unlink(fileOf(id)).catch(() => {});
  return true;
}
