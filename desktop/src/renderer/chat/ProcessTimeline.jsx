// coding agent 式「过程时间线」：Working 计时 + Thought 闪出 + 具体工具条目 + 完成折叠（墨黑鎏金主题）
// 数据来源：实时 = window.finalcheck.onAgentEvent 事件流（applyAgentEvent 归约到流式消息上）；
//          历史 = msg.trace / msg.reasoning（落盘无耗时，合成条目）。
import React, { useEffect, useState } from 'react';
import { CommandDetail, GenericToolDetail, BODY_CARD_TOOLS } from './TraceCards.jsx';
import { humanizeToolError, summarizeToolArgs } from '../lib/humanize.js';
import { iconFor, IconBrain } from './ToolIcons.jsx';
import { DEFAULT_WORKING_LABEL, retryLabel } from './activity.mjs';
import { t } from '../i18n/core.mjs';

// 时长进位：60s → 1m，60m → 1h（不再出现 Working 152s / 3900s）
const fmtDur = (ms) => {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
};
const fmtToolMs = (ms) => ((ms ?? 0) < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtThought = (ms) => {
  const s = Math.max(0, (ms || 0) / 1000);
  if (s < 0.05) return '0s';
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
};

const parseArgs = (v) => {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return {}; }
};
const splitPath = (p) => {
  const n = String(p || '').replace(/\\/g, '/');
  const i = n.lastIndexOf('/');
  return i >= 0 ? { file: n.slice(i + 1), dir: n.slice(0, i) } : { file: n, dir: '' };
};
const oneLine = (s, max = 220) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > max ? str.slice(0, max) + '…' : str;
};

/* ---------- 事件归约 ---------- */
function finalizeThought(events, at = Date.now()) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'thought' || !e.live) continue;
    const ms = e.startedAt ? Math.max(0, at - e.startedAt) : 0;
    if (!String(e.text || '').trim() && ms < 400) events.splice(i, 1);
    else events[i] = { ...e, live: false, ms };
  }
}

/** agent 事件 → 流式 assistant 消息 reducer（App 的 onAgentEvent 回调里调用） */
export function applyAgentEvent(msg, ev) {
  if (!msg || !ev?.kind) return msg;
  const events = [...(msg.events || [])];
  switch (ev.kind) {
    case 'turn-start':
      return { ...msg, startedAt: ev.at || Date.now() };
    case 'phase': {
      if (ev.name === 'thinking' && !events.some((e) => e.type === 'thought' && e.live)) {
        events.push({ type: 'thought', text: '', startedAt: Date.now(), live: true });
      }
      return { ...msg, events };
    }
    case 'reasoning': {
      let idx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'thought' && events[i].live) { idx = i; break; }
      }
      if (idx >= 0) events[idx] = { ...events[idx], text: (events[idx].text || '') + (ev.text || '') };
      else events.push({ type: 'thought', text: ev.text || '', startedAt: Date.now(), live: true });
      return { ...msg, events };
    }
    case 'activity': {
      // 主进程真实活动提示：Writing… / Writing <tool>… / Calling <tool>… / Thinking…
      const label = typeof ev.label === 'string' ? ev.label.trim() : '';
      if (!label) return msg;
      return { ...msg, activityLabel: label, activityTone: 'activity', activity: { label, tone: 'activity', tool: ev.tool || null, chars: ev.chars ?? null, at: Date.now() } };
    }
    case 'tool-start':
      finalizeThought(events);
      events.push({ type: 'tool', name: ev.name || 'tool', args: String(ev.args || ''), status: 'running' });
      // 兜底：即使 activity 事件迟到/缺失，工具开始也会把底部文案切到 Calling <tool>…
      return { ...msg, events, activityLabel: `Calling ${ev.name || 'tool'}…`, activityTone: 'activity' };
    case 'tool-end': {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.type === 'tool' && e.name === ev.name && e.status === 'running') {
          events[i] = { ...e, status: ev.ok ? 'ok' : 'fail', ms: ev.ms, result: ev.result !== undefined ? ev.result : e.result };
          break;
        }
      }
      return { ...msg, events };
    }
    case 'retry': {
      // 网关抖动自动重试：事件进时间线，同时把 WorkingStatus 切成琥珀色「重试 2/5 · 网关无响应」
      const r = { type: 'retry', attempt: ev.attempt, max: ev.max, reason: ev.reason || '' };
      events.push(r);
      return { ...msg, events, activityLabel: retryLabel(r), activityTone: 'retry', activity: { ...r, kind: 'retry', label: retryLabel(r), tone: 'retry', at: Date.now() } };
    }
    case 'workflow-start':
      // 工作流工具开始执行：先放一个空骨架（App 的实时卡在首个快照到达后被替换）
      return {
        ...msg,
        workflowStarting: true,
        workflow: {
          ...(msg.workflow || {}),
          running: true,
          starting: true,
          startedAt: msg.workflow?.startedAt || ev.at || Date.now(),
          steps: Array.isArray(msg.workflow?.steps) ? msg.workflow.steps : [],
          phases: Array.isArray(msg.workflow?.phases) ? msg.workflow.phases : [],
          concurrency: msg.workflow?.concurrency ?? 14,
          goal: msg.workflow?.goal || ''
        }
      };
    case 'workflow':
      // 工作流实时快照（多 agent 运行状态）：只更新消息上的 workflow 字段，不进普通事件列表
      return { ...msg, workflowStarting: false, workflow: { ...ev, updatedAt: Date.now() } };
    case 'turn-end':
      finalizeThought(events);
      return { ...msg, workedMs: ev.ms ?? msg.workedMs, turnError: !!ev.error, activityLabel: null, activityTone: null, workflowStarting: false };
    default:
      return msg;
  }
}

