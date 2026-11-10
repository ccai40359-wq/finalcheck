// 工作流 journal（落盘 + 断点恢复用）：
// 一次 run 一个 <runId>.json，原子写入（.tmp 后 rename）；步骤结束时由引擎更新条目。
// 本模块只负责 journal 的形状与 I/O，不参与调度，也不依赖 workflow.mjs（避免循环依赖）。
import fs from 'node:fs/promises';
import path from 'node:path';

export const JOURNAL_VERSION = 1;

/** runId 只允许安全字符，既做校验也防路径穿越 */
export function isValidRunId(runId) {
  return typeof runId === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(runId);
}

/**
 * 生成 runId：时间戳 + 随机串。
 * now / random 可注入，测试里传函数或值都可以。
 * @param {{now?: (()=>number)|number, random?: (()=>number)|number}} [opts]
 */
export function runIdOf({ now = Date.now, random = Math.random } = {}) {
  const rawNow = typeof now === 'function' ? now() : now;
  const ms = Number(rawNow);
  const stamp = new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().replace(/[-:.TZ]/g, '');
  const rawRandom = typeof random === 'function' ? random() : random;
  const r = Number(rawRandom);
  const rand = Math.floor((Number.isFinite(r) ? Math.abs(r) : Math.random()) * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
    .slice(-8);
  return `wf-${stamp}-${rand}`;
}

/** 新建一份 v1 journal（steps 为空对象） */
export function createJournal({ runId = runIdOf(), goal = '', startedAt = Date.now() } = {}) {
  if (!isValidRunId(runId)) throw new Error(`runId 非法：${runId}`);
  const t = Number(startedAt);
  return {
    version: JOURNAL_VERSION,
    runId,
    goal: String(goal ?? ''),
    startedAt: Number.isFinite(t) ? t : Date.now(),
    finishedAt: null,
    stopped: false,
    steps: {},
  };
}

/** 写一条步骤记录（覆盖同 id）；只接受 success|failed|cancelled 三种状态 */
export function recordStep(journal, step, patch = {}) {
  if (!journal || typeof journal !== 'object') throw new Error('journal 必须是对象');
  if (!journal.steps || typeof journal.steps !== 'object' || Array.isArray(journal.steps)) journal.steps = {};
  const id = String(patch.id || step?.id || '').trim();
  if (!id) throw new Error('步骤 id 不能为空');
  const status = ['success', 'failed', 'cancelled'].includes(patch.status) ? patch.status : 'failed';
  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const dependsOn = Array.isArray(patch.depends_on)
    ? patch.depends_on
    : (Array.isArray(step?.depends_on) ? step.depends_on : []);
  const entry = {
    name: String(patch.name ?? step?.name ?? ''),
    role: String(patch.role ?? step?.role ?? ''),
    hash: String(patch.hash ?? ''),
    depends_on: dependsOn.map(String),
    status,
    content: String(patch.content ?? ''),
    error: patch.error == null ? null : String(patch.error),
    // 结构化错误码（失败步骤才有；旧 journal 没有该字段，读出来就是 undefined → 调用方按无码回落）
    errorCode: patch.errorCode == null ? null : String(patch.errorCode),
    ms: num(patch.ms),
    tools: num(patch.tools),
    startedAt: num(patch.startedAt),
    finishedAt: num(patch.finishedAt, Date.now()),
  };
  journal.steps[id] = entry;
  return entry;
}

let tmpSeq = 0;

/**
 * 原子写 journal：先写 <runId>.json.tmp-* 再 rename 到 <dir>/<runId>.json。
 * 目录不存在会自动创建。
 * @returns {Promise<string>} 最终文件路径
 */
export async function saveJournal(journal, { dir } = {}) {
  if (!journal || typeof journal !== 'object') throw new Error('journal 必须是对象');
  if (!isValidRunId(journal.runId)) throw new Error(`journal.runId 非法：${journal.runId}`);
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('saveJournal 需要 dir');
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${journal.runId}.json`);
  const tmp = path.join(dir, `${journal.runId}.json.tmp-${process.pid}-${++tmpSeq}`);
  const data = JSON.stringify(journal, null, 2) + '\n';
  await fs.writeFile(tmp, data, 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (e) {
    // Windows 上目标已存在时少数环境会拒绝 rename：退化为「删旧再 rename」，仍不会写出半个文件
    if (e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES')) {
      await fs.rm(target, { force: true });
      try {
        await fs.rename(tmp, target);
      } catch (e2) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw e2;
      }
    } else {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }
  return target;
}

/** 读 journal；文件不存在返回 null，损坏或版本不匹配抛错 */
export async function loadJournal(runId, { dir } = {}) {
  if (!isValidRunId(runId)) throw new Error(`runId 非法：${runId}`);
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('loadJournal 需要 dir');
  const file = path.join(dir, `${runId}.json`);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
  let journal;
  try {
    journal = JSON.parse(text);
  } catch {
    throw new Error(`journal 文件损坏：${file}`);
  }
  if (!journal || journal.version !== JOURNAL_VERSION) throw new Error(`journal 版本不支持：${journal?.version}`);
  if (journal.runId !== runId) throw new Error(`journal runId 与文件名不一致：${runId}`);
  return journal;
}

/** 列出目录下所有合法 journal，按 startedAt 倒序（供 UI 的断点列表用） */
export async function listJournals({ dir } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('listJournals 需要 dir');
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      const journal = JSON.parse(text);
      if (journal && journal.version === JOURNAL_VERSION && isValidRunId(journal.runId)) out.push(journal);
    } catch {
      /* 单个损坏文件不影响列表 */
    }
  }
  out.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0) || String(b.runId).localeCompare(String(a.runId)));
  return out;
}

// ---- 断点续跑选择（ZCode 语义：中断/出错的运行，重发同一目标时自动复用已完成步骤） ----
export const RESUME_FRESH_MS = 7 * 24 * 60 * 60 * 1000; // 只认 7 天内的 journal，防止很久以前的旧运行突然「接管」新请求

/**
 * 从 journal 列表里挑出可以断点续跑的那一个。
 * 条件：目标完全一致 + 还新鲜（默认 7 天内）+ 确实没跑完（stopped / 没有 finishedAt / 有失败步骤）。
 * @param {Array<object>} journals listJournals() 的结果
 * @param {string} goalText 本次请求的总目标（完全一致才算同一次工作）
 * @returns {string|null} 可续跑的 runId；没有返回 null
 */
export function pickResumableRun(journals, goalText, { now = Date.now(), freshMs = RESUME_FRESH_MS } = {}) {
  const goal = String(goalText || '').trim();
  if (!goal) return null;
  const candidates = (Array.isArray(journals) ? journals : []).filter((j) => {
    if (!j || String(j.goal || '').trim() !== goal) return false;
    if ((Number(j.startedAt) || 0) < now - freshMs) return false;
    const steps = j.steps && typeof j.steps === 'object' ? Object.values(j.steps) : [];
    const unfinished = j.stopped === true || !j.finishedAt || steps.some((s) => s && s.status === 'failed');
    return unfinished;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
  const hit = candidates[0];
  return isValidRunId(hit.runId) ? hit.runId : null;
}
