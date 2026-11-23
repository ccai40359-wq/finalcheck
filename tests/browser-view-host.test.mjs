// 0.32.0：内嵌浏览器宿主（WebContentsView 池）的状态机测试。
//
// 用假的 electron 模块注入（node:module register）——和 tests/computer-use-action-entry.test.mjs
// 同一套手法：真跑宿主代码，但 WebContentsView 换成可观测的替身。
// 钉住的东西：只有活动标签可见、rect 必须落在窗口内容区、看不见时一律隐藏、
// window.open 被拒并转交给上层、关闭标签后不留可见的孤儿 view。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// —— 假 electron：只实现宿主用到的那几样 ——
const created = [];
let evtHandlers = new Map();
class FakeWebContents {
  constructor(opts) {
    this.opts = opts;
    this.url = '';
    this.title = '';
    this.destroyed = false;
    this.handlers = new Map();
    this.windowOpenHandler = null;
    this.visibleRects = [];
  }
  loadURL(u) { this.url = u; this.emit('did-navigate', null, u); return Promise.resolve(); }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
  on(name, fn) { const list = this.handlers.get(name) || []; list.push(fn); this.handlers.set(name, list); }
  emit(name, ...args) { for (const fn of (this.handlers.get(name) || [])) fn(...args); }
  close() { this.destroyed = true; }
  isDestroyed() { return this.destroyed; }
  capturePage() { return Promise.resolve({ toPNG: () => Buffer.from('x'), getSize: () => ({ width: 10, height: 10 }) }); }
  executeJavaScriptInIsolatedWorld() { return Promise.resolve({ ok: true }); }
}
class FakeView {
  constructor(opts) {
    this.webContents = new FakeWebContents(opts);
    this.visible = true;
    this.bounds = null;
    created.push(this);
  }
  setVisible(v) { this.visible = v; }
  getVisible() { return this.visible; }
  setBounds(b) { this.bounds = b; }
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

const load = async () => import(pathToFileURL(path.join(repoRoot, 'desktop/src/main/browser-view-host.mjs')).href + `?t=${Date.now()}`);

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
  const t2 = await host.newTab({ url: 'https://b.test/' });
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

test('宿主: window.open 一律 deny，http(s) 才转交上层开新标签', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow);
  const opened = [];
  host.ensureHost(fakeWindow).onWindowOpen = (u, fromId) => opened.push([u, fromId]);
  const t = await host.newTab({ url: 'https://a.test/' });
  const v = created.find((x) => x.webContents.getURL() === 'https://a.test/');
  const decision = v.webContents.windowOpenHandler({ url: 'https://b.test/new' });
  assert.equal(decision.action, 'deny', '浏览器默认行为必须拒绝（否则会开原生新窗口）');
  assert.deepEqual(opened, [['https://b.test/new', t.id]], 'http(s) 要转交给上层当新标签开');
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
  assert.deepEqual(host.hostInfo(), { attached: false, tabs: [], activeId: null, rect: null, visible: false });
  for (const fn of ['setRect', 'setVisible', 'activateTab', 'closeTabById', 'revealTab']) {
    const r = host[fn]({ x: 1, y: 1, width: 10, height: 10 });
    assert.equal(r.ok, false, `${fn} 在没有宿主时必须报失败`);
  }
});

test('宿主: revealTab 在没有 rect 时也把标签设为可见（AI 操作不能"看不见"）', async () => {
  created.length = 0;
  CHILD_VIEWS.clear();
  const host = await load();
  host.ensureHost(fakeWindow);
  const t = await host.newTab({ url: 'https://a.test/' });
  const r = host.revealTab(t.id, { x: 700, y: 50, width: 500, height: 700 });
  assert.equal(r.ok, true);
  assert.equal(created.filter((v) => v.visible).length, 1, 'AI 一动手就必须让画面真的显示出来');
});
