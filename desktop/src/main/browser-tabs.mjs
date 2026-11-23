// 0.32.0：内嵌浏览器多标签的纯逻辑（不 import electron，可在纯 Node 里直测）。
//
// 为什么需要它：0.31.x 的自带浏览器只有一个隐藏窗口，`window.open` 返回 false、页面数恒为 1。
// 0.32.0 把浏览器嵌进右栏后，一个右栏浏览器 tab 里要能开多个网页标签——开/切/关的状态机
// 放在这里，宿主（WebContentsView 池）只负责照它执行。
//
// 约定：id 由调用方给（宿主用递增序号），这里只管不变式：
//   · 标签顺序 = 打开顺序，新标签追加到末尾并成为活动标签
//   · 关掉活动标签 → 活动标签落到「原位置的邻居」（原位置已被占则退到前一个；空了就 null）
//   · 关掉非活动标签 → 活动标签不变
//   · 上限 MAX_TABS：超了拒绝并如实说明（不静默丢弃用户已打开的页面）

export const MAX_TABS = 12;

/** @returns {{tabs: Array, activeId: string|null}} */
export function emptyState() {
  return { tabs: [], activeId: null };
}

export function tabById(state, id) {
  if (!state || !Array.isArray(state.tabs)) return null;
  return state.tabs.find((t) => t.id === String(id)) || null;
}

export function activeTab(state) {
  if (!state) return null;
  return tabById(state, state.activeId);
}

/**
 * 开一个标签并设为活动。
 * @param {{tabs:Array, activeId:string|null}} state
 * @param {{id:string, url?:string, title?:string, openerId?:string|null}} tab
 * @returns {{ok:true, state, tab} | {ok:false, error:string, state}}
 */
export function openTab(state, tab) {
  const cur = state && Array.isArray(state.tabs) ? state : emptyState();
  const id = String(tab?.id ?? '').trim();
  if (!id) return { ok: false, error: '标签缺少 id', state: cur };
  if (tabById(cur, id)) return { ok: false, error: `标签 id 已存在：${id}`, state: cur };
  if (cur.tabs.length >= MAX_TABS) {
    return { ok: false, error: `最多同时开 ${MAX_TABS} 个网页标签，请先关掉一些`, state: cur };
  }
  const entry = {
    id,
    url: String(tab?.url ?? ''),
    title: String(tab?.title ?? ''),
    openerId: tab?.openerId == null ? null : String(tab.openerId)
  };
  const next = { tabs: [...cur.tabs, entry], activeId: id };
  return { ok: true, state: next, tab: entry };
}

/** 切换活动标签。目标不存在时保持原状并报错（不静默切到别的）。 */
export function switchTab(state, id) {
  const cur = state || emptyState();
  const want = String(id ?? '').trim();
  const found = tabById(cur, want);
  if (!found) return { ok: false, error: `标签不存在：${want}`, state: cur };
  return { ok: true, state: { ...cur, activeId: found.id }, tab: found };
}

/**
 * 关掉一个标签。活动标签的落点规则见文件头。
 * 最后一条被关掉时 activeId 归 null（由调用方决定右栏是否整体收起）。
 */
export function closeTab(state, id) {
  const cur = state || emptyState();
  const want = String(id ?? '').trim();
  const idx = cur.tabs.findIndex((t) => t.id === want);
  if (idx < 0) return { ok: false, error: `标签不存在：${want}`, state: cur };
  const remaining = cur.tabs.filter((_, i) => i !== idx);
  let nextActive = cur.activeId;
  if (cur.activeId === want) {
    // 原位置现在站着的是「后面的那个」；没有后面就退到前一个
    const neighbor = remaining[idx] || remaining[idx - 1] || null;
    nextActive = neighbor ? neighbor.id : null;
  }
  return { ok: true, state: { tabs: remaining, activeId: nextActive }, closedId: want };
}

/** 更新标签的 url/title（导航完成、标题变化时由宿主回填）。 */
export function patchTab(state, id, patch = {}) {
  const cur = state || emptyState();
  const want = String(id ?? '').trim();
  if (!tabById(cur, want)) return { ok: false, error: `标签不存在：${want}`, state: cur };
  const tabs = cur.tabs.map((t) => (t.id === want
    ? { ...t, ...(typeof patch.title === 'string' ? { title: patch.title } : {}), ...(typeof patch.url === 'string' ? { url: patch.url } : {}) }
    : t));
  return { ok: true, state: { ...cur, tabs } };
}

/**
 * window.open / target=_blank 该不该变成新标签。
 * 宿主拿到 setWindowOpenHandler 的 url 后调这里判定：http/https 才开新标签，
 * 其它（about:blank 的空窗、非网页 scheme）一律 deny 并回报原因——不静默吞掉，也不乱开。
 */
export function classifyWindowOpen(rawUrl) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return { open: false, reason: 'empty-url' };
  if (url === 'about:blank') return { open: false, reason: 'about-blank' };
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return { open: true, url: u.href };
    if (u.protocol === 'file:') return { open: true, url: u.href };
    return { open: false, reason: `scheme-not-allowed:${u.protocol}` };
  } catch {
    return { open: false, reason: 'not-a-url' };
  }
}

/** 给 UI 的摘要（不把整条 URL 塞进标签标题）：取主机名，取不到就截断原文。 */
export function tabLabel(tab) {
  const title = String(tab?.title ?? '').trim();
  if (title) return title;
  const url = String(tab?.url ?? '').trim();
  if (!url) return '新标签';
  try {
    const u = new URL(url);
    return u.host || url.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}
