// 0.32.0：内嵌浏览器多标签的纯逻辑测试。
// 背景（用户实机 + 我的实测）：0.31.x 的自带浏览器只能开一个页面（window.open 返回 false、
// 页面数恒为 1），右栏也没有浏览器。0.32.0 要能多标签，状态机在这里钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TABS, emptyState, openTab, switchTab, closeTab, patchTab,
  tabById, activeTab, classifyWindowOpen, tabLabel
} from '../desktop/src/main/browser-tabs.mjs';

test('browser-tabs: 开标签追加到末尾并成为活动标签', () => {
  let st = emptyState();
  let r = openTab(st, { id: 't1', url: 'https://a.test/' });
  assert.equal(r.ok, true);
  st = r.state;
  assert.deepEqual(st.tabs.map((t) => t.id), ['t1']);
  assert.equal(st.activeId, 't1');

  r = openTab(st, { id: 't2', url: 'https://b.test/' });
  st = r.state;
  assert.deepEqual(st.tabs.map((t) => t.id), ['t1', 't2'], '顺序 = 打开顺序');
  assert.equal(st.activeId, 't2', '新标签成为活动');
});

test('browser-tabs: 关掉活动标签落到邻居（原位置的后者优先，否则前一个）', () => {
  let st = emptyState();
  for (const id of ['t1', 't2', 't3']) st = openTab(st, { id }).state;
  assert.equal(st.activeId, 't3');

  // 关中间那个（非活动）→ 活动不变
  st = closeTab(st, 't2').state;
  assert.equal(st.activeId, 't3');
  assert.deepEqual(st.tabs.map((t) => t.id), ['t1', 't3']);

  // 关活动 t3（末尾）→ 退到前一个 t1
  st = closeTab(st, 't3').state;
  assert.equal(st.activeId, 't1');
  assert.deepEqual(st.tabs.map((t) => t.id), ['t1']);

  // 关最后一个 → activeId 归 null（右栏是否收起由调用方决定）
  st = closeTab(st, 't1').state;
  assert.equal(st.activeId, null);
  assert.equal(st.tabs.length, 0);
});

test('browser-tabs: 关活动标签且后面还有时，落到后面那个', () => {
  let st = emptyState();
  for (const id of ['a', 'b', 'c']) st = openTab(st, { id }).state;
  st = switchTab(st, 'b').state;              // 活动 = 中间的 b
  const r = closeTab(st, 'b');
  assert.equal(r.ok, true);
  assert.equal(r.state.activeId, 'c', '原位置现在站着 c');
  assert.deepEqual(r.state.tabs.map((t) => t.id), ['a', 'c']);
});

test('browser-tabs: 上限 12 个，超了拒绝并说明（不静默丢页面）', () => {
  let st = emptyState();
  for (let i = 0; i < MAX_TABS; i++) st = openTab(st, { id: `t${i}` }).state;
  assert.equal(st.tabs.length, MAX_TABS);
  const r = openTab(st, { id: 'overflow' });
  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(String(MAX_TABS)), '错误信息要说清上限');
  assert.equal(r.state.tabs.length, MAX_TABS, '拒绝时状态不能被改坏');
});

test('browser-tabs: 重复 id / 缺 id 都拒绝（不产生两个同 id 标签）', () => {
  const st = openTab(emptyState(), { id: 't1' }).state;
  assert.equal(openTab(st, { id: 't1' }).ok, false);
  assert.equal(openTab(st, { id: '' }).ok, false);
  assert.equal(openTab(st, {}).ok, false);
});

test('browser-tabs: 切到不存在的标签保持原状并报错（不静默乱切）', () => {
  const st = openTab(emptyState(), { id: 't1' }).state;
  const r = switchTab(st, 'nope');
  assert.equal(r.ok, false);
  assert.equal(r.state.activeId, 't1');
});

test('browser-tabs: patchTab 只更新 title/url，不丢 opener 等信息', () => {
  let st = openTab(emptyState(), { id: 't1', url: 'https://a.test/', openerId: 'parent' }).state;
  st = patchTab(st, 't1', { title: '小红书', url: 'https://a.test/explore' }).state;
  const t = tabById(st, 't1');
  assert.equal(t.title, '小红书');
  assert.equal(t.url, 'https://a.test/explore');
  assert.equal(t.openerId, 'parent', '其它字段不能被 patch 弄丢');
  // 非法 id 不改状态
  const bad = patchTab(st, 'nope', { title: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.state.tabs.length, 1);
});

test('browser-tabs: window.open 判定 —— http(s)/file 开新标签，about:blank 与 javascript: 拒绝', () => {
  assert.deepEqual(classifyWindowOpen('https://b.test/x'), { open: true, url: 'https://b.test/x' });
  assert.deepEqual(classifyWindowOpen('http://b.test/x'), { open: true, url: 'http://b.test/x' });
  assert.equal(classifyWindowOpen('about:blank').open, false, 'about:blank 是空窗，不是真页面');
  assert.equal(classifyWindowOpen('javascript:alert(1)').open, false, 'javascript: 绝不能当页面加载');
  assert.equal(classifyWindowOpen('file:///C:/x.html').open, true, '本地文件允许（FC 自己也用 file://）');
  assert.equal(classifyWindowOpen('').open, false);
  assert.equal(classifyWindowOpen('not a url').open, false);
  assert.match(classifyWindowOpen('chrome://settings').reason, /scheme-not-allowed/);
});

test('browser-tabs: 标签标题优先用页面标题，没有就退主机名，再没有就截断 URL', () => {
  assert.equal(tabLabel({ title: '小红书', url: 'https://x.test/' }), '小红书');
  assert.equal(tabLabel({ title: '', url: 'https://www.xiaohongshu.com/explore' }), 'www.xiaohongshu.com');
  assert.equal(tabLabel({ title: '', url: '' }), '新标签');
  assert.equal(tabLabel({ title: '', url: 'not-a-url-but-long' }).length <= 40, true);
  assert.equal(tabLabel(null), '新标签');
});

test('browser-tabs: activeTab 与 tabById 对空状态安全', () => {
  assert.equal(activeTab(emptyState()), null);
  assert.equal(tabById(null, 'x'), null);
  assert.equal(tabById(emptyState(), 'x'), null);
  assert.equal(activeTab(null), null);
});
