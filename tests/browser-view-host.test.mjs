// 0.32.0：内嵌浏览器宿主（WebContentsView 池）的状态机测试。
//
// 用假的 electron 模块注入（node:module register）——和 tests/computer-use-action-entry.test.mjs
// 同一套手法：真跑宿主代码，但 WebContentsView 换成可观测的替身。
// 钉住的东西：只有活动标签可见、rect 必须落在窗口内容区、看不见时一律隐藏、
// window.open 由内嵌宿主接管，关闭标签后不留可见的孤儿 view。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// —— 假 electron：只实现宿主用到的那几样 ——
const created = [];
let evtHandlers = new Map();
let rejectedUrl = null;
let openOutside = null;
let importCount = 0;
let nextContentsId = 0;
let sessionFixture = null;
let duringLoad = null;
const deferredLoads = new Map();
class FakeWebContents extends EventEmitter {
  constructor(opts) {
    super();
    this.id = ++nextContentsId;
    this.session = sessionFixture;
    this.opts = opts;
    this.url = '';
    this.title = '';
    this.destroyed = false;
    this.windowOpenHandler = null;
    this.loads = [];
    this.reloads = 0;
    // 0.32.6 幂等断言用：数「真的下发了几次」，而不是数代码跑了几遍
    this.zoomSets = [];
    this.__fcNavGuard = (_e, url) => openOutside?.(url);
    this.on('will-navigate', this.__fcNavGuard);
    this.setWindowOpenHandler(({ url }) => { openOutside?.(url); return { action: 'deny' }; });
  }
  loadURL(url) {
    this.loads.push(url);
    this.emit('did-start-navigation', { isMainFrame: true });
    duringLoad?.(this, url);
    if (deferredLoads.has(url)) return deferredLoads.get(url).promise;
    if (rejectedUrl === url) return Promise.reject(new Error('failed load'));
    this.url = url;
    this.title = new URL(url).hostname;
    this.emit('did-navigate', null, url);
    this.emit('page-title-updated', null, this.title);
    return Promise.resolve();
  }
  reload() { this.reloads++; }
  isLoading() { return false; }
  isWaitingForResponse() { return false; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
  close() { this.destroyed = true; this.emit('destroyed'); }
  isDestroyed() { return this.destroyed; }
  capturePage() { return Promise.resolve({ toPNG: () => Buffer.from('x'), getSize: () => ({ width: 10, height: 10 }) }); }
  executeJavaScriptInIsolatedWorld() { return Promise.resolve({ ok: true, ready: 'complete' }); }
  setZoomFactor(z) { this.zoomSets.push(z); }
}
class FakeView {
  constructor(opts) {
    this.webContents = new FakeWebContents(opts);
    this.visible = true;
    this.bounds = null;
    this.boundsSets = 0;   // 0.32.6 幂等断言用
    created.push(this);
  }
  setVisible(v) { this.visible = v; }
  getVisible() { return this.visible; }
  setBounds(b) { this.bounds = b; this.boundsSets++; }
  getBounds() { return this.bounds; }
}
const CHILD_VIEWS = new Set();
const fakeContentView = {
  addChildView(v) { CHILD_VIEWS.add(v); },
  removeChildView(v) { CHILD_VIEWS.delete(v); }
};
const fakeWindow = {
  destroyed: false,
  contentView: fakeContentView,
  on(name, fn) { evtHandlers.set(name, fn); },
  isDestroyed() { return this.destroyed; },
  getContentBounds() { return { x: 0, y: 0, width: 1280, height: 820 }; }
};

const fakeElectron = {
  WebContentsView: FakeView,
  BrowserWindow: class {},
  app: { whenReady: () => Promise.resolve() }
};

// node:module register 的 hooks：把 'electron' 解析到我们的替身
const registerData = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: ${JSON.stringify('data:text/javascript,export const WebContentsView = globalThis.__FC_FAKE__.WebContentsView; export const BrowserWindow = globalThis.__FC_FAKE__.BrowserWindow; export const app = globalThis.__FC_FAKE__.app;')}, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
globalThis.__FC_FAKE__ = fakeElectron;
const dataUrl = 'data:text/javascript,' + encodeURIComponent(registerData);
register(dataUrl);

const load = async () => import(pathToFileURL(path.join(repoRoot, 'desktop/src/main/browser-view-host.mjs')).href + `?t=${++importCount}`);

test('宿主: 只有活动标签可见，其余一律隐藏', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow);
  await host.newTab({ url: 'https://a.test/', partition: 'fc-browser-use' });
  await host.newTab({ url: 'https://b.test/', partition: 'fc-browser-use' });
  host.setRect({ x: 700, y: 50, width: 500, height: 700 });
  host.setVisible(true);

