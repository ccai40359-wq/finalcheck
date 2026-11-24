// 0.33.3：会话里点「回到底部」，滚到半路就停；消息越长越明显。
//
// 根因（已定位，不是猜测）：styles.css 的 .cv-auto（content-visibility:auto +
// contain-intrinsic-size: auto 400px）挂在每条 assistant 消息上。屏幕外的消息只按
// 400px 记账，而一条含大标题/表格/引用块的回答真实高度有 1500-2500px，于是
// scrollHeight 被严重低估，scrollTo({ top: scrollHeight }) 滚到一个「假底部」；
// 停稳后视口内的消息才按真实内容撑开，用户又离底部很远。流式输出跟不到底是同一个根因。
//
// 修法（本测试钉住的就是这几条，任何一条被删都可能让 bug 复发）：
//   ① 回到底部：滚动期间给滚动容器挂 .cv-off（临时关掉 content-visibility），
//      等一帧让浏览器按真实高度重排，再滚；滚完一定摘掉（否则长会话永久全量渲染会卡）。
//   ② 自动跟随：不再只写一次 scrollTop，而是「贴一次 → 读回 scrollHeight 强制重排 →
//      还差一截就下一帧再贴」，并有帧数上界，不会无限滚。
//   ③ 默认估计值 400px 不许动：那是性能优化，靠临时关闭绕过，不靠调大估计值掩盖。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');
const messageList = read('desktop/src/renderer/components/MessageList.jsx');
const app = read('desktop/src/renderer/App.jsx');
const css = read('desktop/src/renderer/styles.css');

// 按花括号配平切出一个函数体：断言语义而不是断言某一行，注释/换行调整不会误报。
// 找不到标记就直接失败（改名/被删时必须让测试红）。
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

const jump = bodyOf(messageList, 'const jumpToBottom = () =>');

test('回到底部：滚动期间临时关掉 content-visibility（挂 .cv-off）', () => {
  assert.match(jump, /classList\.add\('cv-off'\)/, 'jumpToBottom 必须先给滚动容器挂 .cv-off');
  assert.match(jump, /const el = scrollRef\.current;/, '.cv-off 必须挂在 scrollRef.current（真正滚动的那个容器）上');
  // 顺序：先挂 class，再滚。反了就还是按 400px 估计滚
  assert.ok(jump.indexOf("classList.add('cv-off')") < jump.indexOf('scrollTo('),
    '必须先挂 .cv-off 再 scrollTo，否则量到的还是被低估的 scrollHeight');
});

