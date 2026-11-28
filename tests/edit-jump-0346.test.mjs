// 0.34.6：点历史消息上的「编辑」，视口要回到那条消息。
//
// 用户实测：在长会话里点消息上的铅笔（编辑并从这条重开），只有输入框被回填，
// 视口纹丝不动——正在流式输出时跟随态还会把视口钉在底部，用户根本看不到
// 自己正在编辑哪一条、发送后会从哪里重开。
//
// 修法（MessageList.jumpToMessage，本测试钉住的就是这几条，删任何一条都可能让问题复发）：
//   ① 用户消息行带 data-midx={i}：jumpToMessage 靠它找到要回到的 DOM 节点；
//   ② 点编辑时先 jumpToMessage(i) 再回填输入框：滚动 + 金圈高亮（.fc-msg-flash）；
//   ③ 跳历史 = 主动退出跟随态（stickRef.current = false），且必须在 scrollIntoView 之前——
//      反了的话流式输出下一帧就把视口拽回底部；
//   ④ 滚动期间挂 .cv-off（同 jumpToBottom：content-visibility 屏幕外按 400px 占位，
//      不挂量/滚都会停半路），release 必须摘掉（永久全量渲染会让长会话卡）；
//   ⑤ 停在历史消息处不在底部：release 要把「回到底部」箭头请回来（setShowJump(true)），
//      并把 jumpingRef 复位（否则箭头被永久压住）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');
const messageList = read('desktop/src/renderer/components/MessageList.jsx');
const css = read('desktop/src/renderer/styles.css');

// 按花括号配平切出一个函数体：断言语义而不是断言某一行，注释/换行调整不会误报。
function bodyOf(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `源码里找不到 ${marker}（函数被改名或删掉了？）`);
  const start = src.indexOf('{', at + marker.length);
  assert.ok(start > at, `${marker} 后面没有函数体`);
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  assert.fail(`${marker} 的花括号没有闭合`);
}

const jump = bodyOf(messageList, 'const jumpToMessage = (idx) =>');

test('编辑锚点：用户消息行带 data-midx，jumpToMessage 靠它定位', () => {
  assert.match(messageList, /data-midx=\{i\}/, '用户消息行必须带 data-midx={i}（jumpToMessage 的定位锚点）');
  assert.match(jump, /querySelector\(`\[data-midx="\$\{idx\}"\]`\)/, 'jumpToMessage 必须按 data-midx 查目标节点');
  assert.match(jump, /if \(!target\) return;/, '找不到目标节点时直接返回，不许抛错');
});

test('编辑跳转：先退出跟随态再滚动，否则流式输出会把视口拽回底部', () => {
  assert.match(jump, /stickRef\.current = false;/, '跳去历史消息必须主动退出跟随态');
  assert.ok(jump.indexOf('stickRef.current = false') < jump.indexOf('scrollIntoView('),
    'stickRef.current = false 必须在 scrollIntoView 之前（顺序反了跟随态会抢滚动条）');
  assert.match(jump, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/, '滚到视口中央，不是顶部/底部');
});

test('编辑跳转：滚动期间挂 .cv-off，release 必须摘掉（同 0.33.3 的假高度坑）', () => {
  assert.match(jump, /classList\.add\('cv-off'\)/, '滚动前必须给滚动容器挂 .cv-off');
  assert.match(jump, /classList\.remove\('cv-off'\)/, 'release 必须摘掉 .cv-off（永久全量渲染长会话会卡）');
  assert.ok(jump.indexOf("classList.add('cv-off')") < jump.indexOf('scrollIntoView('),
    '必须先挂 .cv-off 再滚');
  assert.match(jump, /requestAnimationFrame\(/, 'class 刚加上还没按真实高度重排，必须等一帧再滚');
});

test('编辑跳转：滚动收尾要复位 jumpingRef 并请回「回到底部」箭头', () => {
  assert.match(jump, /jumpingRef\.current = false;/, 'release 必须复位 jumpingRef（否则箭头被永久压住）');
  assert.match(jump, /setShowJump\(true\)/, '停在历史消息处不在底部，箭头要回来');
  assert.match(jump, /setTimeout\(release, 1600\)/, '要有兜底定时器（smooth 不来 scrollend 时也收尾）');
});

test('编辑跳转：armed 门——点击前残留的 scrollend 不许提前收尾', () => {
  // 真机自检抓到的竞态：点击前那次瞬时滚动（探针设 scrollTop / 流式跟随每帧贴底）的
  // scrollend 异步补发，落在监听注册之后、rAF 之前 → release 抢跑 → rAF 里
  // `if (released) return` 把 scrollIntoView 整个跳掉（表现为点了编辑但视口纹丝不动）。
  assert.match(jump, /let armed = false;/, '必须先落 unarmed，吃掉点击前的残留 scrollend');
  assert.match(jump, /if \(armed\) release\(\)/, 'scrollend 只有在真正开始滚（armed）之后才算数');
  assert.ok(jump.indexOf('armed = true') < jump.indexOf('scrollIntoView('),
    'armed 必须在 scrollIntoView 之前置位（先开门再滚）');
  assert.match(jump, /removeEventListener\('scrollend', onScrollEnd\)/, 'release 必须摘掉的是 onScrollEnd 监听');
});

test('点编辑先回到那条消息，再回填输入框', () => {
  // 编辑按钮的 onClick 里 jumpToMessage 必须先于 onEditMessage
  const at = messageList.indexOf("title={t('编辑并从这条重开')}");
  assert.ok(at >= 0, '编辑按钮被改名或删掉了');
  const onClick = messageList.slice(at, at + 800);
  assert.match(onClick, /jumpToMessage\(i\)/, '点编辑必须调 jumpToMessage');
  assert.ok(onClick.indexOf('jumpToMessage(i)') < onClick.indexOf('onEditMessage('),
    '先跳转高亮，再回填输入框（顺序保证用户先看到锚点）');
});

test('高亮样式：.fc-msg-flash 画在气泡上（金圈淡出，尊重减少动效）', () => {
  assert.match(css, /@keyframes fc-msg-flash/, '高亮动画 keyframes 必须存在');
  assert.match(css, /\.fc-msg-flash \.glass-bubble \{ animation: fc-msg-flash/, '高亮必须作用在气泡上（行容器是全宽的，圈不出哪一条）');
  assert.match(css, /var\(--fc-gold\)/, '金圈用主题金色变量（深浅主题各自成立）');
  // styles.css 末尾的全局 prefers-reduced-motion 会把动画压到 0.01ms，无需单独处理
});