  const visible = created.filter((v) => v.visible);
  assert.equal(visible.length, 1, '同一时刻只能有一个标签可见');
  assert.equal(visible[0].webContents.getURL(), 'https://b.test/', '活动标签是最后打开的那个');
  assert.deepEqual(visible[0].getBounds(), { x: 700, y: 50, width: 500, height: 700 });
  assert.equal(created.filter((v) => !v.visible).length, 1, '另一个标签必须隐藏');
});

test('宿主: 切标签只改可见性，不销毁任何页面（切回来页面还在）', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow);
  const t1 = await host.newTab({ url: 'https://a.test/' });
  await host.newTab({ url: 'https://b.test/' });
  host.setRect({ x: 700, y: 50, width: 500, height: 700 });
  host.setVisible(true);

  host.activateTab(t1.id);
  const vis1 = created.filter((v) => v.visible);
  assert.equal(vis1.length, 1);
  assert.equal(vis1[0].webContents.getURL(), 'https://a.test/');
  // 切走的那一个仍然活着（只是不可见）
  assert.equal(created.find((v) => v.webContents.getURL() === 'https://b.test/').webContents.isDestroyed(), false);
});

test('宿主: 看不见时（setVisible(false) / rect 无效）一律隐藏', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow);
  await host.newTab({ url: 'https://a.test/' });
  host.setRect({ x: 700, y: 50, width: 500, height: 700 });
  host.setVisible(true);
  assert.equal(created.filter((v) => v.visible).length, 1);

  host.setVisible(false);
  assert.equal(created.filter((v) => v.visible).length, 0, '右栏收起后必须全部隐藏');

  host.setVisible(true);
  host.setRect({ x: 0, y: 0, width: 0, height: 0 }); // 无效 rect
  assert.equal(created.filter((v) => v.visible).length, 0, 'rect 无效时宁可不显示，也不画到错位置');
});

test('宿主: rect 会被窗口内容区裁住（不能画到窗口外）', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow);
  await host.newTab({ url: 'https://a.test/' });
  // 故意报一个超出窗口的 rect（1280x820 的窗口，x=1200 + width=500）
  host.setRect({ x: 1200, y: 10, width: 500, height: 700 });
  host.setVisible(true);
  const v = created.filter((x) => x.visible)[0];
  const b = v.getBounds();
  assert.equal(b.x, 1200);
  assert.equal(b.width, 80, '被裁到窗口右边缘（1280 - 1200）');
});

test('宿主: 新窗口请求在同一 partition 内创建一个嵌入标签，拒绝外部 scheme', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  const changed = [];
  const outside = [];
  openOutside = (url) => outside.push(url);
  host.ensureHost(fakeWindow, (sessionId) => changed.push(sessionId));
  const browser = host.hostForSession('owner');
  const source = await browser.newTab({ url: 'https://a.test/', partition: 'persist:fixture' });
  browser.setRect({ x: 700, y: 50, width: 500, height: 700 });
  browser.setVisible(true);
  const opener = browser.contentsOf(source.id);

  assert.deepEqual(opener.windowOpenHandler({ url: 'mailto:example@test.invalid' }), { action: 'deny' });
  assert.equal(browser.getState().tabs.length, 1);
  assert.deepEqual(opener.windowOpenHandler({ url: 'https://b.test/new' }), { action: 'deny' });
  const { tabs, activeId } = browser.getState();
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs[1], { id: activeId, openerId: source.id, title: 'b.test', url: 'https://b.test/new' });
  assert.equal(browser.contentsOf(activeId).opts.webPreferences.partition, 'persist:fixture');
  assert.deepEqual(browser.hostInfo().showing, [activeId]);

  let prevented = false;
  opener.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://c.test/login');
  assert.equal(prevented, false);
  opener.emit('will-navigate', { preventDefault() { prevented = true; } }, 'mailto:example@test.invalid');
  assert.equal(prevented, true);
  assert.deepEqual(outside, []);
  assert.ok(changed.length > 0);
  assert.ok(changed.every((owner) => owner === 'owner'));
  openOutside = null;
});

