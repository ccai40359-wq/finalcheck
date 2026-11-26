// 任务栏提醒（0.34.1）：AI 需要你（提问/审批）或任务完成时，任务栏图标右下角亮红点 + 轻微气泡音。
//
// 用户原话：「只要是问用户问题，或者完成一个任务结束了，就会像 zcode 一样，
//            图标右下角出现红色的点，同时有轻微的气泡声音」。
//
// 实现要点（Electron 的限制，不能想当然）：
//   · 任务栏角标 = `win.setOverlayIcon(image, desc)`，**只有 Windows 支持**，macOS/Linux 静默跳过。
//   · 需要一个 16×16 的红点 PNG。不能靠 SVG 字符串（setOverlayIcon 要 NativeImage），
//     所以这里用 `nativeImage.createFromDataURL` 载一段内联 PNG（避免多打包一个资源文件）。
//   · 声音：Electron 没有跨平台系统音 API。Windows 用 PowerShell 播系统提示音
//     （`[System.Media.SystemSounds]::Asterisk.Play()`，不需要文件、不依赖外部资源）。
//     刻意**不需要用户先交互**才能响（Electron/Chromium 的音频限制在渲染层，这里是系统级播放）。
//   · 用户点回窗口 → 清掉角标。所以 `focus` 事件里 reset。
//
// 重要（踩过的坑）：**不能在这个模块顶层静态 import electron**。
// 纯 Node 环境（测试、CLI、无头引擎）加载本模块时会报
//   `Named export 'nativeImage' not found. The requested module 'electron' is a CommonJS module`
// 因为 electron 在非 Electron 进程里只是个「返回 exe 路径字符串」的占位包。
// 所以 electron 只在使用时惰性取，取不到就整体降级成 no-op。
import { spawn } from 'node:child_process';

let electronMod = null;
function loadElectron() {
  if (electronMod !== null) return electronMod;
  try {
    // 只有在真的 Electron 主进程里才能拿到 API（导入后 nativeImage 是对象而不是 undefined）
    const m = new Function('return require("electron")')();
    electronMod = (m && typeof m === 'object' && typeof m.nativeImage?.createFromBitmap === 'function') ? m : false;
  } catch {
    electronMod = false;
  }
  return electronMod;
}

// 16×16 红点用**代码生成位图**（见 dotImage），不放 base64 常量——
// 手改过的 base64 一错就整张图不可见，而位图是按像素算的，可测、可调半径/颜色。

let lastAt = 0;          // 节流：同一秒内不重复响
let soundProc = null;

/** 只在 Windows 真的支持；其他平台返回 false */
function overlaySupported(win) {
    return process.platform === 'win32' && !!win && typeof win.setOverlayIcon === 'function';
}

/** 画一个纯色圆点（不依赖外部 PNG 文件）。size=16 时任务栏最清晰 */
function dotImage(size = 16) {
  const e = loadElectron();
  if (!e) return null;
  const w = size, h = size;
  const buf = Buffer.alloc(w * h * 4);
  const cx = (w - 1) / 2, cy = (h - 1) / 2, r = w / 2 - 1.2;
  const [cr, cg, cb] = [0xe5, 0x48, 0x4d];   // #e5484d 偏红，浅色/深色任务栏都看得清
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      let a = 0;
      if (d <= r) a = 255;
      else if (d <= r + 1) a = Math.round(255 * (1 - (d - r)));   // 1px 抗锯齿
      const i = (y * w + x) * 4;
      buf[i] = cb; buf[i + 1] = cg; buf[i + 2] = cr; buf[i + 3] = a;   // BGRA
    }
  }
  try { return e.nativeImage.createFromBitmap(buf, { width: w, height: h }); } catch { return null; }
}

/** 播放系统气泡提示音（Windows）。异步、失败静默——声音不该影响任何逻辑 */
function playChime() {
  if (process.platform !== 'win32') return;
  const now = Date.now();
  if (now - lastAt < 900) return;   // 900ms 内不重复，避免连弹两次很吵
  lastAt = now;
  try {
    // 用 -NoProfile 启动，避免加载用户 profile 拖慢；-WindowStyle Hidden 不闪窗口
    soundProc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
      '[System.Media.SystemSounds]::Asterisk.Play()'
    ], { windowsHide: true, stdio: 'ignore', detached: false });
    soundProc.on('error', () => { /* 没 powershell 就算了 */ });
    soundProc.on('exit', () => { soundProc = null; });
    // 兜底：2 秒还没退就杀掉，防僵尸进程
    setTimeout(() => { try { soundProc?.kill(); } catch { /* 已退 */ } }, 2000).unref?.();
  } catch { /* 忽略 */ }
}

/**
 * 在任务栏图标上点亮提醒（红点 + 声音）。
 * @param {any} win  BrowserWindow
 * @param {'question'|'done'} kind  提问/审批 vs 完成
 * @param {string} [desc]  角标 tooltip（Windows 悬停可见）
 * @param {{sound?:boolean}} [opts]
 */
export function markAttention(win, kind = 'question', desc = '', opts = {}) {
  if (!win || win.isDestroyed?.()) return false;
  let marked = false;
  if (overlaySupported(win)) {
    try {
      const img = dotImage(16);
      if (img) {
        win.setOverlayIcon(img, desc || (kind === 'question' ? 'FinalCheck：需要你回答' : 'FinalCheck：任务已完成'));
        marked = true;
      }
    } catch { /* 角标失败不影响声音 */ }
  }
  // 窗口在后台才响；前台已经看得见，不需要再吵
  const hidden = !win.isVisible?.() || win.isMinimized?.() || !win.isFocused?.();
  if ((opts.sound !== false) && hidden) playChime();
  return marked;
}

/** 清掉角标（用户点回窗口 / 已读） */
export function clearAttention(win) {
  if (!win || win.isDestroyed?.()) return;
  if (!overlaySupported(win)) return;
  try { win.setOverlayIcon(null, ''); } catch { /* 忽略 */ }
}
