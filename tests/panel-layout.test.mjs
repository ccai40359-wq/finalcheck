// 右栏：并排 → 浮层的降级（正文不许被压没）。
//
// 用户实机（2026-11-19 截图）：1010px 窗口打开产物预览，
// 右栏上限是「窗口 72%」= 727px，侧栏 212，正文只剩 71px——主区整个消失，
// 输入框挤成最下面一条。这不是模型名太长，是面板没考虑正文还剩多少。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  MIN_MAIN_WIDTH, SIDEBAR_WIDTH, SHEET_RATIO, SHEET_MIN, SHEET_MAX, SHEET_RESERVE,
  maxRailWidth, planPanelLayout, clampPanelWidth
} from '../desktop/src/renderer/lib/panel-layout.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('panel-layout: 用户实机场景 —— 1010 窗口 + 560 右栏必须降级为浮层', () => {
  const r = planPanelLayout({ windowWidth: 1010, desiredWidth: 560 });
  assert.equal(r.mode, 'sheet', '1010 下 560 右栏会把正文压到 238px，必须浮层');
  // 浮层宽度按「扣掉侧栏后的可用宽度」算，并留出 SHEET_RESERVE 让正文仍看得见
  const avail = 1010 - SIDEBAR_WIDTH;
  const expect = Math.min(SHEET_MAX, Math.max(SHEET_MIN, avail - SHEET_RESERVE), Math.max(SHEET_MIN, Math.round(avail * SHEET_RATIO)));
  assert.equal(r.width, expect);
  assert.ok(avail - r.width >= SHEET_RESERVE, `浮层要给正文留 ≥${SHEET_RESERVE}px，实际 ${avail - r.width}`);
});

test('panel-layout: 旧逻辑的 72% 上限在 1010 窗口会算出 727px —— 现在不可能出现', () => {
  const oldMax = Math.round(1010 * 0.72);
  assert.equal(oldMax, 727, '旧上限');
  const r = planPanelLayout({ windowWidth: 1010, desiredWidth: oldMax });
  assert.equal(r.mode, 'sheet', '要求 727px 时直接浮层，不会挤压正文');
  assert.ok(r.width < oldMax, '浮层宽度比旧上限窄（0.62 比例）');
});

test('panel-layout: 宽窗口（1920）右栏 560 并排，正文仍 ≥ 最小宽', () => {
  const r = planPanelLayout({ windowWidth: 1920, desiredWidth: 560 });
  assert.equal(r.mode, 'rail');
  assert.equal(r.width, 560);
  assert.ok(1920 - SIDEBAR_WIDTH - r.width >= MIN_MAIN_WIDTH);
});

test('panel-layout: maxRailWidth = 窗口 − 侧栏 − 正文最小宽', () => {
  assert.equal(maxRailWidth(1010), 1010 - SIDEBAR_WIDTH - MIN_MAIN_WIDTH); // 118
  assert.equal(maxRailWidth(1280), 388);
  assert.equal(maxRailWidth(1920), 1028);
});

test('panel-layout: 轻微收缩才并排，压太狠直接浮层', () => {
  // 1280 期望 400：收缩下限 360 ≤ maxRail 388 → 并排（收到 388）
  assert.equal(planPanelLayout({ windowWidth: 1280, desiredWidth: 400 }).mode, 'rail');
  // 1280 期望 560：收缩下限 504 > 388 → 浮层
  assert.equal(planPanelLayout({ windowWidth: 1280, desiredWidth: 560 }).mode, 'sheet');
  // 1920 期望 1000：1000 ≤ 1028 → 并排
  assert.equal(planPanelLayout({ windowWidth: 1920, desiredWidth: 1000 }).mode, 'rail');
});

test('panel-layout: clamp 从不越界', () => {
  assert.equal(clampPanelWidth({ windowWidth: 1280, width: 9999, mode: 'rail' }), maxRailWidth(1280));
  assert.equal(clampPanelWidth({ windowWidth: 1280, width: -50, mode: 'rail' }), 0);
  assert.equal(clampPanelWidth({ windowWidth: 1280, width: 1, mode: 'sheet' }), SHEET_MIN);
  assert.equal(clampPanelWidth({ windowWidth: 4000, width: 5000, mode: 'sheet' }), SHEET_MAX);
});

test('panel-layout: 并排模式下正文永不低于最小宽；浮层模式下正文不被挤压（=可用宽度全额）', () => {
  for (const win of [800, 900, 1010, 1280, 1440, 1600, 1920, 2560]) {
    for (const want of [320, 400, 560, 700, 900, 1200]) {
      const r = planPanelLayout({ windowWidth: win, desiredWidth: want });
      const available = win - SIDEBAR_WIDTH;
      if (r.mode === 'rail') {
        const mainW = available - r.width;
        assert.ok(mainW >= MIN_MAIN_WIDTH, `win=${win} want=${want} 并排 → 正文 ${mainW} < ${MIN_MAIN_WIDTH}`);
      } else {
        // 浮层不参与 flex 布局：正文拿到全部可用宽度（窗口本身就太小时，
        // 这是物理上限——再压面板也变不出更多空间）
        assert.ok(r.width <= Math.max(SHEET_MIN, Math.round(win * SHEET_RATIO)), `win=${win} 浮层宽 ${r.width} 超出`);
      }
    }
  }
});

// ---------------------------------------------------------------- 接线检查

test('panel: 两个面板都用了 planPanelLayout + 浮层定位 + 遮罩', () => {
  for (const file of ['chat/ArtifactPanel.jsx', 'chat/SubagentPanel.jsx']) {
    const src = readFileSync(path.join(repoRoot, 'desktop/src/renderer', file), 'utf8');
    assert.match(src, /planPanelLayout/, `${file} 没接布局策略`);
    assert.match(src, /data-panel-mode=\{layout\.mode\}/, `${file} 缺模式标记`);
    assert.match(src, /data-panel-scrim/, `${file} 浮层缺遮罩`);
    assert.match(src, /absolute right-0 top-2 bottom-2/, `${file} 浮层没用绝对定位（应为右浮抽屉：top-2/bottom-2 留边）`);
    assert.ok(!/window\.innerWidth \* 0\.72/.test(src), `${file} 还在用旧的 72% 上限`);
  }
});

test('panel: 主区容器 relative（浮层相对它定位）', () => {
  const src = readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');
  assert.match(src, /relative flex-1 min-w-0 flex min-h-0[\s\S]{0,200}<main/);
});
