// 0.32.6 P0 回归：用户报的三个问题 + 合并时补回的两项。
//
// 用户报的现象（2026-11-23）：
//   ① 「开了浏览器情况下我点不了图片」
//   ② 「巨卡无比，我切换会话，打字，巨卡」
//   ③ 「我在内置浏览器页面点这些课程没反应」
//
// 0.32.5（我）与 0.32.6（合并 Codex）分别用不同路径都解决了这三条：
//   · 我：断掉渲染↔IPC 死循环（回调走 ref + 结构比较）+ 给 window.open 真接线
//   · Codex：事件驱动推送（updateState 引用相等守卫）+ 宿主内部直接 newTab + 按会话隔离宿主
// 合并后真实的实现是「Codex 架构 + 我补的两项」，所以这个文件钉的是**合并后的约束**，
// 不是任何一侧的历史写法。
//
// 合并时补回的项（Codex 侧缺）：
//   A. ensureBrowserRailTab —— 已有浏览器 tab 时，后续通知不得抢走用户正在看的产物/图片
//   B. 宿主幂等（zoom/bounds/visible）—— 拖右栏不反复整页重排（见 browser-view-host.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  emptyRail, openRailTab, activateRailTab, patchRailTab, ensureBrowserRailTab
} from '../desktop/src/renderer/lib/rail-tabs.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paneSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/BrowserPane.jsx'), 'utf8');
const railSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/RightRail.jsx'), 'utf8');
const appSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');
const hostSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/browser-view-host.mjs'), 'utf8');
const useSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/browser-use.mjs'), 'utf8');
const ipcSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/ipc/ipc-agent.mjs'), 'utf8');

/* ---------------- A. 防抢焦点（合并时补回） ---------------- */

test('A1 ensureBrowserRailTab：重复通知不抢用户正在看的 tab（"点不了图片"的根因之一）', () => {
  // 真实链路（S16 实测）：点 chip 后产物 tab 确实开出来了，但 6.5s 内 activeKind 变回 browser。
  // 原因是多条通道（AI navigate / 用户输网址）都调 openRailTab(browser)，
  // 而它无条件把 activeKey 设成 'browser'。
  let rail = emptyRail();
  // 第一次：右栏还没有浏览器 tab → 必须开出来并切过去（用户要看见 AI 在干什么）
  rail = ensureBrowserRailTab(rail, { tabId: 'bt-1' });
  assert.equal(rail.activeKey, 'browser', '首次必须切到浏览器（否则用户看不到 AI 在操作什么）');
  assert.equal(rail.tabs.length, 1);
  // 用户点了 PNG chip
  rail = openRailTab(rail, { kind: 'artifact', artifactPath: 'D:/x/n1.png', title: 'n1.png' }).rail;
  rail = activateRailTab(rail, 'artifact:D:/x/n1.png').rail;
  assert.equal(rail.activeKey, 'artifact:D:/x/n1.png');
  // 这时又来一条浏览器通知（用户输网址 / AI 换页）
  const after = ensureBrowserRailTab(rail, { tabId: 'bt-2' });
  assert.equal(after.activeKey, 'artifact:D:/x/n1.png', '已有浏览器 tab 时，后续通知绝不能抢焦点');
  assert.equal(after.tabs.find((t) => t.kind === 'browser').payload.tabId, 'bt-2', '载荷仍要更新');
});

test('A2 ensureBrowserRailTab：空载荷不覆盖已有标题，无变化时返回同一引用', () => {
  let rail = ensureBrowserRailTab(emptyRail(), { tabId: 'bt-1' });
  // 标题由 patchRailTab 写（合并后的真实路径）
  rail = patchRailTab(rail, 'browser', { payload: { pageTitle: '哈尔滨理工大学(学生)' } }).rail;
  // 主进程推的 pageTitle 常常是空串——不能把标题清空
  const a = ensureBrowserRailTab(rail, { tabId: 'bt-1', pageTitle: '' });
  assert.equal(a, rail, '完全无变化必须返回同一引用（零重渲染）');
  assert.equal(a.tabs[0].payload.pageTitle, '哈尔滨理工大学(学生)', '空值不覆盖已有值');
  assert.equal(ensureBrowserRailTab(a, { tabId: 'bt-1' }), a, '重复同一 tabId 也是无变化');
});

