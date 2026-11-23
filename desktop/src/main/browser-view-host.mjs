// 0.32.0：内嵌浏览器的宿主（WebContentsView 池，挂在主窗口的 contentView 上）。
//
// 为什么要有这个（用户两次实机截图 + 我的 PoC 实测）：
//   · 0.31.x 的自带浏览器是 `offscreen: true` + `show: false` 的隐藏 BrowserWindow ——
//     页面确实加载了，但**从不渲染到屏幕**，用户看到的是一个写着「No content under offscreen mode」
//     的白框，AI 还让他去扫一个根本看不见的二维码。
//   · 只能开一个页面（window.open 返回 false，页面数恒为 1）。
//
// 这个模块只做「把 webContents 变成主窗口里的一块可见画面」这件事，页面语义（快照/点击/ref）
// 仍然全部留在 browser-use.mjs —— 它把 webContents 交给这里托管，两者各管一半。
//
// PoC 已验证（2026-11-23，Electron 33.4.11）：
//   ① 按 rect 显示而非铺满整窗 ② 多 view + setVisible 切换 ③ capturePage 可取图
//   ④ setWindowOpenHandler 能抓到 url ⑤ 摘下来 webContents 仍存活、重挂不丢状态
//   ⑥ 窗口缩放**不会**自动跟随 → 必须由渲染层上报 rect（这就是 railRect 通道的由来）
import { WebContentsView } from 'electron';
import { emptyState, openTab, switchTab, closeTab, patchTab, activeTab, tabById, classifyWindowOpen, MAX_TABS } from './browser-tabs.mjs';

let host = null;

const nowId = () => `bt-${Math.random().toString(36).slice(2, 9)}`;

/**
 * 宿主单例。主窗口变了（重建）就重建宿主——旧 view 全部丢掉，不跨窗口搬运（槽位语义会错）。
 * @param {import('electron').BrowserWindow} mainWin
 */
export function ensureHost(mainWin) {
  if (!mainWin || mainWin.isDestroyed?.()) return null;
  if (host && host.win === mainWin && !host.win.isDestroyed?.()) return host;
  disposeHost();
  host = {
    win: mainWin,
    // 每个标签：{ id, view, wc, partition, url, title }
    views: new Map(),
    state: emptyState(),
    rect: null,          // 渲染层报上来的内容区（DIP，相对主窗口内容区左上角）
    visible: false,      // 右栏当前是否真的在显示这个浏览器
    onWindowOpen: null,  // (url) => void：window.open 转新标签的出口
    seq: 0
  };
  const win = mainWin;
  win.on('resize', () => { if (host && host.win === win) applyAllBounds(); });
  win.on('closed', () => { if (host && host.win === win) disposeHost(); });
  return host;
}

export function disposeHost() {
  if (!host) return;
  for (const entry of host.views.values()) {
    // 顺序：先摘掉再关。摘之前必须先隐藏——PoC 实测「摘掉的 view 仍可能保持可见状态」，
    // 窗口重绘时会在原位闪一帧旧画面（用户看到的是"关掉的标签还在那儿"）。
    try { entry.view.setVisible(false); } catch { /* 已销毁 */ }
    try { host.win?.contentView?.removeChildView?.(entry.view); } catch { /* 窗口已关 */ }
    try { entry.wc?.close?.(); } catch { /* 已销毁 */ }
  }
  host.views.clear();
  host = null;
}

export function hostInfo() {
  if (!host) return { attached: false, tabs: [], activeId: null, rect: null, visible: false, showing: [] };
  // 每个 view 的实测状态（诊断"画了但看不见"用）。
  // ⚠️ WebContentsView 没有 getVisible()（实测返回 undefined），所以「当前是否真的显示在我方」
  // 只能靠宿主自己记账（entry.showing），不能靠 bounds 推断——bounds 是"上次设过的位置"，
  // 折叠/切走后它仍然非零，用它判断会得出"还在显示"的错误结论。
  const views = [];
  const showing = [];
  for (const [id, entry] of host.views) {
    let b = null;
    try { b = entry.view.getBounds?.() || null; } catch { b = null; }
    if (entry.showing) showing.push(id);
    views.push({ id, bounds: b, showing: Boolean(entry.showing), url: entry.url || '' });
  }
  return {
    attached: true,
    tabs: host.state.tabs.map((t) => ({ ...t, label: t.title || t.url })),
    activeId: host.state.activeId,
    rect: host.rect,
    visible: host.visible,
    showing,                                  // 真正处于"已显示"状态的标签 id（0 个或 1 个）
    winContent: (() => { try { return host.win.getContentBounds(); } catch { return null; } })(),
    views
  };
}

