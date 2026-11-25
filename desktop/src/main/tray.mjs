// 系统托盘（0.34.0）：关窗口 = 退到托盘，程序继续在后台跑，点托盘图标再回来。
//
// 为什么需要它：定时唤醒（wakeup-scheduler）与后台任务（bg-tasks）都依赖进程活着。
// 旧实现 window-all-closed 直接 app.quit()，用户一关窗口，定好的唤醒和跑着的后台命令全没了
// （wakeup-scheduler.mjs 顶部那条注释就在说这个代价）。
//
// 行为约定（用户：「关闭界面时候是退回到小图标状态」）：
//   · 点窗口的 ✕       → 隐藏窗口，进程留着，托盘图标在
//   · 点托盘图标       → 显示并聚焦窗口（不是每次新建窗口）
//   · 托盘右键菜单     → 打开主窗口 / 退出 FinalCheck
//   · 真正退出         → 菜单里点退出，或 app.quit()（isQuitting 标志放行）
//
// 陷阱（都踩过或明知会踩）：
//   1. `win.close()` 之后窗口还能 show()——但前提是没真销毁。所以第一次 close 要 preventDefault，
//      之后一律 hide()。直接改 window-all-closed 会让「✕」销毁 webContents，
//      正在跑的回合、浏览器宿主、右栏状态全部作废。
//   2. 托盘图标必须被引用住（模块级变量）。局部变量会被 GC，图标过一会儿自己消失。
//   3. Windows 上托盘 balloon/菜单用应用语言；这里跟随 config 的 language 设置传入。
import { Tray, Menu, nativeImage } from 'electron';

let tray = null;          // 模块级：防 GC（见陷阱 2）
let quitting = false;     // 真退出放行标志
let handlers = null;

const isWin = process.platform === 'win32';

/**
 * 创建/复用托盘图标。幂等：重复调用只更新菜单。
 * @param {object} o
 * @param {()=>any} o.getWin     取主窗口（可能是 null）
 * @param {(force?:boolean)=>void} o.showWindow  显示并聚焦主窗口
 * @param {()=>void} o.onQuit    用户从菜单选「退出」
 * @param {string} o.iconPath    托盘图标（打包后 build/icon.ico）
 * @param {string} [o.tooltip]
 * @param {Record<string,string>} [o.labels]  菜单文案（多语言）
 */
export function installTray({ getWin = null, showWindow, onQuit, iconPath, tooltip = 'FinalCheck', labels = {} } = {}) {
  handlers = { showWindow, onQuit, getWin };
  const L = {
    open: labels.open || 'Open FinalCheck',
    quit: labels.quit || 'Quit FinalCheck',
    ...labels
  };

  const buildMenu = () => Menu.buildFromTemplate([
    { label: L.open, click: () => handlers?.showWindow?.() },
    { type: 'separator' },
    { label: L.quit, click: () => { markQuitting(); handlers?.onQuit?.(); } }
  ]);

  if (tray && !tray.isDestroyed?.()) {
    tray.setContextMenu(buildMenu());
    if (tooltip) { try { tray.setToolTip(tooltip); } catch { /* 销毁竞态 */ } }
    return tray;
  }

  let image = nativeImage.createFromPath(iconPath);
  // Windows 托盘区是 16×16：原图 256×256 也能自动缩，但先 resize 一下更清晰（不做也行）
  if (isWin && !image.isEmpty()) {
    try { image = image.resize({ width: 16, height: 16 }); } catch { /* 缩放失败就用原图 */ }
  }
  if (image.isEmpty()) {
    // 图标缺失不该让托盘整体起不来：给一个 1px 透明图兜底，菜单照常可用
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  if (tooltip) { try { tray.setToolTip(tooltip); } catch { /* 忽略 */ } }
  tray.setContextMenu(buildMenu());
  // 左键单击 = 打开窗口（Windows 习惯）。双击也一样。
  tray.on('click', () => handlers?.showWindow?.());
  tray.on('double-click', () => handlers?.showWindow?.());
  return tray;
}

/** 真退出前调用：之后 close 不再被拦（app.quit() 走的是同一条路） */
export function markQuitting() { quitting = true; }

/** 当前是否处于「关窗口 = 收到托盘」模式（窗口的 close 事件据此 preventDefault） */
export function shouldHideOnClose() { return !quitting; }

/** 销毁托盘（应用退出时调；不调也能退，但 Windows 上可能留下僵尸图标） */
export function destroyTray() {
  if (tray && !tray.isDestroyed?.()) { try { tray.destroy(); } catch { /* 忽略 */ } }
  tray = null;
}

/**
 * 给窗口挂上「关 = 收托盘」的行为。幂等：重复挂不会重复注册。
 * @param {any} win  BrowserWindow
 * @param {{onHidden?:()=>void}} [o]
 */
export function attachHideOnClose(win, { onHidden = null, onShow = null } = {}) {
  if (!win || win.__fcTrayAttached) return win;
  win.__fcTrayAttached = true;
  win.on('close', (e) => {
    if (quitting) return;              // 真退出：放行
    e.preventDefault();                // 陷阱 1：不能让 webContents 销毁
    try { win.hide(); } catch { /* 已销毁 */ }
    onHidden?.();
  });
  win.on('show', () => { onShow?.(); });
  return win;
}

/** 当前托盘是否已建立（给诊断/测试读） */
export function trayReady() { return !!(tray && !tray.isDestroyed?.()); }