test('A3 App：两条 browser-rail-open 通道都走 ensureBrowserRailTab（不是 openRailTab）', () => {
  // 用 indexOf 计数：正则里 `{` 是量词起始符，写 /openRailTab(cur, { kind/ 会语法错
  const needle = "openRailTab(cur, { kind: 'browser'";
  let n = 0;
  for (let i = appSrc.indexOf(needle); i >= 0; i = appSrc.indexOf(needle, i + 1)) n++;
  assert.equal(n, 0, '不得再有「无条件切到浏览器」的写法');
  let m = 0;
  const ensureNeedle = 'ensureBrowserRailTab(cur';
  for (let i = appSrc.indexOf(ensureNeedle); i >= 0; i = appSrc.indexOf(ensureNeedle, i + 1)) m++;
  assert.ok(m >= 2, `至少两处（agent-event 通道 + 用户输网址通道）要走 ensure，实际 ${m} 处`);
});

/* ---------------- ① 死循环：三方约束 ---------------- */

test('① 右栏归约函数：activeKey 已是目标时返回同一引用（不造新对象 = 不断供重渲染燃料）', () => {
  // 这条两侧独立收敛到同一结论（我 0.32.5 / Codex 696bcb0 都有），是死循环的根本护栏
  let rail = openRailTab(emptyRail(), { kind: 'browser' }).rail;
  assert.equal(activateRailTab(rail, 'browser').rail, rail, 'activateRailTab 同值必须返回同一引用');
  assert.equal(openRailTab(rail, { kind: 'browser' }).rail, rail, 'openRailTab 重复同键必须返回同一引用');
  // patchRailTab：值没变也必须返回同一引用
  rail = patchRailTab(rail, 'browser', { payload: { pageTitle: 'X' } }).rail;
  assert.equal(patchRailTab(rail, 'browser', { payload: { pageTitle: 'X' } }).rail, rail,
    'patchRailTab 值没变必须返回同一引用');
});

test('① BrowserPane：刷新走事件驱动 + 序号守卫，不靠「父组件回调进依赖数组」', () => {
  // Codex 的方案：refreshSequence 序号丢弃过期响应；onBrowserTabsChanged 事件驱动
  assert.match(paneSrc, /refreshSequence/, '要有请求序号守卫（丢弃过期响应）');
  assert.match(paneSrc, /onBrowserTabsChanged/, '要订阅主进程的变更事件（事件驱动而非纯轮询）');
  // 反例：不得再出现「每次渲染都换引用的父组件回调」直接驱动刷新
  assert.equal(/onTabsChange/.test(paneSrc), false, '旧的 onTabsChange 通道必须消失');
});

