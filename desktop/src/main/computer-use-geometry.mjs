const CLICK_ACTIONS = new Set(['move', 'click', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click']);

export function sameBounds(left, right) {
  return Boolean(left && right && ['x', 'y', 'width', 'height'].every((key) =>
    Number.isSafeInteger(left[key]) && left[key] === right[key]));
}

export function sameWindow(left, right) {
  return Boolean(left?.hwnd && left?.pid && left.hwnd === right?.hwnd && left.pid === right?.pid);
}

export function sameObservation(observed, current) {
  return sameWindow(observed, current) && sameBounds(observed.bounds, current.bounds) && observed.title === current.title;
}

export function overlapBounds(left, right) {
  if (!left || !right || left.width <= 0 || left.height <= 0 || right.width <= 0 || right.height <= 0) return false;
  return left.x < right.x + right.width && right.x < left.x + left.width &&
    left.y < right.y + right.height && right.y < left.y + left.height;
}

export function matchesProcess(processName, expected) {
  const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/\.exe$/, '');
  return !normalize(expected) || normalize(processName) === normalize(expected);
}

// 0.29.7（遮挡校验）：指针动作落点的顶层窗口（WindowFromPoint 的 GA_ROOT）必须属于目标窗口
// ——同 hwnd（落点在目标窗口或其子窗口上）或同进程（同一应用的另一个顶层窗口，如弹窗）。
// 不是 → 返回遮挡窗口的显示名（调用方据此拒绝动作并点名遮挡窗）；是 → 返回 null 放行。
// 注意：遮挡不是前台漂移（那走 auto-refocus 限频仲裁），这里只判定、只拒绝，绝不自动最小化遮挡窗。
// 查询结果无效（没有 hwnd/pid）→ 返回 null 不拦（不新增失败模式，与「文件读不到→放行」同一原则）。
export function occludedBy(topWindow, target) {
  if (!topWindow || typeof topWindow !== 'object') return null;
  const hwnd = Number(topWindow.hwnd) || 0;
  const pid = Number(topWindow.pid) || 0;
  if (!hwnd && !pid) return null;
  if (target?.hwnd && hwnd === Number(target.hwnd)) return null;
  if (target?.pid && pid === Number(target.pid)) return null;
  const label = String(topWindow.title ?? '').trim() || String(topWindow.process ?? '').trim();
  return label || '其它窗口';
}

export function selectCaptureSource(sources, { target, displayId, windowTitle }) {
  if (target === 'screen') {
    const matches = sources.filter((source) => String(source.display_id) === String(displayId));
    return matches.length === 1 ? { source: matches[0] } : { error: '找不到与主显示器唯一对应的截图源。' };
  }

  const selector = String(windowTitle ?? '').trim();
  if (!selector) return { error: '指定窗口截图需要窗口名称或来源 ID。' };
  const byId = sources.find((source) => source.id === selector);
  if (byId) return { source: byId };

  const title = selector.toLowerCase();
  const exact = sources.filter((source) => source.name.trim().toLowerCase() === title);
  const matches = exact.length ? exact : sources.filter((source) => source.name.toLowerCase().includes(title));
  if (matches.length === 1) return { source: matches[0] };
  return { error: matches.length ? '多个窗口名称匹配。请指定窗口来源 ID。' : '没有窗口匹配指定名称或来源 ID。' };
}

export function thumbnailSize(bounds, maxWidth) {
  const requested = Number.isSafeInteger(maxWidth) && maxWidth > 0 ? maxWidth : 1560;
  const ratio = Math.min(1, Math.min(requested, 2560) / bounds.width, 1600 / bounds.height);
  return {
    width: Math.max(1, Math.round(bounds.width * ratio)),
    height: Math.max(1, Math.round(bounds.height * ratio))
  };
}

export function matchesImageGeometry(image, physical, region = null) {
  // 0.29.4：region 截图按「图像尺寸 == region 尺寸」校验（原生分辨率 1:1，没有整屏比例关系）。
  if (region) return image.width === region.width && image.height === region.height;
  return image.width > 1 && image.height > 1 &&
    Math.abs(image.height - image.width * physical.height / physical.width) <= 1;
}

// region 参数（0.29.4）：{x,y,width,height} 物理像素整数，以主显示器左上角为原点。
// 只校验不 clamp：非整数 / 负数 / 宽或高 < 2 / 超出显示器范围都直接报错，绝不悄悄改参数。
export function normalizeRegion(region, bounds) {
  if (!region || typeof region !== 'object' || Array.isArray(region)) {
    return { error: 'region 必须是 {x, y, width, height} 对象（物理像素整数）。' };
  }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isSafeInteger(region[key])) {
      return { error: `region.${key} 必须是整数（物理像素），收到 ${JSON.stringify(region[key] ?? null)}。` };
    }
    if (region[key] < 0) {
      return { error: `region.${key} 不能为负数（region 以主显示器左上角为原点）。` };
    }
  }
  if (region.width < 2 || region.height < 2) {
    return { error: 'region 的 width 与 height 都不能小于 2（物理像素）。' };
  }
  if (region.x + region.width > bounds.width || region.y + region.height > bounds.height) {
    return { error: `region 超出主显示器范围（物理 ${bounds.width}x${bounds.height}）：需要 x+width ≤ ${bounds.width} 且 y+height ≤ ${bounds.height}。` };
  }
  return { region: { x: region.x, y: region.y, width: region.width, height: region.height } };
}

