// Electron 截图与 Windows 输入之间的授权和坐标校验。
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { desktopCapturer, screen, nativeImage } from 'electron';
import * as input from './desktop-input-win.mjs';
import { tierForApp, checkActionAllowed, AccessLedger, describeTier } from './computer-use-policy.mjs';
import {
  actionPoints, matchesImageGeometry, matchesProcess, normalizeRegion, occludedBy, overlapBounds, sameBounds, sameObservation, sameWindow, selectCaptureSource, thumbnailSize
} from './computer-use-geometry.mjs';
import { createWindowCapture, windowSourceId } from './computer-window-capture.mjs';
import { detectWinapp, winappScreenshotCommand, parseWinappScreenshotJson } from './winapp-cli.mjs';
import {
  classifyUiaError, rememberUiaVerdict, shutdownUia, uiaApplicability, uiaClickEligible, uiaInvokeAt, uiaObserve
} from './uia-adapter.mjs';
import { hasChordModifiers, postDeliveryDecision, postDeliveryResult } from './post-delivery.mjs';
import { makeFailFast, normalizeTimeout, waitForCondition } from './wait-for.mjs';

const execFileAsync = promisify(execFile);

const ledger = new AccessLedger();
const clickActions = new Map([
  ['click', ['left', 1]], ['left_click', ['left', 1]],
  ['right_click', ['right', 1]], ['middle_click', ['middle', 1]],
  ['double_click', ['left', 2]], ['triple_click', ['left', 3]]
]);
const otherActions = new Set(['move', 'drag', 'left_click_drag', 'scroll', 'type', 'key', 'focus']);
let latestScreenshot = null;
let operationQueue = Promise.resolve();
let lastAutoRefocusAt = 0; // 0.29.3：前台漂移自动拉回的限频（1.2s），防止循环抢前台锁死用户
// 0.30.0（特性 1）：进程名 → 'uia'|'skip' 的适用性缓存（避免每动作 COM 遍历；探测结论学一次）
const uiaVerdicts = new Map();

// ---- CU 模式广播（0.29.2）：全屏遮罩 + 主窗迷你化的开关信号，由 index.mjs 订阅 ----
// 0.30.0（追加项 4，真 bug 修复）：遮罩表示「CU 会话进行中」，不是「刚成功执行了一个动作」。
// 0.29.3 的 paused 让位（前台被用户占用 → 让位等「继续」）只作废截图，但回合收尾的
// endComputerUseSession 会退遮罩 → 用户回复「继续」后模型先跑 run_command/read_file 时，
// 屏幕长时间没有遮罩/迷你窗（真机反馈）。修法：paused 时置 pauseHold，回合收尾遇到
// pauseHold 只作废截图、保留遮罩，并清掉 pauseHold（一次性续期：下一个回合收尾正常退出）。
// 只有「会话真正结束」（回合收尾且没有 paused 续期）或「用户主动中止」（ESC/cu-stop/revoke/
// shutdown）才退遮罩。
let cuModeActive = false;
let cuModeListener = null;
let pauseHold = false;
export function onComputerUseModeChange(cb) {
  cuModeListener = typeof cb === 'function' ? cb : null;
  if (cuModeActive) { try { cb?.(true); } catch { /* 订阅方故障不影响桌面操作 */ } }
}
function setCuMode(active) {
  // 0.30.0：任何显式的模式切换都清掉 paused 续期标记——成功恢复动作（active=true）说明会话已经在动，
  // 不需要再为「等继续」续命；真正的退出（active=false）更是终态。
  pauseHold = false;
  if (cuModeActive === active) return;
  cuModeActive = active;
  try { cuModeListener?.(active); } catch { /* UI 故障不影响桌面操作 */ }
}
export function resumeCuMode() {
  // 0.30.0：显式恢复入口（ipc-agent 在用户「继续」且上一轮 paused 时可调用）。
  // 当前实现采用「paused 保留遮罩」方案，正常路径不需要它；保留导出用于外部恢复/自检。
  if (!cuModeActive) setCuMode(true);
}
export function endComputerUseSession() {
  latestScreenshot = null;
  if (pauseHold) { pauseHold = false; return; } // 0.30.0：paused 让位后的续期——遮罩留着，下一回合收尾再退
  setCuMode(false);
}

function withDesktopOperation(operation) {
  const result = operationQueue.then(operation);
  operationQueue = result.catch(() => {});
  return result;
}

export function grantedApps() { return ledger.list(); }
export function grantApps(names) { return ledger.grant(names); }
export function revokeApps() {
  latestScreenshot = null;
  setCuMode(false);
  return ledger.revokeAll();
}

function withPolicy(foreground) {
  if (!foreground?.process) return null;
  const tier = tierForApp(foreground.process, foreground.title);
  return { ...foreground, tier, tierLabel: describeTier(tier), granted: ledger.isGranted(foreground.process) };
}

function brief(foreground) {
  if (!foreground) return null;
  const { hwnd, pid, process, title, tier, tierLabel, granted } = foreground;
  return { hwnd, pid, process, title, tier, tierLabel, granted };
}

