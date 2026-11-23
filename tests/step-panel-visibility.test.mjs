// Bug A 回归：右侧子代理面板只属于它绑定的那次对话——设置/用量页、切会话都必须不显示。
// 纯函数覆盖判定；源码形态断言保证 App.jsx 的渲染条件与清理 effect 没被改回去。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldShowArtifactPanel, shouldShowStepPanel } from '../desktop/src/renderer/lib/panel-visibility.mjs';

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

test('App.jsx: 子代理面板只在当前会话的聊天右栏内渲染', async () => {
  const [src, rail] = await Promise.all([
    readFile(path.join(ROOT, 'desktop/src/renderer/App.jsx'), 'utf8'),
    readFile(path.join(ROOT, 'desktop/src/renderer/chat/RightRail.jsx'), 'utf8')
  ]);
  assert.match(src, /const railBelongsToSession = railSessionRef\.current === activeId;/);
  assert.match(src, /\{railBelongsToSession && shouldShowRail\(rail\) && page === 'chat' && \(\s*<RightRail\b/);
  assert.match(rail, /\{active\?\.kind === 'subagent' && \(\s*<SubagentPanel\b/);
  assert.doesNotMatch(src, /<SubagentPanel\b/, 'App 不得在右栏条件之外另行渲染子代理面板');
  assert.match(src, /shouldShowStepPanel\(\{ view: page, stepView: cur, activeSessionId: activeId \}\)/);
});

test('App.jsx: 离开聊天视图/切会话时把 stepView 置空（返回聊天不自动弹回）', async () => {
  const src = await readFile(path.join(ROOT, 'desktop/src/renderer/App.jsx'), 'utf8');
  assert.match(src, /setStepView\(\(cur\) => \(cur && !shouldShowStepPanel\(\{ view: page, stepView: cur, activeSessionId: activeId \}\) \? null : cur\)\);/);
  assert.match(src, /\}, \[page, activeId\]\);/);
});

// Bug B 回归：产物预览面板（ArtifactPanel）同样不能跟到设置/用量页。
test('artifact-panel: 聊天视图有产物（或加载中/报错）→ 显示', () => {
  assert.equal(shouldShowArtifactPanel({ view: 'chat', artifact: { path: 'a.md', name: 'a.md' } }), true);
  assert.equal(shouldShowArtifactPanel({ view: 'chat', artifactLoading: true }), true);
  assert.equal(shouldShowArtifactPanel({ view: 'chat', artifactError: '读取失败' }), true);
});

test('artifact-panel: 设置/用量等非聊天视图 → 不显示（即使产物还开着）', () => {
  const artifact = { path: 'finalcheck-gh-L2-acceptance.md', name: 'finalcheck-gh-L2-acceptance.md' };
  for (const view of ['settings', 'usage', 'about', null, undefined]) {
    assert.equal(shouldShowArtifactPanel({ view, artifact }), false, `view=${view}`);
  }
});

test('artifact-panel: 状态不清空——从设置返回聊天后继续显示同一产物', () => {
  const artifact = { path: 'finalcheck-gh-L2-acceptance.md', name: 'finalcheck-gh-L2-acceptance.md' };
  assert.equal(shouldShowArtifactPanel({ view: 'settings', artifact }), false);
  // 回到同一聊天时，同一份产物状态仍能显示。
  assert.equal(shouldShowArtifactPanel({ view: 'chat', artifact }), true);
});

test('artifact-panel: 没有产物且不在加载/报错 → 不显示', () => {
  assert.equal(shouldShowArtifactPanel({ view: 'chat' }), false);
  assert.equal(shouldShowArtifactPanel({ view: 'chat', artifact: null, artifactLoading: false, artifactError: '' }), false);
});

test('App.jsx: 产物预览只在当前会话的活动产物标签内渲染', async () => {
  const [src, rail] = await Promise.all([
    readFile(path.join(ROOT, 'desktop/src/renderer/App.jsx'), 'utf8'),
    readFile(path.join(ROOT, 'desktop/src/renderer/chat/RightRail.jsx'), 'utf8')
  ]);
  assert.match(src, /const openArtifact = \(path\) => \{[\s\S]*?openRailTab\(cur, \{\s*kind: 'artifact', artifactPath: path[^\n]*payload: \{ path \}/);
  assert.match(src, /\{railBelongsToSession && shouldShowRail\(rail\) && page === 'chat' && \(\s*<RightRail\b/);
  assert.match(rail, /\{active\?\.kind === 'artifact' && \(\s*<RailArtifactPreview\b[\s\S]*?path=\{active\.payload\.path\}/);
  assert.doesNotMatch(src, /<ArtifactPanel\b/, 'App 不得在右栏条件之外另行渲染产物面板');
});
