// DeepSeek 式对话主界面：左栏品牌 + 会话列表，中央聊天流（工具调用渲染富卡片）
// 仅两个视图：「对话」（默认）与「模型设置」（左下角齿轮进入）
// 拆分后 App 只保留状态 / effects / handler 与编排；展示与弹层在 components/ 下按职责分开。
import React, { useEffect, useRef, useState } from 'react';
import SettingsPage from './pages/SettingsPage.jsx';
import { api } from './lib/ui.jsx';
import { mergeRunningRun, shouldReloadSessionFromDisk } from './lib/session-restore.mjs';
import { filterAskCardsByTrace, hideAskTracesForCards } from './lib/ask-cards.mjs';
import { applyAgentEvent, mergeTraceIntoEvents } from './chat/ProcessTimeline.jsx';
import { ArtifactPanel } from './chat/ArtifactPanel.jsx';
import { SubagentPanel } from './chat/SubagentPanel.jsx';
import { shouldShowArtifactPanel, shouldShowStepPanel } from './lib/panel-visibility.mjs';
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
import CompactionStatus from './components/CompactionStatus.jsx';
import Dialogs from './components/Dialogs.jsx';
import { IDLE as COMPACTION_IDLE, reduce as reduceCompaction } from './lib/compaction.mjs';
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

// ---- Steer（照 ZCode：消息立刻上屏 + 中断当前回合 + 用这条消息重开一回合）的纯函数 ----
// 同样用 BEGIN/END 标记隔离，供 tests/queue-steer.test.mjs 提取单测：无副作用、无 React、无 JSX。
/* STEER-HELPERS-BEGIN */
// 排队项 → 真正发出去的正文（与 sendOnce 的组装顺序一致：正文 → 粘贴块 → 附件清单）
const steerMessageText = (item) => {
  const typed = String((item && item.text) || '').trim();
  const pasted = ((item && item.pasted) || []).filter((x) => String(x || '').trim());
  const previews = (item && item.previews) || [];
  const attach = previews.length ? '[附件]\n' + previews.map((a) => `- ${a.path}`).join('\n') : '';
  return [typed, ...pasted, attach].filter((x) => String(x || '').trim()).join('\n\n');
};
// 乐观上屏：插在「正在流式的助手气泡」之前（保持「最后一条是 assistant」的归约约定），
// local:true 表示只是本地占位——sendOnce 组织 wire history 时会过滤掉它，
// 真实消息随后由 sendOnce 自己入列，避免同一条消息出现两条。
const insertUserBubble = (messages, text) => {
  const list = Array.isArray(messages) ? messages : [];
  const bubble = { role: 'user', content: String(text || ''), local: true };
  const i = list.length - 1;
  if (i >= 0 && list[i] && list[i].role === 'assistant' && list[i].streaming) {
    return [...list.slice(0, i), bubble, list[i]];
  }
  return [...list, bubble];
};
// Steer 的一次原子状态迁移：取排队项 → 出队 + 上屏。item=null 表示这条已经不在了（幂等）。
const planSteer = (queue, messages, id) => {
  const list = Array.isArray(queue) ? queue : [];
  const item = list.find((x) => x && x.id === id) || null;
  if (!item) return { item: null, queue: list, messages: Array.isArray(messages) ? messages : [], text: '' };
  const text = steerMessageText(item);
  return { item, queue: list.filter((x) => x && x.id !== id), messages: insertUserBubble(messages, text), text };
};
/* STEER-HELPERS-END */

// ---- 队列泵闸门 / 停止看门狗（纯函数，供 tests/queue-steer.test.mjs 提取单测） ----
// 事故：用户点了停止（或回合以报错收尾）后，队列泵只看「不忙」就自动发下一条，
// 于是「停止」之后又自己跑起来一轮；另外 stoppingIds 若因窄竞态没被 turn-end 清掉，
// 会话会永久停在「停止中…」，之后每次发送只入队、永不发出。
/* PUMP-HELPERS-BEGIN */
// 回合收尾类型：'ok' 正常结束 / 'stopped' 用户停止 / 'error' 失败收尾
const turnOutcomeOf = (r) => {
  if (!r || typeof r !== 'object') return 'ok';
  if (r.cancelled || r.error === '已取消') return 'stopped';
  if (r.error) return 'error';
  return 'ok';
};
// 是否允许自动发队首（用户没在看时也不抢跑）：stopped / error 收尾必须由用户手动点发送
const holdsQueue = (outcome) => outcome === 'stopped' || outcome === 'error';
const canAutoPump = ({ sid, busy, stopping, pumping, inflight, steering, outcome, headHeld } = {}) => {
  if (!sid || busy || stopping || pumping || inflight || steering) return false;
  if (headHeld) return false; // 重启后恢复的「待发送」：必须用户点发送，不能自己跑
  return !holdsQueue(outcome);
};
// 「停止中…」看门狗：超过 timeoutMs 还没等到 turn-end 的会话 id
const STOPPING_WATCHDOG_MS = 15000;
const expiredStopping = (stoppingAt, now, timeoutMs = STOPPING_WATCHDOG_MS) => {
  const map = stoppingAt && typeof stoppingAt === 'object' ? stoppingAt : {};
  const at = Number(now) || 0;
  return Object.keys(map).filter((id) => at - Number(map[id] || 0) >= timeoutMs);
};
/* PUMP-HELPERS-END */

