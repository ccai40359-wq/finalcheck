// 0.32.0：右栏多标签归约的纯逻辑测试。
// 背景：三类内容（产物 / 内嵌浏览器 / 子代理）以前是互斥的两个面板，
// 现在要在一条 tab 条里并存、随便切随便关。归约规则必须被钉住，
// 否则很容易出现「关掉浏览器 tab 顺手把产物也关了」这类回归。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RAIL_KINDS, railTabKey, emptyRail, openRailTab, activateRailTab, closeRailTab,
  patchRailTab, pruneForSession, shouldShowRail, railTabLabel, railTabByKey, activeRailTab
} from '../desktop/src/renderer/lib/rail-tabs.mjs';

test('rail-tabs: 三类内容都能开，按打开顺序排列', () => {
  let rail = emptyRail();
  let r = openRailTab(rail, { kind: 'artifact', title: '报告.html', payload: { path: 'D:/r.html' } });
  assert.equal(r.ok, true);
  rail = r.rail;
  r = openRailTab(rail, { kind: 'browser', payload: { pageTitle: '小红书' } });
  rail = r.rail;
  r = openRailTab(rail, { kind: 'subagent', title: '注入面审查员', payload: { stepId: 's1', sessionId: 'sess1' } });
  rail = r.rail;

  assert.deepEqual(rail.tabs.map((t) => t.kind), ['artifact', 'browser', 'subagent']);
  assert.equal(rail.activeKey, 'subagent:s1', '最后打开的是活动的');
  assert.deepEqual(RAIL_KINDS, ['artifact', 'browser', 'subagent']);
});

test('rail-tabs: 浏览器只占一个 tab（重复触发只切过去，不堆重复）', () => {
  let rail = openRailTab(emptyRail(), { kind: 'artifact', artifactPath: 'D:/a.png' }).rail;
  const first = openRailTab(rail, { kind: 'browser' });
  rail = first.rail;
  const second = openRailTab(rail, { kind: 'browser' });
  assert.equal(second.existed, true, '第二次打开要复用而不是新建');
  assert.equal(second.rail.tabs.filter((t) => t.kind === 'browser').length, 1, '浏览器 tab 只能有一个');
  assert.equal(second.rail.activeKey, 'browser', '复用时要把它切成活动');
});

test('rail-tabs: 同一个产物重复打开只切过去；不同产物各占一个 tab', () => {
  let rail = openRailTab(emptyRail(), { kind: 'artifact', artifactPath: 'D:/a.html' }).rail;
  const again = openRailTab(rail, { kind: 'artifact', artifactPath: 'D:/a.html' });
  assert.equal(again.existed, true);
  assert.equal(again.rail.tabs.length, 1);
  const other = openRailTab(again.rail, { kind: 'artifact', artifactPath: 'D:/b.png' });
  assert.equal(other.existed, false);
  assert.deepEqual(other.rail.tabs.map((t) => t.key), ['artifact:D:/a.html', 'artifact:D:/b.png']);
});

test('rail-tabs: 关活动 tab 落到邻居，关非活动 tab 活动不变', () => {
  let rail = emptyRail();
  rail = openRailTab(rail, { kind: 'artifact', artifactPath: 'A' }).rail;
  rail = openRailTab(rail, { kind: 'browser' }).rail;
  rail = openRailTab(rail, { kind: 'artifact', artifactPath: 'B' }).rail;
  assert.equal(rail.activeKey, 'artifact:B');

  // 关中间（非活动）
  rail = closeRailTab(rail, 'browser').rail;
  assert.equal(rail.activeKey, 'artifact:B', '关非活动 tab 不影响活动');
  assert.deepEqual(rail.tabs.map((t) => t.key), ['artifact:A', 'artifact:B']);

  // 关活动（末尾）→ 退到前一个
  rail = closeRailTab(rail, 'artifact:B').rail;
  assert.equal(rail.activeKey, 'artifact:A');

  // 关最后一个 → 空
  rail = closeRailTab(rail, 'artifact:A').rail;
  assert.equal(rail.activeKey, null);
  assert.equal(shouldShowRail(rail), false, '全关光右栏应收起');
});