async function desktopContext() {
  if (!input.inputSupported()) {
    return { ok: false, reason: '当前平台不支持桌面操作（目前只实现了 Windows）' };
  }
  try {
    await input.ensureInputReady();
    const state = await input.desktopState();
    return { ok: true, ...state, foreground: withPolicy(state.foreground) };
  } catch (error) {
    return { ok: false, reason: `无法读取桌面状态：${error?.message || error}` };
  }
}

export async function foregroundContext() {
  const state = await desktopContext();
  if (!state.ok) return state;
  if (!state.foreground) return { ok: false, reason: '无法识别当前前台窗口。' };
  return { ok: true, ...state.foreground };
}

function primaryDisplay() {
  const display = screen.getPrimaryDisplay();
  const bounds = input.inputSupported()
    ? screen.dipToScreenRect(null, display.bounds)
    : { ...display.bounds };
  return { id: display.id, bounds };
}

function sameDisplay(first, second) {
  return first.id === second.id && sameBounds(first.bounds, second.bounds);
}

function canUseDisplay(display, state) {
  return state?.physicalCoordinates && sameBounds(display.bounds, state.primaryScreen);
}

export function captureScreen(options = {}) {
  return withDesktopOperation(async () => {
    latestScreenshot = null;
    try {
      return await capture(options);
    } catch (error) {
      return { ok: false, error: `截图失败：${error?.message || error}` };
    }
  });
}

// 0.29.4：region 截图（两段式：全屏导航 → 区域读字）。
// region = {x,y,width,height} 物理像素整数（主显示器左上角为原点）：
// 按屏幕原生物理尺寸取帧（绕过 thumbnailSize 的 0.609 缩放帽），nativeImage.crop 零重采样裁剪，
// 输出图像尺寸 == region 尺寸，坐标 1:1 映射回屏幕（mapScreenshotPoint 的 region 分支）。
// ⚠️ shot.bounds 必须保持全屏物理 bounds（原生层 captureBounds.Matches(PrimaryBounds()) 断言依赖它），
// region 只存独立字段，绝不写进 bounds。0.29.7-beta 起窗口 rect 同样只存独立字段 windowRect。
async function capture({ target = 'screen', windowTitle = '', maxWidth = 1560, region = null, hwnd = null } = {}) {
  if (target === 'window') {
    if (region) return { ok: false, error: 'region 只支持全屏截图（target 用默认的 screen）。' };
    return captureWindowFrame({ windowTitle, hwnd });
  }
  return captureScreenFrame({ maxWidth, region });
}

// ③ 现行 screen 捕获（screen 永远兜底：窗口模式的 ①② 不可用时也落到这里）。
async function captureScreenFrame({ maxWidth = 1560, region = null, fallbackNote = '' } = {}) {
  const display = primaryDisplay();
  if (region) {
    const checked = normalizeRegion(region, display.bounds);
    if (checked.error) return { ok: false, error: checked.error };
    region = checked.region;
  }
  const before = await desktopContext();
  const requestedSize = region
    ? { width: display.bounds.width, height: display.bounds.height }
    : thumbnailSize(display.bounds, maxWidth);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: requestedSize,
    fetchWindowIcons: false
  });
  const { source, error } = selectCaptureSource(sources, { target: 'screen', displayId: display.id });
  if (error) return { ok: false, error };

  let image = source.thumbnail;
  if (!image || image.isEmpty()) return { ok: false, error: '截图为空（窗口可能最小化或内容受到保护）。' };
  const after = await desktopContext();
  const foreground = after.foreground;
  const original = image.getSize();
  if (region) {
    // 取不到原生分辨率的帧就放弃裁剪：任何重采样都会破坏 1:1 坐标映射，宁可报错也不给错图。
    if (original.width !== requestedSize.width || original.height !== requestedSize.height) {
      return { ok: false, error: `无法按原生分辨率取帧（得到 ${original.width}x${original.height}，需要 ${requestedSize.width}x${requestedSize.height}）。请改用不带 region 的全屏截图。` };
    }
    image = image.crop({ x: region.x, y: region.y, width: region.width, height: region.height });
  } else if (original.width > requestedSize.width) {
    image = image.resize({ width: requestedSize.width, quality: 'best' });
  }
  const { width, height } = image.getSize();

  let observationOnlyReason = null;
  if (!sameObservation(before.foreground, foreground)) {
    observationOnlyReason = '截图期间未能确认同一个前台窗口。请重截主显示器。';
  } else if (!sameDisplay(display, primaryDisplay()) || !canUseDisplay(display, before) ||
    !canUseDisplay(display, after) || !sameBounds(before.virtualScreen, after.virtualScreen) ||
    !matchesImageGeometry({ width, height }, display.bounds, region)) {
    observationOnlyReason = '无法确认截图与物理屏幕的坐标对应。当前截图仅供查看。';
  } else if (!overlapBounds(foreground.bounds, display.bounds)) {
    observationOnlyReason = '主显示器截图未覆盖前台窗口。请将窗口移到主显示器后重新截图。';
  } else if (foreground.tier === 'read') {
    observationOnlyReason = '当前前台应用属于只读级别。';
  }

  const screenshotId = randomUUID();
  const canAct = !observationOnlyReason;
  const buf = image.toJPEG(92);
  if (!buf.length) return { ok: false, error: '截图编码失败。' };
  if (canAct) setCuMode(true);

  latestScreenshot = {
    screenshotId, canAct, observationOnlyReason, display, width, height,
    // 0.29.4 P0 红线：bounds 仍是全屏物理 bounds；region/windowRect 都是独立字段，不进 bounds。
    bounds: display.bounds, foreground, virtualScreen: after.virtualScreen,
    focusHwnd: before?.foreground?.focusHwnd === foreground?.focusHwnd ? foreground?.focusHwnd : null,
    windowSource: 'screen',
    windowRect: null,
    region: region ?? null
  };
  return {
    ok: true, buf, mime: 'image/jpeg', width, height, screenshotId, canAct,
    observationOnlyReason,
    scale: region ? 1 : display.bounds.width / width,
    windowSource: 'screen',
    windowRect: null,
    region: region ?? null,
    source: { id: source.id, name: source.name },
    sourceCount: sources.length,
    foreground: brief(foreground),
    virtualScreen: after.virtualScreen ?? null,
    note: fallbackNote || null
  };
}

