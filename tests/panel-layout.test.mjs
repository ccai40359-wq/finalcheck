// 右栏宽度：始终并排，但绝不把正文压没。
//
// 用户实机（2026-11-19）：1010px 窗口打开产物预览，右栏按「窗口 72%」能占 727px，
// 侧栏 212，正文只剩 71px——主区整个消失。
// 用户明确否决了浮层/抽屉/遮罩方案（遮罩会盖住正文、中间滑不动）。
// 定案：保持并排，只收缩右栏，给正文留出可用空间。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  SIDEBAR_WIDTH, MIN_MAIN_WIDTH, MIN_PANEL_WIDTH, CLOSE_AT,
  maxRailWidth, planPanelLayout, clampPanelWidth, shouldClosePanel
} from '../desktop/src/renderer/lib/panel-layout.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('panel-layout: 用户实机场景 —— 1010 窗口 + 期望 560 右栏，正文必须留够', () => {
  const r = planPanelLayout({ windowWidth: 1010, desiredWidth: 560 });
  const available = 1010 - SIDEBAR_WIDTH; // 798
  assert.equal(r.mode, 'rail', '必须并排（用户否决浮层）');
  assert.ok(available - r.width >= MIN_MAIN_WIDTH, `正文 ${available - r.width} 应 ≥ ${MIN_MAIN_WIDTH}`);
  assert.equal(r.width, maxRailWidth(1010), '收缩到上限');
});

test('panel-layout: 旧逻辑的 72% 上限在 1010 窗口是 727px —— 现在不可能', () => {
  assert.equal(Math.round(1010 * 0.72), 727, '旧上限');
  const r = planPanelLayout({ windowWidth: 1010, desiredWidth: 727 });
  assert.ok(r.width < 727, `实际 ${r.width}，绝不会给到 727`);
  assert.ok(1010 - SIDEBAR_WIDTH - r.width >= MIN_MAIN_WIDTH);
});

test('panel-layout: 宽窗口下期望宽度照常满足', () => {
  assert.equal(planPanelLayout({ windowWidth: 1920, desiredWidth: 560 }).width, 560);
  assert.equal(planPanelLayout({ windowWidth: 1600, desiredWidth: 560 }).width, 560);
  assert.equal(planPanelLayout({ windowWidth: 1440, desiredWidth: 400 }).width, 400);
});

test('panel-layout: 窗口太小连 MIN_PANEL_WIDTH 都给不出时，两边对半分', () => {
  // 700 − 212 = 488；maxRail = 488 − 420 = 68 < 300 → 对半 244
  const r = planPanelLayout({ windowWidth: 700, desiredWidth: 500 });
  assert.equal(r.mode, 'rail');
  assert.equal(r.width, Math.round((700 - SIDEBAR_WIDTH) / 2));
});

test('panel-layout: maxRailWidth = 窗口 − 侧栏 − 正文最小宽', () => {
  assert.equal(maxRailWidth(1010), 1010 - SIDEBAR_WIDTH - MIN_MAIN_WIDTH); // 378
  assert.equal(maxRailWidth(1920), 1920 - SIDEBAR_WIDTH - MIN_MAIN_WIDTH); // 1288
  assert.equal(maxRailWidth(600), 0);
});

test('panel-layout: 穷举 —— 任何窗口下正文都不会少于 MIN_MAIN_WIDTH（除非窗口本身放不下）', () => {
  for (const win of [1010, 1100, 1280, 1366, 1440, 1600, 1920, 2560]) {
    for (const want of [300, 400, 560, 700, 900, 1200]) {
      const r = planPanelLayout({ windowWidth: win, desiredWidth: want });
      const available = win - SIDEBAR_WIDTH;
      const mainW = available - r.width;
      assert.ok(mainW >= MIN_MAIN_WIDTH, `win=${win} want=${want} → 正文 ${mainW} < ${MIN_MAIN_WIDTH}`);
    }
  }
});

test('panel-layout: clamp 与 shouldClosePanel', () => {
  assert.equal(clampPanelWidth({ windowWidth: 1010, width: 9999 }), maxRailWidth(1010));
  assert.equal(clampPanelWidth({ windowWidth: 1010, width: 0 }), 0);
  assert.equal(shouldClosePanel(200), true);
  assert.equal(shouldClosePanel(CLOSE_AT), false);
  assert.equal(shouldClosePanel(400), false);
});

// ---------------------------------------------------------------- 接线检查

test('panel: 两个面板都是纯并排（没有浮层、没有遮罩、没有 absolute 抽屉）', () => {
  for (const file of ['chat/ArtifactPanel.jsx', 'chat/SubagentPanel.jsx']) {
    const src = readFileSync(path.join(repoRoot, 'desktop/src/renderer', file), 'utf8');
    assert.match(src, /planPanelLayout/, `${file} 没接布局策略`);
    assert.match(src, /data-panel-mode="rail"/, `${file} 应为并排`);
    assert.ok(!/data-panel-scrim/.test(src), `${file} 不该再有遮罩（用户否决浮层）`);
    assert.ok(!/absolute right-0 top-2 bottom-2/.test(src), `${file} 不该再有抽屉定位`);
    assert.ok(!/isSheet/.test(src), `${file} 不该再有 isSheet 分支`);
    assert.ok(!/window\.innerWidth \* 0\.72/.test(src), `${file} 还在用旧的 72% 上限`);
    assert.match(src, /shouldClosePanel/, `${file} 拖到头关闭没走统一判定`);
  }
});
