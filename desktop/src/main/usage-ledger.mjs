// 用量账本：%APPDATA%/FinalCheck/usage.json（FINALCHECK_USAGE_FILE 可覆盖，测试/便携场景用）
// 形状 { version: 1, events: [{ at, model, providerId, prompt, completion, cached }] }
// 追加式；写入走 tmp+rename 原子替换；只保留最近 180 天、最多 5000 条。
// 文件损坏时回退空账本并 warning，绝不阻塞对话。
import { readFile, writeFile, mkdir, rename, stat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const USAGE_VERSION = 1;
export const RETENTION_DAYS = 180;
export const MAX_EVENTS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const warnedFiles = new Set();

/** 账本文件路径：env 覆盖优先，否则 %APPDATA%/FinalCheck/usage.json */
export function usageFilePath() {
  const envFile = process.env.FINALCHECK_USAGE_FILE;
  if (envFile && envFile.trim()) return path.resolve(envFile.trim());
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'FinalCheck', 'usage.json');
  }
  return path.join(os.homedir(), 'FinalCheck', 'usage.json');
}

// 进程内缓存（file + mtime/size 签名）：连续 append 不必每次都重读整个账本。
// 文件被外部改写/删除时签名变化，自动失效，不会把旧内容写回去。
let cache = { file: null, sig: null, events: null };

const fileSig = async (file) => {
  try {
    const st = await stat(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
};

const setCache = (file, sig, events) => { cache = { file, sig, events }; };

const numOrNull = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

const emptyLedger = () => ({ version: USAGE_VERSION, events: [] });

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return {
    at,
    model: String(raw.model ?? '').trim() || 'unknown',
    providerId: String(raw.providerId ?? '').trim(),
    prompt: numOrNull(raw.prompt),
    completion: numOrNull(raw.completion),
    cached: numOrNull(raw.cached)
  };
}

function warnCorrupt(file, err) {
  if (warnedFiles.has(file)) return;
  warnedFiles.add(file);
  console.warn(`[usage-ledger] 账本损坏/不可读，已回退空账本（${file}）：${(err && err.message) || err}`);
}

/** 读取账本；文件不存在返回空账本，损坏文件 warning 后回退空账本。 */
export async function readUsage() {
  const file = usageFilePath();
  const sig = await fileSig(file);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') warnCorrupt(file, e);
    setCache(file, sig, []);
    return emptyLedger();
  }
  try {
    const parsed = JSON.parse(text);
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    const clean = events.map(normalizeEvent).filter(Boolean).sort((a, b) => a.at - b.at);
    setCache(file, sig, clean);
    return { version: USAGE_VERSION, events: clean };
  } catch (e) {
    warnCorrupt(file, e);
    setCache(file, sig, []);
    return emptyLedger();
  }
}

async function writeLedger(ledger) {
  const file = usageFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger), 'utf8');
  // Windows：账本正被读句柄占着时 rename 会 EPERM/EBUSY（Usage 页刷新与「按请求记账」并发写入）。
  // 短暂退避重试，避免一条真实用量事件因瞬时占用被丢掉；重试仍失败交给调用方 catch（绝不阻塞对话）。
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, file);
      return;
    } catch (e) {
      const retryable = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (!retryable || attempt >= 8) {
        await rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
    }
  }
}