export function getState() { return host ? host.state : emptyState(); }

/** 渲染层上报的内容区 rect（DIP）。只认整数并且宽高为正，否则视为「还不知道」。 */
export function setRect(rect) {
  if (!host) return { ok: false, error: '宿主未就绪' };
  const r = normalizeRect(rect);
  if (!r) {
    host.rect = null;
    // 尺寸不可用 → 立刻藏起来，避免上一帧的画面停在错位处
    hideAll();
    return { ok: false, error: 'rect 无效' };
  }
  host.rect = r;
  applyAllBounds();
  return { ok: true, rect: r };
}

/** 右栏显示/隐藏这个浏览器面板。隐藏时不销毁 webContents（切 tab 再回来页面还在）。 */
export function setVisible(visible) {
  if (!host) return { ok: false, error: '宿主未就绪' };
  host.visible = visible === true;
  if (!host.visible) { hideAll(); return { ok: true, visible: false }; }
  applyAllBounds();
  return { ok: true, visible: true };
}

/**
 * 新开一个网页标签。partition 由调用方按现有策略解析（无痕/持久语义不变）。
 * @param {{url?:string, partition?:string, openerId?:string|null, background?:boolean}} opts
 */
export async function newTab({ url = '', partition, openerId = null, background = false } = {}) {
  if (!host) return { ok: false, error: '宿主未就绪' };
  const id = nowId();
  const res = openTab(host.state, { id, url, openerId });
  if (!res.ok) return { ok: false, error: res.error };
  host.state = res.state;

  let view;
  try {
    view = new WebContentsView({
      webPreferences: {
        // 与主窗口同款隔离；页面本身不可信，绝不能给它 node
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 标签后台不节流：切走的标签仍要能被 AI 截图/读结构（否则定时器停摆、页面"假死"）
        backgroundThrottling: false,
        ...(partition ? { partition } : {})
      }
    });
  } catch (error) {
    host.state = closeTab(host.state, id).state; // 建 view 失败：回滚状态，不留下打不开的标签
    return { ok: false, error: `创建视图失败：${error?.message || error}` };
  }

  const wc = view.webContents;
  // showing：宿主自己记账「这个 view 当前是否真的被设为可见」。
  // WebContentsView 没有 getVisible()，而 bounds 在隐藏后仍然非零，所以只能自己记。
  const entry = { id, view, wc, url: '', title: '', showing: false };
  host.views.set(id, entry);
  try { host.win.contentView.addChildView(view); } catch { /* 窗口已关 */ }
  view.setVisible(false); // 先藏，等 rect + 可见性都确定后再显示（避免错位闪现）

  // window.open / target=_blank → 变成新标签（PoC 已验证 handler 能抓到 url）
  wc.setWindowOpenHandler(({ url: target }) => {
    const verdict = classifyWindowOpen(target);
    if (verdict.open) {
      // 交给上层（工具层）决定是否真的开；这里只拒绝浏览器默认行为
      try { host?.onWindowOpen?.(verdict.url, id); } catch { /* 上层故障不影响 */ }
    }
    return { action: 'deny' };
  });

  // 标题/地址回填（标签条与工具层都要用）
  wc.on('page-title-updated', (_e, title) => {
    if (!host || !host.views.has(id)) return;
    entry.title = String(title || '');
    host.state = patchTab(host.state, id, { title: entry.title }).state;
  });
  wc.on('did-navigate', (_e, navUrl) => {
    if (!host || !host.views.has(id)) return;
    entry.url = String(navUrl || '');
    host.state = patchTab(host.state, id, { url: entry.url }).state;
  });
  wc.on('did-navigate-in-page', (_e, navUrl) => {
    if (!host || !host.views.has(id)) return;
    entry.url = String(navUrl || '');
    host.state = patchTab(host.state, id, { url: entry.url }).state;
  });

  if (!background) host.state = switchTab(host.state, id).state;
  applyEntryBounds(entry);

  if (url) {
    try { await wc.loadURL(url); } catch (error) { return { ok: false, error: String(error?.message || error), id }; }
  }
  return { ok: true, id, tab: tabById(host.state, id) };
}

/** 切活动标签（只切可见性，不销毁任何页面）。 */
export function activateTab(id) {
  if (!host) return { ok: false, error: '宿主未就绪' };
  const res = switchTab(host.state, id);
  if (!res.ok) return { ok: false, error: res.error };
  host.state = res.state;
  applyAllBounds();
  return { ok: true, activeId: host.state.activeId };
}