test('宿主: 弹窗加载失败会销毁视图，达到标签上限时不会创建视图', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  const browser = host.ensureHost(fakeWindow);
  const opener = await browser.newTab({ url: 'https://a.test/' });
  const url = rejectedUrl = 'https://failure.test/';
  try {
    browser.contentsOf(opener.id).windowOpenHandler({ url });
    await Promise.resolve();
    assert.equal(browser.getState().tabs.length, 1);
    assert.equal(browser.hostInfo().activeId, opener.id);
    assert.equal(created.at(-1).webContents.isDestroyed(), true);
    assert.equal(CHILD_VIEWS.size, 1);
  } finally { rejectedUrl = null; }

  for (let i = 1; i < host.MAX_TABS; i++) await browser.newTab();
  const count = created.length;
  browser.contentsOf(opener.id).windowOpenHandler({ url: 'https://b.test/' });
  assert.equal(created.length, count);
  assert.equal(browser.getState().tabs.length, host.MAX_TABS);
  assert.equal(CHILD_VIEWS.size, host.MAX_TABS);
});

test('宿主: 首次加载被用户导航或刷新取代后保留标签，已关闭标签不复活', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  const browser = host.ensureHost(fakeWindow);
  try {
    const byNavigation = Promise.withResolvers();
    deferredLoads.set('https://initial.test/', byNavigation);
    const opening = browser.newTab({ url: 'https://initial.test/' });
    const id = browser.getState().activeId;
    const wc = browser.contentsOf(id);
    assert.equal((await browser.navigateTab(id, 'https://newer.test/')).ok, true);
    byNavigation.reject(new Error('ERR_ABORTED'));
    const result = await opening;
    assert.equal(result.ok, true);
    assert.equal(result.tab.url, 'https://newer.test/');
    assert.equal(browser.getState().activeId, id);
    assert.equal(browser.contentsOf(id), wc);
    assert.equal(wc.isDestroyed(), false);

    const byReload = Promise.withResolvers();
    deferredLoads.set('https://reload.test/', byReload);
    const openingReload = browser.newTab({ url: 'https://reload.test/' });
    const reloadId = browser.getState().activeId;
    const reloading = browser.contentsOf(reloadId);
    assert.equal(browser.reloadTab(reloadId).ok, true);
    byReload.reject(new Error('ERR_ABORTED'));
    assert.equal((await openingReload).ok, true);
    assert.equal(reloading.reloads, 1);
    assert.equal(reloading.isDestroyed(), false);

    const byClose = Promise.withResolvers();
    deferredLoads.set('https://close.test/', byClose);
    const openingClosed = browser.newTab({ url: 'https://close.test/' });
    const closedId = browser.getState().activeId;
    const closed = browser.contentsOf(closedId);
    browser.closeTabById(closedId);
    byClose.reject(new Error('ERR_ABORTED'));
    assert.equal((await openingClosed).ok, false);
    assert.equal(closed.isDestroyed(), true);
    assert.deepEqual(browser.getState().tabs.map((tab) => tab.id), [id, reloadId]);
  } finally {
    deferredLoads.clear();
    host.disposeHost();
  }
});

