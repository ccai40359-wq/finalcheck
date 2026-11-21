// WF3（2026-11-21）：Sidebar 行红绿点 → 金色 Update 按钮。
// 旧态：红点=有新版本（update-event available）、绿点=IPC 桥存活。
// 新态：绿点删除（Settings 页已有等效断连提示：App 全局琥珀横幅 + SettingsPage 卡片 ErrorNote）；
// 红点改为金色「Update v{version}」按钮，只在有更新时渲染，点击走既有下载/安装流程，
// 状态跟随既有 update 事件；不许 openExternal（updater-state.mjs 红线：不硬编码 owner/repo）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  SIDEBAR_UPDATE_INITIAL,
  reduceSidebarUpdateEvent,
  sidebarUpdateButton
} from '../desktop/src/renderer/lib/sidebar-update.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sidebar = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/Sidebar.jsx'), 'utf8');
const app = readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');
const ipcUpdater = readFileSync(path.join(repoRoot, 'desktop/src/main/ipc/ipc-updater.mjs'), 'utf8');

test('两态直测：无 updateVersion → 按钮不渲染', () => {
  assert.equal(sidebarUpdateButton(SIDEBAR_UPDATE_INITIAL).visible, false, '初始态（无更新）不渲染');
  assert.equal(sidebarUpdateButton(null).visible, false, '畸形输入按无更新处理');
  assert.equal(sidebarUpdateButton({ version: '', phase: 'downloaded' }).visible, false, 'version 空 = 无更新');
  assert.equal(sidebarUpdateButton({ version: 'v0.29.4', phase: 'not-available' }).visible, false,
    'not-available 事件清空 version → 不渲染（reduce 里已归零，这里兜底防畸形状态）');
});

test('两态直测：有 updateVersion → 金色按钮「Update v{v}」，点击触发下载', () => {
  const view = sidebarUpdateButton({ version: '0.29.4', phase: 'available' });
  assert.equal(view.visible, true);
  assert.equal(view.action, 'download');
  assert.equal(view.disabled, false);
  assert.equal(view.labelKey, 'Update v{v}');
  assert.deepEqual(view.params, { v: '0.29.4' }, '按钮文案 Update v0.29.4（Sidebar 里 t() 渲染）');
  // 旧红点必须不复存在
  assert.ok(!/bg-red-400/.test(sidebar), 'Settings 行红点已删除');
});

test('状态机：available → 设版本与按钮态；not-available → 归零（无更新=按钮消失）', () => {
  const s1 = reduceSidebarUpdateEvent(SIDEBAR_UPDATE_INITIAL, { type: 'available', version: 'v0.30.0' });
  assert.deepEqual(s1, { version: '0.30.0', phase: 'available', percent: null });
  assert.equal(sidebarUpdateButton(s1).action, 'download');
  const s2 = reduceSidebarUpdateEvent(s1, { type: 'not-available', version: '0.29.3' });
  assert.deepEqual(s2, SIDEBAR_UPDATE_INITIAL);
  assert.equal(sidebarUpdateButton(s2).visible, false);
});

test('状态机：progress → downloading + 百分比；downloaded → 重启安装；error → 回可下载态', () => {
  const avail = reduceSidebarUpdateEvent(SIDEBAR_UPDATE_INITIAL, { type: 'available', version: '0.30.0' });
  const dl = reduceSidebarUpdateEvent(avail, { type: 'progress', percent: 37.4 });
  assert.deepEqual(dl, { version: '0.30.0', phase: 'downloading', percent: 37 });
  const btn = sidebarUpdateButton(dl);
  assert.equal(btn.disabled, true, '下载中禁点');
  assert.equal(btn.action, null, '下载中没有可触发的动作');
  assert.equal(btn.labelKey, '下载中 {percent}%');

  const done = reduceSidebarUpdateEvent(dl, { type: 'downloaded', version: '0.30.0' });
  assert.deepEqual(done, { version: '0.30.0', phase: 'downloaded', percent: 100 });
  const installBtn = sidebarUpdateButton(done);
  assert.equal(installBtn.action, 'install', '已下载 → 点击走重启安装');
  assert.equal(installBtn.labelKey, '重启并安装');

  // 下载失败回到「Update v{v}」可重试
  const retry = reduceSidebarUpdateEvent(dl, { type: 'error', message: '网络中断' });
  assert.equal(retry.phase, 'available');
  assert.equal(sidebarUpdateButton(retry).action, 'download');
  // 静默检查期的 error（非 downloading 态）不动按钮
  const untouched = reduceSidebarUpdateEvent(avail, { type: 'error', message: 'x' });
  assert.deepEqual(untouched, avail);
});

