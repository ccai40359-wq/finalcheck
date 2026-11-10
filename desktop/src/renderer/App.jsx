// DeepSeek 式对话主界面：左栏品牌 + 会话列表，中央聊天流（工具调用渲染富卡片）
// 仅两个视图：「对话」（默认）与「模型设置」（左下角齿轮进入）
import React, { useEffect, useRef, useState } from 'react';
import SettingsPage from './pages/SettingsPage.jsx';
import { api } from './lib/ui.jsx';
import { mergeRunningRun } from './lib/session-restore.mjs';
import { TraceBlock, WorkflowLiveCard } from './chat/TraceCards.jsx';
import { ProcessTimeline, WorkingStatus, applyAgentEvent, mergeTraceIntoEvents } from './chat/ProcessTimeline.jsx';
import { ArtifactPanel, ArtifactChips, collectArtifacts } from './chat/ArtifactPanel.jsx';
import { SubagentPanel } from './chat/SubagentPanel.jsx';
import { renderMarkdown } from './chat/md.jsx';

const SESSION_PREVIEW = 5; // 每个工作区默认露出几条会话，其余走 Show more

// 模型条目兼容 string 与 { id, contextWindow, maxOutputTokens, vision }：
// 模型设置保存的是对象，而会话配置/菜单只认 string 的 id（否则会把对象当 React child 渲染）
const modelId = (m) => (typeof m === 'string' ? m.trim() : String(m?.id ?? '').trim());
const modelIdsOf = (p) => (Array.isArray(p?.models) ? p.models : []).map(modelId).filter(Boolean);
const modelEntriesOf = (p) => (Array.isArray(p?.models) ? p.models : [])
  .map((m) => (typeof m === 'string' ? { id: m.trim() } : (m && typeof m === 'object' ? { ...m, id: modelId(m) } : { id: '' })))
  .filter((m) => m.id);

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

const nextQueueId = () => `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nextPasteId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const countLines = (text) => String(text || '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length;
// 长粘贴阈值（照 ZCode）：≥8 行或 ≥1000 字符 → 收成「粘贴文本块」卡片，不直接塞进输入框
const isLongPaste = (text) => {
  const t = String(text || '');
  if (!t.trim()) return false;
  return countLines(t) >= 8 || t.length >= 1000;
};

// 空态能力卡：直接对应我们自己的功能，不写死任何目录/端口
const CAPABILITIES = [
  { id: 'audit', title: '代码体检', en: 'Audit', icon: 'shield', desc: '对当前项目跑 L1/L2/L3，结论带文件:行证据',
    prompt: '对当前项目做一次 L2 安全体检：先给目录概览，再按检查项跑，结论要带文件:行证据。' },
  { id: 'pentest', title: '渗透测试', en: 'Pentest', icon: 'radar', desc: '先侦察再按方法论跑最小验证集，不爆破',
    prompt: `我要做渗透测试，目标 URL 是：
（把目标地址补在这行后面）
先侦察端口/指纹，再按方法论跑最小验证集，不要爆破。` },
  { id: 'download', title: '下载闸安检', en: 'Download gate', icon: 'download', desc: '安装脚本、投毒、外呼、README 注入',
    prompt: '对当前项目做下载闸安检：安装脚本、投毒、外呼、README 注入。' },
  { id: 'workflow', title: '多 Agent 工作流', en: 'Workflow', icon: 'flow', desc: '分头查多个方向，最后汇总成一份结论',
    prompt: '用工作流分头查这个项目的三个方向：依赖与供应链、鉴权与越权、动态探测；最后汇总成一份结论。' },
  { id: 'report', title: '生成报告', en: 'Report', icon: 'report', desc: '跑体检并生成可预览的完整报告',
    prompt: '对当前项目跑一次体检，并生成可预览的完整报告。' },
  { id: 'explore', title: '自由执行', en: 'Free run', icon: 'terminal', desc: '看目录、读代码、跑命令，像 coding agent 一样',
    prompt: '先看一下当前项目的目录结构和 README，再用三句话告诉我这是个什么项目。' }
];
const CAP_ICON = { shield: IconShield, radar: IconRadar, download: IconDownload, flow: IconFlow, report: IconReport, terminal: IconTerminal, play: IconPlay };

// 首次使用判定：没有供应商，或所有供应商都被禁用（enabled === false）
export const needsFirstRunSetup = (cfg) => !(Array.isArray(cfg?.providers) ? cfg.providers : []).some((p) => p?.enabled !== false);

// 示例体检结果 → 展示摘要（verdict + 发现数 + 前 3 条）
export function formatDemoAuditSummary(result, dir) {
  const verdict = result?.conclusion?.verdict || result?.verdict || '未给出结论';
  const reason = result?.conclusion?.reason || result?.reason || '';
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const SEV_LABEL = { high: '高危', medium: '中危', low: '低危' };
  const lines = findings.slice(0, 3).map((f) => {
    const sev = SEV_LABEL[f?.severity] || '提示';
    const where = f?.file ? `（${baseName(f.file)}${f?.line ? `:${f.line}` : ''}）` : '';
    return `- [${sev}] ${f?.checkId ? `${f.checkId} · ` : ''}${f?.message || f?.rule || '未命名问题'}${where}`;
  });
  return [
    '### 示例体检完成（L2）',
    `**结论：${verdict}**${reason ? ` · ${reason}` : ''}`,
    `发现 **${findings.length}** 条${findings.length > 3 ? '，先列前 3 条' : ''}`,
    lines.length ? lines.join('\n') : '没有发现明显问题。',
    `> 示例目录：\`${dir}\``
  ].join('\n\n');
}

// 用户消息里的附件块（发送时由 renderer 追加，模型可见；UI 显示成文件 chips）
const splitAttachmentBlock = (content) => {
  const s = String(content || '');
  const m = s.match(/\n\n\[附件\]\n((?:- .+\n?)+)$/);
  if (!m) return { text: s, files: [] };
  return {
    text: s.slice(0, m.index),
    files: m[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
  };
};
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

// /workflow 会展开成一段工程指令发给模型；聊天里只显示「Workflow + 任务」，原始指令折叠可查
const WF_PROMPT_PREFIX = '请用 run_workflow 组织一次多 agent 工作流';
const parseWorkflowPrompt = (content) => {
  const s = String(content || '');
  if (!s.startsWith(WF_PROMPT_PREFIX)) return null;
  const m = s.match(/\n任务：([\s\S]*)$/);
  return { task: (m?.[1] || '').trim() };
};

// 会话标题展示：把技能/工作流的内部指令原文折成可读形式（老会话也立即变干净）
const prettyTitle = (text) => {
  const s = String(text || '').replace(/\n\n\[附件\][\s\S]*$/, '').trim();
  const skill = s.match(/^\[技能\]\s*([^（(]+)/);
  if (skill) return `✦ ${skill[1].trim().slice(0, 24)}`;
  if (s.startsWith(WF_PROMPT_PREFIX)) {
    const task = s.match(/\n任务：([^\n]+)/);
    return `Workflow · ${(task?.[1] || '多 agent 工作流').trim().slice(0, 24)}`;
  }
  return s;
};

// ---- 技能展开段（纯函数，便于单测） ----
// expandSkill() 会把用户输入的 /ssrf 展开成固定句式（发给模型）：
//   [技能] <中文名>（playbook <id>）—— 请先调用 read_playbook(topic="<id>") 加载方法论，再严格按手册执行。
// 聊天里不该露这段内部指令，所以在这里解析回「名称 + id」并把它从正文里摘掉。
// 正则说明：名称可含中文/空格/括号，故名称用惰性 [\s\S]*? 并锚定「（playbook 」；
// id 优先取 topic="..." 引号内的值（比括号里的 id 更可靠，名称里的括号不会污染它）；
// 段首空白一并吃掉，段后空白留给后续正文，最后再规整一次空白（不动普通消息）。
const SKILL_SEGMENT_RE = /[ \t]*\[技能\]\s*([\s\S]*?)（playbook\s+([^）]*?)）——\s*请先调用\s*read_playbook\(topic="([^"]*)"\)\s*加载方法论，再严格按手册执行。/g;
const buildSkillSegment = (s) => `[技能] ${s.cn}（playbook ${s.id}）—— 请先调用 read_playbook(topic="${s.id}") 加载方法论，再严格按手册执行。`;

const tidySkillRemoval = (s) => String(s || '')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n[ \t]+/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const parseSkillSegments = (content) => {
  const source = String(content || '');
  const skills = [];
  // String.replace 每次从 lastIndex 0 开始，这里显式归零，避免全局正则被外部复用时串状态
  SKILL_SEGMENT_RE.lastIndex = 0;
  const stripped = source.replace(SKILL_SEGMENT_RE, (full, name, idInParen, topic) => {
    const id = String(topic || idInParen || '').trim();
    skills.push({ name: String(name || '').trim() || id, id });
    return ' ';
  });
  if (!skills.length) return { skills, text: source, tokenText: source };
  SKILL_SEGMENT_RE.lastIndex = 0;
  // tokenText：把展开段还原成 /id，供复制/编辑用；重发时再由 expandSkill 展开
  const tokenText = tidySkillRemoval(source.replace(SKILL_SEGMENT_RE, (full, name, idInParen, topic) => ` /${String(topic || idInParen || '').trim()} `));
  return { skills, text: tidySkillRemoval(stripped), tokenText };
};

// 技能 chip：金色符号 + 名称，细底无边框（不是药丸）；title 只在 hover 时暴露 playbook id
function SkillChips({ skills }) {
  if (!skills?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {skills.map((s, k) => (
        <span key={`${s.id}-${k}`} title={`playbook ${s.id}`}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] bg-gold/[0.10] px-1.5 py-[1px] text-[12.5px] leading-relaxed text-goldSoft shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
          <span aria-hidden="true" className="text-[10px] leading-none text-gold">✦</span>
          <span className="font-kai tracking-[0.03em]">{s.name}</span>
        </span>
      ))}
    </div>
  );
}
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

// 图片预览统一入口：磁盘路径 → artifactRead 拿 dataURL（不依赖内存 File/blob 生命周期），
// 展示前用 canvas 把最长边压到 ≤480px，避免把 20MB 原图 base64 塞进 React state。
const MAX_PREVIEW_DIM = 480;
function shrinkImageDataUrl(dataUrl, maxDim = MAX_PREVIEW_DIM) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (!w || !h || Math.max(w, h) <= maxDim) return resolve(dataUrl);
          const scale = maxDim / Math.max(w, h);
          const cw = Math.max(1, Math.round(w * scale));
          const ch = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(dataUrl);
          ctx.drawImage(img, 0, 0, cw, ch);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl); // 解码失败交给调用方决定占位/重试
      img.src = dataUrl;
    } catch { resolve(dataUrl); }
  });
}

async function previewFromPath(y, p) {
  if (!p || !IMG_EXT_RE.test(String(p))) return null;
  try {
    const r = await y?.artifactRead?.(p);
    if (!r?.dataUrl) return null;
    return await shrinkImageDataUrl(r.dataUrl);
  } catch { return null; }
}