/**
 * 一轮结束：把 agentChat 返回的 trace（全量 args + result）按「顺序 + 同名」合并回事件条目。
 * tool-start 事件里的 args 可能被主进程截断，这里用 trace 原文补全；展开面板因此可见完整命令与 diff。
 */
export function mergeTraceIntoEvents(events, trace, workedMs = null) {
  const out = (events || []).map((e) => ({ ...e }));
  if (!trace?.length) return out;
  const toStr = (v) => (typeof v === 'string' ? v : v != null ? JSON.stringify(v) : '');
  let ti = 0;
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.type !== 'tool') continue;
    let j = ti;
    while (j < trace.length && (trace[j].tool || 'tool') !== e.name) j++;
    if (j >= trace.length) continue;
    const t = trace[j];
    ti = j + 1;
    if (t.args != null) e.args = toStr(t.args);
    if (t.result !== undefined) e.result = t.result;
    if (e.status === 'running') e.status = 'ok';
  }
  // 完成时兜底：turn-end 事件可能晚于结果到达，残留的 live 思考用「到现在」的耗时收尾，
  // 且不超过整轮 workedMs（避免出现 Thought · 511s 这种跨轮残留）
  for (const e of out) {
    if (e.type === 'thought' && e.live) {
      const raw = e.startedAt ? Math.max(0, Date.now() - e.startedAt) : null;
      const cap = Number.isFinite(workedMs) && workedMs > 0 ? workedMs : 120000;
      e.live = false;
      e.ms = raw == null ? null : Math.min(raw, cap);
    }
  }
  return out;
}

