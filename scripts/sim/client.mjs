// 无头「模拟客户端」：不开窗口、不操作电脑，但走的是和真人一模一样的后端链路。
//
//   界面（这里用代码模拟）──IPC──▶ backend.mjs（桌面端同一份接线）──▶ 会话库 / 历史展开 / agent / 工具 / 落库
//
// 做法：给 createBackend 一个假的 ipcMain（只收集 handler）和一个假窗口（webContents.send 收事件），
// 然后像渲染层一样调用 handler：新建会话 → 设模型 → buildSendHistory（渲染层同一个函数）→ agent-chat。
// 提问卡（ask_user）、审批条、停止、Steer、重开会话、重启应用都按渲染层的调用方式模拟。
//
// 隔离：createSimClient 第一件事就是 isolateEnv()——所有数据目录、APPDATA、HOME 都指到临时目录。
import { cpSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateEnv } from './isolate.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const clip = (v, n = 300) => {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return s && s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s;
};

/** 事件写日志前把大字段截短（工具结果可能几十 KB） */
function compactEv(ev) {
  const out = {};
  for (const [k, v] of Object.entries(ev || {})) out[k] = typeof v === 'string' ? clip(v, 1500) : (v && typeof v === 'object' ? (JSON.stringify(v).length > 1500 ? clip(v, 1500) : v) : v);
  return out;
}