/** 关掉一个标签（连同它的 view）。 */
export function closeTabById(id) {
  if (!host) return { ok: false, error: '宿主未就绪' };
  const entry = host.views.get(String(id));
  const res = closeTab(host.state, id);
  if (!res.ok) return { ok: false, error: res.error };
  host.state = res.state;
  if (entry) {
    host.views.delete(String(id));
    // 先隐藏再摘（同 disposeHost：PoC 实测摘掉的 view 仍可能保持可见，会在原位闪一帧旧画面）
    try { entry.view.setVisible(false); } catch { /* 已销毁 */ }
    try { host.win.contentView.removeChildView(entry.view); } catch { /* 窗口已关 */ }
    try { entry.wc.close(); } catch { /* 已销毁 */ }
  }
  applyAllBounds();
  return { ok: true, state: host.state };
}

/** 给指定标签导航（工具层 navigate 会走这里，成功后活动标签就是它）。 */
export async function navigateTab(id, url, { activate = true } = {}) {
  if (!host) return { ok: false, error: '宿主未就绪' };
  const entry = host.views.get(String(id));
  if (!entry) return { ok: false, error: `标签不存在：${id}` };
  if (activate) host.state = switchTab(host.state, id).state;
  try {
    await entry.wc.loadURL(url);
    entry.url = entry.wc.getURL();
    host.state = patchTab(host.state, id, { url: entry.url }).state;
    return { ok: true, id, url: entry.url, title: entry.wc.getTitle() };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * 拿 webContents 给 browser-use 用：它需要在这个 wc 上跑快照/点击（executeJavaScriptInIsolatedWorld）
 * 与 capturePage。宿主只借出引用，不干涉页面语义。
 */
export function contentsOf(id = null) {
  if (!host) return null;
  const targetId = id == null ? host.state.activeId : String(id);
  if (!targetId) return null;
  return host.views.get(targetId)?.wc || null;
}

export function activeContents() { return contentsOf(null); }

/** AI 要操作时把对应标签摆到可见位置（右栏没展开时也强制可见——否则又是"看不到"）。 */
export function revealTab(id = null, rect = null) {
  if (!host) return { ok: false, error: '宿主未就绪' };
  if (rect) {
    const r = normalizeRect(rect);
    if (r) host.rect = r;
  }
  const targetId = id == null ? host.state.activeId : String(id);
  if (!targetId) return { ok: false, error: '没有可用标签' };
  host.state = switchTab(host.state, targetId).state;
  host.visible = true;
  applyAllBounds();
  return { ok: true, activeId: host.state.activeId, rect: host.rect };
}

export { MAX_TABS };

/* ---------------- 内部：几何 ---------------- */

function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const x = Math.round(Number(rect.x));
  const y = Math.round(Number(rect.y));
  const width = Math.round(Number(rect.width));
  const height = Math.round(Number(rect.height));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x: Math.max(0, x), y: Math.max(0, y), width, height };
}

function hideAll() {
  if (!host) return;
  for (const entry of host.views.values()) {
    try { entry.view.setVisible(false); } catch { /* 已销毁 */ }
    entry.showing = false;
  }
}

// 主窗口内容区尺寸上限：rect 超出就会画到窗口外（Electron 不会自动裁剪）
function clampToWindow(rect) {
  if (!host?.win || host.win.isDestroyed?.()) return rect;
  const cb = host.win.getContentBounds();
  const x = Math.max(0, Math.min(rect.x, Math.max(0, cb.width - 1)));
  const y = Math.max(0, Math.min(rect.y, Math.max(0, cb.height - 1)));
  const width = Math.max(1, Math.min(rect.width, cb.width - x));
  const height = Math.max(1, Math.min(rect.height, cb.height - y));
  return { x, y, width, height };
}

function applyEntryBounds(entry) {
  if (!host || !entry || !host.rect || host.win?.isDestroyed?.()) return;
  const r = clampToWindow(host.rect);
  try {
    entry.view.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
  } catch { /* 已销毁 */ }
}

/**
 * 让「只有活动标签可见，且贴在渲染层报上来的 rect」这件事一直成立。
 * 每次 rect / 可见性 / 活动标签 / 窗口尺寸变化都调它——幂等。
 */
function applyAllBounds() {
  if (!host) return;
  const active = host.state.activeId;
  for (const [id, entry] of host.views) {
    const shouldShow = host.visible && Boolean(host.rect) && id === active;
    try {
      if (shouldShow) {
        applyEntryBounds(entry);
        entry.view.setVisible(true);
        entry.showing = true;
      } else {
        entry.view.setVisible(false);
        entry.showing = false;
      }
    } catch { /* 已销毁 */ }
  }
}
