// 验收单（todo_write）：主进程校验/状态台账与渲染层卡片共用的纯函数。
// 与 ask_user 同一套路：工具参数/结果落库后，历史卡片从 trace 的 tool part 还原，不改会话 schema。
// - 状态机：pending → running → done | failed | skipped（可多次调用 todo_write 更新；也允许回退）
// - done 必须带 evidence（证据：文件:行 / 命令输出 / HTTP 复现），否则报告闸判不合格
// - failed / skipped 必须写进报告的 ## Not covered，否则报告闸判不合格
import { t } from '../i18n/core.mjs';

export const TODO_TOOL = 'todo_write';
export const TODO_STATUSES = Object.freeze(['pending', 'running', 'done', 'failed', 'skipped']);
export const TODO_MIN_ITEMS = 3;
export const TODO_MAX_ITEMS = 8;

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}

/** 工具参数可能是 JSON 字符串（function.arguments）或对象 */
export function parseTodoArgs(args) {
  let raw = args;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return { raw: {}, error: null };
    try { raw = JSON.parse(text); } catch { return { raw: {}, error: t('todo_write 参数不是合法 JSON') }; }
  }
  return { raw: asObject(raw) || {}, error: null };
}

/** 状态归一：缺省 pending；不认识的值原样返回 null（由校验层报错） */
export function normalizeTodoStatus(value) {
  if (value == null || value === '') return 'pending';
  const s = String(value).trim().toLowerCase();
  return TODO_STATUSES.includes(s) ? s : null;
}

function text(value, max = 2000) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 宽松归一（只用于展示）：不校验条数/必填，尽量把模型写的东西渲染出来 */
export function coerceTodoItems(input) {
  const list = Array.isArray(input) ? input : [];
  return list.map((it, i) => {
    const o = asObject(it) || {};
    return {
      id: text(o.id, 80) || `#${i + 1}`,
      task: text(o.task, 500),
      acceptance: text(o.acceptance, 1000),
      status: normalizeTodoStatus(o.status) || 'pending',
      evidence: text(o.evidence, 1000)
    };
  });
}

/**
 * 严格校验模型给的 items。
 * acceptance 必填：不写就报错把话递回给模型补，而不是静默收下一张没有验收标准的清单。
 * @param {any} input
 * @returns {{ok:true, items:Array<{id:string,task:string,acceptance:string,status:string,evidence:string}>} | {ok:false, error:string}}
 */
export function validateTodoItems(input) {
  if (!Array.isArray(input)) return { ok: false, error: t('todo_write 需要 items 数组（{min}-{max} 条）', { min: TODO_MIN_ITEMS, max: TODO_MAX_ITEMS }) };
  if (input.length < TODO_MIN_ITEMS || input.length > TODO_MAX_ITEMS) {
    return { ok: false, error: t('todo_write 需要 {min}-{max} 条任务，当前 {n} 条：按验收步骤拆分或合并后再调用', { min: TODO_MIN_ITEMS, max: TODO_MAX_ITEMS, n: input.length }) };
  }
  const items = [];
  const seen = new Set();
  for (let i = 0; i < input.length; i++) {
    const o = asObject(input[i]);
    const at = i + 1;
    if (!o) return { ok: false, error: t('第 {n} 条不是对象（需要 {id, task, acceptance, status?}）', { n: at }) };
    const id = text(o.id, 80);
    if (!id) return { ok: false, error: t('第 {n} 条缺少 id（稳定标识，更新状态时按 id 合并）', { n: at }) };
    if (seen.has(id)) return { ok: false, error: t('任务 id 重复：{id}', { id }) };
    seen.add(id);
    const task = text(o.task, 500);
    if (!task) return { ok: false, error: t('任务 {id} 缺少 task（这一步要做什么）', { id }) };
    const acceptance = text(o.acceptance, 1000);
    if (!acceptance) {
      return { ok: false, error: t('任务 {id} 缺少 acceptance（验收标准）：先想清楚「怎么算完成」再调用 todo_write，把验收标准补上', { id }) };
    }
    const status = normalizeTodoStatus(o.status);
    if (status == null) {
      return { ok: false, error: t('任务 {id} 的 status 非法：{status}（只能是 {allowed}）', { id, status: text(o.status, 40), allowed: TODO_STATUSES.join(' / ') }) };
    }
    items.push({ id, task, acceptance, status, evidence: text(o.evidence, 1000) });
  }
  return { ok: true, items };
}

/** 展示用文案（键会进 i18n 字典） */
export const TODO_DISPLAY_LABELS = Object.freeze({
  pending: '待做',
  running: '进行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
  interrupted: '已中断'
});

/** 展示用符号：已中断用空心圆，和「真的在跑」（◐ + 脉冲）区分开 */
export const TODO_DISPLAY_MARKS = Object.freeze({
  pending: '☐',
  running: '◐',
  done: '✓',
  failed: '✕',
  skipped: '—',
  interrupted: '◌'
});

/**
 * 展示态：running 只有在「这条消息所属回合仍在流式」时才算真的在跑。
 * 为什么需要：卡片是从最后一次 todo_write 的 args 还原的（重启/停止后也一样），
 * 停止、报错、崩溃都不会往会话里写终态，于是 running 会永远转圈。
 * 这里只改展示，原始 status 数据一个字都不动（历史/报告闸仍读到 running 原值）。
 * @param {{status?:string}|string} item
 * @param {boolean} live 这条卡片所属回合是否仍在流式
 * @returns {{status:string, raw:string, label:string, mark:string, pulse:boolean}}
 */
