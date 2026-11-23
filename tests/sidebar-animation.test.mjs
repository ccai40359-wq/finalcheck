// 侧栏折叠动画：要顺滑，但不能重演「玻璃动画每帧重合成」的性能事故。
//
// 本仓踩过的坑（记在 styles.css 的注释里）：.app-ambient 全屏渐变 + 32s 无限动画，
// 压在 backdrop-filter 玻璃下面，导致整棵树每帧重新合成，GPU 进程稳定吃 11% CPU。
// 所以这次侧栏折叠的硬约束是：
//   ① 只过渡 width（不碰 left/margin/padding 这些触发布局的属性）
//   ② 动画进行中临时去掉 backdrop-filter（结束立刻恢复）
//   ③ 折叠完成后清掉 will-change，不让它常驻一个合成图层
//   ④ 内层固定 212px，宽度收到 0 时是「裁切」而不是「挤压」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const css = readFileSync(path.join(repoRoot, 'desktop/src/renderer/styles.css'), 'utf8');
const sidebar = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/Sidebar.jsx'), 'utf8');
const app = readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');

test('只过渡 width（不碰 left/margin/padding，避免每帧触发布局）', () => {
  assert.match(css, /\.fc-sidebar \{\s*transition: width 220ms var\(--fc-ease\);/, '必须是 width 过渡');
  // 这条规则块里不该出现 margin/left/padding 的过渡
  const block = css.slice(css.indexOf('.fc-sidebar {'), css.indexOf('.fc-sidebar-inner'));
  assert.ok(!/transition:[^;]*(margin|left|padding|top)/.test(block), '不要过渡布局属性');
});

test('动画期去掉 backdrop-filter，结束后恢复（不是永久去掉）', () => {
  assert.match(css, /\.fc-sidebar\.fc-sidebar-animating \{[\s\S]{0,160}backdrop-filter: none !important;/);
  // 只在 animating 类下才有这条覆盖，静态时不生效
  assert.ok(css.indexOf('fc-sidebar-animating') > css.indexOf('.fc-sidebar {'));
});

test('折叠完成后不常驻 will-change（省一个合成图层）', () => {
  assert.match(css, /\.fc-sidebar\.fc-sidebar-collapsed \{[\s\S]{0,120}will-change: auto;/);
});

test('内层固定 212px：收窄是裁切，不挤压内容', () => {
  assert.match(css, /\.fc-sidebar-inner \{ width: 212px; \}/);
  assert.match(sidebar, /className="w-\[212px\] flex flex-col flex-1 min-h-0 fc-sidebar-inner"/);
});

test('尊重 prefers-reduced-motion：直接跳变', () => {
  const tail = css.slice(css.indexOf('.fc-sidebar {'));
  assert.match(tail, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}\.fc-sidebar \{ transition: none; \}/);
});

test('animating 类靠 transitionend + 兜底计时器收尾（reduced-motion 下 transitionend 不触发）', () => {
  assert.match(sidebar, /addEventListener\('transitionend', onEnd\)/);
  assert.match(sidebar, /setTimeout\(stop, 280\)/, '缺少兜底计时器');
  assert.match(sidebar, /if \(done\) return;/, '收尾必须幂等（transitionend 与计时器会撞）');
});

test('首次挂载不播动画（避免启动时侧栏从 0 滑入）', () => {
  assert.match(sidebar, /firstRef\.current/, '需要跳过首次');
  assert.match(sidebar, /if \(firstRef\.current\) \{ firstRef\.current = false; return; \}/);
});

test('侧栏始终挂载（折叠不卸载：卸载会丢滚动位置与展开状态，也没法做过渡）', () => {
  assert.match(app, /page === 'chat' && <Sidebar/, '侧栏必须常驻');
  assert.match(app, /collapsed=\{sidebarCollapsed\}/);
  assert.ok(!/page === 'chat' && !sidebarCollapsed && <Sidebar/.test(app), '不该再按 collapsed 卸载');
});

test('右栏宽度跟随侧栏真实像素（ResizeObserver），不是折叠布尔值', () => {
  assert.match(app, /ResizeObserver/, '缺少尺寸观察');
  assert.match(app, /querySelector\('.fc-sidebar'\)/, '应按类名取侧栏根节点');
  assert.match(app, /sidebarWidth=\{sidebarPx\}/, '右栏要收真实宽度');
  // 0.32.0：右栏统一成 RightRail 多标签容器（原先是 ArtifactPanel + SubagentPanel 两处）
  const n = (app.match(/sidebarWidth=\{sidebarPx\}/g) || []).length;
  assert.equal(n, 1, '右栏只有一个容器（RightRail），它收真实像素宽度');
});

test('折叠时可被辅助技术忽略（aria-hidden + inert）', () => {
  assert.match(sidebar, /aria-hidden=\{collapsed\}/);
  assert.match(sidebar, /inert=\{collapsed/);
});
