// 界面缩放（0.34.1）：Ctrl/Cmd + `+` / `-` / `0` 放大、缩小、复位。
//
// 用户原话：「桌面端可以 ctrl + - 来放大缩小」。
//
// 为什么放在主进程而不是渲染层：
//   ① 缩放必须作用于 webContents（`setZoomFactor`），渲染层改不动自己；
//   ② 快捷键要在**输入框里打字时也生效**（浏览器默认的 Ctrl+± 在 Electron 无菜单时不触发），
//      靠渲染层 keydown 拦截容易被 IME / 富文本吞掉；
//   ③ 需要记住用户的选择（下次启动还放大着），落 localStorage 做不到跨窗口，落 config 更稳。
//
// 关键细节（踩过/易踩）：
//   · `setZoomFactor` 的值是**倍率**不是百分比；0.5–3.0 之外会看不清/撑爆，必须夹紧。
//   · `setZoomFactor` 只影响当前 webContents；View 层的内嵌浏览器有它自己的 zoom（browser-view-host），
//     这里刻意不碰——用户要的是「界面」放大，不是网页内容。
//   · 缩放会触发重排，是重活；所以按步进离散档位（不是连续值），且节流。
//
// 重要（和 attention.mjs 同一个坑）：**不能在模块顶层静态 import electron**。
// 纯 Node（测试 / CLI / 无头引擎）加载会报
//   `Named export 'app' not found. The requested module 'electron' is a CommonJS module`
// 所以 electron 只在使用时惰性取，取不到就降级成「只更新内部状态、不动窗口」。

let electronMod = null;
function loadElectron() {
  if (electronMod !== null) return electronMod;
  try {
    const m = new Function('return require("electron")')();
    electronMod = (m && typeof m === 'object' && typeof m.BrowserWindow?.getAllWindows === 'function') ? m : false;
  } catch {
    electronMod = false;
  }
  return electronMod;
}

const MIN = 0.5;
const MAX = 3.0;
const LEVELS = [0.5, 0.6, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const DEFAULT = 1;

let current = DEFAULT;
let wired = false;

const clamp = (v) => Math.min(MAX, Math.max(MIN, v));

function nearestLevel(dir, from) {
  const i = LEVELS.findIndex((v) => Math.abs(v - from) < 0.001);
  if (i >= 0) return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, i + dir))];
  // 不在标准档上：按方向找第一个更大/更小的
  if (dir > 0) return LEVELS.find((v) => v > from + 0.001) ?? MAX;
  return [...LEVELS].reverse().find((v) => v < from - 0.001) ?? MIN;
}

/** 当前缩放倍率 */
export function getZoom() { return current; }

/**
 * 应用缩放。factor 省略时用当前位置。
 * @param {any} win  BrowserWindow（省略则作用于所有窗口）
 * @param {number} [factor]
 * @returns {number} 生效后的倍率
 */
export function applyZoom(win, factor) {
  const target = clamp(Number(factor) || DEFAULT);
  current = target;
  const e = loadElectron();
  const wins = (win && !win.isDestroyed?.()) ? [win] : (e ? e.BrowserWindow.getAllWindows() : []);
  for (const w of wins) {
    try { w.webContents.setZoomFactor(target); } catch { /* 已销毁 */ }
  }
  try { e?.app?.emit?.('fc-zoom-changed', target); } catch { /* 忽略 */ }
  return target;
}

/** 按方向调一档：dir=+1 放大 / -1 缩小 / 0 复位 */
export function stepZoom(win, dir) {
  if (dir === 0) return applyZoom(win, DEFAULT);
  return applyZoom(win, nearestLevel(dir > 0 ? 1 : -1, current));
}

/**
 * 装上快捷键。幂等：重复调用只装一次。
 * @param {object} o
 * @param {()=>any} o.getWin
 * @param {(z:number)=>void} [o.persist]  保存偏好（存 config）
 * @param {number} [o.start]  启动时恢复的倍率
 */
export function installZoomShortcuts({ getWin, persist = null, start = null } = {}) {
  if (wired) return current;
  wired = true;
  if (Number.isFinite(Number(start)) && Number(start) > 0) current = clamp(Number(start));

  // 用 webContents 的 before-input-event：比渲染层 window keydown 更可靠
  // （IME 组合中、焦点在 input 里、甚至焦点在内嵌浏览器面板时都能拦到）。
  const attach = (win) => {
    if (!win || win.isDestroyed?.() || win.__fcZoomAttached) return;
    win.__fcZoomAttached = true;
    try { win.webContents.setZoomFactor(current); } catch { /* 忽略 */ }
    // 诊断开关：FINALCHECK_ZOOM_DEBUG=1 时把每次拦截打出来（排查「按了没反应」用）
    const dbg = process.env.FINALCHECK_ZOOM_DEBUG === '1';
    win.webContents.on('before-input-event', (event, input) => {
      const mod = process.platform === 'darwin' ? input.meta : input.control;
      if (dbg && input.type === 'keyDown' && mod) {
        try { console.log(`[zoom] ctrl+${JSON.stringify(input.key)} code=${input.code}`); } catch { /* 忽略 */ }
      }
      if (input.type !== 'keyDown') return;
      if (!mod) return;
      const key = String(input.key || '');
      // `+` 在美式键盘要按 Shift，所以 input.key 可能是 '='；数字小键盘是 '+'。三种都认。
      const isPlus = key === '+' || key === '=' || key === 'add' || input.code === 'Equal' || input.code === 'NumpadAdd';
      const isMinus = key === '-' || key === '_' || key === 'subtract' || input.code === 'Minus' || input.code === 'NumpadSubtract';
      const isZero = key === '0' || input.code === 'Digit0' || input.code === 'Numpad0';
      if (!isPlus && !isMinus && !isZero) return;
      event.preventDefault();
      const z = dir => { const r = stepZoom(getWin(), dir); try { persist?.(r); } catch { /* 忽略 */ } };
      if (isPlus) z(+1);
      else if (isMinus) z(-1);
      else z(0);
    });
  };

  const e = loadElectron();
  if (e) e.app.on('browser-window-created', (_evt, win) => attach(win));
  const existing = getWin?.();
  if (existing) attach(existing);
  return current;
}

/** 供「设置」页读当前值 */
export function zoomLevelList() { return LEVELS.slice(); }