// ② winapp ui screenshot -w <hwnd> -o <file> --json（微软 winappcli v0.8.0，可选增强；
// WGC 优先、旧系统回退 PrintWindow，--capture-screen 才是拍屏幕——这里只拍窗口自身）。
// 输出是窗口原生物理尺寸 PNG；--json 里的 Width/Height 用于交叉校验（防黑图/拍错窗当成功）。
async function winappScreenshotViaCli(exe, hwnd) {
  const out = path.join(os.tmpdir(), `finalcheck-winapp-${Number(hwnd)}-${Date.now()}.png`);
  const cmd = winappScreenshotCommand(exe, hwnd, out);
  try {
    const r = await execFileAsync(cmd.file, cmd.args, { timeout: 20000, windowsHide: true });
    // winapp 的 JSON 在 stdout；部分版本会混入警告行 → parse 失败就当无元数据（不阻断）
    const meta = parseWinappScreenshotJson(r?.stdout);
    const png = fs.readFileSync(out);
    return { ok: png.length > 0, png, meta };
  } finally {
    try { fs.unlinkSync(out); } catch { /* 临时文件清不掉就留给系统清理 */ }
  }
}

// ①→② 级窗口捕获（依赖注入见 computer-window-capture.mjs；null = 两级都不可用 → ③ 兜底）。
const captureWindowImage = createWindowCapture({
  getSources: (options) => desktopCapturer.getSources(options),
  winappDetect: () => detectWinapp(),
  winappScreenshot: winappScreenshotViaCli,
  createImage: (png) => nativeImage.createFromBuffer(png)
});

