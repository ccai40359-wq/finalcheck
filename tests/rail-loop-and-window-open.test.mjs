// 0.32.5 P0 回归：用户这一轮报的三个问题，根因两条。
//
// ① 「还是一样 开了浏览器情况下我点不了图片」
// ② 「现在不知道为什么 巨卡无比，我切换会话，打字，巨卡」
//    → 同一个**渲染↔IPC 正反馈死循环**：
//      BrowserPane.refreshTabs 依赖 onTabsChange（父组件内联箭头，每次渲染换引用）
//      → effect 重跑 → 调 IPC → setTabs(新数组) + 父组件 setRail(新对象)
//      → App 全树重渲染 → 回调再换引用 → ……
//      循环里的闭包捕获的是旧 rail.activeKey（'browser'），所以用户点 PNG tab 之后
//      又被切回浏览器 tab（表现=「点不了图片」）；同时每轮一次 IPC 往返把主进程打满（=「巨卡」）。
//
// ③ 「我在内置浏览器页面点这些课程 没反应」
//    → browser-view-host.mjs 里 `host.onWindowOpen?.(...)` 的出口**全仓库从未赋值**，
//      window.open / target=_blank 一律被 deny 后静默丢掉。
//
// 这个文件把三条都钉住，且断言「约束」而不是「某个字面写法」（0.32.4 的教训：
// 钉死写法会在下一次重构时变成假失败，而真约束其实还成立）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  emptyRail, openRailTab, activateRailTab, setBrowserTabTitle, ensureBrowserRailTab
} from '../desktop/src/renderer/lib/rail-tabs.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paneSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/BrowserPane.jsx'), 'utf8');
const railSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/RightRail.jsx'), 'utf8');
const appSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');
const hostSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/browser-view-host.mjs'), 'utf8');
const useSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/browser-use.mjs'), 'utf8');
const ipcSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/ipc/ipc-agent.mjs'), 'utf8');

/* ---------------- ① 死循环：纯函数层（可执行断言，不是源码文本） ---------------- */

test('① setBrowserTabTitle：标题没变时返回同一引用（React 直接 bail out，循环无燃料）', () => {
  const rail = openRailTab(emptyRail(), { kind: 'browser' }).rail;
  const first = setBrowserTabTitle(rail, '小红书');
  assert.equal(first.tabs[0].payload.pageTitle, '小红书');
  // 同一个标题再来一次 → 必须是同一个对象（否则每次轮询都会触发一次 App 重渲染）
  const again = setBrowserTabTitle(first, '小红书');
  assert.equal(again, first, '标题没变必须返回同一个对象引用');
  // 前后空白差异也不算变化（网页常带尾随空格）
  const padded = setBrowserTabTitle(first, '  小红书  ');
  assert.equal(padded, first, '去空白后相同 = 不算变化');
});

test('① setBrowserTabTitle：只改标题，绝不改 activeKey（这是"点图片被切回浏览器"的根因）', () => {
  let rail = openRailTab(emptyRail(), { kind: 'artifact', artifactPath: 'D:/x/n1.png', title: 'n1.png' }).rail;
  rail = openRailTab(rail, { kind: 'browser' }).rail;
  // 用户切到图片 tab
  rail = activateRailTab(rail, 'artifact:D:/x/n1.png').rail;
  assert.equal(rail.activeKey, 'artifact:D:/x/n1.png');
  // 这时浏览器那边报告了网页标题（异步回来）
  const after = setBrowserTabTitle(rail, '哈尔滨理工大学(学生)');
  assert.equal(after.activeKey, 'artifact:D:/x/n1.png',
    '回填网页标题绝不能把用户的 tab 切走（旧写法用过期闭包的 activeKey 切回 browser）');
  assert.equal(after.tabs.find((t) => t.kind === 'browser').payload.pageTitle, '哈尔滨理工大学(学生)');
});

