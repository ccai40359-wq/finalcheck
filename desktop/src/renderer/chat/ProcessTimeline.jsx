// coding agent 式「过程时间线」：Working 计时 + Thought 闪出 + 具体工具条目 + 完成折叠（墨黑鎏金主题）
// 数据来源：实时 = window.finalcheck.onAgentEvent 事件流（applyAgentEvent 归约到流式消息上）；
//          历史 = msg.trace / msg.reasoning（落盘无耗时，合成条目）。
import React, { useEffect, useMemo, useState } from 'react';
import { CommandDetail, GenericToolDetail, BODY_CARD_TOOLS } from './TraceCards.jsx';
import { humanizeToolError, summarizeToolArgs } from '../lib/humanize.js';
import { iconFor, IconBrain } from './ToolIcons.jsx';
import { DEFAULT_WORKING_LABEL } from './activity.mjs';
import { t } from '../i18n/core.mjs';
import { timelineEntries } from '../lib/process-events.mjs';
import { planTimelineWindow } from '../lib/timeline-window.mjs';
import { useLanguage } from '../i18n/index.jsx';

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
export { applyAgentEvent, mergeTraceIntoEvents } from '../lib/process-events.mjs';

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
      <pre className="rounded-md bg-[#111114] px-2.5 py-2 font-mono text-ink/75 whitespace-pre-wrap break-all max-h-72 overflow-y-auto">{result?.content || ''}</pre>
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
      <pre className="rounded-md bg-[#111114] px-2.5 py-2 font-mono text-ink/75 whitespace-pre-wrap break-all max-h-72 overflow-y-auto">{result?.content || ''}</pre>
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
      <div className="rounded-md bg-[#111114] max-h-72 overflow-auto font-mono text-[11px] leading-5">
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
// 运行中的秒数走表：没有它「正在跑」和「卡死」在界面上完全一样。
function useElapsedSince(startedAt, active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !startedAt) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);
  if (!startedAt || !active) return 0;
  return Math.max(0, now - startedAt);
}