function mapAxis(value, imageLength, physicalLength, origin) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= imageLength) {
    throw new RangeError('坐标必须在截图像素范围内。');
  }
  const physicalOffset = Math.round(Math.min(value, imageLength - 1) * (physicalLength - 1) / (imageLength - 1));
  return origin + physicalOffset;
}

export function mapScreenshotPoint(snapshot, x, y) {
  const { width, height, bounds, region } = snapshot;
  // 0.29.4：region 截图 1:1——图像像素 (px,py) 对应屏幕物理点 bounds 原点 + region 偏移 + (px,py)。
  if (region) {
    return {
      x: mapAxis(x, width, region.width, bounds.x + region.x),
      y: mapAxis(y, height, region.height, bounds.y + region.y)
    };
  }
  return {
    x: mapAxis(x, width, bounds.width, bounds.x),
    y: mapAxis(y, height, bounds.height, bounds.y)
  };
}

// ---- 0.29.7-beta：窗口自身捕获（WGC）的坐标映射 ----
// 标定结论（2026-11-22 本机 Win11 23H2 实测，证据 D:/fc-bench-0291/wgc-poc/cert-log.json 与
// cert-occl-b-occluded-notepad.png）：
// 1. desktopCapturer 窗口源 id 形如 window:<hwnd>:0，中间数字 == GetWindowRect 的 hwnd（6/6 全匹配）。
// 2. WGC thumbnail 尺寸 ≈ GetWindowRect 物理尺寸（±1px：ZCode 2576x1408→2576x1407、记事本
//    1200x800→1199x800），明显不是 DWMWA_EXTENDED_FRAME_BOUNDS（ZCode EFB 宽 2560 < 缩略图 2576）
//    → 图像 (0,0) 对齐 GetWindowRect 原点，WGC 帧含不可见的 DWM resize 边框。
// 3. 边框偏移标定常数 = {x:0, y:0}（图像原点即 GetWindowRect 原点），再由真机点击标定复核
//    （0297beta-click-calibration-*，若后续真机测出系统性偏差再改这里）。
export const WINDOW_FRAME_OFFSET = { x: 0, y: 0 };
// 原生分辨率判定容差：实测 WGC 返回尺寸与请求相差 1px，超过 2px 视为被重采样（拒绝，走兜底）。
export const WINDOW_NATIVE_TOLERANCE_PX = 2;

export function mapWindowPoint(windowRect, x, y) {
  const { x: originX, y: originY, width, height, imageWidth, imageHeight } = windowRect ?? {};
  if (!Number.isSafeInteger(imageWidth) || imageWidth < 1 ||
    !Number.isSafeInteger(imageHeight) || imageHeight < 1) {
    throw new TypeError('windowRect 需要 imageWidth/imageHeight（截图实际像素尺寸）。');
  }
  return {
    x: mapAxis(x, imageWidth, width, originX + WINDOW_FRAME_OFFSET.x),
    y: mapAxis(y, imageHeight, height, originY + WINDOW_FRAME_OFFSET.y)
  };
}

export function actionPoints(action, params, snapshot) {
  // 0.29.7-beta：窗口自身捕获的截图带 windowRect 独立字段——图内像素按窗口原点映射回屏幕物理坐标；
  // 全屏/region 截图仍走原映射（shot.bounds 语义不变）。
  const mapPoint = snapshot?.windowRect
    ? (x, y) => mapWindowPoint(snapshot.windowRect, x, y)
    : (x, y) => mapScreenshotPoint(snapshot, x, y);
  if (action === 'drag' || action === 'left_click_drag') {
    return [
      mapPoint(params.x1 ?? params.fromX ?? params.x, params.y1 ?? params.fromY ?? params.y),
      mapPoint(params.x2, params.y2)
    ];
  }
  if (CLICK_ACTIONS.has(action) || (action === 'scroll' && (params.x != null || params.y != null))) {
    return [mapPoint(params.x, params.y)];
  }
  return [];
}
