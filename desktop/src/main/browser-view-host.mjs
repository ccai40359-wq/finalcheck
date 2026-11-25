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
import { hardenSession } from './browser-hardening.mjs';
import { applyEdgeIdentityToSession, applyEdgeIdentityToContents } from './browser-fingerprint.mjs';
import { emptyState, openTab, switchTab, closeTab, patchTab, tabById, classifyWindowOpen, MAX_TABS } from './browser-tabs.mjs';

let windowOwner = null;
let hosts = new Map();
let notifyTabs = null;
let nextId = 0;

export function ensureHost(mainWin, onTabsChanged = null) {
  if (!mainWin || mainWin.isDestroyed?.()) return null;
  if (windowOwner !== mainWin) {
    disposeHost();
    windowOwner = mainWin;
    mainWin.on('resize', () => {
      if (windowOwner === mainWin) for (const host of hosts.values()) host.resize();
    });
    mainWin.on('closed', () => { if (windowOwner === mainWin) disposeHost(); });
  }
  notifyTabs = onTabsChanged;
  return hostForSession(null);
}

export function hostForSession(sessionId) {
  if (!windowOwner || windowOwner.isDestroyed?.()) return null;
  const key = sessionId == null ? null : String(sessionId);
  if (!hosts.has(key)) {
    hosts.set(key, createBrowserHost(windowOwner, {
      isManaged: () => Boolean(notifyTabs),
      onChange: () => notifyTabs?.(key)
    }));
  }
  return hosts.get(key);
}

export function disposeSession(sessionId) {
  const key = sessionId == null ? null : String(sessionId);
  hosts.get(key)?.dispose();
  hosts.delete(key);
}

export function clearAllTabs() {
  for (const host of hosts.values()) host.clearTabs();
}

export function disposeHost() {
  const previous = hosts;
  hosts = new Map();
  windowOwner = null;
  notifyTabs = null;
  for (const host of previous.values()) host.dispose();
}

const NO_HOST = { ok: false, error: '宿主未就绪' };
const defaultSetRect = (rect) => hostForSession(null)?.setRect(rect) || NO_HOST;
const defaultSetVisible = (visible) => hostForSession(null)?.setVisible(visible) || NO_HOST;
const defaultNewTab = (options) => hostForSession(null)?.newTab(options) || Promise.resolve(NO_HOST);
const defaultActivateTab = (id) => hostForSession(null)?.activateTab(id) || NO_HOST;
const defaultCloseTabById = (id) => hostForSession(null)?.closeTabById(id) || NO_HOST;
const defaultContentsOf = (id) => hostForSession(null)?.contentsOf(id) || null;
const defaultRevealTab = (id, rect) => hostForSession(null)?.revealTab(id, rect) || NO_HOST;
const defaultHostInfo = () => hostForSession(null)?.hostInfo() || {
  attached: false, tabs: [], activeId: null, rect: null, visible: false, showing: []
};
const defaultGetState = () => hostForSession(null)?.getState() || emptyState();
const defaultNavigateTab = (id, url, options) => hostForSession(null)?.navigateTab(id, url, options) || Promise.resolve(NO_HOST);
export const activeContents = () => defaultContentsOf();
export {
  defaultSetRect as setRect,
  defaultSetVisible as setVisible,
  defaultNewTab as newTab,
  defaultActivateTab as activateTab,
  defaultCloseTabById as closeTabById,
  defaultContentsOf as contentsOf,
  defaultRevealTab as revealTab,
  defaultHostInfo as hostInfo,
  defaultGetState as getState,
  defaultNavigateTab as navigateTab,
  MAX_TABS
};

/**
 * 0.32.4：让网页**横向完整显示**在给定宽度里。
 *
 * 用户实测（截图：i.chaoxing.com 的个人空间在 620px 右栏里右侧被切掉）：
 * 「这个边框的宽和窄都要限制，一定要把完整页面横向显示出来」。
 *
 * 做法不是继续加宽右栏（窗口就那么宽，加到 1280 就没对话区了），而是：
 *   页面按自己的设计宽度排版（不重排成手机版）→ 再用缩放把它整体压进右栏宽度。
 * 这就是桌面浏览器「缩小到适合宽度」的同一套语义。
 *
 * 为什么这不是 hack：browser_use 的所有交互都走 **DOM 快照 + ref + elementFromPoint**（CSS 像素），
 * 不依赖屏幕坐标，所以 zoomFactor 不会让点击错位。cu（桌面操作）不碰这个 view。
 *
 * @param {number} railWidth 右栏内容区宽度（CSS px）
 */
