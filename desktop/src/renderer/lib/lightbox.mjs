// 0.33.9 图片大图查看（用户：「对话输入框和我的消息框的图片可以直接点开」）
// 任何地方调 openLightbox({ items:[{src, name, path}], index }) 就能弹大图；ImageLightbox 组件挂在 App 根上监听。
// 用 window 事件而不是 React context：Composer / MessageList 都能直接调，不用一路往下传回调。
export const LIGHTBOX_EVENT = 'fc:lightbox';

/** 归一化要显示的图片列表（去掉没 src 的），index 夹在范围内 */
export function normalizeLightbox(payload = {}) {
  const items = (Array.isArray(payload.items) ? payload.items : [])
    .filter((x) => x && typeof x.src === 'string' && x.src)
    .map((x) => ({ src: x.src, name: String(x.name || ''), path: String(x.path || '') }));
  if (!items.length) return null;
  const raw = Number(payload.index) || 0;
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(raw)));
  return { items, index };
}

/** 左右切换：循环 */
export function stepLightbox(state, dir) {
  if (!state?.items?.length) return state;
  const n = state.items.length;
  return { ...state, index: (state.index + (dir < 0 ? -1 : 1) + n) % n };
}

export function openLightbox(payload) {
  const state = normalizeLightbox(payload);
  if (!state || typeof window === 'undefined') return false;
  window.dispatchEvent(new CustomEvent(LIGHTBOX_EVENT, { detail: state }));
  return true;
}
