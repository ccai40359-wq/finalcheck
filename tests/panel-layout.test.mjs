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
  SIDEBAR_WIDTH, MIN_MAIN_WIDTH, CLOSE_AT, MAX_PANEL_WIDTH,
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

test('panel-layout: maxRailWidth = 窗口 − 侧栏 − 正文最小宽，且不超过绝对上限', () => {
  assert.equal(maxRailWidth(1010), 1010 - SIDEBAR_WIDTH - MIN_MAIN_WIDTH); // 378（未触顶）
  // 0.32.4：1920 窗口原本会给 1288，但绝对上限 1280 先封顶（用户要求"宽也要限制"）
  assert.equal(maxRailWidth(1920), MAX_PANEL_WIDTH, `宽窗口要封顶到 ${MAX_PANEL_WIDTH}，不是无限放宽`);
  assert.equal(maxRailWidth(2560), MAX_PANEL_WIDTH, '再宽的窗口也封顶');
  assert.equal(maxRailWidth(600), 0);
});

test('panel-layout: 0.32.4 宽窄双向都有界（绝不无限放宽/放宽）', () => {
  // 窄：正文永远保住 MIN_MAIN_WIDTH
  for (const win of [1010, 1280, 1440]) {
    const r = planPanelLayout({ windowWidth: win, desiredWidth: 2000 });
    assert.ok(win - SIDEBAR_WIDTH - r.width >= MIN_MAIN_WIDTH, `窗口 ${win}：正文被压太窄`);
    assert.ok(r.width <= MAX_PANEL_WIDTH, `窗口 ${win}：右栏超过绝对上限`);
  }
  // 宽：即便用户把期望拖到 3000，也封顶到 MAX_PANEL_WIDTH
  const wide = planPanelLayout({ windowWidth: 2560, desiredWidth: 3000 });
  assert.equal(wide.width, MAX_PANEL_WIDTH);
  assert.equal(wide.capped, true, '要如实报告"被上限截断了"');
});

test('panel-layout: 浏览器需要的宽度上限足够（1280 设计宽度的网页能完整排开）', () => {
  // 1920 窗口下右栏能拿到 1280，足够放下按 1280 设计的主流网页
  const r = planPanelLayout({ windowWidth: 1920, desiredWidth: 1280 });
  assert.equal(r.width, 1280);
  // 1440 窗口下能拿到多少（受正文 MIN_MAIN_WIDTH 约束）
  const r2 = planPanelLayout({ windowWidth: 1440, desiredWidth: 1280 });
  assert.equal(r2.width, 1440 - SIDEBAR_WIDTH - MIN_MAIN_WIDTH, '1440 下给到上限，正文仍保 420');
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
    // 0.32.0：这两个组件现在既能当独立面板（<aside data-panel-mode="rail">），
    // 也能 embedded 进 RightRail 的 tab（那时外壳由右栏提供）。并排纪律仍在：检查它出现在非嵌入分支里。
    assert.match(src, /'data-panel-mode': 'rail'/, `${file} 应为并排（非嵌入时）`);
    assert.ok(!/data-panel-scrim/.test(src), `${file} 不该再有遮罩（用户否决浮层）`);
    assert.ok(!/absolute right-0 top-2 bottom-2/.test(src), `${file} 不该再有抽屉定位`);
    assert.ok(!/isSheet/.test(src), `${file} 不该再有 isSheet 分支`);
    assert.ok(!/window\.innerWidth \* 0\.72/.test(src), `${file} 还在用旧的 72% 上限`);
    assert.match(src, /shouldClosePanel/, `${file} 拖到头关闭没走统一判定`);
  }
});

// 0.32.0：右栏变成多标签容器（产物 / 内嵌浏览器 / 子代理并存），它必须守住同一条并排纪律。
test('panel: 右栏（RightRail）也是纯并排，且沿用统一的宽度策略', () => {
  const src = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/RightRail.jsx'), 'utf8');
  assert.match(src, /planPanelLayout/, 'RightRail 必须接布局策略（MIN_MAIN_WIDTH=420 不变）');
  assert.match(src, /data-panel-mode="rail"/, 'RightRail 应为并排');
  assert.match(src, /shouldClosePanel/, 'RightRail 拖到头关闭要走统一判定');
  assert.ok(!/data-panel-scrim/.test(src), '右栏也不能有遮罩');
  assert.ok(!/isSheet/.test(src), '右栏不能有抽屉分支');
});