// 0.29.7-beta：target='window' 主路径切「窗口自身捕获」（WGC）。
// 入参 hwnd（可选）缺省 = 当前前台目标窗口；window_title 走源列表定位后同样解析成 hwnd。
// 链：① desktopCapturer 窗口 thumbnail（按 hwnd 匹配源，thumbnailSize=窗口原生物理尺寸）
//     ② winapp ui screenshot --hwnd（运行时探测，缺失即跳过）
//     ③ captureScreenFrame（永远兜底；最小化直接走 ③ 并在 note 注明）
// shot.bounds 语义不变（全屏物理 bounds）；windowRect 存独立字段（0.29.4 region 同款思路）。
async function captureWindowFrame({ windowTitle = '', hwnd = null } = {}) {
  const display = primaryDisplay();
  const before = await desktopContext();
  if (!before.ok) return { ok: false, error: before.reason };

  let target = null;
  if (hwnd != null && hwnd !== '') {
    const n = Number(hwnd);
    if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, error: 'hwnd 必须是正整数。' };
    target = await input.windowInfo(n).catch(() => null);
    if (!target?.hwnd) return { ok: false, error: `找不到 hwnd=${n} 对应的窗口（可能已关闭）。` };
  } else if (String(windowTitle).trim()) {
    // 标题片段 → 源列表定位 → 源 id 解析 hwnd（certainty A：id 中间数字 == GetWindowRect 的 hwnd）
    // → windowInfo 校验目标仍存在。
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    } catch { sources = []; }
    const { source, error } = selectCaptureSource(sources, { target: 'window', displayId: display.id, windowTitle });
    if (error) return { ok: false, error };
    const parsed = /^window:(\d+):\d+$/.exec(source.id);
    if (!parsed) return { ok: false, error: `截图源 id 无法解析出窗口句柄（${source.id}）。` };
    target = await input.windowInfo(Number(parsed[1])).catch(() => null);
    if (!target?.hwnd) return { ok: false, error: '匹配到的窗口已关闭或不可查询。' };
  } else {
    target = before.foreground;
    if (!target?.hwnd) return { ok: false, error: '无法确定目标窗口：请传 hwnd，或让目标处于前台后重试。' };
  }

  const rect = target.bounds;
  if (!rect || !Number.isSafeInteger(rect.width) || !Number.isSafeInteger(rect.height) ||
    rect.width < 2 || rect.height < 2) {
    return { ok: false, error: '目标窗口没有有效的物理矩形（可能已最小化或正被系统收起）。' };
  }

  // 最小化：WGC 帧冻结拍不到、源也从列表消失（certainty PoC 实测）→ 直接走 ③ 全屏兜底。
  let got = null;
  if (target.iconic !== true) {
    got = await captureWindowImage({ hwnd: target.hwnd, rect }).catch(() => null);
  }
  if (!got) {
    return captureScreenFrame({
      maxWidth: 1560, region: null,
      fallbackNote: target.iconic === true
        ? '目标已最小化，窗口捕获不可用，已回退全屏。'
        : '窗口捕获不可用（窗口源未找到/被重采样，或 winapp 缺失/失败），已回退全屏。'
    });
  }

  const after = await desktopContext();
  const foreground = after.foreground;
  const { image, level } = got;
  const original = image.getSize();
  const width = original.width;
  const height = original.height;
  if (width < 2 || height < 2) return { ok: false, error: '窗口截图尺寸无效。' };

  // canAct 只在「目标窗口就是前台窗口」时给出：动手链路的 every 校验（sameObservation /
  // AssertForeground / B 遮挡拒绝）照旧生效——窗口捕获解决「看」，B 解决「点」。
  let observationOnlyReason = null;
  if (!sameWindow(target, foreground)) {
    observationOnlyReason = '窗口截图仅供观察：目标窗口当前不在前台。请先把它切到前台再动手。';
  } else if (!sameObservation(before.foreground, foreground)) {
    observationOnlyReason = '截图期间未能确认同一个前台窗口。请重截。';
  } else if (!sameDisplay(display, primaryDisplay()) || !canUseDisplay(display, before) ||
    !canUseDisplay(display, after) || !sameBounds(before.virtualScreen, after.virtualScreen)) {
    observationOnlyReason = '无法确认截图与物理屏幕的坐标对应。当前截图仅供观察。';
  } else if (foreground.tier === 'read') {
    observationOnlyReason = '当前前台应用属于只读级别。';
  }

  const screenshotId = randomUUID();
  const canAct = !observationOnlyReason;
  const buf = image.toPNG();
  if (!buf.length) return { ok: false, error: '截图编码失败。' };
  if (canAct) setCuMode(true);

  latestScreenshot = {
    screenshotId, canAct, observationOnlyReason, display, width, height,
    // 0.29.4 P0 红线：bounds 仍是全屏物理 bounds（原生层 captureBounds.Matches(PrimaryBounds())
    // 断言依赖它）；窗口 rect 存独立字段 windowRect（带 imageWidth/imageHeight 供 mapWindowPoint
    // 做 scale 映射），绝不写进 bounds。
    bounds: display.bounds, foreground, virtualScreen: after.virtualScreen,
    focusHwnd: before?.foreground?.focusHwnd === foreground?.focusHwnd ? foreground?.focusHwnd : null,
    windowSource: level,
    windowRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, imageWidth: width, imageHeight: height },
    region: null
  };
  return {
    ok: true, buf, mime: 'image/png', width, height, screenshotId, canAct,
    observationOnlyReason,
    scale: rect.width / width,
    windowSource: level,
    windowRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    region: null,
    source: { id: windowSourceId(target.hwnd), name: target.title ?? '' },
    foreground: brief(foreground),
    virtualScreen: after.virtualScreen ?? null,
    note: `已用窗口自身捕获（${level === 'winapp' ? 'winapp CLI' : 'WGC 窗口 thumbnail'}）看清全貌；` +
      (canAct
        ? '被遮挡时：UIA 富应用可用无障碍接口直接点中（不依赖像素可见性），其它应用仍拒绝并点名遮挡窗。'
        : '动手前需将目标切到前台。被遮挡时：UIA 富应用可用无障碍接口直接点中，其它应用仍会被拒绝并点名遮挡窗。')
  };
}

export async function listWindows() {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
  return sources.map(({ id, name }) => ({ id, name }));
}

function checkPolicy(foreground, action) {
  const policy = checkActionAllowed(foreground.tier, action);
  if (!policy.ok) return { ok: false, deniedBy: 'tier', error: policy.reason, foreground: brief(foreground) };
  if (!ledger.isGranted(foreground.process)) {
    return {
      ok: false, deniedBy: 'access', needAccess: foreground.process, foreground: brief(foreground),
      error: `应用「${foreground.process}」还没有获得操作授权。请先调用 computer_request_access。`
    };
  }
  return null;
}

function deny(deniedBy, error, foreground, extra = null) {
  return { ok: false, deniedBy, error, foreground: brief(foreground), ...(extra || {}) };
}

function foregroundGuard(foreground) {
  return { hwnd: foreground.hwnd, pid: foreground.pid, title: foreground.title, windowBounds: foreground.bounds };
}

