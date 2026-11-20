// Computer use 执行层（2026-11-21）：屏幕截图 + 授权检查 + 动作派发。
//
// 结构照 Claude Code 的 computer-use MCP server：
//   ① 每次动作前先看前台是什么应用 → 查 tier → 查是否已授权 → 再执行
//   ② 截图走 Electron desktopCapturer（零依赖，不引原生模块）
//   ③ 动作派发给 desktop-input-win.mjs 的常驻 PowerShell 进程（SendInput）
//   ④ 不判停、不限轮（用户既定「不要任何超时限制」），但每一步都可以被 tier 挡住
import { desktopCapturer, screen, nativeImage } from 'electron';
import * as input from './desktop-input-win.mjs';
import {
  tierForApp, checkActionAllowed, AccessLedger, describeTier
} from './computer-use-policy.mjs';

/** 进程级台账：一次应用生命周期内有效（重启要重新授权，和 CC 一样） */
const ledger = new AccessLedger();

export function grantedApps() { return ledger.list(); }
export function grantApps(names) { return ledger.grant(names); }
export function revokeApps() { return ledger.revokeAll(); }

/** 当前前台应用 + 其 tier + 是否已授权 */
export async function foregroundContext() {
  if (!input.inputSupported()) {
    return { ok: false, reason: '当前平台不支持桌面操作（目前只实现了 Windows）' };
  }
  // 必须先确保常驻进程起来了，否则 send() 会报「未就绪」（真实使用里第一次调用就会踩到）
  try { await input.ensureInputReady(); } catch (e) {
    return { ok: false, reason: `桌面输入进程启动失败：${e?.message || e}` };
  }
  const fg = await input.foregroundInfo();
  const tier = tierForApp(fg.process, fg.title);
  return { ok: true, ...fg, tier, tierLabel: describeTier(tier), granted: ledger.isGranted(fg.process) };
}

/**
 * 截屏（整屏或指定窗口）。
 * @param {{target?: 'screen'|'window', windowTitle?: string, maxWidth?: number}} opts
 */
export async function captureScreen({ target = 'screen', windowTitle = '', maxWidth = 1560 } = {}) {
  const display = screen.getPrimaryDisplay();
  const dsf = display.scaleFactor || 1;
  // 用显示器物理像素抓，模型看到的坐标就是真实屏幕坐标（避免 DPI 缩放导致点偏）
  const physicalW = Math.round(display.size.width * dsf);
  const physicalH = Math.round(display.size.height * dsf);
  const types = target === 'window' ? ['window'] : ['screen'];
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: Math.min(physicalW, 2560), height: Math.min(physicalH, 1600) },
    fetchWindowIcons: false
  });

  let src = sources[0];
  if (target === 'window' && windowTitle) {
    const want = String(windowTitle).toLowerCase();
    src = sources.find((s) => s.name.toLowerCase().includes(want)) || sources[0];
  }
  if (!src) return { ok: false, error: `没有抓到${target === 'window' ? '窗口' : '屏幕'}（desktopCapturer 无源）` };

  let img = src.thumbnail;
  if (!img || img.isEmpty()) return { ok: false, error: '截图为空（可能窗口最小化或受保护内容）' };
  const size = img.getSize();
  if (size.width > maxWidth) img = img.resize({ width: maxWidth, quality: 'best' });

  const fg = await foregroundContext().catch(() => null);
  const shot = img.toPNG();
  const finalSize = img.getSize();

  return {
    ok: true,
    buf: shot,
    mime: 'image/png',
    width: finalSize.width,
    height: finalSize.height,
    // 截图坐标 ↔ 屏幕坐标的换算：模型看的是缩过的图，点的时候要乘回去
    scale: size.width > 0 ? size.width / finalSize.width : 1,
    source: { id: src.id, name: src.name },
    sourceCount: sources.length,
    foreground: fg?.ok ? { process: fg.process, title: fg.title, tier: fg.tier, tierLabel: fg.tierLabel, granted: fg.granted } : null,
    virtualScreen: await input.ensureInputReady().catch(() => null)
  };
}

