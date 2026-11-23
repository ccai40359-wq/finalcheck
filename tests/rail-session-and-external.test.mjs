// 0.32.4 P0 回归：用户这一轮报的四个真问题。
//
// ① 「我切了会话，这个右边栏还是保留，这个问题给我记好了，以后不要再犯」
//    → 右栏必须按会话隔离：切走收起、切回恢复。旧实现只清子代理 tab，注释里明写
//      「产物与浏览器 tab 留着」，于是 A 会话的网页/图片留在 B 会话的右栏上。
// ② 「我一扫码登录，跳转到我外面的浏览器了」
//    → index.mjs 的全局 web-contents-created 守卫把**所有** webContents 的 window.open /
//      will-navigate 都交给系统浏览器，内嵌浏览器的 view 也在它管辖内。
// ③ 「浏览器开着的时候，我点旁边的 png 是没反应的」
//    → 切产物 tab 只改了 tab 状态，没有按该 tab 的路径重新读产物。
// ④ 「AI 在操作浏览器时我动它，他的操作就刷新在我的页面」
//    → UI 切标签直接调 switchTabTo，把 AI 的工作目标也搬走了。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { railForSession, snapshotRail, emptyRail, openRailTab } from '../desktop/src/renderer/lib/rail-tabs.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');
const useSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/browser-use.mjs'), 'utf8');
const hostSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/browser-view-host.mjs'), 'utf8');
const indexSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/index.mjs'), 'utf8');
const ipcSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/ipc/ipc-agent.mjs'), 'utf8');
const paneSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/BrowserPane.jsx'), 'utf8');

/* ---------------- ① 右栏跟会话走 ---------------- */

test('① 右栏按会话隔离：切走存档 + 换入目标会话的右栏（不是只清子代理 tab）', () => {
  assert.match(appSrc, /const railBySessionRef = useRef\(new Map\(\)\);/, '要按会话存右栏快照');
  assert.match(appSrc, /railBySessionRef\.current\.set\(String\(prev\), snapshotRail\(railRef\.current\)\);/, '切走时存档旧会话');
  assert.match(appSrc, /setRail\(railForSession\(activeId == null \? null : railBySessionRef\.current\.get\(String\(activeId\)\)\)\);/, '切回时恢复');
  // 反例：旧写法（只清子代理 tab、其它留着）不能再出现
  assert.ok(!/setRail\(\(cur\) => pruneForSession\(cur, activeId\)\.rail\);/.test(appSrc),
    '旧的「只清子代理 tab」写法必须消失（那正是用户说"以后不要再犯"的 bug）');
});

test('① railForSession / snapshotRail：深拷贝，且空缓存返回空右栏', () => {
  const cached = { tabs: [{ key: 'browser', kind: 'browser', payload: { pageTitle: 'x' } }], activeKey: 'browser' };
  const restored = railForSession(cached);
  assert.deepEqual(restored.tabs.map((t) => t.key), ['browser']);
  // 改恢复出来的对象不能污染缓存
  restored.tabs[0].payload.pageTitle = 'changed';
  assert.equal(cached.tabs[0].payload.pageTitle, 'x', '必须是深拷贝');
  // 没存过 → 空右栏（切到新会话时右栏应当是空的）
  assert.deepEqual(railForSession(null), emptyRail());
  assert.deepEqual(railForSession(undefined), emptyRail());
  // snapshot 同样是拷贝
  const snap = snapshotRail(cached);
  snap.tabs.push({ key: 'x', kind: 'artifact', payload: {} });
  assert.equal(cached.tabs.length, 1, 'snapshot 不能改到原对象');
});

/* ---------------- ② 扫码后不能跳外部浏览器 ---------------- */

