// 0.30.0（特性 3）：wait-for——动作后等待界面变化（元素出现/消失/文字等于/包含）。
//
// 关键语义（reviewer R7）：**超时不等于失败**。超时返回 ok:true, matched:false, timedOut:true；
// ok:false 会置 stopAutomation 把后续动作全杀掉（0.29.x 的失败闸行为），用户要的是「等不到就
// 如实说明、继续做别的」，不是整轮中断。
// R10：无 UIA 应用（微信/Electron）快速失败，不硬等满超时；窗口关闭/hwnd 失效立即返回。
//
// 轮询默认 200ms、默认超时 5s、上限 30s；clock/poll 可注入 → 纯函数直测（不起真进程）。
import { uiaApplicability } from './uia-adapter.mjs';

export const DEFAULT_POLL_MS = 200;
export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 30000;

export const WAIT_CONDITIONS = Object.freeze(['element-exists', 'element-gone', 'value-equals', 'value-contains']);

/** 超时预算归一：非法/缺失 → 默认 5s；<1 → 默认；>30s → 30s（不报错，夹到上限）。 */
export function normalizeTimeout(timeoutMs) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.floor(n));
}

/** 轮询间隔归一：默认 200ms；小于 50ms 提到 50ms（防高频 COM 调用打爆目标应用）。 */
export function normalizePoll(pollMs) {
  const n = Number(pollMs);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_POLL_MS;
  return Math.max(50, Math.floor(n));
}

/**
 * 参数校验（纯函数）。返回 null = 合法，否则返回给模型看的错误文案。
 * element-* 必须有 target.selector；value-* 必须有 value 字符串。
 */
export function validateWaitFor(waitFor) {
  if (waitFor == null) return null;
  if (typeof waitFor !== 'object' || Array.isArray(waitFor)) return 'wait_for 必须是对象。';
  const condition = String(waitFor.condition ?? '').trim();
  if (!WAIT_CONDITIONS.includes(condition)) {
    return `wait_for.condition 只支持 ${WAIT_CONDITIONS.join(' / ')}。`;
  }
  if (condition.startsWith('element-')) {
    const selector = String(waitFor.target?.selector ?? '').trim();
    if (!selector) return 'element-* 条件需要 target.selector（要等待的元素名称）。';
  } else if (typeof waitFor.value !== 'string') {
    return `${condition} 需要字符串 value。`;
  }
  return null;
}

/**
 * 单次条件求值（纯函数）：给定「当前观测快照」，判断条件是否命中。
 * observation 形状：
 *   { windowAlive: boolean, hasUiaTree: boolean, elements: string[], values: string[] }
 * 语义：
 *   element-exists → elements 里出现 selector（精确匹配或包含）
 *   element-gone   → elements 里不再有 selector
 *   value-equals   → values 里任一 === value
 *   value-contains → values 里任一包含 value
 * 窗口已关闭：element-gone 视为命中（目标没了 = 元素也没了）；其它条件不命中且带 windowClosed。
 */
export function evaluateWaitCondition(condition, observation, { selector = '', value = '' } = {}) {
  const obs = observation || {};
  const elements = Array.isArray(obs.elements) ? obs.elements.map((s) => String(s)) : [];
  const values = Array.isArray(obs.values) ? obs.values.map((s) => String(s)) : [];
  const sel = String(selector ?? '').trim();
  const val = String(value ?? '');
  if (condition === 'element-exists') {
    const hit = Boolean(sel) && elements.some((name) => name === sel || name.includes(sel));
    return { matched: hit, windowClosed: obs.windowAlive === false };
  }
  if (condition === 'element-gone') {
    if (obs.windowAlive === false) return { matched: true, windowClosed: true }; // R10：窗口没了 = 元素也没了
    const hit = !elements.some((name) => name === sel || name.includes(sel));
    return { matched: hit, windowClosed: false };
  }
  if (condition === 'value-equals') {
    return { matched: values.some((v) => v === val), windowClosed: obs.windowAlive === false };
  }
  if (condition === 'value-contains') {
    return { matched: Boolean(val) && values.some((v) => v.includes(val)), windowClosed: obs.windowAlive === false };
  }
  return { matched: false, windowClosed: obs.windowAlive === false };
}

/**
 * 轮询直到命中 / 超时 / 快速失败。**纯逻辑**：observe 与 clock 都是注入的。
 * @param {object} opts
 * @param {'element-exists'|'element-gone'|'value-equals'|'value-contains'} opts.condition
 * @param {string} [opts.selector]
 * @param {string} [opts.value]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.pollMs]
 * @param {() => Promise<object>} opts.observe 返回 observation 快照（抛错视为窗口失效）
 * @param {() => number} [opts.now] Date.now 注入
 * @param {(ms:number) => Promise<void>} [opts.sleep] 等待注入
 * @param {(obs:object) => boolean} [opts.failFast] 快速失败判定（R10：无 UIA 树 / 窗口已关）
 * @returns {Promise<object>} 结果：ok:true + matched/timedOut/attempts/elapsedMs（R7：超时不是 ok:false）
 */
export async function waitForCondition({
  condition, selector = '', value = '', timeoutMs, pollMs,
  observe, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  failFast
}) {
  const budget = normalizeTimeout(timeoutMs);
  const interval = normalizePoll(pollMs);
  const startedAt = now();
  let attempts = 0;
  let last = { matched: false, windowClosed: false };

  while (true) {
    attempts++;
    let obs;
    try {
      obs = await observe();
    } catch (error) {
      // 观测抛出（UIA 宿主失败/窗口已销毁）→ 按窗口失效处理（R10 立即返回）
      return {
        ok: true, matched: condition === 'element-gone', timedOut: false, attempts,
        elapsedMs: now() - startedAt, windowClosed: true, reason: String(error?.message || error)
      };
    }
    last = evaluateWaitCondition(condition, obs, { selector, value });
    if (last.matched) {
      return {
        ok: true, matched: true, timedOut: false, attempts,
        elapsedMs: now() - startedAt, windowClosed: last.windowClosed === true
      };
    }
    // R10：目标窗口已关闭 / 无 UIA 树 → 立即返回（不硬等满超时）
    if (last.windowClosed) {
      return {
        ok: true, matched: false, timedOut: false, attempts,
        elapsedMs: now() - startedAt, windowClosed: true,
        reason: '目标窗口已关闭'
      };
    }
    if (typeof failFast === 'function' && failFast(obs)) {
      return {
        ok: true, matched: false, timedOut: false, attempts,
        elapsedMs: now() - startedAt, windowClosed: false, reason: 'no-uia-tree'
      };
    }
    if (now() - startedAt >= budget) {
      // R7：超时 → ok:true + matched:false + timedOut:true（不是失败）
      return {
        ok: true, matched: false, timedOut: true, attempts,
        elapsedMs: now() - startedAt, windowClosed: false,
        reason: `等待 ${budget}ms 未命中`
      };
    }
    await sleep(interval);
  }
}

/**
 * 应用快速失败判定（R10）：进程没有 UIA 树（微信/Electron/Chromium）时不该硬等。
 * 显式传入 windowAlive=false 也快速失败（窗口关闭另有分支，这里只兜底）。
 */
export function makeFailFast(condition, processName, { cache } = {}) {
  // element-* 才依赖 UIA 树；value-* 走文本观测（也经 UIA，所以同样适用）
  const verdict = uiaApplicability(processName, { cache });
  if (verdict === 'skip') {
    return () => true; // 直接一次就返回（reason: 'no-uia-tree'）
  }
  return null;
}
