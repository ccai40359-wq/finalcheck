// WF2（2026-11-21）：AI 自检截图 chip 折叠分组。
// 背景：agent 每次自查截图都在会话流渲染一个独立 chip（「截图： http://127.0.0.1:…」），
// 几十个把屏幕占满——这些是 AI 自己的检查证据，不是交付物。同一条 assistant 消息内
// 收成单个「检查截图 ×N」分组条，默认收起；展开后每张 chip 仍走原 onOpen 链路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  SHOT_GROUP_DEFAULT_EXPANDED,
  isScreenshotArtifact,
  partitionArtifacts,
  shotGroupView
} from '../desktop/src/renderer/lib/artifact-groups.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const artifactPanel = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/ArtifactPanel.jsx'), 'utf8');
const messageList = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/MessageList.jsx'), 'utf8');
const processTimeline = readFileSync(path.join(repoRoot, 'desktop/src/renderer/chat/ProcessTimeline.jsx'), 'utf8');

const shot = (p, what = 'p') => ({ path: p, name: `截图：${what}`, shot: true });
const file = (p, name = 'a.html', added = 3, removed = 1) => ({ path: p, name, added, removed });

test('默认收起：SHOT_GROUP_DEFAULT_EXPANDED=false，shotGroupView 收起态 chips 为空数组', () => {
  assert.equal(SHOT_GROUP_DEFAULT_EXPANDED, false);
  const view = shotGroupView({ count: 3, items: [shot('a.png'), shot('b.png'), shot('c.png')] });
  assert.equal(view.expanded, false, '不传 expanded 时默认收起');
  assert.deepEqual(view.chips, [], '收起态不携带任何 chip 数据');
  assert.equal(view.count, 3);
  assert.equal(view.labelKey, '检查截图 ×{n}');
  assert.deepEqual(view.params, { n: 3 });
});

test('N 计数：3 张截图 → count=3；分组数据结构完整（items 保留原产物字段）', () => {
  const items = [shot('a.png'), shot('b.png'), shot('c.png')];
  const { regular, shotGroup } = partitionArtifacts(items);
  assert.equal(regular.length, 0, '纯截图消息没有常规产物');
  assert.equal(shotGroup.count, 3);
  assert.equal(shotGroup.items.length, 3);
  assert.equal(shotGroup.items[0].path, 'a.png');
  const open = shotGroupView(shotGroup, true);
  assert.equal(open.expanded, true);
  assert.equal(open.chips.length, 3, '展开后渲染 N 个 chip');
  assert.deepEqual(open.chips, items, '展开态 chip 数据与原产物一致（onOpen 链路不破坏）');
});

test('非截图工具不受影响：edit_file / write_file / present_artifact 仍走常规 chip', () => {
  const { regular, shotGroup } = partitionArtifacts([
    file('p:/a.html'), file('p:/b.css', 'b.css'), { path: 'p:/c.png', name: '交付图' }, // 无 shot 标记 = 常规产物
    shot('s1.png'), shot('s2.png')
  ]);
  assert.deepEqual(regular.map((a) => a.path), ['p:/a.html', 'p:/b.css', 'p:/c.png'], '常规产物原样保留');
  assert.equal(shotGroup.count, 2, '只有带 shot 标记的进分组');
});

test('边界：null / 空数组 / count 与 items 数不一致时稳健', () => {
  assert.deepEqual(partitionArtifacts(null), { regular: [], shotGroup: null });
  assert.deepEqual(partitionArtifacts([]), { regular: [], shotGroup: null });
  assert.deepEqual(partitionArtifacts('x'), { regular: [], shotGroup: null });
  assert.equal(shotGroupView(null, true), null, '没有截图 → 不渲染分组条');
  assert.equal(shotGroupView({ count: 0, items: [] }, true), null, '0 张 → 不渲染分组条');
  // count 缺失时回退 items.length
  const view = shotGroupView({ items: [shot('a.png')] }, false);
  assert.equal(view.count, 1);
});

test('isScreenshotArtifact 只认显式 shot===true（不误伤普通产物/畸形输入）', () => {
  assert.equal(isScreenshotArtifact(shot('a.png')), true);
  assert.equal(isScreenshotArtifact(file('p:/a.html')), false);
  assert.equal(isScreenshotArtifact({ path: 'x', shot: 1 }), false);
  assert.equal(isScreenshotArtifact(null), false);
  assert.equal(isScreenshotArtifact('shot'), false);
});

test('collectArtifacts：0.33.9 起 capture_screenshot 不再堆到消息底部（留在那一步的工具记录里可点开）', () => {
  // 用户：「下面我希望是 AI 主动展示的，而不是截图堆积的」
  assert.match(artifactPanel, /\['edit_file', 'write_file', 'present_artifact'\]\.includes\(entry\?\.tool\)/,
    '底部只收 AI 交付 / 改动的文件');
  assert.doesNotMatch(artifactPanel, /\['edit_file', 'write_file', 'present_artifact', 'capture_screenshot'\]/);
  assert.match(artifactPanel, /return out;/, 'collectArtifacts 仍返回扁平数组');
});

test('收起态 DOM 不渲染任何 <img>：artifactChip + ArtifactChips 函数体只出按钮与文本', () => {
  const start = artifactPanel.indexOf('function artifactChip');
  const end = artifactPanel.indexOf('export function ArtifactPanel');
  assert.ok(start > 0 && end > start, 'artifactChip / ArtifactChips 函数体定位失败');
  const body = artifactPanel.slice(start, end);
  assert.ok(!body.includes('<img'), 'chip 渲染路径不允许出现 <img>（右侧预览面板的本体 <img> 不在此范围）');
  assert.match(body, /useState\(SHOT_GROUP_DEFAULT_EXPANDED\)/, '展开态必须默认收起');
  assert.match(body, /partitionArtifacts\(artifacts\)/, '分组走纯函数 partitionArtifacts');
  assert.match(body, /shotGroupView\(shotGroup, shotsOpen\)/, '折叠视图走纯函数 shotGroupView');
  assert.match(body, /group\.expanded \? /, '只有展开时才渲染 chip 列表');
  assert.match(body, /onClick=\{\(\) => onOpen\(a\.path\)\}/, 'chip 点击仍走 onOpen(path) 链路');
  assert.match(body, /setShotsOpen\(\(v\) => !v\)/, '分组条可切换展开/收起');
});

test('MessageList.jsx:263 传参链不破坏（artifacts / activePath / onOpen 原样）', () => {
  assert.match(messageList,
    /<ArtifactChips artifacts=\{collectArtifacts\(m\.trace\)\} activePath=\{artifactPath\} onOpen=\{onOpenArtifact\} \/>/,
    'ArtifactChips 调用点必须保持原传参链');
});

test('范围红线：ProcessTimeline 的 Screenshot 条目不在本次改动内', () => {
  assert.match(processTimeline, /case 'capture_screenshot':/, 'ProcessTimeline 的截图条目保持原样');
});
