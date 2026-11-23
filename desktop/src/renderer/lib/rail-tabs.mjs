// 0.32.0：右栏多标签的纯逻辑（无 React、无 DOM，可直测）。
//
// 目标形态（用户给的那张 ZCode 右栏）：顶部一条 tab 条，可同时开
//   · 产物预览（html/png/pdf/…）—— 一个产物一个 tab
//   · 内嵌浏览器（多个网页标签在它内部）—— 右栏里只有一个「浏览器」tab
//   · 子代理会话 —— 一个步骤一个 tab
// 然后随便切、随便关。
//
// 为什么单独抽出来：这三类内容以前是「互斥的两个面板」（step 优先、artifact 次之），
// 现在要并存，归约规则（开/切/关/同键复用/回落）必须能被单测钉住，
// 否则很容易出现「关了浏览器 tab 却把产物也关了」这类回归。

export const RAIL_KINDS = Object.freeze(['artifact', 'browser', 'subagent']);

/** tab 的唯一键：同一类 + 同一目标 = 同一个 tab（重复打开只是切过去，不堆重复 tab） */
export function railTabKey({ kind, artifactPath = '', stepId = '', payload = null } = {}) {
  if (kind === 'browser') return 'browser';
  if (kind === 'artifact') {
    // 产物路径既可能在顶层（调用方便利写法），也可能在 payload（渲染层统一存放）
    const p = String(artifactPath || payload?.path || '').trim();
    return `artifact:${p}`;
  }
  if (kind === 'subagent') {
    // 子代理的 stepId 通常在 payload 里（openStep 的对象结构）；两处都认，别只读顶层
    const id = String(stepId || payload?.stepId || '').trim();
    return `subagent:${id}`;
  }
  return '';
}

export function emptyRail() {
  return { tabs: [], activeKey: null };
}

export function railTabByKey(rail, key) {
  if (!rail || !Array.isArray(rail.tabs)) return null;
  return rail.tabs.find((t) => t.key === String(key)) || null;
}

export function activeRailTab(rail) {
  return rail ? railTabByKey(rail, rail.activeKey) : null;
}

/**
 * 打开（或切到）一个右栏 tab。
 * 已有的同键 tab 不会重复创建——只把它设为活动（用户/AI 反复触发同一条不会堆 tab）。
 * @returns {{ok:true, rail, tab, existed:boolean}}
 */
export function openRailTab(rail, tab) {
  const cur = rail && Array.isArray(rail.tabs) ? rail : emptyRail();
  const kind = String(tab?.kind || '');
  if (!RAIL_KINDS.includes(kind)) return { ok: false, error: `不认识的右栏 tab 类型：${kind}`, rail: cur };
  const key = String(tab?.key || railTabKey(tab)).trim();
  if (!key) return { ok: false, error: 'tab 缺少 key', rail: cur };
  const existing = railTabByKey(cur, key);
  if (existing) {
    return { ok: true, rail: { ...cur, activeKey: key }, tab: existing, existed: true };
  }
  const entry = {
    key,
    kind,
    title: String(tab?.title || ''),
    // 各类型自己的载荷（渲染层用）：artifact → path；browser → 无；subagent → stepId/name/role
    payload: tab?.payload && typeof tab.payload === 'object' ? { ...tab.payload } : {}
  };
  return { ok: true, rail: { tabs: [...cur.tabs, entry], activeKey: key }, tab: entry, existed: false };
}

/** 切到某个已有 tab（不存在则保持原状并报错）。 */
export function activateRailTab(rail, key) {
  const cur = rail || emptyRail();
  const found = railTabByKey(cur, key);
  if (!found) return { ok: false, error: `tab 不存在：${key}`, rail: cur };
  return { ok: true, rail: { ...cur, activeKey: found.key }, tab: found };
}

/**
 * 关掉一个 tab，并把活动 tab 回落到邻居。
 * 全关光 → activeKey=null（右栏整体是否收起由调用方决定）。
 */
export function closeRailTab(rail, key) {
  const cur = rail || emptyRail();
  const want = String(key ?? '');
  const idx = cur.tabs.findIndex((t) => t.key === want);
  if (idx < 0) return { ok: false, error: `tab 不存在：${want}`, rail: cur };
  const remaining = cur.tabs.filter((_, i) => i !== idx);
  let activeKey = cur.activeKey;
  if (cur.activeKey === want) {
    const neighbor = remaining[idx] || remaining[idx - 1] || null;
    activeKey = neighbor ? neighbor.key : null;
  }
  return { ok: true, rail: { tabs: remaining, activeKey }, closedKey: want };
}

/** 更新标题（产物加载完、页面标题变化、子代理跑完）。key 不存在时不改状态。 */
export function patchRailTab(rail, key, patch = {}) {
  const cur = rail || emptyRail();
  const want = String(key ?? '');
  if (!railTabByKey(cur, want)) return { ok: false, error: `tab 不存在：${want}`, rail: cur };
  const tabs = cur.tabs.map((t) => (t.key === want
    ? { ...t, ...(typeof patch.title === 'string' && patch.title ? { title: patch.title } : {}) }
    : t));
  return { ok: true, rail: { ...cur, tabs } };
}

/**
 * 会话切换时要清掉哪些 tab：子代理 tab 属于具体会话，切走就不该继续挂在那儿；
 * 产物与浏览器则不跟会话走（产物是文件、浏览器是进程级页面）。
 */
export function pruneForSession(rail, sessionId) {
  const cur = rail || emptyRail();
  const kept = cur.tabs.filter((t) => {
    if (t.kind !== 'subagent') return true;
    const owner = t.payload?.sessionId;
    if (owner == null) return true;          // 草稿会话的子代理 tab 不绑定会话
    return String(owner) === String(sessionId ?? '');
  });
  if (kept.length === cur.tabs.length) return { rail: cur, changed: false };
  const activeStill = kept.some((t) => t.key === cur.activeKey);
  const activeKey = activeStill ? cur.activeKey : (kept[kept.length - 1]?.key || null);
  return { rail: { tabs: kept, activeKey }, changed: true };
}

/** 右栏是否该显示（有 tab 就显示，全关就收起）。 */
export function shouldShowRail(rail) {
  return Boolean(rail && Array.isArray(rail.tabs) && rail.tabs.length > 0);
}

/** 给 tab 条的显示文案（浏览器 tab 要显示当前网页标题，而不是干巴巴「浏览器」）。 */
export function railTabLabel(tab) {
  const kind = String(tab?.kind || '');
  if (kind === 'browser') return String(tab?.payload?.pageTitle || '').trim() || '浏览器';
  if (kind === 'artifact') return String(tab?.title || '').trim() || '产物';
  if (kind === 'subagent') return String(tab?.title || '').trim() || '子代理';
  return String(tab?.title || '').trim() || '面板';
}
