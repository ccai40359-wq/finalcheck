// 0.30.0 特性 1：UIA 优先点击（被遮挡时 UIA 富应用走无障碍接口穿透；其它应用仍拒绝）
//
// 真机前提（D:/fc-bench-0291/uia-poc/）：AutomationElement.FromPoint 在被遮挡时返回**遮挡窗**元素
// （z-order 命中测试），因此穿透必须走「目标 hwnd FromHandle → 自己的子树几何命中 → 归属断言 → Invoke」。
// 本文件钉住：三态适用性 / 回退表 / 协议解析 / 动作白名单 / 源码分支顺序 / P0 R2+R3 / 契约透传。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  UIA_NO_TREE_PATTERNS, UIA_RICH_PATTERNS, classifyUiaError, parseUiaResponse,
  rememberUiaVerdict, uiaApplicability, uiaClickEligible
} from '../desktop/src/main/uia-adapter.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cuSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-use.mjs'), 'utf8');
const uiaSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/uia-adapter.mjs'), 'utf8');
// C# 宿主脚本正文（注释里会提到 FromPoint/AssertPoint 作为「不要这么做」的说明，钉必须只看代码）
const uiaScript = uiaSrc.slice(uiaSrc.indexOf('const UIA_PS_SCRIPT = String.raw`'), uiaSrc.indexOf('let uiaProc = null;'));

// ---- uiaApplicability 三态 ----

test('uiaApplicability: 白名单富应用 → uia（记事本/计算器/Office/资源管理器/字符映射表）', () => {
  for (const name of ['notepad', 'Notepad.exe', 'calc', 'Calculator', 'ApplicationFrameHost',
    'explorer', 'charmap', 'winword', 'excel', 'mspaint', 'notepad++']) {
    assert.equal(uiaApplicability(name), 'uia', `${name} 应为 uia`);
  }
});

test('uiaApplicability: 无 UIA 树的应用 → skip（微信/Electron/Chromium/终端/本产品）', () => {
  for (const name of ['weixin', 'WeChat', 'WeChatAppEx', 'Weixin.exe', 'chrome', 'msedge', 'electron',
    'code', 'cursor', 'FinalCheck', 'ZCode', 'WindowsTerminal', 'mintty', 'idea', 'notion']) {
    assert.equal(uiaApplicability(name), 'skip', `${name} 应为 skip（零延迟，不试探）`);
  }
});

test('uiaApplicability: 未知进程 → unknown（可探一次再学习）；空名 → skip', () => {
  assert.equal(uiaApplicability('mysteryapp'), 'unknown');
  assert.equal(uiaApplicability(''), 'skip');
  assert.equal(uiaApplicability(null), 'skip');
  assert.equal(uiaApplicability(undefined), 'skip');
});

test('uiaApplicability: 按进程名缓存（学习结果直接生效，不改全局表）', () => {
  const cache = new Map();
  assert.equal(uiaApplicability('mysteryapp', { cache }), 'unknown');
  rememberUiaVerdict(cache, 'MysteryApp.exe', 'uia');
  assert.equal(uiaApplicability('mysteryapp', { cache }), 'uia');
  rememberUiaVerdict(cache, 'other.exe', 'skip');
  assert.equal(uiaApplicability('OTHER', { cache }), 'skip');
  // 非法 verdict 不写入（只缓存确定结论）
  rememberUiaVerdict(cache, 'x.exe', 'unknown');
  assert.equal(cache.has('x.exe'), false);
  rememberUiaVerdict(new Map(), 'y.exe', 'uia'); // 非 Map 时静默忽略
  rememberUiaVerdict(cache, '', 'uia');
  assert.equal(cache.size, 2);
});

test('uiaApplicability: 白名单与排除表互斥（同一个名字不会同时命中两边）', () => {
  // 防回归：微信/Electron 若被误加进富应用表，就会去试探（双倍延迟）
  const sample = ['notepad', 'calc', 'weixin', 'chrome', 'msedge', 'code', 'explorer', 'charmap'];
  for (const name of sample) {
    const rich = UIA_RICH_PATTERNS.some((re) => re.test(name));
    const noTree = UIA_NO_TREE_PATTERNS.some((re) => re.test(name));
    assert.ok(!(rich && noTree), `${name} 同时命中两边`);
  }
});

