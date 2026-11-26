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
import { fileSuggestions } from './mentions.mjs';
import { loadHooksConfig, hooksFilePath, normalizeHooksConfig, runHookEvent, HOOK_EVENTS } from './hooks.mjs';
import { writeFile as writeFileAsync, mkdir as mkdirAsync } from 'node:fs/promises';
import { getSessionDir, scanSessionsDir, projectRootOfSessionsDir } from './session-projects.mjs';
import { planProjectSwitch } from './project-switch.mjs';
import { registerSessionIpc } from './ipc/ipc-sessions.mjs';
// 0.32.7：定时唤醒（类似 cron 的单次/重复延时版）的 IPC
import { registerWakeupIpc } from './ipc/ipc-wakeups.mjs';
import { registerAgentIpc } from './ipc/ipc-agent.mjs';
import { registerCompactIpc } from './ipc/ipc-compact.mjs';
import { registerSystemIpc } from './ipc/ipc-system.mjs';
// 0.33.0：MCP 客户端（接外部 MCP 服务器）
import { createMcpManager, parseServers } from './mcp-client.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
    // 0.31.1：sessionId → 用户在本会话里选过的浏览器模式（oneshot/persistent/real）。
    // 存在每个会话里而不是一次回合里：同一任务里连续导航不该反复弹三选一卡片。
    browserChoices: new Map(),
    hookSessionContext,
    mcp: null
  };

  // ---- 0.33.0 MCP：进程级管理器，配置在 config.json 的 mcpServers（和 Claude Code 同形） ----
  let appVersion = '0';
  try { appVersion = JSON.parse(readFileSync(path.join(repoRoot, 'desktop', 'package.json'), 'utf8')).version || '0'; } catch { /* 测试台 */ }
  const mcp = createMcpManager({
    clientInfo: { name: 'finalcheck', version: appVersion },
    log,
    onChange: () => { try { getWin()?.webContents?.send('finalcheck:mcp-changed'); } catch { /* 窗口未就绪 */ } }
  });
  state.mcp = mcp;
  async function syncMcp() {
    try { await mcp.sync((await store.loadConfig())?.mcpServers); } catch (e) { log('[mcp] 同步失败：' + (e?.message || e)); }
    return mcp.status();
  }

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
    // MCP 服务器在后台连（npx 首次可能要下载几十秒），不拖慢启动；连上后工具在下一回合出现
    void syncMcp();
    return { activeProject, interrupted };
  }

  /** 注册不依赖 Electron 的 IPC（顺序与拆分前一致） */
  async function registerCoreIpc() {
    registerSystemIpc({ ipcMain, getWin, engineUrl, store, getHooksConfig: () => hooksConfig, sessionProjectPathOf, sessionUsage: state.sessionUsage, mcpSchemas: () => mcp.schemas() });
    registerSessionIpc({ ipcMain, state, sessionProjectPathOf, runSessionStart });
    // 定时唤醒：不依赖 Electron，纯 Node 可测（存储用 JSON，见 wakeup-store.mjs）
    // ⚠️ 必须把 engineUrl 传进去：否则 IPC 侧走相对路径 import、index.mjs 走 engineUrl，
    // 会拿到**两个不同的模块实例** —— 真机 W0 实测就撞了：IPC 通了但 running 永远 false，
    // 于是「设了定时任务」也永远不会触发。
    registerWakeupIpc({ ipcMain, engineUrl });
    registerCompactIpc({ ipcMain, getWin, store, sessionProjectPathOf, sessionUsage: state.sessionUsage });
    // MCP：状态 / 保存配置并重连 / 单个重启
    ipcMain.handle('finalcheck:mcp-status', () => mcp.status());
    ipcMain.handle('finalcheck:mcp-save', async (_e, servers) => {
      const obj = servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : null;
      if (!obj) return { ok: false, error: 'mcpServers 必须是一个对象：{ "名字": { "command": ... } }' };
      const bad = parseServers(obj).filter((s) => s.error).map((s) => `${s.name}：${s.error}`);
      const cfg = await store.loadConfig();
      await store.saveConfig({ ...cfg, mcpServers: obj });
      const status = await syncMcp();
      return { ok: true, warnings: bad, status };
    });
    // 0.33.1 Hooks 设置页：读 / 存 hooks.json（存完立即重载，下一次工具调用起生效）/ 用示例输入试跑一条
    // 0.33.1 @文件引用：输入框候选（项目文件模糊匹配）
    ipcMain.handle('finalcheck:project-files', async (_e, sessionId, query) => {
      try { return await fileSuggestions(sessionProjectPathOf(sessionId) || activeProjectPath, String(query || '').slice(0, 200), 30); } catch { return []; }
    });
    // 0.33.9 右栏「文件」：和 @ 提及同一套搜索，但带上项目根（右栏要拼绝对路径去预览）
    ipcMain.handle('finalcheck:project-browse', async (_e, sessionId, query) => {
      const root = sessionProjectPathOf(sessionId) || activeProjectPath || '';
      if (!root) return { root: '', files: [] };
      try {
        const files = await fileSuggestions(root, String(query || '').slice(0, 200), 200);
        // 右栏「文件」给人看：FinalCheck 自己的 .finalcheck（会话库 / 日志）不列；其它隐藏目录排到最后
        const hidden = (f) => f.split('/').some((seg) => seg.startsWith('.'));
        const list = files.filter((f) => !f.endsWith('/') && !/(^|\/)\.finalcheck(\/|$)/.test(f));
        return { root, files: [...list.filter((f) => !hidden(f)), ...list.filter(hidden)] };
      } catch { return { root, files: [] }; }
    });
    ipcMain.handle('finalcheck:hooks-get', async () => {
      const file = hooksFilePath();
      let raw = null;
      try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 不存在或坏了：给默认 */ }
      const cfg = hooksConfig || loadHooksConfig();
      return { file, events: HOOK_EVENTS, enabled: cfg.enabled, config: raw && typeof raw === 'object' ? raw : { enabled: false, events: {} }, warnings: cfg.warnings || [] };
    });
    ipcMain.handle('finalcheck:hooks-save', async (_e, raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'hooks 配置必须是 JSON 对象' };
      const norm = normalizeHooksConfig(raw);
      const file = hooksFilePath();
      await mkdirAsync(path.dirname(file), { recursive: true });
      await writeFileAsync(file, JSON.stringify(raw, null, 2), 'utf8');
      hooksConfig = loadHooksConfig();
      return { ok: true, file, enabled: hooksConfig.enabled, warnings: norm.warnings };
    });
    ipcMain.handle('finalcheck:hooks-test', async (_e, { event, hook } = {}) => {
      if (!HOOK_EVENTS.includes(event)) return { error: '未知事件' };
      const command = String(hook?.command || '').trim();
      if (!command) return { error: '先填命令' };
      const samples = {
        SessionStart: { source: 'startup' },
        UserPromptSubmit: { prompt: '（试跑）帮我看看这个项目' },
        PreToolUse: { tool: 'run_command', args: { command: 'echo hello' } },
        PermissionRequest: { tool: 'run_command', summary: 'echo hello' },
        PostToolUse: { tool: 'run_command', args: { command: 'echo hello' }, result: { stdout: 'hello' } },
        PostToolUseFailure: { tool: 'run_command', args: { command: 'echo hello' }, error: '（试跑）示例错误' },
        Stop: { response: '（试跑）示例回复' }
      };
      const started = Date.now();
      // 试跑只跑这一条，不带 matcher（matcher 是否命中另说）；cwd = 当前项目
      const r = await runHookEvent(event, { ...samples[event], sessionId: 'hooks-test', cwd: activeProjectPath || process.cwd() }, {
        cwd: activeProjectPath || undefined,
        config: { enabled: true, events: { [event]: [{ command, timeoutMs: Math.min(Number(hook?.timeoutMs) || 30000, 60000) }] } }
      });
      return { ...r, ms: Date.now() - started, sample: samples[event] };
    });
    // 0.33.0 持久权限规则（config.permissionRules = { allow:[], deny:[] }，对齐 Claude Code）
    const cleanRuleList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/\r?\n/))
      .map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 500);
    ipcMain.handle('finalcheck:permission-rules-get', async () => {
      const pr = (await store.loadConfig())?.permissionRules || {};
      return { allow: cleanRuleList(pr.allow), deny: cleanRuleList(pr.deny) };
    });
    ipcMain.handle('finalcheck:permission-rules-save', async (_e, rules) => {
      const { parseRules } = await import(engineUrl('desktop/src/main/permission-rules.mjs'));
      const next = { allow: cleanRuleList(rules?.allow), deny: cleanRuleList(rules?.deny) };
      const parsed = parseRules(next);
      if (parsed.errors.length) return { ok: false, errors: parsed.errors };
      const cfg = await store.loadConfig();
      await store.saveConfig({ ...cfg, permissionRules: next });
      return { ok: true, rules: next };
    });
    // 审批条「总是允许（存为规则）」：追加一条 allow；只接受能解析的单条规则
    ipcMain.handle('finalcheck:permission-rules-add', async (_e, kind, rule) => {
      const { parseRule } = await import(engineUrl('desktop/src/main/permission-rules.mjs'));
      const k = kind === 'deny' ? 'deny' : 'allow';
      const r = parseRule(rule);
      if (!r || r.error) return { ok: false, error: r?.error || '规则为空' };
      const cfg = await store.loadConfig();
      const cur = cfg.permissionRules || {};
      const list = cleanRuleList(cur[k]);
      if (!list.includes(r.raw)) list.push(r.raw);
      const next = { allow: cleanRuleList(cur.allow), deny: cleanRuleList(cur.deny), [k]: list };
      await store.saveConfig({ ...cfg, permissionRules: next });
      return { ok: true, rules: next };
    });
    // 「试一下」：用编辑框里还没保存的规则，判定一次假想的工具调用会怎样
    ipcMain.handle('finalcheck:permission-rules-test', async (_e, { rules, tool, input } = {}) => {
      const { parseRules, evaluateRules } = await import(engineUrl('desktop/src/main/permission-rules.mjs'));
      const parsed = parseRules({ allow: cleanRuleList(rules?.allow), deny: cleanRuleList(rules?.deny) });
      const name = String(tool || 'run_command');
      const value = String(input ?? '');
      const args = name === 'run_command' ? { command: value }
        : name === 'browser_navigate' ? { url: value }
          : { path: value };
      return { ...evaluateRules(parsed, name, args, { projectPath: activeProjectPath }), errors: parsed.errors };
    });
    // 0.33.0 文件检查点：把 AI 在某条用户消息之后改过的文件恢复原样（先出计划，确认后执行）
    const checkpointPlan = async (sessionId, keepUserTurns) => {
      const { planRewindFiles } = await import(engineUrl('desktop/src/main/checkpoints.mjs'));
      const s = await sessions.loadSession(String(sessionId || ''));
      return planRewindFiles(s?.messages || [], keepUserTurns);
    };
    ipcMain.handle('finalcheck:checkpoint-plan', (_e, sessionId, keepUserTurns) => checkpointPlan(sessionId, keepUserTurns));
    ipcMain.handle('finalcheck:checkpoint-restore', async (_e, sessionId, keepUserTurns) => {
      if (state.activeChats.has(sessionId)) return { error: '这个会话还在运行，先停止再恢复文件' };
      const { applyRewindFiles } = await import(engineUrl('desktop/src/main/checkpoints.mjs'));
      // 执行时重新算一遍计划（不信任渲染层传回来的文件清单）
      return applyRewindFiles(await checkpointPlan(sessionId, keepUserTurns));
    });
    ipcMain.handle('finalcheck:mcp-restart', async (_e, name) => {
      await mcp.restart(String(name || ''));
      return mcp.status();
    });
    await registerAgentIpc({
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
      shellAppRoot,
      // 0.34.1 任务栏提醒：提问/审批 → 红点+气泡音；任务完成 → 同样。
      // 无头环境（CLI/测试台）没窗口，模块里的 markAttention 会自己判空，不报错。
      attention: await import(engineUrl('desktop/src/main/attention.mjs')).catch(() => null)
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
    getHooksConfig: () => hooksConfig,
    mcp,
    syncMcp,
    shutdown: () => mcp.closeAll()
  };
}
