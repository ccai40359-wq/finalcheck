// DeepSeek 式对话主界面：左栏品牌 + 会话列表，中央聊天流（工具调用渲染富卡片）
// 仅两个视图：「对话」（默认）与「模型设置」（左下角齿轮进入）
// 拆分后 App 只保留状态 / effects / handler 与编排；展示与弹层在 components/ 下按职责分开。
import React, { useEffect, useRef, useState } from 'react';
import SettingsPage from './pages/SettingsPage.jsx';
import { api } from './lib/ui.jsx';
import { mergeRunningRun } from './lib/session-restore.mjs';
import { applyAgentEvent, mergeTraceIntoEvents } from './chat/ProcessTimeline.jsx';
import { ArtifactPanel } from './chat/ArtifactPanel.jsx';
import { SubagentPanel } from './chat/SubagentPanel.jsx';
// 双语：t() 在英文模式查词典、中文模式原样返回；useLanguage() 只负责切换语言时触发重渲染
import { t, setLanguage, resolveLanguage } from './i18n/core.mjs';
import { useLanguage } from './i18n/index.jsx';
import {
  modelIdsOf, nextQueueId, nextPasteId, countLines, needsFirstRunSetup, prettyTitle, baseName, expandSkill
} from './lib/app-helpers.mjs';
import TitleBar from './components/TitleBar.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatHeader from './components/ChatHeader.jsx';
import MessageList from './components/MessageList.jsx';
import EmptyState from './components/EmptyState.jsx';
import Composer from './components/Composer.jsx';
import Dialogs from './components/Dialogs.jsx';
// 兼容原来的模块出口（外部若按旧路径取这两个函数/组件仍可用）
export { needsFirstRunSetup, formatDemoAuditSummary } from './lib/app-helpers.mjs';
export { default as FirstRunCard } from './components/FirstRunCard.jsx';

// ---- 排队（AI 回合进行中还能继续发消息）的纯函数 ----
// 注释段 + BEGIN/END 标记供 tests/queue-steer.test.mjs 提取单测：这里不要写副作用、不要依赖 React/JSX。
/* QUEUE-HELPERS-BEGIN */
const enqueue = (list, item) => [...(Array.isArray(list) ? list : []), item];
const takeNext = (list) => {
  const l = Array.isArray(list) ? list : [];
  return l.length ? { item: l[0], rest: l.slice(1) } : { item: null, rest: l };
};
const removeById = (list, id) => {
  const l = Array.isArray(list) ? list : [];
  return l.some((x) => x && x.id === id) ? l.filter((x) => x && x.id !== id) : l;
};
const moveToInput = (list, id) => {
  const l = Array.isArray(list) ? list : [];
  const item = l.find((x) => x && x.id === id) || null;
  return { item, rest: item ? l.filter((x) => x && x.id !== id) : l };
};
/* QUEUE-HELPERS-END */

