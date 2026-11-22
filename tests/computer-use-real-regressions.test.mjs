// CU 真机测试踩到的问题（2026-11-21），全部固化成回归：
// 这三个都不是单测能想到的，只有真的在 Windows 上跑才暴露。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const inputSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/desktop-input-win.mjs'), 'utf8');
const cuSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-use.mjs'), 'utf8');

test('cu-real: stdin 非 ASCII 必须转义成 \\uXXXX（否则中文变「娴嬭瘯」）', () => {
  // 真机现象：输入「FC测试输入」，页面上出现「1FC娴嬭瘯杈撳叆」
  // 根因：PowerShell 的 stdin 按系统 ANSI（中文 Windows = GBK）解码 UTF-8 中文
  // 按行找关键词，避免正则/转义歧义
  const lines = inputSrc.split('\n');
  const escapeLine = lines.find((l) => l.includes('JSON.stringify(cmd).replace('));
  assert.ok(escapeLine, '必须有对 cmd JSON 的转义处理');
  const codeLine = lines.find((l) => l.includes("'0000' + c.charCodeAt(0)"));
  assert.ok(codeLine, '必须把字符转成 \\uXXXX 形式（ASCII 安全）');
  const sendLine = lines.find((l) => l.includes('stdin.write'));
  assert.ok(sendLine && sendLine.includes('pending.json'), 'next() 必须发预转义的那个');
});

