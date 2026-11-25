// 0.33.9 工具记录里的图片（用户：「调用工具时候他看图片，我可以点开看，这样我就知道他在哪一步做到什么情况」；
//   「下面我希望是 AI 主动展示的，而不是截图堆积的」）：
//   · AI 看过 / 拍过的图，不再堆到消息底部的「检查截图 ×N」，而是留在**那一步**的工具记录里，文件名可点
//   · 点了在右栏打开（产物预览：能缩放、看原图）
//   · 消息底部只留 AI 主动交付的东西（present_artifact、改过的文件）
export const OPEN_ARTIFACT_EVENT = 'fc-open-artifact';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
export const isImagePath = (p) => IMAGE_RE.test(String(p || ''));

function parse(args) {
  if (args && typeof args === 'object') return args;
  try { return JSON.parse(String(args || '{}')); } catch { return {}; }
}

/** 一条工具记录里「AI 看到 / 拍下」的图片路径（去重，最多 4 张） */
export function toolImagePaths(entry) {
  if (!entry || entry.type === 'thought') return [];
  const name = String(entry.name || entry.tool || '');
  const a = parse(entry.args);
  const r = entry.result && typeof entry.result === 'object' ? entry.result : {};
  if (r.error) return [];
  const out = [];
  const push = (p) => { const s = String(p || '').trim(); if (s && isImagePath(s) && !out.includes(s)) out.push(s); };
  switch (name) {
    case 'view_image':
      if (Array.isArray(r.images)) r.images.forEach((m) => push(m?.path));
      if (!out.length) (Array.isArray(a.paths) ? a.paths : [a.path]).forEach(push);
      break;
    case 'read_file':
      push(a.path);
      break;
    case 'capture_screenshot':
    case 'browser_screenshot':
    case 'computer_screenshot':
      push(r.path);
      break;
    default:
      break;
  }
  return out.slice(0, 4);
}

export function fileNameOf(p) {
  return String(p || '').split(/[\\/]/).pop() || String(p || '');
}

export function requestOpenArtifact(path) {
  try { window.dispatchEvent(new CustomEvent(OPEN_ARTIFACT_EVENT, { detail: { path: String(path || '') } })); } catch { /* 非浏览器环境 */ }
}