// 进程内追加队列：并发 append 串行执行，避免读改写互相覆盖。
let appendQueue = Promise.resolve();
function enqueue(task) {
  const run = appendQueue.then(task, task);
  appendQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 追加一条用量事件。
 * @param {{at?:number, model?:string, providerId?:string, prompt?:number|null, completion?:number|null, cached?:number|null}} evt
 * @returns {Promise<{ok:true, count:number, event:object}>}
 */
export function appendUsage(evt = {}) {
  return enqueue(async () => {
    const event = normalizeEvent({ at: Date.now(), ...evt });
    if (!event) throw new Error('非法用量事件：at 必须是有效时间戳');
    const file = usageFilePath();
    const sig = await fileSig(file);
    const existing = (cache.file === file && cache.sig === sig && cache.events)
      ? cache.events
      : (await readUsage()).events;
    const now = Date.now();
    const cutoff = now - RETENTION_DAYS * DAY_MS;
    const kept = [...existing, event]
      .filter((e) => e.at >= cutoff)
      .sort((a, b) => a.at - b.at);
    const events = kept.length > MAX_EVENTS ? kept.slice(-MAX_EVENTS) : kept;
    await writeLedger({ version: USAGE_VERSION, events });
    setCache(file, await fileSig(file), events);
    return { ok: true, count: events.length, event };
  });
}

const pad2 = (n) => String(n).padStart(2, '0');
const dateKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const parseDayKey = (key) => {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
};
// a - b 的自然日差（按本地日期，四舍五入抵消 DST 的 23/25 小时）
const dayDiff = (aKey, bKey) => Math.round((parseDayKey(aKey) - parseDayKey(bKey)) / DAY_MS);
const tokensOf = (e) => (e.prompt || 0) + (e.completion || 0);

/**
 * 计算用量统计。
 * @param {{days?:number, sessions?:Array<{createdAt?:number, updatedAt?:number}>}} opts
 *   days 默认 7；sessions 可选，仅用于 longestSessionMs（updatedAt-createdAt 最大值，没有则 0）
 */
export async function computeStats({ days = 7, sessions = null } = {}) {
  const windowDays = Math.min(Math.max(Math.floor(Number(days)) || 7, 1), 365);
  const { events } = await readUsage();

  let totalTokens = 0;
  const daily = new Map(); // dateKey → { byModel, total }
  const modelTotals = new Map();
  for (const e of events) {
    const tokens = tokensOf(e);
    totalTokens += tokens;
    const key = dateKey(e.at);
    const day = daily.get(key) || { byModel: {}, total: 0 };
    day.byModel[e.model] = (day.byModel[e.model] || 0) + tokens;
    day.total += tokens;
    daily.set(key, day);
    modelTotals.set(e.model, (modelTotals.get(e.model) || 0) + tokens);
  }

  // peakTokens：全部历史里单日最高
  let peakTokens = 0;
  for (const d of daily.values()) if (d.total > peakTokens) peakTokens = d.total;

  // streak：按有事件的自然日；当前连续天数允许最后一次活动是今天或昨天
  const allKeys = [...daily.keys()].sort();
  let longestStreakDays = 0;
  let run = 0;
  for (let i = 0; i < allKeys.length; i++) {
    run = i > 0 && dayDiff(allKeys[i], allKeys[i - 1]) === 1 ? run + 1 : 1;
    if (run > longestStreakDays) longestStreakDays = run;
  }
  let currentStreakDays = 0;
  if (allKeys.length) {
    const latest = allKeys[allKeys.length - 1];
    if (dayDiff(dateKey(Date.now()), latest) <= 1) {
      currentStreakDays = 1;
      for (let i = allKeys.length - 2; i >= 0; i--) {
        if (dayDiff(allKeys[i + 1], allKeys[i]) !== 1) break;
        currentStreakDays++;
      }
    }
  }

  // days：窗口内补齐缺失日期为 0（按自然日，最新一天在末尾）
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const windowDates = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    windowDates.push(dateKey(d.getTime()));
  }
  const daysOut = windowDates.map((date) => {
    const hit = daily.get(date);
    return { date, byModel: hit ? { ...hit.byModel } : {}, total: hit ? hit.total : 0 };
  });

  // models：全部历史，按总量降序，share 为 0–1
  const models = [...modelTotals.entries()]
    .map(([model, tokens]) => ({ model, tokens, share: totalTokens > 0 ? tokens / totalTokens : 0 }))
    .sort((a, b) => (b.tokens - a.tokens) || a.model.localeCompare(b.model));

  // longestSessionMs：可选，从会话 updatedAt-createdAt 估计；没有会话信息就是 0
  let longestSessionMs = 0;
  if (Array.isArray(sessions)) {
    for (const s of sessions) {
      const delta = Number(s?.updatedAt) - Number(s?.createdAt);
      if (Number.isFinite(delta) && delta > longestSessionMs) longestSessionMs = delta;
    }
  }

  return { totalTokens, peakTokens, longestSessionMs, currentStreakDays, longestStreakDays, days: daysOut, models };
}