export default function App() {
  const y = api(); // window.finalcheck（浏览器直开时为空 → 仅壳）
  useLanguage(); // 订阅语言状态：设置页切换语言后整棵界面重渲染（t() 读的是最新语言）
  const [page, setPage] = useState('chat');
  const [sessions, setSessions] = useState([]);       // 当前项目的会话 [{id,title,updatedAt,turns}]
  const [projects, setProjects] = useState([]);       // [{id,name,path,isDefault,sessionCount}]
  const [activeProjectId, setActiveProjectId] = useState(null);
  // 当前「所在会话/草稿」所属的项目：顶部 New Session 默认开在这里，
  // 不跟着侧栏展开/收起别的 Workspace 漂移；openSession / 新建草稿 / 切项目时写入。
  const [activeSessionProjectId, setActiveSessionProjectId] = useState(null);
  // 每个项目的会话缓存：{ [projectId]: sessions[] }。展开 Workspace 时按需拉一次；
  // 当前项目的刷新（发消息/归档/重命名/删除）同步写回这里的当前项目桶。
  const [projectSessions, setProjectSessions] = useState({});
  const projectSessionsRef = useRef({});       // 与 projectSessions 同步：异步回调里读最新缓存
  const loadingProjectsRef = useRef(new Set()); // 正在请求中的项目（防重复 IPC）
  const [activeId, setActiveId] = useState(null);     // 当前会话 ID（agentChat 第三参）
  const [messages, setMessages] = useState([]);       // 当前会话消息（含流式助手占位）
  const [input, setInput] = useState('');
  const [editing, setEditing] = useState(null); // {index, keepTurns}：编辑历史消息，发送后从该条重开
  const [runningIds, setRunningIds] = useState({}); // 会话 id → 是否正在跑（多会话可同时跑）
  const [stoppingIds, setStoppingIds] = useState({}); // 会话 id → 已点停止、等待主进程收尾
  const [sessCfg, setSessCfg] = useState({ providerId: '', model: '', effort: '' }); // 当前会话自己的模型配置
  const [effortPos, setEffortPos] = useState(null); // 拖动中的连续位置（0-4，可为小数；松手后按最近档位落库）
  const activeIdRef = useRef(null);   // 供异步回调判断「现在看的是哪个会话」
  const activeProjectIdRef = useRef(null); // 同上：异步回调里判断「当前项目」
  const activeSessionProjectIdRef = useRef(null); // 同上：当前会话/草稿的项目归属
  const runsRef = useRef(new Map());  // sid → { content, events, startedAt }（后台会话的实时流）
  const stoppedRef = useRef(new Set()); // 手动停止过的会话：屏蔽迟到的流式事件把消息变回 streaming
  const stoppingRef = useRef(new Set()); // 已发出停止请求的会话：阻止重复点击
  const approvalsRef = useRef([]);    // 排队中的审批（并行子代理可能同时要命令审批）
  const pumpingRef = useRef(false);   // 正在消费队首 → 防止 effect 在 runningIds 落定前重复派发
  const inflightRef = useRef(new Set()); // 仍在 send 里的会话：回合收尾前不自动发下一条（防旧 finally 清掉新一轮状态）
  const jumpingRef = useRef(false);   // 平滑回到底部动画中：滚动事件不要重新弹出箭头
  const [queueBySession, setQueueBySession] = useState({}); // 会话 id → 待发消息 FIFO：[{id,text,pasted,previews}]（必须先于 queueItems 声明）
  const busy = !!runningIds[activeId];
  const stopping = !!stoppingIds[activeId];
  const queueItems = queueBySession[activeId || 'draft'] || []; // 当前会话的排队消息（切会话各自独立）
  const [approval, setApproval] = useState(null); // 待审批：{callId, tool, summary}（主进程 fail-closed 推送）
  const [confirmBox, setConfirmBox] = useState(null); // 自定义确认框：{text, resolve}
  const [rowMenu, setRowMenu] = useState(null); // 会话右键菜单：{x,y,session,project}
  const [renameBox, setRenameBox] = useState(null); // {session,value}
  const [moveOpen, setMoveOpen] = useState(false);
  // 工作区展开状态（{ [projectId]: boolean }）：可同时展开多个；当前项目默认展开，别的项目点开才展开。
  // undefined = 默认值（当前项目展开 / 其它项目折叠），显式 true/false 覆盖。
  const [expandedProjects, setExpandedProjects] = useState({});
  const [showAllSessions, setShowAllSessions] = useState({});     // 每个工作区：默认 5 条，Show more 展开
  const [showArchived, setShowArchived] = useState({});           // 每个工作区：归档会话默认隐藏，点 Archived 才展开
  const [permMode, setPermMode] = useState('ask'); // 'ask'=标准审批 | 'full'=完全权限（仿 ZCode）
  const [menu, setMenu] = useState(null); // 'perm' | 'model' | 'context' | null
  const [providerMenu, setProviderMenu] = useState(false); // 模型面板右侧的供应商列表
  const [cfg, setCfg] = useState(null);
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [updateVersion, setUpdateVersion] = useState(''); // 有新版本时在 Settings 入口点红点
  // 首次使用向导：本会话内可「稍后配置」跳过（存 localStorage）
  const [setupDismissed, setSetupDismissed] = useState(() => {
    try { return typeof localStorage !== 'undefined' && localStorage.getItem('fc.setupSkipped') === '1'; } catch { return false; }
  });
  const [demoBusy, setDemoBusy] = useState(false);
  const [ctxStats, setCtxStats] = useState(null);
  const [attachments, setAttachments] = useState([]); // [{path,name,size,preview}]
  const [pastedBlocks, setPastedBlocks] = useState([]); // 长粘贴文本块：[{id,text,lines,expanded}]（发送时并入正文）
  const [showJump, setShowJump] = useState(false); // 聊天区不在底部时显示「回到底部」按钮
  const [artifact, setArtifact] = useState(null);
  const [stepView, setStepView] = useState(null); // 右侧子代理上下文面板：{sessionId, stepId, name, role} // 右侧预览的已加载产物
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState('');
  const [skills, setSkills] = useState([]); // 40 类方法论（slash 菜单）
  const [slashIndex, setSlashIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [openWorkflowRaw, setOpenWorkflowRaw] = useState(null); // 哪条 workflow 消息展开了原始指令
  // 切换会话时清掉「编辑中」状态（避免把上一条会话的内容发到新会话）
  useEffect(() => { setEditing(null); }, [activeId]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // 会话级模型默认值：新会话继承全局默认，之后各会话互不影响
  const cfgDefaults = () => {
    const list = (cfg?.providers || []).filter((p) => p.enabled && p.baseUrl && p.apiKey && p.models?.length);
    const p = list.find((x) => x.id === cfg?.activeProviderId) || list[0] || null;
    const ids = modelIdsOf(p);
    const model = (p && cfg?.activeModel && ids.includes(cfg.activeModel)) ? cfg.activeModel : (ids[0] || '');
    return { providerId: p?.id || '', model, effort: cfg?.thinkingEffort || 'max' };
  };
  const applySessionCfg = (s) => {
    const mc = s?.modelConfig || {};
    const d = cfgDefaults();
    setSessCfg({ providerId: mc.providerId || d.providerId, model: mc.model || d.model, effort: mc.effort || d.effort });
  };
  useEffect(() => {
    if (!cfg) return;
    setSessCfg((prev) => {
      if (prev.providerId && prev.model) return prev;
      const d = cfgDefaults();
      return { providerId: prev.providerId || d.providerId, model: prev.model || d.model, effort: prev.effort || d.effort };
    });
  }, [cfg]);
  const [booted, setBooted] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const stickRef = useRef(true); // 是否跟随输出（用户往上翻时不再抢滚动条）
  const modelMenuRef = useRef(null); // 模型菜单 + 供应商子菜单 + 触发按钮
  const rowMenuRef = useRef(null);   // 会话右键菜单内容

  const scrollDown = () => {
    stickRef.current = true;
    setShowJump(false);
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };
  // 只有用户本来就在底部附近才自动跟随；往上看历史时保持不动
  const autoScroll = () => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setShowJump(false);
  };
  useEffect(autoScroll, [messages]);

  const cacheProjectSessions = (projectId, list) => {
    if (!projectId) return;
    projectSessionsRef.current = { ...projectSessionsRef.current, [projectId]: Array.isArray(list) ? list : [] };
    setProjectSessions(projectSessionsRef.current);
  };

  // 当前项目列表的读写都走这里：同一份数据写进 sessions 与对应项目缓存
  const refreshSessions = async (projectId = activeProjectIdRef.current) => {
    if (!y) return [];
    try {
      const list = await y.sessions.list();
      // IPC 期间用户切走了：sessions.list() 读的是主进程「那一刻」的当前项目，
      // 不能把它写进旧项目的缓存；按只读 IPC 重新核对一次归属。
      if (projectId && projectId !== activeProjectIdRef.current) {
        return loadProjectSessions(projectId, { force: true });
      }
      setSessions(list);
      cacheProjectSessions(projectId, list);
      return list;
    } catch { return []; }
  };

  // 刷新某个项目：当前项目沿用 sessions.list()（和聊天区同一份事实源），
  // 别的项目走只读 IPC（finalcheck:projects:sessions），不切当前项目、不动环境变量。
  const refreshProjectSessions = async (projectId) => {
    if (!y || !projectId) return [];
    if (projectId === activeProjectIdRef.current) return refreshSessions(projectId);
    try {
      const list = y.projects?.sessions ? await y.projects.sessions(projectId) : [];
      cacheProjectSessions(projectId, list);
      return list;
    } catch { return []; }
  };

  // 展开别的项目时才拉会话（惰性 + 缓存）：已缓存/in-flight 都不再发 IPC
  const loadProjectSessions = async (projectId, { force = false } = {}) => {
    if (!projectId) return [];
    if (!y?.projects?.sessions) { cacheProjectSessions(projectId, []); return []; }
    if (!force && projectSessionsRef.current[projectId] !== undefined) return projectSessionsRef.current[projectId];
    if (loadingProjectsRef.current.has(projectId)) return projectSessionsRef.current[projectId] || [];
    loadingProjectsRef.current.add(projectId);
    try {
      const list = await y.projects.sessions(projectId);
      cacheProjectSessions(projectId, list);
      return projectSessionsRef.current[projectId];
    } catch {
      cacheProjectSessions(projectId, []);
      return [];
    } finally {
      loadingProjectsRef.current.delete(projectId);
    }
  };

  // 按会话 id 找它属于哪个项目（缓存里的会话只属于一个项目）
  const projectIdOfSession = (sessionId) => {
    if (!sessionId) return null;
    for (const [pid, list] of Object.entries(projectSessionsRef.current)) {
      if (Array.isArray(list) && list.some((s) => s.id === sessionId)) return pid;
    }
    return null;
  };

  // 局部更新某个项目的会话列表（标题/轮数）；当前项目同时更新 sessions
  const patchSessionsOf = (projectId, fn) => {
    if (!projectId) return;
    const prev = projectSessionsRef.current[projectId] || [];
    const next = fn(prev);
    cacheProjectSessions(projectId, next);
    if (projectId === activeProjectIdRef.current) setSessions(next);
  };

  const refreshProjects = async () => {
    if (!y?.projects) return [];
    try { const list = await y.projects.list(); setProjects(list); return list; } catch { return []; }
  };

  // 「自动打开」只挑未归档会话：归档的默认看不见，也就不该被打开；
  // 整个项目都归档了就停在新会话页（用户 2026-11-10 反馈：点项目不该跳回一条已归档的对话）
  const firstOpenable = (list) => (Array.isArray(list) ? list.find((x) => !x.archived) : null) || null;

  // 当前项目默认展开；显式状态优先（可同时展开多个 Workspace）
  const isProjectExpanded = (p) => {
    const v = expandedProjects[p.id];
    if (typeof v === 'boolean') return v;
    return p.id === activeProjectId;
  };

  // 切「当前项目」只影响模型/权限/New Session 的归属，并保持所有已展开的 Workspace 展开
  const activateProject = (id) => {
    const prev = activeProjectIdRef.current;
    setExpandedProjects((s) => {
      const next = { ...s };
      if (prev && isProjectExpanded({ id: prev })) next[prev] = true; // 已展开的项目离开后不折叠
      if (id) next[id] = true; // 切过去/点会话的项目保持展开
      return next;
    });
    activeProjectIdRef.current = id || null;
    setActiveProjectId(id || null);
  };

  // 记录「当前所在会话/草稿」的项目归属；顶栏 New Session 的默认归属靠它，
  // 即使侧栏只是展开/收起其它 Workspace（不切当前项目）也不会跟着漂。
  const rememberSessionProject = (projectId) => {
    const id = projectId || null;
    activeSessionProjectIdRef.current = id;
    setActiveSessionProjectId(id);
  };

  // 切项目只切 UI 视角（ZCode 语义）：不中断任何在跑的回合，runsRef 里的后台流原样保留
  const switchProject = async (p) => {
    if (!p) return;
    await y.projects.select(p.id);
    activateProject(p.id);
    rememberSessionProject(p.id); // 项目里没有可打开的会话时，空白草稿也属于这个项目
    setArtifact(null);
    setAttachments([]);
    setInput('');
    const list = await refreshSessions(p.id);
    const pick = firstOpenable(list);
    if (pick) await openSession(pick.id, p.id);
    else { setActiveId(null); setMessages([]); }
    setPage('chat');
  };

  // 工作区行：只展开/收起它自己的会话，不再切「当前项目」（切项目发生在点会话时）
  const toggleProject = (p) => {
    const expanded = isProjectExpanded(p);
    setExpandedProjects((s) => ({ ...s, [p.id]: !expanded }));
    if (!expanded) loadProjectSessions(p.id); // 首次展开才拉；有缓存直接命中
  };

  // 展开的「非当前」项目：惰性拉一次（缓存命中不重复 IPC）；当前项目由 refreshSessions 维护
  useEffect(() => {
    if (!y?.projects?.sessions) return;
    for (const p of projects) {
      if (p.id === activeProjectIdRef.current) continue;
      if (!isProjectExpanded(p)) continue;
      loadProjectSessions(p.id);
    }
    // eslint 不扫 JSX 文件；loadProjectSessions 每次都重新创建，靠缓存/in-flight 去重
  }, [projects, expandedProjects, activeProjectId]);

  const addProject = async () => {
    if (!y?.pickDirectory || !y?.projects) return;
    const dir = await y.pickDirectory();
    if (!dir) return;
    try {
      const p = await y.projects.add(dir);
      await refreshProjects();
      await switchProject(p);
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'notice', content: t('添加项目失败：{msg}', { msg: e.message }) }]);
    }
  };

  const removeProject = async (p) => {
    if (!y?.projects) return;
    const ok = await new Promise((resolve) => setConfirmBox({
      text: t('从项目列表移除「{name}」？不会删除磁盘文件夹，只移除这里的入口。', { name: p.name }),
      resolve
    }));
    setConfirmBox(null);
    if (!ok) return;
    try {
      const r = await y.projects.remove(p.id);
      // 移除的项目：展开状态与缓存一起清掉
      const restCache = { ...projectSessionsRef.current };
      delete restCache[p.id];
      projectSessionsRef.current = restCache;
      setProjectSessions(restCache);
      setExpandedProjects((s) => { if (!(p.id in s)) return s; const n = { ...s }; delete n[p.id]; return n; });
      const list = await refreshProjects();
      if (activeSessionProjectIdRef.current === p.id) rememberSessionProject(null); // 当前会话的项目已移除：归属先清空
      if (activeProjectId === p.id) {
        const next = list[0] || r.projects?.[0];
        if (next) await switchProject(next);
        else { activateProject(null); setSessions([]); setMessages([]); setActiveId(null); }
      }
    } catch { /* 忽略 */ }
  };

  const copyText = (text) => { const p = y?.copyText?.(text); if (p?.catch) p.catch(() => {}); };
  const patchFlags = async (s, flags, projectId = null) => {
    setRowMenu(null);
    try {
      await y.sessions.flags(s.id, flags);
      await refreshProjectSessions(projectId || projectIdOfSession(s.id) || activeProjectIdRef.current);
    } catch { /* 忽略 */ }
  };
  const moveSession = async (s, targetProjectId, sourceProjectId = null) => {
    setRowMenu(null);
    setMoveOpen(false);
    try {
      await y.sessions.move(s.id, targetProjectId);
      await refreshProjectSessions(sourceProjectId || projectIdOfSession(s.id) || activeProjectIdRef.current);
      await refreshProjectSessions(targetProjectId); // 目标项目缓存同步（未展开也保持最新）
      await refreshProjects();
      if (activeIdRef.current === s.id) rememberSessionProject(targetProjectId); // 当前会话被移动：归属跟着走
    } catch (e) { setMessages((prev) => [...prev, { role: 'notice', content: t('移动失败：{msg}', { msg: e.message }) }]); }
  };
  const saveRename = async () => {
    if (!renameBox) return;
    const { session, value } = renameBox;
    setRenameBox(null);
    if (!String(value || '').trim()) return;
    try {
      await y.sessions.rename(session.id, value);
      await refreshProjectSessions(renameBox.projectId || projectIdOfSession(session.id) || activeProjectIdRef.current);
    } catch { /* 忽略 */ }
  };
  // 切项目不再走「先停掉所有回合」：主进程按会话所属项目继续跑，切 Workspace 只换 UI 视角
  // projectId：这条会话所属项目（跨项目点会话时先 select 再 open，刷新缓存也落到该项目）
  const openSession = async (id, projectId = null) => {
    if (!y) return;
    try {
      const s = await y.sessions.open(id);
      // 归属：调用方传入的项目 → 会话缓存里的目录登记 → 当前项目（老会话/未登记时兜底）
      rememberSessionProject(projectId || projectIdOfSession(s.id) || activeProjectIdRef.current);
      setActiveId(s.id);
      activeIdRef.current = s.id;
      applySessionCfg(s);
      stickRef.current = true; // 切会话回到最新位置
      const loaded = (s.messages || []).map((m) => {
        // 旧版本把「用户点停止」写成了 error='已取消' → 读档时按「已中断」还原，不再显示红色报错
        const legacyCancel = m.error === '已取消' || m.error === '已中断';
        return { role: m.role, content: m.content ?? '', error: legacyCancel ? null : (m.error ?? null), interrupted: !!m.interrupted || legacyCancel, reasoning: m.reasoning || '', trace: m.trace || [], workedMs: m.workedMs ?? null };
      });
      // 后台还在跑的会话：把实时流叠加到磁盘历史后面（切回来能继续看到输出 + 工作流卡片）
      const run = runsRef.current.get(id);
      const merged = mergeRunningRun(loaded, run, { stopped: stoppedRef.current.has(id) });
      setMessages(merged.messages);
      setStepView(null); // 面板属于某个会话的某一步：切会话就收起，别留着上一条的上下文
      setPage('chat');
      refreshSessions(projectId || activeProjectIdRef.current); // markRead 已在主进程清掉 unread → 绿点消失
    } catch { refreshSessions(projectId || activeProjectIdRef.current); }
  };

  // 点某个 Workspace 下的会话：不属于当前项目 → 先切到它所属项目（模型/权限/New Session 跟着走），再打开
  const openProjectSession = async (p, s) => {
    if (!y) return;
    if (p.id !== activeProjectIdRef.current) {
      try {
        await y.projects.select(p.id);
        activateProject(p.id);
        setArtifact(null);
        setAttachments([]);
        setInput('');
      } catch { return; }
      await refreshSessions(p.id); // 切过去后当前项目列表就位（同时写缓存）
    }
    await openSession(s.id, p.id);
  };

  // 清空「草稿页」的界面状态：不读取任何「当前项目」，项目归属由调用方决定
  const resetDraftState = () => {
    setActiveId(null);
    activeIdRef.current = null;
    stickRef.current = true;
    setMessages([]);
    setEditing(null);
    setAttachments([]);
    setInput('');
    setPastedBlocks([]);
    setArtifact(null);
    setStepView(null); // 新建草稿时必须收起子代理面板：否则会把上一条会话的子代理对话留在右边栏
    setSessCfg(cfgDefaults());
    setPage('chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // dsh 语义：New Session 只是「开一张空白草稿」，不落盘；
  // 真正创建会话文件是在第一次发送消息那一刻（send() 里 sid 为空时 create）
  // 默认归属顺序：当前打开会话/草稿的项目 → 当前激活项目 → 第一个项目（已删除的跳过）
  const newSession = async () => {
    if (!y) { resetDraftState(); return; }
    const target = [activeSessionProjectIdRef.current, activeProjectIdRef.current]
      .map((id) => projects.find((p) => p.id === id))
      .find(Boolean) || projects[0] || null;
    if (target) {
      if (target.id !== activeProjectIdRef.current) {
        try { await y.projects.select(target.id); } catch { /* 项目已失效：仍按 UI 归属开草稿 */ }
        activateProject(target.id);
        await refreshProjectSessions(target.id); // 换到新项目后侧栏会话列表就位
      }
      rememberSessionProject(target.id); // 连续 New Session 留在同一个项目
    } else {
      rememberSessionProject(null);
    }
    resetDraftState();
  };

  // 项目行 hover 的 ＋：在该项目里开一个新对话（不触发行本身的展开/收起）
  const newSessionInProject = async (p) => {
    if (!p) return;
    if (y?.projects?.select) {
      try { await y.projects.select(p.id); } catch { /* 项目已失效：仍按 UI 归属开草稿 */ }
    }
    activateProject(p.id);
    rememberSessionProject(p.id);
    setExpandedProjects((s) => ({ ...s, [p.id]: true })); // 点 ＋ 后项目保持展开
    resetDraftState();
    await refreshProjectSessions(p.id); // 拉一次该项目的会话列表
  };

  const archiveSession = async (s, projectId = null) => {
    if (!y?.sessions?.flags) return;
    const pid = projectId || projectIdOfSession(s.id) || activeProjectIdRef.current;
    const next = !s.archived;
    try { await y.sessions.flags(s.id, { archived: next }); } catch { return; }
    const list = await refreshProjectSessions(pid);
    refreshProjects();
    // 归档正在看的那条（只在它所属项目就是当前项目时）：自动打开下一条未归档的
    if (next && activeId === s.id && pid === activeProjectIdRef.current && page === 'chat') {
      const pick = (list || []).find((x) => !x.archived && x.id !== s.id);
      if (pick) openSession(pick.id);
      else { setActiveId(null); setMessages([]); }
    }
  };

  const removeSession = async (s, projectId = null) => {
    if (!y) return;
    const pid = projectId || projectIdOfSession(s.id) || activeProjectIdRef.current;
    // 自定义黑金确认框（原生 window.confirm 太丑，用户实测点名）
    const ok = await new Promise((resolve) => {
      setConfirmBox({
        text: t('删除会话「{title}」？此操作不可恢复。', { title: prettyTitle(s.title) || t('未命名') }),
        resolve
      });
    });
    setConfirmBox(null);
    if (!ok) return;
    try { await y.sessions.remove(s.id); } catch { /* 忽略 */ }
    const list = await refreshProjectSessions(pid);
    refreshProjects();
    if (activeId === s.id && pid === activeProjectIdRef.current) {
      setActiveId(null);
      setMessages([]);
      const pick = firstOpenable(list);
      if (pick) openSession(pick.id);
    }
  };

  // 启动：加载项目列表，选中默认/当前项目，再加载该项目下的会话
  useEffect(() => {
    if (!y) { setBooted(true); return; }
    (async () => {
      const plist = await refreshProjects();
      const curId = await y.projects?.current?.();
      const p = plist.find((x) => x.id === curId) || plist[0] || null;
      if (p) {
        try { await y.projects.select(p.id); activateProject(p.id); } catch { /* 忽略 */ }
        const list = await refreshSessions(p.id);
        const pick = firstOpenable(list);
        if (pick) await openSession(pick.id, p.id);
      }
      setBooted(true);
    })();
    // 权限模式 / 模型 / 思考强度：启动时从配置载入（仿 ZCode Full access）
    Promise.resolve(y.getConfig?.())
      .then((c) => { setCfg(c || null); setPermMode(c?.permissionMode === 'full' ? 'full' : 'ask'); setLanguage(resolveLanguage(c?.language, navigator.language)); })
      .catch(() => {})
      .finally(() => setCfgLoaded(true));
    y.skillsList?.().then((list) => setSkills(Array.isArray(list) ? list : [])).catch(() => {});
  }, []);

  // 从设置页回到对话：重新读配置（模型/effort 可能在设置页改过）
  useEffect(() => {
    if (page !== 'chat' || !y) return;
    y.getConfig?.().then((c) => { setCfg(c); setPermMode(c?.permissionMode === 'full' ? 'full' : 'ask'); setLanguage(resolveLanguage(c?.language, navigator.language)); }).catch(() => {});
  }, [page]);

  // 首次使用向导：没有供应商（或全部 disabled）时显示；有可用供应商后清掉跳过标记
  const needsSetup = needsFirstRunSetup(cfg);
  useEffect(() => {
    if (!cfgLoaded || needsSetup) return; // 只有已经配好供应商时才清掉跳过标记
    setSetupDismissed(false);
    try { localStorage.removeItem('fc.setupSkipped'); } catch { /* 忽略 */ }
  }, [cfgLoaded, needsSetup]);
  const showSetup = !!y && cfgLoaded && !setupDismissed && needsSetup;

  const skipSetup = () => {
    setSetupDismissed(true);
    try { localStorage.setItem('fc.setupSkipped', '1'); } catch { /* 忽略 */ }
  };
  const finishSetup = (nextCfg, provider) => {
    setCfg(nextCfg || null);
    setSetupDismissed(true);
    try { localStorage.removeItem('fc.setupSkipped'); } catch { /* 忽略 */ }
    setSessCfg({
      providerId: provider?.id || '',
      model: modelIdsOf(provider)[0] || '',
      effort: nextCfg?.thinkingEffort || cfg?.thinkingEffort || 'max'
    });
    setPage('chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Context 指示器：消息变化后 500ms 估算一次（主进程算系统提示/工具 schema/技能目录/摘要）
  useEffect(() => {
    if (!y?.contextStats) return undefined;
    const t = setTimeout(() => {
      y.contextStats({ messages: messages.filter((m) => !m.steer), sessionId: activeId }).then(setCtxStats).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [messages, activeId, cfg]);

  // 流式 token：按 sessionId 路由（多会话可同时跑；看不到的会话先攒在 runsRef 里）
  useEffect(() => {
    if (!y?.onAgentToken) return undefined;
    return y.onAgentToken((p) => {
      const sid = p && typeof p === 'object' ? p.sessionId : null;
      const txt = p && typeof p === 'object' ? p.text : '';
      if (!sid || typeof txt !== 'string' || !txt) return;
      const run = runsRef.current.get(sid);
      if (run) run.content += txt;
      if (activeIdRef.current !== sid) return;
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role !== 'assistant' || last.error) return prev;
        if (last.streaming) next[next.length - 1] = { ...last, content: last.content + txt };
        // 已手动停止：只补内容，绝不把消息变回 streaming
        else if (stoppedRef.current.has(sid) && last.interrupted) next[next.length - 1] = { ...last, content: (last.content || '') + txt, streaming: false };
        return next;
      });
    });
  }, [y]);

  // 过程时间线：主进程 agent 事件流（含 sessionId）→ 归约到对应会话的流式消息
  useEffect(() => {
    if (!y?.onAgentEvent) return undefined;
    return y.onAgentEvent((p) => {
      const sid = p && typeof p === 'object' ? p.sessionId : null;
      const ev = p && typeof p === 'object' ? p.ev : p;
      if (!sid || !ev) return;
      const run = runsRef.current.get(sid);
      if (run) {
        run.events = [...(run.events || []), ev];
        // 工作流快照单独存一份：切走再切回来时卡片要能原样恢复（只存 events 会丢卡片）
        if (ev.kind === 'workflow') run.workflow = ev;
        if (ev.kind === 'workflow-start') run.workflowStarting = true;
      }
      if (ev.kind === 'turn-end') {
        setStoppingIds((prev) => { if (!prev[sid]) return prev; const n = { ...prev }; delete n[sid]; return n; });
        stoppingRef.current.delete(sid);
      }
      if (activeIdRef.current !== sid) return;
      // Steer：用户中途注入当前回合。插在流式助手消息之前，画一条带徽标的用户气泡；
      // 它不属于会话历史（主进程只把它并进本轮上下文），所以不参与编辑/回退。
      if (ev.kind === 'steer') {
        const bubble = { role: 'user', content: String(ev.text || ''), steer: true };
        setMessages((prev) => {
          const i = prev.length - 1;
          if (i >= 0 && prev[i]?.role === 'assistant' && prev[i]?.streaming) return [...prev.slice(0, i), bubble, prev[i]];
          return [...prev, bubble];
        });
        return;
      }
      setMessages((prev) => {
        const i = prev.length - 1;
        if (i < 0 || prev[i]?.role !== 'assistant') return prev;
        if (stoppedRef.current.has(sid)) {
          // 手动停止后：只接受 turn-end 收尾耗时，其余迟到事件一律不套用，防止消息重新变回 streaming
          if (ev.kind !== 'turn-end') return prev;
          const next = [...prev];
          next[i] = { ...applyAgentEvent(prev[i], ev), streaming: false, interrupted: true };
          return next;
        }
        if (!prev[i].streaming) return prev;
        const next = [...prev];
        next[i] = applyAgentEvent(prev[i], ev);
        return next;
      });
    });
  }, [y]);

  // 更新提示：后台检查发现新版本时，在左下角 Settings 入口点一个小红点（不打断对话）
  useEffect(() => {
    if (!y?.onUpdateEvent) return undefined;
    return y.onUpdateEvent((ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'available') setUpdateVersion(String(ev.version || ''));
      else if (ev.type === 'not-available') setUpdateVersion('');
    });
  }, [y]);

  // 权限审批：主进程推送待确认条目（run_command 等）→ 聊天流渲染确认条；多条排队（并行子代理）
  useEffect(() => {
    if (!y?.onApprovalRequest) return undefined;
    return y.onApprovalRequest((p) => {
      if (!p || !p.callId) return;
      setApproval((cur) => {
        if (!cur) return p;
        approvalsRef.current.push(p);
        return cur;
      });
    });
  }, [y]);

  // AI 命名：首轮结束后主进程生成标题 → 侧栏和顶栏即时更新（不用刷新）
  useEffect(() => {
    if (!y?.onSessionTitle) return undefined;
    return y.onSessionTitle((p) => {
      if (!p?.sessionId || !p?.title) return;
      // 后台会话可能属于任意已展开的项目：所有缓存桶里同名会话一起改名
      let touched = false;
      const next = {};
      for (const [pid, list] of Object.entries(projectSessionsRef.current)) {
        if (!Array.isArray(list) || !list.some((s) => s.id === p.sessionId)) { next[pid] = list; continue; }
        touched = true;
        next[pid] = list.map((s) => (s.id === p.sessionId ? { ...s, title: p.title } : s));
      }
      if (touched) {
        projectSessionsRef.current = next;
        setProjectSessions(next);
      }
      setSessions((prev) => prev.map((s) => (s.id === p.sessionId ? { ...s, title: p.title } : s)));
    });
  }, [y]);

  // 回填审批决定：点击即回传主进程并收起确认条（主进程侧超时 120s 兜底拒绝）
  const decideApproval = async (decision) => {
    if (!approval || !y?.approvalDecide) return;
    const { callId } = approval;
    // 并发子代理可能同时要审批：先弹下一个排队项，再回传决定
    const next = approvalsRef.current.shift() || null;
    setApproval(next);
    try { await y.approvalDecide(callId, decision); } catch { /* 决定回传失败由主进程超时兜底拒绝 */ }
  };

  // ---- 右侧产物预览 ----
  const openArtifact = async (p) => {
    if (!y?.artifactRead || !p) return;
    setArtifactLoading(true);
    setArtifactError('');
    try {
      const r = await y.artifactRead(p);
      if (r && r.kind === 'missing') {
        setArtifact({ path: p, name: r.name || baseName(p) });
        setArtifactError(r.error || t('文件已不存在'));
      } else {
        setArtifact(r);
      }
    } catch (e) {
      setArtifact({ path: p, name: baseName(p) });
      setArtifactError(e.message || t('读取失败'));
    } finally {
      setArtifactLoading(false);
    }
  };
  const closeArtifact = () => { setArtifact(null); setArtifactError(''); setArtifactLoading(false); };

  // ---- / 技能（dsh 式：文字后面空格 + / 就能唤起，命令/技能可嵌在正文里） ----
  const runCompact = async () => {
    if (!y?.compactSession || busy || compacting) return;
    setCompacting(true);
    let sid = activeId;
    try {
      if (!sid) {
        const s = await y.sessions.create(t('新会话'));
        sid = s.id;
        setActiveId(sid);
        await refreshSessions();
        setMessages([]);
      }
      const r = await y.compactSession(sid);
      if (r?.error) setMessages((prev) => [...prev, { role: 'notice', content: r.error }]);
      else await openSession(sid);
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'notice', content: t('压缩失败：{msg}', { msg: e.message }) }]);
    } finally { setCompacting(false); setMenu(null); }
  };
  const chooseSlash = (item) => {
    if (!item) return;
    // 只替换「光标前那个 /token」，保留前面已经写好的文字（dsh 式）
    const m = input.match(/(^|\s)\/([a-z0-9-]*)$/i);
    const head = m ? input.slice(0, m.index) + (m[1] || '') : input;
    if (item.type === 'command' && item.id === 'compact' && !head.trim()) {
      setInput('');
      runCompact();
      return;
    }
    setInput(head + `/${item.name} `);
    setMenu(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Ctrl+T：打开当前会话的模型/思考强度面板（同 ZCode）
  useEffect(() => {
    if (menu !== 'model') {
      setEffortPos(null);     // 面板关掉后滑块回到落库档位
      setProviderMenu(false); // 供应商子菜单只存在于模型面板里
    }
  }, [menu]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 't') {
        e.preventDefault();
        setMenu((m) => (m === 'model' ? null : 'model'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 浮层（模型菜单 / 供应商子菜单 / 会话右键菜单）：点外部关闭；Esc 关闭任何打开的浮层
  useEffect(() => {
    if (!menu && !providerMenu && !rowMenu) return;
    const onDown = (e) => {
      if (menu === 'model' && modelMenuRef.current && !modelMenuRef.current.contains(e.target)) {
        setMenu(null);
        setProviderMenu(false);
      }
      if (rowMenu && rowMenuRef.current && !rowMenuRef.current.contains(e.target)) {
        setRowMenu(null);
        setMoveOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setMenu(null);
      setProviderMenu(false);
      setRowMenu(null);
      setMoveOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, providerMenu, rowMenu]);

  // 手动入队：把当前输入（含粘贴块 / 附件）压进当前会话的队列，不打断正在跑的回合
  const enqueueCurrent = () => {
    const key = activeId || 'draft';
    const typed = input.trim();
    const previews = attachments.map((a) => ({ ...a }));
    setQueueBySession((prev) => ({
      ...prev,
      [key]: enqueue(prev[key], { id: nextQueueId(), text: typed, pasted: pastedBlocks.map((b) => b.text), previews })
    }));
    setInput('');
    setPastedBlocks([]);
    setAttachments([]);
    setEditing(null); // 排队按「新消息」发送（编辑/回退意图不能跨回合保留，避免下一条手动消息误回退）
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  // send(override)：override = 队首消息（自动发送时使用，不改动输入框里的草稿）
  const send = async (override = null) => {
    const sendProjectId = activeProjectIdRef.current; // 本轮新建会话的归属：之后切项目也不串桶
    const queued = !!override;
    const typedRaw = String(queued ? (override.text || '') : input).trim();
    const pastedTexts = queued ? (override.pasted || []) : pastedBlocks.map((b) => b.text);
    const raw = [typedRaw, ...pastedTexts].filter((x) => String(x || '').trim()).join('\n\n').trim();
    if (!raw || !y) { pumpingRef.current = false; return; }
    // 忙时不再丢弃：入队（FIFO），当前回合照常跑，回合结束由 effect 自动发队首
    if (runningIds[activeId] || stoppingIds[activeId]) {
      if (!queued) enqueueCurrent();
      else if (activeId) { // 自动发送碰上并发忙：把队首原样放回去，避免消息丢
        setQueueBySession((prev) => ({ ...prev, [activeId]: [override, ...(prev[activeId] || [])] }));
      }
      pumpingRef.current = false;
      return;
    }
    if (!activeModel) {
      setMessages((prev) => [...prev, { role: 'notice', content: t('供应商「{name}」还没有可用模型：请在模型面板里添加/选择模型后再发送。', { name: activeProv?.name || t('未选择') }) }]);
      pumpingRef.current = false;
      return;
    }
    if (!pastedTexts.length && /^\/compact\b/i.test(typedRaw)) {
      setInput('');
      if (!queued) { setPastedBlocks([]); setAttachments([]); }
      pumpingRef.current = false;
      runCompact();
      return;
    }
    // 编辑历史消息：先把会话回退到被编辑那条之前（失败不阻断本次发送）；排队消息按普通新消息发送
    let baseMessages = messages;
    if (!queued && editing) {
      baseMessages = messages.slice(0, editing.index);
      if (activeId && y.sessions?.rewind) {
        try { await y.sessions.rewind(activeId, editing.keepTurns); } catch { /* 回退失败不阻断 */ }
      }
      setEditing(null);
    }
    // 技能展开只作用于手输文本；粘贴块原样进入上下文（避免误把粘贴内容里的 /token 当技能）
    const typedText = expandSkill(typedRaw, skills);
    const text = [typedText, ...pastedTexts].filter((x) => String(x || '').trim()).join('\n\n');
    const files = queued ? (override.previews || []) : attachments;
    const attachBlock = files.length
      ? '\n\n[附件]\n' + files.map((a) => `- ${a.path}`).join('\n')
      : '';
    const finalText = text + attachBlock;
    if (!queued) {
      setInput('');
      setPastedBlocks([]);
      setAttachments([]);
      if (inputRef.current) inputRef.current.style.height = 'auto';
    }

    let sid = activeId;
    if (!sid) { // 无会话时自动补建，保证每轮落盘
      try {
        const s = await y.sessions.create(t('新会话'));
        sid = s.id;
        setActiveId(sid);
        activeIdRef.current = sid;
        if (sendProjectId) rememberSessionProject(sendProjectId); // 草稿落盘后：会话归属与创建它的项目一致
        const fresh = { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, turns: 0 };
        if (sendProjectId) patchSessionsOf(sendProjectId, (list) => [fresh, ...list]);
        else setSessions((prev) => [fresh, ...prev]);
        setMessages([]);
        refreshProjects();
      } catch { /* 忽略 */ }
    }
    if (!sid) { pumpingRef.current = false; return; }
    // 新会话首次发送：把当前会话的模型配置落盘（主进程按它选模型）
    if (y.sessions?.setModel) { try { await y.sessions.setModel(sid, sessCfg); } catch { /* 落盘失败用全局默认 */ } }

    const baseList = baseMessages
      .filter((m) => !m.error && !m.local && !m.steer && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: m.content }));
    const wireHistory = [...baseList, { role: 'user', content: finalText }]; // 发给主进程：只有 role/content
    const displayUser = { role: 'user', content: finalText, ...(pastedTexts.length ? { pasted: pastedTexts, typed: typedText } : {}) };
    const history = [...baseList, displayUser]; // 本地渲染：多带粘贴块结构，气泡才能分段渲染
    const startedAt = Date.now();
    inflightRef.current.add(sid);
    stoppedRef.current.delete(sid); // 新一轮开始：解除上一轮手动停止的迟到事件屏蔽
    stoppingRef.current.delete(sid);
    setStoppingIds((prev) => { if (!prev[sid]) return prev; const n = { ...prev }; delete n[sid]; return n; });
    runsRef.current.set(sid, { content: '', events: [], startedAt, userMessage: finalText });
    setRunningIds((prev) => ({ ...prev, [sid]: true }));
    const isActive = () => activeIdRef.current === sid;
    if (isActive()) {
      setMessages([...history, { role: 'assistant', content: '', streaming: true, events: [], startedAt }]);
      scrollDown();
    }

    try {
      const r = await y.agentChat(wireHistory, [], sid);
      if (isActive()) {
        setMessages((prev) => {
          const next = [...prev];
          const last = next.length - 1;
          const pm = next[last] || {};
          const fallbackMs = pm.startedAt ? Date.now() - pm.startedAt : undefined;
          const timeline = { // 过程时间线数据随消息固化（完成态折叠展示）；trace 全量 args/result 合并回条目供展开查看
            events: mergeTraceIntoEvents(pm.events || [], r.trace || [], r.workedMs),
            startedAt: pm.startedAt,
            workedMs: r.workedMs ?? pm.workedMs ?? fallbackMs,
            reasoning: r.reasoning || undefined
          };
          if (r.cancelled || r.error === '已取消') next[last] = { role: 'assistant', content: r.partialContent || pm.content || '', interrupted: true, trace: r.trace || [], ...timeline };
          else if (r.error) next[last] = { role: 'assistant', content: '', error: r.error, trace: r.trace || [], ...timeline };
          else next[last] = { role: 'assistant', content: r.answer || prev[last]?.content || t('(空回复)'), trace: r.trace || [], ...timeline };
          return next;
        });
      }
      if (r.persisted) {
        // 会话可能属于别的项目（回合中切走了）：只更新它自己的缓存桶，别动当前项目的列表
        patchSessionsOf(projectIdOfSession(sid) || sendProjectId, (list) => list
          .map((s) => (s.id === sid ? { ...s, title: r.persisted.title || s.title, updatedAt: r.persisted.updatedAt, turns: s.turns + 1 } : s))
          .sort((a, b) => (b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt)));
      }
    } catch (e) {
      if (isActive()) {
        setMessages((prev) => {
          const next = [...prev];
          const pm = next[next.length - 1] || {};
          next[next.length - 1] = {
            role: 'assistant', content: '', error: t('Agent 调用失败：{msg}', { msg: e.message }), trace: [],
            events: pm.events || [], startedAt: pm.startedAt,
            workedMs: pm.workedMs ?? (pm.startedAt ? Date.now() - pm.startedAt : undefined)
          };
          return next;
        });
      }
    } finally {
      inflightRef.current.delete(sid);
      runsRef.current.delete(sid);
      setRunningIds((prev) => { const n = { ...prev }; delete n[sid]; return n; });
      stoppingRef.current.delete(sid);
      stoppedRef.current.delete(sid);
      setStoppingIds((prev) => { if (!prev[sid]) return prev; const n = { ...prev }; delete n[sid]; return n; });
      pumpingRef.current = false; // 允许自动发送 effect 消费下一条排队消息
      if (isActive()) { setApproval(null); approvalsRef.current = []; } // 本轮结束清掉残留确认条（超时未决的主进程侧已按拒绝兜底）
      // 后台会话跑完 → 绿点（表示「已完成」）；当前正在看的会话不留点
      if (!isActive()) {
        try { await y?.sessions?.flags?.(sid, { unread: true }); } catch { /* 忽略 */ }
        const pid = projectIdOfSession(sid) || sendProjectId;
        if (pid) refreshProjectSessions(pid); else refreshSessions();
      }
    }
  };
  const sendRef = useRef(null);
  sendRef.current = send;

  // 队列自动发送：当前会话空闲（且不在停止中）时消费队首一条；切到别的会话不消费它的队列
  useEffect(() => {
    const sid = activeId;
    if (!sid || busy || stopping || pumpingRef.current) return;
    if (inflightRef.current.has(sid)) return; // 上一轮 send 还没收尾（例如刚点停止），不抢跑
    const q = queueBySession[sid] || [];
    if (!q.length) return;
    const head = q[0];
    pumpingRef.current = true;
    setQueueBySession((prev) => {
      const cur = prev[sid] || [];
      if (cur[0]?.id !== head.id) return prev; // 已被手动移除/取回：放弃这次消费
      return { ...prev, [sid]: cur.slice(1) };
    });
    // 下一拍再发，让本次状态的 setRunningIds 先落定
    Promise.resolve().then(() => sendRef.current?.(head));
  }, [activeId, busy, stopping, queueBySession]);

  // ---- 队列卡片操作：Steer（注入当前回合）/ 取回编辑 / 移除 ----
  const removeQueueItem = (id) => {
    if (!activeId) return;
    setQueueBySession((prev) => ({ ...prev, [activeId]: removeById(prev[activeId], id) }));
  };
  const moveQueueItemToInput = (id) => {
    const sid = activeId;
    if (!sid) return;
    const { item } = moveToInput(queueBySession[sid] || [], id);
    if (!item) return;
    setQueueBySession((prev) => ({ ...prev, [sid]: removeById(prev[sid], id) }));
    if (item.text) setInput((prev) => (prev.trim() ? prev.replace(/\s+$/, '') + '\n' + item.text : item.text));
    if (item.pasted?.length) {
      setPastedBlocks((prev) => [...prev, ...item.pasted.map((t) => ({ id: nextPasteId(), text: t, lines: countLines(t), expanded: false }))]);
    }
    if (item.previews?.length) {
      setAttachments((prev) => {
        const have = new Set(prev.map((a) => a.path));
        return [...prev, ...item.previews.filter((a) => !have.has(a.path))];
      });
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const steerQueueItem = async (item) => {
    const sid = activeId;
    const note = (content) => setMessages((prev) => [...prev, { role: 'notice', content }]);
    if (!sid || !item) return;
    if (!runningIds[sid] || stoppingIds[sid]) { note(t('当前没有运行中的回合，无法 Steer')); return; }
    if (!y?.agentSteer) { note(t('当前版本不支持 Steer')); return; }
    const text = [
      String(item.text || '').trim(),
      ...(item.pasted || []),
      ...(item.previews?.length ? ['[附件]\n' + item.previews.map((a) => `- ${a.path}`).join('\n')] : [])
    ].filter((x) => String(x || '').trim()).join('\n\n');
    try {
      const r = await y.agentSteer(sid, text);
      if (r?.error) { note(r.error); return; } // 失败保留在队列，用户可重试或等回合结束
      setQueueBySession((prev) => ({ ...prev, [sid]: removeById(prev[sid], item.id) }));
    } catch (e) {
      note(t('Steer 失败：{msg}', { msg: e?.message || e }));
    }
  };

  // 停止本回合：中断主进程里的流（用户实测：长回合无法中止=像卡死）
  // 点击即生效：先同步把 UI 切到「已中断/停止中」，再通知主进程杀工具进程树；
  // 迟到的 token / turn-end 用 stoppedRef 屏蔽，只能补内容，不能把消息变回 streaming。
  const stop = async () => {
    const sid = activeIdRef.current ?? activeId;
    if (!sid || stoppingRef.current.has(sid)) return; // 重复点击直接忽略
    stoppingRef.current.add(sid);
    stoppedRef.current.add(sid);
    setStoppingIds((prev) => ({ ...prev, [sid]: true }));
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'assistant' && last.streaming) next[next.length - 1] = { ...last, streaming: false, interrupted: true };
      return next;
    });
    setRunningIds((prev) => { const n = { ...prev }; delete n[sid]; return n; });
    try { await y?.cancelChat(sid); } catch { /* 忽略 */ }
  };

  // 编辑历史用户消息：回填输入框；发送时先把会话回退到该条之前
  const startEdit = (index, text, keepTurns, files = []) => {
    setEditing({ index, keepTurns, prevAttachments: attachments, prevPasted: pastedBlocks });
    setInput(text);
    // 被编辑的消息里如果有图片/附件，一起带回输入框（可删可加，和正常发送一致）
    setAttachments((files || []).map((p) => ({ path: p, name: baseName(p), preview: null })));
    setMenu(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const cancelEdit = () => {
    setAttachments(editing?.prevAttachments || []);
    setPastedBlocks(editing?.prevPasted || []);
    setEditing(null);
    setInput('');
  };
  // 消息区的「编辑并从这条重开」：粘贴块也要一起回填（先回填正文与附件，再放粘贴块）
  const editMessage = (index, text, keepTurns, files, pasted) => {
    if (pasted) {
      startEdit(index, text, keepTurns, files);
      setPastedBlocks(pasted.map((x) => ({ id: nextPasteId(), text: x, lines: countLines(x), expanded: false })));
    } else {
      startEdit(index, text, keepTurns, files);
    }
  };
  const openStep = (s) => setStepView({ sessionId: activeId, stepId: s.id, name: s.name, role: s.role, kind: s.kind || null, opType: s.opType || s.op || null, key: Date.now() });

  const hasMsgs = messages.length > 0;
  const providers = (cfg?.providers || []).filter((p) => p.enabled !== false);
  const activeProv = (cfg?.providers || []).find((p) => p.id === sessCfg.providerId) || providers[0] || null;
  const activeModel = (sessCfg.model && modelIdsOf(activeProv).includes(sessCfg.model)) ? sessCfg.model : (modelIdsOf(activeProv)[0] || '');

  return (
    <div className="app-root h-full flex flex-col bg-base text-ink">
      {/* 液态玻璃的底：两团极暗的金色/青色光晕（玻璃要有东西可以折射） */}
      <div className="app-ambient" aria-hidden="true" />
      <TitleBar y={y} />
      <div className="relative z-[1] flex-1 min-h-0 flex text-ink">
      {/* ---- 左栏（液态玻璃）：设置/用量页改全屏布局，不露会话侧栏 ---- */}
      {page === 'chat' && <Sidebar
        y={y} booted={booted} page={page} projects={projects} activeProjectId={activeProjectId}
        activeId={activeId} sessions={sessions} projectSessions={projectSessions}
        showAllSessions={showAllSessions} showArchived={showArchived}
        runningIds={runningIds} updateVersion={updateVersion} isProjectExpanded={isProjectExpanded}
        setShowAllSessions={setShowAllSessions} setShowArchived={setShowArchived}
        onNewSession={newSession} onAddProject={addProject} onToggleProject={toggleProject}
        onOpenSession={openProjectSession} onNewSessionInProject={newSessionInProject}
        onRemoveProject={removeProject} onArchiveSession={archiveSession}
        onOpenRowMenu={(x, y2, s, p) => { setMoveOpen(false); setRowMenu({ x, y: y2, session: s, project: p }); }}
        onSettings={() => setPage('settings')}
      />}

      {/* ---- 主区 + 右侧产物预览 ---- */}
      <div className="flex-1 min-w-0 flex min-h-0">
      <main className="chat-veil flex-1 min-w-0 flex flex-col">
        {!y && (
          <div className="m-4 mb-0 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-300 text-sm px-4 py-3 transition-all duration-200">
            {t('请在 Electron 中运行：当前未检测到 window.finalcheck（浏览器直开），仅展示 UI 壳，功能不可用。')}
          </div>
        )}

        {page === 'chat' ? (
          <>
            <ChatHeader
              sessions={sessions} activeId={activeId} activeProjectId={activeProjectId} projects={projects}
              busy={busy} showSetup={showSetup} y={y} cfg={cfg}
              onArchiveSession={archiveSession} onSaved={finishSetup} onSkip={skipSetup}
            />

            {hasMsgs ? (
              <MessageList
                messages={messages} activeId={activeId} providers={providers} artifactPath={artifact?.path}
                openWorkflowRaw={openWorkflowRaw} setOpenWorkflowRaw={setOpenWorkflowRaw}
                scrollRef={scrollRef} stickRef={stickRef} jumpingRef={jumpingRef}
                showJump={showJump} setShowJump={setShowJump} y={y}
                onSendRecover={(text) => send({ text, pasted: [] })}
                onOpenArtifact={openArtifact} onEditMessage={editMessage} onOpenStep={openStep}
              />
            ) : (
              <EmptyState y={y} demoBusy={demoBusy} setDemoBusy={setDemoBusy}
                setMessages={setMessages} setInput={setInput} inputRef={inputRef} />
            )}

            {/* 输入区（与消息区同宽） */}
            <Composer
              y={y} input={input} setInput={setInput} attachments={attachments} setAttachments={setAttachments}
              pastedBlocks={pastedBlocks} setPastedBlocks={setPastedBlocks}
              editing={editing} dragging={dragging} busy={busy} stopping={stopping} compacting={compacting}
              approval={approval} queueItems={queueItems} menu={menu} providerMenu={providerMenu}
              permMode={permMode} ctxStats={ctxStats} skills={skills} cfg={cfg} sessCfg={sessCfg}
              effortPos={effortPos} activeId={activeId} slashIndex={slashIndex} setSlashIndex={setSlashIndex}
              inputRef={inputRef} modelMenuRef={modelMenuRef}
              setDragging={setDragging} setMenu={setMenu} setProviderMenu={setProviderMenu} setEffortPos={setEffortPos}
              setSessCfg={setSessCfg} setCfg={setCfg} setPermMode={setPermMode}
              cancelEdit={cancelEdit} chooseSlash={chooseSlash} decideApproval={decideApproval}
              steerQueueItem={steerQueueItem} moveQueueItemToInput={moveQueueItemToInput}
              removeQueueItem={removeQueueItem} send={send} stop={stop}
              onGoSettings={() => setPage('settings')}
            />
          </>
        ) : (
          <SettingsPage onBack={() => setPage('chat')} initialSection={page === 'usage' ? 'usage' : 'models'} />
        )}
      </main>
      {stepView ? (
        <SubagentPanel target={stepView} onClose={() => setStepView(null)} />
      ) : (artifact || artifactLoading || artifactError) && (
        <ArtifactPanel
          artifact={artifact}
          loading={artifactLoading}
          error={artifactError}
          onClose={closeArtifact}
          onReload={openArtifact}
          onOpen={(p) => y?.artifactOpen?.(p)}
        />
      )}
      </div>
      </div>
      {/* 会话右键菜单 / 重命名 / 确认框（顺序与拆分前一致） */}
      <Dialogs
        y={y} rowMenu={rowMenu} moveOpen={moveOpen} renameBox={renameBox} confirmBox={confirmBox}
        projects={projects} activeModel={activeModel} ctxStats={ctxStats} rowMenuRef={rowMenuRef}
        onCloseRowMenu={() => setRowMenu(null)}
        onDismissRowMenu={() => { setRowMenu(null); setMoveOpen(false); }}
        onToggleMove={() => setMoveOpen((v) => !v)}
        onMoveSession={moveSession} onPatchFlags={patchFlags}
        onStartRename={(session, projectId) => { setRenameBox({ session, value: session.title, projectId }); setRowMenu(null); }}
        onRemoveSession={removeSession} onCopyText={copyText}
        onOpenArtifact={openArtifact} onGoSettings={() => setPage('settings')}
        onNotice={(content) => setMessages((prev) => [...prev, { role: 'notice', content }])}
        onRenameChange={(value) => setRenameBox({ ...renameBox, value })}
        onSaveRename={saveRename} onCloseRename={() => setRenameBox(null)}
      />
    </div>
  );
}
