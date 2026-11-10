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
