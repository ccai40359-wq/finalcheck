// 主进程后端接线（不依赖 Electron）：桌面端 index.mjs 与无头「模拟客户端」测试台共用同一份。
//
// 为什么抽出来（0.26）：以前接线写在 index.mjs 里，而 index.mjs 一 import 就要 Electron，
// 测试只能绕过它直接调 runAgentTurn——真人走的「IPC → 会话库 → 历史展开 → agent → 落库 → 下一轮」
// 这条链从来没被完整测过。现在桌面端和测试台都调 createBackend()，测的就是用户用的那条链。
//
// 这里只放：项目/会话目录切换、SessionStart hook、会话 → 项目的归属、启动收尾扫描、
// 以及不依赖 Electron 的 IPC 模块（会话 / agent / 系统统计）。弹窗、剪贴板、自动更新等仍留在 index.mjs。
import { mkdir } from 'node:fs/promises';
import * as sessions from './sessions.mjs';
import * as projects from './projects.mjs';
import { loadHooksConfig } from './hooks.mjs';
import { getSessionDir, scanSessionsDir, projectRootOfSessionsDir } from './session-projects.mjs';
import { planProjectSwitch } from './project-switch.mjs';
import { registerSessionIpc } from './ipc/ipc-sessions.mjs';
import { registerAgentIpc } from './ipc/ipc-agent.mjs';
import { registerCompactIpc } from './ipc/ipc-compact.mjs';
import { registerSystemIpc } from './ipc/ipc-system.mjs';

export const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };

/**
 * @param {object} o
 * @param {any} o.ipcMain        Electron ipcMain，或测试台的同形对象（handle(channel, fn)）
 * @param {() => any} o.getWin   返回带 webContents.send 的窗口（测试台给假窗口，收集事件）
 * @param {() => string} o.getDataRoot
 * @param {(rel: string) => string} o.engineUrl
 * @param {string} o.repoRoot
 * @param {any} o.store          createConfigStore() 的返回
 * @param {string|null} [o.shellAppRoot]
 * @param {(line: string) => void} [o.log]
 */
export function createBackend({ ipcMain, getWin, getDataRoot, engineUrl, repoRoot, store, shellAppRoot = null, log = () => {} }) {
  // 会话读写按「会话所属项目」解析目录（未登记则回退当前项目目录）
  sessions.setSessionDirResolver((id) => getSessionDir(id));

  let activeProjectId = null;
  let activeProjectPath = null; // 当前项目根（项目记忆 AGENTS.md 在这里）
  let hooksConfig = null;      // hooks.json 进程内快照：启动/切换项目时读一次，工具层与回合层共用
  const hookSessionContext = new Map(); // sessionId → { messages, context }：SessionStart hook 结果（仅内存）
  // 回合运行时状态（IPC 模块共享）
  const state = {
    activeChats: new Map(),
    workflowControls: new Map(), // sessionId → 运行中工作流的控制台（暂停/并发/子代理模型）
    workflowTranscripts: new Map(), // sessionId → { stepId: { name, role, ms, toolCount, messages } }（右侧子代理面板）
    sessionUsage: new Map(),      // sessionId → 最后一次请求的真实 usage（服务端口径，含工具输出）
    steerBuffers: new Map(),      // sessionId → 待注入当前回合的 Steer 文本（FIFO，每次模型请求前 drain）
    hookSessionContext
  };

  // SessionStart：项目选择 / 会话打开·新建各跑一次。fail-open：deny 或 hook 崩溃都不影响会话可用；
  // 结果只记内存，下一轮 agent-chat 把 context 作为 system 消息注入（项目记忆之后）。
  async function runSessionStart(sessionId = null, projectPath = activeProjectPath) {
    if (!projectPath) return null;
    try {
      const { runSessionStartHook } = await import(engineUrl('desktop/src/main/agent-service.mjs'));
      const r = await runSessionStartHook({ sessionId, cwd: projectPath, projectPath, hooksConfig });
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
    if (plan.reloadHooksConfig) hooksConfig = loadHooksConfig();
    await projects.setActiveProject(p.id).catch(() => {});
    await runSessionStart(null, plan.activeProjectPath);
    return p;
  }

  // 会话所属项目根：登记目录反推（<p>/.finalcheck/sessions）；未登记/全局目录回退当前 UI 项目
  const sessionProjectPathOf = (sessionId) => projectRootOfSessionsDir(sessionId ? getSessionDir(sessionId) : null) || activeProjectPath;

  /**
   * 启动：选中项目（给了 project 就用它，否则上次的 / 默认项目）、登记各项目会话、收尾上次崩溃遗留的运行中工具。
   * @param {{ project?: any }} [o]
   */
  async function boot({ project = null } = {}) {
    const defaultProject = project ? null : await projects.ensureDefaultProject();
    const activeProject = project || (await projects.getActiveProject()) || defaultProject;
    await selectProjectEnv(activeProject);
    const known = await projects.listProjects().catch(() => []);
    const ordered = [activeProject, ...known.filter((p) => p.id !== activeProject.id)];
    for (const p of ordered) await scanSessionsDir(projects.sessionDirOf(p.path)).catch(() => {});
    // 上次进程崩溃/被强杀时挂着的「运行中」工具调用：启动即标成 interrupted，
    // 否则卡片永远转圈，工作流恢复入口也不知道该重放什么。
    let interrupted = 0;
    for (const p of ordered) interrupted += await sessions.markInterruptedRunningParts(projects.sessionDirOf(p.path)).catch(() => 0);
    if (interrupted) log(`启动收尾：${interrupted} 个遗留的工具调用已标记为「应用重启导致中断」`);
    return { activeProject, interrupted };
  }

  /** 注册不依赖 Electron 的 IPC（顺序与拆分前一致） */
  function registerCoreIpc() {
    registerSystemIpc({ ipcMain, getWin, engineUrl, store, getHooksConfig: () => hooksConfig, sessionProjectPathOf, sessionUsage: state.sessionUsage });
    registerSessionIpc({ ipcMain, state, sessionProjectPathOf, runSessionStart });
    registerCompactIpc({ ipcMain, getWin, store, sessionProjectPathOf });
    registerAgentIpc({
      ipcMain,
      getWin,
      getHooksConfig: () => hooksConfig,
      getDataRoot,
      engineUrl,
      repoRoot,
      imageMime: IMAGE_MIME,
      sessionProjectPathOf,
      store,
      state,
      shellAppRoot
    });
  }

  return {
    state,
    boot,
    registerCoreIpc,
    selectProjectEnv,
    runSessionStart,
    sessionProjectPathOf,
    getActiveProjectId: () => activeProjectId,
    getActiveProjectPath: () => activeProjectPath,
    getHooksConfig: () => hooksConfig
  };
}