async function performFocus(params, foreground) {
  const hwnd = Number(params.hwnd);
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0) return { ok: false, error: 'focus 需要有效的目标窗口句柄。' };
  const target = withPolicy(await input.windowInfo(hwnd));
  if (!target || !matchesProcess(target.process, params.expectProcess)) {
    return deny('foreground-mismatch', '找不到与目标身份匹配的窗口。', foreground);
  }
  const blocked = checkPolicy(target, 'focus');
  if (blocked) return blocked;
  if (target.tier === 'read') return deny('tier', '当前目标窗口属于只读级别。', target);
  const currentBlocked = checkPolicy(foreground, 'focus');
  if (currentBlocked) return currentBlocked;

  latestScreenshot = null;
  const result = await input.focusWindow(hwnd, { target, guard: foregroundGuard(foreground) });
  if (!result.ok || !result.becameForeground) {
    return { ok: false, deniedBy: 'foreground-mismatch', error: 'Windows 未能将目标窗口切到前台。请手动切换后重新截图。' };
  }
  return actionResult('focus', target);
}

function actionResult(action, foreground) {
  const keyboard = action === 'type' || action === 'key';
  const note = keyboard
    ? '已发送键盘输入。相同窗口和键盘焦点可沿用截图 ID。需要核对结果时请重新截图。'
    : '动作已发送。同一窗口内连续点击/输入可沿用截图 ID 连续操作；提交/保存/删除类动作完成后请重新截图复查结果。';
  return { ok: true, action, foregroundAtAction: brief(foreground), note };
}

/**
 * 0.30.0（特性 3）：wait-for 求值（工具层的 computer_action.wait_for 调它）。
 * - 目标 hwnd：waitFor.target.hwnd 或当前前台窗口（缺省）。
 * - 观测：目标窗口自己的 UIA 子树（名字 + 值）。UIA 不适用（微信/Electron）→ R10 快速失败。
 * - R7：超时返回 ok:true/matched:false/timedOut:true，绝不是 ok:false。
 */
export async function waitFor(waitFor = {}) {
  const condition = String(waitFor?.condition ?? '').trim();
  const selector = String(waitFor?.target?.selector ?? '').trim();
  const value = typeof waitFor?.value === 'string' ? waitFor.value : '';
  const timeoutMs = normalizeTimeout(waitFor?.timeout_ms);
  const state = await desktopContext();
  if (!state.ok) {
    return { ok: true, matched: false, timedOut: false, attempts: 0, elapsedMs: 0, windowClosed: true, reason: state.reason };
  }
  const foreground = state.foreground;
  const hwnd = Number(waitFor?.target?.hwnd) || Number(foreground?.hwnd) || 0;
  if (!hwnd) {
    return { ok: true, matched: false, timedOut: false, attempts: 0, elapsedMs: 0, windowClosed: true, reason: '无法确定等待目标的窗口句柄' };
  }
  // R10：进程没有 UIA 树（微信/Electron/Chromium）→ 一次就返回，不硬等满超时
  const processName = Number(waitFor?.target?.hwnd) ? (await input.windowInfo(hwnd).catch(() => null))?.process : foreground?.process;
  const failFast = makeFailFast(condition, processName, { cache: uiaVerdicts });
  const result = await waitForCondition({
    condition, selector, value, timeoutMs,
    observe: async () => {
      // hwnd 存活 + pid 匹配：投递途中窗口关闭 → 立即返回（R10）
      const info = await input.windowInfo(hwnd).catch(() => null);
      if (!info?.hwnd || info.hwnd !== hwnd) return { windowAlive: false, hasUiaTree: false, elements: [], values: [] };
      const obs = await uiaObserve(hwnd, { maxNodes: 400 });
      if (!obs.ok) {
        // 宿主失败/超时：按「这次没观测到」处理（不立刻判死，交给循环与预算）
        return { windowAlive: true, hasUiaTree: false, elements: [], values: [] };
      }
      return { windowAlive: obs.windowAlive, hasUiaTree: true, elements: obs.elements, values: obs.values };
    },
    failFast
  });
  return result;
}

export function performAction(action, params = {}) {
  return withDesktopOperation(async () => {
    try {
      return await runAction(action, params);
    } catch (error) {
      const message = String(error?.message || error);
      const deniedBy = ['foreground-mismatch', 'screenshot-required'].find((code) => message.startsWith(`${code}:`));
      if (deniedBy) {
        return {
          ok: false, deniedBy,
          error: '输入前的窗口、指针位置或显示器校验失败。请确认目标窗口并重新截图。'
        };
      }
      return { ok: false, error: `动作执行失败：${message}` };
    }
  });
}