function ToolEntry({ e, cardInBody }) {
  const [open, setOpen] = useState(false);
  const running = e.status === 'running';
  const elapsedMs = useElapsedSince(e.at, running);
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
    <div className="min-w-0 fc-tool-entry">
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
        {running ? <span className="ml-auto shrink-0 tabular-nums text-[10px] text-goldSoft/70" data-testid="tool-elapsed">{t('已耗时 {n}s', { n: Math.floor(elapsedMs / 1000) })}</span>
          : e.ms > 0 ? <span className="ml-auto shrink-0 text-[10px] tabular-nums text-mute/40">· {fmtToolMs(e.ms)}</span> : null}
        {expandable ? <Chevron open={open} /> : null}
      </button>
      {expandable && open && (
        <div className="mt-1.5 rounded-lg bg-white/[0.02] p-2.5 animate-[fadeIn_.2s_ease]">
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
const EntryList = React.memo(function EntryList({ entries, cardInBody, offset, language }) {
  if (!entries.length) return null;
  return (
    <div className="ml-0.5 border-l border-edge/80 pl-3 space-y-1.5">
      {entries.map((e, i) => {
        const key = e.type === 'tool' && (e.id != null || e.callId != null) ? `tool-${e.id ?? e.callId}` : `${e.type}-${offset + i}`;
        if (e.type === 'thought') return <ThoughtEntry key={key} e={e} />;
        if (e.type === 'retry') {
          return <div key={key} className="text-[11px] text-goldSoft/80 font-mono">↻ {t('重试 {attempt}/{max}', { attempt: e.attempt, max: e.max })}{e.reason ? ` · ${humanizeToolError(e.reason)}` : ''}</div>;
        }
        return <ToolEntry key={key} e={e} cardInBody={cardInBody} />;
      })}
    </div>
  );
});

/**
 * assistant 消息内附属块：
 * - streaming：Working Ns + 实时条目（Thought 自动展开 / 工具 running→完成）
 * - 完成：默认展开（round9 用户实测：折叠后切会话回来「过程全看不到」）；点标题可收起/展开，
 *   状态按消息 id 持久化到 localStorage——切会话、重启都不重置用户的展开选择
 * - 历史恢复：无 events 时由 msg.trace + msg.reasoning 合成
 */
// 键前缀带版本号：round9 之前用户手动收起过的回合会在 localStorage 留下 "0"，
// 升级后这些旧记录会让「默认展开」失效（用户看到「还是收起的」）。带版本 = 旧记录自动作废。
const TL_OPEN_PREFIX = 'fc.timeline.open:v2:';
// 键：磁盘消息带 id（sessions.mjs buildMessage），实时回合带 mid（App.jsx 生成）。
// 两处都认——漏掉 id 会让「记住收起状态」静默失效（round9 自查发现的真字段错配）。
const timelineKey = (msg) => (msg?.mid || msg?.id || null);
function readTimelineOpen(msg) {
  try {
    const key = timelineKey(msg);
    if (key) {
      const v = localStorage.getItem(TL_OPEN_PREFIX + key);
      if (v === '0') return false;
      if (v === '1') return true;
    }
  } catch { /* localStorage 不可用（隐私模式等）→ 用默认值 */ }
  return true; // 默认展开：完成态也要看得到工具调用过程
}
function writeTimelineOpen(msg, open) {
  const key = timelineKey(msg);
  try { if (key) localStorage.setItem(TL_OPEN_PREFIX + key, open ? '1' : '0'); } catch { /* 忽略 */ }
}

export const ProcessTimeline = React.memo(function ProcessTimeline({ msg }) {
  const language = useLanguage();
  const [open, setOpen] = useState(() => readTimelineOpen(msg));
  const [page, setPage] = useState(null);
  const { events, trace, reasoning, streaming, interrupted, workedMs } = msg || {};
  // A typed character or streamed answer token does not change the tool timeline.
  // Keep the derived entries and visible segment stable until their actual inputs change.
  const liveEntries = useMemo(() => timelineEntries({ events, trace, reasoning, streaming, interrupted, workedMs }),
    [events, trace, reasoning, streaming, interrupted, workedMs]);
  const window = planTimelineWindow(liveEntries.length, page);
  const visibleEntries = useMemo(() => liveEntries.slice(window.start, window.end), [liveEntries, window.start, window.end]);
  if (!msg || msg.role !== 'assistant') return null;

  const live = !!streaming;
  const entryList = (
    <div data-testid="timeline-segment">
      {window.pages > 1 ? (
        <nav aria-label={t('过程记录分页')} className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-mute/70">
          <span className="font-mono tabular-nums">{t('过程 {from}–{to} / 共 {total} 条', { from: window.start + 1, to: window.end, total: window.total })}</span>
          <button type="button" disabled={!window.hasEarlier} onClick={() => setPage(0)} className="hover:text-goldSoft disabled:opacity-35">{t('最早记录')}</button>
          <button type="button" disabled={!window.hasEarlier} onClick={() => setPage(window.page - 1)} className="hover:text-goldSoft disabled:opacity-35">{t('更早记录')}</button>
          <button type="button" disabled={!window.hasLater} onClick={() => setPage(window.page + 1 === window.lastPage ? null : window.page + 1)} className="hover:text-goldSoft disabled:opacity-35">{t('更后记录')}</button>
          <button type="button" disabled={!window.hasLater} onClick={() => setPage(null)} className="hover:text-goldSoft disabled:opacity-35">{t('最新记录')}</button>
        </nav>
      ) : null}
      <EntryList entries={visibleEntries} offset={window.start} cardInBody={!live && !msg.error} language={language} />
    </div>
  );

  if (live) {
    // 进行中的 Working 计时不再放在这里（消息变长会滚出视野），由消息底部/子代理面板底部渲染 WorkingStatus
    const wfStarting = !!msg.workflowStarting && !(msg.workflow?.steps?.length);
    if (!liveEntries.length && !wfStarting) return null;
    return (
      <div className="mb-2.5">
        {liveEntries.length ? entryList : null}
        {wfStarting ? (
          <div className="flex items-center gap-2 text-[11px] text-goldSoft/70">
            <span className="w-1.5 h-1.5 shrink-0 bg-goldSoft/70 animate-pulse" />
            <span className="tracking-wide">{t('Workflow 已启动 · 等待第一个子代理…')}</span>
          </div>
        ) : null}
      </div>
    );
  }

  const entries = liveEntries;
  const expandable = entries.length > 0;
  if (!expandable && msg.workedMs == null) return null;

  const label = msg.workedMs != null
    ? `Worked for ${fmtDur(msg.workedMs)}`
    : t('Worked for {n} 步', { n: entries.filter((e) => e.type === 'tool').length || 1 });
  return (
    <div className="mb-2.5">
      <button onClick={() => { if (!expandable) return; const v = !open; setOpen(v); writeTimelineOpen(msg, v); }} disabled={!expandable}
        className={`flex items-center gap-1.5 text-xs text-mute/70 transition-colors duration-150 ${expandable ? 'hover:text-goldSoft cursor-pointer' : 'cursor-default'}`}>
        <span className="font-mono tabular-nums">{label}</span>
        {expandable ? <Chevron open={open} /> : null}
      </button>
      {expandable && open && (
        <div className="mt-2 animate-[fadeIn_.2s_ease]">
          {entryList}
        </div>
      )}
    </div>
  );
});
