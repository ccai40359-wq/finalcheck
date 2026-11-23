// 0.32.1/0.32.3：内嵌浏览器的「画面必须跟着 UI 走」——这条约束是用户报的两个 bug 的同一根因。
//
// 用户实测两次：
//   ① 「我还不能点浏览器 tab 左边的这个图片了，就是我现在被锁住了一样」
//      → 切到产物 tab 后，网页那张 WebContentsView 仍盖在原位，下面的图片标签点不动。
//   ② 「你又犯错误了…页面不是只存在那个对话的」（截图：设置页右边压着小红书）
//      → 切到设置页时右栏卸载了，但 WebContentsView 画在主窗口上，不会随 React 卸载消失。
//
// 两个都是同一个物理事实：**WebContentsView 是主窗口上的原生视图，不是 DOM**。
// 所以任何「右栏不该显示浏览器」的状态，都必须显式通知主进程 setVisible(false)。
// 这个文件把三类触发点都钉住：面板卸载、切到其它 tab、切到其它视图（设置/用量）、折叠。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paneSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/BrowserPane.jsx'), 'utf8');
const railSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/RightRail.jsx'), 'utf8');
const appSrc = readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');
const hostSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/browser-view-host.mjs'), 'utf8');

test('隐藏约束: BrowserPane 卸载时必须通知主进程隐藏（"锁住"与"盖住设置页"的根因）', () => {
  // 必须存在一个「只跑清理」的 effect（依赖数组为空 / 返回 cleanup 函数）
  assert.match(paneSrc, /useEffect\(\(\) => \(\) => \{ void yRef\.current\?\.railVisible\?\.\(false\); \}, \[\]\);/,
    '卸载清理必须调 railVisible(false)，且用 ref 避免依赖变化提前触发');
  assert.match(paneSrc, /const yRef = useRef\(y\);/,
    '用 ref 存 y：否则 y 变化会提前清理一次，卸载时才真清理');
});

test('隐藏约束: 面板不可见时（切到别的 tab）立刻隐藏', () => {
  assert.match(paneSrc, /if \(!visible\) void y\?\.railVisible\?\.\(false\);|if \(!visible\) \{ void y\?\.railVisible\?\.\(false\); \}/,
    'visible=false 时必须调隐藏');
});

test('隐藏约束: App 层兜底 —— 任何「右栏不该显示浏览器」的状态都强制隐藏', () => {
  assert.match(appSrc, /const railBrowserShowing = Boolean\(activeRailTab\(rail\) && activeRailTab\(rail\)\.kind === 'browser'\)\s*\n\s*&& page === 'chat' && !railCollapsed;/,
    '判据必须同时覆盖：活动 tab 是浏览器 + 在聊天视图 + 未折叠');
  assert.match(appSrc, /if \(railBrowserShowing\) return;\s*\n\s*void y\?\.railVisible\?\.\(false\);/,
    '不满足就隐藏——切设置页/折叠/切 tab 全走这一道');
});

test('隐藏约束: 折叠态与动画期间画面都必须隐藏（不能留着网页盖住对话区）', () => {
  // 0.32.4：折叠改成"同一棵 DOM 变窄 + 过渡"，判据也要覆盖动画窗口——
  // 原生层跟不上逐帧动画，动画中必须藏起来，否则会看到画面抖动拖影。
  assert.match(railSrc, /const browserVisible = Boolean\(active && active\.kind === 'browser'\) && !collapsed && !animating;/,
    '折叠或被折叠/展开动画中，browserVisible 必须为 false');
  assert.match(railSrc, /const \[animating, setAnimating\] = useState\(false\);/,
    '必须有动画窗口状态');
});

test('宿主: rect 无效 / 不可见时宁可不显示（避免画到错位置）', () => {
  assert.match(hostSrc, /if \(width <= 0 \|\| height <= 0\) return null;/);
  assert.match(hostSrc, /if \(!r\) \{\s*\n\s*host\.rect = null;/,
    'rect 无效时要清空并隐藏');
  assert.match(hostSrc, /const shouldShow = host\.visible && Boolean\(host\.rect\) && id === active;/,
    '三者同时成立才显示：可见性 + rect + 是活动标签');
});