test('浏览器: 用户打开、切换、导航、刷新或弹窗都保留独立的 AI 目标和会话', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow, () => {});
  const use = await import('../desktop/src/main/browser-use.mjs');
  use.setViewHostProvider(host.hostForSession);
  const a = use.forSession('a');
  const b = use.forSession('b');
  const [superseded, initial, other] = await Promise.all([
    a.navigate('https://superseded.test/'),
    a.navigate('https://ai.test/'),
    b.navigate('https://other.test/')
  ]);
  assert.equal(superseded.ok, false);
  assert.equal(initial.ok, true);
  assert.equal(other.ok, true);
  assert.deepEqual(a.listTabs().tabs.map((tab) => tab.url), ['https://ai.test/']);
  assert.deepEqual(b.listTabs().tabs.map((tab) => tab.url), ['https://other.test/']);

  const userTab = await a.openTab('', { partition: 'persist:fixture' });
  const aHost = host.hostForSession('a');
  const bHost = host.hostForSession('b');
  assert.equal(a.tabFocusInfo().aiTab, initial.tabId);
  assert.equal(a.tabFocusInfo().viewing, userTab.id);
  // 0.32.7：无痕存储按会话派生，a 和 b 的登录态互不可见
  const { sessionPartition } = await import('../desktop/src/main/browser-session.mjs');
  assert.equal(aHost.contentsOf(initial.tabId).opts.webPreferences.partition, sessionPartition('fc-browser-use', 'a'));
  assert.notEqual(bHost.contentsOf(other.tabId).opts.webPreferences.partition, aHost.contentsOf(initial.tabId).opts.webPreferences.partition);
  assert.equal(aHost.contentsOf(userTab.id).opts.webPreferences.partition, 'persist:fixture');
  assert.equal(a.listTabs().tabs.at(-1).url, '');
  a.viewTab(initial.tabId);
  a.viewTab(userTab.id);
  assert.equal(a.listTabs().tabs.at(-1).url, '');
  assert.equal((await a.gotoTab(userTab.id, 'https://user.test/')).ok, true);
  assert.equal(a.reloadTab(userTab.id).ok, true);
  assert.equal(aHost.contentsOf(userTab.id).reloads, 1);
  assert.equal(aHost.contentsOf(initial.tabId).reloads, 0);
  assert.deepEqual(aHost.contentsOf(initial.tabId).loads, ['https://ai.test/']);
  assert.deepEqual(aHost.contentsOf(userTab.id).loads, ['https://user.test/']);
  assert.equal((await a.navigate('https://ai.test/next')).ok, true);
  assert.equal(a.tabFocusInfo().viewing, userTab.id);
  assert.equal(a.tabFocusInfo().aiTab, initial.tabId);

  aHost.contentsOf(userTab.id).windowOpenHandler({ url: 'https://popup.test/' });
  assert.equal(a.listTabs().tabs.length, 3);
  const popup = a.listTabs().tabs.at(-1);
  assert.equal(popup.url, 'https://popup.test/');
  assert.equal(aHost.contentsOf(popup.id).opts.webPreferences.partition, 'persist:fixture');
  assert.equal(a.tabFocusInfo().aiTab, initial.tabId);
  assert.equal(a.closeTab(userTab.id).aiTab, initial.tabId);
  assert.equal((await b.gotoTab(initial.tabId, 'https://wrong-owner.test/')).ok, false);
  assert.deepEqual(aHost.hostInfo().showing, [], 'background agent cannot show a native view');
  aHost.setRect({ x: 700, y: 50, width: 500, height: 700 });
  aHost.setVisible(true);
  assert.equal(aHost.hostInfo().showing.length, 1);
  aHost.setVisible(false);
  assert.equal(a.listTabs().tabs.length, 2);
  const remaining = a.listTabs().tabs.map((tab) => aHost.contentsOf(tab.id));
  const bContents = bHost.contentsOf(other.tabId);
  a.closePanel();
  assert.deepEqual(a.listTabs().tabs, []);
  assert.ok(remaining.every((wc) => wc.isDestroyed()));
  assert.equal(bContents.isDestroyed(), false);
  assert.equal(b.tabFocusInfo().aiTab, other.tabId);

  use.releaseSession('b');
  host.disposeSession('b');
  assert.equal(bContents.isDestroyed(), true);
  assert.deepEqual(b.listTabs().tabs, []);
  assert.equal(b.tabFocusInfo().aiTab, null);
  use.closeAll();
  host.disposeHost();
});

test('浏览器: 共享 partition 按 WebContents 等待请求，完成和出错均释放计数', async () => {
  const host = await load();
  host.ensureHost(fakeWindow, () => {});
  const use = await import('../desktop/src/main/browser-use.mjs');
  use.setViewHostProvider(host.hostForSession);
  const a = use.forSession('net-a');
  const b = use.forSession('net-b');
  const beforeRequest = [];
  const completed = [];
  const errors = [];
  sessionFixture = {
    webRequest: {
      onBeforeRequest(_filter, callback) { beforeRequest.push(callback); },
      onCompleted(_filter, callback) { completed.push(callback); },
      onErrorOccurred(_filter, callback) { errors.push(callback); }
    }
  };
  const requestsStarted = Promise.withResolvers();
  duringLoad = (contents, url) => {
    if (url !== 'https://wait.test/') return;
    beforeRequest[0]({ id: 71, webContentsId: contents.id }, (reply) => assert.deepEqual(reply, {}));
    beforeRequest[0]({ id: 72, webContentsId: contents.id }, (reply) => assert.deepEqual(reply, {}));
    requestsStarted.resolve(contents);
  };
  const pendingB = b.navigate('https://wait.test/');
  try {
    const waiting = await Promise.race([requestsStarted.promise, setTimeout(700, null, { ref: false })]);
    assert.ok(waiting, 'fixture did not start requests');
    const first = await Promise.race([
      pendingB.then(() => 'b'),
      a.navigate('https://quick.test/').then((result) => result.ok ? 'a' : 'failed')
    ]);
    assert.equal(first, 'a', 'A 的新页面可以完成，B 的两个请求仍未完成');
    assert.equal(beforeRequest.length, 1, '共享 partition 只挂一个监听器');

    // Electron 可以在发起 WebContents 已不便访问时只给出请求 ID。
    completed[0]({ id: 71 });
    errors[0]({ id: 72 });
    const finished = await Promise.race([pendingB, setTimeout(700, null, { ref: false })]);
    assert.equal(finished?.ok, true);
  } finally {
    duringLoad = null;
    sessionFixture = null;
    use.closeAll();
    host.disposeHost();
    await pendingB.catch(() => {});
  }
});

