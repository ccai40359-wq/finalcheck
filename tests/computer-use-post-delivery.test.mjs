// 0.30.0 特性 2：post-message 后台键盘（白名单保守 + R5/R6 全部落实）
// 产品决策：只对实测验证过的经典 Win32 应用启用；微信/Electron/Chromium 一律 SendInput；
// 不在白名单 → 明确 deny('delivery-not-whitelisted')，绝不静默降级/试一次失败再退化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  POST_DELIVERY_WHITELIST, hasChordModifiers, isPostDeliveryAllowed,
  postDeliveryDecision, postDeliveryResult
} from '../desktop/src/main/post-delivery.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cuSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-use.mjs'), 'utf8');
const inputSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/desktop-input-win.mjs'), 'utf8');
const postSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/post-delivery.mjs'), 'utf8');

// ---- 白名单常量 ----

test('post: 白名单常量存在且只含实测验证过的经典 Win32（记事本等）', () => {
  assert.ok(Array.isArray(POST_DELIVERY_WHITELIST));
  assert.ok(POST_DELIVERY_WHITELIST.includes('notepad'));
  // 保守：不能把微信/Electron/Chromium 放进白名单
  for (const bad of ['weixin', 'wechat', 'wechatappex', 'chrome', 'msedge', 'electron', 'code', 'finalcheck', 'zcode']) {
    assert.ok(!POST_DELIVERY_WHITELIST.includes(bad), `${bad} 不得进 post 白名单`);
  }
  assert.ok(Object.isFrozen(POST_DELIVERY_WHITELIST), '白名单必须冻结（运行时不可被模型/代码改）');
});

test('post: isPostDeliveryAllowed 大小写/扩展名不敏感；空名 false', () => {
  assert.equal(isPostDeliveryAllowed('notepad'), true);
  assert.equal(isPostDeliveryAllowed('NOTEPAD.exe'), true);
  assert.equal(isPostDeliveryAllowed('Weixin.exe'), false);
  assert.equal(isPostDeliveryAllowed(''), false);
  assert.equal(isPostDeliveryAllowed(null), false);
  assert.equal(isPostDeliveryAllowed('notepad++'), false); // 白名单精确匹配，不做前缀猜测
});

// ---- 决策表 ----

test('post: 显式 delivery:post + 白名单 + type → 允许', () => {
  assert.deepEqual(
    postDeliveryDecision({ processName: 'notepad', action: 'type', delivery: 'post', hasModifiers: false }),
    { allowed: true }
  );
});

test('post: 不在白名单 → delivery-not-whitelisted（不静默降级）', () => {
  for (const name of ['weixin', 'chrome', 'electron', 'unknownapp']) {
    const d = postDeliveryDecision({ processName: name, action: 'type', delivery: 'post', hasModifiers: false });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, 'delivery-not-whitelisted', name);
  }
});

test('post: 组合键拒绝（key 动作 / 带修饰符的 type 都一样）', () => {
  assert.equal(
    postDeliveryDecision({ processName: 'notepad', action: 'key', delivery: 'post', hasModifiers: false }).reason,
    'chords-not-supported'
  );
  assert.equal(
    postDeliveryDecision({ processName: 'notepad', action: 'type', delivery: 'post', hasModifiers: true }).reason,
    'chords-not-supported'
  );
});

test('post: 非 type 动作拒绝（click/scroll/drag 等）', () => {
  for (const action of ['click', 'left_click', 'scroll', 'drag', 'move', 'focus']) {
    assert.equal(
      postDeliveryDecision({ processName: 'notepad', action, delivery: 'post', hasModifiers: false }).reason,
      'action-not-supported', action
    );
  }
});

test('post: 没请求 post（delivery 缺省）→ not-requested（默认路径完全不变）', () => {
  for (const delivery of [undefined, null, '']) {
    assert.deepEqual(
      postDeliveryDecision({ processName: 'notepad', action: 'type', delivery, hasModifiers: false }),
      { allowed: false, reason: 'not-requested' }
    );
  }
});