async function runAction(action, params) {
  if (!clickActions.has(action) && !otherActions.has(action)) return { ok: false, error: `不认识的桌面动作：${action}` };
  const state = await desktopContext();
  if (!state.ok) return { ok: false, error: state.reason };
  let foreground = state.foreground;
  if (!foreground) return deny('foreground-mismatch', '无法确认前台窗口。请重新截图。');
  const blocked = checkPolicy(foreground, action);
  if (blocked) return blocked;
  if (action === 'focus') return performFocus(params, foreground);

  if (!matchesProcess(foreground.process, params.expectProcess)) {
    return deny('foreground-mismatch', `前台进程是「${foreground.process}」，与指定进程「${params.expectProcess}」不匹配。`, foreground);
  }

  const shot = latestScreenshot;
  if (!shot?.canAct || shot.screenshotId !== params.screenshotId) {
    return deny('screenshot-required', shot?.observationOnlyReason || '请传入最近一次可用于操作的主显示器截图 ID。', foreground);
  }
  const keyboard = action === 'type' || action === 'key';
  // 0.29.2：键盘动作只认窗口身份（hwnd+pid）——打字本身会改窗口标题（未保存脏标记 *），
  // title 严格比对会把「自己刚打出来的标题变化」误判成前台切换，文本编辑类任务每打一段就被拒一次。
  // 防误点的关键防线不变：键盘焦点必须还是截图时的那个（下面 focusHwnd 检查 + C# 注入层 focus 复核）。
  const observationOk = keyboard
    ? sameWindow(shot.foreground, foreground)
    : sameObservation(shot.foreground, foreground);
  if (!observationOk) {
    // 0.29.3：前台漂移仲裁。r5/r6 实测：托盘/浏览器反复抢前台时，一律拒绝会让多步操作
    // 全军覆没（deniedBy 风暴）；而 run_command 自写注入脚本又绕过安全层、还把微信搞锁死。
    // 正确形态：目标窗口仍在且已授权 → 限频（1.2s）自动拉回前台再核一次；拉不回来 =
    // 用户/系统在持续占用 → paused 让位（绝不与用户抢前台、绝不循环重试）。
    const now = Date.now();
    const hwnd = shot.foreground?.hwnd;
    let foregroundNow = foreground;
    let recovered = false;
    let attempted = false;
    if (hwnd && now - lastAutoRefocusAt > 1200) {
      attempted = true;
      lastAutoRefocusAt = now;
      const winInfo = await input.windowInfo(hwnd).catch(() => null);
      const target = winInfo ? withPolicy(winInfo) : null;
      if (target && matchesProcess(target.process, shot.foreground.process)) {
        // 目标已验过授权与身份，此处的 focus 只是把被抢走的前台要回来，guard 留空
        await input.focusWindow(hwnd, { target, guard: null });
        const after = await desktopContext();
        if (after.ok && after.foreground && sameWindow(after.foreground, shot.foreground)) {
          foreground = after.foreground;
          foregroundNow = after.foreground;
          recovered = true;
        }
      }
    }
    if (attempted && !recovered) {
      latestScreenshot = null;
      // 0.30.0（追加项 4）：paused 只作废截图（状态未知必须重截），**不退 CU 模式**——
      // 遮罩/迷你窗表示「会话进行中」，用户回「继续」后模型可能先跑 run_command 再回到桌面，
      // 此时遮罩必须还在。续期标记 pauseHold 让「本回合收尾」也不退，下一回合收尾再退。
      pauseHold = true;
      return {
        ok: false, paused: true, deniedBy: 'user-active',
        error: `前台被「${foregroundNow?.process ?? '其它应用'}」持续占用（两次拉回「${shot.foreground.process}」都没成功），已暂停让位。请完成你的操作后回复「继续」，我会接着做。`,
        foreground: brief(foregroundNow)
      };
    }
    if (!recovered) {
      latestScreenshot = null;
      return deny('foreground-mismatch', keyboard
        ? '键盘焦点所在的窗口与截图记录的不是同一个。请重新截图。'
        : '截图所记录的前台窗口已变化。请切回目标窗口并重新截图。', foreground);
    }
  }
  if (!sameDisplay(shot.display, primaryDisplay()) || !canUseDisplay(shot.display, state) ||
    !sameBounds(shot.virtualScreen, state.virtualScreen)) {
    latestScreenshot = null;
    return deny('screenshot-required', '显示器布局已变化。请重新截图。', foreground);
  }

  if (keyboard && (!foreground.focusHwnd || foreground.focusHwnd !== shot.focusHwnd)) {
    latestScreenshot = null;
    return deny('foreground-mismatch', '截图所记录的键盘焦点已变化或无法确认。请重新截图。', foreground);
  }
  const guard = {
    ...foregroundGuard(foreground), captureBounds: shot.bounds, virtualScreen: shot.virtualScreen,
    focusHwnd: foreground.focusHwnd
  };

  let points;
  try {
    points = actionPoints(action, params, shot);
  } catch (error) {
    return deny('invalid-coordinates', error.message, foreground);
  }

  const invalidArguments = validateActionArguments(action, params);
  if (invalidArguments) return { ok: false, error: invalidArguments };

  // 0.30.0（特性 2）：post-message 后台键盘。只有显式 delivery:'post' 才尝试；默认路径载荷
  // 与 0.29.10 逐字段相同（params 里没有 delivery 时行为完全不变）。
  // 白名单外 → 明确 deny('delivery-not-whitelisted')，绝不静默降级、绝不「先 post 失败再 SendInput」。
  if (params.delivery === 'post') {
    const chord = action === 'key' ? hasChordModifiers(params.keys ?? params.key) : false;
    const decision = postDeliveryDecision({
      processName: foreground.process, action, delivery: params.delivery, hasModifiers: chord
    });
    if (!decision.allowed) {
      return deny('delivery-not-whitelisted',
        decision.reason === 'chords-not-supported'
          ? '组合键不能走后台消息投递（WM_KEYDOWN 无法携带修饰键状态，结果不确定）。请用 SendInput（不传 delivery:"post"）。'
          : decision.reason === 'action-not-supported'
            ? '后台消息投递只支持 type（输入文字）。其它动作请用 SendInput。'
            : `应用「${foreground.process}」不在后台消息投递白名单（只对实测验证过的经典 Win32 程序启用，如记事本）。微信/Electron/Chromium 类必须用 SendInput（不传 delivery:"post"）。`,
        foreground);
    }
    const delivered = await dispatchPostType(foreground, params.text);
    if (!delivered.ok) {
      // 投递前就失败（窗口关闭/pid 变化/宿主错误）：不静默回退 SendInput——回退会把「后台」变成
      // 「抢前台」，与用户意图相反。
      return deny('delivery-failed', `后台消息投递失败：${delivered.error}。可用 SendInput 重试（不传 delivery:"post"）。`, foreground);
    }
    setCuMode(true);
    return {
      ...actionResult(action, foreground),
      ...postDeliveryResult({
        targetHwnd: delivered.targetHwnd, sent: delivered.sent, failed: delivered.failed, processName: foreground.process
      })
    };
  }

  // 0.29.7（遮挡校验）：指针动作落点的顶层窗口（WindowFromPoint 的 GA_ROOT）必须属于目标窗口
  // （同 hwnd / 子窗口 / 同进程），否则直接拒绝并点名遮挡窗口——绝不自动最小化遮挡窗。
  // 这不是前台问题，与 0.29.3 前台仲裁（auto-refocus 限频 1.2s）各走各的：遮挡不复用 refocus 路径。
  // 真机实证：绿按钮区域被别的窗口压住时，模型曾自写脚本像素扫描到 pixels=0 才 ABORT；这里让它
  // 一步拿到明确原因。查询失败/结果无效不拦（occludedBy 返回 null），不新增失败模式。
  //
  // 0.30.0（特性 1，用户拍板）：被遮挡时 UIA 富应用改用无障碍接口直接操作（不依赖像素可见性）；
  // 其它应用（无 UIA 树/微信）仍按 0.29.7 拒绝并点名遮挡窗。放行条件是**严格**的：
  //   ① 本次动作是单击左键（uiaClickEligible；拖拽/滚动/右键/中键/连击一律不走 UIA）
  //   ② 进程适用性判定为 'uia' 或 'unknown'（skip 直接拒绝，延迟增量 = 0，绝不试探）
  //   ③ 目标窗口自己的 UIA 子树在该点有可 Invoke 元素且归属断言通过（uiaInvokeAt/hostVerified）
  // 三者任一不成立 → 回到 0.29.7 的 occluded 拒绝（行为不放松）。
  const uiaEligible = uiaClickEligible(action)
    && points.length === 1
    && input.inputSupported()
    && uiaApplicability(foreground.process, { cache: uiaVerdicts }) !== 'skip';
  let uiaAttempted = null;
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    let top = null;
    try { top = await input.windowAtPoint(point.x, point.y); } catch { top = null; }
    const blocker = occludedBy(top, foreground);
    if (!blocker) continue;
    if (uiaEligible) {
      const viaUia = await tryUiaClick(foreground, point);
      if (viaUia) {
        uiaAttempted = viaUia;
        break; // 已用无障碍接口完成，不再走 SendInput（也不存在遮挡拒绝）
      }
    }
    return deny('occluded', `目标被「${blocker}」遮挡，请移开遮挡窗口或调整布局后重新截图再操作。` +
      (uiaEligible
        ? '（该应用未命中可用的 UIA 控件：' + (uiaAttempted?.error || '无') + '）'
        : '（该应用不支持无障碍接口穿透：' + (uiaApplicability(foreground.process, { cache: uiaVerdicts }) === 'skip' ? '无 UIA 树' : '该动作不走 UIA') + '）'), foreground, {
      uia: { applicable: uiaEligible ? 'yes' : 'skip', reason: uiaAttempted?.error ?? null }
    });
  }
  if (uiaAttempted?.ok) {
    // UIA 已点中：等价于动作成功（不返回给调用方看内部细节，但带 uia 标记便于排查）
    setCuMode(true);
    return { ...actionResult(action, foreground), uia: uiaAttempted.summary };
  }

  // 0.29.7（A3 反过度思考）：指针动作成功后不再强制作废截图——同一窗口内连续点击/输入可复用当前
  // screenshot_id（真机实测截图/看图占 27% 调用）。安全网不变：下一次动作前仍做 sameObservation
  // （hwnd+pid+title+bounds）核对，注入层 AssertForeground/AssertPoint 再复核一次，漂移/遮挡当场拒。
  // 提交/保存/删除类动作由提示词纪律要求重新截图复查（AUTOMATION_GUIDANCE + actionResult note）。
  // 回滚点：在 dispatchAction 之前恢复「指针动作成功后立即作废截图」的旧行为，即回到每动作强制重截。
  try {
    await dispatchAction(action, params, points, guard);
  } catch (error) {
    latestScreenshot = null;
    throw error;
  }
  setCuMode(true);
  return actionResult(action, foreground);
}

