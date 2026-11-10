import { app, BrowserWindow, ipcMain } from 'electron';

// Windows 的「原生遮挡检测」会在窗口被别的窗口盖住时把页面判定为 hidden：
// Chromium 随即停掉 requestAnimationFrame、把定时器节流到 ~1s，用户切回来就觉得“卡”。
// 这里关掉遮挡检测与首帧可见性分发，窗口在后台也保持正常帧率（代价是后台也会画，可接受）。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,WidgetInitVisibilityDispatch');
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdir, mkdir, stat, copyFile, unlink, writeFile } from 'node:fs/promises';
import * as sessions from './sessions.mjs';
import * as projects from './projects.mjs';
import { loadHooksConfig } from './hooks.mjs';
import { getSessionDir, scanSessionsDir, projectRootOfSessionsDir } from './session-projects.mjs';
import { planProjectSwitch } from './project-switch.mjs';
import { createConfigStore, registerConfigIpc } from './ipc/config-store.mjs';
import { registerProjectIpc } from './ipc/ipc-projects.mjs';
import { registerSessionIpc } from './ipc/ipc-sessions.mjs';
import { registerWorkspaceIpc } from './ipc/ipc-workspace.mjs';
import { registerAgentIpc } from './ipc/ipc-agent.mjs';
import { registerSystemIpc } from './ipc/ipc-system.mjs';
import { registerDiagnosticsIpc } from './ipc/ipc-diagnostics.mjs';
import { registerUpdaterIpc } from './ipc/ipc-updater.mjs';

// 会话读写按「会话所属项目」解析目录（未登记则回退当前项目目录）
sessions.setSessionDirResolver((id) => getSessionDir(id));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..'); // desktop/src/main → 仓库根
const engineUrl = (rel) => pathToFileURL(path.join(REPO_ROOT, rel)).href;
let DATA_ROOT = path.resolve(__dirname, '..', '..'); // dev 默认 desktop/；打包后在 whenReady 改到 userData
const getDataRoot = () => DATA_ROOT;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico'); // 打包后 exe 也用它
app.setName('FinalCheck'); // 进程/系统里显示 FinalCheck（不再显示 Electron）
process.title = 'FinalCheck';

// 配置 / 供应商工具（含语言、沙箱模式、摘要与标题生成）
const configStore = createConfigStore({ app, getDataRoot, engineUrl });

// 当前项目：切换时把 sessions/memory 环境变量指向 <project>/.finalcheck/ 下
let activeProjectId = null;
let activeProjectPath = null; // 当前项目根（项目记忆 AGENTS.md 在这里）
let hooksConfig = null;      // hooks.json 进程内快照：启动/切换项目时读一次，工具层与回合层共用
const hookSessionContext = new Map(); // sessionId → { messages, context }：SessionStart hook 结果（仅内存）
// 回合运行时状态（IPC 模块共享，入口只负责创建与注入）
const activeChats = new Map();
const workflowControls = new Map(); // sessionId → 运行中工作流的控制台（暂停/并发/子代理模型）
const workflowTranscripts = new Map(); // sessionId → { stepId: { name, role, ms, toolCount, messages } }（右侧子代理面板）
const sessionUsage = new Map();      // sessionId → 最后一次请求的真实 usage（服务端口径，含工具输出）
const steerBuffers = new Map();      // sessionId → 待注入当前回合的 Steer 文本（FIFO，每次模型请求前 drain）
const sharedState = { activeChats, workflowControls, workflowTranscripts, sessionUsage, steerBuffers, hookSessionContext };

// SessionStart：项目选择 / 会话打开·新建各跑一次。fail-open：deny 或 hook 崩溃都不影响会话可用；
// 结果只记内存，下一轮 agent-chat 把 context 作为 system 消息注入（项目记忆之后）。
async function runSessionStart(sessionId = null, projectPath = activeProjectPath) {
  if (!projectPath) return null;
  try {
    const { runSessionStartHook } = await import(engineUrl('desktop/src/main/agent-service.mjs'));
    const r = await runSessionStartHook({
      sessionId,
      cwd: projectPath,
      projectPath,
      hooksConfig
    });
    if (sessionId) hookSessionContext.set(sessionId, { messages: r.messages || [], context: r.context || '' });
    if (r?.warnings?.length) console.warn('[hooks] ' + r.warnings.join('；'));
    return r;
  } catch (e) {
    console.warn('[hooks] SessionStart 接线异常（已忽略）：' + (e?.message || e));
    return null;
  }
}

