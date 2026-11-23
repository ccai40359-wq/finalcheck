// 会话侧栏折叠开关：做在标题栏 FC logo 上（用户定案）
//
// 需求（2026-11-19）：左上角 FC logo 位置就是「隐藏/显示侧栏」按钮，
// 鼠标悬停时 logo 变成侧栏图标（参考样式：灰底圆角 + 竖向分隔 + 箭头）。
// 不额外占标题栏空间，也不多加一个按钮。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const titleBar = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/TitleBar.jsx'), 'utf8');
const app = readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');
const enApp = readFileSync(path.join(repoRoot, 'desktop/src/renderer/i18n/en/app.js'), 'utf8');

test('侧栏开关按钮就在 FC logo 位置（同一个 button）', () => {
  assert.match(titleBar, /data-ui="sidebar-toggle"/);
  // 按钮内含 FC 常态字 + 侧栏图标的悬停态
  assert.match(titleBar, />FC<\/span>/, '按钮里要有 FC 常态');
  assert.match(titleBar, /<IconSidebarToggle collapsed=\{sidebarCollapsed\} \/>/);
});

test('悬停才换成侧栏图标（常态 FC 可见、图标隐藏）', () => {
  // FC 常态：默认 opacity 1，hover 时 0
  assert.match(titleBar, /group-hover\/logo:opacity-0/, 'FC 悬停应淡出');
  // 图标态：默认 opacity-0，hover 时 100
  assert.match(titleBar, /text-mute opacity-0 group-hover\/logo:text-ink group-hover\/logo:opacity-100/);
});

test('图标形态对齐参考：竖向分隔线 + 箭头（收起/展开两个方向）', () => {
  assert.match(titleBar, /<line x1="8\.5" y1="4" x2="8\.5" y2="20" \/>/, '缺少竖向分隔线');
  assert.match(titleBar, /collapsed\s*\?.*M15\.5 10\.5.*:.*M11\.5 10\.5/s, '缺少收/展两向箭头');
});

test('无障碍：aria-expanded 反映折叠状态，title 说明动作', () => {
  assert.match(titleBar, /aria-expanded=\{!sidebarCollapsed\}/);
  assert.match(titleBar, /sidebarCollapsed \? t\('展开会话侧栏'\) : t\('收起会话侧栏'\)/);
  assert.match(titleBar, /aria-label=\{sidebarCollapsed \? t\('展开会话侧栏'\) : t\('收起会话侧栏'\)\}/);
});

test('标题栏按钮不抢拖拽区（WebkitAppRegion: no-drag）', () => {
  const btn = titleBar.slice(titleBar.indexOf('data-ui="sidebar-toggle"') - 600, titleBar.indexOf('data-ui="sidebar-toggle"') + 400);
  assert.match(btn, /WebkitAppRegion: 'no-drag'/, 'logo 按钮必须可从拖拽区排除，否则点不动');
});

test('App：折叠状态持久化到 localStorage，侧栏常驻但宽度收到 0', () => {
  assert.match(app, /localStorage\.getItem\('fc\.sidebarCollapsed'\) === '1'/, '读取持久化状态');
  assert.match(app, /localStorage\.setItem\('fc\.sidebarCollapsed'/);
  // 0.27 起改成「始终挂载 + 宽度过渡」：卸载会让主区瞬间跳 212px、且丢失滚动位置
  assert.match(app, /page === 'chat' && <Sidebar/, '侧栏始终挂载');
  assert.match(app, /collapsed=\{sidebarCollapsed\}/, '折叠通过 prop 传给侧栏');
  assert.match(app, /sidebarCollapsed=\{sidebarCollapsed\} onToggleSidebar=\{toggleSidebar\}/, 'TitleBar 没接开关');
});

test('App：右栏宽度计算跟随侧栏真实像素（过渡期间也不跳）', () => {
  assert.match(app, /sidebarWidth=\{sidebarPx\}/, '应传实时像素宽度，而不是折叠布尔值');
  // 0.32.0：右栏统一成 RightRail（原先是 ArtifactPanel + SubagentPanel 两处传参）
  const n = (app.match(/sidebarWidth=\{sidebarPx\}/g) || []).length;
  assert.equal(n, 1, '右栏只有一个容器（RightRail），它收真实像素宽度');
  assert.match(app, /ResizeObserver/, '靠 ResizeObserver 跟随过渡中的实际宽度');
});

test('两个面板接收 sidebarWidth 并传给布局函数', () => {
  for (const file of ['chat/ArtifactPanel.jsx', 'chat/SubagentPanel.jsx']) {
    const src = readFileSync(path.join(repoRoot, 'desktop/src/renderer', file), 'utf8');
    assert.match(src, /sidebarWidth = 212/, `${file} 缺默认值`);
    assert.match(src, /planPanelLayout\(\{ windowWidth: winW, desiredWidth: width, sidebar: sidebarWidth \}\)/, `${file} 没把侧栏宽度传给布局`);
  }
});

test('新增文案都有英文词条', () => {
  assert.match(enApp, /'收起会话侧栏': 'Hide the session sidebar'/);
  assert.match(enApp, /'展开会话侧栏': 'Show the session sidebar'/);
});