// 主进程 error-guard 的失败返回体（{ error, code:'IPC_FAILED' }）→ 抛成异常：
// 调用点已有的 catch 就能给出可见提示，而不是把错误对象当数据继续渲染（= 界面空白/卡住）。
// 其他业务对象里的 .error（如 /compact 的 { error }）保持原样，由各调用点自己判断。
const unwrapIpc = (r) => {
  if (r && typeof r === 'object' && !Array.isArray(r) && r.code === 'IPC_FAILED' && typeof r.error === 'string') {
    throw new Error(r.error);
  }
  return r;
};

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
  const [steeringIds, setSteeringIds] = useState({}); // 会话 id → 正在 Steer（中断旧回合 → 起新回合），按钮禁用
  const [sessCfg, setSessCfg] = useState({ providerId: '', model: '', effort: '' }); // 当前会话自己的模型配置
  const [effortPos, setEffortPos] = useState(null); // 拖动中的连续位置（0-4，可为小数；松手后按最近档位落库）
  const activeIdRef = useRef(null);   // 供异步回调判断「现在看的是哪个会话」
  const activeProjectIdRef = useRef(null); // 同上：异步回调里判断「当前项目」
  const activeSessionProjectIdRef = useRef(null); // 同上：当前会话/草稿的项目归属
  const runsRef = useRef(new Map());  // sid → { content, events, startedAt }（后台会话的实时流）
  const stoppedRef = useRef(new Set()); // 手动停止过的会话：屏蔽迟到的流式事件把消息变回 streaming
  const stoppingRef = useRef(new Set()); // 已发出停止请求的会话：阻止重复点击
  const steerRef = useRef(new Set()); // 正在 Steer 的会话：连点不能并发起两个新回合
  const approvalsRef = useRef([]);    // 排队中的审批（并行子代理可能同时要命令审批）
  const pumpingRef = useRef(false);   // 正在消费队首 → 防止 effect 在 runningIds 落定前重复派发
  const turnOutcomeRef = useRef(new Map()); // sid → 上一轮收尾类型（ok/stopped/error）：stopped/error 不自动发队列
  const inflightRef = useRef(new Set()); // 仍在 send 里的会话：回合收尾前不自动发下一条（防旧 finally 清掉新一轮状态）
  const jumpingRef = useRef(false);   // 平滑回到底部动画中：滚动事件不要重新弹出箭头
  const [queueBySession, setQueueBySession] = useState({}); // 会话 id → 待发消息 FIFO：[{id,text,pasted,previews}]（必须先于 queueItems 声明）
  const busy = !!runningIds[activeId];
  const stopping = !!stoppingIds[activeId];
  const queueItems = queueBySession[activeId || 'draft'] || []; // 当前会话的排队消息（切会话各自独立）
  // 上下文压缩的进行中状态（idle/running/done/failed）：只表示「当前会话」的压缩，
  // 由主进程 compact-start/compact-end 事件驱动，手动 /compact 另有本地兜底（reducer 幂等）。
  const [compaction, setCompaction] = useState(COMPACTION_IDLE);
  const compactionRef = useRef(COMPACTION_IDLE); // 异步回调（stop / runCompact）里读最新值
  const [approval, setApproval] = useState(null); // 待审批：{callId, tool, summary}（主进程 fail-closed 推送）
  const [askCards, setAskCards] = useState([]); // 回合中途提问卡（实时）：[{callId,sessionId,question,options,multiSelect,status,...}]
  const askCardsRef = useRef([]); // 与 askCards 同步：回合收尾/停止回调里读最新值
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
  const [stepView, setStepView] = useState(null); // 右侧子代理上下文面板：{sessionId, stepId, name, role}
  // 子代理面板只属于它绑定的那次对话：进设置/用量或切工作区（换会话）就置空，
  // 返回聊天时不会又自动弹回来（渲染侧另有 shouldShowStepPanel 兜底）。
  useEffect(() => {
    setStepView((cur) => (cur && !shouldShowStepPanel({ view: page, stepView: cur, activeSessionId: activeId }) ? null : cur));
  }, [page, activeId]);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState('');
  const [skills, setSkills] = useState([]); // 40 类方法论（slash 菜单）
  const [slashIndex, setSlashIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [openWorkflowRaw, setOpenWorkflowRaw] = useState(null); // 哪条 workflow 消息展开了原始指令
  // 切换会话时清掉「编辑中」状态（避免把上一条会话的内容发到新会话）
  useEffect(() => { setEditing(null); }, [activeId]);
  // 压缩状态只属于某个会话：切走就清空（事件层已按会话过滤，这里防「切回来还挂着上一条的动画」）
  useEffect(() => { compactionRef.current = COMPACTION_IDLE; setCompaction(COMPACTION_IDLE); }, [activeId]);
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
  useEffect(autoScroll, [messages, askCards]);

  const cacheProjectSessions = (projectId, list) => {
    if (!projectId) return;
    projectSessionsRef.current = { ...projectSessionsRef.current, [projectId]: Array.isArray(list) ? list : [] };
    setProjectSessions(projectSessionsRef.current);
  };

  // 当前项目列表的读写都走这里：同一份数据写进 sessions 与对应项目缓存
  const refreshSessions = async (projectId = activeProjectIdRef.current) => {
    if (!y) return [];
    try {
      const list = unwrapIpc(await y.sessions.list());
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
      const list = y.projects?.sessions ? unwrapIpc(await y.projects.sessions(projectId)) : [];
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
      const list = unwrapIpc(await y.projects.sessions(projectId));
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
    try { const list = unwrapIpc(await y.projects.list()); setProjects(list); return list; } catch { return []; }
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
    // 失败必须可见：以前这里没有 catch，主进程一拒就是一整条未处理的 Promise + 界面毫无反应
    try {
      unwrapIpc(await y.projects.select(p.id));
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'notice', content: t('切换项目失败：{msg}', { msg: e?.message || e }) }]);
      return;
    }
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
      const p = unwrapIpc(await y.projects.add(dir));
      await refreshProjects();
      await switchProject(p);
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'notice', content: t('添加项目失败：{msg}', { msg: e?.message || e }) }]);
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
      unwrapIpc(await y.sessions.move(s.id, targetProjectId));
      await refreshProjectSessions(sourceProjectId || projectIdOfSession(s.id) || activeProjectIdRef.current);
      await refreshProjectSessions(targetProjectId); // 目标项目缓存同步（未展开也保持最新）
      await refreshProjects();
      if (activeIdRef.current === s.id) rememberSessionProject(targetProjectId); // 当前会话被移动：归属跟着走
    } catch (e) { setMessages((prev) => [...prev, { role: 'notice', content: t('移动失败：{msg}', { msg: e?.message || e }) }]); }
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
    // 这条会话已经激活且本进程还在跑这一回合：不再从磁盘重建（否则磁盘 pending 副本
    // 会和内存实时副本叠成两份，pending assistant 还会被误标「已停止」）。
    if (!shouldReloadSessionFromDisk({
      activeId: activeIdRef.current,
      sessionId: id,
      liveRun: runsRef.current.has(id),
      inflight: inflightRef.current.has(id)
    })) return;
    try {
      const s = unwrapIpc(await y.sessions.open(id));
      // 归属：调用方传入的项目 → 会话缓存里的目录登记 → 当前项目（老会话/未登记时兜底）
      rememberSessionProject(projectId || projectIdOfSession(s.id) || activeProjectIdRef.current);
      setActiveId(s.id);
      activeIdRef.current = s.id;
      applySessionCfg(s);
      stickRef.current = true; // 切会话回到最新位置
      // 该会话还有实时提问卡时：从磁盘历史里去掉仍在 running 的 ask_user 卡片，
      // 避免「实时卡 + 历史里同一张未完成卡」重复显示。
      const hasLiveAsk = askCardsRef.current.some((c) => c.sessionId === s.id);
      const loaded = (s.messages || []).map((m) => {
        // 旧版本把「用户点停止」写成了 error='已取消' → 读档时按「已中断」还原，不再显示红色报错
        const legacyCancel = m.error === '已取消' || m.error === '已中断';
        const trace = Array.isArray(m.trace) && hasLiveAsk
          ? m.trace.filter((x) => !(x?.tool === 'ask_user' && (x.status === 'running' || x.status == null)))
          : (m.trace || []);
        return { role: m.role, content: m.content ?? '', error: legacyCancel ? null : (m.error ?? null), interrupted: !!m.interrupted || legacyCancel, reasoning: m.reasoning || '', trace, workedMs: m.workedMs ?? null, ...(m.kind ? { kind: m.kind } : {}) };
      });
      // 后台还在跑的会话：把实时流叠加到磁盘历史后面（切回来能继续看到输出 + 工作流卡片）
      const run = runsRef.current.get(id);
      const merged = mergeRunningRun(loaded, run, { stopped: stoppedRef.current.has(id) });
      setMessages(merged.messages);
      setStepView(null); // 面板属于某个会话的某一步：切会话就收起，别留着上一条的上下文
      setPage('chat');
      // 排队消息存档：重启后恢复成「待发送」（hold=true），并明确告知；绝不自动发送/静默丢。
      // 本进程里已经有更新的队列时不覆盖（用户刚入队的那几条更可信）。
      try {
        const hadLocal = (queueBySession[s.id] || []).length > 0;
        if (!hadLocal && y.sessions?.queueGet) {
          const stored = await y.sessions.queueGet(s.id);
          const restored = Array.isArray(stored) ? stored : [];
          if (restored.length) {
            setQueueBySession((prev) => {
              if ((prev[s.id] || []).length) return prev;
              return { ...prev, [s.id]: restored.map((it) => ({ ...it, hold: true })) };
            });
            setMessages((prev) => [...prev, { role: 'notice', content: t('已恢复 {n} 条排队消息为「待发送」：点「发送」才会发出', { n: restored.length }) }]);
          }
        }
      } catch { /* 读档失败不阻断打开会话 */ }
      refreshSessions(projectId || activeProjectIdRef.current); // markRead 已在主进程清掉 unread → 绿点消失
    } catch (e) {
      // 会话打不开（文件损坏/被外部删掉）：明确说一句，别让用户以为「点了没反应」
      setMessages((prev) => [...prev, { role: 'notice', content: t('打开会话失败：{msg}', { msg: e?.message || e }) }]);
      refreshSessions(projectId || activeProjectIdRef.current);
    }
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

  // 全局提示气泡：主进程进程级异常（sessionId=null 的 notice）与回合 warning 都要看得见。
  // 插在流式助手气泡之前，保持「最后一条是 assistant」的约定（token 归约依赖它）。
  const pushNotice = (content) => {
    const text = String(content || '').trim();
    if (!text) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && last.streaming) return [...prev.slice(0, -1), { role: 'notice', content: text }, last];
      return [...prev, { role: 'notice', content: text }];
    });
  };

  // 流式 token：按 sessionId 路由（多会话可同时跑；看不到的会话先攒在 runsRef 里）
  useEffect(() => {
    if (!y?.onAgentToken) return undefined;
    return y.onAgentToken((p) => {
      try {
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
      } catch { /* 单个 token 异常不能让后续 token 全部丢失（否则界面停在半句） */ }
    });
  }, [y]);

  // 过程时间线：主进程 agent 事件流（含 sessionId）→ 归约到对应会话的流式消息
  useEffect(() => {
    if (!y?.onAgentEvent) return undefined;
    return y.onAgentEvent((p) => {
      const sid = p && typeof p === 'object' ? p.sessionId : null;
      const ev = p && typeof p === 'object' ? p.ev : p;
      if (!ev) return;
      // 上下文压缩：只更新「当前会话」的活动行状态，不并进过程时间线（它不是一个工具步骤）
      if (ev.kind === 'compact-start' || ev.kind === 'compact-end') {
        if (!sid || activeIdRef.current !== sid) return; // 后台会话的压缩不打扰当前对话
        const next = reduceCompaction(compactionRef.current, ev);
        compactionRef.current = next;
        setCompaction(next);
        return;
      }
      // 主进程 notice（进程级异常兜底，sessionId 可能为 null）与回合 warning：
      // 以前这些事件被 reducer 的 default 分支丢掉，用户完全看不到「主进程出事了」。
      if (ev.kind === 'notice' || ev.kind === 'warning') {
        const message = String(ev.message || (ev.kind === 'warning' ? ev.text : '') || '').trim();
        if (message) pushNotice(sid && activeIdRef.current !== sid ? t('（后台会话）{msg}', { msg: message }) : message);
        if (!sid) return;
      }
      if (!sid) return;
      try {
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
          // 兜底：回合已收尾但压缩的 end 事件丢了（极端情况）→ 不能留一个永远转的圈
          if (activeIdRef.current === sid && compactionRef.current.phase === 'running') {
            const next = reduceCompaction(compactionRef.current, { kind: 'compact-end', scope: compactionRef.current.scope, cancelled: true });
            compactionRef.current = next;
            setCompaction(next);
          }
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
      } catch {
        // 单个畸形事件不能让整条事件流失效（否则后面的 turn-end 收不到 → 界面一直「运行中」）
        pushNotice(t('有一个过程事件渲染失败（已跳过，不影响本轮结果）'));
      }
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

  // 回合中途提问：主进程推一张卡（不是 modal），本回合暂停等回答；卡状态按 callId 存。
  useEffect(() => {
    if (!y?.onAskUser) return undefined;
    return y.onAskUser((p) => {
      if (!p || !p.callId) return;
      if (askCardsRef.current.some((c) => c.callId === p.callId)) return;
      const card = {
        callId: String(p.callId),
        sessionId: p.sessionId == null ? null : String(p.sessionId),
        question: String(p.question || ''),
        options: Array.isArray(p.options) ? p.options : [],
        multiSelect: p.multiSelect === true,
        askedAt: p.askedAt || Date.now(),
        status: 'pending',
        selected: [],
        text: ''
      };
      askCardsRef.current = [...askCardsRef.current, card];
      setAskCards(askCardsRef.current);
      if (activeIdRef.current === card.sessionId) scrollDown();
    });
  }, [y]);

  // 更新一张实时卡（按 callId）：answered / cancelled / expired
  const patchAskCard = (callId, patch) => {
    askCardsRef.current = askCardsRef.current.map((c) => (c.callId === callId ? { ...c, ...patch } : c));
    setAskCards(askCardsRef.current);
  };

  // 回填回答：主进程 resolve pending → 本回合继续；答完卡片变「已提交：X」
  const answerAskUser = async (callId, { selected = [], text = '' } = {}) => {
    const card = askCardsRef.current.find((c) => c.callId === callId);
    if (!card || card.status !== 'pending') return;
    try {
      const r = await y?.askUserAnswer?.({ callId, selected, text });
      if (r?.ok) patchAskCard(callId, { status: 'answered', answer: r.answer || '', selected, text });
      else patchAskCard(callId, { status: 'expired', answer: '', error: r?.error || t('该提问已失效') });
    } catch {
      // IPC 失败：保持 pending，用户可重试
    }
  };

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
  // 只由 send() 在「整条消息就是 /compact」时调用：没有活动会话不新建，直接提示用户先打开会话
  const runCompact = async (sid = activeId) => {
    if (!y?.compactSession || !sid || busy || compacting) return;
    // 语义上完全等同一次任务在跑：占住 runningIds → 输入区可停止、消息进队列（沿用现有规则），
    // 同时点亮活动行。主进程也会推 compact-start/end；本地这一份是兜底，reducer 对重复事件幂等。
    const mark = (ev) => {
      const next = reduceCompaction(compactionRef.current, { at: Date.now(), ...ev });
      compactionRef.current = next;
      setCompaction(next);
    };
    setCompacting(true);
    mark({ kind: 'compact-start', scope: 'manual' });
    setRunningIds((prev) => ({ ...prev, [sid]: true }));
    try {
      const r = await y.compactSession(sid);
      // 失败原因交给活动行显示（「压缩失败：…」），不再往消息流里塞一条重复提示
      if (r?.cancelled) mark({ kind: 'compact-end', scope: 'manual', cancelled: true });
      else if (r?.error) mark({ kind: 'compact-end', scope: 'manual', error: r.reason || r.error });
      else await openSession(sid);
    } catch (e) {
      mark({ kind: 'compact-end', scope: 'manual', error: e?.message || String(e) });
    } finally {
      setCompacting(false);
      setMenu(null);
      setRunningIds((prev) => { if (!prev[sid]) return prev; const n = { ...prev }; delete n[sid]; return n; });
    }
  };
  const chooseSlash = (item) => {
    if (!item) return;
    // 只替换「光标前那个 /token」，保留前面已经写好的文字（dsh 式）
    const m = input.match(/(^|\s)\/([a-z0-9-]*)$/i);
    const head = m ? input.slice(0, m.index) + (m[1] || '') : input;
    // 命令一律只插入文本、不立即执行（/compact 与 /workflow 一致）：用户点发送才真正压缩
    const next = head + `/${item.name} `;
    setInput(next);
    setMenu(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      try { el?.setSelectionRange(next.length, next.length); } catch { /* 非 textarea 时忽略 */ }
    });
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
  // 发送入口：内部对「可预期失败」各自 catch（建会话/落盘/agent-chat）；
  // 这里只兜住意外异常，保证不会出现「点了发送、界面既没消息也没提示」。
  const send = async (override = null) => {
    try {
      await sendOnce(override);
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'notice', content: t('发送失败：{msg}（消息未发出，可直接重试）', { msg: e?.message || e }) }]);
    } finally {
      pumpingRef.current = false; // 任何分支都要释放队列泵，否则排队消息永远不发出
    }
  };
  const sendOnce = async (override = null) => {
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
    // 整条消息恰好是 /compact 才触发压缩；`/compact 保留结论` 这类带后续文字的按普通消息交给模型
    if (!pastedTexts.length && /^\/compact$/i.test(typedRaw)) {
      if (!queued) {
        setInput('');
        setPastedBlocks([]);
        setAttachments([]);
        if (inputRef.current) inputRef.current.style.height = 'auto';
      }
      pumpingRef.current = false;
      if (!activeId) {
        setMessages((prev) => [...prev, { role: 'notice', content: t('请先打开一个会话') }]);
        return;
      }
      if (compacting) {
        setMessages((prev) => [...prev, { role: 'notice', content: t('正在压缩当前上下文，请稍候…') }]);
        return;
      }
      runCompact();
      return;
    }
    if (!activeModel) {
      setMessages((prev) => [...prev, { role: 'notice', content: t('供应商「{name}」还没有可用模型：请在模型面板里添加/选择模型后再发送。', { name: activeProv?.name || t('未选择') }) }]);
      pumpingRef.current = false;
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
        const s = unwrapIpc(await y.sessions.create(t('新会话')));
        sid = s.id;
        setActiveId(sid);
        activeIdRef.current = sid;
        if (sendProjectId) rememberSessionProject(sendProjectId); // 草稿落盘后：会话归属与创建它的项目一致
        const fresh = { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, turns: 0 };
        if (sendProjectId) patchSessionsOf(sendProjectId, (list) => [fresh, ...list]);
        else setSessions((prev) => [fresh, ...prev]);
        setMessages([]);
        refreshProjects();
      } catch (e) {
        // 输入框在上面已经清空了：这里必须把文字放回去 + 明确提示，否则用户会以为「点了没反应、字也没了」
        if (!queued) setInput(typedRaw);
        setMessages((prev) => [...prev, { role: 'notice', content: t('新建会话失败，消息未发送：{msg}', { msg: e?.message || e }) }]);
      }
    }
    if (!sid) return;
    // 手动发送 / 新会话首次发送：把当前会话的模型配置落盘（主进程按它选模型）。
    // 排队消息出队时不回写：出队执行的回合由主进程在回合开始重读盘上最新配置，
    // 这条路径若拿入队时的状态回写，反而会把运行中刚改的新模型覆盖回旧值。
    if (!queued && y.sessions?.setModel) { try { await y.sessions.setModel(sid, sessCfg); } catch { /* 落盘失败用全局默认 */ } }

    const baseList = baseMessages
      .filter((m) => !m.error && !m.local && !m.steer && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: m.content }));
    const wireHistory = [...baseList, { role: 'user', content: finalText }]; // 发给主进程：只有 role/content
    const displayUser = { role: 'user', content: finalText, ...(pastedTexts.length ? { pasted: pastedTexts, typed: typedText } : {}) };
    const history = [...baseList, displayUser]; // 本地渲染：多带粘贴块结构，气泡才能分段渲染
    const startedAt = Date.now();
    inflightRef.current.add(sid);
    stoppedRef.current.delete(sid); // 新一轮开始：解除上一轮手动停止的迟到事件屏蔽
    turnOutcomeRef.current.delete(sid); // 新一轮开始：上一轮的 stopped/error 不再拦队列泵
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
      turnOutcomeRef.current.set(sid, turnOutcomeOf(r)); // 停止/报错收尾：队列泵不再自动发下一条
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
      turnOutcomeRef.current.set(sid, 'error'); // 意外异常收尾：同样不自动发下一条
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
      // 实时提问卡收尾：问答已随 assistant.trace（ask_user tool part）固化，下一帧由 TraceBlock 还原成只读卡
      if (askCardsRef.current.some((c) => c.sessionId === sid)) {
        askCardsRef.current = askCardsRef.current.filter((c) => c.sessionId !== sid);
        setAskCards(askCardsRef.current);
      }
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

  // 队列自动发送：当前会话空闲（且不在停止中、上一轮不是停止/报错收尾）时消费队首一条；
  // 切到别的会话不消费它的队列。停止/报错后必须由用户手动点「发送」，否则「停止」等于没停。
  useEffect(() => {
    const sid = activeId;
    if (!sid) return;
    const q = queueBySession[sid] || [];
    if (!q.length) return;
    const head = q[0];
    const ok = canAutoPump({
      sid,
      busy,
      stopping,
      pumping: pumpingRef.current,
      inflight: inflightRef.current.has(sid), // 上一轮 send 还没收尾（例如刚点停止），不抢跑
      steering: steerRef.current.has(sid),     // 正在 Steer（中断旧回合 → 重开一回合）：避免抢在 Steer 前发下一条
      outcome: turnOutcomeRef.current.get(sid),
      headHeld: head?.hold === true             // 重启后恢复的排队消息：等用户点发送
    });
    if (!ok) return;
    pumpingRef.current = true;
    setQueueBySession((prev) => {
      const cur = prev[sid] || [];
      if (cur[0]?.id !== head.id) return prev; // 已被手动移除/取回：放弃这次消费
      return { ...prev, [sid]: cur.slice(1) };
    });
    // 下一拍再发，让本次状态的 setRunningIds 先落定
    Promise.resolve().then(() => sendRef.current?.(head));
  }, [activeId, busy, stopping, queueBySession]);

  // 排队消息存档（F8）：任何会话的队列变化都写 session_meta（重启不丢）。
  // 草稿（还没建会话，key=draft）没有 id，不存。同一份内容不重复写（签名对比）。
  const queueSavedRef = useRef(new Map()); // sid → JSON 签名
  useEffect(() => {
    const save = y?.sessions?.queueSave;
    if (!save) return;
    for (const [sid, list] of Object.entries(queueBySession)) {
      if (!sid || sid === 'draft') continue;
      const sig = JSON.stringify(list || []);
      if (queueSavedRef.current.get(sid) === sig) continue;
      queueSavedRef.current.set(sid, sig);
      try {
        Promise.resolve(save(sid, list || [])).catch(() => { queueSavedRef.current.delete(sid); });
      } catch { queueSavedRef.current.delete(sid); }
    }
  }, [queueBySession, y]);

  // 「停止中…」看门狗：turn-end 因窄竞态丢了就永远发不出去（每次发送只入队）。
  // 15s 后强制解除停止态并明确提示；stoppedRef 保留，迟到事件仍然不能把消息变回 streaming。
  useEffect(() => {
    if (!Object.keys(stoppingIds).length) return undefined;
    const timer = setInterval(() => {
      const expired = expiredStopping(stoppingIds, Date.now());
      if (!expired.length) return;
      for (const id of expired) stoppingRef.current.delete(id);
      setStoppingIds((prev) => {
        const next = { ...prev };
        for (const id of expired) delete next[id];
        return next;
      });
      pushNotice(t('等待回合收尾超过 {n}s，已恢复可发送（若刚才的回合仍在后台运行，它的结果仍会落库）', { n: STOPPING_WATCHDOG_MS / 1000 }));
    }, 1000);
    return () => clearInterval(timer);
  }, [stoppingIds]);

  // ---- 队列卡片操作：Steer（中断当前回合并用这条消息重开）/ 取回编辑 / 移除 ----
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
  // 手动发送某条排队消息：停止/报错收尾后队列不再自动发，这条路径就是「点发送」。
  // 只发这一条，不打断任何回合；与自动泵共用 pumpingRef，避免同一拍抢队首。
  const sendQueueItemNow = (id) => {
    const sid = activeIdRef.current ?? activeId;
    if (!sid) return;
    const item = (queueBySession[sid] || []).find((x) => x && x.id === id);
    if (!item) return;
    if (runningIds[sid] || stoppingIds[sid] || inflightRef.current.has(sid)) {
      pushNotice(t('当前回合仍在运行，无法立即发送排队消息（可等它结束或点停止）'));
      return;
    }
    pumpingRef.current = true;
    setQueueBySession((prev) => ({ ...prev, [sid]: removeById(prev[sid], id) }));
    Promise.resolve().then(() => sendRef.current?.(item)); // send 的 finally 会释放 pumpingRef
  };
  // 等旧回合真正收尾：sendOnce 的 finally 会清 inflightRef/stoppingRef/runsRef。
  // 必须等（而不是只发 abort 就走），否则旧回合收尾时的 setMessages 会覆盖新回合的流式气泡，
  // 旧 finally 的 setRunningIds(delete) 也会把新回合的「运行中」误清掉（与队列泵的守卫同一个原因）。
  const waitTurnSettled = async (sid, timeoutMs = 8000) => {
    const t0 = Date.now();
    while (inflightRef.current.has(sid) || stoppingRef.current.has(sid) || runsRef.current.has(sid)) {
      if (Date.now() - t0 >= timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 40));
    }
    return true;
  };
  // Steer（照 ZCode）：排队项立刻作为「用户消息」上屏 → 中断当前回合 → 用同一条消息重开一个回合。
  // 旧回合迟到的 token/turn-end 由 stop() 已有的 stoppedRef 机制屏蔽，这里不另造一套。
  const steerQueueItem = async (item) => {
    const sid = activeIdRef.current ?? activeId;
    const note = (content) => setMessages((prev) => [...prev, { role: 'notice', content }]);
    if (!sid || !item) return;
    if (steerRef.current.has(sid)) return; // 上一次 Steer 还在进行：连点直接忽略（不能并发起两个新回合）
    if (stoppingRef.current.has(sid)) return; // 正在中断：同一会话同一时刻只允许一条控制链
    const plan = planSteer(queueBySession[sid] || [], messages, item.id);
    if (!plan.item) return; // 已被取回/移除：幂等，什么都不做
    if (!plan.text) { note(t('这条排队消息是空的，无法 Steer')); return; }
    steerRef.current.add(sid);
    setSteeringIds((prev) => ({ ...prev, [sid]: true }));
    // ① 立刻可见：本地占位气泡（local:true，不参与 wire history）
    setMessages((prev) => insertUserBubble(prev, plan.text));
    scrollDown();
    // ④ 无论后面成败都出队：点过 Steer 的这条不再留在排队区
    setQueueBySession((prev) => ({ ...prev, [sid]: removeById(prev[sid], item.id) }));
    try {
      // ② 中断当前回合（stop() 会置 stoppedRef/stoppingRef 再 cancelChat，迟到事件只补内容不回退状态）
      if (runningIds[sid] || stoppingIds[sid] || inflightRef.current.has(sid)) await stop();
      // ③ 等旧回合收尾，再用同一条消息开新回合
      if (!(await waitTurnSettled(sid))) {
        note(t('旧回合没有及时停止，这条消息已保留在对话里；等它停下来后请手动重发'));
        return;
      }
      // 等旧回合的这段时间用户可能切走了：sendOnce 按「当前 activeId」发送，绝不能把这条发到别的会话
      if (activeIdRef.current !== sid) {
        note(t('会话已切换，这条 Steer 消息没有发送（已从排队区移除）'));
        return;
      }
      // 真实消息由 sendOnce 自己入列并上屏（占位气泡会被过滤掉），不 await 整轮以免锁死按钮
      const p = sendRef.current?.({ text: item.text || '', pasted: item.pasted || [], previews: item.previews || [] });
      if (p?.catch) p.catch(() => {}); // send 内部已兜异常，这里只防未处理的拒绝
    } catch (e) {
      note(t('Steer 失败：{msg}（这条消息已保留在对话里）', { msg: e?.message || e }));
    } finally {
      steerRef.current.delete(sid);
      setSteeringIds((prev) => { if (!prev[sid]) return prev; const n = { ...prev }; delete n[sid]; return n; });
    }
  };

  // 停止本回合：中断主进程里的流（用户实测：长回合无法中止=像卡死）
  // 点击即生效：先同步把 UI 切到「已中断/停止中」，再通知主进程杀工具进程树；
  // 迟到的 token / turn-end 用 stoppedRef 屏蔽，只能补内容，不能把消息变回 streaming。
  const stop = async () => {
    const sid = activeIdRef.current ?? activeId;
    if (!sid || stoppingRef.current.has(sid)) return; // 重复点击直接忽略
    // 压缩中且没有回合在跑：停止只收掉压缩（cancelChat 是给回合用的，误发会打掉下一轮）
    if (compactionRef.current.phase === 'running' && !inflightRef.current.has(sid)) {
      stoppingRef.current.add(sid);
      const next = reduceCompaction(compactionRef.current, { kind: 'compact-end', scope: compactionRef.current.scope, cancelled: true });
      compactionRef.current = next;
      setCompaction(next);
      setCompacting(false);
      setRunningIds((prev) => { if (!prev[sid]) return prev; const n = { ...prev }; delete n[sid]; return n; });
      try { await y?.compactCancel?.(sid); } catch { /* 取消失败：主进程最多 30s 超时自行收尾 */ }
      stoppingRef.current.delete(sid);
      return;
    }
    stoppingRef.current.add(sid);
    stoppedRef.current.add(sid);
    // 回合里正在压缩（自动路径的 LLM 摘要）→ 停止时一并收掉活动行，别让它在停止后还转
    if (compactionRef.current.phase === 'running') {
      const next = reduceCompaction(compactionRef.current, { kind: 'compact-end', scope: compactionRef.current.scope, cancelled: true });
      compactionRef.current = next;
      setCompaction(next);
    }
    setStoppingIds((prev) => ({ ...prev, [sid]: Date.now() })); // 值=点击时刻，供看门狗判断超时
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'assistant' && last.streaming) next[next.length - 1] = { ...last, streaming: false, interrupted: true };
      return next;
    });
    setRunningIds((prev) => { const n = { ...prev }; delete n[sid]; return n; });
    // 挂起的提问卡立即转为「用户取消」；主进程侧 pending 也会被 agent-cancel 同步 resolve
    askCardsRef.current = askCardsRef.current.map((c) => (
      c.sessionId === sid && c.status === 'pending' ? { ...c, status: 'cancelled', error: t('用户取消') } : c
    ));
    setAskCards(askCardsRef.current);
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
  // 实时提问卡与历史 trace 的互斥渲染（同 callId 只出一张卡）：
  // - 已收尾的 ask 以历史卡为准，藏掉实时卡；
  // - 仍在进行的 ask 以实时卡为准，从展示用消息里摘掉它的历史 trace 条目。
  const activeAskCards = activeId ? askCards.filter((c) => c.sessionId == null || c.sessionId === activeId) : [];
  const visibleAskCards = filterAskCardsByTrace(activeAskCards, messages);
  const chatMessages = hideAskTracesForCards(messages, visibleAskCards);
  // 面板可见性：设置页/切换会话时不渲染（返回聊天也不会自动弹回来，因为状态已被上面的 effect 清空）
  const showStepPanel = shouldShowStepPanel({ view: page, stepView, activeSessionId: activeId });
  // 产物面板只属于聊天视图；状态不清空，返回聊天后继续显示之前打开的产物
  const showArtifactPanel = shouldShowArtifactPanel({ view: page, artifact, artifactLoading, artifactError });
  // 用量页自动刷新开关：任一会话正在跑（含后台/工作流）就 5 秒轮询，全部停下即停
  const anyRunning = Object.values(runningIds).some(Boolean);
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
                messages={chatMessages} activeId={activeId} providers={providers} artifactPath={artifact?.path}
                openWorkflowRaw={openWorkflowRaw} setOpenWorkflowRaw={setOpenWorkflowRaw}
                scrollRef={scrollRef} stickRef={stickRef} jumpingRef={jumpingRef}
                showJump={showJump} setShowJump={setShowJump} y={y}
                onSendRecover={(text) => send({ text, pasted: [] })}
                onOpenArtifact={openArtifact} onEditMessage={editMessage} onOpenStep={openStep}
                askCards={visibleAskCards}
                onAskUserAnswer={answerAskUser}
              />
            ) : (
              <EmptyState y={y} demoBusy={demoBusy} setDemoBusy={setDemoBusy}
                setMessages={setMessages} setInput={setInput} inputRef={inputRef} />
            )}

            {/* 上下文压缩进行中/失败：贴在输入区上方的活动行（完成提示仍走会话里的 notice） */}
            <CompactionStatus state={compaction} />

            {/* 输入区（与消息区同宽） */}
            <Composer
              y={y} input={input} setInput={setInput} attachments={attachments} setAttachments={setAttachments}
              pastedBlocks={pastedBlocks} setPastedBlocks={setPastedBlocks}
              editing={editing} dragging={dragging} busy={busy} stopping={stopping} compacting={compacting}
              steering={!!steeringIds[activeId]}
              approval={approval} queueItems={queueItems} menu={menu} providerMenu={providerMenu}
              permMode={permMode} ctxStats={ctxStats} skills={skills} cfg={cfg} sessCfg={sessCfg}
              effortPos={effortPos} activeId={activeId} slashIndex={slashIndex} setSlashIndex={setSlashIndex}
              onNotice={(content) => setMessages((prev) => [...prev, { role: 'notice', content }])}
              inputRef={inputRef} modelMenuRef={modelMenuRef}
              setDragging={setDragging} setMenu={setMenu} setProviderMenu={setProviderMenu} setEffortPos={setEffortPos}
              setSessCfg={setSessCfg} setCfg={setCfg} setPermMode={setPermMode}
              cancelEdit={cancelEdit} chooseSlash={chooseSlash} decideApproval={decideApproval}
              steerQueueItem={steerQueueItem} moveQueueItemToInput={moveQueueItemToInput}
              removeQueueItem={removeQueueItem} sendQueueItemNow={sendQueueItemNow}
              queueHeld={queueItems.length > 0 && (queueItems[0]?.hold === true || holdsQueue(turnOutcomeRef.current.get(activeId)))}
              send={send} stop={stop}
              onGoSettings={() => setPage('settings')}
            />
          </>
        ) : (
          <SettingsPage onBack={() => setPage('chat')} running={anyRunning} initialSection={page === 'usage' ? 'usage' : 'models'} />
        )}
      </main>
      {showStepPanel ? (
        <SubagentPanel target={stepView} onClose={() => setStepView(null)} />
      ) : showArtifactPanel && (
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