// 输入框里的附件 chip：图片直接显示缩略图（无 preview 时按路径读），文件名 + 移除
function AttachmentChip({ item, onRemove }) {
  const y = api();
  const [src, setSrc] = useState(item.preview || null);
  const triedRef = useRef(false);
  const retriedRef = useRef(false);
  useEffect(() => { setSrc(item.preview || null); triedRef.current = false; retriedRef.current = false; }, [item.preview, item.path]);
  useEffect(() => {
    let alive = true;
    if (src || triedRef.current || !IMG_EXT_RE.test(item.path || '')) return undefined;
    triedRef.current = true;
    (async () => {
      const url = await previewFromPath(y, item.path);
      if (alive && url) setSrc(url);
    })();
    return () => { alive = false; };
  }, [item.path, src, item.preview]);
  // 图片加载失败：先撤下破图（立刻回 ▤ 占位），再按路径用主进程重读一次 data URL
  const handleImgError = () => {
    setSrc(null);
    if (retriedRef.current || !item.path) return;
    retriedRef.current = true;
    previewFromPath(y, item.path).then((url) => { if (url) setSrc(url); }).catch(() => {});
  };
  // 图片附件只显示缩略图（不写文件名），删除按钮悬停浮出；非图片仍保留文件名 chip
  const isImage = !!src || IMG_EXT_RE.test(item.path || '') || IMG_EXT_RE.test(item.name || '');
  if (isImage) {
    return (
      <div className="group relative shrink-0">
        {src
          ? <img src={src} alt={item.name || ''} title={item.name || ''} className="h-9 w-9 rounded-lg object-cover border border-edge/60 hover:border-gold/50 transition-colors" onError={handleImgError} />
          : <span title={item.name || ''} className="h-9 w-9 rounded-lg bg-white/[0.04] border border-edge/60 flex items-center justify-center text-goldDeep">▤</span>}
        <button onClick={onRemove} title="移除附件"
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-black/80 border border-edge text-[9px] leading-none text-mute/80 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity">✕</button>
      </div>
    );
  }
  return (
    <div className="group inline-flex items-center gap-2 rounded-xl bg-white/[0.04] border border-edge/60 pl-1.5 pr-2 py-1 text-[11px] transition-colors duration-200 hover:border-edge">
      <span className="h-7 w-7 rounded-lg bg-white/[0.04] flex items-center justify-center text-goldDeep">▤</span>
      <span className="max-w-[170px] truncate text-ink/80">{item.name}</span>
      <button onClick={onRemove} title="移除附件" className="text-mute/50 hover:text-red-400 transition-colors duration-200">✕</button>
    </div>
  );
}

// 用户消息里的附件：图片直接出缩略图（点开右侧预览），其它类型保留文件名 chip
function UserAttachments({ files, onOpen }) {
  const y = api();
  const [loaded, setLoaded] = useState({});
  const retriedRef = useRef(new Set());
  const key = (files || []).join('|');
  useEffect(() => {
    let alive = true;
    retriedRef.current = new Set();
    (async () => {
      for (const p of (files || []).filter((f) => IMG_EXT_RE.test(f))) {
        const url = await previewFromPath(y, p);
        if (alive && url) setLoaded((s) => ({ ...s, [p]: url }));
      }
    })();
    return () => { alive = false; };
  }, [key]);
  // data URL 也加载失败（文件损坏/已删除）：先回 ▤ 占位，再按路径重读一次；仍失败保持占位，不显示破图
  const handleImgError = (p) => {
    setLoaded((s) => { if (!s[p]) return s; const n = { ...s }; delete n[p]; return n; });
    if (retriedRef.current.has(p)) return;
    retriedRef.current.add(p);
    previewFromPath(y, p).then((url) => { if (url) setLoaded((s) => ({ ...s, [p]: url })); }).catch(() => {});
  };
  if (!files?.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
      {files.map((p) => loaded[p] ? (
        <button key={p} onClick={() => onOpen?.(p)} title={p}
          className="w-28 h-20 rounded-lg overflow-hidden border border-gold/30 hover:border-gold/70 bg-[#0d0d10] transition-colors">
          <img src={loaded[p]} alt={baseName(p)} className="w-full h-full object-cover" onError={() => handleImgError(p)} />
        </button>
      ) : (
        <button key={p} onClick={() => onOpen?.(p)} title={p}
          className="inline-flex items-center gap-1 rounded-md border border-gold/30 bg-gold/10 px-2 py-1 text-[10px] font-mono text-goldSoft/90 hover:border-gold/60">
          <span>▤</span><span className="max-w-[180px] truncate">{baseName(p)}</span>
        </button>
      ))}
    </div>
  );
}
const fmtTokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(v));
};

// 用户消息里的粘贴文本块：纯文本 + 等宽字体，不做 markdown/着色/链接识别；内部滚动、深色底
function PastedTextBlock({ text }) {
  return (
    <pre data-testid="pasted-text-block"
      className="mt-1.5 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-edge bg-[#0a0a0c] px-3 py-2 font-mono text-[12px] leading-6 text-ink/80 select-text">
      {String(text || '')}
    </pre>
  );
}

