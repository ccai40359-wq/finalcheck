// Electron 截图与 Windows 输入之间的授权和坐标校验。
import { randomUUID } from 'node:crypto';
import { desktopCapturer, screen, nativeImage } from 'electron';
import * as input from './desktop-input-win.mjs';
import { tierForApp, checkActionAllowed, AccessLedger, describeTier } from './computer-use-policy.mjs';
import {
  actionPoints, matchesImageGeometry, matchesProcess, overlapBounds, sameBounds, sameObservation, selectCaptureSource, thumbnailSize
} from './computer-use-geometry.mjs';

const ledger = new AccessLedger();
const clickActions = new Map([
  ['click', ['left', 1]], ['left_click', ['left', 1]],
  ['right_click', ['right', 1]], ['middle_click', ['middle', 1]],
  ['double_click', ['left', 2]], ['triple_click', ['left', 3]]
]);
const otherActions = new Set(['move', 'drag', 'left_click_drag', 'scroll', 'type', 'key', 'focus']);
let latestScreenshot = null;
let operationQueue = Promise.resolve();

function withDesktopOperation(operation) {
  const result = operationQueue.then(operation);
  operationQueue = result.catch(() => {});
  return result;
}

export function grantedApps() { return ledger.list(); }
export function grantApps(names) { return ledger.grant(names); }
export function revokeApps() {
  latestScreenshot = null;
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

async function capture({ target = 'screen', windowTitle = '', maxWidth = 1560 } = {}) {
  const isWindow = target === 'window';
  const display = primaryDisplay();
  const before = isWindow ? null : await desktopContext();
  const requestedSize = thumbnailSize(display.bounds, maxWidth);
  const sources = await desktopCapturer.getSources({
    types: isWindow ? ['window'] : ['screen'],
    thumbnailSize: requestedSize,
    fetchWindowIcons: false
  });
  const { source, error } = selectCaptureSource(sources, { target: isWindow ? 'window' : 'screen', displayId: display.id, windowTitle });
  if (error) return { ok: false, error };

  let image = source.thumbnail;
  if (!image || image.isEmpty()) return { ok: false, error: '截图为空（窗口可能最小化或内容受到保护）。' };
  const after = await desktopContext();
  const foreground = after.foreground;
  const original = image.getSize();
  if (original.width > requestedSize.width) image = image.resize({ width: requestedSize.width, quality: 'best' });
  const { width, height } = image.getSize();

  let observationOnlyReason = null;
  if (isWindow) {
    observationOnlyReason = '窗口截图仅供查看。请截取主显示器后再执行桌面动作。';
  } else if (!sameObservation(before.foreground, foreground)) {
    observationOnlyReason = '截图期间未能确认同一个前台窗口。请重截主显示器。';
  } else if (!sameDisplay(display, primaryDisplay()) || !canUseDisplay(display, before) ||
    !canUseDisplay(display, after) || !sameBounds(before.virtualScreen, after.virtualScreen) ||
    !matchesImageGeometry({ width, height }, display.bounds)) {
    observationOnlyReason = '无法确认截图与物理屏幕的坐标对应。当前截图仅供查看。';
  } else if (!overlapBounds(foreground.bounds, display.bounds)) {
    observationOnlyReason = '主显示器截图未覆盖前台窗口。请将窗口移到主显示器后重新截图。';
  } else if (foreground.tier === 'read') {
    observationOnlyReason = '当前前台应用属于只读级别。';
  }

  const screenshotId = randomUUID();
  const canAct = !observationOnlyReason;
  const buf = isWindow ? image.toPNG() : image.toJPEG(92);
  if (!buf.length) return { ok: false, error: '截图编码失败。' };

  latestScreenshot = {
    screenshotId, canAct, observationOnlyReason, display, width, height,
    bounds: display.bounds, foreground, virtualScreen: after.virtualScreen,
    focusHwnd: before?.foreground?.focusHwnd === foreground?.focusHwnd ? foreground?.focusHwnd : null
  };
  return {
    ok: true, buf, mime: isWindow ? 'image/png' : 'image/jpeg', width, height, screenshotId, canAct,
    observationOnlyReason,
    scale: isWindow ? original.width / width : display.bounds.width / width,
    source: { id: source.id, name: source.name },
    sourceCount: sources.length,
    foreground: brief(foreground),
    virtualScreen: after.virtualScreen ?? null
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

function deny(deniedBy, error, foreground) {
  return { ok: false, deniedBy, error, foreground: brief(foreground) };
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
    : '动作已发送。请重新截图确认结果。';
  return { ok: true, action, foregroundAtAction: brief(foreground), note };
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
  const { foreground } = state;
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
  if (!sameObservation(shot.foreground, foreground)) {
    latestScreenshot = null;
    return deny('foreground-mismatch', '截图所记录的前台窗口已变化。请切回目标窗口并重新截图。', foreground);
  }
  if (!sameDisplay(shot.display, primaryDisplay()) || !canUseDisplay(shot.display, state) ||
    !sameBounds(shot.virtualScreen, state.virtualScreen)) {
    latestScreenshot = null;
    return deny('screenshot-required', '显示器布局已变化。请重新截图。', foreground);
  }

  const keyboard = action === 'type' || action === 'key';
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

  // 指针动作后重新观察。只有成功的键盘输入可以沿用截图。
  if (!keyboard) latestScreenshot = null;
  try {
    await dispatchAction(action, params, points, guard);
  } catch (error) {
    latestScreenshot = null;
    throw error;
  }
  return actionResult(action, foreground);
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
  input.shutdownInput();
}

export { nativeImage };