test('① setBrowserTabTitle：没有浏览器 tab / 空标题时安全（不造新对象）', () => {
  const onlyArtifact = openRailTab(emptyRail(), { kind: 'artifact', artifactPath: 'a.html', title: 'a.html' }).rail;
  assert.equal(setBrowserTabTitle(onlyArtifact, 'x'), onlyArtifact, '没有浏览器 tab 不该改状态');
  const rail = openRailTab(emptyRail(), { kind: 'browser' }).rail;
  assert.equal(setBrowserTabTitle(rail, ''), rail, '空标题不该写入');
  // 空状态安全：不抛错，且返回的是空右栏（每次是新对象，不比引用）
  const fromNull = setBrowserTabTitle(null, 'x');
  assert.deepEqual(fromNull, emptyRail(), '空状态返回空右栏且不抛错');
  assert.deepEqual(setBrowserTabTitle(undefined, 'x'), emptyRail());
});

/* ---------------- ① 死循环：源码约束（回调不得进依赖数组） ---------------- */

test('① BrowserPane：refreshTabs/reportRect 的依赖数组不能含父组件回调与 y', () => {
  // 取每个 useCallback 的结尾依赖数组：从声明起，到第一个 `}, [...]);`
  for (const name of ['refreshTabs', 'reportRect']) {
    const start = paneSrc.indexOf(`const ${name} = useCallback(`);
    assert.ok(start > 0, `${name} 必须用 useCallback 定义`);
    const tail = paneSrc.slice(start);
    const m = tail.match(/^[\s\S]*?\n  \}, \[([^\]]*)\]\);/);
    assert.ok(m, `${name} 必须有依赖数组（形如 "}, [...]);"）`);
    assert.equal(m[1].trim(), '', `${name} 的依赖数组必须为空（所有输入走 ref），实际是 [${m[1]}]`);
  }
  // 反例：y / visible / onTabsChange / onPageTitle / addrBusy 不得出现在依赖位置
  assert.equal(/\[y, onTabsChange\]/.test(paneSrc), false, '父组件回调不得进依赖数组');
  assert.equal(/\}, \[addrBusy\]\);/.test(paneSrc), false, 'addrBusy 不得进 refreshTabs 依赖');
});

test('① BrowserPane：标签/活动/标题都做「变了才 set」的结构比较', () => {
  assert.match(paneSrc, /const tabsKeyRef = useRef\(''\);/, '要有标签结构签名');
  assert.match(paneSrc, /if \(sig !== tabsKeyRef\.current\)/, '内容没变就不换数组引用');
  assert.match(paneSrc, /if \(nextActive !== lastActiveRef\.current\)/, '活动标签没变就不 setActiveId');
  assert.match(paneSrc, /if \(pageTitle && pageTitle !== lastTitleRef\.current\)/, '标题没变就不上抛父组件');
  assert.match(paneSrc, /setInterval\(\(\) => \{ void refreshTabs\(\); \}, 5000\);/, '轮询周期放宽到 5s');
});

test('① RightRail：浏览器 tab 只回填标题，不得调 onActivate（那是循环的一半燃料）', () => {
  // 先剥掉注释再判定——注释里写着「绝不调 onActivate」不能算违规
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/^[ \t]*\/\/[^\n]*/gm, '');   // 行注释
  const browserBlock = railSrc.match(/active\?\.kind === 'browser'[\s\S]*?<BrowserPane[\s\S]*?\/>/);
  assert.ok(browserBlock, '要能找到浏览器 tab 的渲染块');
  assert.ok(!/onActivate/.test(stripComments(browserBlock[0])),
    '浏览器 tab 渲染块里不得出现 onActivate（注释提到不算）');
  assert.match(browserBlock[0], /onPageTitle=/, '必须用只回填标题的 onPageTitle');
  assert.match(railSrc, /onPatchBrowserTitle/, 'RightRail 要接收标题回填入口');
});

