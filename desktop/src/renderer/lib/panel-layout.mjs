// 右侧面板（产物预览 / 子代理过程）的宽度策略。
//
// 问题（用户 2026-11-19 实机截图）：右栏是并排 flex，宽度上限写死成「窗口 72%」。
// 1010px 窗口 → 右栏可占 727px，侧栏 212px，正文只剩 71px——整个主区被压没了，
// 输入框挤成最下面一条。这不是「模型名太长」的问题，是面板根本没考虑正文还剩多少。
//
// 现在分两档：
//   rail  —— 并排。右栏占用后正文仍 >= MIN_MAIN_WIDTH，正常拖拽。
//   sheet —— 浮层。正文放不下了，右栏改为覆盖在正文上方（带遮罩），正文保持完整宽度。
//
// 纯函数，无 DOM 依赖，供 App / 面板与单测共用。

/** 正文在并排模式下的最小可用宽度（低于它就改浮层） */
export const MIN_MAIN_WIDTH = 680;
/** 并排时最多把期望宽度压到这个比例；再低就说明并排根本装不下，改浮层 */
export const RAIL_SHRINK_TOLERANCE = 0.9;
/** 侧栏宽度（与 Sidebar.jsx 的 w-[212px] 一致） */
export const SIDEBAR_WIDTH = 212;
/** 浮层模式下右栏占窗口宽度的比例，以及绝对值上下限。
 *  用「扣除侧栏后的可用宽度」算比例，而不是窗口宽度——否则窄窗口下
 *  浮层会把正文挤成一条缝（1010 窗口 × 0.62 = 626，扣掉侧栏 212 后正文只剩 172）。 */
export const SHEET_RATIO = 0.72;
export const SHEET_MIN = 320;
export const SHEET_MAX = 900;
/** 浮层允许覆盖的最大宽度：必须给正文留下这么多可见空间。
 *  340 而不是 260：260 在 1010 窗口下浮层占 67%，正文只剩一条缝，
 *  用户看不出「后面还有内容」，观感和「被挤坏」一样。 */
export const SHEET_RESERVE = 340;

/** 并排模式下右栏允许的最大宽度 = 窗口 - 侧栏 - 正文最小宽 */
export function maxRailWidth(windowWidth, { sidebar = SIDEBAR_WIDTH, minMain = MIN_MAIN_WIDTH } = {}) {
  const w = Number(windowWidth) || 0;
  return Math.max(0, Math.round(w - sidebar - minMain));
}

/**
 * 给定窗口宽度与期望宽度，决定用哪种模式。
 * @returns {{ mode: 'rail'|'sheet', width: number, maxRail: number }}
 */
export function planPanelLayout({ windowWidth, desiredWidth, sidebar = SIDEBAR_WIDTH, minMain = MIN_MAIN_WIDTH } = {}) {
  const win = Math.max(0, Math.round(Number(windowWidth) || 0));
  const want = Math.max(0, Math.round(Number(desiredWidth) || 0));
  const maxRail = maxRailWidth(win, { sidebar, minMain });
  // 并排放得下「期望宽度」且正文仍够宽 → 并排
  if (maxRail > 0 && want <= maxRail) return { mode: 'rail', width: want, maxRail };
  // 装不下：只有「轻微收缩」才并排——把右栏压到期望的 90% 以上
  const shrinkFloor = Math.round(want * RAIL_SHRINK_TOLERANCE);
  if (maxRail >= shrinkFloor && shrinkFloor > 0) return { mode: 'rail', width: maxRail, maxRail };
  // 否则改浮层：浮层覆盖正文，但仍要留出一截让用户看得见「后面还有内容」，
  // 否则视觉上和「正文被挤成一条缝」没区别（用户实机反馈就是这个观感）。
  const available = Math.max(0, win - sidebar);
  const capByReserve = Math.max(SHEET_MIN, available - SHEET_RESERVE);
  const sheetW = Math.min(SHEET_MAX, capByReserve, Math.max(SHEET_MIN, Math.round(available * SHEET_RATIO)));
  return { mode: 'sheet', width: sheetW, maxRail };
}

/** 拖拽时的钳制：并排不超 maxRail；浮层不超 SHEET_MAX，也不小于 SHEET_MIN */
export function clampPanelWidth({ windowWidth, width, mode }) {
  const win = Math.max(0, Math.round(Number(windowWidth) || 0));
  const w = Math.max(0, Math.round(Number(width) || 0));
  if (mode === 'sheet') return Math.min(SHEET_MAX, Math.max(SHEET_MIN, w));
  return Math.min(maxRailWidth(win), Math.max(0, w));
}
