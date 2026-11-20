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

export function matchesImageGeometry(image, physical) {
  return image.width > 1 && image.height > 1 &&
    Math.abs(image.height - image.width * physical.height / physical.width) <= 1;
}

function mapAxis(value, imageLength, physicalLength, origin) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= imageLength) {
    throw new RangeError('坐标必须在截图像素范围内。');
  }
  const physicalOffset = Math.round(Math.min(value, imageLength - 1) * (physicalLength - 1) / (imageLength - 1));
  return origin + physicalOffset;
}

export function mapScreenshotPoint(snapshot, x, y) {
  const { width, height, bounds } = snapshot;
  return {
    x: mapAxis(x, width, bounds.width, bounds.x),
    y: mapAxis(y, height, bounds.height, bounds.y)
  };
}

export function actionPoints(action, params, snapshot) {
  const mapPoint = (x, y) => mapScreenshotPoint(snapshot, x, y);
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
