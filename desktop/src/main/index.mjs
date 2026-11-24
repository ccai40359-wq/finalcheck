import { app, BrowserWindow, globalShortcut, ipcMain, protocol, screen, shell } from 'electron';
import { registerMediaScheme, installMediaProtocol } from './media-protocol.mjs';
import { setSnapshotRenderer } from './capture.mjs';
// 注意：computer-use 模块与 agent-service 一样是运行时经 engineUrl 从 REPO_ROOT 加载的
// （bundle 不内联它）——这里不能用静态 import：electron-vite 会把整条 CU 遮罩订阅摇树掉
// （0.29.2-0.29.5 打包版金色遮罩从未显示过，根因即此）。订阅见下方 whenReady 里的动态加载。

// Windows 的「原生遮挡检测」会在窗口被别的窗口盖住时把页面判定为 hidden：
// Chromium 随即停掉 requestAnimationFrame、把定时器节流到 ~1s，用户切回来就觉得“卡”。
// 这里关掉遮挡检测与首帧可见性分发，窗口在后台也保持正常帧率（代价是后台也会画，可接受）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,WidgetInitVisibilityDispatch');
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdir, mkdir, stat, copyFile, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as projects from './projects.mjs';
import { createConfigStore, registerConfigIpc } from './ipc/config-store.mjs';
import { registerProjectIpc } from './ipc/ipc-projects.mjs';
import { registerWorkspaceIpc } from './ipc/ipc-workspace.mjs';
import { createBackend, IMAGE_MIME } from './backend.mjs';
import { registerDiagnosticsIpc } from './ipc/ipc-diagnostics.mjs';
import { registerUpdaterIpc } from './ipc/ipc-updater.mjs';
import { appendLogLine, installProcessGuards, installSafeIpc } from './error-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..'); // desktop/src/main → 仓库根
const engineUrl = (rel) => pathToFileURL(path.join(REPO_ROOT, rel)).href;
let DATA_ROOT = path.resolve(__dirname, '..', '..'); // dev 默认 desktop/；打包后在 whenReady 改到 userData
const getDataRoot = () => DATA_ROOT;
const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico'); // 打包后 exe 也用它
app.setName('FinalCheck'); // 进程/系统里显示 FinalCheck（不再显示 Electron）
process.title = 'FinalCheck';

// 配置 / 供应商工具（含语言、沙箱模式、摘要与标题生成）
const configStore = createConfigStore({ app, getDataRoot, engineUrl });

// 后端接线（项目/会话目录、SessionStart、会话 IPC、agent IPC）：与无头模拟客户端测试台共用 backend.mjs。
// win / writeLog 在下面才定义，这里用箭头函数延迟取值。
const backend = createBackend({
  ipcMain,
  getWin: () => win,
  getDataRoot,
  engineUrl,
  repoRoot: REPO_ROOT,
  store: configStore,
  // 内置 Git Bash 的查找根：打包后 resources 目录的上级（resolveShell 会拼 resources/gitbash/...）
  shellAppRoot: process.resourcesPath || null,
  log: (line) => writeLog(line)
});

// 打包版数据目录 = userData（%APPDATA%/FinalCheck）：升级/重开不丢历史。
// 首次升级从旧 resources/app 目录迁移 config / sessions / memory / attachments。
async function migrateLegacyData(legacyRoot, dataRoot) {
  if (path.resolve(legacyRoot) === path.resolve(dataRoot)) return;
  await mkdir(dataRoot, { recursive: true });
  const copyIfMissing = async (src, dst) => {
    try { await stat(dst); } catch { try { await copyFile(src, dst); } catch { /* 旧文件不存在 */ } }
  };
  await copyIfMissing(path.join(legacyRoot, 'config.json'), path.join(dataRoot, 'config.json'));
  try {
    const srcDir = path.join(legacyRoot, 'sessions');
    const dstDir = path.join(dataRoot, 'sessions');
    const files = (await readdir(srcDir)).filter((f) => f.endsWith('.json'));
    await mkdir(dstDir, { recursive: true });
    const existing = (await readdir(dstDir)).filter((f) => f.endsWith('.json'));
    if (!existing.length) for (const f of files) await copyFile(path.join(srcDir, f), path.join(dstDir, f)).catch(() => {});
  } catch { /* 无旧会话 */ }
  try {
    await mkdir(path.join(dataRoot, 'memory'), { recursive: true });
    await copyIfMissing(path.join(legacyRoot, 'memory', 'projects.json'), path.join(dataRoot, 'memory', 'projects.json'));
  } catch { /* 无旧档案 */ }
  try {
    const srcDir = path.join(legacyRoot, 'attachments');
    const dstDir = path.join(dataRoot, 'attachments');
    const files = await readdir(srcDir);
    await mkdir(dstDir, { recursive: true });
    for (const f of files) await copyIfMissing(path.join(srcDir, f), path.join(dstDir, f));
  } catch { /* 无旧附件 */ }
}