test('状态机：畸形/无关事件保持原状态（progress 只在下载期生效）', () => {
  const avail = reduceSidebarUpdateEvent(SIDEBAR_UPDATE_INITIAL, { type: 'available', version: '0.30.0' });
  assert.deepEqual(reduceSidebarUpdateEvent(avail, { type: 'checking' }), avail, 'checking 不动按钮');
  assert.deepEqual(reduceSidebarUpdateEvent(avail, null), avail, '畸形事件保持原状态');
  assert.deepEqual(reduceSidebarUpdateEvent(avail, { type: 'progress', percent: 50 }),
    { version: '0.30.0', phase: 'downloading', percent: 50 });
  // 非下载期收到 progress（理论上不该发生）不改状态
  assert.deepEqual(reduceSidebarUpdateEvent(SIDEBAR_UPDATE_INITIAL, { type: 'progress', percent: 50 }), SIDEBAR_UPDATE_INITIAL);
});

test('Sidebar.jsx：绿点删除（IPC 提示不静默消失 → Settings 页有等效提示），按钮组件接线', () => {
  assert.ok(!sidebar.includes('IPC 已连接'), '绿点（IPC 存活）已删除');
  assert.ok(!sidebar.includes('IPC 不可用'), '底部绿点的断连提示已随点删除');
  assert.match(sidebar, /<SidebarUpdateButton state=\{sidebarUpdate\} onAction=\{onUpdateAction\} \/>/);
  assert.match(sidebar, /sidebarUpdateButton\(state\)/, '按钮视图模型走纯函数');
  assert.match(sidebar, /function SidebarUpdateButton/, '金色按钮组件');
  assert.match(sidebar, /bg-gold\/\[0\.14\]/, '按钮用应用现有金色 accent');
  assert.match(sidebar, /onAction\?\.\(view\.action\)/, '点击只触发 App 传入的既有流程');
  // App.jsx:1723 的全局琥珀横幅在 Settings 页同样渲染（main 内、页面条件外）——绿点提示的等效去处
  assert.match(app, /请在 Electron 中运行：当前未检测到 window\.finalcheck（浏览器直开），仅展示 UI 壳，功能不可用。/);
});

test('App.jsx：接线既有 IPC（update:download / update:install），状态机走纯函数，事件链不新增协议', () => {
  assert.match(app, /import \{ SIDEBAR_UPDATE_INITIAL, reduceSidebarUpdateEvent \} from '\.\/lib\/sidebar-update\.mjs';/);
  assert.match(app, /useState\(SIDEBAR_UPDATE_INITIAL\)/, '初始无更新 → 按钮不渲染');
  assert.match(app, /onUpdateEvent\(\(ev\) => \{[\s\S]*?reduceSidebarUpdateEvent\(prev, ev\)/, '跟随既有 update 事件');
  assert.match(app, /sidebarUpdate=\{sidebarUpdate\} onUpdateAction=\{handleSidebarUpdateAction\}/, 'Sidebar 接线');
  assert.match(app, /y\.updateDownload\(\)/, '点击下载走既有 finalcheck:update:download 封装');
  assert.match(app, /y\.updateInstall\(\)/, '重启安装走既有 finalcheck:update:install 封装');
  assert.ok(!/shell\.openExternal|openExternal\(/.test(app), '不许 openExternal 打开 release 页（不硬编码 owner/repo）');
});

test('回归红线：ipc-updater.mjs 的静默检查节奏与 autoDownload=false 一律不改', () => {
  assert.match(ipcUpdater, /const UPDATE_FIRST_CHECK_DELAY = 10 \* 1000;/, '启动 10s 静默检查');
  assert.match(ipcUpdater, /const UPDATE_CHECK_INTERVAL = 6 \* 60 \* 60 \* 1000;/, '6 小时间隔');
  assert.match(ipcUpdater, /au\.autoDownload = false;/, '发现更新只提示，用户点「下载更新」才下载');
});