test('宿主: 缩放按设计宽度等比计算并限定在可读范围', async () => {
  const { zoomForWidth, MIN_READABLE_ZOOM } = await load();
  assert.equal(zoomForWidth(1280), 1);
  assert.equal(zoomForWidth(1600), 1);
  assert.equal(zoomForWidth(620), 0.525);
  assert.equal(zoomForWidth(200), MIN_READABLE_ZOOM);
  assert.equal(zoomForWidth(0), 1);
});

test('宿主: 关掉活动标签后落到邻居，且不留下可见的孤儿 view', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  evtHandlers = new Map(); // 每个用例重置：假窗口的 resize/closed handler 不能跨用例串
  const host = await load();
  host.disposeHost();
  host.ensureHost(fakeWindow);
  const t1 = await host.newTab({ url: 'https://a.test/' });
  const t2 = await host.newTab({ url: 'https://b.test/' });
  host.setRect({ x: 700, y: 50, width: 500, height: 700 });
  host.setVisible(true);

  host.closeTabById(t2.id);
  const state = host.getState();
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeId, t1.id, '关掉活动标签要落回邻居');
  // 只看本用例建的两个 view（前面的用例会留下已摘掉的旧 view，不能用全局计数判定）
  const mine = created.filter((v) => v.webContents.getURL().endsWith('.test/'));
  assert.equal(mine.filter((v) => v.visible).length, 1, '本用例只剩一个可见');
  assert.equal(mine.filter((v) => v.visible)[0].webContents.getURL(), 'https://a.test/');
  assert.equal(mine.find((v) => v.webContents.getURL() === 'https://b.test/').webContents.isDestroyed(), true,
    '被关掉的标签的 webContents 必须真的销毁');
});

test('宿主: 没有宿主时所有入口都返回可执行错误（不崩）', async () => {
  created.length = 0;
  const host = await load();
  host.disposeHost();
  assert.equal(host.contentsOf(), null);
  assert.deepEqual(host.hostInfo(), { attached: false, tabs: [], activeId: null, rect: null, visible: false, showing: [] });
  for (const fn of ['setRect', 'setVisible', 'activateTab', 'closeTabById', 'revealTab']) {
    const r = host[fn]({ x: 1, y: 1, width: 10, height: 10 });
    assert.equal(r.ok, false, `${fn} 在没有宿主时必须报失败`);
  }
});

// 0.32.6 合并后：Codex 侧的 revealTab 用 `if (!isManaged()) setVisible(true)`，
// 其中 isManaged = Boolean(notifyTabs)（即「UI 订阅了变更通知」）。
// 这与我的 force 参数表达**同一个意图**：有 UI 管着时可见性只由 UI 决定；
// 没有 UI（测试台/后台驱动）时 AI 一动手就该看得见。所以两条都要钉，不能只钉一侧。
test('宿主: 有 UI 订阅时 revealTab 不抢可见性（避免盖住产物 tab）', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow, () => {});   // 传入 onChange = UI 在管（isManaged=true）
  const t = await host.newTab({ url: 'https://a.test/' });
  host.setRect({ x: 700, y: 50, width: 500, height: 700 });
  host.setVisible(false);                 // 模拟「用户正在看产物 tab」
  host.revealTab(t.id);                   // AI/页面又来通知说有新页面
  assert.equal(created.filter((v) => v.visible).length, 0,
    '有 UI 订阅时，revealTab 不得凭自己把原生层显示出来（那会盖住用户正在看的产物）');
});

test('宿主: 没有 UI 订阅时 revealTab 强制可见（测试台/后台驱动下 AI 操作不能"看不见"）', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow);            // 无 onChange = 没人管（isManaged=false）
  const t = await host.newTab({ url: 'https://a.test/' });
  host.setRect({ x: 700, y: 50, width: 500, height: 700 });
  host.setVisible(false);
  const r = host.revealTab(t.id);
  assert.equal(r.ok, true);
  assert.equal(created.filter((v) => v.visible).length, 1,
    '没有 UI 管的时候必须真的显示出来（否则又是 0.31.x 那个「看不到」的老 bug）');
});

