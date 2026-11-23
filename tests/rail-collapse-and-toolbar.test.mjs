// 0.32.3：右栏折叠 + 浏览器工具条修正的行为测试。
//
// 用户报的三个交互 bug：
//   ① 「为什么我浏览器这个 tap 的这个加号点了没用」 —— 以前 openBlank 只清空地址栏，什么都没发生；
//      而且 openTab() 要求 URL 非空（assertNavigableUrl 直接抛），空白标签根本开不出来。
//   ② 「左边的这个圈和右边的 open 啥意思，能不能只保留浏览器的 refresh 那个圈」 ——
//      那个圈只刷新**标签列表**（用户零感知），右边 Open 与回车重复。
//   ③ 「给右边栏做个这个，可以折叠，如果只有一个 × 那不方便」 —— 之前只有 ✕（清空所有标签），
//      没有"收起来但内容还在"的操作。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paneSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/BrowserPane.jsx'), 'utf8');
const railSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/RightRail.jsx'), 'utf8');
const appSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');
const useSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/browser-use.mjs'), 'utf8');

/* ---------------- ① 加号：真开空白标签 ---------------- */

test('加号: 点了要真的开一个新标签（不是只清地址栏）', () => {
  const body = paneSrc.slice(paneSrc.indexOf('const openBlank'), paneSrc.indexOf('const reloadPage'));
  assert.match(body, /await y\?\.browserTabOpen\?\.\(/, '必须真的调开标签的 IPC');
  assert.ok(!/^[\s\S]*?setAddr\(''\);[\s\S]*?setNote\(''\);[\s\S]*?};\s*/m.test(body.replace(/browserTabOpen[\s\S]*/, '')),
    '不能只是清空地址栏就结束');
  assert.match(body, /addrRef\.current\?\.focus\(\)/, '开完空白页要把焦点给地址栏（否则用户还得自己点）');
});

test('加号: 主进程允许空 URL 开空白标签（以前 assertNavigableUrl 会直接抛）', () => {
  const body = useSrc.slice(useSrc.indexOf('export async function openTab'), useSrc.indexOf('export function switchTabTo'));
  assert.match(body, /const raw = String\(url \?\? ''\)\.trim\(\);/, '先把空值归一');
  assert.match(body, /if \(raw\) \{/, '只有给了 URL 才校验——空串要放行');
  assert.match(body, /let target = '';/, '空串就是空白页');
  // 关键：assertNavigableUrl 必须只在 if (raw) 里面调用（不能在函数开头无条件调）
  const assertCallIdx = body.indexOf('assertNavigableUrl(raw)');
  const ifRawIdx = body.indexOf('if (raw) {');
  assert.ok(assertCallIdx > ifRawIdx, 'assertNavigableUrl 必须在 if (raw) 分支内（否则空串直接抛）');
  assert.match(body, /return \{ ok: true, id: r\.id, tab: r\.tab, blank: !target \};/, '返回值要标明是空白标签');
});

/* ---------------- ② 那个圈 / Open 按钮 ---------------- */

test('刷新圈: 改成真正的「重新加载当前网页」（以前只刷新标签列表，用户零感知）', () => {
  const body = paneSrc.slice(paneSrc.indexOf('const reloadPage'), paneSrc.indexOf('if (!visible) return null'));
  assert.match(body, /const cur = tabs\.find\(\(x\) => x\.id === activeId\);/, '要针对当前活动网页');
  assert.match(body, /await y\?\.browserGoto\?\.\(cur\.url\)/, '真正的重新加载 = 再导航一次同一个 URL');
  // 按钮必须接到 reloadPage，且有独立标记便于自检
  assert.match(paneSrc, /onClick=\{\(\) => \{ void reloadPage\(\); \}\} title=\{t\('重新加载当前网页'\)\}/);
  assert.match(paneSrc, /data-browser-reload/, '自检要能定位到这个按钮');
});

test('地址栏: 去掉 Open 按钮（回车即打开，按钮与其重复且挤占宽度）', () => {
  assert.ok(!/\) : t\('打开'\)\}/.test(paneSrc), '不应再有"打开"按钮的文案分支');
  assert.ok(!/onClick=\{\(\) => void goto\(\)\}/.test(paneSrc), '不应再有独立的打开按钮');
  // 回车仍然要能打开
  assert.match(paneSrc, /if \(e\.key === 'Enter'\) \{ e\.preventDefault\(\); void goto\(\); \}/);
});

