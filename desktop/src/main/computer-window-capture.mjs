// 窗口自身捕获（0.29.7-beta）①→② 级的纯编排层。
//
// 捕获链（与 computer-use.mjs 的 ③ screen 兜底配合，按序回退）：
//   ① Electron desktopCapturer 窗口 thumbnail —— Electron 33 在 Windows 上默认走 WGC 后端
//     （wgc_capturer_win.cc；GDI 为回退）。certainty 核验实证（D:/fc-bench-0291/wgc-poc/cert-log.json）：
//     源 id 形如 window:<hwnd>:0 且中间数字 == GetWindowRect 的 hwnd（6/6）；窗口被遮挡（未最小化）
//     时 thumbnail 拍到的是窗口自身内容（洋红遮挡实验：thumbnail 洋红=0、PNG 逐字节一致；
//     同刻屏幕合成图洋红 31970 采样点）。thumbnailSize 传窗口原生物理尺寸，返回尺寸与请求相差
//     ±1px（1200x800→1199x800），不是 EFB 尺寸 → 图像原点 == GetWindowRect 原点。
//   ② winapp ui screenshot --hwnd <hwnd>（微软 winappcli，可选增强；运行时探测，缺失/失败都跳过）
//   ③ 现行 screen 捕获（computer-use.mjs 内，永远兜底；最小化直接走 ③）
//
// 本模块不 import electron：getSources / createImage / winapp 探测与调用全部注入，
// 纯 Node 测试台用 mock 覆盖完整回退矩阵。
import { WINDOW_NATIVE_TOLERANCE_PX } from './computer-use-geometry.mjs';

/** desktopCapturer 窗口源 id（certainty A：中间数字就是 hwnd）。 */
export function windowSourceId(hwnd) {
  return `window:${Number(hwnd)}:0`;
}

/** 按 hwnd 精确匹配源；找不到返回 null（绝不按名字猜——宁可走兜底也不拍错窗口）。 */
export function pickWindowSource(sources, hwnd) {
  const id = windowSourceId(hwnd);
  return (Array.isArray(sources) ? sources : []).find((s) => s?.id === id) ?? null;
}

/**
 * 返回尺寸是否等于窗口原生物理尺寸（±WINDOW_NATIVE_TOLERANCE_PX）。
 * 实测 WGC 有 1px 舍入差；差得更多说明 capturer 重采样过，坐标 1:1 会被破坏 → 拒收走兜底。
 */
export function isNativeWindowSize(got, requested) {
  if (!got || !Number.isFinite(got.width) || !Number.isFinite(got.height)) return false;
  return Math.abs(got.width - requested.width) <= WINDOW_NATIVE_TOLERANCE_PX &&
    Math.abs(got.height - requested.height) <= WINDOW_NATIVE_TOLERANCE_PX;
}

/**
 * @param {object} io 注入的依赖
 *   - getSources(options): Electron desktopCapturer.getSources
 *   - winappDetect(): async → { exe } | null（winapp-cli.mjs detectWinapp）
 *   - winappScreenshot(exe, hwnd): async → { ok, png } | falsy
 *   - createImage(png): nativeImage.createFromBuffer
 * @returns {(args: {hwnd, rect}) => Promise<{level:'window-thumbnail'|'winapp', image}|null>}
 *   返回 null 表示 ①② 都不可用，调用方必须走 ③ screen 兜底（永远保留，绝不抛错）。
 */
export function createWindowCapture({ getSources, winappDetect, winappScreenshot, createImage }) {
  return async function captureWindowImage({ hwnd, rect }) {
    const requested = { width: rect.width, height: rect.height };

    // ① desktopCapturer 窗口 thumbnail（WGC）。源列表失败/源缺失（最小化、自进程窗口被排除、
    //    "not capturable" 的 shell/覆盖层类源）/thumbnail 空/尺寸被重采样 → 落到 ②。
    let sources = null;
    try {
      sources = await getSources({
        types: ['window'],
        thumbnailSize: { width: requested.width, height: requested.height },
        fetchWindowIcons: false
      });
    } catch { sources = null; }
    const source = pickWindowSource(sources, hwnd);
    if (source?.thumbnail && typeof source.thumbnail.isEmpty === 'function' &&
      !source.thumbnail.isEmpty() && isNativeWindowSize(source.thumbnail.getSize(), requested)) {
      return { level: 'window-thumbnail', image: source.thumbnail };
    }

    // ② winapp CLI（可选增强：WGC 优先、旧系统回退 PrintWindow）。探测不到 / 调用失败 /
    //    输出为空或尺寸不匹配 → null（调用方走 ③）。
    let winapp = null;
    try { winapp = await winappDetect(); } catch { winapp = null; }
    if (winapp?.exe) {
      let r = null;
      try { r = await winappScreenshot(winapp.exe, hwnd); } catch { r = null; }
      if (r?.ok && Buffer.isBuffer(r.png) && r.png.length > 0) {
        let image = null;
        try { image = createImage(r.png); } catch { image = null; }
        if (image && typeof image.isEmpty === 'function' && !image.isEmpty() &&
          isNativeWindowSize(image.getSize(), requested)) {
          return { level: 'winapp', image };
        }
      }
    }

    return null;
  };
}
