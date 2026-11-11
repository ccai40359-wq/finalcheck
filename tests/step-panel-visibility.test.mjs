// Bug A 回归：右侧子代理面板只属于它绑定的那次对话——设置/用量页、切会话都必须不显示。
// 纯函数覆盖判定；源码形态断言保证 App.jsx 的渲染条件与清理 effect 没被改回去。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldShowStepPanel } from '../desktop/src/renderer/lib/panel-visibility.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('panel-visibility: 对话视图 + 同一会话 → 显示', () => {
  const stepView = { sessionId: 's1', stepId: 'x', name: '审计员' };
  assert.equal(shouldShowStepPanel({ view: 'chat', stepView, activeSessionId: 's1' }), true);
});

test('panel-visibility: 设置/用量等非聊天视图 → 不显示（面板还在挂着是 bug）', () => {
  const stepView = { sessionId: 's1', stepId: 'x' };
  for (const view of ['settings', 'usage', 'about', null, undefined]) {
    assert.equal(shouldShowStepPanel({ view, stepView, activeSessionId: 's1' }), false, `view=${view}`);
  }
});

test('panel-visibility: 切到别的会话 → 不显示（面板属于原对话）', () => {
  const stepView = { sessionId: 's1', stepId: 'x' };
  assert.equal(shouldShowStepPanel({ view: 'chat', stepView, activeSessionId: 's2' }), false);
  assert.equal(shouldShowStepPanel({ view: 'chat', stepView, activeSessionId: null }), false);
});

test('panel-visibility: 没有 stepView 时永远不显示', () => {
  assert.equal(shouldShowStepPanel({ view: 'chat', stepView: null, activeSessionId: 's1' }), false);
  assert.equal(shouldShowStepPanel(), false);
});

test('App.jsx: SubagentPanel 渲染被 showStepPanel（聊天视图）条件包住', async () => {
  const src = await readFile(path.join(ROOT, 'desktop/src/renderer/App.jsx'), 'utf8');
  assert.match(
    src,
    /\{showStepPanel \? \(\s*\n\s*<SubagentPanel target=\{stepView\}/,
    'SubagentPanel 必须由 showStepPanel 控制，不能直接用 stepView 真假渲染'
  );
  assert.doesNotMatch(src, /\{stepView \? \(\s*\n\s*<SubagentPanel/, '旧的「stepView 有值就渲染」写法会让面板挂在设置页');
  assert.match(src, /const showStepPanel = shouldShowStepPanel\(\{ view: page, stepView, activeSessionId: activeId \}\);/);
});

test('App.jsx: 离开聊天视图/切会话时把 stepView 置空（返回聊天不自动弹回）', async () => {
  const src = await readFile(path.join(ROOT, 'desktop/src/renderer/App.jsx'), 'utf8');
  assert.match(src, /setStepView\(\(cur\) => \(cur && !shouldShowStepPanel\(\{ view: page, stepView: cur, activeSessionId: activeId \}\) \? null : cur\)\);/);
  assert.match(src, /\}, \[page, activeId\]\);/);
});