/* ---------------- ③ 折叠 ---------------- */

test('折叠: 有独立的折叠按钮（图标，与 TitleBar 侧栏图标同一套语言）', () => {
  assert.match(railSrc, /function IconRailToggle\(\{ collapsed \}\)/, '折叠图标组件要有');
  assert.match(railSrc, /<rect x="2\.5" y="4" width="19" height="16" rx="2\.5" \/>/, '外框');
  assert.match(railSrc, /onClick=\{\(\) => onToggleCollapsed\?\.\(true\)\}/, '折叠入口');
  assert.match(railSrc, /onClick=\{\(\) => onToggleCollapsed\?\.\(false\)\}/, '展开入口（窄条上）');
});

test('折叠: 折叠后是窄竖条，且内容（标签）仍在——不是清空', () => {
  // 0.32.4：折叠改成"同一棵 DOM 变窄 + 交叉淡入淡出"（不再换 DOM 树，否则宽度过渡不生效）
  assert.match(railSrc, /const collapsedW = 38;/, '折叠态宽度 38（刚够放 32px 图标按钮）');
  assert.match(railSrc, /const railWidth = collapsed \? collapsedW : expandedW;/, '宽度按折叠态切换');
  assert.match(railSrc, /transition: 'width 200ms cubic-bezier\(\.4,0,\.2,1\)'/,
    '宽度必须走 transition（以前是两棵 DOM 硬切，实测 12 帧采样只有 1 个宽度值）');
  // 折叠态仍有标签图标（点了先展开再切过去）
  assert.match(railSrc, /onToggleCollapsed\?\.\(false\); onActivate\?\.\(tab\.key\);/, '折叠态点标签 = 展开 + 切过去');
  // 折叠态内容不被卸载（只是淡出），这样标签与面板状态都保留
  assert.match(railSrc, /aria-hidden=\{collapsed\}/, '折叠态用 aria-hidden 而非卸载');
  assert.match(railSrc, /collapsed \? 'opacity-0 pointer-events-none' : 'opacity-100'/, '展开态内容折叠时淡出+禁交互');
});

test('折叠: 与 ✕（清空所有标签）是两个分开的操作，且用分隔线隔开（避免误点）', () => {
  assert.match(railSrc, /title=\{t\('折叠右栏（内容保留，随时展开）'\)\}/, '折叠按钮要说清"内容保留"');
  assert.match(railSrc, /title=\{t\('关闭右栏（清空所有标签）'\)\}/, '✕ 要说清是清空');
  assert.match(railSrc, /className="ml-auto shrink-0 self-center flex items-center gap-0\.5 pl-1 border-l border-edge\/50"/,
    '两个按钮要有分隔线与左边隔开');
});

test('折叠: 状态持久化（重开 FC 还是折叠着的）', () => {
  assert.match(appSrc, /localStorage\.getItem\('fc\.railCollapsed'\) === '1'/, '读回');
  assert.match(appSrc, /localStorage\.setItem\('fc\.railCollapsed', railCollapsed \? '1' : '0'\)/, '写回');
});

test('折叠: 传给 RightRail 的两个 prop 都接上了', () => {
  assert.match(appSrc, /<RightRail\s*\n\s*rail=\{rail\}\s*\n\s*collapsed=\{railCollapsed\}\s*\n\s*onToggleCollapsed=\{setRailCollapsed\}/,
    'App 必须把折叠状态与切换回调传下去');
});