// 首次升级：把旧 userData/sessions、userData/memory 搬进默认项目 .finalcheck/
async function migrateGlobalToProject(p) {
  // 老数据（全局 sessions）持续并入默认项目：只补缺不覆盖；并入后删源文件，避免删掉的会话被复活。
  // 用户实测「更新后信息没了」= 首次迁移时项目目录已有会话，旧会话被 if(!existing.length) 跳过，永远留在全局目录。
  const dstSessions = projects.sessionDirOf(p.path);
  const srcSessions = path.join(DATA_ROOT, 'sessions');
  await mkdir(dstSessions, { recursive: true });
  const existing = new Set((await readdir(dstSessions).catch(() => [])).filter((f) => f.endsWith('.json')));
  const files = (await readdir(srcSessions).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    if (existing.has(f)) continue;
    const src = path.join(srcSessions, f);
    const dst = path.join(dstSessions, f);
    try {
      await copyFile(src, dst);
      await unlink(src).catch(() => {});
    } catch { /* 源不可读就留着，下次再试 */ }
  }
  const dstMem = projects.memoryDirOf(p.path);
  await mkdir(dstMem, { recursive: true });
  const dstFile = path.join(dstMem, 'projects.json');
  try { await stat(dstFile); } catch {
    await copyFile(path.join(DATA_ROOT, 'memory', 'projects.json'), dstFile).catch(() => {});
  }
  await writeFile(path.join(DATA_ROOT, '.project-migrated'), new Date().toISOString(), 'utf8').catch(() => {});
}

// 安全边界（DESKTOP-ACCEPTANCE §2）已收敛进 permissions.mjs 台账：
// 本机目标默认放行，其他 host 必须先经 confirm-host IPC 写入台账；renderer/agent 透传的
// confirmedHosts 参数一律不再采信（fail-closed，主进程单一事实源）

// UI 自动化自检模式（FINALCHECK_UI_SELFCHECK=1）：隔离 userData。必须在 requestSingleInstanceLock
// 之前 setPath——单例锁按 userData 计算，隔离后才能与用户正开着的实例并行跑；专供截图/冒烟验收
// （安装形态冒烟一直缺这条自动化通道），正常启动完全不进此分支。
// 固定目录名（不带 pid）：自检脚本要在启动前预置 config.json/projects.json；自检串行跑，不冲突。
if (process.env.FINALCHECK_UI_SELFCHECK === '1') {
  app.setPath('userData', path.join(process.env.TEMP || process.env.TMP || '/tmp', 'fc-ui-selfcheck'));
}

// 单实例锁：二次启动聚焦已有窗口，不再堆僵尸进程（用户实测教训）
const gotLock = app.requestSingleInstanceLock();
// 任务栏图标：dev 模式 Windows 默认跟 electron.exe 的内嵌图标，设 AppUserModelID 让窗口图标生效（打包后由 exe 内嵌 logo 彻底接管）
app.setAppUserModelId('com.finalcheck.terminal');
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
}

let win = null;

// ---- 进程级错误边界：未捕获异常/未处理 Promise 只记日志 + 给界面一条 notice，不静默死 ----
// 装得越早越好（启动阶段就崩时也要有记录）；日志文件路径在 whenReady 里按平台确定。
let logFile = null;
const writeLog = (line) => { if (logFile) void appendLogLine(logFile, line); };
installProcessGuards({ proc: process, getWin: () => win, log: writeLog });