export const MIN_READABLE_ZOOM = 0.5; // 再小就看不清了（用户宁可横向滚动/拖宽右栏）
export const DESIGN_WIDTH = 1180;    // 常见桌面网页的设计宽度（1280 窗口减去滚动条/边距）

export function zoomForWidth(railWidth, designWidth = DESIGN_WIDTH) {
  const w = Number(railWidth) || 0;
  if (w <= 0) return 1;
  if (w >= designWidth) return 1;                    // 够宽就不缩
  const z = w / designWidth;
  return Math.max(MIN_READABLE_ZOOM, Math.min(1, Number(z.toFixed(3))));
}

function createBrowserHost(win, { onChange, isManaged }) {
  const host = { win, views: new Map(), state: emptyState(), rect: null, visible: false };
  let disposed = false;

  function updateState(state) {
    if (state === host.state) return;
    host.state = state;
    try { onChange(); } catch { /* 发送窗口已关闭 */ }
  }

  function removeView(entry) {
    try { entry.view.setVisible(false); } catch { /* 已销毁 */ }
    try { win.contentView.removeChildView(entry.view); } catch { /* 窗口已关 */ }
    try { entry.wc.close(); } catch { /* 已销毁 */ }
  }

  function clearTabs() {
    const entries = [...host.views.values()];
    host.views.clear();
    host.visible = false;
    host.rect = null;
    updateState(emptyState());
    for (const entry of entries) removeView(entry);
    return { ok: true };
  }

  function hostInfo() {
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
      views.push({ id, bounds: b, showing: Boolean(entry.showing), zoom: entry.zoom ?? 1, url: entry.url || '' });
    }
    return {
      attached: true,
      tabs: host.state.tabs.map((t) => {
        const entry = host.views.get(t.id);
        return {
          ...t,
          label: t.title || t.url,
          // 0.33.4：前进后退 / 加载中 / 存储模式（界面工具条用）
          ...navInfo(entry),
          loading: Boolean(entry?.loading),
          persistent: String(entry?.partition || '').startsWith('persist:')
        };
      }),
      activeId: host.state.activeId,
      rect: host.rect,
      visible: host.visible,
      showing,                                  // 真正处于"已显示"状态的标签 id（0 个或 1 个）
      winContent: (() => { try { return host.win.getContentBounds(); } catch { return null; } })(),
      views
    };
  }

  function getState() { return host.state; }

  /** 渲染层上报的内容区 rect（DIP）。只认整数并且宽高为正，否则视为「还不知道」。 */
  function setRect(rect) {
    if (disposed) return NO_HOST;
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
  function setVisible(visible) {
    if (disposed) return NO_HOST;
    host.visible = visible === true;
    if (!host.visible) { hideAll(); return { ok: true, visible: false }; }
    applyAllBounds();
    return { ok: true, visible: true };
  }

  /**
   * 新开一个网页标签。partition 由调用方按现有策略解析（无痕/持久语义不变）。
   * @param {{url?:string, partition?:string, openerId?:string|null, background?:boolean}} opts
   */
  async function newTab({ url = '', partition, openerId = null, background = false } = {}) {
    if (disposed) return NO_HOST;
    const id = `bt-${++nextId}`;
    const previous = host.state;
    const res = openTab(previous, { id, url, openerId });
    if (!res.ok) return { ok: false, error: res.error };
    let entry;
    try {
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          // 0.33.5：启用内置 PDF 查看器 → navigator.plugins 和真 Edge 一样有 PDF 条目（空列表是典型的机器人特征）
          plugins: true,
          ...(partition ? { partition } : {})
        }
      });
      // 0.32.6：zoom 初值必须是 null（不是 1/undefined）——否则首帧会白设一次 zoomFactor
      // 0.32.7：权限默认拒绝（Electron 不设处理函数就自动批准摄像头/麦克风/定位等一切请求）
      hardenSession(view.webContents.session);
      // 0.33.5：UA / Accept-Language 对齐 Edge（会话级，去掉 Electron / FinalCheck 字样）
      applyEdgeIdentityToSession(view.webContents.session);
      entry = { id, view, wc: view.webContents, url: '', title: '', showing: false, navigation: 0, zoom: null,
        // 0.33.4：partition 记下来（界面显示「长期保留 / 无痕」）；requested = 最近一次要打开的网址（加载失败时刷新用它重试）
        partition: String(partition || ''), requested: String(url || ''), loading: false };
      view.setVisible(false);
      win.contentView.addChildView(view);
    } catch (error) {
      if (entry) removeView(entry);
      return { ok: false, error: `创建视图失败：${error?.message || error}` };
    }

    const { wc } = entry;
    host.views.set(id, entry);
    // window.open / target=_blank → 变成新标签（PoC 已验证 handler 能抓到 url）
    //
    // ⚠️ 0.32.4 P0（用户实测：「一扫二维码登录，就跳转到我外面的浏览器了」）：
    // index.mjs 有一个全局 app.on('web-contents-created') 守卫，它把**任何**新 webContents 的
    // window.open 和 will-navigate 都交给系统浏览器（shell.openExternal）。内嵌浏览器的 view
    // 也在它管辖范围内，于是扫码后跳登录成功页就被扔到外部浏览器了。
    // 这里在创建后**立刻夺回控制权**：重设 window.open handler + 摘掉那个 will-navigate 监听。
    // 内嵌浏览器的语义必须是「一切留在自己里面」；要开外部浏览器只能由用户点右栏的按钮。
    wc.setWindowOpenHandler(({ url: target }) => {
      const verdict = classifyWindowOpen(target);
      if (verdict.open && host.views.has(id)) {
        void newTab({ url: verdict.url, partition, openerId: id });
      }
      return { action: 'deny' };
    });
    try { wc.__fcEmbeddedBrowser = true; } catch { /* 只读对象：忽略 */ }
    // 摘掉 index.mjs 注册的那个 will-navigate（它会把页面内导航推给系统浏览器）
    try {
      const guard = wc.__fcNavGuard;
      if (typeof guard === 'function') wc.removeListener('will-navigate', guard);
      wc.__fcNavGuard = null;
    } catch { /* 拿不到就靠下面的兜底 */ }
    // 兜底：即便旧的 will-navigate 还在（时序差异），这里也保证页面内主帧导航不被 push 出去。
    // 只拦「跳到系统浏览器」这一件事；页面自己正常跳转要放行（否则扫码后到不了成功页）。
    wc.on('will-navigate', (event, targetUrl) => {
      try {
        const u = new URL(String(targetUrl || ''));
        if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:') {
          entry.navigation++;
          return;
        }
      } catch { /* 非法 URL：交给默认处理 */ }
      event.preventDefault();
    });

    const patchPage = (patch) => {
      if (!host.views.has(id)) return;
      Object.assign(entry, patch);
      const current = tabById(host.state, id);
      if (Object.entries(patch).some(([key, value]) => current[key] !== value)) {
        updateState(patchTab(host.state, id, patch).state);
      }
    };
    // 0.33.4：加载状态 / 前进后退可用性要实时推给右栏（刷新按钮变「停止」、← → 置灰）
    const pushNav = () => { if (host.views.has(id)) { try { onChange(); } catch { /* 窗口已关 */ } } };
    // 0.33.6：页面有了文档才能发视口覆盖（实测：首次加载前发 Emulation.setDeviceMetricsOverride 会把整个进程搞崩）；
    // 每次 dom-ready 重新对一次（跨导航保险）
    wc.on('dom-ready', () => { entry.docReady = true; entry.viewportKey = null; syncHiddenViewport(entry, entry.showing); });
    wc.on('did-start-loading', () => { entry.loading = true; pushNav(); });
    wc.on('did-stop-loading', () => { entry.loading = false; pushNav(); });
    wc.on('did-fail-load', (_e, code, _desc, failedUrl, isMainFrame) => {
      // 主帧加载失败（断网 / 被墙 / 超时）：地址栏保留失败的网址，刷新能重试；-3 是被新导航打断，不算
      if (isMainFrame && code !== -3 && failedUrl) { entry.requested = String(failedUrl); patchPage({ url: String(failedUrl) }); }
    });
    // 0.33.4：页面里按 F5 / Ctrl+R 刷新、Ctrl+Shift+R / Ctrl+F5 强制刷新、Alt+← / Alt+→ 后退前进（和 Edge 一样）
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '');
      const ctrl = input.control || input.meta;
      let act = null;
      if (key === 'F5') act = ctrl || input.shift ? 'hard-reload' : 'reload';
      else if (ctrl && !input.alt && (key === 'r' || key === 'R')) act = input.shift ? 'hard-reload' : 'reload';
      else if (input.alt && !ctrl && key === 'ArrowLeft') act = 'back';
      else if (input.alt && !ctrl && key === 'ArrowRight') act = 'forward';
      else if (key === 'BrowserBack') act = 'back';
      else if (key === 'BrowserForward') act = 'forward';
      if (!act) return;
      event.preventDefault();
      if (act === 'reload' || act === 'hard-reload') reloadTab(id, { hard: act === 'hard-reload' });
      else navHistory(id, act);
    });
    wc.on('page-title-updated', (_e, title) => patchPage({ title: String(title || '') }));
    wc.on('did-navigate', (_e, navUrl) => patchPage({ url: String(navUrl || '') }));
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame) patchPage({ url: String(navUrl || '') });
    });

    updateState(background && previous.activeId ? { ...res.state, activeId: previous.activeId } : res.state);
    applyAllBounds();
    // 0.33.5：Client Hints（Sec-CH-UA / navigator.userAgentData）也报 Microsoft Edge——必须在首个请求之前
    // （只有真 webContents 才有 debugger；测试替身上不多等一拍，保持原有的同步时序）
    if (wc.debugger) await applyEdgeIdentityToContents(wc);
    if (url) {
      const initialNavigation = ++entry.navigation;
      try {
        await wc.loadURL(url);
      } catch (error) {
        if (!host.views.has(id)) return { ok: false, error: '标签已关闭' };
        // 用户可以在首个页面尚未加载完成时输入新网址或刷新。旧请求的失败不应关闭新页面。
        if (entry.navigation === initialNavigation) {
          const wasActive = host.state.activeId === id;
          closeTabById(id);
          if (wasActive && previous.activeId) activateTab(previous.activeId);
          return { ok: false, error: String(error?.message || error) };
        }
      }
    }
    if (!host.views.has(id)) return { ok: false, error: '标签已关闭' };
    return { ok: true, id, tab: tabById(host.state, id) };
  }

  /** 切活动标签（只切可见性，不销毁任何页面）。 */
  function activateTab(id) {
    if (disposed) return NO_HOST;
    const res = switchTab(host.state, id);
    if (!res.ok) return { ok: false, error: res.error };
    if (res.state.activeId !== host.state.activeId) updateState(res.state);
    applyAllBounds();
    return { ok: true, activeId: host.state.activeId };
  }

  /** 关掉一个标签（连同它的 view）。 */
  function closeTabById(id) {
    if (disposed) return NO_HOST;
    const entry = host.views.get(String(id));
    const res = closeTab(host.state, id);
    if (!res.ok) return { ok: false, error: res.error };
    host.views.delete(String(id));
    updateState(res.state);
    if (entry) removeView(entry);
    applyAllBounds();
    return { ok: true, state: host.state };
  }

  /** 给指定标签导航（工具层 navigate 会走这里，成功后活动标签就是它）。 */
  async function navigateTab(id, url, { activate = true } = {}) {
    if (disposed) return NO_HOST;
    const entry = host.views.get(String(id));
    if (!entry) return { ok: false, error: `标签不存在：${id}` };
    if (activate) activateTab(id);
    entry.navigation++;
    entry.requested = String(url || '');
    try {
      await entry.wc.loadURL(url);
      if (!host.views.has(String(id))) return { ok: false, error: '标签已关闭' };
      return { ok: true, id, url: entry.wc.getURL(), title: entry.wc.getTitle() };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  // 0.33.4 用户反馈「刷新完全没反应」：加载失败的标签 tab.url 是空的（did-navigate 没触发），以前直接拒绝；
  // 现在按 当前网址 > 状态里的网址 > 最近一次要打开的网址 取目标——页面没真正加载成功就重新 loadURL，否则 reload。
  function reloadTab(id, { hard = false } = {}) {
    const tab = tabById(host.state, id);
    const entry = host.views.get(String(id));
    if (!tab || !entry) return { ok: false, error: '没有可重新加载的网页' };
    let live = '';
    try { live = entry.wc.getURL(); } catch { live = ''; }
    const target = (live && !/^(about:blank|chrome-error:)/i.test(live) ? live : '') || tab.url || entry.requested || '';
    if (!target) return { ok: false, error: '这个标签还没有打开网页' };
    entry.navigation++;
    try {
      if (live && live === target) {
        if (hard) entry.wc.reloadIgnoringCache(); else entry.wc.reload();
      } else {
        entry.requested = target;
        entry.wc.loadURL(target).catch(() => { /* 失败页由 did-fail-load 记账 */ });
      }
    } catch (error) { return { ok: false, error: String(error?.message || error) }; }
    return { ok: true, id: tab.id, url: target };
  }

  /** 0.33.4：后退 / 前进 / 停止（Electron 新版用 navigationHistory，旧版退回 wc.goBack） */
  function navInfo(entry) {
    const wc = entry?.wc;
    if (!wc) return { canGoBack: false, canGoForward: false };
    try {
      const h = wc.navigationHistory;
      if (h && typeof h.canGoBack === 'function') return { canGoBack: h.canGoBack(), canGoForward: h.canGoForward() };
      return { canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() };
    } catch { return { canGoBack: false, canGoForward: false }; }
  }
  function navHistory(id, dir) {
    const entry = host.views.get(String(id));
    if (!entry) return { ok: false, error: '标签不存在' };
    const wc = entry.wc;
    try {
      if (dir === 'stop') { wc.stop(); return { ok: true }; }
      const info = navInfo(entry);
      const h = wc.navigationHistory;
      if (dir === 'back') {
        if (!info.canGoBack) return { ok: false, error: '没有可后退的页面' };
        entry.navigation++;
        if (h && typeof h.goBack === 'function') h.goBack(); else wc.goBack();
        return { ok: true };
      }
      if (dir === 'forward') {
        if (!info.canGoForward) return { ok: false, error: '没有可前进的页面' };
        entry.navigation++;
        if (h && typeof h.goForward === 'function') h.goForward(); else wc.goForward();
        return { ok: true };
      }
    } catch (error) { return { ok: false, error: String(error?.message || error) }; }
    return { ok: false, error: `未知操作：${dir}` };
  }

  /**
   * 把缩放应用到某个 view（不可用时静默跳过，绝不因此中断导航）。
   *
   * 0.32.6 P0（卡顿第二源）：setZoomFactor 会让页面重新排版/重绘，是重活。
   * 拖动右栏时 rect 每帧都变，以前每次都无条件重设 zoom（即便算出来的值一模一样），
   * 等于每帧让整个网页 relayout 一次。现在只有值真变了才下发（同档位零成本）。
   * ⚠️ 这条 Codex 侧原本没有（它只测 zoomForWidth 的纯函数值，没测重复调用）；
   * 合并时补回，否则「拖动右栏时网页反复重排」这个卡顿源会退回去。
   */
  function applyZoom(entry, railWidth) {
    const z = zoomForWidth(railWidth);
    if (entry.zoom === z) return z;
    try { entry.wc.setZoomFactor?.(z); } catch { /* 老版本/已销毁 */ }
    entry.zoom = z;
    return z;
  }
  /**
   * 拿 webContents 给 browser-use 用：它需要在这个 wc 上跑快照/点击
   * （executeJavaScriptInIsolatedWorld）与 capturePage。宿主只借出引用，不干涉页面语义。
   */
  function contentsOf(id = null) {
    if (disposed) return null;
    const targetId = id == null ? host.state.activeId : String(id);
    if (!targetId) return null;
    return host.views.get(targetId)?.wc || null;
  }

  /** AI 要操作时把对应标签摆到可见位置（右栏没展开时也强制可见——否则又是"看不到"）。 */
  function revealTab(id = null, rect = null) {
    if (disposed) return NO_HOST;
    if (rect) {
      const r = normalizeRect(rect);
      if (r) host.rect = r;
    }
    const targetId = id == null ? host.state.activeId : String(id);
    if (!targetId) return { ok: false, error: '没有可用标签' };
    const result = activateTab(targetId);
    if (!result.ok) return result;
    if (!isManaged()) setVisible(true);
    return { ok: true, activeId: host.state.activeId, rect: host.rect };
  }



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
    if (!host.rect || win.isDestroyed?.()) return;
    const r = clampToWindow(host.rect);
    // 0.32.6：同样的 rect 不重复 setBounds（拖动/轮询会高频调用它，重复设置要付重排代价）
    const key = `${r.x},${r.y},${r.width},${r.height}`;
    if (entry.boundsKey === key) return;
    entry.boundsKey = key;
    try {
      entry.view.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
    } catch { /* 已销毁 */ }
  }

  /**
   * 让「只有活动标签可见，且贴在渲染层报上来的 rect」这件事一直成立。
   * 每次 rect / 可见性 / 活动标签 / 窗口尺寸变化都调它——幂等。
   * 0.32.6：setVisible 本身也做幂等（已经显示就不再重复置真、已经藏着就不再重复置假）。
   */
  /**
   * 0.33.6：藏着的标签（setVisible(false)）在 Chromium 里视口是 0×0 —— elementFromPoint 全落空，
   * AI 在后台标签上点按钮会报「被遮挡」（并行浏览器子代理各占一个标签，同一时间只有一个显示在右栏；
   * 右栏收起时 AI 自己的标签也一样）。实测：给藏着的视图发 CDP Emulation.setDeviceMetricsOverride
   * 就有了真实布局，Input.dispatchMouseEvent 的真实点击也能落到按钮上；显示出来时清掉覆盖，回到跟随视图尺寸。
   */
  const HIDDEN_VIEWPORT = { width: 1280, height: 800 };
  function syncHiddenViewport(entry, showing) {
    const dbg = entry.wc?.debugger;
    if (!dbg || !entry.docReady || entry.wc.isDestroyed?.()) return;
    const size = host.rect?.width > 0 && host.rect?.height > 0
      ? { width: Math.round(host.rect.width), height: Math.round(host.rect.height) }
      : HIDDEN_VIEWPORT;
    const key = showing ? 'shown' : `${size.width}x${size.height}`;
    if (entry.viewportKey === key) return;
    entry.viewportKey = key;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      const sent = showing
        ? dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
        : dbg.sendCommand('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 0, mobile: false });
      sent.catch(() => { if (entry.viewportKey === key) entry.viewportKey = null; });
    } catch { entry.viewportKey = null; }
  }

  function applyAllBounds() {
    const active = host.state.activeId;
    for (const [id, entry] of host.views) {
      const shouldShow = host.visible && Boolean(host.rect) && id === active;
      try {
        if (shouldShow) {
          applyEntryBounds(entry);
          // 0.32.4：宽度一变就重算缩放，保证网页横向完整显示（不是把它切掉）
          if (host.rect?.width) applyZoom(entry, host.rect.width);
          if (!entry.showing) { entry.view.setVisible(true); entry.showing = true; }
        } else if (entry.showing) {
          entry.view.setVisible(false);
          entry.showing = false;
        }
        syncHiddenViewport(entry, shouldShow);
      } catch { /* 已销毁 */ }
    }
  }

  return {
    hostInfo, getState, setRect, setVisible, newTab, activateTab, closeTabById, clearTabs,
    navigateTab, reloadTab, navHistory, contentsOf, revealTab, resize: applyAllBounds,
    suspend() { if (!isManaged()) setVisible(false); },
    dispose() { disposed = true; clearTabs(); }
  };
}