export function displayStatus(item, live = true) {
  const raw = normalizeTodoStatus(item && typeof item === 'object' ? item.status : item) || 'pending';
  const status = raw === 'running' && !live ? 'interrupted' : raw;
  return {
    status,
    raw,
    label: t(TODO_DISPLAY_LABELS[status]),
    mark: TODO_DISPLAY_MARKS[status],
    pulse: status === 'running'
  };
}

/**
 * 合并式更新：同一 id 的 evidence 沿用旧值，避免「第二次调用只改状态」把已有证据冲掉。
 * acceptance 每次必填（校验层保证），所以只合并 evidence。
 */
export function mergeTodoItems(prev, next) {
  const old = new Map((Array.isArray(prev) ? prev : []).map((it) => [it.id, it]));
  return (Array.isArray(next) ? next : []).map((it) => {
    const before = old.get(it.id);
    const evidence = it.evidence || before?.evidence || '';
    return { ...it, evidence };
  });
}

/** 进度汇总：卡片头部与工具返回值共用 */
export function todoProgress(items) {
  const list = Array.isArray(items) ? items : [];
  const count = (status) => list.filter((it) => it.status === status).length;
  return {
    total: list.length,
    done: count('done'),
    running: count('running'),
    pending: count('pending'),
    failed: count('failed'),
    skipped: count('skipped')
  };
}

/* ---------- 卡片渲染层（折叠 / 计数 / 持久化）---------- */

export const TODO_COLLAPSE_PREFIX = 'fc.todo.collapsed:';

/**
 * 卡片头部一句话摘要：计数、百分比、第一条任务、折叠后的单行文案。
 * label 只用于折叠态的一行标题（如「验收单 · 3/7」），不含状态，刷新后仍可比较。
 * @returns {{done:number,total:number,failed:number,skipped:number,percent:number,firstTask:string,label:string}}
 */
export function todoCardSummary(items) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const done = list.filter((it) => it?.status === 'done').length;
  const failed = list.filter((it) => it?.status === 'failed').length;
  const skipped = list.filter((it) => it?.status === 'skipped').length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const firstTask = list.find((it) => it && text(it.task, 500))?.task || '';
  return {
    done, total, failed, skipped, percent,
    firstTask: text(firstTask, 500),
    label: `${t('验收单')} · ${done}/${total}`
  };
}

/**
 * 整卡折叠状态的 localStorage key：sessionId + 任务 id 签名（不含 status，
 * 否则每完成一条就换 key，折叠状态会丢）。没有 sessionId 时退化为纯签名。
 */
export function todoCollapseKey(sessionId, items) {
  const sid = sessionId == null ? '' : String(sessionId).trim();
  const ids = (Array.isArray(items) ? items : [])
    .map((it) => text(it?.id, 80))
    .filter(Boolean)
    .join(',');
  const parts = [];
  if (sid) parts.push(`s:${sid}`);
  if (ids) parts.push(`i:${ids}`);
  return `${TODO_COLLAPSE_PREFIX}${parts.join('|') || 'default'}`;
}

// SSR（没有 window）与隐私模式下 localStorage 可能不可用：一律当作「没有存储」，不抛错。
function resolveStorage(storage) {
  if (storage && typeof storage.getItem === 'function') return storage;
  try {
    if (globalThis.localStorage && typeof globalThis.localStorage.getItem === 'function') return globalThis.localStorage;
  } catch { /* 访问被拒绝 */ }
  return null;
}

/** 读整卡折叠状态：只有存过 '1' 才算折叠，其余（缺省/读失败）一律展开 */
export function readTodoCollapsed(key, storage) {
  const store = resolveStorage(storage);
  if (!store || !key) return false;
  try { return store.getItem(key) === '1'; } catch { return false; }
}

/** 写整卡折叠状态；返回是否写成功（存储不可用时不阻塞渲染） */
export function writeTodoCollapsed(key, collapsed, storage) {
  const store = resolveStorage(storage);
  if (!store || !key) return false;
  try { store.setItem(key, collapsed ? '1' : '0'); return true; } catch { return false; }
}

/**
 * trace / 实时事件里的 todo_write 条目 → 卡片数据。
 * 事件形状：{ type:'tool', name, args, status, result? }；历史 trace：{ tool, args, result, error, status }。
 * 返回 items 为空且没有 error 时，调用方不渲染卡片。
 * @returns {{items:Array<{id:string,task:string,acceptance:string,status:string,evidence:string}>, error:string|null}}
 */
export function todoCardFromTrace(entry) {
  const { raw, error: parseError } = parseTodoArgs(entry?.args ?? entry?.function?.arguments);
  const result = asObject(entry?.result);
  const error = parseError
    || text(entry?.error ?? result?.error, 2000)
    || null;
  const items = coerceTodoItems(raw.items);
  return { items, error: error || null };
}

/** 从事件/回溯列表里取最后一条 todo_write（一次回合内可能调用多次，只渲染最新一张） */
export function latestTodoEntry(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!e) continue;
    const name = String(e.tool ?? e.name ?? '');
    if (name === TODO_TOOL) return e;
  }
  return null;
}

export function isTodoTrace(entry) {
  return String(entry?.tool ?? entry?.name ?? '') === TODO_TOOL;
}