// 0.30.0（特性 1）：UIA 优先点击。用无障碍接口在目标窗口自己的 UIA 子树里命中并 Invoke，
// 不依赖像素可见性（FromPoint 在被遮挡时返回的是遮挡窗元素——真机实测，见 uia-adapter 头注释）。
// 归属/授权：runAction 上游已完成 tier 检查 + checkActionAllowed + ledger.isGranted（UIA 不绕过任何一层），
// 这里再自行复刻 hwnd+pid 归属断言（C# 侧 GetWindowThreadProcessId + GA_ROOT，不依赖 AssertPoint）。
// 失败分类严守 R3：只有「动作肯定没发生」的错误才回退 SendInput（no-pattern/element-not-found/
// stale-element/ownership-mismatch）；invoke 发出后的超时/RPC 错误绝不回退（会双击，微信重复发送）。
async function tryUiaClick(foreground, point) {
  const started = Date.now();
  try {
    const r = await uiaInvokeAt({ hwnd: foreground.hwnd, pid: foreground.pid, x: point.x, y: point.y });
    if (r.ok) {
      rememberUiaVerdict(uiaVerdicts, foreground.process, 'uia');
      return {
        ok: true,
        summary: {
          hit: r.element.name || r.element.controlType || '(unnamed)',
          controlType: r.element.controlType,
          pattern: r.element.pattern,
          verified: r.element.hostVerified,
          elapsedMs: Date.now() - started
        }
      };
    }
    const classified = classifyUiaError(r.code);
    // 探测结论学习：no-uia-root / pid-changed 说明这个应用没有可用树 → 记住 skip，后续动作零延迟。
    if (r.code === 'element-not-found' && /no-uia-root|window-closed/i.test(String(r.message ?? ''))) {
      rememberUiaVerdict(uiaVerdicts, foreground.process, 'skip');
    }
    return { ok: false, code: r.code, error: r.message, fallbackAllowed: classified.fallbackAllowed };
  } catch (error) {
    return { ok: false, code: 'host-error', error: String(error?.message || error), fallbackAllowed: false };
  }
}