async function selectProjectEnv(p) {
  const plan = planProjectSwitch(p);
  if (!plan) return null;
  process.env.FINALCHECK_SESSIONS_DIR = plan.sessionsDir;
  process.env.FINALCHECK_MEMORY_DIR = plan.memoryDir;
  await mkdir(plan.sessionsDir, { recursive: true });
  await mkdir(plan.memoryDir, { recursive: true });
  activeProjectId = plan.activeProjectId;
  activeProjectPath = plan.activeProjectPath;
  // 只重载 hooks 配置（全局 hooks.json）；不 abort 在跑的回合、不清会话级 SessionStart context：
  // 在跑的回合开头已快照项目路径/策略/配置，切项目只影响之后新开的回合与 UI 视角。
  if (plan.reloadHooksConfig) hooksConfig = loadHooksConfig(); // 每次启动/切换项目只读一次磁盘，后续工具调用复用快照
  await projects.setActiveProject(p.id).catch(() => {});
  await runSessionStart(null, plan.activeProjectPath); // 项目选择时跑一次；会话级 context 在 open/new 时按 sessionId 再记
  return p;
}

// 会话所属项目根：登记目录反推（<p>/.finalcheck/sessions）；未登记/全局目录回退当前 UI 项目
const sessionProjectPathOf = (sessionId) => projectRootOfSessionsDir(sessionId ? getSessionDir(sessionId) : null) || activeProjectPath;

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
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980,
    title: 'FinalCheck',
    backgroundColor: '#0a0a0c',
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
}

app.whenReady().then(async () => {
  if (!gotLock) return; // 第二实例只让已有窗口聚焦，不再建窗（用户实测多开问题）
  if (app.isPackaged) {
    const legacyRoot = path.resolve(__dirname, '..', '..'); // resources/app（旧数据位置）
    DATA_ROOT = app.getPath('userData');
    await migrateLegacyData(legacyRoot, DATA_ROOT);
  }
  // 统一稳定数据目录：会话/配置/记忆/附件/溢出文件都不随安装包升级丢失
  process.env.FINALCHECK_CONFIG_FILE ||= path.join(DATA_ROOT, 'config.json');
  process.env.FINALCHECK_SESSIONS_DIR ||= path.join(DATA_ROOT, 'sessions');
  process.env.FINALCHECK_MEMORY_DIR ||= path.join(DATA_ROOT, 'memory');
  process.env.FINALCHECK_SPILL_DIR ||= path.join(DATA_ROOT, 'spill');
  process.env.FINALCHECK_PROJECTS_FILE ||= path.join(DATA_ROOT, 'projects.json');
  await mkdir(DATA_ROOT, { recursive: true });

  // 项目文件夹：默认项目（D:\finalcheck 或 C:\Users\...\finalcheck），旧全局会话迁入；
  // 启动时恢复上次选中的项目
  const defaultProject = await projects.ensureDefaultProject();
  await migrateGlobalToProject(defaultProject);
  const activeProject = (await projects.getActiveProject()) || defaultProject;
  await selectProjectEnv(activeProject);
  // 启动扫描：登记所有已知项目的会话 → 目录映射（只读文件名，不解析内容）。
  // 当前项目先扫；overwrite=false，避免同一会话在旧目录残留时覆盖较新的登记。
  {
    const known = await projects.listProjects().catch(() => []);
    const ordered = [activeProject, ...known.filter((p) => p.id !== activeProject.id)];
    for (const p of ordered) await scanSessionsDir(projects.sessionDirOf(p.path)).catch(() => {});
  }

  // ---- IPC 模块接线（顺序与拆分前一致；运行时状态通过 getter / 共享 Map 注入） ----
  registerProjectIpc({
    ipcMain,
    getWin: () => win,
    getActiveProjectId: () => activeProjectId,
    selectProjectEnv
  });
  registerSystemIpc({
    ipcMain,
    getWin: () => win,
    engineUrl,
    store: configStore,
    getHooksConfig: () => hooksConfig,
    sessionProjectPathOf,
    sessionUsage
  });
  registerWorkspaceIpc({
    ipcMain,
    getWin: () => win,
    getDataRoot,
    imageMime: IMAGE_MIME,
    store: configStore
  });
  registerSessionIpc({
    ipcMain,
    state: sharedState,
    sessionProjectPathOf,
    runSessionStart
  });
  registerAgentIpc({
    ipcMain,
    getWin: () => win,
    getHooksConfig: () => hooksConfig,
    getDataRoot,
    engineUrl,
    repoRoot: REPO_ROOT,
    imageMime: IMAGE_MIME,
    sessionProjectPathOf,
    store: configStore,
    state: sharedState
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
  updater.ensureUpdater(); // dev 下内部直接返回 null（不 import、不联网）
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