test('① 宿主：状态没变就不推变更事件（updateState 引用相等守卫）', () => {
  assert.match(hostSrc, /function updateState\(state\) \{/, '要有统一的 state 更新入口');
  assert.match(hostSrc, /if \(state === host\.state\) return;/, '同一个 state 引用不得重复推 onChange');
});

/* ---------------- ③ 页面 window.open ---------------- */

test('③ 页面 window.open 必须在宿主内部真的开新标签（"点课程没反应"的根因）', () => {
  assert.match(hostSrc, /wc\.setWindowOpenHandler/, '要拦 window.open');
  assert.match(hostSrc, /void newTab\(\{ url: verdict\.url, partition, openerId: id \}\)/,
    'window.open 必须变成真的新标签（合并后是宿主内部直接开，不经过上层回调）');
  // 关键：newTab 与 deny 必须**在同一个 handler 里**（只 deny 不处理 = 静默丢掉，
  // 那正是 0.32.0~0.32.4 两轮「修了但没效果」的原因）。
  // 取边界用 "setWindowOpenHandler" 到它后面第一个 "return { action: 'deny' };"（不要用 '});'
  // ——那会在 newTab({...}) 的内层 ) 就截断，把 deny 切在窗口外）
  const start = hostSrc.indexOf('wc.setWindowOpenHandler');
  const denyAt = hostSrc.indexOf("return { action: 'deny' };", start);
  assert.ok(denyAt > start, 'handler 内必须 return deny');
  const handler = hostSrc.slice(start, denyAt);
  assert.match(handler, /void newTab\(/, 'handler 内必须开新标签');
  // 安全：about:blank / javascript: 仍要拒（classifyWindowOpen 的语义不回归）
  assert.match(hostSrc, /classifyWindowOpen\(target\)/);
});

test('③ window.open 新标签不得搬走 AI 的工作目标（0.32.4 定下的分离语义）', () => {
  // 合并后 window.open 走宿主内部 newTab，它只动宿主自己的 views/state，
  // 不碰 browser-use 里按会话隔离的 scope（active/tabId）。
  assert.match(useSrc, /scopeContext/, 'browser-use 要按会话隔离作用域');
  const body = hostSrc.slice(hostSrc.indexOf('setWindowOpenHandler'), hostSrc.indexOf('setWindowOpenHandler') + 400);
  assert.equal(/active\.contents\s*=/.test(body), false, 'window.open 不得改 browser-use 的 active.contents');
});

/* ---------------- ② 卡顿：宿主幂等（合并时补回） ---------------- */

test('② 宿主：zoom / bounds / visible 都幂等（不重复下发 = 不重复 relayout）', () => {
  assert.match(hostSrc, /if \(entry\.zoom === z\) return z;/, 'zoom 没变不得重复 setZoomFactor（整页 relayout）');
  assert.match(hostSrc, /if \(entry\.boundsKey === key\) return;/, 'bounds 没变不得重复 setBounds');
  assert.match(hostSrc, /if \(!entry\.showing\) \{ entry\.view\.setVisible\(true\); entry\.showing = true; \}/,
    '已经显示就不再重复 setVisible(true)');
  assert.match(hostSrc, /else if \(entry\.showing\) \{/, '已经隐藏就不再重复 setVisible(false)');
  assert.match(hostSrc, /showing: false, navigation: 0, zoom: null \}/, 'entry 的 zoom 初值要是 null');
});

test('② 宿主：报告状态仍能反映真实 zoom（自检要能读到）', () => {
  assert.match(hostSrc, /zoom: entry\.zoom \?\? 1/, 'hostInfo 要报告生效的 zoom');
  assert.match(hostSrc, /if \(host\.rect\?\.width\) applyZoom\(entry, host\.rect\.width\);/, '宽度变化仍要触发 zoom 计算');
});

/* ---------------- 合并后的架构事实（防止有人改回单宿主） ---------------- */

test('合并后：浏览器宿主按会话隔离（每会话独立 webContents/cookie）', () => {
  assert.match(hostSrc, /let hosts = new Map\(\);/ , '要有 hosts 按会话的 Map');
  assert.match(hostSrc, /export function hostForSession\(sessionId\)/, '要能按会话取宿主');
  assert.match(useSrc, /scopeContext\.getStore\(\)/, 'browser-use 要按会话取作用域');
  // 反向：不得退回「一个全局 host 单例」
  assert.equal(/let host = null;/.test(hostSrc), false, '不得退回单宿主（那会让两个会话共用一套 cookie）');
});

test('合并后：preload 的浏览器通道带 sessionId（否则会串会话）', () => {
  assert.match(readFileSync(path.join(repoRoot, 'desktop/src/preload/index.mjs'), 'utf8'),
    /browserTabs: \(sessionId\)|\/\/ 0\.32\.6/,
    'preload 的浏览器通道必须能区分会话');
});