test('② 内嵌浏览器必须在创建后夺回 window.open / will-navigate 控制权', () => {
  // view host 里必须重新设置 handler（盖掉全局守卫）
  assert.match(hostSrc, /P0（用户实测：「一扫二维码登录，就跳转到我外面的浏览器了」）/, '要写明这处修复的原因');
  assert.match(hostSrc, /wc\.setWindowOpenHandler\(\(\{ url: target \}\) =>/, '要重设 window.open handler');
  assert.match(hostSrc, /wc\.__fcEmbeddedBrowser = true;/, '要打内嵌标记');
  assert.match(hostSrc, /wc\.removeListener\('will-navigate', guard\)/, '要摘掉全局守卫注册的 will-navigate');
  // http(s)/file 必须放行留在内嵌浏览器里（否则扫码后到不了成功页）
  assert.match(hostSrc, /if \(u\.protocol === 'http:' \|\| u\.protocol === 'https:' \|\| u\.protocol === 'file:'\) return; \/\/ 留在内嵌浏览器/);
});

test('② 全局守卫要把 will-navigate 监听器记下来（内嵌浏览器才能精确摘除）', () => {
  assert.match(indexSrc, /contents\.__fcNavGuard = navGuard;/, '要保存监听器引用');
  assert.match(indexSrc, /contents\.on\('will-navigate', navGuard\);/, '要用具名函数注册（匿名函数摘不掉）');
});

/* ---------------- ③ 点 PNG 标签要有反应 ---------------- */

test('③ 切到产物 tab 时必须按该 tab 的路径重新读', () => {
  assert.match(appSrc, /if \(key\.startsWith\('artifact:'\)\) \{/, '要识别产物 tab');
  assert.match(appSrc, /const p = key\.slice\('artifact:'\.length\);/, '从 key 取出路径');
  assert.match(appSrc, /if \(p && \(!artifact \|\| artifact\.path !== p\)\) void openArtifact\(p\);/, '路径不同就重读');
});

/* ---------------- ④ AI 目标 vs 用户查看 ---------------- */

test('④ UI 切标签走 viewTab（只改"看哪页"），不动 AI 的工作目标', () => {
  assert.match(useSrc, /export function viewTab\(id\) {/, '要有独立的 viewTab');
  assert.match(useSrc, /· 用户切标签 → 画面切过去（他能看、能自己点）/, '要写明语义');
  assert.match(useSrc, /· AI 的工作目标（active\.contents \/ active\.tabId）保持不变/, '要写明 AI 目标不受影响');
  // viewTab 不能改 active.contents / active.tabId
  const body = useSrc.slice(useSrc.indexOf('export function viewTab'), useSrc.indexOf('export function tabFocusInfo'));
  assert.ok(!/active\.contents =/.test(body), 'viewTab 绝不能改 AI 的页面');
  assert.ok(!/active\.tabId =/.test(body), 'viewTab 绝不能改 AI 的标签');
  // IPC 的 UI 切换必须走 viewTab，不是 switchTabTo
  const ipcBody = ipcSrc.slice(ipcSrc.indexOf("'finalcheck:browser-tab-switch'"), ipcSrc.indexOf("'finalcheck:browser-tab-focus'"));
  assert.match(ipcBody, /browserUse\?\.viewTab/, '界面切换必须走 viewTab');
  assert.ok(!/browserUse\?\.switchTabTo/.test(ipcBody), '界面切换不能再走 switchTabTo（那会夺走 AI 目标）');
});

test('④ 关标签也分情况：关 AI 的标签才换目标，关别人的不动', () => {
  const body = useSrc.slice(useSrc.indexOf('export function closeTab'), useSrc.indexOf('export function installConsoleHook'));
  assert.match(body, /const isAiTab = active\.tabId === closing;/, '要先判是不是 AI 的标签');
  assert.match(body, /if \(isAiTab\) \{\s*\n\s*if \(nextId\) return switchTabTo\(nextId\);/s, '是 AI 的才换 wc');
  assert.match(body, /return \{ ok: true, activeId: nextId, aiTab: active\.tabId \|\| null \};/, '不是 AI 的：目标不动');
});

/* ---------------- 在默认浏览器打开（唯一正当出口） ---------------- */

test('在默认浏览器打开：主进程只放行 http(s)，且只由用户主动触发', () => {
  assert.match(ipcSrc, /'finalcheck:browser-open-external'/, '要有这个通道');
  const body = ipcSrc.slice(ipcSrc.indexOf("'finalcheck:browser-open-external'"), ipcSrc.indexOf("'finalcheck:browser-tab-focus'") > 0 ? undefined : undefined);
  assert.match(ipcSrc, /if \(u\.protocol !== 'http:' && u\.protocol !== 'https:'\) return \{ ok: false, error: '只能打开 http\/https 网址' \};/, '只放行 http(s)');
  assert.match(ipcSrc, /shell\.openExternal\(u\.href\)/, '走系统浏览器');
  // UI 有对应按钮
  assert.match(paneSrc, /data-browser-external/, '自检要能定位到按钮');
  assert.match(paneSrc, /y\?\.browserOpenExternal\?\.\(url\)/, '按钮要走这条通道');
});

/* ---------------- 宽度自适配（横向完整显示） ---------------- */

test('宽度：右栏既有下限也有绝对上限，且会报告是否被截断', () => {
  assert.match(hostSrc, /export const MIN_READABLE_ZOOM = 0\.5;/, '缩放有下限（再小就看不清）');
  assert.match(hostSrc, /export function zoomForWidth\(railWidth, designWidth = DESIGN_WIDTH\) {/, '要有宽度→缩放的纯函数');
  assert.match(hostSrc, /if \(w >= designWidth\) return 1;/, '够宽就不缩');
  assert.match(hostSrc, /return Math.max\(MIN_READABLE_ZOOM, Math.min\(1, Number\(z\.toFixed\(3\)\)\)\);/, '缩放钳在 [下限, 1]');
});

test('宽度：缩放会在每次布局变化时重算（拖动/窗口缩放都跟上）', () => {
  assert.match(hostSrc, /if \(host\.rect\?\.width\) applyZoom\(entry, host\.rect\.width\);/, 'applyAllBounds 里要重算缩放');
  assert.match(hostSrc, /views\.push\(\{ id, bounds: b, showing: Boolean\(entry\.showing\), zoom: entry\.zoom \?\? 1, url: entry\.url \|\| '' \}\);/, 'hostInfo 要暴露 zoom 供自检');
});

test('宽度：zoomForWidth 的实际取值（620 宽 → 约 0.53；1280 → 1）', () => {
  // 不能直接 import browser-view-host.mjs（它 import electron，纯 Node 环境没有）。
  // 改成从源码里抽出这个纯函数求值——它本来就是"无依赖纯函数"，这么做是安全的。
  const consts = { MIN_READABLE_ZOOM: 0.5, DESIGN_WIDTH: 1180 };
  for (const line of hostSrc.split('\n')) {
    const m = line.match(/export const (MIN_READABLE_ZOOM|DESIGN_WIDTH) = (\d+(?:\.\d+)?);/);
    if (m) consts[m[1]] = Number(m[2]);
  }
  const fnBody = hostSrc.slice(
    hostSrc.indexOf('export function zoomForWidth'),
    hostSrc.indexOf('/** 把缩放应用到某个 view')
  ).replace('export function', 'function');
  // 常量要一起注入：函数签名里的默认参数 `designWidth = DESIGN_WIDTH` 需要它在作用域内
  // eslint-disable-next-line no-new-func
  const zoomForWidth = new Function(
    `const MIN_READABLE_ZOOM = ${consts.MIN_READABLE_ZOOM}; const DESIGN_WIDTH = ${consts.DESIGN_WIDTH};`
    + `${fnBody}; return zoomForWidth;`
  )();

  assert.equal(zoomForWidth(1280), 1, '够宽不缩');
  assert.equal(zoomForWidth(1600), 1, '更宽也不放大（1 是上限）');
  const z620 = zoomForWidth(620);
  assert.ok(z620 > consts.MIN_READABLE_ZOOM && z620 < 1, `620 宽应有可读缩放，实际 ${z620}`);
  assert.ok(Math.abs(z620 - 620 / consts.DESIGN_WIDTH) < 0.002, '按设计宽度等比缩放');
  // 极窄时钳在下限（宁可让用户拖宽，也不能把字缩到看不清）
  assert.equal(zoomForWidth(200), consts.MIN_READABLE_ZOOM);
  assert.equal(zoomForWidth(0), 1, '没有宽度信息时不缩');
});