function Chevron({ open }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/* 进行中状态：金色小方点呼吸 + 秒数实时走。
   可复用组件：主会话/子代理面板都把它放在消息底部（顶部入口随内容变长会滚出视野）。
   间距由调用方通过 className 决定，组件本身不带外边距。 */
export function WorkingStatus({ startedAt, label = null, tone = 'activity', className = '' }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  if (!startedAt) return null;
  const elapsed = Math.max(0, now - startedAt);
  // label 只来自真实事件（Writing / Calling / Thinking / 重试）；没有事件时保持默认 Working
  const text = typeof label === 'string' && label.trim() ? label.trim() : DEFAULT_WORKING_LABEL;
  const retry = tone === 'retry';
  return (
    <div className={`flex items-center gap-2 text-xs min-w-0 ${className}`}>
      <span className={`w-1.5 h-1.5 shrink-0 animate-pulse ${retry ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.9)]' : 'bg-goldSoft shadow-[0_0_6px_rgba(227,197,107,0.9)]'}`} />
      <span className={`font-medium tracking-wide truncate min-w-0 ${retry ? 'text-amber-400' : 'text-goldSoft'}`}>{text}</span>
      <span className="shrink-0 font-mono tabular-nums text-gold/90">{fmtDur(elapsed)}</span>
    </div>
  );
}

/* Thought：dsh/ZCode 式「Thought · Ns」；流式时自动展开淡灰思考字，结束折叠 */
function ThoughtEntry({ e }) {
  // 默认折叠（ZCode 风格：一行 Thought · Ns + 一句预览，点开才看全文），避免思考正文占满一屏
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!e.live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [e.live]);
  const text = String(e.text || '').trim();
  const ms = e.live ? (e.startedAt ? now - e.startedAt : 0) : e.ms;
  return (
    <div className="min-w-0">
      <button onClick={() => text && setOpen(!open)}
        className={`group w-full flex items-center gap-1.5 min-w-0 text-[11px] transition-colors duration-150 ${text ? 'cursor-pointer hover:text-ink/80' : 'cursor-default'} ${e.live ? 'text-goldSoft/80' : 'text-mute/55'}`}>
        <IconBrain className={`shrink-0 ${e.live ? 'animate-pulse text-goldSoft' : 'text-mute/45'}`} />
        <span className="shrink-0 tracking-wide">Thought</span>
        {ms != null ? <span className="shrink-0 font-mono tabular-nums text-mute/40">· {fmtThought(ms)}</span> : null}
        {text && !open ? <span className="truncate min-w-0 text-[10px] italic text-mute/35">{oneLine(text, 90)}</span> : null}
        {text ? <span className={`ml-auto shrink-0 text-[10px] text-mute/35 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▾</span> : null}
      </button>
      {text && open && (
        <div className="mt-1 ml-[5px] border-l border-edge/70 pl-3 py-0.5 text-[11px] leading-relaxed text-mute/50 italic whitespace-pre-wrap break-words max-h-40 overflow-y-auto animate-[fadeIn_.18s_ease]">
          {text}
        </div>
      )}
    </div>
  );
}

/* ---------- 工具条目元信息：每类工具都有具体名字，不再千篇一律 run_command ---------- */
function toolMeta(e) {
  const a = parseArgs(e.args);
  const r = e.result && typeof e.result === 'object' ? e.result : {};
  const p = splitPath(a.path || r.path);
  switch (e.name) {
    case 'run_command':
      return { icon: 'terminal', label: 'Terminal', detail: oneLine(a.command || '', 260), mono: true };
    case 'read_file':
      return { icon: 'file', label: 'Read', file: p.file, dir: p.dir, extra: r.totalLines != null ? t('{n} 行', { n: r.totalLines }) : '' };
    case 'edit_file':
      return { icon: 'edit', label: 'Edit', file: p.file, dir: p.dir, added: r.added, removed: r.removed };
    case 'write_file':
      return { icon: 'file', label: 'Write', file: p.file, dir: p.dir, added: r.added, removed: r.removed };
    case 'read_playbook':
      // 技能加载：ZCode 式紧凑壳——行内只露 "Skill"，类目/文件等细节收进展开面板
      return { icon: 'skill', label: 'Skill', detail: '' };
    case 'list_playbooks':
      return { icon: 'skill', label: 'Skills', detail: r.total ? t('{n} 类', { n: r.total }) : t('40 类') };
    case 'remember_project':
      return { icon: 'edit', label: 'Memory', detail: oneLine(a.fact || '', 200) };
    case 'present_artifact':
      return { icon: 'file', label: 'Artifact', file: p.file, dir: p.dir };
    case 'audit_project':
    case 'get_report':
      return { icon: 'shield', label: 'Audit', detail: oneLine(a.dir || '', 200), mono: true };
    case 'probe_target':
      return { icon: 'search', label: 'Probe', detail: oneLine(a.url || '', 200), mono: true };
    case 'stress_target':
      return { icon: 'stress', label: 'Stress', detail: `${oneLine(a.url || '', 160)}${a.duration ? ` · ${a.duration}s` : ''}`, mono: true };
    case 'download_gate':
      return { icon: 'download', label: 'Download gate', detail: oneLine(a.dir || '', 200), mono: true };
    case 'run_workflow':
      // 工作流：同样紧凑——行内只露 "Workflow"，步数/目标收进展开面板
      return { icon: 'tool', label: 'Workflow', detail: '' };
    default:
      return { icon: 'tool', label: e.name, detail: summarizeToolArgs(e.name, e.args), mono: true };
  }
}

function ReadDetail({ result }) {
  if (result?.error) return <div className="text-xs text-ink/70">{humanizeToolError(result.error)}</div>;
  return (
    <div className="space-y-1.5 text-[11px]">
      <div className="flex items-center gap-2 font-mono text-mute/60">
        <span>{result?.path}</span>
        <span className="text-mute/40">{t('{n} 行', { n: result?.totalLines })}</span>
        {result?.truncated ? <span className="text-goldDeep">{t('已截断，nextOffset={offset}', { offset: result.nextOffset })}</span> : null}
      </div>
      <pre className="rounded-lg bg-[#0d0d10] border border-edge px-2.5 py-2 font-mono text-ink/75 whitespace-pre-wrap break-all max-h-72 overflow-y-auto">{result?.content || ''}</pre>
    </div>
  );
}

function PlaybookDetail({ result }) {
  if (result?.error) return <div className="text-xs text-ink/70">{humanizeToolError(result.error)}</div>;
  return (
    <div className="space-y-1.5 text-[11px]">
      <div className="flex items-center gap-2 font-mono text-mute/60">
        <span>{result?.dir}</span>
        <span className="text-goldSoft/80">{result?.file}</span>
        <span className="text-mute/40">{t('{n} 字符', { n: result?.totalChars })}</span>
      </div>
      <pre className="rounded-lg bg-[#0d0d10] border border-edge px-2.5 py-2 font-mono text-ink/75 whitespace-pre-wrap break-all max-h-72 overflow-y-auto">{result?.content || ''}</pre>
    </div>
  );
}

/* diff 详情：+ 绿底 / - 红底 / 上下文灰字 */
function DiffDetail({ result }) {
  if (result?.error) return <div className="text-xs text-ink/70">{humanizeToolError(result.error)}</div>;
  const lines = result?.diff || [];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 text-[11px] font-mono">
        <span className="text-jade">+{result?.added ?? 0}</span>
        <span className="text-red-400">-{result?.removed ?? 0}</span>
        <span className="text-mute/50 truncate">{result?.path}</span>
        {result?.created ? <span className="text-goldSoft/80">{t('新建')}</span> : null}
      </div>
      <div className="rounded-lg border border-edge bg-[#0d0d10] max-h-72 overflow-auto font-mono text-[11px] leading-5">
        {lines.length ? lines.map((l, i) => (
          <div key={i} className={
            l.type === 'add' ? 'bg-jade/10 text-jade/90'
              : l.type === 'del' ? 'bg-red-500/10 text-red-300/90'
                : 'text-mute/55'
          }>
            <span className="inline-block w-5 text-center select-none opacity-60">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
            <span className="whitespace-pre-wrap break-all">{l.text === '' ? ' ' : l.text}</span>
          </div>
        )) : <div className="px-2.5 py-2 text-mute/40">{t('无行级改动')}</div>}
      </div>
      {result?.diffTruncated ? <div className="text-[10px] text-goldDeep/70">{t('diff 过长，仅显示前 200 行')}</div> : null}
    </div>
  );
}

/* 工具条目：图标 + 类型名 + 具体对象（文件/命令/URL）+ +N -M + 耗时，点开展开详情 */
function ToolEntry({ e, cardInBody }) {
  const [open, setOpen] = useState(false);
  const running = e.status === 'running';
  const expandable = running || !!e.args || e.result !== undefined;
  const meta = toolMeta(e);
  const summary = summarizeToolArgs(e.name, e.args);
  const detailText = summary === t('无参数') && meta.detail ? meta.detail : summary;
  const Icon = iconFor(meta.icon);
  const isCmd = e.name === 'run_command';
  const isDiff = e.name === 'edit_file' || e.name === 'write_file';
  const isRead = e.name === 'read_file';
  const isPlaybook = e.name === 'read_playbook';
  // Skill / Workflow 走 ZCode 式紧凑壳：行内只有 图标 + 名称 + 细竖线，细节点开才看
  const isCompact = isPlaybook || e.name === 'run_workflow';
  const showCardHint = cardInBody && !running && BODY_CARD_TOOLS.has(e.name);
  const failed = e.status === 'fail' || !!e.result?.error;
  const iconCls = running ? 'text-goldSoft animate-pulse' : failed ? 'text-red-400' : 'text-goldDeep/90';
  // 运行中用动名词（Reading），完成后回到名词；Skill/Workflow 紧凑壳始终只露名称，状态放右侧
  const label = running && e.name === 'read_file' ? 'Reading' : meta.label;

  return (
    <div className="min-w-0">
      <button onClick={() => expandable && setOpen(!open)}
        className={`group w-full flex items-center gap-2 text-left text-xs text-mute/70 min-w-0 font-mono transition-colors duration-150
          ${running ? 'animate-pulse' : ''} ${expandable ? 'hover:text-goldSoft cursor-pointer' : 'cursor-default'}`}>
        <Icon className={`shrink-0 ${iconCls}`} />
        <span className="shrink-0 text-[11px] tracking-wide text-mute/60 group-hover:text-goldSoft/90">{label}</span>
        {isCompact ? (
          <span className="shrink-0 select-none text-[11px] leading-none text-mute/25">|</span>
        ) : (
          <span className="truncate min-w-0 text-ink/70">{detailText}</span>
        )}
        {meta.extra ? <span className="shrink-0 text-[10px] text-mute/40">{meta.extra}</span> : null}
        {meta.added != null ? <span className="shrink-0 text-[11px] text-jade">+{meta.added}</span> : null}
        {meta.removed != null ? <span className="shrink-0 text-[11px] text-red-400">-{meta.removed}</span> : null}
        {running ? <span className="ml-auto shrink-0 text-[10px] text-goldSoft/70">running</span>
          : e.ms > 0 ? <span className="ml-auto shrink-0 text-[10px] tabular-nums text-mute/40">· {fmtToolMs(e.ms)}</span> : null}
        {expandable ? <Chevron open={open} /> : null}
      </button>
      {expandable && open && (
        <div className="mt-1.5 glass-card rounded-xl border border-gold/25 p-2.5 animate-[fadeIn_.2s_ease]">
          {isCmd ? (
            <CommandDetail args={e.args} result={e.result} />
          ) : isDiff ? (
            <DiffDetail result={e.result} />
          ) : isRead ? (
            <ReadDetail result={e.result} />
          ) : isPlaybook ? (
            <PlaybookDetail result={e.result} />
          ) : showCardHint ? (
            <div className="space-y-2 text-[11px]">
              <div className="text-ink/80 break-words">{detailText}</div>
              <div className="flex items-center gap-1.5 text-jade"><span className="font-bold">✓</span>{t('成果已在下方卡片展示')}</div>
            </div>
          ) : (
            <GenericToolDetail name={e.name} args={e.args} result={e.result} running={running} />
          )}
        </div>
      )}
    </div>
  );
}

/* 条目列：Thought / 工具 / 重试，左侧细线纵轴 */
function EntryList({ entries, cardInBody }) {
  if (!entries.length) return null;
  return (
    <div className="ml-0.5 border-l border-edge/80 pl-3 space-y-1.5">
      {entries.map((e, i) => {
        if (e.type === 'thought') return <ThoughtEntry key={i} e={e} />;
        if (e.type === 'retry') {
          return <div key={i} className="text-[11px] text-goldSoft/80 font-mono">↻ {t('重试 {attempt}/{max}', { attempt: e.attempt, max: e.max })}{e.reason ? ` · ${humanizeToolError(e.reason)}` : ''}</div>;
        }
        return <ToolEntry key={i} e={e} cardInBody={cardInBody} />;
      })}
    </div>
  );
}

/**
 * assistant 消息内附属块：
 * - streaming：Working Ns + 实时条目（Thought 自动展开 / 工具 running→完成）
 * - 完成：折叠成 Worked for Xm Ys ▾，点开看全部条目
 * - 历史恢复：无 events 时由 msg.trace + msg.reasoning 合成
 */
export function ProcessTimeline({ msg }) {
  const [open, setOpen] = useState(false);
  if (!msg || msg.role !== 'assistant') return null;

  const live = !!msg.streaming;
  const events = msg.events || [];
  const liveEntries = events.filter((e) => e.type === 'tool' || e.type === 'retry' || e.type === 'thought');

  if (live) {
    // 进行中的 Working 计时不再放在这里（消息变长会滚出视野），由消息底部/子代理面板底部渲染 WorkingStatus
    const wfStarting = !!msg.workflowStarting && !(msg.workflow?.steps?.length);
    if (!liveEntries.length && !wfStarting) return null;
    return (
      <div className="mb-2.5">
        {liveEntries.length ? <EntryList entries={liveEntries} cardInBody={false} /> : null}
        {wfStarting ? (
          <div className="flex items-center gap-2 text-[11px] text-goldSoft/70">
            <span className="w-1.5 h-1.5 shrink-0 bg-goldSoft/70 animate-pulse" />
            <span className="tracking-wide">{t('Workflow 已启动 · 等待第一个子代理…')}</span>
          </div>
        ) : null}
      </div>
    );
  }

  // 历史恢复：trace 提供全量 args/result；reasoning 补一条 Thought
  let entries = events.length ? [...liveEntries] : [];
  if (!events.length) {
    entries = (msg.trace || []).map((t) => ({
      type: 'tool',
      name: t.tool || 'tool',
      args: typeof t.args === 'string' ? t.args : t.args != null ? JSON.stringify(t.args) : '',
      result: t.result,
      status: 'ok'
    }));
  }
  // 完成态绝不显示还在增长的思考计时（历史 trace 没有耗时，统一显示 Thought 不带秒数）
  entries = entries.map((e) => (e.type === 'thought' && e.live ? { ...e, live: false, ms: null } : e));
  if (msg.reasoning && !entries.some((e) => e.type === 'thought')) {
    entries = [{ type: 'thought', text: msg.reasoning, ms: null, live: false }, ...entries];
  }
  const expandable = entries.length > 0;
  if (!expandable && msg.workedMs == null) return null;

  const label = msg.workedMs != null
    ? `Worked for ${fmtDur(msg.workedMs)}`
    : t('Worked for {n} 步', { n: entries.filter((e) => e.type === 'tool').length || 1 });
  const cardInBody = !msg.error;
  return (
    <div className="mb-2.5">
      <button onClick={() => expandable && setOpen(!open)} disabled={!expandable}
        className={`flex items-center gap-1.5 text-xs text-mute/70 transition-colors duration-150 ${expandable ? 'hover:text-goldSoft cursor-pointer' : 'cursor-default'}`}>
        <span className="font-mono tabular-nums">{label}</span>
        {expandable ? <Chevron open={open} /> : null}
      </button>
      {expandable && open && (
        <div className="mt-2 animate-[fadeIn_.2s_ease]">
          <EntryList entries={entries} cardInBody={cardInBody} />
        </div>
      )}
    </div>
  );
}