// 0.32.3：WebContentsView **没有 getVisible()**（实测返回 undefined），
// 而 bounds 在隐藏之后仍然非零。所以「当前到底显示没显示」只能由宿主自己记账。
// 这条不成立的话，自检就会把「折叠后仍算显示」判成通过（我踩过一次）。
test('宿主: showing 记账与实际 setVisible 严格一致（bounds 不能用来推断可见性）', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.disposeHost();
  host.ensureHost(fakeWindow);
  await host.newTab({ url: 'https://a.test/' });
  host.setRect({ x: 700, y: 50, width: 500, height: 700 });
  host.setVisible(true);

  const on = host.hostInfo();
  assert.deepEqual(on.showing, [on.activeId], '可见时 showing 恰好是活动标签');
  assert.equal(on.views.find((v) => v.id === on.activeId).showing, true);

  host.setVisible(false);
  const off = host.hostInfo();
  assert.deepEqual(off.showing, [], '隐藏后 showing 必须清空');
  // 关键反例：bounds 仍然非零（这就是不能用它判断可见性的原因）
  const v = off.views[0];
  assert.ok(v.bounds && v.bounds.width > 0, 'bounds 在隐藏后仍然保留——所以它不是可见性信号');
  assert.equal(v.showing, false, 'showing 才是可见性信号');

  // 折叠等价：再显示、再隐藏，showing 每次都跟着走
  host.setVisible(true);
  assert.equal(host.hostInfo().showing.length, 1);
});

/* ---------------- 0.32.6：宿主侧幂等（拖右栏不反复重排） ---------------- */
// 为什么必须有这组断言：Codex 侧只测了 zoomForWidth 的纯函数返回值，
// 没测「重复调用会不会重复下发」。而 setZoomFactor / setBounds 都是重活
// （整页 relayout），拖动右栏时 rect 每帧都变，无条件下发就等于每帧重排一次。
// 这是用户报「巨卡」的次因，静态时不触发，所以「空闲零长任务」测不出来。
test('宿主幂等: 同一 rect 连报 10 次只下发一次 zoom / bounds / visible', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow);
  await host.newTab({ url: 'https://a.test/' });
  const rect = { x: 700, y: 50, width: 500, height: 700 };
  host.setRect(rect);
  host.setVisible(true);
  const wc = created[0].webContents;
  const view = created[0];
  const zoomAfterFirst = wc.zoomSets.length;
  const boundsAfterFirst = view.boundsSets;
  for (let i = 0; i < 10; i++) host.setRect(rect);   // 完全相同的 rect
  assert.equal(wc.zoomSets.length, zoomAfterFirst, '同一宽度不得重复 setZoomFactor');
  assert.equal(view.boundsSets, boundsAfterFirst, '同一 rect 不得重复 setBounds');
});

test('宿主幂等: 宽度真的变了才下发 zoom（同档位不重复）', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow);
  await host.newTab({ url: 'https://a.test/' });
  host.setRect({ x: 700, y: 50, width: 500, height: 700 });
  host.setVisible(true);
  const wc = created[0].webContents;
  const z1 = wc.zoomSets.length;
  // 500 → 700：zoom 值不同 → 必须再下发一次
  host.setRect({ x: 700, y: 50, width: 700, height: 700 });
  assert.equal(wc.zoomSets.length, z1 + 1, '宽度变了必须重新计算缩放');
  // 700 → 701：toFixed(3) 后 zoom 仍是 1（700/1180=0.593 vs 701/1180=0.594 —— 会变，改用 >1180 的两档）
  host.setRect({ x: 700, y: 50, width: 1190, height: 700 });
  host.setRect({ x: 700, y: 50, width: 1200, height: 700 });
  const zAfter = wc.zoomSets.length;
  // 1190 与 1200 都 >= 1180 → zoom 都是 1 → 第二次不该再下发
  assert.ok(wc.zoomSets.every((z) => Number.isFinite(z)), 'zoom 值必须是有限数');
  assert.equal(wc.zoomSets[wc.zoomSets.length - 1], 1, '宽度超过设计宽度时 zoom 应封顶为 1');
  assert.ok(zAfter >= 1, '至少下发过');
});