// ---- 组合键识别 ----

test('post: hasChordModifiers 覆盖 SendKeys 语法与常见写法', () => {
  // SendKeys 语法（与 C# GuardedKeyEvents 一致）
  for (const keys of ['^s', '%{F4}', '+{TAB}', '^%s']) {
    assert.equal(hasChordModifiers(keys), true, keys);
  }
  // 常见英文写法
  for (const keys of ['Ctrl+S', 'ctrl+s', 'Shift+Tab', 'Alt+F4', 'Win+Space', 'Meta+K', 'Control+C']) {
    assert.equal(hasChordModifiers(keys), true, keys);
  }
  // 单键没有修饰符
  for (const keys of ['Enter', 'Tab', 'F5', 'a', '~', 'Escape']) {
    assert.equal(hasChordModifiers(keys), false, keys);
  }
  assert.equal(hasChordModifiers(''), false);
  assert.equal(hasChordModifiers(null), false);
});

// ---- R5：PostMessage 返回值 ≠ 投递成功 ----

test('post R5: 结果带 delivery:post + confidence:unverified + warnings[]，且文案明说未核验', () => {
  const r = postDeliveryResult({ targetHwnd: 123, sent: 5, failed: 0, processName: 'notepad' });
  assert.equal(r.delivery, 'post');
  assert.equal(r.confidence, 'unverified');
  assert.equal(r.targetHwnd, 123);
  assert.equal(r.sent, 5);
  assert.equal(r.failed, 0);
  assert.ok(Array.isArray(r.warnings) && r.warnings.length >= 2);
  assert.match(r.warnings.join('\n'), /消息队列/);
  assert.match(r.warnings.join('\n'), /可能忽略或丢弃/);
  assert.match(r.note, /未核验/);
  assert.match(r.note, /重新截图/);
  // 有失败字符时 warnings 追加一条
  const withFail = postDeliveryResult({ targetHwnd: 1, sent: 3, failed: 2, processName: 'notepad' });
  assert.match(withFail.warnings.join('\n'), /2 个字符未被消息队列接受/);
});

test('post R5: C# 侧 PostMessage 返回值只用于计数，注释与实现都不把它当成功', () => {
  const postText = inputSrc.slice(inputSrc.indexOf('public static string PostText'), inputSrc.indexOf('public static string CursorPos'));
  assert.match(postText, /bool ok = PostMessage\(target, WM_CHAR, new IntPtr\(\(int\)c\), IntPtr\.Zero\);/);
  assert.match(postText, /if \(ok\) sent\+\+; else failed\+\+;/);
  assert.match(postText, /return "OK\|" \+ target\.ToInt64\(\) \+ "\|" \+ sent \+ "\|" \+ failed;/);
  // 返回的是 sent/failed 两个计数（不是布尔 success）
  assert.doesNotMatch(postText, /return "OK\|1"|return "OK\|success"/);
});

// ---- R6-a：WM_CHAR 发到有消息循环的子控件 ----