// 0.30.0（特性 2）：post 投递执行——不做 SetForegroundWindow/AssertForeground（R6-c），
// 投递前复检目标窗口存活 + pid 匹配（R6-d），投递后再复检一次（窗口可能在投递途中关闭）。
async function dispatchPostType(foreground, text) {
  let alive = null;
  try { alive = await input.windowInfo(foreground.hwnd); } catch { alive = null; }
  if (!alive?.hwnd || Number(alive.pid) !== Number(foreground.pid)) {
    return { ok: false, error: '目标窗口已关闭或进程已变化' };
  }
  try {
    const r = await input.postTypeText(foreground.hwnd, text, { pid: foreground.pid });
    if (!r.ok) return { ok: false, error: `${r.code}${r.detail ? `（${r.detail}）` : ''}` };
    return { ok: true, targetHwnd: r.targetHwnd, sent: r.sent, failed: r.failed };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function validateActionArguments(action, params) {
  if (action === 'scroll') {
    const direction = params.direction ?? 'down';
    const amount = Number(params.amount ?? 3);
    if (!['up', 'down', 'left', 'right'].includes(direction) || !Number.isSafeInteger(amount) || amount < 1 || amount > 2147483647) {
      return '滚动需要有效的方向和正整数格数。';
    }
  } else if (action === 'key') {
    const keys = params.keys ?? params.key;
    const repeat = Number(params.repeat ?? 1);
    if (typeof keys !== 'string' || keys.length === 0 || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) {
      return '每次只发送一个按键或组合键，例如 Enter、Tab 或 Ctrl+S。重复次数需在 1 到 100 之间。';
    }
  } else if (action === 'type' && (typeof params.text !== 'string' || params.text.length === 0 || params.text.length > 4096)) {
    return '单次输入需要指定文字，最多 4096 个 UTF-16 代码单元。';
  }
  // 0.30.0（特性 2）：delivery 只接受 'post' 或不传（不传 = 默认 SendInput 路径，载荷与 0.29.10 一致）
  if (params.delivery != null && params.delivery !== 'post') {
    return 'delivery 只支持 "post"（后台消息投递）；不传即走默认键盘注入。';
  }
  return null;
}

async function dispatchAction(action, params, [first, second], guard) {
  if (clickActions.has(action)) {
    const [button, count] = clickActions.get(action);
    return input.click(first.x, first.y, { button, count, guard });
  }
  switch (action) {
    case 'move':
      return input.moveMouse(first.x, first.y, { guard });
    case 'drag':
    case 'left_click_drag':
      return input.drag(first.x, first.y, second.x, second.y, { guard });
    case 'scroll':
      return input.scroll(first?.x, first?.y, { dir: params.direction ?? 'down', amount: Number(params.amount ?? 3), guard });
    case 'type':
      return input.typeText(params.text, { guard });
    case 'key':
      return input.pressKey(params.keys ?? params.key, { repeat: Number(params.repeat ?? 1), guard });
  }
}

export function shutdown() {
  latestScreenshot = null;
  setCuMode(false);
  try { shutdownUia(); } catch { /* UIA 宿主可能未启动 */ }
  input.shutdownInput();
}

export { nativeImage };