/** 列出可截的窗口（给模型挑） */
export async function listWindows() {
  const display = screen.getPrimaryDisplay();
  const dsf = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: Math.round(display.size.width * dsf * 0.4), height: Math.round(display.size.height * dsf * 0.4) }
  });
  return sources.map((s) => ({ id: s.id, name: s.name }));
}

/**
 * 执行一个动作：先过 tier/授权闸，再派发。
 * @param {string} action  'left_click' | 'right_click' | 'double_click' | 'type' | 'key' | 'scroll' | 'drag' | 'move'
 * @param {object} params
 */
export async function performAction(action, params = {}) {
  if (!input.inputSupported()) return { ok: false, error: '当前平台不支持桌面操作（目前只实现了 Windows）' };

  const fg = await foregroundContext();
  if (!fg.ok) return { ok: false, error: fg.reason };

  // ① tier 检查（前台应用决定）
  const policy = checkActionAllowed(fg.tier, action);
  if (!policy.ok) {
    return {
      ok: false,
      deniedBy: 'tier',
      error: policy.reason,
      foreground: { process: fg.process, title: fg.title, tier: fg.tier, tierLabel: fg.tierLabel }
    };
  }

  // ② 逐应用授权（CC 的 request_access）
  if (!fg.granted) {
    return {
      ok: false,
      deniedBy: 'access',
      needAccess: fg.process,
      error: `应用「${fg.process || fg.title}」还没有被授权操作。先调用 computer_request_access 请求授权（列出你要用到的应用），用户同意后再试。`,
      foreground: { process: fg.process, title: fg.title, tier: fg.tier }
    };
  }

  // ③ 派发（坐标按模型看到的图换算回真实屏幕坐标）
  const scale = Number(params.scale) > 0 ? Number(params.scale) : 1;
  const toReal = (v) => Math.round(Number(v) * scale);
  try {
    switch (action) {
      case 'move':
        await input.moveMouse(toReal(params.x), toReal(params.y));
        break;
      case 'left_click':
      case 'click':
        await input.click(toReal(params.x), toReal(params.y), { button: 'left', count: 1 });
        break;
      case 'right_click':
        await input.click(toReal(params.x), toReal(params.y), { button: 'right', count: 1 });
        break;
      case 'middle_click':
        await input.click(toReal(params.x), toReal(params.y), { button: 'middle', count: 1 });
        break;
      case 'double_click':
        await input.click(toReal(params.x), toReal(params.y), { button: 'left', count: 2 });
        break;
      case 'triple_click':
        await input.click(toReal(params.x), toReal(params.y), { button: 'left', count: 3 });
        break;
      case 'drag':
      case 'left_click_drag':
        await input.drag(toReal(params.x1 ?? params.fromX), toReal(params.y1 ?? params.fromY), toReal(params.x2), toReal(params.y2));
        break;
      case 'scroll':
        await input.scroll(
          params.x == null ? -1 : toReal(params.x),
          params.y == null ? -1 : toReal(params.y),
          { dir: params.direction || 'down', amount: Number(params.amount) || 3 }
        );
        break;
      case 'type':
        await input.typeText(String(params.text ?? ''));
        break;
      case 'key':
        await input.pressKey(String(params.keys ?? params.key ?? ''), { repeat: Number(params.repeat) || 1 });
        break;
      case 'focus':
        await input.focusWindow(Number(params.hwnd));
        break;
      default:
        return { ok: false, error: `不认识的桌面动作：${action}` };
    }
  } catch (e) {
    return { ok: false, error: `动作执行失败：${e?.message || e}` };
  }

  return {
    ok: true,
    action,
    foregroundAtAction: { process: fg.process, title: fg.title, tier: fg.tier },
    note: '动作已执行。下一步建议重新截图确认结果（capture_screen），不要假设点对了。'
  };
}

/** 关掉常驻注入进程（应用退出时） */
export function shutdown() { input.shutdownInput(); }

export { nativeImage };