// 启动期读一次主题：窗口底板色要用（config.json 由 configStore 管理，但那时还没 ready）。
// 读不到/解析失败一律按深色——与 normalizeConfig 的默认值保持一致。
function startupTheme() {
  try {
    const f = process.env.FINALCHECK_CONFIG_FILE || path.join(DATA_ROOT, 'config.json');
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    return raw?.theme === 'light' ? 'light' : 'dark';
  } catch { return 'dark'; }
}

/**
 * 外部链接一律交给系统浏览器（2026-11-20 用户实机反馈）。
 *
 * 以前完全没拦：点消息里的 http(s) 链接，Electron 默认让**主窗口自己导航过去**，
 * 界面就变成一个网页，用户只能关掉重开——看起来像「点了链接就进了 Electron」。
 * 现在：应用自己的 origin（dev 的 vite / 打包后的 file://）放行，其它 http(s) 一律
 * shell.openExternal 交给默认浏览器，并且拒绝在主窗口里导航。
 *
 * 只在 http/https 里放行外部打开（其它 scheme 如 file:/javascript: 直接拒绝）。
 */
function installExternalLinkGuards() {
  const APP_ORIGIN = process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).origin
    : 'file://';
  const isAppUrl = (u) => {
    try {
      const s = String(u || '');
      if (s.startsWith('file://')) return true;      // 打包后的渲染层
      if (s.startsWith('fc-media://')) return true;   // 视频/媒体协议
      if (s.startsWith('fc-snapshot')) return true;
      return s.startsWith(APP_ORIGIN);
    } catch { return false; }
  };
  const openOutside = (url) => {
    try {
      const parsed = new URL(String(url || ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      void shell.openExternal(parsed.href);
      return true;
    } catch { return false; }
  };

  // ① 主窗口自己不许被导航到外部站点
  win?.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return; // 应用内跳转（如 hash 路由）放行
    event.preventDefault();
    openOutside(url);
  });

  // ② target=_blank / window.open：不开新 Electron 窗口，交系统浏览器
  win?.webContents.setWindowOpenHandler(({ url }) => {
    if (openOutside(url)) return { action: 'deny' };
    return { action: 'deny' }; // 非 http(s) 一律不开窗
  });

  // ③ 以后新建的任何 webContents（含截图隐藏窗口）同样遵守。
  // 注：右栏内嵌浏览器（browser-view-host.mjs 的 WebContentsView）会在自己创建后**立刻覆盖**
  // setWindowOpenHandler 并摘掉这里的 will-navigate 监听——那边才是它的正确行为
  // （页面内的 window.open 要变成新标签，而不是跳去系统浏览器）。见该文件 createEmbeddedGuard。
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
    const navGuard = (event, url) => {
      if (isAppUrl(url)) return;
      event.preventDefault();
      openOutside(url);
    };
    contents.on('will-navigate', navGuard);
    // 记下这个监听器，方便内嵌浏览器显式摘除（Electron 没有 removeAllListeners('will-navigate') 的语义保证）
    try { contents.__fcNavGuard = navGuard; } catch { /* 只读对象：忽略 */ }
  });
}