test('rail-tabs: 切到不存在的 tab / 关不存在的 tab 都报错且不改状态', () => {
  const rail = openRailTab(emptyRail(), { kind: 'browser' }).rail;
  const a = activateRailTab(rail, 'artifact:x');
  assert.equal(a.ok, false);
  assert.equal(a.rail.activeKey, 'browser');
  const c = closeRailTab(rail, 'artifact:x');
  assert.equal(c.ok, false);
  assert.equal(c.rail.tabs.length, 1);
});

test('rail-tabs: 不认识的 kind 被拒绝（不静默塞进 tab 条）', () => {
  const r = openRailTab(emptyRail(), { kind: 'video-stream' });
  assert.equal(r.ok, false);
  assert.match(r.error, /不认识/);
  assert.equal(r.rail.tabs.length, 0);
});

test('rail-tabs: 切会话时子代理 tab 被清掉，产物与浏览器留着', () => {
  let rail = emptyRail();
  rail = openRailTab(rail, { kind: 'artifact', artifactPath: 'D:/r.html' }).rail;
  rail = openRailTab(rail, { kind: 'browser' }).rail;
  rail = openRailTab(rail, { kind: 'subagent', payload: { stepId: 's1', sessionId: 'old-session' } }).rail;
  assert.equal(rail.activeKey, 'subagent:s1');

  const pruned = pruneForSession(rail, 'new-session');
  assert.equal(pruned.changed, true);
  assert.deepEqual(pruned.rail.tabs.map((t) => t.kind), ['artifact', 'browser'], '子代理 tab 必须清掉');
  assert.equal(pruned.rail.tabs.some((t) => t.kind === 'subagent'), false);
  // 活动 tab 被清掉后要回落到还活着的那个
  assert.equal(pruned.rail.activeKey, 'browser');
  assert.equal(shouldShowRail(pruned.rail), true, '还有别的 tab，右栏不该收起');

  // 同一会话不清理
  const same = pruneForSession(rail, 'old-session');
  assert.equal(same.changed, false);
  assert.equal(same.rail.tabs.length, 3);
});

test('rail-tabs: 浏览器 tab 的标题跟随当前网页（而不是干巴巴「浏览器」）', () => {
  assert.equal(railTabLabel({ kind: 'browser', payload: { pageTitle: '小红书 - 你的生活指南' } }), '小红书 - 你的生活指南');
  assert.equal(railTabLabel({ kind: 'browser', payload: {} }), '浏览器');
  assert.equal(railTabLabel({ kind: 'artifact', title: '报告.html' }), '报告.html');
  assert.equal(railTabLabel({ kind: 'subagent', title: '注入面审查员' }), '注入面审查员');
  assert.equal(railTabLabel(null), '面板');
});

test('rail-tabs: patchRailTab 更新标题，空标题不覆盖已有标题', () => {
  let rail = openRailTab(emptyRail(), { kind: 'browser', payload: { pageTitle: '加载中' } }).rail;
  rail = patchRailTab(rail, 'browser', { title: '' }).rail;
  assert.equal(railTabByKey(rail, 'browser').payload.pageTitle, '加载中', '空标题不能把已有标题擦掉');
  const bad = patchRailTab(rail, 'nope', { title: 'x' });
  assert.equal(bad.ok, false);
});

test('rail-tabs: activeRailTab / railTabByKey 对空状态安全', () => {
  assert.equal(activeRailTab(emptyRail()), null);
  assert.equal(activeRailTab(null), null);
  assert.equal(railTabByKey(null, 'x'), null);
  assert.equal(shouldShowRail(null), false);
  assert.equal(shouldShowRail(emptyRail()), false);
});