const relTime = (ts) => {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h`;
  if (d < 7 * 86400e3) return `${Math.floor(d / 86400e3)}d`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};

export default function App() {
  const y = api(); // window.finalcheck（浏览器直开时为空 → 仅壳）
  const [page, setPage] = useState('chat');
  const [sessions, setSessions] = useState([]);       // [{id,title,updatedAt,turns}]
  const [projects, setProjects] = useState([]);       // [{id,name,path,isDefault,sessionCount}]
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeId, setActiveId] = useState(null);     // 当前会话 ID（agentChat 第三参）
  const [messages, setMessages] = useState([]);       // 当前会话消息（含流式助手占位）
  const [input, setInput] = useState('');
  const [editing, setEditing] = useState(null); // {index, keepTurns}：编辑历史消息，发送后从该条重开
  const [runningIds, setRunningIds] = useState({}); // 会话 id → 是否正在跑（多会话可同时跑）
  const [stoppingIds, setStoppingIds] = useState({}); // 会话 id → 已点停止、等待主进程收尾
  const [sessCfg, setSessCfg] = useState({ providerId: '', model: '', effort: '' }); // 当前会话自己的模型配置
  const [effortPos, setEffortPos] = useState(null); // 拖动中的连续位置（0-4，可为小数；松手后按最近档位落库）
  const activeIdRef = useRef(null);   // 供异步回调判断「现在看的是哪个会话」
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
  const [collapsedProjects, setCollapsedProjects] = useState({}); // 工作区折叠（折叠的是它自己的会话列表）
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
  const changeMode = async (m) => {
    setPermMode(m);
    setMenu(null);
    try { const c = await y.getConfig(); const nc = { ...c, permissionMode: m }; await y.setConfig(nc); setCfg(nc); } catch { /* 忽略 */ }
  };
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
  // 一键回到底部：平滑滚动，立刻隐藏按钮（滚动事件里会再兜底校正）
  const jumpToBottom = () => {
    stickRef.current = true;
    jumpingRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setTimeout(() => { jumpingRef.current = false; }, 500);
  };

  const refreshSessions = async () => {
    if (!y) return [];
    try { const list = await y.sessions.list(); setSessions(list); return list; } catch { return []; }
  };

  const refreshProjects = async () => {
    if (!y?.projects) return [];
    try { const list = await y.projects.list(); setProjects(list); return list; } catch { return []; }
  };

  // 切项目只切 UI 视角（ZCode 语义）：不中断任何在跑的回合，runsRef 里的后台流原样保留
  const switchProject = async (p) => {
    if (!p) return;
    await y.projects.select(p.id);
    setActiveProjectId(p.id);
    setArtifact(null);
    setAttachments([]);
    setInput('');
    const list = await refreshSessions();
    if (list.length) await openSession(list[0].id);
    else { setActiveId(null); setMessages([]); }
    setPage('chat');
  };

  // 工作区行：非当前项目 → 切过去并展开；当前项目 → 折叠/展开它自己的会话
  const toggleProject = async (p) => {
    if (p.id !== activeProjectId) {
      await switchProject(p);
      setCollapsedProjects((s) => ({ ...s, [p.id]: false }));
      return;
    }
    setCollapsedProjects((s) => ({ ...s, [p.id]: !s[p.id] }));
  };

  const addProject = async () => {
    if (!y?.pickDirectory || !y?.projects) return;
    const dir = await y.pickDirectory();
    if (!dir) return;
    try {
      const p = await y.projects.add(dir);
      await refreshProjects();
      await switchProject(p);
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'notice', content: '添加项目失败：' + e.message }]);
    }
  };

  const removeProject = async (p) => {
    if (!y?.projects) return;
    const ok = await new Promise((resolve) => setConfirmBox({
      text: `从项目列表移除「${p.name}」？不会删除磁盘文件夹，只移除这里的入口。`,
      resolve
    }));
    setConfirmBox(null);
    if (!ok) return;
    try {
      const r = await y.projects.remove(p.id);
      const list = await refreshProjects();
      if (activeProjectId === p.id) {
        const next = list[0] || r.projects?.[0];
        if (next) await switchProject(next);
        else { setActiveProjectId(null); setSessions([]); setMessages([]); setActiveId(null); }
      }
    } catch { /* 忽略 */ }
  };

  const copyText = (text) => { const p = y?.copyText?.(text); if (p?.catch) p.catch(() => {}); };
  const patchFlags = async (s, flags) => {
    setRowMenu(null);
    try { await y.sessions.flags(s.id, flags); await refreshSessions(); } catch { /* 忽略 */ }
  };
  const moveSession = async (s, targetProjectId) => {
    setRowMenu(null);
    setMoveOpen(false);
    try {
      await y.sessions.move(s.id, targetProjectId);
      await refreshSessions();
      await refreshProjects();
    } catch (e) { setMessages((prev) => [...prev, { role: 'notice', content: '移动失败：' + e.message }]); }
  };
  const saveRename = async () => {
    if (!renameBox) return;
    const { session, value } = renameBox;
    setRenameBox(null);
    if (!String(value || '').trim()) return;
    try { await y.sessions.rename(session.id, value); await refreshSessions(); } catch { /* 忽略 */ }
  };

  // 切项目不再走「先停掉所有回合」：主进程按会话所属项目继续跑，切 Workspace 只换 UI 视角
  const openSession = async (id) => {
    if (!y) return;
    try {
      const s = await y.sessions.open(id);
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
      refreshSessions(); // markRead 已在主进程清掉 unread → 绿点消失
    } catch { refreshSessions(); }
  };

  // dsh 语义：New Session 只是「开一张空白草稿」，不落盘；
  // 真正创建会话文件是在第一次发送消息那一刻（send() 里 sid 为空时 create）
  const newSession = async () => {
    if (!y) { setActiveId(null); setMessages([]); setPage('chat'); return; }
    if (!activeProjectId && projects[0]) {
      try { await y.projects.select(projects[0].id); setActiveProjectId(projects[0].id); } catch { /* 忽略 */ }
    }
    setActiveId(null);
    activeIdRef.current = null;
    stickRef.current = true;
    setMessages([]);
    setEditing(null);
    setAttachments([]);
    setInput('');
    setArtifact(null);
    setStepView(null); // 新建草稿时必须收起子代理面板：否则会把上一条会话的子代理对话留在右边栏
    setSessCfg(cfgDefaults());
    setPage('chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const archiveSession = async (s) => {
    if (!y?.sessions?.flags) return;
    const next = !s.archived;
    try { await y.sessions.flags(s.id, { archived: next }); } catch { return; }
    const list = await refreshSessions();
    refreshProjects();
    // 归档正在看的那条：自动打开下一条未归档的，别把界面停在一条列表里看不见的会话上
    if (next && activeId === s.id && page === 'chat') {
      const pick = (list || []).find((x) => !x.archived && x.id !== s.id);
      if (pick) openSession(pick.id);
      else { setActiveId(null); setMessages([]); }
    }
  };

  const removeSession = async (s) => {
    if (!y) return;
    // 自定义黑金确认框（原生 window.confirm 太丑，用户实测点名）
    const ok = await new Promise((resolve) => {
      setConfirmBox({
        text: `删除会话「${prettyTitle(s.title) || '未命名'}」？此操作不可恢复。`,
        resolve
      });
    });
    setConfirmBox(null);
    if (!ok) return;
    try { await y.sessions.remove(s.id); } catch { /* 忽略 */ }
    const list = await refreshSessions();
    refreshProjects();
    if (activeId === s.id) {
      setActiveId(null);
      setMessages([]);
      if (list.length) openSession(list[0].id);
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
        try { await y.projects.select(p.id); setActiveProjectId(p.id); } catch { /* 忽略 */ }
        const list = await refreshSessions();
        if (list.length) await openSession(list[0].id);
      }
      setBooted(true);
    })();
    // 权限模式 / 模型 / 思考强度：启动时从配置载入（仿 ZCode Full access）
    Promise.resolve(y.getConfig?.())
      .then((c) => { setCfg(c || null); setPermMode(c?.permissionMode === 'full' ? 'full' : 'ask'); })
      .catch(() => {})
      .finally(() => setCfgLoaded(true));
    y.skillsList?.().then((list) => setSkills(Array.isArray(list) ? list : [])).catch(() => {});
  }, []);

  // 从设置页回到对话：重新读配置（模型/effort 可能在设置页改过）
  useEffect(() => {
    if (page !== 'chat' || !y) return;
    y.getConfig?.().then((c) => { setCfg(c); setPermMode(c?.permissionMode === 'full' ? 'full' : 'ask'); }).catch(() => {});
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
        setArtifactError(r.error || '文件已不存在');
      } else {
        setArtifact(r);
      }
    } catch (e) {
      setArtifact({ path: p, name: baseName(p) });
      setArtifactError(e.message || '读取失败');
    } finally {
      setArtifactLoading(false);
    }
  };
  const closeArtifact = () => { setArtifact(null); setArtifactError(''); setArtifactLoading(false); };

  // ---- 附件：粘贴截图 / 拖拽文件 / 加号选择 ----
  const readBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  // 粘贴/拖入的图片直接转 data URL（blob: URL 会随源 File 生命周期失效，导致 chip 显示破图）
  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('读取图片失败'));
    r.readAsDataURL(file);
  });
  const addFiles = async (files) => {
    if (!y?.saveAttachment) return;
    for (const f of Array.from(files || [])) {
      if (f.size > 20 * 1024 * 1024) continue;
      try {
        const dataBase64 = await readBase64(f);
        const saved = await y.saveAttachment({ name: f.name || 'pasted.png', dataBase64 });
        let preview = null;
        if (String(f.type || '').startsWith('image/')) {
          // 主路径：从落盘文件回读（切会话/重开仍可显示）；大图在 previewFromPath 内缩到 ≤480px
          preview = await previewFromPath(y, saved.path);
          // 极端情况（落盘文件暂不可读）：退回内存 File 转 dataURL，仍缩到预览尺寸
          if (!preview) {
            try { preview = await shrinkImageDataUrl(await fileToDataUrl(f)); } catch { /* 保持 ▤ 占位 */ }
          }
        }
        setAttachments((prev) => [...prev, { ...saved, preview }]);
      } catch { /* 单个附件失败不阻断 */ }
    }
  };
  const pickAttachFiles = async () => {
    if (!y?.pickFiles) return;
    try {
      const paths = await y.pickFiles();
      setAttachments((prev) => [...prev, ...(paths || []).map((p) => ({ path: p, name: baseName(p), size: 0, preview: null }))]);
    } catch { /* 用户取消 */ }
  };
  const removeAttachment = (idx) => setAttachments((prev) => prev.filter((_, i) => i !== idx));

  // ---- 长粘贴文本块：≥8 行或 ≥1000 字符收成卡片（内容不进输入框，发送时并入正文） ----
  const addPastedBlock = (text) => {
    const body = String(text || '').replace(/\r\n?/g, '\n');
    if (!isLongPaste(body)) return false;
    setPastedBlocks((prev) => [...prev, { id: nextPasteId(), text: body, lines: countLines(body), expanded: false }]);
    return true;
  };
  const togglePasted = (id) => setPastedBlocks((prev) => prev.map((b) => (b.id === id ? { ...b, expanded: !b.expanded } : b)));
  const removePasted = (id) => setPastedBlocks((prev) => prev.filter((b) => b.id !== id));

  // ---- 模型 / 思考强度（按会话保存，不再改全局默认） ----
  const persistSessionCfg = async (patch, { close = true } = {}) => {
    const next = { ...sessCfg, ...patch };
    setSessCfg(next);
    if (close) setMenu(null);
    if (activeId && y?.sessions?.setModel) {
      try { await y.sessions.setModel(activeId, next); } catch { /* 保存失败仅影响下次打开 */ }
    }
  };
  const chooseModel = (providerId, model) => persistSessionCfg({ providerId, model });
  const chooseEffort = (thinkingEffort, opts) => persistSessionCfg({ effort: thinkingEffort }, opts);
  const pickProvider = (p) => {
    const next = { ...sessCfg, providerId: p.id, model: modelIdsOf(p)[0] || '' };
    setSessCfg(next);
    setProviderMenu(false);
    if (activeId && y?.sessions?.setModel) { try { y.sessions.setModel(activeId, next); } catch { /* 忽略 */ } }
  };

  // ---- / 技能（dsh 式：文字后面空格 + / 就能唤起，命令/技能可嵌在正文里） ----
  const skillOf = (name) => skills.find((s) => String(s.name).toLowerCase() === String(name).toLowerCase());
  const expandSkill = (text) => {
    const raw = String(text || '');
    // /workflow 出现在任意位置都生效：把命令本身拿掉，剩下的全文当任务
    if (/(^|\s)\/workflow(?=\s|$)/i.test(raw)) {
      const task = raw.replace(/(^|\s)\/workflow(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim();
      return `请用 run_workflow 组织一次多 agent 工作流：先自己设计 2-8 个步骤（id/name/role/prompt/depends_on），互不依赖的步骤会并行执行；每步 prompt 必须自包含（要做什么、输入是什么、交付什么），上游结果引擎会自动附上。拿到各步结果后再汇总成一份结论——不要只列计划，也不要用文字模拟并行。${task ? `\n任务：${task}` : ''}`;
    }
    // 技能 token 可以嵌在正文里：逐个展开成 read_playbook 指令，保留其它文字
    return raw.replace(/(^|\s)\/([a-z0-9][a-z0-9-]*)(?=\s|$)/gi, (full, space, name) => {
      const s = skillOf(name);
      if (!s) return full;
      return `${space}${buildSkillSegment(s)}`;
    });
  };
  const runCompact = async () => {
    if (!y?.compactSession || busy || compacting) return;
    setCompacting(true);
    let sid = activeId;
    try {
      if (!sid) {
        const s = await y.sessions.create('新会话');
        sid = s.id;
        setActiveId(sid);
        await refreshSessions();
        setMessages([]);
      }
      const r = await y.compactSession(sid);
      if (r?.error) setMessages((prev) => [...prev, { role: 'notice', content: r.error }]);
      else await openSession(sid);
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'notice', content: '压缩失败：' + e.message }]);
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
      setMessages((prev) => [...prev, { role: 'notice', content: `供应商「${activeProv?.name || '未选择'}」还没有可用模型：请在模型面板里添加/选择模型后再发送。` }]);
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
    const typedText = expandSkill(typedRaw);
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
        const s = await y.sessions.create('新会话');
        sid = s.id;
        setActiveId(sid);
        activeIdRef.current = sid;
        setSessions((prev) => [{ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, turns: 0 }, ...prev]);
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
          else next[last] = { role: 'assistant', content: r.answer || prev[last]?.content || '(空回复)', trace: r.trace || [], ...timeline };
          return next;
        });
      }
      if (r.persisted) {
        setSessions((prev) => prev
          .map((s) => (s.id === sid ? { ...s, title: r.persisted.title || s.title, updatedAt: r.persisted.updatedAt, turns: s.turns + 1 } : s))
          .sort((a, b) => (b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt)));
      }
    } catch (e) {
      if (isActive()) {
        setMessages((prev) => {
          const next = [...prev];
          const pm = next[next.length - 1] || {};
          next[next.length - 1] = {
            role: 'assistant', content: '', error: 'Agent 调用失败：' + e.message, trace: [],
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
        refreshSessions();
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
    if (!runningIds[sid] || stoppingIds[sid]) { note('当前没有运行中的回合，无法 Steer'); return; }
    if (!y?.agentSteer) { note('当前版本不支持 Steer'); return; }
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
      note('Steer 失败：' + (e?.message || e));
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

  const pickSuggestion = (s) => {
    setInput(s);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // 示例一键演示：demoPath() → 现有 audit IPC（L2）→ 把摘要作为一条本地 assistant 消息展示
  const pushNotice = (content) => setMessages((prev) => [...prev, { role: 'notice', content }]);
  const runDemoAudit = async () => {
    if (!y || demoBusy) return;
    if (!y.demoPath) { pushNotice('示例项目未随包发布'); return; }
    setDemoBusy(true);
    let phase = 'demo';
    try {
      const p = await y.demoPath();
      const dir = typeof p === 'string' ? p : (p && typeof p === 'object' && !p.error ? (p.path || p.dir || null) : null);
      if (!dir) { pushNotice('示例项目未随包发布'); return; }
      if (!y.audit) { pushNotice('当前版本不支持体检调用'); return; }
      phase = 'audit';
      const r = await y.audit(dir, { tier: 'L2', interactive: true });
      setMessages((prev) => [...prev, { role: 'assistant', content: formatDemoAuditSummary(r, dir), trace: [], local: true }]);
    } catch (e) {
      if (phase === 'demo') pushNotice('示例项目未随包发布');
      else pushNotice('示例体检失败：' + (e?.message || String(e)));
    } finally {
      setDemoBusy(false);
    }
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

  const hasMsgs = messages.length > 0;
  const activeProject = projects.find((p) => p.id === activeProjectId) || null;
  const activeTitle = prettyTitle(sessions.find((s) => s.id === activeId)?.title) || (activeId ? activeProject?.name : 'New Session');

  // ---- 输入框下方的模型 / 思考强度 / 技能菜单（按当前会话的配置显示） ----
  const allProviders = cfg?.providers || [];
  const providers = allProviders.filter((p) => p.enabled !== false);
  const activeProv = allProviders.find((p) => p.id === sessCfg.providerId) || providers[0] || null;
  const activeModelIds = modelIdsOf(activeProv);
  const activeModel = (sessCfg.model && activeModelIds.includes(sessCfg.model)) ? sessCfg.model : (activeModelIds[0] || '');
  const activeModelEntries = modelEntriesOf(activeProv);
  const effort = sessCfg.effort || cfg?.thinkingEffort || 'max';
  const EFFORTS = [
    { v: 'default', label: 'Default', desc: '跟随模型默认' },
    { v: 'low', label: 'Low', desc: '更快，思考更少' },
    { v: 'medium', label: 'Medium', desc: '平衡' },
    { v: 'high', label: 'High', desc: '更深入' },
    { v: 'max', label: 'Max', desc: '最大思考强度（默认）' }
  ];
  const effortIndex = Math.max(0, EFFORTS.findIndex((x) => x.v === effort));
  const sliderPos = effortPos ?? effortIndex;
  const effortLabel = EFFORTS[Math.round(sliderPos)]?.label || 'Max';
  const COMMANDS = [
    { type: 'command', id: 'compact', name: 'compact', cn: '压缩上下文', description: '把当前对话压成摘要，后续只带摘要 + 最近 6 条' },
    { type: 'command', id: 'workflow', name: 'workflow', cn: '多 agent 工作流', description: '你自己写步骤，引擎按依赖并行调度多个子代理' }
  ];
  const skillItems = skills.map((s) => ({ type: 'skill', id: s.id, name: s.name, cn: s.cn, description: s.description || '' }));
  const slashMatch = input.match(/(^|\s)\/([a-z0-9-]*)$/i);
  const slashQ = (slashMatch?.[2] || '').toLowerCase();
  const slashItems = [...COMMANDS, ...skillItems]
    .filter((i) => !slashQ || String(i.name).toLowerCase().includes(slashQ) || String(i.cn).toLowerCase().includes(slashQ) || String(i.description).toLowerCase().includes(slashQ))
    .slice(0, 50);
  const slashOpen = !!slashMatch;

  const onComposerKeyDown = (e) => {
    if (slashOpen && slashItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((v) => (v + 1) % slashItems.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((v) => (v - 1 + slashItems.length) % slashItems.length); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); chooseSlash(slashItems[Math.min(slashIndex, slashItems.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setInput(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  };

  return (
    <div className="app-root h-full flex flex-col bg-base text-ink">
      {/* 液态玻璃的底：两团极暗的金色/青色光晕（玻璃要有东西可以折射） */}
      <div className="app-ambient" aria-hidden="true" />
      {/* 自定义标题栏（frame:false，用户嫌原生标题栏丑）：可拖拽 + 自绘最小化/最大化/关闭 */}
      <div className="relative z-[1] shrink-0 h-9 flex items-center justify-between border-b border-white/[0.06] bg-white/[0.025] backdrop-blur-2xl select-none" style={{ WebkitAppRegion: 'drag' }}>
        <div className="flex items-center gap-2 pl-3">
          <span className="w-4 h-4 rounded-[4px] bg-gold/15 border border-gold/50 flex items-center justify-center text-[9px] font-bold text-goldSoft">FC</span>
          <span className="text-[12px] tracking-widest text-mute">FinalCheck</span>
        </div>
        <div className="flex items-center h-full" style={{ WebkitAppRegion: 'no-drag' }}>
          <button onClick={() => y?.windowCtl('minimize')} className="h-full px-3.5 text-mute hover:text-ink hover:bg-white/5 transition-colors" title="最小化">─</button>
          <button onClick={() => y?.windowCtl('maximize')} className="h-full px-3.5 text-mute hover:text-ink hover:bg-white/5 transition-colors" title="最大化">▢</button>
          <button onClick={() => y?.windowCtl('close')} className="h-full px-3.5 text-mute hover:text-red-300 hover:bg-red-500/15 transition-colors" title="关闭">✕</button>
        </div>
      </div>
      <div className="relative z-[1] flex-1 min-h-0 flex text-ink">
      {/* ---- 左栏（液态玻璃）：设置/用量页改全屏布局，不露会话侧栏 ---- */}
      {page === 'chat' && <aside className="glass-side w-[212px] shrink-0 flex flex-col">
        {/* 最上面一条：New Session（居中、全英文，仿 ZCode） */}
        <div className="px-2 pt-2.5 pb-1">
          <button onClick={newSession} disabled={!y || !activeProjectId}
            className="glass-row w-full flex items-center justify-center gap-2 rounded-xl px-2.5 h-9 text-[13px] text-ink/90 hover:text-ink disabled:opacity-35">
            <IconPlusCircle /> New Session
          </button>
        </div>

        {/* Workspaces 标题 + 新建项目文件夹（右边这个图标） */}
        <div className="px-3.5 pt-3.5 pb-1 flex items-center justify-between">
          <span className="text-[10px] tracking-[0.16em] text-mute/45 select-none">Workspaces</span>
          <button onClick={addProject} title="新建项目文件夹（会话与记忆存到该目录 .finalcheck/）"
            className="h-6 w-6 -mr-1 rounded-lg text-mute/55 hover:text-goldSoft hover:bg-white/[0.07] transition-colors flex items-center justify-center">
            <IconFolderPlus />
          </button>
        </div>

        {/* 工作区列表：文件夹行的箭头折叠它自己的会话；默认 5 条，多的 Show more */}
        <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          {!y && <div className="text-xs text-mute/70 px-2 py-3">浏览器直开：项目/会话不可用</div>}
          {y && booted && projects.length === 0 && <div className="text-xs text-mute/70 px-2 py-3">No workspaces yet</div>}
          {projects.map((p) => {
            const isActive = p.id === activeProjectId;
            const collapsed = !!collapsedProjects[p.id];
            const list = isActive ? sessions : [];
            const live = list.filter((x) => !x.archived);   // 归档的默认不出现（文件、历史、记忆都还在磁盘上）
            const arch = list.filter((x) => x.archived);
            const expanded = !!showAllSessions[p.id];
            const archOpen = !!showArchived[p.id];
            const shown = expanded ? live : live.slice(0, SESSION_PREVIEW);

            // 一行会话：hover 的动作是归档（不删任何数据）；归档过的行 hover 变成恢复
            const renderSessionRow = (s) => {
              const sActive = s.id === activeId && page === 'chat';
              const running = !!runningIds[s.id];
              return (
                <div key={s.id} onClick={() => openSession(s.id)}
                  onContextMenu={(e) => { e.preventDefault(); setMoveOpen(false); setRowMenu({ x: e.clientX, y: e.clientY, session: s, project: p }); }}
                  title={`${prettyTitle(s.title)} · ${new Date(s.updatedAt).toLocaleString('zh-CN')}${s.turns ? ` · ${s.turns} 轮` : ''}`}
                  className={`group relative flex items-center gap-1.5 rounded-lg pl-2 pr-1.5 py-1.5 cursor-pointer transition-colors ${s.archived ? 'opacity-45' : ''} ${
                    sActive ? 'bg-white/[0.09] text-goldSoft' : 'text-ink/85 hover:bg-white/[0.06] hover:text-ink'}`}>
                  {s.pinned ? <span className="text-goldDeep/70 text-[9px] shrink-0">▴</span> : null}
                  {/* 状态槽：跑的时候转圈，跑完才是绿点 */}
                  <span className="w-3 shrink-0 flex items-center justify-center">
                    {running
                      ? <Spinner size={13} className="text-ink/65" title="运行中" />
                      : s.unread ? <span title="已完成" className="w-1.5 h-1.5 rounded-full bg-jade" /> : null}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[12px]">{prettyTitle(s.title)}</span>
                  <span className="shrink-0 text-[10px] text-mute/60 tabular-nums group-hover:opacity-0 transition-opacity">{relTime(s.updatedAt)}</span>
                  <button title={s.archived ? '恢复会话' : '归档会话（历史与记忆保留，在 Archived 里可找回）'}
                    onClick={(e) => { e.stopPropagation(); archiveSession(s); }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-md text-mute/40 opacity-0 group-hover:opacity-100 hover:text-goldSoft hover:bg-white/[0.08] transition-opacity">
                    {s.archived ? <IconUnarchive /> : <IconArchive />}
                  </button>
                </div>
              );
            };
            return (
              <div key={p.id} className="mb-0.5">
                <div onClick={() => toggleProject(p)} title={p.path}
                  className={`group relative flex items-center gap-1 rounded-lg pl-1 pr-1.5 py-1.5 cursor-pointer transition-colors ${
                    isActive ? 'text-goldSoft bg-white/[0.045]' : 'text-ink/80 hover:bg-white/[0.05] hover:text-ink'}`}>
                  <span role="button" tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); setCollapsedProjects((s) => ({ ...s, [p.id]: !s[p.id] })); }}
                    className="shrink-0 p-0.5 rounded text-mute/45 hover:text-ink transition-colors">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                      className={`transition-transform duration-300 ${collapsed ? '-rotate-90' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
                  </span>
                  <IconFolder active={isActive} />
                  <span className={`flex-1 min-w-0 truncate text-[13px] ${isActive ? 'font-medium' : ''}`}>{p.name}</span>
                  <span className="shrink-0 text-[10px] text-mute/55 tabular-nums group-hover:opacity-0 transition-opacity">{isActive ? live.length : (p.sessionCount || 0)}</span>
                  <button title="从列表移除项目（不删磁盘目录）" onClick={(e) => { e.stopPropagation(); removeProject(p); }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-md text-mute/40 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/10 transition-opacity">
                    <IconTrash />
                  </button>
                </div>

                {!collapsed && isActive && (
                  <div className="mt-0.5 mb-1 ml-[13px] pl-2 border-l border-white/[0.06]">
                    {list.length === 0 && <div className="px-2 py-1 text-[10px] text-mute/30">No sessions</div>}
                    {shown.map((s) => renderSessionRow(s))}
                    {live.length > SESSION_PREVIEW && (
                      <button onClick={() => setShowAllSessions((v) => ({ ...v, [p.id]: !v[p.id] }))}
                        className="mt-0.5 w-full text-left px-2 py-1 rounded-lg text-[11px] text-mute/55 hover:text-goldSoft hover:bg-white/[0.045] transition-colors">
                        {expanded ? 'Show less' : 'Show more'}
                      </button>
                    )}
                    {arch.length > 0 && (
                      <>
                        <button onClick={() => setShowArchived((v) => ({ ...v, [p.id]: !v[p.id] }))}
                          className="mt-0.5 w-full text-left px-2 py-1 rounded-lg text-[11px] text-mute/45 hover:text-ink hover:bg-white/[0.045] transition-colors flex items-center gap-1.5">
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                            className={`transition-transform duration-300 ${archOpen ? '' : '-rotate-90'}`}><path d="M6 9l6 6 6-6" /></svg>
                          Archived <span className="text-mute/30 tabular-nums">{arch.length}</span>
                        </button>
                        {archOpen && arch.map((s) => renderSessionRow(s))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 底部：Settings + 连接状态点 */}
        <div className="px-2 py-2 border-t border-white/[0.06] flex items-center gap-1">
          <button onClick={() => setPage('settings')}
            className={`flex-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors ${
              page === 'settings' ? 'bg-white/[0.06] text-goldSoft' : 'text-mute hover:text-ink hover:bg-white/[0.045]'}`}>
            <IconGear active={page === 'settings'} />Settings
            {updateVersion ? (
              <span title={updateVersion ? `有新版本 v${updateVersion}` : '有新版本'}
                className="ml-auto w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
            ) : null}
          </button>
          <span title={y ? 'IPC 已连接' : 'IPC 不可用'} className={`w-1.5 h-1.5 rounded-full ${y ? 'bg-jade' : 'bg-red-400/70'}`} />
        </div>
      </aside>}

      {/* ---- 主区 + 右侧产物预览 ---- */}
      <div className="flex-1 min-w-0 flex min-h-0">
      <main className="chat-veil flex-1 min-w-0 flex flex-col">
        {!y && (
          <div className="m-4 mb-0 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-300 text-sm px-4 py-3 transition-all duration-200">
            请在 Electron 中运行：当前未检测到 window.finalcheck（浏览器直开），仅展示 UI 壳，功能不可用。
          </div>
        )}

        {page === 'chat' ? (
          <>
            {/* 顶栏：当前会话标题 */}
            <div className="shrink-0 h-10 flex items-center px-5 border-b border-edge/60">
              <span className="font-kai text-sm text-goldSoft truncate">{activeTitle || 'FinalCheck'}</span>
              {(() => { const cur = sessions.find((x) => x.id === activeId); return cur?.archived ? (
                <button onClick={() => archiveSession(cur)} title="这条会话已归档（历史和记忆都还在），点一下恢复"
                  className="ml-2 shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-mute/70 hover:text-goldSoft hover:border-gold/40 transition-colors">归档</button>
              ) : null; })()}
              {busy && <span className="ml-3 text-[11px] text-mute">思考中…</span>}
            </div>

            {showSetup && (
              <div className="shrink-0 px-5 pt-4">
                <FirstRunCard y={y} cfg={cfg} onSaved={finishSetup} onSkip={skipSetup} />
              </div>
            )}

            {hasMsgs ? (
              <div className="relative flex-1 min-h-0">
                <div ref={scrollRef} className="h-full overflow-y-auto px-5 py-4"
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                    stickRef.current = stuck;
                    if (jumpingRef.current) { if (stuck) setShowJump(false); }
                    else setShowJump(!stuck);
                  }}>
                  {/* 全宽文档式排版：消息/输入区同宽（≥90% 容器宽） */}
                  <div className="w-full max-w-[96%] mx-auto space-y-4">
                    {messages.map((m, i) => (
                    m.role === 'notice' ? (
                      <div key={i} className="flex items-center gap-3 py-1 text-[11px] text-mute/60">
                        <span className="h-px flex-1 bg-edge" />
                        <span className="max-w-[80%] text-center whitespace-pre-wrap">{m.content}</span>
                        <span className="h-px flex-1 bg-edge" />
                      </div>
                    ) : m.role === 'user' ? (() => {
                      const u = splitAttachmentBlock(m.content);
                      const wf = parseWorkflowPrompt(u.text);
                      const wfText = wf ? (`/workflow ${wf.task}`.trim()) : null;
                      // 技能段：展示时摘掉内部 read_playbook 指令，只剩 chip；复制/编辑还原成 /id token
                      const sk = parseSkillSegments(u.text);
                      const typedSk = m.pasted?.length ? parseSkillSegments(m.typed || '') : null;
                      const hasSkills = !wf && sk.skills.length > 0;
                      const restoreText = m.pasted?.length
                        ? [typedSk?.tokenText, ...(m.pasted || [])].filter((x) => String(x || '').trim()).join('\n\n')
                        : (wf ? wfText : (sk.skills.length ? sk.tokenText : u.text));
                      const keepTurns = messages.slice(0, i).filter((x) => x.role === 'user' && !x.steer).length;
                      // Steer 气泡：不是会话历史，只展示「已注入当前回合」；不给编辑/回退入口
                      if (m.steer) {
                        return (
                          <div key={i} className="flex flex-col items-start gap-1 border-l-2 border-gold/70 pl-3" data-testid="steer-bubble">
                            <div className="inline-flex items-center gap-1.5">
                              <span className="badge bg-gold/20 text-goldSoft border border-gold/50">Steer</span>
                              <span className="text-[10px] text-mute/60">已注入当前回合</span>
                            </div>
                            <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border border-gold/25 bg-gold/[0.06] px-3.5 py-2 text-sm leading-relaxed text-ink/90">
                              {m.content}
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={i} className="group flex flex-col items-end">
                          <div className={`glass-bubble max-w-[75%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm break-words leading-relaxed ${wf || m.pasted?.length || hasSkills ? '' : 'whitespace-pre-wrap'}`}>
                            {m.pasted?.length ? (
                              <div className="min-w-0">
                                {m.typed ? (typedSk.skills.length ? (
                                  <div className="min-w-0">
                                    <SkillChips skills={typedSk.skills} />
                                    {typedSk.text ? <div className="mt-2 whitespace-pre-wrap break-words">{typedSk.text}</div> : null}
                                  </div>
                                ) : <div className="whitespace-pre-wrap">{m.typed}</div>) : null}
                                {m.pasted.map((t, k) => <PastedTextBlock key={k} text={t} />)}
                              </div>
                            ) : wf ? (
                              // Workflow：金色符号 + 标题，正文另起一行；不用药丸/边框，原始指令折叠区低调内滚
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span aria-hidden="true" className="text-[12px] leading-none text-goldSoft/90 [text-shadow:0_0_10px_rgba(227,197,107,0.35)]">✦</span>
                                  <span className="font-kai text-[15px] font-semibold leading-none tracking-[0.14em] text-goldSoft">Workflow</span>
                                </div>
                                <div className="mt-2 text-[13.5px] leading-relaxed text-ink/90 break-words">{wf.task || '多 agent 并行执行'}</div>
                                {openWorkflowRaw === i ? (
                                  <div className="mt-2.5 max-h-36 overflow-y-auto border-t border-gold/15 pt-2 pr-1 text-[11px] leading-relaxed text-mute/70 whitespace-pre-wrap break-words">
                                    {u.text}
                                  </div>
                                ) : null}
                              </div>
                            ) : hasSkills ? (
                              <div className="min-w-0">
                                <SkillChips skills={sk.skills} />
                                {sk.text ? <div className="mt-2 whitespace-pre-wrap break-words">{sk.text}</div> : null}
                              </div>
                            ) : u.text}
                          </div>
                          <UserAttachments files={u.files} onOpen={openArtifact} />
                          <div className="mt-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            {wf ? (
                              <button title={openWorkflowRaw === i ? '收起原始指令' : '查看原始指令'}
                                onClick={() => setOpenWorkflowRaw((v) => (v === i ? null : i))}
                                className="p-1.5 rounded-md text-mute/55 hover:text-goldSoft hover:bg-white/5 transition-colors"><IconChevron /></button>
                            ) : null}
                            <button title="复制" onClick={() => y?.copyText?.(restoreText)}
                              className="p-1.5 rounded-md text-mute/55 hover:text-goldSoft hover:bg-white/5 transition-colors"><IconCopy /></button>
                            <button title="编辑并从这条重开"
                              onClick={() => {
                                if (m.pasted?.length) {
                                  startEdit(i, typedSk?.tokenText || m.typed || '', keepTurns, u.files);
                                  setPastedBlocks(m.pasted.map((t) => ({ id: nextPasteId(), text: t, lines: countLines(t), expanded: false })));
                                } else {
                                  startEdit(i, restoreText, keepTurns, u.files);
                                }
                              }}
                              className="p-1.5 rounded-md text-mute/55 hover:text-goldSoft hover:bg-white/5 transition-colors"><IconEdit /></button>
                          </div>
                        </div>
                      );
                    })() : (
                      /* AI 回答去气泡：无底色卡片，仅左侧金竖线（错误消息换红线）区分 */
                      <div key={i} className={`w-full border-l-2 pl-4 transition-all duration-200 ${m.error ? 'border-red-500/50' : m.interrupted ? 'border-gold/25' : 'border-gold/45'}`}>
                        <ProcessTimeline msg={m} />
                        {m.streaming && m.workflow ? <WorkflowLiveCard data={m.workflow} sessionId={activeId} providers={providers}
                          onRecover={(text) => send({ text, pasted: [] })}
                          onOpenStep={(s) => setStepView({ sessionId: activeId, stepId: s.id, name: s.name, role: s.role, kind: s.kind || null, opType: s.opType || s.op || null, key: Date.now() })} /> : null}
                        {m.interrupted && !m.error && (
                          <div className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] text-mute/80">
                            <span className="inline-block w-2.5 h-2.5 rounded-[2px] bg-gold/70" />
                            已停止 · 输出已保留
                          </div>
                        )}
                        {m.content && <div className="md text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />}
                        {m.streaming && (
                          m.startedAt
                            ? <WorkingStatus startedAt={m.startedAt} label={m.activityLabel} tone={m.activityTone || 'activity'} className="mt-2" />
                            : (
                              <span className="inline-flex gap-1 items-center h-4 mt-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-goldSoft animate-bounce" style={{ animationDelay: '0ms' }} />
                                <span className="w-1.5 h-1.5 rounded-full bg-goldSoft animate-bounce" style={{ animationDelay: '150ms' }} />
                                <span className="w-1.5 h-1.5 rounded-full bg-goldSoft animate-bounce" style={{ animationDelay: '300ms' }} />
                              </span>
                            )
                        )}
                        {m.error && (
                          <div className="text-red-300">
                            <div className="font-medium mb-1">出错了</div>
                            <div className="text-xs leading-relaxed">{m.error}</div>
                            {/* 恢复键在工作流卡片底栏（只在中断/失败时出现）；这里只留说明文字 */}
                          </div>
                        )}
                        {/* 出错的回合也可能是「工作流跑完了、总结被打断」：trace 照样要渲染（否则卡片/证据全看不到） */}
                        {!m.streaming && m.trace?.length > 0 && <TraceBlock trace={m.trace} onRecover={(text) => send({ text, pasted: [] })} onOpenStep={(s) => setStepView({ sessionId: activeId, stepId: s.id, name: s.name, role: s.role, kind: s.kind || null, opType: s.opType || s.op || null, key: Date.now() })} />}
                        <ArtifactChips artifacts={collectArtifacts(m.trace)} activePath={artifact?.path} onOpen={openArtifact} />
                      </div>
                    )
                  ))}
                  </div>
                </div>
                {/* 不在底部时：底部居中的回到底部箭头（不挡输入框、不压 WorkingStatus） */}
                {showJump && (
                  <button type="button" data-testid="scroll-bottom" onClick={jumpToBottom} title="回到底部"
                    className="absolute bottom-2 left-1/2 z-20 flex h-[30px] w-[30px] -translate-x-1/2 items-center justify-center rounded-full border border-gold/45 bg-[#141210]/80 text-goldSoft shadow-lg backdrop-blur-md transition-all duration-200 hover:border-gold hover:bg-gold/20 hover:text-ink">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
                  </button>
                )}
              </div>
            ) : (
              /* 空态：能力卡（直接对应产品功能，不硬编码路径） */
              <div className="flex-1 min-h-0 overflow-y-auto px-6">
                <div className="min-h-full flex flex-col items-center justify-center py-10">
                  <div className="font-kai text-5xl text-goldSoft mb-3 tracking-[0.04em]">FinalCheck</div>
                  <p className="text-sm text-mute mb-8 tracking-wide">体检 · 渗透 · 下载闸 · 工作流 —— 选一个，或直接说</p>
                  <div className="w-full max-w-2xl grid grid-cols-2 gap-2.5">
                    {CAPABILITIES.map((c) => {
                      const Icon = CAP_ICON[c.icon] || IconSparkle;
                      const isDemo = c.id === 'demo';
                      return (
                        <button key={c.id} onClick={() => (isDemo ? runDemoAudit() : pickSuggestion(c.prompt))}
                          disabled={isDemo && demoBusy}
                          className="glass-row group flex items-start gap-3 rounded-2xl px-4 py-3.5 text-left disabled:opacity-50">
                          <span className="mt-0.5 text-goldSoft/85 group-hover:text-goldSoft transition-colors"><Icon /></span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className="text-[13px] text-ink/90">{c.title}</span>
                              <span className="text-[10px] font-mono text-mute/40">{c.en}</span>
                            </span>
                            <span className="mt-1 block text-[11px] leading-relaxed text-mute/80">
                              {isDemo && demoBusy ? '体检中…示例项目 L2 正在跑' : c.desc}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* 输入区（与消息区同宽） */}
            <div className="shrink-0 px-5 pb-3 pt-1">
              <div className="w-full max-w-[96%] mx-auto">
                {/* 权限确认条：agent 请求执行敏感操作（run_command）时弹出，三选一回传主进程 */}
                {approval && (
                  <div data-testid="approval-bar"
                    className="mb-2.5 rounded-xl border border-gold/50 bg-gold/10 px-4 py-3 animate-[fadeIn_.2s_ease]">
                    <div className="flex items-center gap-2 text-xs font-medium text-goldSoft">
                      <IconShield />
                      <span>Agent 请求{approval.tool === 'edit_file' ? '修改文件' : approval.tool === 'write_file' ? '写入文件' : '执行命令'}，需要你的授权</span>
                      <span className="ml-auto text-[11px] font-normal text-mute/70">120 秒内未处理将自动拒绝</span>
                    </div>
                    <div data-testid="approval-summary"
                      className="glass-card mt-2 rounded-xl px-3 py-2 font-mono text-xs text-ink/90 break-all whitespace-pre-wrap max-h-28 overflow-y-auto">
                      {approval.summary || '(空命令)'}
                    </div>
                    <div className="mt-2.5 flex items-center gap-2">
                      <button data-testid="approval-allow-once" onClick={() => decideApproval('allowed-once')}
                        className="btn-primary px-3 py-1.5 text-xs">允许一次</button>
                      <button data-testid="approval-allow-session" onClick={() => decideApproval('always-session')}
                        className="btn-ghost px-3 py-1.5 text-xs !text-goldSoft !border-gold/40 hover:!bg-gold/10">本会话总是允许</button>
                      <button data-testid="approval-reject" onClick={() => decideApproval('rejected')}
                        className="ml-auto rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10 transition-all duration-200">拒绝</button>
                    </div>
                  </div>
                )}
                {/* 排队卡片（当前回合进行中还能继续发消息）：FIFO，回合结束后自动发队首 */}
                {queueItems.length > 0 && (
                  <div className="mb-2.5 space-y-1.5" data-testid="queue-list">
                    <div className="flex items-center gap-2 px-1">
                      <span className="badge bg-gold/15 text-goldSoft border border-gold/35">排队 {queueItems.length}</span>
                      <span className="text-[10px] text-mute/55">当前回合结束后自动发送（Steer 可注入本回合）</span>
                    </div>
                    {queueItems.map((item, idx) => (
                      <div key={item.id} data-testid="queue-item"
                        className="glass-card flex items-center gap-2 rounded-xl border border-gold/20 px-3 py-2">
                        <span className="shrink-0 font-mono text-[10px] text-goldSoft/60">{idx + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-ink/85"
                          title={[item.text, ...(item.pasted || [])].filter(Boolean).join('\n\n') || 'Pasted text'}>
                          {item.text || (item.pasted?.length
                            ? `Pasted text · ${item.pasted.reduce((n, t) => n + countLines(t), 0)} 行`
                            : '(空)')}
                        </span>
                        {item.previews?.length ? <span className="shrink-0 text-[10px] text-mute/50">附件 {item.previews.length}</span> : null}
                        <button type="button" data-testid="queue-steer" onClick={() => steerQueueItem(item)}
                          title={busy && !stopping ? '注入当前回合（下一次模型请求前生效）' : '当前回合未在运行，无法 Steer'}
                          className="shrink-0 rounded-md border border-gold/40 px-2 py-0.5 text-[10px] text-goldSoft hover:bg-gold/15 transition-colors">Steer</button>
                        <button type="button" data-testid="queue-edit" onClick={() => moveQueueItemToInput(item.id)}
                          title="取回编辑（从队列移除，内容放回输入框）"
                          className="shrink-0 rounded-md p-1 text-mute/55 hover:text-goldSoft hover:bg-white/5 transition-colors">
                          <IconEdit />
                        </button>
                        <button type="button" data-testid="queue-remove" onClick={() => removeQueueItem(item.id)}
                          title="移除此条"
                          className="shrink-0 rounded-md p-1 text-mute/55 hover:text-red-300 hover:bg-red-500/10 transition-colors">
                          <IconTrash />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div
                  className={`glass-composer relative z-30 rounded-[20px] ${dragging ? 'fc-drag' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={async (e) => { e.preventDefault(); setDragging(false); await addFiles(e.dataTransfer?.files); }}
                >
                  {editing && (
                    <div className="flex items-center gap-2 px-3 pt-2.5 text-[11px]">
                      <span className="badge bg-gold/15 text-goldSoft border border-gold/35">编辑中</span>
                      <span className="text-mute/60">发送后将从这条消息重开，后面的对话会被丢弃</span>
                      <button onClick={cancelEdit} className="ml-auto text-mute/60 hover:text-ink transition-colors">取消</button>
                    </div>
                  )}
                  {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                      {attachments.map((a, i) => (
                        <AttachmentChip key={a.path} item={a} onRemove={() => removeAttachment(i)} />
                      ))}
                    </div>
                  )}
                  {/* 长粘贴：收成「Pasted text」卡片（默认折叠，点击展开纯文本全文） */}
                  {pastedBlocks.length > 0 && (
                    <div className="space-y-1.5 px-3 pt-2.5">
                      {pastedBlocks.map((b) => (
                        <div key={b.id} data-testid="pasted-card"
                          className="overflow-hidden rounded-xl border border-edge bg-white/[0.035]">
                          <div role="button" tabIndex={0}
                            onClick={() => togglePasted(b.id)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePasted(b.id); } }}
                            title={b.expanded ? '收起粘贴文本' : '展开粘贴文本'}
                            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer hover:bg-white/5 transition-colors">
                            <IconPaste />
                            <span className="shrink-0 text-[11px] text-goldSoft">Pasted text</span>
                            <span className="shrink-0 text-[10px] text-mute/55">{b.lines} 行</span>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-mute/70">{b.text.split('\n')[0]}</span>
                            <button type="button" title="删除粘贴文本"
                              onClick={(e) => { e.stopPropagation(); removePasted(b.id); }}
                              className="shrink-0 rounded-md p-1 text-mute/45 hover:text-red-300 hover:bg-red-500/10 transition-colors">
                              <IconTrash />
                            </button>
                            <span className={`shrink-0 text-[10px] text-mute/40 transition-transform duration-200 ${b.expanded ? 'rotate-180' : ''}`}>▾</span>
                          </div>
                          {b.expanded && (
                            <pre data-testid="pasted-text-full"
                              className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words border-t border-edge bg-[#0a0a0c] px-3 py-2 font-mono text-[12px] leading-6 text-ink/80">
                              {b.text}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="px-3.5 pt-3">
                    <textarea
                      ref={inputRef}
                      rows={1}
                      value={input}
                      onChange={(e) => {
                        setInput(e.target.value);
                        e.target.style.height = 'auto';
                        e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
                      }}
                      onPaste={(e) => {
                        const files = Array.from(e.clipboardData?.files || []);
                        if (files.length) { e.preventDefault(); addFiles(files); return; }
                        // 长文本不直接塞进输入框：收成「Pasted text」卡片（短文本保持原样粘贴）
                        const pasted = e.clipboardData?.getData('text/plain') || '';
                        if (isLongPaste(pasted)) { e.preventDefault(); addPastedBlock(pasted); }
                      }}
                      onKeyDown={onComposerKeyDown}
                      placeholder={y ? (busy ? '输入消息排队，回合结束后自动发送（Enter 入队）…' : '输入消息，/ 唤起技能，Enter 发送…') : 'IPC 不可用（浏览器直开）'}
                      disabled={!y}
                      className="w-full bg-transparent outline-none resize-none text-sm leading-6 placeholder:text-mute/45 disabled:opacity-50"
                    />
                  </div>

                  {/* 底部工具条：只有图标与文字，没有边框（对齐 ZCode） */}
                  <div className="flex items-center gap-0.5 px-2 pb-2">
                    <button onClick={pickAttachFiles} title="添加文件（也可直接粘贴截图 / 拖拽文件）"
                      className="shrink-0 h-7 w-7 rounded-lg text-mute/70 hover:text-goldSoft hover:bg-white/[0.06] transition-colors flex items-center justify-center">
                      <IconPlus />
                    </button>
                    <div className="relative">
                      <button onClick={() => setMenu(menu === 'perm' ? null : 'perm')}
                        className={`inline-flex items-center gap-1.5 text-[11px] rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.06] ${permMode === 'full' ? 'text-goldSoft' : 'text-mute hover:text-ink'}`}>
                        <IconShield />
                        {permMode === 'full' ? '完全权限' : '标准审批'}
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
                      </button>
                      {menu === 'perm' && (
                        <div className="glass-pop absolute bottom-full mb-1.5 left-0 w-60 rounded-2xl p-1.5 z-40">
                          <button onClick={() => changeMode('ask')} className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors text-xs ${permMode === 'ask' ? 'bg-gold/10 text-goldSoft' : 'hover:bg-white/5'}`}>
                            标准审批<span className="block text-[10px] text-mute mt-0.5">执行命令前每次确认（默认）</span>
                          </button>
                          <button onClick={() => changeMode('full')} className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors text-xs ${permMode === 'full' ? 'bg-gold/10 text-goldSoft' : 'hover:bg-white/5'}`}>
                            完全权限<span className="block text-[10px] text-mute mt-0.5">不再询问；灾难命令仍会被拦截</span>
                          </button>
                        </div>
                      )}
                    </div>

                    <span className="text-[10px] text-mute/35 select-none pl-1">{compacting ? '压缩中…' : '输入 / 选技能'}</span>

                    <div className="ml-auto flex items-center gap-1.5">
                      <div className="relative">
                        <button
                          onMouseEnter={() => setMenu('context')}
                          onMouseLeave={() => setMenu((m) => (m === 'context' ? null : m))}
                          onClick={() => setMenu(menu === 'context' ? null : 'context')}
                          title="上下文使用情况"
                          className="p-1 rounded-full hover:bg-white/5 transition-colors">
                          <ContextRing percent={ctxStats?.measured?.prompt ? Math.min(100, (ctxStats.measured.prompt / ctxStats.window) * 100) : (ctxStats?.percent || 0)} />
                        </button>
                        {menu === 'context' && (
                          <div onMouseEnter={() => setMenu('context')} onMouseLeave={() => setMenu((m) => (m === 'context' ? null : m))}
                            className="glass-pop absolute bottom-full mb-2 right-0 w-[352px] rounded-2xl p-3 z-50">
                            {(() => {
                              // 实测 = 服务端 usage.prompt_tokens（本轮最后一次请求，含工具输出）；估算 = 下一轮会发出去的内容
                              const measured = ctxStats?.measured || null;
                              const pct = measured?.prompt ? Math.min(100, (measured.prompt / ctxStats.window) * 100) : (ctxStats?.percent || 0);
                              const shownTokens = measured?.prompt || ctxStats?.used || 0;
                              return (
                                <>
                                  <div className="flex items-baseline justify-between">
                                    <span className="text-xs text-ink/85">Context windows</span>
                                    <span className="text-[11px] font-mono text-mute/60">
                                      {ctxStats ? `${fmtTokens(shownTokens)}/${fmtTokens(ctxStats.window)}` : '—'}
                                    </span>
                                  </div>
                                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-mute/60">
                                    {measured?.prompt ? (
                                      <>
                                        <span>实测 {pct.toFixed(1)}%</span>
                                        <span className="text-mute/25">·</span>
                                        <span className="text-mute/45">下一轮估算 {fmtTokens(ctxStats.used)}（{ctxStats.percent.toFixed(1)}%）</span>
                                      </>
                                    ) : (
                                      <span>估算 {pct.toFixed(1)}%（下一轮请求）{busy ? ' · 本轮进行中，暂无实测' : ''}</span>
                                    )}
                                  </div>
                                  <div className="mt-1.5 h-1.5 rounded-full bg-white/10 overflow-hidden">
                                    <div className="h-full rounded-full bg-goldSoft transition-all duration-300" style={{ width: `${pct}%` }} />
                                  </div>
                                  <div className="mt-1 text-[10px] leading-relaxed text-mute/40">
                                    {measured?.prompt ? '实测＝本轮最后一次请求（含工具输出）；估算只算下一轮要发的内容（不含历史工具输出）' : '估算＝下一轮要发的内容（不含历史工具输出）'}
                                  </div>
                                </>
                              );
                            })()}
                            <div className="mt-2.5 mb-1 text-[10px] text-mute/40">下一轮构成（按估算）</div>
                            <div className="space-y-1.5">
                              {[
                                ['Messages', 'messages', 'bg-goldSoft'],
                                ['System tools', 'systemTools', 'bg-[#7aa2ff]'],
                                ['MCP tools', 'mcpTools', 'bg-[#9b8cff]'],
                                ['Meta context', 'metaContext', 'bg-[#6fd3c7]'],
                                ['Skills', 'skills', 'bg-[#c6d36f]'],
                                ['System prompt', 'systemPrompt', 'bg-[#d38f6f]']
                              ].map(([label, key, color]) => {
                                const v = ctxStats?.breakdown?.[key] || 0;
                                const pct = ctxStats?.used ? (v / ctxStats.used) * 100 : 0;
                                return (
                                  <div key={key} className="flex items-center gap-2 text-[11px]">
                                    <span className={`w-2 h-2 rounded-full ${color}`} />
                                    <span className="text-mute/70">{label}</span>
                                    <span className="ml-auto font-mono text-mute/50">{pct.toFixed(1)}%</span>
                                  </div>
                                );
                              })}
                            </div>
                            <div className="mt-2.5 pt-2 border-t border-edge/70 flex items-center justify-between text-[11px]">
                              <span className="text-mute/60">Last request cache hit</span>
                              <span className="font-mono text-mute/70">{ctxStats?.cacheHit != null ? `${ctxStats.cacheHit.toFixed(1)}%` : '—（网关未返回缓存字段）'}</span>
                            </div>
                            <div className="mt-1.5 text-[10px] text-mute/35 leading-relaxed">估算口径：CJK 1 字≈1 token、4 字符≈1 token；上下文上限在模型设置里改。</div>
                          </div>
                        )}
                      </div>
                      <div className="relative" ref={modelMenuRef}>
                        <button onClick={() => { setMenu(menu === 'model' ? null : 'model'); setProviderMenu(false); }}
                          className="inline-flex items-center gap-1.5 max-w-[280px] text-[11px] px-1 py-1 text-mute hover:text-goldSoft transition-colors duration-200">
                          <span className="truncate">{activeModel || '未配置模型'}</span>
                          <span className="text-mute/45">{effortLabel}</span>
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                        {menu === 'model' && (
                          <div className="glass-pop absolute bottom-full mb-2 right-0 w-[300px] rounded-2xl z-50 pop-in">
                            {/* 供应商头：点一下切到供应商列表 */}
                            <button onClick={() => setProviderMenu(!providerMenu)}
                              className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-white/5 transition-colors text-left">
                              <span className="w-5 h-5 rounded-md bg-gold/15 border border-gold/40 flex items-center justify-center text-[11px] text-goldSoft">⌬</span>
                              <span className="text-[13px] text-ink/90 truncate">{activeProv?.name || '未配置供应商'}</span>
                              <span className="text-[9px] px-1 py-0.5 rounded border border-edge text-mute/55">API</span>
                              <svg className="ml-auto shrink-0 text-mute/50" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
                            </button>

                            <div className="px-3 pt-2 pb-1 text-[10px] text-mute/50">Models</div>
                            <div className="max-h-56 overflow-y-auto px-1.5 pb-1">
                              {activeModelEntries.map((m) => (
                                <button key={m.id} onClick={() => chooseModel(activeProv.id, m.id)}
                                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-mono transition-colors ${m.id === activeModel ? 'bg-white/[0.06] text-ink' : 'text-ink/75 hover:bg-white/5'}`}>
                                  <span className="truncate">{m.id}</span>
                                  {(m.vision || /vision|vl\b/i.test(m.id)) ? <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-edge text-mute/60 font-sans shrink-0">Vision</span> : null}
                                  {m.id === activeModel ? <span className="ml-auto text-jade shrink-0">✓</span> : null}
                                </button>
                              ))}
                              {activeModelEntries.length === 0 && (
                                <div className="px-2.5 py-3 text-[11px] text-mute">
                                  该供应商还没有模型
                                  <button onClick={() => { setMenu(null); setPage('settings'); }} className="ml-2 text-goldSoft hover:underline underline-offset-2">去添加</button>
                                </div>
                              )}
                            </div>
                            <div className="border-t border-edge/70 px-3 py-2.5">
                              <div className="flex items-center gap-2 text-[11px]">
                                <span className="text-mute">Effort</span>
                                <span className="text-ink/85">{effortLabel}</span>
                                <span className="ml-auto text-[10px] text-mute/40">Ctrl+T</span>
                              </div>
                              <input type="range" min="0" max="4" step="0.01" value={sliderPos}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  setEffortPos(v);
                                  const lvl = EFFORTS[Math.round(v)]?.v;
                                  if (lvl && lvl !== effort) chooseEffort(lvl, { close: false });
                                }}
                                onMouseUp={() => setEffortPos(null)}
                                onTouchEnd={() => setEffortPos(null)}
                                className="effort-slider w-full mt-2" />
                            </div>

                            {/* 供应商列表：浮在面板左侧，切换不用跳去模型设置 */}
                            {providerMenu && (
                              <div className="glass-pop absolute right-full top-0 mr-2 w-56 rounded-2xl p-1.5 z-[60] pop-in">
                                <div className="px-2.5 py-1.5 text-[10px] text-mute/50">供应商（{providers.length}）</div>
                                {providers.length === 0 && <div className="px-2.5 py-3 text-[11px] text-mute">还没有供应商，请到「模型设置」添加</div>}
                                {providers.map((p) => (
                                  <button key={p.id} onClick={() => pickProvider(p)}
                                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs transition-colors ${p.id === activeProv?.id ? 'bg-white/[0.06] text-ink' : 'text-ink/75 hover:bg-white/5'}`}>
                                    <span className="truncate">{p.name}</span>
                                    <span className="text-[9px] px-1 py-0.5 rounded border border-edge text-mute/50">API</span>
                                    {(p.models || []).length === 0 ? <span className="text-[9px] text-amber-400/80">无模型</span> : null}
                                    {p.id === activeProv?.id ? <span className="ml-auto text-jade">✓</span> : null}
                                  </button>
                                ))}
                                <button onClick={() => { setMenu(null); setPage('settings'); }}
                                  className="w-full text-left px-2.5 py-2 mt-1 rounded-lg text-xs text-mute hover:text-goldSoft hover:bg-white/5 border-t border-edge/60">
                                  Manage models
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {/* 发送键：金色方块（busy 时变成停止 + 可选「排队发送」；已点停止则变为「停止中…」且禁用重复点击） */}
                    {busy || stopping ? (
                      <>
                        {/* 注意：这里必须转布尔。input 为空时 ('' || 0) 是数字 0，
                            React 的 {0 && <x/>} 会把「0」当成文本渲染出来（就是那个多余的 0） */}
                        {!!(input.trim() || pastedBlocks.length) && (
                          <button onClick={() => send()} data-testid="queue-send"
                            title="排队发送（当前回合结束后自动发送）"
                            className="ml-1.5 shrink-0 h-7 w-7 rounded-[9px] flex items-center justify-center border border-gold/45 text-goldSoft hover:bg-gold/15 transition-colors duration-200">
                            <IconSend />
                          </button>
                        )}
                        <button onClick={stop} disabled={stopping} title={stopping ? '正在中断，请稍候' : '停止本回合'}
                          className={`ml-1.5 shrink-0 h-7 rounded-[9px] flex items-center justify-center gap-1 transition-colors duration-200 ${stopping ? 'px-2 bg-gold/60 text-[#0a0a0c] cursor-not-allowed' : 'w-7 bg-gold hover:bg-goldSoft text-[#0a0a0c]'}`}>
                          {stopping ? (
                            <>
                              <svg className="animate-spin" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 4" /></svg>
                              <span className="text-[10px] font-medium leading-none">停止中…</span>
                            </>
                          ) : (
                            <svg width="10" height="10" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="2" fill="currentColor" /></svg>
                          )}
                        </button>
                      </>
                    ) : (
                      <button onClick={() => send()} disabled={!y || (!input.trim() && !pastedBlocks.length)} title="发送"
                        className="ml-1.5 shrink-0 h-7 w-7 rounded-[9px] flex items-center justify-center bg-gold text-[#141008] hover:bg-goldSoft disabled:opacity-60 transition-colors duration-200">
                        <IconSend />
                      </button>
                    )}
                  </div>

                  {/* / 技能菜单（命令 + 40 类方法论） */}
                  {slashOpen && (
                    <div className="glass-pop absolute bottom-full mb-2 left-0 right-0 rounded-2xl overflow-hidden z-50 pop-in">
                      <div className="max-h-80 overflow-y-auto p-1.5">
                        {slashItems.length === 0 ? (
                          <div className="px-3 py-4 text-[11px] text-mute">没有匹配的命令或技能</div>
                        ) : slashItems.map((item, idx) => (
                          <button key={item.type + item.id}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => chooseSlash(item)}
                            onMouseEnter={() => setSlashIndex(idx)}
                            className={`w-full flex items-center gap-2 px-2.5 py-[7px] rounded-lg transition-colors ${idx === Math.min(slashIndex, slashItems.length - 1) ? 'bg-gold/12' : 'hover:bg-white/5'}`}>
                            <span className={`shrink-0 font-mono text-[12px] ${item.type === 'command' ? 'text-goldSoft' : 'text-jade'}`}>/{item.name}</span>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-ink/70">{item.cn}</span>
                            <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-full ${item.type === 'command' ? 'text-goldDeep/80 bg-gold/10' : 'text-mute/50 bg-white/[0.05]'}`}>
                              {item.type === 'command' ? '命令' : '技能'}
                            </span>
                          </button>
                        ))}
                        <div className="px-3 py-1.5 text-[10px] text-mute/35 border-t border-white/[0.06] mt-1">
                          ↑↓ 选择 · Enter 确认 · Esc 关闭
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
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
      {/* 会话右键菜单（ZCode 式） */}
      {rowMenu && (
        <div className="fixed inset-0 z-[60]" onClick={() => { setRowMenu(null); setMoveOpen(false); }} onContextMenu={(e) => { e.preventDefault(); setRowMenu(null); }}>
          <div ref={rowMenuRef} className="glass-pop absolute w-56 rounded-2xl py-1 text-[12px]"
            style={{ left: Math.min(rowMenu.x, (window.innerWidth || 1200) - 250), top: Math.min(rowMenu.y, (window.innerHeight || 800) - 430) }}
            onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setMoveOpen((v) => !v)} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5 flex items-center">
              Move to group <span className="ml-auto text-mute/50">▸</span>
            </button>
            {moveOpen && (
              <div className="mx-2 mb-1 border-l border-edge pl-1">
                {projects.filter((x) => x.id !== rowMenu.project.id).map((x) => (
                  <button key={x.id} onClick={() => moveSession(rowMenu.session, x.id)}
                    className="w-full text-left px-2 py-1 rounded-md text-[11px] text-mute hover:text-goldSoft hover:bg-white/5 truncate">{x.name}</button>
                ))}
                {projects.length < 2 && <div className="px-2 py-1 text-[10px] text-mute/40">只有当前项目</div>}
              </div>
            )}
            <button onClick={() => patchFlags(rowMenu.session, { pinned: !rowMenu.session.pinned })} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">{rowMenu.session.pinned ? 'Unpin task' : 'Pin task'}</button>
            <button onClick={() => { setRenameBox({ session: rowMenu.session, value: rowMenu.session.title }); setRowMenu(null); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Rename task</button>
            <button onClick={() => patchFlags(rowMenu.session, { archived: !rowMenu.session.archived })} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">{rowMenu.session.archived ? 'Unarchive task' : 'Archive task'}</button>
            <button onClick={() => { const s = rowMenu.session; setRowMenu(null); removeSession(s); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-red-300 hover:bg-red-500/10">Delete task（不可恢复）</button>
            <button onClick={() => patchFlags(rowMenu.session, { unread: true })} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Mark as unread</button>
            <div className="my-1 border-t border-edge/70" />
            <button onClick={() => { y?.artifactOpen?.(rowMenu.project.path); setRowMenu(null); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Open in File Explorer</button>
            <button onClick={() => { copyText(rowMenu.project.path); setRowMenu(null); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Copy path</button>
            <button onClick={() => { copyText(rowMenu.session.path || ''); setRowMenu(null); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Copy task path</button>
            <button onClick={() => { copyText(rowMenu.session.path || ''); setRowMenu(null); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Copy log path</button>
            <button onClick={() => { copyText(rowMenu.session.id); setRowMenu(null); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Copy session ID</button>
            <div className="my-1 border-t border-edge/70" />
            <button onClick={() => { setRowMenu(null); setPage('settings'); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Go to config</button>
            <button onClick={() => { const s = rowMenu.session; setRowMenu(null); if (s.path) openArtifact(s.path); }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">View model trajectory</button>
            <button onClick={() => {
              copyText(`FinalCheck 问题反馈\n项目: ${rowMenu.project.path}\n会话: ${rowMenu.session.title}\n会话文件: ${rowMenu.session.path}\n模型: ${activeModel}\n上下文: ${ctxStats ? `${fmtTokens(ctxStats.used)}/${fmtTokens(ctxStats.window)}` : '—'}`);
              setRowMenu(null);
              setMessages((prev) => [...prev, { role: 'notice', content: '已复制诊断信息，可粘贴到反馈里。' }]);
            }} className="w-full text-left px-3 py-1.5 text-mute hover:text-ink hover:bg-white/5">Report issue</button>
          </div>
        </div>
      )}

      {/* 重命名会话 */}
      {renameBox && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" onClick={() => setRenameBox(null)}>
          <div className="glass-pop w-[380px] rounded-2xl p-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm text-goldSoft mb-2">重命名会话</div>
            <input autoFocus value={renameBox.value}
              onChange={(e) => setRenameBox({ ...renameBox, value: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveRename(); } if (e.key === 'Escape') setRenameBox(null); }}
              className="input w-full" />
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setRenameBox(null)} className="btn-ghost px-3 py-1.5 text-xs">取消</button>
              <button onClick={saveRename} className="btn-primary px-3 py-1.5 text-xs">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 自定义黑金确认框 */}
      {confirmBox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px]" onClick={() => confirmBox.resolve(false)}>
          <div className="glass-pop w-[380px] rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="font-kai text-goldSoft text-base tracking-wider">确认操作</div>
            <div className="mt-2.5 text-sm text-ink/90 leading-relaxed">{confirmBox.text}</div>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => confirmBox.resolve(false)} className="btn-ghost px-3.5 py-1.5 text-xs">取消</button>
              <button onClick={() => confirmBox.resolve(true)} className="rounded-lg bg-red-500/90 hover:bg-red-500 px-3.5 py-1.5 text-xs text-white transition-colors">确定删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- 首次使用向导：没有可用供应商时显示一张卡片，填 Base URL / Key / 模型即可开始 ---- */
export function FirstRunCard({ y, cfg, onSaved, onSkip }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [name, setName] = useState('My Provider');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testRes, setTestRes] = useState(null);
  const [err, setErr] = useState('');
  const canSubmit = !!(baseUrl.trim() && apiKey.trim() && model.trim());

  const test = async () => {
    if (!canSubmit || testing) return;
    if (!y?.testProvider) { setTestRes({ ok: false, reason: '当前版本没有 testProvider IPC' }); return; }
    setTesting(true);
    setTestRes(null);
    try {
      const r = await y.testProvider({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() });
      setTestRes(r && typeof r === 'object' ? r : { ok: false, reason: '测试接口没有返回结果' });
    } catch (e) {
      setTestRes({ ok: false, reason: e?.message || String(e) });
    } finally { setTesting(false); }
  };

  const save = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    setErr('');
    try {
      if (!y?.setConfig) throw new Error('当前版本不能写入配置（请在 Electron 中运行）');
      const cur = (await y.getConfig?.()) || cfg || {};
      const providers = Array.isArray(cur.providers) ? [...cur.providers] : [];
      const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const provider = {
        id,
        name: name.trim() || 'My Provider',
        baseUrl: baseUrl.trim(),
        apiFormat: 'chat-completions',
        apiKey: apiKey.trim(),
        models: [model.trim()],
        contextWindow: 1000000,
        enabled: true
      };
      const next = { ...cur, providers: [...providers, provider], activeProviderId: id, activeModel: model.trim() };
      await y.setConfig(next);
      onSaved?.(next, provider);
    } catch (e) {
      setErr('保存失败：' + (e?.message || '请检查配置是否可写'));
    } finally { setSaving(false); }
  };

  return (
    <div className="glass-card max-w-3xl mx-auto rounded-2xl border border-gold/30 px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 h-9 w-9 rounded-xl bg-gold/10 border border-gold/35 flex items-center justify-center text-goldSoft shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] tracking-[0.18em] uppercase text-goldDeep">首次使用</span>
            <span className="h-px flex-1 bg-gold/20" />
          </div>
          <div className="mt-1 font-kai text-base text-goldSoft tracking-wider">连接 OpenAI 兼容网关</div>
          <p className="mt-1 text-[11px] text-mute leading-relaxed">
            FinalCheck 需要连接一个 OpenAI 兼容网关（Base URL + API Key + 模型名）才能对话、跑体检和工作流。Key 只存本机 config.json。
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="sm:col-span-2 block">
          <span className="mb-1 block text-[11px] text-mute">Base URL</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={saving}
            placeholder="https://api.example.com/v1" autoFocus
            className="input font-mono" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-mute">API Key</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={saving}
            placeholder="sk-…" autoComplete="new-password" className="input font-mono" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-mute">模型名</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} disabled={saving}
            placeholder="glm-4.6 / deepseek-v4.1-flash"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
            className="input font-mono" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[11px] text-mute">供应商名称 <span className="text-mute/45">（可选）</span></span>
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={saving}
            placeholder="My Provider" className="input" />
        </label>
      </div>

      {testRes && (testRes.ok ? (
        <div className="mt-3 rounded-xl border border-jade/40 bg-jade/10 px-3.5 py-2.5 text-[11px] text-jade">
          已连通 · 模型已回复
          {testRes.reply ? <span className="ml-2 text-ink/75">“{String(testRes.reply).slice(0, 120)}”</span> : null}
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-[11px] text-red-300">
          连接失败：{testRes.reason || '未知原因'}
          {testRes.hint ? <span className="mt-1 block text-mute">{testRes.hint}</span> : null}
        </div>
      ))}
      {err && <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-[11px] text-red-300">{err}</div>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={test} disabled={!canSubmit || testing || saving} className="btn-ghost text-xs px-3 py-1.5">
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button onClick={save} disabled={!canSubmit || saving || testing} className="btn-primary text-xs px-3.5 py-1.5">
          {saving ? '保存中…' : '保存并开始'}
        </button>
        <button onClick={onSkip} disabled={saving} className="ml-auto text-[11px] text-mute/55 hover:text-ink transition-colors px-2 py-1">
          稍后配置
        </button>
      </div>
    </div>
  );
}

/* ---- 品牌标：assets/logo.png 存在则用图，加载失败回退「检」字金印 ---- */
// 会话「正在跑」的转圈（苹果式 8 段 spinner）
function Spinner({ size = 11, className = '', ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`fc-spin ${className}`} aria-hidden="true" {...rest}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <rect key={i} x="11" y="2.4" width="2" height="5.6" rx="1" fill="currentColor"
          opacity={0.15 + i * 0.106} transform={`rotate(${i * 45} 12 12)`} />
      ))}
    </svg>
  );
}

// 新建会话：圆圈加号（ZCode 的 New Session 图标）
function IconPlusCircle() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

// 添加项目文件夹：方框 + 右上角加号（对齐 ZCode workspace 图标）
function IconFolderPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5.5" />
      <path d="M18 3v6M15 6h6" />
    </svg>
  );
}

/* ---- 内联图标（stroke 继承 currentColor） ---- */
function IconPlus() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// 上下文用量：只有一个小圆圈（hover 看明细）；颜色按占用率变化
function ContextRing({ percent = 0 }) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const r = 7.5;
  const c = 2 * Math.PI * r;
  const color = p >= 85 ? '#f87171' : p >= 60 ? '#fbbf24' : '#34d399';
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="block">
      <circle cx="10" cy="10" r={r} fill="none" stroke="#3a3a42" strokeWidth="2.5" />
      <circle cx="10" cy="10" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${Math.max(0.6, (p / 100) * c)} ${c}`} transform="rotate(-90 10 10)" />
    </svg>
  );
}

function IconCopy() {  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function IconChevron() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function IconFolder({ active }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 ${active ? 'text-goldSoft' : 'text-mute/60'}`}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}
function IconArchive() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" rx="1" />
      <polyline points="10 12.5 12 14.5 14 12.5" />
    </svg>
  );
}
function IconUnarchive() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" rx="1" />
      <path d="M12 18.5v-6" />
      <polyline points="9.5 15 12 12.5 14.5 15" />
    </svg>
  );
}
// 粘贴文本块图标（剪贴板）：小号、灰色，不抢金色语义
function IconPaste() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0 text-mute/55">
      <rect x="8" y="3" width="8" height="3" rx="1" />
      <path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
      <path d="M8 11h8M8 15h5" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" /><path d="M14 11v6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
function IconSparkle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="text-goldSoft shrink-0">
      <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  );
}
function IconShield() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z" />
      <polyline points="9 11.5 11.2 13.7 15.5 9.5" />
    </svg>
  );
}
function IconSend() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19.5V5" /><path d="M5.8 11.2 12 5l6.2 6.2" />
    </svg>
  );
}
function IconRadar() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 12l6.5-6.5" /><circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}
function IconDownload() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v11" /><path d="M7.5 10.5 12 15l4.5-4.5" /><path d="M4 19h16" />
    </svg>
  );
}
function IconFlow() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" />
      <path d="M9 6h4a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" /><path d="M6 9v6a2 2 0 0 0 2 2h4" />
    </svg>
  );
}
function IconReport() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5" /><path d="M8.5 13h7M8.5 17h5" />
    </svg>
  );
}
function IconTerminal() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7 9.5l3 2.5-3 2.5" /><path d="M13 15h4" />
    </svg>
  );
}
function IconPlay() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4.5v15l11-7.5z" />
    </svg>
  );
}
function IconGear({ active }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={active ? 'text-goldSoft' : ''}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