// ---- CU 模式（0.29.2，对标 Claude Code 桌面端）：操控期间全屏遮罩提示 + 主窗缩到右上角固定 ----
// 遮罩必须 focusable:false + 点击穿透，否则会抢走目标应用的前台，CU 的前台校验会全线拒绝。
// 停止入口在右上角迷你窗的红色横幅（finalcheck.cuStop → ipc-agent 撤授权 + 中止回合）。
let cuOverlay = null;
let cuSavedBounds = null;
let cuSavedMinSize = null; // 进 CU 模式前的窗口尺寸下限（minWidth=980 必须先放宽才能缩到 360）
let cuWasMaximized = false;
let cuModeOn = false; // 遮罩/横幅重注入的开关（渲染层 reload 后 did-finish-load 会重注入，审查 P1-2）
const CU_OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:rgba(214,158,52,.15);overflow:hidden;
    font-family:system-ui,'Segoe UI','Microsoft YaHei',sans-serif;user-select:none}
  .banner{position:fixed;top:18px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;
    background:rgba(26,20,8,.88);color:#f2c566;padding:10px 18px;border-radius:10px;
    font-size:14px;font-weight:600;letter-spacing:.5px;box-shadow:0 4px 18px rgba(0,0,0,.45);
    border:1px solid rgba(242,197,102,.4)}
  .dot{width:10px;height:10px;border-radius:50%;background:#f2c566;animation:pulse 1.1s infinite}
  .hint{font-size:11px;font-weight:400;opacity:.85;margin-left:6px}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
</style></head><body>
  <div class="banner"><span class="dot"></span>FinalCheck 正在操控电脑
    <span class="hint">按 ESC 或点右上角小窗「停止」可中止</span></div>
</body></html>`;

function injectCuBanner() {
  win?.webContents.executeJavaScript(`(function(){
    if (document.getElementById('fc-cu-stop')) return 'exists';
    const bar = document.createElement('div');
    bar.id = 'fc-cu-stop';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647;background:rgba(26,20,8,.92);color:#f2c566;border-bottom:1px solid rgba(242,197,102,.4);font:600 12px/28px system-ui,sans-serif;text-align:center;cursor:pointer;user-select:none';
    bar.textContent = '● FinalCheck 操控中 — 点此停止（按 ESC 也可）';
    bar.onclick = function(){ window.finalcheck && window.finalcheck.cuStop && window.finalcheck.cuStop(); };
    document.body.appendChild(bar);
    document.body.classList.add('fc-cu-mini'); // 迷你形态：隐藏侧栏，只留对话流+输入框
    return 'injected';
  })()`).catch(() => { /* 渲染层未就绪：cuModeOn 期间 did-finish-load 会重注入 */ });
}

function enterCuMode() {
  try {
    if (process.env.FINALCHECK_WINDOW_BG === '1') return; // 后台驱动模式：不建遮罩、不动窗口
    if (!win || win.isDestroyed()) return;
    cuModeOn = true;
    const { width, height } = screen.getPrimaryDisplay().bounds;
    if (!cuOverlay || cuOverlay.isDestroyed()) {
      cuOverlay = new BrowserWindow({
        x: 0, y: 0, width, height,
        frame: false, transparent: true, resizable: false, movable: false,
        hasShadow: false, skipTaskbar: true,
        focusable: false, // 关键：绝不抢前台，否则 CU 的前台校验拒绝一切动作
        alwaysOnTop: true,
        webPreferences: { sandbox: true, backgroundThrottling: false }
      });
      cuOverlay.setAlwaysOnTop(true, 'screen-saver');
      cuOverlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      cuOverlay.setIgnoreMouseEvents(true, { forward: true }); // 全屏点击穿透：你的鼠标照常用，事件照达底层窗口
      cuOverlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(CU_OVERLAY_HTML));
    }
    cuOverlay.showInactive();
    // 主窗缩到右上角固定（对话照常可用：会话状态在主进程，窗口变小不影响聊天）
    if (!cuSavedBounds) {
      cuWasMaximized = win.isMaximized();
      if (cuWasMaximized) win.unmaximize();
      cuSavedBounds = win.getBounds();
      cuSavedMinSize = win.getMinimumSize();
    }
    const wa = screen.getPrimaryDisplay().workArea;
    win.setAlwaysOnTop(true, 'screen-saver');
    // 关键：主窗创建时 minWidth=980，不先放宽尺寸下限，下面的 360px setBounds 会被
    // Windows 直接拒绝（窗口停在 980 宽、只挪了位置）——0.29.7/0.29.8 的迷你样式因此全白做。
    try { win.setMinimumSize(300, 200); } catch { /* 旧窗口/平台不支持则跳过 */ }
    const miniW = 360;
    // 位置：右上角、距右边缘留 12px；但避开任务栏与屏幕顶部的操控横幅（banner 高约 60px）
    win.setBounds({
      x: Math.max(wa.x, wa.x + wa.width - miniW - 12),
      y: wa.y + 64,
      width: miniW,
      height: Math.min(560, wa.height - 80)
    });
    injectCuBanner();
    // 用户拍板：ESC = 全局退出操控（等同点「停止」）。仅在 CU 模式期间注册，退出即注销。
    // 代价：CU 期间你在任何应用里按 ESC 都会停止操控——这是明确的取舍。
    try {
      globalShortcut.register('Escape', () => {
        try { win?.webContents.executeJavaScript('window.finalcheck&&window.finalcheck.cuStop&&window.finalcheck.cuStop()').catch(() => {}); } catch { /* ignore */ }
      });
    } catch { /* 注册失败不影响 CU 本体 */ }
  } catch { /* 遮罩/迷你化失败不影响 CU 本体动作 */ }
}

function exitCuMode() {
  try {
    cuModeOn = false;
    try { globalShortcut.unregister('Escape'); } catch { /* ignore */ }
    if (cuOverlay && !cuOverlay.isDestroyed()) cuOverlay.destroy();
    cuOverlay = null;
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(false);
      win.webContents.executeJavaScript(`(function(){const b=document.getElementById('fc-cu-stop');if(b)b.remove();document.body.classList.remove('fc-cu-mini');})()`).catch(() => {});
      // 顺序：先放宽尺寸下限（进 CU 时被降过）→ 再还原 bounds → 最后按需最大化
      if (cuSavedMinSize) { try { win.setMinimumSize(cuSavedMinSize[0], cuSavedMinSize[1]); } catch { /* ignore */ } }
      if (cuSavedBounds) win.setBounds(cuSavedBounds);
      if (cuWasMaximized) win.maximize();
    }
    cuSavedBounds = null;
    cuSavedMinSize = null;
    cuWasMaximized = false;
  } catch { /* ignore */ }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980,
    // 后台驱动模式（FINALCHECK_WINDOW_BG=1）：不建可见窗口、不抢焦点，CDP 照常驱动
    // （自动化跑批/长任务验收用——窗口是真实的，只是不弹到用户面前）
    show: process.env.FINALCHECK_WINDOW_BG !== '1',
    title: 'FinalCheck',
    // 窗口底板色：跟随主题，否则浅色主题启动/缩放时会闪一下黑边。
    // 这里读盘上的 config.json（同步、启动期一次），拿不到就按深色兜底。
    backgroundColor: startupTheme() === 'light' ? '#f7f5f0' : '#0a0a0c',
    autoHideMenuBar: true,
    frame: false, // 自绘标题栏（用户：原生标题栏丑）
    icon: APP_ICON, // 任务栏/窗口图标：build/icon.ico（由 logo 生成，打包后 exe 同源）
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 后台不节流：最小化/被遮挡时定时器与 rAF 仍按正常节奏跑，切回来不会“卡一下”
      backgroundThrottling: false
    }
  });
  // 自绘窗口按钮通道（removeHandler 保证重复建窗不冲突）
  ipcMain.removeHandler('finalcheck:window-ctl');
  ipcMain.handle('finalcheck:window-ctl', (_e, action) => {
    if (!win) return false;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') { win.isMaximized() ? win.unmaximize() : win.maximize(); }
    else if (action === 'close') win.close();
    return true;
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
  // 0.29.2：CU 模式激活期间渲染层重载后重注入停止横幅（唯一停止入口不能丢）
  win.webContents.on('did-finish-load', () => { if (cuModeOn) injectCuBanner(); });
  if (process.env.FINALCHECK_WINDOW_BG === '1') {
    win.once('ready-to-show', () => { try { win?.showInactive(); } catch { /* 销毁竞态忽略 */ } });
  }
}

// 右侧预览的视频流协议：特权 scheme 必须在 ready 之前登记
registerMediaScheme(protocol);

app.whenReady().then(async () => {
  if (!gotLock) return; // 第二实例只让已有窗口聚焦，不再建窗（用户实测多开问题）
  if (app.isPackaged) {
    const legacyRoot = path.resolve(__dirname, '..', '..'); // resources/app（旧数据位置）
    DATA_ROOT = app.getPath('userData');
    await migrateLegacyData(legacyRoot, DATA_ROOT);
  }
  installMediaProtocol(protocol);
  // AI 截图通道（capture_screenshot）：隐藏窗口加载同一份渲染层的 #fc-snapshot 路由
  setSnapshotRenderer({
    url: process.env.ELECTRON_RENDERER_URL || null,
    file: path.join(__dirname, '../renderer/index.html'),
    preload: path.join(__dirname, '../preload/index.mjs'),
  });
  // 自检模式：数据根跟随隔离后的 userData——config.json（供应商）与 projects.json（指向独立测试项目）
  // 由自检脚本预置，绝不读写用户的真实会话/项目数据。
  if (process.env.FINALCHECK_UI_SELFCHECK === '1') {
    DATA_ROOT = app.getPath('userData');
  }
  // 统一稳定数据目录：会话/配置/记忆/附件/溢出文件都不随安装包升级丢失
  process.env.FINALCHECK_CONFIG_FILE ||= path.join(DATA_ROOT, 'config.json');
  process.env.FINALCHECK_SESSIONS_DIR ||= path.join(DATA_ROOT, 'sessions');
  process.env.FINALCHECK_MEMORY_DIR ||= path.join(DATA_ROOT, 'memory');
  process.env.FINALCHECK_SPILL_DIR ||= path.join(DATA_ROOT, 'spill');
  process.env.FINALCHECK_SNAPSHOTS_DIR ||= path.join(DATA_ROOT, 'snapshots'); // 修复回路（③）：edit/write 改前快照
  process.env.FINALCHECK_PROJECTS_FILE ||= path.join(DATA_ROOT, 'projects.json');
  await mkdir(DATA_ROOT, { recursive: true });
  // 崩溃/未捕获异常日志：与诊断包读的是同一个 main.log（app.getPath('logs')，拿不到就回落 DATA_ROOT）
  try {
    logFile = path.join(app.getPath('logs'), 'main.log');
  } catch {
    logFile = path.join(DATA_ROOT, 'logs', 'main.log');
  }
  // 所有 IPC handler 统一错误边界：抛错 → { error, code: 'IPC_FAILED' }（不再把栈丢给用户）
  installSafeIpc(ipcMain, { log: writeLog });

  // 项目文件夹：默认项目（D:\finalcheck 或 C:\Users\...\finalcheck），旧全局会话迁入；
  // 启动时恢复上次选中的项目
  const defaultProject = await projects.ensureDefaultProject();
  await migrateGlobalToProject(defaultProject);
  const activeProject = (await projects.getActiveProject()) || defaultProject;
  // 选中项目 + 登记会话目录 + 收尾上次崩溃遗留的运行中工具调用（见 backend.boot）
  await backend.boot({ project: activeProject });

  // ---- IPC 模块接线（顺序与拆分前一致；运行时状态通过 getter / 共享 Map 注入） ----
  registerProjectIpc({
    ipcMain,
    getWin: () => win,
    getActiveProjectId: () => backend.getActiveProjectId(),
    selectProjectEnv: (p) => backend.selectProjectEnv(p)
  });
  // 系统统计 / 会话 / agent：不依赖 Electron 的那部分，桌面端与测试台同一份
  await backend.registerCoreIpc();
  registerWorkspaceIpc({
    ipcMain,
    getWin: () => win,
    getDataRoot,
    imageMime: IMAGE_MIME,
    store: configStore
  });
  registerDiagnosticsIpc({
    ipcMain,
    getWin: () => win,
    getDataRoot,
    repoRoot: REPO_ROOT,
    app,
    store: configStore
  });
  registerConfigIpc({ ipcMain, store: configStore });
  const updater = registerUpdaterIpc({ ipcMain, app, getWin: () => win });

  createWindow();
  installExternalLinkGuards(); // 点消息里的链接要开系统浏览器，不能把主窗口导航走
  // 0.29.2：CU 模式开关 → 全屏遮罩 + 主窗右上角迷你化（computer-use 模块在首次可操作截图/动作时进入，
  // 撤销授权 / 回合收尾 / 用户点停止时退出）。
  // 必须动态加载与 agent-tools 同一个模块实例（engineUrl 指向 REPO_ROOT 的文件拷贝，
  // 和 backend.mjs:56 同款模式）——静态 import 的绑定会被摇树删除（0.29.5 及之前打包版遮罩不显示的根因）。
  void (async () => {
    try {
      const { onComputerUseModeChange } = await import(engineUrl('desktop/src/main/computer-use.mjs'));
      onComputerUseModeChange((active) => { try { active ? enterCuMode() : exitCuMode(); } catch { /* 遮罩故障不影响 CU 本体 */ } });
    } catch { /* 模块加载失败不影响 CU 本体（工具走 loadDesktopTools 自己的实例） */ }
  })();
  updater.ensureUpdater(); // dev 下内部直接返回 null（不 import、不联网）

  // 0.32.7：定时唤醒调度器（类似 cron 的单次/重复延时版）。
  // 为什么放在这里而不是 ipc 模块里：它必须**常驻**（不随某个 IPC 注册而活），
  // 而且要能跟着 app 退出一起停。
  // 职责边界：调度器只负责「到点通知渲染层：该唤醒某会话了」，**不自己起回合**——
  // 起回合的完整逻辑（落盘/UI/停止语义/队列泵）渲染层的 send() 已经实现好了，
  // 让定时唤醒走和"用户手打一条消息"完全相同的路径，不需要另造一套执行体系。
  void (async () => {
    try {
      const { startScheduler } = await import(engineUrl('desktop/src/main/wakeup-scheduler.mjs'));
      await startScheduler({
        getDataRoot: () => DATA_ROOT,
        onDue: (item) => {
          // 发到渲染层；窗口不在/已销毁时这条唤醒**丢失**（feature 说明里写明了这个限制）。
          // ⚠️ 必须用模块级 `win`：本文件**没有** getWin() 函数（`getWin: () => win` 只是
          // 传给各 IPC 注册器的属性）。真机第一次跑 W3 就撞了：调用不存在的 getWin()
          // → ReferenceError → 被下面的 catch 吞掉 → 任务被消费但界面毫无反应。
          //
          // 0.32.7：先**落库**一条 notice 再通知渲染层。
          // 为什么必须先落库（真机 W4 实测）：渲染层加的那条 notice 会被随后的
          // openSession 重载覆盖掉（send 内部会 reload 会话），用户看不到"定时唤醒发生过"。
          // 写进会话历史就不会丢——重载会话时它自然带回来，跟 /compact 那条提示一个机制。
          void (async () => {
            try {
              const { appendNotice } = await import(engineUrl('desktop/src/main/sessions.mjs'));
              await appendNotice(item.sessionId,
                `⏰ 定时唤醒触发：${String(item.label || item.prompt || '').slice(0, 60)}`, 'wakeup');
            } catch { /* 落库失败不阻塞唤醒（界面还有实时提示） */ }
            try {
              if (win && !win.isDestroyed()) win.webContents.send('finalcheck:wakeup-due', item);
            } catch { /* 窗口没了：这条唤醒丢失，不做补偿（下次 tick 也不会重放，因为时间已推进） */ }
          })();
        }
      });
    } catch (e) {
      // 调度器起不来不能拖垮主进程：定时功能不可用，其余照常
      try { console.warn('[wakeups] 调度器启动失败：' + (e?.message || e)); } catch { /* 忽略 */ }
    }
  })();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// 0.32.7：退出时停掉定时调度器（不停的话进程退出时定时器还挂在那儿，日志会很难看，
// 而且 before-quit 里停掉能保证不会在退出瞬间触发一次没必要的唤醒）
app.on('before-quit', () => {
  void (async () => {
    try {
      const { stopScheduler } = await import(engineUrl('desktop/src/main/wakeup-scheduler.mjs'));
      stopScheduler();
    } catch { /* 没启动过就没事 */ }
  })();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