// ---- classifyUiaError 回退表 ----

test('classifyUiaError: 只有 no-pattern/element-not-found/stale-element/ownership-mismatch 允许回退', () => {
  for (const code of ['no-pattern', 'element-not-found', 'stale-element', 'ownership-mismatch']) {
    assert.deepEqual(classifyUiaError(code), { code, fallbackAllowed: true }, code);
  }
});

test('classifyUiaError: invoke 发出后的超时/RPC 错误绝不回退（会双击，微信重复发送）', () => {
  for (const code of ['invoke-rpc-error', 'timeout', 'com-error', 'host-error', 'unknown']) {
    const r = classifyUiaError(code);
    assert.equal(r.fallbackAllowed, false, `${code} 不得回退`);
  }
  assert.deepEqual(classifyUiaError(''), { code: 'unknown', fallbackAllowed: false });
  assert.deepEqual(classifyUiaError(null), { code: 'unknown', fallbackAllowed: false });
});

// ---- 动作白名单 ----

test('uiaClickEligible: 只有单击左键走 UIA（不做拖拽/滚动/右键/中键/连击）', () => {
  assert.equal(uiaClickEligible('click'), true);
  assert.equal(uiaClickEligible('left_click'), true);
  for (const action of ['right_click', 'middle_click', 'double_click', 'triple_click',
    'drag', 'left_click_drag', 'scroll', 'move', 'type', 'key', 'focus']) {
    assert.equal(uiaClickEligible(action), false, `${action} 不得走 UIA`);
  }
});

// ---- 协议解析 ----

test('parseUiaResponse: OK 六段解析（含空控件名——WinUI MenuItem 实测 name=""）', () => {
  const ok = parseUiaResponse('OK|Settings|Button|17788|0|1|invoke|22');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.element, {
    name: 'Settings', controlType: 'Button', pid: 17788, nativeWindowHandle: 0,
    hostVerified: true, pattern: 'invoke', visited: 22
  });
  // OK||MenuItem|… 第一段为空串：不能因为空名而错位（第一版踩过，controlType 变成了 pid）
  const unnamed = parseUiaResponse('OK||MenuItem|17788|0|1|invoke|24');
  assert.equal(unnamed.ok, true);
  assert.equal(unnamed.element.name, '');
  assert.equal(unnamed.element.controlType, 'MenuItem');
  assert.equal(unnamed.element.pid, 17788);
});

test('parseUiaResponse: ERR 带 code 与消息；未知/空响应归为 host-error', () => {
  const err = parseUiaResponse('ERR|no-pattern|hit=Document visited=3');
  assert.equal(err.ok, false);
  assert.equal(err.code, 'no-pattern');
  assert.equal(err.message, 'hit=Document visited=3');
  assert.equal(parseUiaResponse('ERR|element-not-found').code, 'element-not-found');
  assert.equal(parseUiaResponse('').code, 'host-error');
  assert.equal(parseUiaResponse('garbage output').code, 'host-error');
});

// ---- 源码钉：C# 侧穿透与归属 ----

test('钉：穿透必须走目标 hwnd 的子树几何命中，不得用 FromPoint 当主路径', () => {
  // FromPoint 是 z-order 命中测试，被遮挡时返回遮挡窗元素（真机实证）→ 绝不能作为穿透实现
  assert.doesNotMatch(uiaScript, /AutomationElement\.FromPoint/);
  // 主动路径：FromHandle(target) + 包含命中 + 取面积最小
  assert.match(uiaSrc, /AutomationElement\.FromHandle\(h\)/);
  assert.match(uiaSrc, /HitInSubtree\(root, x, y, out visited\)/);
  assert.match(uiaSrc, /double area = r\.Width \* r\.Height;/);
  assert.match(uiaSrc, /if \(area < bestArea\)/);
  // 剪枝：只下钻包含命中点的元素（点不在父矩形内时子元素不可能命中）
  assert.match(uiaSrc, /bool inside = px >= r\.X && px < r\.X \+ r\.Width && py >= r\.Y && py < r\.Y \+ r\.Height;/);
  assert.match(uiaSrc, /if \(!inside\) continue;/);
  // 有节点预算，防超大 UIA 树卡死
  assert.match(uiaSrc, /NODE_BUDGET = 3000/);
  assert.match(uiaSrc, /visited < NODE_BUDGET/);
});