test('① App：标题回填走纯函数 setBrowserTabTitle（不经过 activateRailTab）', () => {
  // 允许经过排障包装 setRailW —— 钉的是「最终落到 setBrowserTabTitle」这条语义，不是某个字面写法
  assert.ok(/onPatchBrowserTitle=\{\(title\) => (?:setRailW|setRail)\([\s\S]{0,80}setBrowserTabTitle\(cur, title\)/.test(appSrc),
    '标题回填必须走 setBrowserTabTitle（纯更新）');
  // onActivate 不再接第二个参数 patch（旧语义已删除）
  assert.ok(!/onActivate=\{\(key, patch\) =>/.test(appSrc), 'onActivate 不应再有 patch 参数');
  assert.ok(!/patch\?\.pageTitle/.test(appSrc), '旧的 pageTitle 分支必须消失');
});


test('① ensureBrowserRailTab：重复通知不抢用户正在看的 tab（这是点图片被切回浏览器的另一半根因）', () => {
  // 真实链路：点 chip 后 artifact tab 确实开出来了，但 6.5s 内 activeKind 变回 browser（S16 实测）。
  // 原因是三条通道（AI navigate / 用户输网址 / 页面 window.open）都会调 openRailTab(browser)，
  // 而它无条件把 activeKey 设成 'browser'。
  let rail = emptyRail();
  // 第一次：右栏还没有浏览器 tab → 必须开出来并切过去（用户要看见 AI 在干什么）
  rail = ensureBrowserRailTab(rail, { tabId: 'bt-1' });
  assert.equal(rail.activeKey, 'browser');
  assert.equal(rail.tabs.length, 1);
  // 用户点了 PNG chip
  rail = openRailTab(rail, { kind: 'artifact', artifactPath: 'D:/x/n1.png', title: 'n1.png' }).rail;
  rail = activateRailTab(rail, 'artifact:D:/x/n1.png').rail;
  assert.equal(rail.activeKey, 'artifact:D:/x/n1.png');
  // 这时又来一条浏览器通知（用户输网址 / AI 换页 / 页面 window.open）
  const after = ensureBrowserRailTab(rail, { tabId: 'bt-2' });
  assert.equal(after.activeKey, 'artifact:D:/x/n1.png', '已有浏览器 tab时，后续通知绝不能抢焦点');
  assert.equal(after.tabs.find((t) => t.kind === 'browser').payload.tabId, 'bt-2', '载荷仍要更新');
});

test('① ensureBrowserRailTab：空载荷不覆盖已有标题，且无变化时返回同一引用', () => {
  let rail = ensureBrowserRailTab(emptyRail(), { tabId: 'bt-1' });
  rail = setBrowserTabTitle(rail, '哈尔滨理工大学(学生)');
  // 主进程推的空 pageTitle 不能把标题清空
  const a = ensureBrowserRailTab(rail, { tabId: 'bt-1', pageTitle: '' });
  assert.equal(a, rail, '完全无变化必须返回同一引用（零重渲染）');
  assert.equal(a.tabs[0].payload.pageTitle, '哈尔滨理工大学(学生)', '空值不覆盖已有值');
  // 重复同一个 tabId 也是无变化
  assert.equal(ensureBrowserRailTab(a, { tabId: 'bt-1' }), a);
});

test('① App：三条 browser-rail-open 通道都走 ensureBrowserRailTab（不是 openRailTab）', () => {
  // 用 indexOf 计数：正则里 `{` 是量词起始符，写 /openRailTab(cur, { kind/ 直接语法错
  const needle = "openRailTab(cur, { kind: 'browser'";
  let n = 0;
  for (let i = appSrc.indexOf(needle); i >= 0; i = appSrc.indexOf(needle, i + 1)) n++;
  assert.equal(n, 0, '不得再有「无条件切到浏览器」的写法');
  let m = 0;
  const ensureNeedle = 'ensureBrowserRailTab(cur';
  for (let i = appSrc.indexOf(ensureNeedle); i >= 0; i = appSrc.indexOf(ensureNeedle, i + 1)) m++;
  assert.ok(m >= 2, `至少两处（agent-event 通道 + 用户输网址通道）要走 ensure，实际 ${m} 处`);
});

/* ---------------- ② window.open 被吞：出口必须真的有接线 ---------------- */

test('② 页面 window.open 必须有真实接线（不能靠给 ESM 命名空间赋值）', () => {
  assert.match(hostSrc, /wc\.setWindowOpenHandler/, 'host 要拦 window.open');
  assert.match(hostSrc, /host\?\.onWindowOpen\?\.\(verdict\.url, id\)/, 'host 要把 URL 交给上层');
  // 关键：必须由宿主导出的 setter 来接线。
  // 0.32.5 的教训（真人链路 S15 实测抓到）：`module.onWindowOpen = fn` 是**无效**的——
  // ESM 命名空间冻结会抛 TypeError（被 try/catch 吞掉），且被调用的是宿主内部对象。
  assert.match(hostSrc, /export function setWindowOpenSink\(fn\)/, '宿主要导出真正的 setter');
  assert.match(hostSrc, /if \(host\) host\.onWindowOpen = windowOpenSink;/, 'setter 要写到内部 host 对象');
  assert.match(hostSrc, /onWindowOpen: windowOpenSink,/, '宿主重建时要把 sink 带过去（否则重建后弹窗又失效）');
  // 上层必须真的调用这个 setter
  assert.match(useSrc, /h\.setWindowOpenSink\(\(url, fromId\) => onWindowOpenFromPage\(url, fromId\)\)/,
    'browser-use 必须调 setWindowOpenSink（这是唯一有效的接线方式）');
  assert.match(useSrc, /function onWindowOpenFromPage\(url, fromId\) \{/, '要有具体实现');
  assert.match(useSrc, /state\.host\.newTab\(\{ url: target/, 'window.open 要变成新标签');
  // 反例：不许再出现「给模块命名空间/宿主对象直接赋值」这种无效写法
  assert.equal(/h\.onWindowOpen\s*=/.test(useSrc), false, '不得直接给宿主对象赋值（要走 setter）');
  // 语义：不能把 AI 的工作目标搬走（0.32.4 定下的分离）
  assert.equal(/state\.contents = wc;[\s\S]{0,200}onWindowOpenFromPage/.test(useSrc), false,
    'window.open 不得改 AI 的工作目标');
});

test('② window.open 的新标签要能让右栏亮起来（否则用户看不见弹出的页面）', () => {
  assert.match(useSrc, /try \{ pageAttention\?\.\(\{ tabId: r\.id, url: target, openedBy: 'page' \}\); \}/,
    '开完新标签要通知 UI');
  assert.match(useSrc, /export function setPageAttentionNotifier\(fn\)/, '要暴露注入点');
  assert.match(ipcSrc, /bu\.setPageAttentionNotifier/, '主进程要注入 notifier');
  assert.match(ipcSrc, /'finalcheck:browser-rail-open', p/, 'notifier 要推既有的右栏打开事件');
});

/* ---------------- ③ 卡顿第二源：宿主侧幂等 ---------------- */

test('③ 宿主：zoom / bounds / visible 都幂等（不重复下发 = 不重复 relayout）', () => {
  assert.match(hostSrc, /if \(entry\.zoom === z\) return z;/, 'zoom 没变不得重复 setZoomFactor（那是整页 relayout）');
  assert.match(hostSrc, /if \(entry\.boundsKey === key\) return;/, 'bounds 没变不得重复 setBounds');
  assert.match(hostSrc, /if \(!entry\.showing\) \{ entry\.view\.setVisible\(true\); entry\.showing = true; \}/,
    '已经显示就不再重复 setVisible(true)');
  assert.match(hostSrc, /else if \(entry\.showing\) \{/, '已经隐藏就不再重复 setVisible(false)');
  // entry 初始 zoom 必须是 null（否则首帧 undefined !== 1 会白设一次）
  assert.match(hostSrc, /showing: false, zoom: null \}/, 'entry 的 zoom 初值要是 null');
});

test('③ 宿主：报告状态仍能反映真实 zoom（自检要能读到）', () => {
  assert.match(hostSrc, /zoom: entry\.zoom \?\? 1/, 'hostInfo 要报告生效的 zoom');
  // 回归护栏：不得因为幂等把「首次一定生效」也跳掉
  assert.match(hostSrc, /if \(host\.rect\?\.width\) applyZoom\(entry, host\.rect\.width\);/, '宽度变化仍要触发 zoom 计算');
});
