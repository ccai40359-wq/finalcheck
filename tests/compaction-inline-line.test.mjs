// 上下文压缩的**流内分隔线**（0.32.9 用户要求：像 CC 那样在正文里持续出现）
//
// 用户原话与截图：
//   「持续出现在文字区域，然后会渐变色表示正在压缩，压缩完就是这样子」
//   「上下文压缩的进行 ui 显示应该在文字区域中出现」
//
// 老实现的两个问题（这次一起修掉）：
//   ① 位置错：挂在输入框上方的胶囊，压缩完就消失 → 用户回翻历史看不到「这里压过」；
//   ② 自动压缩完全无痕：只有手动 /compact 会落 notice，自动压缩（回合开始 / 回合内）
//      不落任何消息，而老实现 phase==='done' 直接 return null → 界面上什么都没有。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { IDLE, reduce } from '../desktop/src/renderer/lib/compaction.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

const comp = read('desktop/src/renderer/components/CompactionStatus.jsx');
const list = read('desktop/src/renderer/components/MessageList.jsx');
const app = read('desktop/src/renderer/App.jsx');
const css = read('desktop/src/renderer/styles.css');

test('分隔线渲染在消息流里，不在输入框上方', () => {
  // MessageList 内部渲染（消息末尾），并且吃 compaction 这个 prop
  assert.match(list, /<CompactionStatus state=\{compaction\}/, 'MessageList 必须渲染定位线');
  assert.match(list, /compaction = null/, 'MessageList 必须接收 compaction prop');
  assert.match(app, /compaction=\{compaction\}/, 'App 必须把 compaction 传进 MessageList');
  // App 里不能再有输入框上方那份（已删除）
  assert.equal(/<CompactionStatus[^>]*\/>/.test(app), false, 'App 不应再直接渲染 CompactionStatus');
});

test('done 态必须渲染（自动压缩不落 notice，否则完全无痕）', () => {
  // 老 bug：phase==='done' 时 return null
  assert.equal(
    /if\s*\(\s*phase\s*!==\s*'running'\s*&&\s*phase\s*!==\s*'failed'\s*\)\s*return null/.test(comp),
    false,
    'done 不能被排除在渲染之外'
  );
  assert.match(comp, /phase !== 'running' && phase !== 'failed' && phase !== 'done'/, '三种态都要渲染');
  assert.match(comp, /data-phase="done"/, 'done 态要有可断言标记');
  assert.match(comp, /上下文已压缩/, 'done 态文案');
});

test('running 态用渐变扫光，不是胶囊呼吸点', () => {
  assert.match(comp, /fc-compact-sweep/, '进行中要有渐变扫光 class');
  assert.match(css, /\.fc-compact-sweep\s*\{/, 'CSS 必须有 .fc-compact-sweep 规则');
  assert.match(css, /@keyframes fc-compact-sweep/, 'CSS 必须有扫光关键帧');
  assert.match(css, /background-clip:\s*text/, '扫光要靠 background-clip:text 作用在文字上');
  // 旧的胶囊呼吸点不该再被这个组件使用
  assert.equal(/fc-compact-dot/.test(comp), false, '分隔线不该再用三个呼吸点');
});

test('扫光的渐变色标必须是显式颜色，不能用 currentColor（否则整句透明看不见）', () => {
  // 实测根因（0.32.9 第一版）：color:transparent + gradient 用 currentColor
  // → currentColor 解析成 rgba(0,0,0,0) → 只有中间一小段有色，文字几乎不可见。
  const block = css.slice(css.indexOf('.fc-compact-sweep {'), css.indexOf('@keyframes fc-compact-sweep'));
  assert.ok(block.length > 0, '找不到 .fc-compact-sweep 规则');
  assert.equal(/currentColor/.test(block), false, '渐变里不能用 currentColor（会被透明色吃掉）');
  assert.match(block, /rgb\(/, '渐变必须用显式 rgb 色标');
});

test('prefers-reduced-motion 下扫光退化成静态文字（可读性优先）', () => {
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /\.fc-compact-sweep/, '减少动效时也要处理扫光');
  assert.match(block, /-webkit-text-fill-color:\s*currentColor/,
    '关掉 background-clip 后必须把文字填充色还原，否则文字会是透明的（不可读）');
});

test('分隔线样式与已有 notice 分隔线同构（h-px + 居中文字）', () => {
  assert.match(comp, /h-px flex-1/, '左右各一条细线');
  assert.match(comp, /max-w-\[80%\]/, '中间文字限宽，与 notice 一致');
});

test('手动 /compact 成功后复位状态（否则和落库 notice 出现两条）', () => {
  // 主进程手动压缩会 appendNotice(...,'compact')，openSession 会读回来渲染成同样一条线。
  // 这里必须复位，不能留一个 done 让界面出现两条「上下文已压缩」。
  const runCompact = app.slice(app.indexOf('const runCompact'), app.indexOf('const chooseSlash'));
  assert.match(runCompact, /compactionRef\.current = COMPACTION_IDLE/, '手动成功后要复位 ref');
  assert.match(runCompact, /setCompaction\(COMPACTION_IDLE\)/, '手动成功后要复位 state');
});

test('状态机仍然能把 auto 路径串成 done（分隔线因此能留在历史里）', () => {
  let st = IDLE;
  st = reduce(st, { kind: 'compact-start', scope: 'auto', before: 200000 });
  assert.equal(st.phase, 'running');
  st = reduce(st, { kind: 'compact-end', scope: 'auto', before: 200000, after: 20000 });
  assert.equal(st.phase, 'done');
  assert.equal(st.after, 20000);
});

test('token 数用「万」口径显示（与上下文面板一致），且缺数据时不显示 0', () => {
  assert.match(comp, /function fmtTokens/, '需要紧凑数字格式化');
  assert.match(comp, /万/, '中文用「万」');
  // 没有 before/after 时 detail 为空串（不能出现「→」两个空值）
  assert.match(comp, /: '';/, '缺数据时 detail 必须为空串');
});