test('钉 R2/R3：UIA 路径自行复刻 hwnd 归属断言（不依赖 C# AssertPoint）', () => {
  // 归属判定：就近取第一个带 NativeWindowHandle 的祖先，GA_ROOT == 目标 hwnd
  const ownedBy = uiaSrc.slice(uiaSrc.indexOf('static bool OwnedBy'), uiaSrc.indexOf('static AutomationElement Actionable'));
  assert.match(ownedBy, /long nwh = SafeNwh\(cur\);/);
  assert.match(ownedBy, /IntPtr root = GetAncestor\(h, GA_ROOT\);/);
  assert.match(ownedBy, /return root == target;/);
  // 命中元素与最终目标都要过归属断言
  assert.match(uiaSrc, /if \(!OwnedBy\(hit, h\)\) return "ERR\|ownership-mismatch\|element-outside-target"/);
  assert.match(uiaSrc, /if \(!OwnedBy\(target, h\)\) return "ERR\|ownership-mismatch\|target-outside-window"/);
  // pid 二次核对（窗口 pid 变了 = 窗口被复用/换进程）
  assert.match(uiaSrc, /if \(GetWindowThreadProcessId\(h, out actualPid\) == 0 \|\| \(pid != 0 && actualPid != \(uint\)pid\)\)/);
  assert.match(uiaSrc, /return "ERR\|ownership-mismatch\|pid-changed"/);
  // 绝不调用注入层的 AssertPoint（UIA 绕过了它，必须自己断言）
  // 注释里允许提到 AssertPoint（说明「不能用它」），但绝不允许真的调用
  assert.doesNotMatch(uiaScript, /AssertPoint\(|AssertPoint\b\s*[;.]/);
});

test('钉 R3：invoke 之前/之后的错误分类严格分离（发出后超时绝不回退）', () => {
  // started 标记：只有「已开始 Invoke」的异常才归为 invoke-rpc-error（非回退）
  assert.match(uiaSrc, /bool started = false;/);
  assert.match(uiaSrc, /started = true;\s*\r?\n\s*p\.Invoke\(\);/);
  assert.match(uiaSrc, /return started \? "ERR\|invoke-rpc-error\|element-vanished-after-invoke" : "ERR\|stale-element\|element-vanished";/);
  assert.match(uiaSrc, /return "ERR\|" \+ \(started \? "invoke-rpc-error" : "com-error"\)/);
});

test('钉：只按几何命中向上冒泡找可执行控件（不做全树遍历找「最近可 Invoke 元素」）', () => {
  const actionable = uiaSrc.slice(uiaSrc.indexOf('static AutomationElement Actionable'), uiaSrc.indexOf('public static string Probe'));
  assert.match(actionable, /for \(int i = 0; i < 6 && cur != null; i\+\+\)/); // 最多 6 层
  assert.match(actionable, /InvokePattern\.Pattern/);
  assert.match(actionable, /SelectionItemPattern\.Pattern/);
  assert.match(actionable, /TogglePattern\.Pattern/);
  assert.match(actionable, /cur = TreeWalker\.ControlViewWalker\.GetParent\(cur\)/);
});

test('钉：UIA 宿主与键鼠宿主分离（各自常驻进程，UIA 卡住不拖累注入热路径）', () => {
  assert.match(uiaSrc, /let uiaProc = null;/);
  assert.match(uiaSrc, /spawn\('powershell', \['-NoProfile', '-NonInteractive', '-Command', UIA_PS_SCRIPT\]/);
  assert.doesNotMatch(uiaSrc, /from '\.\/desktop-input-win\.mjs'/);
  // DPI 纪律与注入层一致（UIA 矩形与 GetWindowRect 同在物理坐标空间）
  assert.match(uiaSrc, /SetThreadDpiAwarenessContext\(new IntPtr\(-4\)\)/);
});

// ---- 源码钉：runAction 分支顺序与 P0 归属 ----

const runActionBody = cuSrc.slice(cuSrc.indexOf('async function runAction'), cuSrc.indexOf('function validateActionArguments'));

test('钉：runAction 分支顺序 = tier/授权 → screenshot_id → sameObservation → focus → 坐标 → 遮挡(UIA 放行) → dispatch', () => {
  const order = [
    'const blocked = checkPolicy(foreground, action);',
    'shot.screenshotId !== params.screenshotId',
    'const observationOk = keyboard',
    'if (keyboard && (!foreground.focusHwnd || foreground.focusHwnd !== shot.focusHwnd))',
    'points = actionPoints(action, params, shot);',
    'const invalidArguments = validateActionArguments(action, params);',
    'const blocker = occludedBy(top, foreground);',
    'await dispatchAction(action, params, points, guard);'
  ];
  let at = -1;
  for (const needle of order) {
    const next = runActionBody.indexOf(needle);
    assert.ok(next > at, `分支顺序错误：${needle} 应在上一项之后`);
    at = next;
  }
});

test('钉 P0：UIA 分支复用 checkActionAllowed + ledger 授权，且 screenshot_id 四指纹不变', () => {
  // 授权/层级检查在 UIA 分支之前（UIA 不得绕过 read-tier 或授权台账）
  assert.match(cuSrc, /const blocked = checkPolicy\(foreground, action\);/);
  assert.match(cuSrc, /const policy = checkActionAllowed\(foreground\.tier, action\);/);
  assert.match(cuSrc, /if \(!ledger\.isGranted\(foreground\.process\)\)/);
  // 四指纹（hwnd+pid+bounds+title）核对仍在 UIA 之前
  assert.match(cuSrc, /const observationOk = keyboard/);
  assert.match(cuSrc, /sameObservation\(shot\.foreground, foreground\)/);
  // 显示器几何核对不受 UIA 影响
  assert.match(cuSrc, /sameBounds\(shot\.virtualScreen, state\.virtualScreen\)/);
  // shot.bounds 语义（0.29.4 P0）：仍是全屏物理 bounds，UIA 分支不碰
  assert.match(cuSrc, /captureBounds: shot\.bounds, virtualScreen: shot\.virtualScreen/);
});

test('钉：UIA 不得出现在 count>1 / right / middle / drag / scroll 分支', () => {
  // eligibility 门：只有 click/left_click + 单点
  assert.match(cuSrc, /const uiaEligible = uiaClickEligible\(action\)/);
  assert.match(cuSrc, /&& points\.length === 1/);
  // dispatchAction 保持原样（click 的 button/count 由 clickActions 表决定；UIA 分支只处理 left 单击）
  const dispatch = cuSrc.slice(cuSrc.indexOf('async function dispatchAction'), cuSrc.indexOf('export function shutdown'));
  assert.match(dispatch, /const \[button, count\] = clickActions\.get\(action\);/);
  assert.doesNotMatch(dispatch, /uia/i); // 派发层不得出现 UIA
  // 连击/右键/中键的动作表原样（UIA 未篡改）
  assert.match(cuSrc, /\['double_click', \['left', 2\]\], \['triple_click', \['left', 3\]\]/);
  assert.match(cuSrc, /\['right_click', \['right', 1\]\], \['middle_click', \['middle', 1\]\]/);
});

test('钉：skip 应用零延迟（不做 UIA 尝试，直接按 0.29.7 拒绝）；unknown 才探测', () => {
  // veredict 门在 windowAtPoint 之前算好：skip 时根本不会调 uiaInvokeAt
  assert.match(cuSrc, /uiaApplicability\(foreground\.process, \{ cache: uiaVerdicts \}\) !== 'skip'/);
  // 遮挡循环里：skip → 不进 tryUiaClick → 直接 deny('occluded', …)
  assert.match(cuSrc, /if \(uiaEligible\) \{\s*\r?\n\s*const viaUia = await tryUiaClick\(foreground, point\);/);
  assert.match(cuSrc, /return deny\('occluded'/);
});

test('钉：成功走 UIA 后不再 SendInput（否则会在遮挡窗上再点一次）', () => {
  const body = runActionBody.slice(runActionBody.indexOf('if (uiaAttempted?.ok)'), runActionBody.indexOf('// 0.29.7（A3 反过度思考）'));
  assert.match(body, /setCuMode\(true\);/);
  assert.match(body, /return \{ \.\.\.actionResult\(action, foreground\), uia: uiaAttempted\.summary \};/);
  assert.doesNotMatch(body, /dispatchAction/);
});

test('钉：UIA 失败后按回退表决定——允许回退才落 SendInput，否则抛错不作废截图逻辑不变', () => {
  // tryUiaClick 返回 fallbackAllowed（由 classifyUiaError 决定）；只有 !uiaEligible 或 skip 才直接 deny
  assert.match(cuSrc, /const classified = classifyUiaError\(r\.code\);/);
  assert.match(cuSrc, /fallbackAllowed: classified\.fallbackAllowed/);
  // 无 UIA 根 → 学习为 skip（后续动作零延迟）
  assert.match(cuSrc, /rememberUiaVerdict\(uiaVerdicts, foreground\.process, 'skip'\)/);
  assert.match(cuSrc, /rememberUiaVerdict\(uiaVerdicts, foreground\.process, 'uia'\)/);
});

test('钉：成功后不得新增 latestScreenshot = null（A3 反过度思考行为不变）', () => {
  assert.doesNotMatch(runActionBody, /if \(!keyboard\) latestScreenshot = null;/);
  assert.match(runActionBody, /catch \(error\) \{\s*\r?\n\s*latestScreenshot = null;\s*\r?\n\s*throw error;/);
});

test('钉：shutdown 关 UIA 宿主（不留孤儿 PowerShell）', () => {
  const shutdown = cuSrc.slice(cuSrc.indexOf('export function shutdown'));
  assert.match(shutdown, /try \{ shutdownUia\(\); \} catch/);
  assert.match(shutdown, /input\.shutdownInput\(\);/);
});

// ---- 契约：结果字段透传（mock 引擎）----

test('contract: UIA 成功结果带 uia.summary 透传到工具层（hit/controlType/pattern）', async () => {
  const { createAgentTools } = await import('../desktop/src/main/agent-tools.mjs');
  const calls = [];
  const tools = createAgentTools({
    repoRoot,
    getDesktopToolsAsync: async () => ({
      computerUse: {
        async performAction(action, params) {
          calls.push({ action, params });
          return {
            ok: true, action, foregroundAtAction: { hwnd: 1, pid: 2, process: 'notepad', title: 'x' },
            note: '动作已发送。', uia: { hit: 'Settings', controlType: 'Button', pattern: 'invoke', verified: true, elapsedMs: 12 }
          };
        }
      },
      browserUse: {}
    })
  });
  const r = await tools.computer_action({ action: 'left_click', x: 10, y: 10, screenshot_id: 'sid' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.uia, { hit: 'Settings', controlType: 'Button', pattern: 'invoke', verified: true, elapsedMs: 12 });
});

test('contract: 遮挡拒绝带 uia 诊断信息（applicable/reason）；ok:false 时透传', async () => {
  const { createAgentTools } = await import('../desktop/src/main/agent-tools.mjs');
  const tools = createAgentTools({
    repoRoot,
    getDesktopToolsAsync: async () => ({
      computerUse: {
        async performAction() {
          return {
            ok: false, deniedBy: 'occluded', error: '目标被「记事本」遮挡…',
            uia: { applicable: 'skip', reason: null }
          };
        }
      },
      browserUse: {}
    })
  });
  const r = await tools.computer_action({ action: 'left_click', x: 1, y: 1, screenshot_id: 'sid' });
  assert.equal(r.ok, false);
  assert.equal(r.deniedBy, 'occluded');
  assert.deepEqual(r.uia, { applicable: 'skip', reason: null });
});