/** 日志：events.jsonl（机器读）+ run.log（人读） */
export function createSimLog(dir) {
  if (dir) mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const lines = [];
  const write = (type, data = {}) => {
    const rec = { t: Date.now() - t0, type, ...data };
    lines.push(rec);
    if (dir) {
      try { appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(rec) + '\n'); } catch { /* 日志失败不影响 */ }
    }
    return rec;
  };
  const human = (text) => {
    const line = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${text}`;
    if (dir) { try { appendFileSync(path.join(dir, 'run.log'), line + '\n'); } catch { /* 忽略 */ } }
    if (process.env.FC_SIM_VERBOSE === '1') console.log(line);
  };
  return { dir, write, human, lines };
}

/**
 * @param {object} o
 * @param {string} [o.label]
 * @param {string} [o.root]                 隔离根目录（默认新建临时目录）
 * @param {{ copyFrom?: string, files?: Record<string,string>, name?: string }} [o.project]
 * @param {{ url: string }} o.gateway       startGateway() 的返回（或任何 OpenAI 兼容地址）
 * @param {string} [o.model]
 * @param {string} [o.apiKey]
 * @param {Record<string, any>} [o.config]  额外写进 config.json 的字段（permissionMode / contextWindow 等）
 * @param {Record<string, any>} [o.providerExtra] 供应商额外字段（contextWindow / maxOutputTokens / family…）
 * @param {'approve'|'reject'|((p:any)=>string)} [o.approvals] 审批条怎么点（默认全部允许）
 * @param {(ask:any) => string|object|null} [o.answerAsk] 提问卡怎么回答（默认选第一个选项）
 * @param {string} [o.logDir]
 */
export async function createSimClient({
  label = 'sim', root = null, project = {}, gateway, model = 'sim-model', apiKey = 'sim-key', config = {}, providerExtra = {},
  approvals = 'approve', answerAsk = null, logDir = null
} = {}) {
  const env = isolateEnv({ root, label });
  const log = createSimLog(logDir);
  const engineUrl = (rel) => pathToFileURL(path.join(REPO_ROOT, rel)).href;
  // 先隔离，再 import 主进程模块
  const [{ createBackend }, { createConfigStore }, { installSafeIpc }, projects, sessions, { buildSendHistory }] = await Promise.all([
    import(engineUrl('desktop/src/main/backend.mjs')),
    import(engineUrl('desktop/src/main/ipc/config-store.mjs')),
    import(engineUrl('desktop/src/main/error-guard.mjs')),
    import(engineUrl('desktop/src/main/projects.mjs')),
    import(engineUrl('desktop/src/main/sessions.mjs')),
    import(engineUrl('desktop/src/renderer/lib/interrupted-digest.mjs'))
  ]);

  // ---- 项目：复制一份（绝不在原目录上跑）或按 files 现写 ----
  const projName = project.name || 'proj';
  const projDir = path.join(env.projectsRoot, projName);
  if (project.copyFrom) {
    cpSync(project.copyFrom, projDir, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git|\.finalcheck)([\\/]|$)/.test(src.slice(project.copyFrom.length)) });
  } else {
    mkdirSync(projDir, { recursive: true });
  }
  for (const [rel, content] of Object.entries(project.files || {})) {
    const f = path.join(projDir, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }

  // ---- 配置：只有一个供应商，指向模拟网关 ----
  const cfg = {
    providers: [{ id: 'sim', name: 'Sim', baseUrl: gateway.url, apiFormat: 'chat-completions', apiKey, models: [model], enabled: true, ...providerExtra }],
    activeProviderId: 'sim',
    activeModel: model,
    permissionMode: 'full',
    language: 'zh',
    thinkingEffort: 'default',
    ...config
  };
  writeFileSync(process.env.FINALCHECK_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  const proj = await projects.addProject(projDir, { name: projName });

  // ---- 假窗口：收集主进程推给渲染层的一切 ----
  const listeners = new Set();
  const fakeWin = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        for (const fn of [...listeners]) { try { fn(channel, payload); } catch (e) { log.write('listener-error', { error: String(e?.message || e) }); } }
      }
    }
  };

  let backend = null;
  let handlers = new Map();
  const boot = async () => {
    handlers = new Map();
    const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: (ch) => handlers.delete(ch), on() {} };
    installSafeIpc(ipcMain, { warn: { warn: (m) => log.write('ipc-error', { message: clip(m, 2000) }) } });
    const store = createConfigStore({ app: { getLocale: () => 'zh-CN' }, getDataRoot: () => env.dataRoot, engineUrl });
    backend = createBackend({ ipcMain, getWin: () => fakeWin, getDataRoot: () => env.dataRoot, engineUrl, repoRoot: REPO_ROOT, store, log: (l) => log.human('[main] ' + l) });
    const r = await backend.boot({ project: proj });
    await backend.registerCoreIpc();
    log.write('boot', { project: projDir, interrupted: r.interrupted });
    return r;
  };
  await boot();

  /** 像渲染层一样调用 IPC */
  const invoke = async (channel, ...args) => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error('没有注册这个 IPC：' + channel);
    log.write('ipc', { channel, args: clip(args, 500) });
    return fn({ sender: null }, ...args);
  };

  // ---- 自动处理审批条 / 提问卡（像用户在界面上点） ----
  listeners.add((channel, p) => {
    if (channel === 'finalcheck:approval-request') {
      // 审批决定只认 allowed-once / always-session / rejected（permissions.mjs 闭集）；
      // 以前这里给的是 'approved'——非法值按 rejected 处理，只是剧本都跑 full 模式才没暴露
      const d = typeof approvals === 'function' ? approvals(p) : (approvals === 'reject' ? 'rejected' : 'allowed-once');
      log.write('approval', { tool: p?.tool, summary: clip(p?.summary, 200), decision: d });
      log.human(`审批：${p?.tool} → ${d}`);
      setImmediate(() => { void invoke('finalcheck:approval-decide', p.callId, d); });
    } else if (channel === 'finalcheck:ask-user') {
      let ans = answerAsk ? answerAsk(p) : null;
      if (ans == null) ans = p?.options?.[0]?.label || '好的，按你的判断来';
      const payload = typeof ans === 'string' ? { callId: p.callId, answer: ans } : { callId: p.callId, ...ans };
      log.write('ask-user', { question: clip(p?.question, 300), options: (p?.options || []).map((o) => o.label), answer: clip(payload.answer ?? payload, 200) });
      log.human(`提问卡：${clip(p?.question, 120)} → ${clip(payload.answer ?? payload.selected, 80)}`);
      setImmediate(() => { void invoke('finalcheck:ask-user-answer', payload); });
    }
  });

  // 渲染层的显示历史（按会话），发下一条消息时由 buildSendHistory 生成 wire
  const ui = new Map();

  const newSession = async (title = '新会话') => {
    const s = await invoke('finalcheck:sessions:new', title);
    if (s?.error) throw new Error(s.error);
    ui.set(s.id, []);
    await invoke('finalcheck:sessions:set-model', s.id, { providerId: 'sim', model, effort: cfg.thinkingEffort });
    log.human(`新建会话 ${s.id}`);
    return s.id;
  };

  /** 打开会话：和渲染层一样从库里读，映射成显示历史 */
  const open = async (sid) => {
    const s = await invoke('finalcheck:sessions:open', sid);
    if (s?.error) throw new Error(s.error);
    ui.set(sid, (s.messages || []).map((m) => {
      const legacyCancel = m.error === '已取消' || m.error === '已中断';
      return { role: m.role, id: m.id ?? null, content: m.content ?? '', error: legacyCancel ? null : (m.error ?? null), interrupted: !!m.interrupted || legacyCancel, reasoning: m.reasoning || '', trace: m.trace || [], workedMs: m.workedMs ?? null, model: m.model ?? null, ...(m.kind ? { kind: m.kind } : {}) };
    }));
    return s;
  };

  /**
   * 发一条消息并等这一轮结束。
   * @param {string} sid
   * @param {string} text
   * @param {{ onEvent?: (ev:any, ctl:{cancel:()=>Promise<any>, steer:(t:string)=>Promise<any>}) => void, cancelAfterMs?: number }} [o]
   */
  const send = async (sid, text, { onEvent = null, cancelAfterMs = null } = {}) => {
    if (!ui.has(sid)) await open(sid);
    const startedAt = Date.now();
    const reqBefore = gateway.requests ? gateway.requests.length : 0;
    const base = ui.get(sid) || [];
    const sendHistory = buildSendHistory(base);
    const wire = [...sendHistory.wire, { role: 'user', content: text }];
    log.write('send', { sessionId: sid, text: clip(text, 1000), wireLen: wire.length });
    log.human(`▶ 用户：${clip(text, 160)}`);
    const events = [];
    let streamed = '';
    const ctl = {
      cancel: () => invoke('finalcheck:agent-cancel', sid),
      steer: (t) => invoke('finalcheck:agent-steer', sid, t)
    };
    const onMsg = (channel, p) => {
      if (p?.sessionId !== sid) return;
      if (channel === 'finalcheck:agent-token') { streamed += p.text || ''; return; }
      if (channel !== 'finalcheck:agent-event') return;
      const ev = p.ev || {};
      events.push(ev);
      if (ev.kind === 'tool-start' || ev.kind === 'tool') log.human(`  工具 ${ev.tool || ev.name}${ev.args ? ' ' + clip(ev.args, 140) : ''}`);
      else if (ev.kind === 'tool-end') log.human(`  工具结束 ${ev.tool || ev.name} ${ev.ok === false || ev.error ? '✗ ' + clip(ev.error, 120) : '✓'}${ev.ms != null ? ` ${ev.ms}ms` : ''}`);
      else if (['notice', 'warning', 'compact-start', 'compact-end', 'workflow-start'].includes(ev.kind)) log.human(`  [${ev.kind}] ${clip(ev.message || ev.label || '', 200)}`);
      if (!['activity', 'phase', 'thinking-token'].includes(ev.kind)) log.write('event', { sessionId: sid, ev: compactEv(ev) });
      try { onEvent?.(ev, ctl); } catch (e) { log.write('onEvent-error', { error: String(e?.message || e) }); }
    };
    listeners.add(onMsg);
    let timer = null;
    if (cancelAfterMs != null) timer = setTimeout(() => { void ctl.cancel(); }, cancelAfterMs);
    let r;
    try {
      r = await invoke('finalcheck:agent-chat', wire, [], sid);
    } finally {
      listeners.delete(onMsg);
      if (timer) clearTimeout(timer);
    }
    // 渲染层收尾：把这一轮的 assistant 放进显示历史（与 App.jsx 同一套分支）
    const list = [...base, { role: 'user', content: text }];
    if (r?.cancelled || r?.error === '已取消') list.push({ role: 'assistant', content: r.partialContent || streamed || '', interrupted: true, trace: r.trace || [] });
    else if (r?.error) list.push({ role: 'assistant', content: '', error: r.error, trace: r.trace || [] });
    else list.push({ role: 'assistant', content: r?.answer || streamed || '(空回复)', trace: r?.trace || [] });
    ui.set(sid, list);
    const requests = gateway.requests ? gateway.requests.slice(reqBefore) : [];
    const trace = Array.isArray(r?.trace) ? r.trace : [];
    const turn = {
      sessionId: sid,
      result: r,
      answer: r?.answer ?? '',
      error: r?.error ?? null,
      cancelled: !!r?.cancelled,
      interrupted: !!r?.interrupted,
      events,
      trace,
      tools: trace.map((x) => x?.tool || x?.name).filter(Boolean),
      toolMs: events.filter((e) => e.kind === 'tool-end').reduce((a, e) => a + (Number(e.ms) || 0), 0),
      requests,
      ms: Date.now() - startedAt
    };
    const main = requests.filter((q) => q.kind === 'main');
    log.write('turn', {
      sessionId: sid, ms: turn.ms, answer: clip(turn.answer, 2000), error: turn.error, cancelled: turn.cancelled,
      tools: turn.tools, requests: requests.length, mainRequests: main.length,
      estPromptTokens: main.reduce((a, q) => a + (q.estPromptTokens || 0), 0), estCachedTokens: main.reduce((a, q) => a + (q.estCachedTokens || 0), 0)
    });
    log.human(`◀ AI（${(turn.ms / 1000).toFixed(1)}s，${turn.tools.length} 次工具，${requests.length} 次请求）：${clip(turn.error ? '错误：' + turn.error : turn.answer, 240)}`);
    return turn;
  };

  /** 模拟「关掉应用再打开」：丢掉渲染层状态，重建后端并跑启动收尾；之后要 open() 才能接着聊 */
  const restart = async () => {
    log.human('— 重启应用 —');
    ui.clear();
    return boot();
  };

  const close = async () => {
    try { sessions.closeAllSessionDatabases?.(); } catch { /* 忽略 */ }
  };

  return {
    env, projectDir: projDir, project: proj, log, invoke, handlers: () => handlers,
    newSession, open, send, restart, close,
    loadSession: (sid) => sessions.loadSession(sid),
    ui: (sid) => ui.get(sid) || [],
    backend: () => backend,
    exists: (rel) => existsSync(path.join(projDir, rel))
  };
}
