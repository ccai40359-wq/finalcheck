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

/**
 * 切到某个已有 tab（不存在则保持原状并报错）。
 *
 * ⚠️ 0.32.5 P0（reviewer 指出的「最根本的护栏」）：当 activeKey **已经是**目标时，
 * 必须返回**同一个 rail 引用**。
 * 以前无条件 `{...cur, activeKey}` → 每次都产出新对象 → 即使 activeKey 一个字都没变，
 * 也会让 App 全树重渲染。这条不变量一破，任何「重复通知同一个 tab」的通道
 * （AI navigate / 用户输网址 / 页面 window.open / 点击已选中的 tab）都会变成重渲染燃料。
 */
export function activateRailTab(rail, key) {
  const cur = rail || emptyRail();
  const found = railTabByKey(cur, key);
  if (!found) return { ok: false, error: `tab 不存在：${key}`, rail: cur };
  if (cur.activeKey === found.key) return { ok: true, rail: cur, tab: found };  // ← 已经是目标：零变化
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
/**
 * 切会话时的右栏处理。
 *
 * ⚠️ 0.32.4 修正（用户两次强调「我切了会话，这个右边栏还是保留，这个问题给我记好了，以后不要再犯」）：
 * 旧实现只清子代理 tab，注释里写着「产物与浏览器 tab 留着」——那是错的。
 * **右栏内容属于当前会话**：切走时旧会话的产物/浏览器/子代理 tab 都必须收起来，
 * 切回来再恢复（恢复由调用方用 railBySessionRef 做，见 App.jsx）。
 *
 * 所以这个函数现在做两件事：
 *   ① 返回「这个会话应有的右栏」（从缓存里取，没缓存就是空）
 *   ② 提供 pruneForSession 兼容旧行为（只清子代理 tab）——**不再用于切会话**
 *
 * @param {{tabs:Array, activeKey:string|null}|null} cached 该会话上次保存的右栏
 */
export function railForSession(cached) {
  if (!cached || !Array.isArray(cached.tabs)) return emptyRail();
  // 深拷贝一层：调用方 setRail 后不会再改到缓存里的对象
  return { tabs: cached.tabs.map((t) => ({ ...t, payload: { ...(t.payload || {}) } })), activeKey: cached.activeKey || null };
}

/** 存档时用：把当前右栏存成可恢复的快照。 */
export function snapshotRail(rail) {
  if (!rail || !Array.isArray(rail.tabs)) return emptyRail();
  return { tabs: rail.tabs.map((t) => ({ ...t, payload: { ...(t.payload || {}) } })), activeKey: rail.activeKey || null };
}

/**
 * 只清掉属于其它会话的子代理 tab（保留同会话的）。
 * 保留给「同一会话内切换视图」这类场景；**切会话请用 railForSession**。
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

/**
 * 0.32.5 P0：把「浏览器 tab 显示当前网页标题」做成**纯更新**。
 *
 * 为什么必须单独抽出来（这是一个真实的死循环，用户实测"巨卡 + 点图片没反应"）：
 * 旧写法是 BrowserPane 轮询到网页标题 → 父组件 onActivate(rail.activeKey) → setRail(...)
 * → App 全树重渲染 → 传给 BrowserPane 的回调是新函数（内联箭头）→ 轮询 effect 依赖变化
 * → 再轮询 → 再 setRail…… 每轮都是一次 IPC 往返，以几百轮/秒自转。
 * 而那个闭包里捕获的 rail.activeKey 是**旧的**（'browser'），所以用户点 PNG tab 后
 * 循环会把他切回浏览器 tab——表现就是「点图片没反应 / 像被锁住」。
 *
 * 断环的两条硬规则都在这里保证：
 *   ① 标题没变 → **返回同一个对象引用**（React 直接 bail out，不重渲染，循环自然停）
 *   ② 只改 payload.pageTitle，**绝不碰 activeKey**（切 tab 是人的动作，不是刷新的副作用）
 *
 * @param {{tabs:Array, activeKey:string|null}|null} rail
 * @param {string} title 网页当前标题
 */
export function setBrowserTabTitle(rail, title) {
  const cur = rail || emptyRail();
  const next = String(title || '').trim();
  if (!Array.isArray(cur.tabs) || cur.tabs.length === 0) return cur;
  const tab = cur.tabs.find((t) => t.kind === 'browser');
  if (!tab) return cur;
  const prev = String(tab?.payload?.pageTitle || '').trim();
  if (prev === next) return cur;                 // ← ① 没变就原样返回（零重渲染）
  return {
    ...cur,                                      // ← ② activeKey 原样保留
    tabs: cur.tabs.map((t) => (t.key === tab.key
      ? { ...t, payload: { ...(t.payload || {}), pageTitle: next } }
      : t))
  };
}

/**
 * 0.32.5 P0：**确保**右栏里有一个浏览器 tab，但不抢用户正在看的那一页。
 *
 * 为什么要单独一个函数（这是「开了浏览器就点不了图片」的完整根因）：
 * `openRailTab` 的语义是「打开**或切到**」——它每次都把 activeKey 设成目标 tab。
 * 而浏览器 tab 会从三条通道被**反复**通知「有个页面」：
 *   ① AI 的 browser_navigate ／ 用户输网址（browser-goto 成功后主进程推事件）
 *   ② 页面自己的 window.open（pageAttention）
 *   ③ 工具层的 browser-rail-open（agent-event）
 * 只要其中任何一条在用户点了 PNG 之后到达，就会把他从产物 tab 拽回浏览器 tab
 * ——实测：点 chip 后 artifact tab 确实开出来了，但 6.5s 内 activeKind 变回 'browser'。
 *
 * 语义（与用户的预期一致）：
 *   · 右栏还没有浏览器 tab（= AI/用户第一次开网页）→ 开一个并**切过去**（用户要看见）
 *   · 已经有浏览器 tab（= 后续通知）→ 只更新载荷（当前页标题等），**不动 activeKey**
 */
export function ensureBrowserRailTab(rail, payload = {}) {
  const cur = rail || emptyRail();
  const existing = cur.tabs.find((t) => t.kind === 'browser');
  if (!existing) return openRailTab(cur, { kind: 'browser', payload }).rail;
  // 合并载荷：空值（null / undefined / ''）不覆盖已有值——
  // 主进程推的 pageTitle 常常是空串，直接展开会把「哈尔滨理工大学(学生)」清成空白。
  const merged = { ...(existing.payload || {}) };
  let changed = false;
  for (const [k, v] of Object.entries(payload || {})) {
    if (v == null || v === '') continue;
    if (merged[k] === v) continue;
    merged[k] = v;
    changed = true;
  }
  if (!changed) return cur;                     // 没有任何变化 → 同一引用（零重渲染）
  return { ...cur, tabs: cur.tabs.map((t) => (t.key === existing.key ? { ...t, payload: merged } : t)) };
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