test('post R6-a: WM_CHAR 发到可见子控件（顶层窗口常被忽略），找不到才回退顶层', () => {
  const postText = inputSrc.slice(inputSrc.indexOf('public static string PostText'), inputSrc.indexOf('public static string CursorPos'));
  assert.match(inputSrc, /static bool FindMessageTarget\(IntPtr top, out IntPtr target\)/);
  assert.match(inputSrc, /IntPtr child = GetWindow\(top, GW_CHILD\);/);
  assert.match(inputSrc, /child = GetWindow\(child, GW_HWNDNEXT\);/);
  // 只认可可见子窗口
  assert.match(inputSrc, /IsWindowVisible\(child\)/);
  // 排除不处理 WM_CHAR 的框架控件
  for (const cls of ['ScrollBar', 'msctls_statusbar32', 'ToolbarWindow32', 'ReBarWindow32', 'SysHeader32']) {
    assert.ok(inputSrc.includes(cls), `必须排除 ${cls}`);
  }
  const findBody = inputSrc.slice(inputSrc.indexOf('static bool FindMessageTarget'), inputSrc.indexOf('public static string PostText'));
  // 0.30.0 实现比原任务书更严谨：顶层自身是编辑控件时直接用；否则按类名找编辑/输入类可见子控件；
  // 再退一级找非框架类可见子窗口；都找不到 → 返回 false（调用方明确报 ERR|no-message-target，
  // 不静默把顶层当目标——那会让 WM_CHAR 打在没消息循环的窗口上、静默丢字）。
  assert.match(findBody, /target = top; return true;/, '顶层自身是编辑控件时直接用');
  assert.ok(findBody.includes('GW_CHILD'), '必须遍历子控件找消息宿主');
  assert.ok(findBody.includes('IsWindowVisible(child)'), '只看可见子控件');
  assert.ok(findBody.includes('return false;'), '找不到合适宿主必须明确失败，不静默回退');
  assert.match(postText, /if \(!FindMessageTarget\(w, out target\)\) return "ERR\|no-message-target";/);
  assert.match(postText, /PostMessage\(target, WM_SETFOCUS, IntPtr\.Zero, IntPtr\.Zero\);/);
  assert.match(postText, /PostMessage\(target, WM_CHAR, /);
});

// ---- R6-b：逐 UTF-16 code unit ----

test('post R6-b: 逐 UTF-16 code unit 发送（foreach char，代理对分别发）', () => {
  const postText = inputSrc.slice(inputSrc.indexOf('public static string PostText'), inputSrc.indexOf('public static string CursorPos'));
  assert.match(postText, /foreach \(char c in text\) \{/);
  assert.match(postText, /new IntPtr\(\(int\)c\)/);
  assert.doesNotMatch(postText, /GetBytes|UTF8Encoding|Encoding\./); // 不许按字节切
});

// ---- R6-c：post 路径不得调 SetForegroundWindow / AssertForeground ----

test('post R6-c: post 路径不抢前台（无 SetForegroundWindow/AssertForeground/FocusWindow）', () => {
  const postText = inputSrc.slice(inputSrc.indexOf('public static string PostText'), inputSrc.indexOf('public static string CursorPos'));
  assert.doesNotMatch(postText, /SetForegroundWindow|AssertForeground|AssertPoint|ShowWindow|BringWindowToTop/);
  const findBody = inputSrc.slice(inputSrc.indexOf('static bool FindMessageTarget'), inputSrc.indexOf('public static string PostText'));
  assert.doesNotMatch(findBody, /SetForegroundWindow|AssertForeground|ShowWindow|BringWindowToTop/);
  // JS 转发层：postTypeText 不传 guard（guard 就是前台断言载体）
  const jsStart = inputSrc.indexOf('export async function postTypeText');
  const jsPost = inputSrc.slice(jsStart, inputSrc.indexOf('export async function typeText', jsStart));
  assert.match(jsPost, /send\(\{ op: 'post-type', hwnd: Number\(hwnd\), pid: Number\(pid\) \|\| 0, text: String\(text\) \}\)/);
  // 只钉「不把 guard 传进 send」，注释里解释「不走 guard」不算
  assert.doesNotMatch(jsPost, /guard\s*(?:\}\s*=|:\s*[a-zA-Z_$]|,)/);
  // computer-use 的 post 分支也不做焦点/前台调用
  const cuPost = cuSrc.slice(cuSrc.indexOf('async function dispatchPostType'), cuSrc.indexOf('function validateActionArguments'));
  assert.doesNotMatch(cuPost, /SetForegroundWindow|focusWindow|assertForeground/i);
});

// ---- R6-d：复检目标 hwnd 存活 + pid 匹配 ----

test('post R6-d: 投递前复检窗口存活 + pid 匹配（窗口被复用/关闭即拒）', () => {
  // 注释在函数上方，正文里是 alive 变量
  const body = cuSrc.slice(cuSrc.indexOf('async function dispatchPostType'), cuSrc.indexOf('async function dispatchPostType') + 2600);
  assert.match(body, /alive = await input\.windowInfo\(foreground\.hwnd\)/);
  assert.match(body, /Number\(alive\.pid\) !== Number\(foreground\.pid\)/);
  // C# 侧再核一次 pid（双保险）
  assert.match(inputSrc, /if \(GetWindowThreadProcessId\(w, out pid\) == 0 \|\| \(expectedPid != 0 && pid != expectedPid\)\) \{/);
  assert.match(inputSrc, /return "ERR\|ownership-mismatch";/);
  // 逐字符循环里复查窗口还活着
  assert.match(inputSrc, /if \(!IsWindow\(target\)\) return "ERR\|window-closed";/);
});

// ---- 默认路径载荷逐字段不变 ----

test('post: 默认路径载荷与 0.29.10 相同（无 delivery 字段；type 仍是 op:type + text + guard）', () => {
  // JS typeText 原样
  assert.match(inputSrc, /export async function typeText\(text, \{ guard \} = \{\}\) \{ await send\(\{ op: 'type', text: String\(text\), guard \}\); \}/);
  // computer-use 的默认 dispatch 不变
  const dispatch = cuSrc.slice(cuSrc.indexOf('async function dispatchAction'), cuSrc.indexOf('export function shutdown'));
  assert.match(dispatch, /return input\.typeText\(params\.text, \{ guard \}\);/);
  assert.doesNotMatch(dispatch, /delivery/);
  // post 分支只在显式 delivery 时进入
  assert.match(cuSrc, /if \(params\.delivery === 'post'\) \{/);
});

// ---- 源码钉：runAction 里 post 分支的位置与拒绝形态 ----

test('钉: post 分支在参数校验之后、遮挡校验之前；白名单外明确 deny 不降级', () => {
  const body = cuSrc.slice(cuSrc.indexOf('async function runAction'), cuSrc.indexOf('function validateActionArguments'));
  const argCheck = body.indexOf('const invalidArguments = validateActionArguments(action, params);');
  const post = body.indexOf("if (params.delivery === 'post') {");
  const occl = body.indexOf('const blocker = occludedBy(top, foreground);');
  assert.ok(argCheck >= 0 && post > argCheck, 'post 分支在参数校验之后');
  assert.ok(occl < 0 || post < occl, 'post 分支在遮挡校验之前（键盘动作本来没有 points，但顺序必须固定）');
  assert.match(body, /return deny\('delivery-not-whitelisted'/);
  assert.match(body, /绝不静默降级/);
  // 投递失败也不回退 SendInput（回退会把「后台」变成「抢前台」）
  assert.match(body, /return deny\('delivery-failed'/);
  assert.doesNotMatch(body.slice(post, post + 1800), /input\.typeText/);
});

test('钉: delivery 参数只接受 post（不传=默认路径）', () => {
  assert.match(cuSrc, /if \(params\.delivery != null && params\.delivery !== 'post'\) \{/);
  assert.match(cuSrc, /delivery 只支持 "post"/);
});

test('钉: schema 暴露 delivery 与 wait_for（模型能看到）', () => {
  const serviceSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-service.mjs'), 'utf8');
  const schemaLine = serviceSrc.split('\n').find((l) => l.includes("name: 'computer_action'"));
  assert.match(schemaLine, /delivery: \{ type: 'string', enum: \['post'\]/);
  assert.match(schemaLine, /wait_for: \{ type: 'object'/);
  assert.match(schemaLine, /element-exists', 'element-gone', 'value-equals', 'value-contains'/);
});

test('钉: 白名单导出可单测，源码里没有内联第二份副本', () => {
  assert.match(postSrc, /export const POST_DELIVERY_WHITELIST = Object\.freeze\(\[/);
  // computer-use 必须引用同一常量模块（不得自己维护一份名单）
  assert.match(cuSrc, /from '\.\/post-delivery\.mjs'/);
  assert.doesNotMatch(cuSrc, /POST_DELIVERY_WHITELIST/);
});
