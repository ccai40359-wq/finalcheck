// 右侧面板（产物预览 / 子代理过程）的宽度策略。
//
// 问题（用户 2026-11-19 实机截图）：右栏是并排 flex，宽度上限写死成「窗口 72%」。
// 1010px 窗口 → 右栏可占 727px，侧栏 212px，正文只剩 71px——主区被压没了。
//
// 用户定案：**不要浮层/抽屉/遮罩**（抽屉会盖住正文，中间也滑不动）。
// 就保持并排，但**收缩右栏宽度**，让正文始终有一块能用的地方。
// 所以这里只算「右栏最多能占多宽」，不再有第二套浮层布局。
//
// 纯函数，无 DOM 依赖，供 App / 面板与单测共用。

/** 侧栏宽度（与 Sidebar.jsx 的 w-[212px] 一致） */
export const SIDEBAR_WIDTH = 212;
/** 正文最少要保留的宽度。窄窗口下右栏必须让位到这个下限之上。 */
export const MIN_MAIN_WIDTH = 420;
/** 右栏自身的最小可用宽度（再窄就没法看内容了，此时允许正文进一步压缩） */
export const MIN_PANEL_WIDTH = 300;

/** 并排模式下右栏允许的最大宽度 = 窗口 − 侧栏 − 正文最小宽 */
export function maxRailWidth(windowWidth, { sidebar = SIDEBAR_WIDTH, minMain = MIN_MAIN_WIDTH } = {}) {
  const w = Number(windowWidth) || 0;
  return Math.max(0, Math.round(w - sidebar - minMain));
}

/**
 * 给定窗口宽度与期望宽度，算出右栏实际宽度（始终并排，永不浮层）。
 * 规则：优先满足期望宽度，但绝不把正文压到 MIN_MAIN_WIDTH 以下；
 *      窗口实在太小、连 MIN_PANEL_WIDTH 都给不出时，按比例对半分。
 * @returns {{ mode: 'rail', width: number, maxRail: number }}
 */
export function planPanelLayout({ windowWidth, desiredWidth, sidebar = SIDEBAR_WIDTH, minMain = MIN_MAIN_WIDTH } = {}) {
  const win = Math.max(0, Math.round(Number(windowWidth) || 0));
  const want = Math.max(0, Math.round(Number(desiredWidth) || 0));
  const available = Math.max(0, win - sidebar);
  const maxRail = Math.max(0, available - minMain);
  // 期望宽度在可用范围内 → 照用
  if (want <= maxRail) return { mode: 'rail', width: want, maxRail };
  // 期望太宽：收到 maxRail（这样正文正好保住 minMain）
  if (maxRail >= MIN_PANEL_WIDTH) return { mode: 'rail', width: maxRail, maxRail };
  // 窗口太小：两边各让一半，谁都不至于没有
  return { mode: 'rail', width: Math.max(0, Math.round(available / 2)), maxRail };
}

/**
 * 拖拽时的钳制。
 * 拖到最小宽（< CLOSE_AT）表示用户想关掉面板 —— 由调用方判定关闭；
 * 这里只负责把宽度限制在合法区间内。
 */
export const CLOSE_AT = 220;

export function clampPanelWidth({ windowWidth, width, sidebar = SIDEBAR_WIDTH, minMain = MIN_MAIN_WIDTH }) {
  const win = Math.max(0, Math.round(Number(windowWidth) || 0));
  const w = Math.max(0, Math.round(Number(width) || 0));
  const available = Math.max(0, win - sidebar);
  const upper = Math.max(0, available - minMain);
  if (upper >= MIN_PANEL_WIDTH) return Math.min(upper, w);
  return Math.min(Math.max(w, 0), Math.round(available / 2));
}

/** 拖到这个宽度以下就当“想关闭”（由调用方 onClose） */
export function shouldClosePanel(width) {
  return Math.round(Number(width) || 0) < CLOSE_AT;
}