test('cu-real: PowerShell 输出编码必须设成 UTF-8（否则读窗口标题的中文会乱码）', () => {
  assert.match(inputSrc, /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
});

test('cu-real: guarded focus uses Windows policy and reports actual foreground', () => {
  const guardedFocus = inputSrc.slice(inputSrc.indexOf('public static bool GuardedFocus'), inputSrc.indexOf('public static string CursorPos'));
  assert.match(guardedFocus, /GetWindowThreadProcessId\(target, out pid\)/);
  assert.match(guardedFocus, /return GetForegroundWindow\(\) == target/);
  assert.doesNotMatch(guardedFocus, /AttachThreadInput/);
  assert.match(cuSrc, /!result\.ok \|\| !result\.becameForeground/);
});

test('cu-real: GetCurrentThreadId 必须从 kernel32 导入（user32 里没有这个入口点）', () => {
  // 真机报错：无法在 DLL "user32.dll" 中找到名为 "GetCurrentThreadId" 的入口点
  const tidLine = inputSrc.split('\n').find((l) => l.includes('GetCurrentThreadId') && l.includes('DllImport'));
  assert.ok(tidLine, '必须有 GetCurrentThreadId 的 DllImport 声明');
  assert.ok(tidLine.includes('kernel32'), '它必须从 kernel32 导入，实际：' + (tidLine || '').trim());
});

test('cu-real: action binds screenshot identity and performs foreground checks again in the native helper', () => {
  assert.match(cuSrc, /shot\.screenshotId !== params\.screenshotId/);
  assert.match(cuSrc, /sameObservation\(shot\.foreground, foreground\)/);
  assert.match(inputSrc, /foreground\.ToInt64\(\) != guard\.hwnd \|\| pid != guard\.pid/);
  assert.match(inputSrc, /GetAncestor\(window, GA_ROOT\)\.ToInt64\(\) != guard\.hwnd/);
  assert.match(inputSrc, /inserted != events\.Length/);
});

test('cu-real: desktopContext waits for the helper before querying desktop state', () => {
  const fnBody = cuSrc.slice(cuSrc.indexOf('async function desktopContext'), cuSrc.indexOf('export async function foregroundContext'));
  assert.match(fnBody, /await input\.ensureInputReady\(\);\s+const state = await input\.desktopState\(\)/);
});

test('cu-real: capture keeps legacy scale metadata without accepting it from actions', () => {
  const fnBody = cuSrc.slice(cuSrc.indexOf('async function capture('));
  assert.match(fnBody, /scale:/);
  assert.doesNotMatch(cuSrc, /params\.scale/);
});

test('cu-real: guarded key validates one chord and checks foreground and child focus before each dispatch', () => {
  const key = inputSrc.slice(inputSrc.indexOf('public static void Key'), inputSrc.indexOf('public static void TypeText'));
  const guarded = key.slice(key.indexOf('if (repeat < 1'));
  assert.match(guarded, /repeat > 100/);
  assert.match(guarded, /GuardedKeyEvents\(keyName\)/);
  // 0.29.2：键盘入口不再比 title（打字会加未保存脏标记 *，title 变化是自己造成的）；
  // 身份由 hwnd+pid 保证，落点由 focus 复核保证；指针路径（false, true）不受影响。
  assert.match(guarded, /AssertForeground\(guard, true, false\);\s+Submit\(events, events\.Length \/ 2\)/);
  assert.doesNotMatch(guarded, /SendKeys/);
  assert.match(inputSrc.slice(inputSrc.indexOf('public static void TypeText'), inputSrc.indexOf('public static bool GuardedFocus')), /AssertForeground\(guard, true, false\);\s*\r?\n\s*foreach/);
  assert.match(cuSrc, /before\?\.foreground\?\.focusHwnd === foreground\?\.focusHwnd/);
  // 0.29.7（A3 反过度思考）：指针动作成功后不再强制作废截图（同一窗口连续操作可复用 screenshot_id）；
  // 安全网仍在：下一次动作前 sameObservation 全量比对 + 注入层 AssertForeground/AssertPoint 复核。
  const runActionBody = cuSrc.slice(cuSrc.indexOf('async function runAction'), cuSrc.indexOf('function validateActionArguments'));
  assert.doesNotMatch(runActionBody, /if \(!keyboard\) latestScreenshot = null;/);
  assert.match(runActionBody, /catch \(error\) \{\s*\r?\n\s*latestScreenshot = null;\s*\r?\n\s*throw error;/); // 失败路径仍作废（状态未知 → 强制重截）
  // 0.29.2：JS 层键盘动作只认窗口身份（hwnd+pid），指针动作仍走含 title 的完整比对
  assert.match(cuSrc, /const observationOk = keyboard\s*\r?\n\s*\? sameWindow\(shot\.foreground, foreground\)\s*\r?\n\s*: sameObservation\(shot\.foreground, foreground\);/);
  // 0.29.2：指针路径的 title 复核必须保持——键盘放宽不允许外溢到指针
  assert.match(inputSrc, /AssertForeground\(guard, false, true\);/);
});

// ---- 0.29.7（B）遮挡校验：点击前校验落点顶层窗口（WindowFromPoint）必须属于目标 hwnd/同进程 ----
test('cu-real: pointer actions verify the top window at the landing point and name the occluder on denial', () => {
  // C# 侧：point-owner 查询用 WindowFromPoint + GA_ROOT（与 AssertPoint 同一套结构，DPI 已配置）
  assert.match(inputSrc, /public static Window PointOwner\(int x, int y\)/);
  const pointOwner = inputSrc.slice(inputSrc.indexOf('public static Window PointOwner'), inputSrc.indexOf('static POINT ReadCursor'));
  assert.match(pointOwner, /WindowFromPoint\(new POINT \{ X = x, Y = y \}\)/);
  assert.match(pointOwner, /GetAncestor\(hit, GA_ROOT\)/);
  assert.match(inputSrc, /"point-owner" \{/);
  // JS 侧：runAction 指针路径在派发前逐点校验；命中遮挡 → deniedBy 'occluded' 并点名遮挡窗，不自动最小化
  const runActionBody = cuSrc.slice(cuSrc.indexOf('async function runAction'), cuSrc.indexOf('function validateActionArguments'));
  assert.match(runActionBody, /input\.windowAtPoint\(point\.x, point\.y\)/);
  assert.match(runActionBody, /occludedBy\(top, foreground\)/);
  assert.match(runActionBody, /deny\('occluded'/);
  assert.match(runActionBody, /请移开遮挡窗口或调整布局/);
  assert.doesNotMatch(runActionBody, /ShowWindow|SW_MINIMIZE|minimize/i); // 绝不自动最小化遮挡窗
  // keyboard 路径不涉及：遮挡校验在 validateActionArguments 之后、按 points 循环，键盘动作没有 points
});

test('cu-real: occlusion is judged on window ownership, not foreground (no refocus reuse)', () => {
  // 遮挡不是前台漂移：不复用 auto-refocus 路径（0.29.3 限频仲裁保持独立）
  assert.match(cuSrc, /0\.29\.7（遮挡校验）：指针动作落点的顶层窗口/);
  const geometrySrc = cuSrc; // occludedBy 从 geometry 导入
  assert.match(geometrySrc, /occludedBy, overlapBounds/);
  assert.match(cuSrc, /now - lastAutoRefocusAt > 1200/); // refocus 仲裁原样保留
});

test('cu-real: foreground drift arbitration auto-refocuses granted targets and yields to the user', () => {
  // 0.29.3：前台漂移仲裁（微信六轮迭代的产物）——r5/r6 实测托盘/浏览器抢前台时一律拒绝会让
  // 多步操作全军覆没；run_command 自写注入脚本则绕过安全层还把微信搞锁死。
  assert.match(cuSrc, /0\.29\.3：前台漂移仲裁/);
  assert.match(cuSrc, /now - lastAutoRefocusAt > 1200/); // 自动拉回前台限频，防循环抢前台锁死用户
  assert.match(cuSrc, /paused: true, deniedBy: 'user-active'/); // 拉不回来 = 用户占用 → 让位不硬抢
  assert.match(cuSrc, /input\.focusWindow\(hwnd, \{ target, guard: null \}\)/);
});

test('cu-real: native point checks include an existing mouse-capture owner', () => {
  const point = inputSrc.slice(inputSrc.indexOf('static void AssertPoint'), inputSrc.indexOf('static POINT ReadCursor'));
  assert.match(point, /info\.capture != IntPtr\.Zero && GetAncestor\(info\.capture, GA_ROOT\)\.ToInt64\(\) != guard\.hwnd/);
});

// 0.29.6 打包回归钉：index.mjs 对 computer-use 必须用 engineUrl 动态加载，禁止静态 import。
// 0.29.2-0.29.5 打包版金色遮罩从未显示过——静态 import 的 onComputerUseModeChange 订阅被
// electron-vite 摇树删除（bundle 里 enterCuMode/CU_OVERLAY_HTML 全消失），dev 模式正常所以只在安装版暴露。
test('打包钉：index.mjs 的 CU 遮罩订阅必须走 engineUrl 动态加载（静态 import 会被摇树删）', async () => {
  const { readFileSync } = await import('node:fs');
  const pathMod = await import('node:path');
  const repo = pathMod.resolve(pathMod.dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(pathMod.join(repo, 'desktop/src/main/index.mjs'), 'utf8');
  assert.ok(!/import\s*\{[^}]*onComputerUseModeChange[^}]*\}\s*from\s*'\.\/computer-use\.mjs'/.test(src),
    '禁止静态 import computer-use（会被 electron-vite 摇树删）');
  assert.ok(src.includes("await import(engineUrl('desktop/src/main/computer-use.mjs'))"),
    '订阅必须动态加载同一模块实例（engineUrl 与 agent-tools 的运行时实例同路径）');
  assert.ok(src.includes('enterCuMode() : exitCuMode()'), '进入/退出分支仍在');
});

// 0.29.7 用户拍板的 UI 三条（金色化/屏幕顶部居中/ESC 全局退出）+ 迷你对话窗
test('打包钉：CU 遮罩金色化+横幅屏幕顶部居中+提示 ESC；ESC 全局注册在 CU 模式期间', async () => {
  const { readFileSync } = await import('node:fs');
  const pathMod = await import('node:path');
  const repo = pathMod.resolve(pathMod.dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(pathMod.join(repo, 'desktop/src/main/index.mjs'), 'utf8');
  assert.ok(src.includes("background:rgba(214,158,52,.15)"), '全屏蒙层必须是金色淡染（不再是黑）');
  assert.ok(src.includes('left:50%;transform:translateX(-50%)'), '横幅必须屏幕顶部居中');
  assert.ok(src.includes('color:#f2c566'), '横幅/停止条文字必须是金色');
  assert.ok(src.includes('按 ESC 或点右上角小窗'), '提示必须写明 ESC 可中止');
  assert.ok(src.includes("globalShortcut.register('Escape'"), 'CU 模式期间注册全局 ESC');
  assert.ok(src.includes("globalShortcut.unregister('Escape'"), '退出 CU 模式必须注销 ESC');
  const css = readFileSync(pathMod.join(repo, 'desktop/src/renderer/styles.css'), 'utf8');
  assert.ok(css.includes('body.fc-cu-mini .fc-sidebar { display: none !important; }'),
    '迷你形态开关=body.fc-cu-mini（CU 生命周期驱动，不用 @media 窗口宽度——composer-narrow 布局纪律）');
  assert.ok(css.includes('body.fc-cu-mini .fc-chat-header { display: none !important; }'),
    '迷你形态隐藏会话标题头（360px 下标题只会截断成噪音）');
  assert.ok(css.includes('body.fc-cu-mini [data-testid="message-scroll"] * { overflow-wrap: anywhere; }'),
    '迷你形态长 token 必须折行——横向零裁剪（用户验收：对话 100% 显示完全）');
  const header = readFileSync(pathMod.join(repo, 'desktop/src/renderer/components/ChatHeader.jsx'), 'utf8');
  assert.ok(header.includes('fc-chat-header'), 'ChatHeader 必须带 fc-chat-header 类钩子');
  assert.ok(src.includes("classList.add('fc-cu-mini')") && src.includes("classList.remove('fc-cu-mini')"),
    '主进程负责挂/摘 fc-cu-mini（注入/恢复两个方向都要有）');
  // 0.29.9 根因钉：主窗 minWidth=980 时不先放宽下限，360px setBounds 会被 Windows 拒绝，
  // 迷你样式全白做（0.29.7/0.29.8 就是这么失效的）。
  assert.ok(src.includes('win.setMinimumSize(300, 200)'), '进 CU 模式必须先放宽尺寸下限（否则 360px 缩不下去）');
  assert.ok(src.includes('cuSavedMinSize'), '退出时必须有恢复下限的状态变量');
  assert.ok(!src.includes('wa.width - 372'), '旧的 372 偏移写法应已被替换');
});