test('回到底部：等一帧让浏览器按真实高度重排，再量 scrollHeight 滚', () => {
  assert.match(jump, /requestAnimationFrame\(/, 'class 刚加上时同一任务里读到的 scrollHeight 还是旧估计值，必须等一帧');
  const raf = jump.slice(jump.indexOf('requestAnimationFrame('));
  assert.match(raf, /scrollTo\(\{ top: el\.scrollHeight/, '滚动目标要在 rAF 里现读 scrollHeight');
  assert.ok(jump.indexOf('requestAnimationFrame(') < jump.indexOf('scrollTo('),
    'scrollTo 必须在 rAF 回调里，不能提前');
});

test('回到底部：清理逻辑齐全，不会永久关掉 content-visibility', () => {
  assert.match(jump, /classList\.remove\('cv-off'\)/, '必须有摘掉 .cv-off 的动作（留着 = 整条会话永久全量渲染）');
  assert.match(jump, /addEventListener\('scrollend', release/, '滚完要能感知（scrollend）');
  assert.match(jump, /removeEventListener\('scrollend', release/, 'scrollend 监听要摘，不能越积越多');
  assert.match(jump, /setTimeout\(release, \d+\)/, '平滑滚动没有 scrollend 时要有兜底定时器');
  assert.match(jump, /clearTimeout\(timer\)/, '清理时要撤掉兜底定时器');
  assert.match(jump, /if \(released\) return;/, 'release 必须幂等：scrollend / 定时器 / 卸载 三条路径都会调它');
  // 已经在底部时不会产生滚动 → 不会有 scrollend，必须自己收尾
  assert.match(jump, /scrollHeight - el\.scrollTop - el\.clientHeight < 2\) release\(\)/,
    '本来就在底部（连点/双击）要立刻收尾，别白挂 800ms 的 cv-off');
  // 异常路径：没有滚动容器时不能留下 jumpingRef 悬空
  assert.match(jump, /if \(!el\) \{ jumpingRef\.current = false; return; \}/,
    'el 为空时必须复位 jumpingRef 再退出');
  assert.match(jump, /jumpingRef\.current = false;/, '收尾要复位 jumpingRef');
});

test('回到底部：卸载时也收尾（定时器不留到组件消失之后）', () => {
  assert.match(messageList, /useEffect\(\(\) => \(\) => \{ cvOffReleaseRef\.current\?\.\(\); \}, \[\]\)/,
    '组件卸载时要把上一轮的 release 调掉，否则 800ms 定时器跑在已卸载的节点上');
  // 上一轮收尾必须在置 jumpingRef=true 之前：release 会把 jumpingRef 复位成 false，
  // 顺序反了就变成「正在平滑滚动但 jumpingRef=false」→ 滚动事件把箭头又弹出来
  const callAt = jump.indexOf('cvOffReleaseRef.current?.();');
  const setAt = jump.indexOf('jumpingRef.current = true;');
  assert.ok(callAt >= 0 && setAt >= 0, '找不到上一轮收尾 / 置位语句');
  assert.ok(callAt < setAt, '必须先调上一轮的 release，再置 jumpingRef=true（否则它会把新一轮的标记清掉）');
});

test('回到底部：摘掉 .cv-off 后仍贴一次底（防高度微调导致跳回）', () => {
  const releaseBody = bodyOf(jump, 'const release = () =>');
  assert.match(releaseBody, /classList\.remove\('cv-off'\)/);
  assert.match(releaseBody, /stickRef\.current\) el\.scrollTop = el\.scrollHeight/,
    '摘掉 class 后若用户仍在跟随态，要再贴一次底（字体/图片可能刚好在这时落位）');
});

test('回到底部：兜底定时器要盖住整段平滑滚动（实测 ~1500ms）', () => {
  const m = jump.match(/setTimeout\(release, (\d+)\)/);
  assert.ok(m, '必须有兜底定时器');
  const ms = Number(m[1]);
  assert.ok(ms >= 1600, `兜底 ${ms}ms 短于实测的 ~1500ms 平滑滚动时长：会在动画中途摘掉 .cv-off`);
});

test('自动跟随：不再只依赖单次 scrollHeight', () => {
  const auto = bodyOf(app, 'const autoScroll = () =>');
  assert.ok(!/if \(el\) el\.scrollTop = el\.scrollHeight;/.test(auto),
    'autoScroll 不能只写一次 scrollTop 就结束（那一刻新内容还没按真实高度布局完）');
  const pin = bodyOf(auto, 'const pin = () =>');
  assert.match(pin, /el\.scrollTop = el\.scrollHeight/, '每一帧都要重新读 scrollHeight 再贴');
  assert.match(pin, /requestAnimationFrame\(pin\)/, '必须跨帧再贴：同帧重排结果还没出来');
  assert.match(pin, /\+\+frames < \d+/, '补滚帧必须有上界，不能无限滚');
  // 反例钉：同帧判 gap 会「当场收手」，等于没修；scrollIntoView 单独用实测无效
  assert.ok(!/scrollHeight - el\.scrollTop - el\.clientHeight/.test(pin),
    '不能在同帧用 gap 判定是否继续：刚赋值完 gap 恒为 0，必然当场收手（实测无效）');
  assert.ok(!/scrollIntoView/.test(auto),
    '不能用 scrollIntoView 单独兜底：目标节点自身在视口外时几何仍是 400px 估计值（实测仍落后 1768px）');
  // 用户中途往上翻：必须停手
  assert.match(pin, /if \(!stickRef\.current \|\| scrollRef\.current !== el\) return;/,
    '补滚帧里要重新确认用户还在跟随态，否则会把正在看历史的人拽回底部');
  // 每个 token 都触发一次：上一帧没跑完就叠新的会抖
  assert.match(auto, /cancelAnimationFrame\(followRafRef\.current\)/, '新的 autoScroll 要先取消上一帧');
  assert.match(app, /const followRafRef = useRef\(0\)\)?;/, '上一帧的句柄要存 ref');
  assert.match(auto, /setShowJump\(false\)/, '跟随态不该显示「回到底部」箭头');
});

test('自动跟随：没有滚动容器时也要复位箭头状态', () => {
  const auto = bodyOf(app, 'const autoScroll = () =>');
  assert.match(auto, /if \(!el\) \{ setShowJump\(false\); return; \}/,
    'el 为空提前 return 时要跟原来一样把箭头收起来');
});

test('回到底部：异常路径也一定摘掉 .cv-off', () => {
  assert.match(jump, /try \{/, 'addEventListener/rAF 这一段要包 try');
  assert.match(jump, /catch \(err\) \{\s*release\(\);/, 'catch 里必须先 release，再抛回去');
  assert.match(jump, /throw err;/, '不能吞异常（吞了会掩盖真 bug）');
  // 定时器必须在 try 之前挂上：否则 try 里抛错时它还没排上，就只有 catch 这一条路
  assert.ok(jump.indexOf('setTimeout(release, 1600)') < jump.indexOf('try {'),
    '兜底定时器要先挂，再进 try，否则抛错时既无定时器也无监听');
});

test('CSS：.cv-off 覆盖规则存在，且按容器后代作用域', () => {
  assert.match(css, /\.cv-off \.cv-auto/, '.cv-off 必须挂在容器上、以 .cv-auto 为后代选择器（不能改成全局覆盖）');
  const rule = css.slice(css.indexOf('.cv-off .cv-auto'));
  const block = rule.slice(0, rule.indexOf('}') + 1);
  assert.match(block, /content-visibility: visible;/, '关闭态必须是 content-visibility: visible');
  assert.match(block, /contain-intrinsic-size: auto;/, '关闭态要把估计值换成 auto 单值（保留 400px 会继续干扰滚动范围估算）');
  assert.ok(!/^\s*\.cv-auto\s*\{\s*content-visibility: visible/m.test(css),
    '不能把 .cv-auto 本身改成 visible（那等于永久关掉这项优化）');
});

test('CSS：默认估计值 400px 不许动（性能优化，靠临时关闭绕过）', () => {
  assert.match(css, /\.cv-auto \{\s*content-visibility: auto;\s*contain-intrinsic-size: auto 400px;/,
    'contain-intrinsic-size 默认值必须保持 auto 400px：改大改小都有副作用，修法不是调估计值');
});
