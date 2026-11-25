// 0.33.5 后台任务面板（右上角，和验收单同一列）：
//   折叠 = 一个小胶囊「后台 N」（有在跑的显示转圈 + 运行数）；展开 = 任务列表：
//   命令 / 子代理、标题、状态、已用时间；在跑的可以停止；可以看输出（命令）或报告（子代理），
//   子代理还能打开它的完整过程（复用 SubagentPanel 的 onOpenStep）。
// 0.33.7（用户：「完成就是完成，中断是中断」「既然是命令，做成和 cc 一样的命令行终端小窗口，并且是真实的」
//         「展开都是 no output 太空旷了」）：
//   · 状态：已完成 ✓ / 失败 ✕ + 退出码 / 已中断 ⏸（写明是你还是 AI 中断的）
//   · 命令展开 = 终端小窗口：`$ 命令` + 实时真实输出（每秒刷新、贴底滚动、光标闪烁）+ 结束行
//   · 常驻服务（background:true）的输出以前被丢掉了，现在主进程写进日志文件再送到这里
// 数据：主进程 finalcheck:bg-tasks 推送 + 打开会话时拉一次（bgTasksList）。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/core.mjs';
import { bgChipSummary, cleanTerminalText } from '../lib/bg-tasks-view.mjs';

function fmtSecs(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function Spinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function KindIcon({ kind }) {
  return kind === 'agent' ? (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </svg>
  ) : (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <path d="M4 17l6-5-6-5" /><path d="M12 19h8" />
    </svg>
  );
}

function statusLabel(task) {
  if (task.status === 'running') return t('运行中');
  if (task.status === 'done') return t('已完成');
  if (task.status === 'failed') return task.exitCode !== undefined ? t('失败 · 退出码 {n}', { n: task.exitCode }) : t('失败');
  return task.stoppedBy === 'model' ? t('已中断（AI）') : task.stoppedBy === 'user' ? t('已中断（你）') : t('已中断');
}

function StatusIcon({ task }) {
  if (task.status === 'running') return <Spinner />;
  if (task.status === 'done') {
    return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="m5 12 5 5L20 7" /></svg>;
  }
  if (task.status === 'failed') {
    return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true" className="shrink-0"><path d="M6 6l12 12M18 6 6 18" /></svg>;
  }
  return <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="shrink-0"><rect x="6" y="5" width="4" height="14" rx="1.2" /><rect x="14" y="5" width="4" height="14" rx="1.2" /></svg>;
}

/**
 * 终端小窗口（对齐 Claude Code 的后台命令视图）：真实输出，不是摘要。
 *   标题栏 = 目录 + PID；第一行 `$ 命令`；下面实时输出（运行中每秒刷新、贴底滚动、行尾闪烁光标）；
 *   结束时补一行 `── 已完成 · 退出码 0 · 12s ──`。没有输出也写清楚，不留一个空框。
 */
function TerminalView({ task, output, running }) {
  const ref = useRef(null);
  const stick = useRef(true);
  const text = cleanTerminalText(output).replace(/\s+$/, '');
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text, running]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  const cmd = task.command || task.title || '';
  const footer = running ? null
    : task.status === 'done' ? t('已完成 · 退出码 {n} · {d}', { n: task.exitCode ?? 0, d: fmtSecs(task.ms) })
      : task.status === 'failed' ? t('失败 · 退出码 {n} · {d}', { n: task.exitCode ?? '?', d: fmtSecs(task.ms) })
        : `${statusLabel(task)} · ${fmtSecs(task.ms)}`;
  const footerTone = task.status === 'done' ? 'text-emerald-400/80' : task.status === 'failed' ? 'text-red-400/85' : 'text-zinc-500';
  return (
    <div data-testid="bg-task-terminal" className="overflow-hidden rounded-lg border border-zinc-800 bg-[#0c0c0e] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/60 px-2.5 py-1.5 text-[10.5px] text-zinc-500">
        <span className="flex gap-1" aria-hidden="true">
          <span className="h-2 w-2 rounded-full bg-zinc-700" /><span className="h-2 w-2 rounded-full bg-zinc-700" /><span className="h-2 w-2 rounded-full bg-zinc-700" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" title={task.detail}>{task.detail || t('终端')}</span>
        <span className="shrink-0 font-mono tabular-nums">{task.id}{task.pid ? ` · PID ${task.pid}` : ''}</span>
      </div>
      <pre ref={ref} onScroll={onScroll} data-testid="bg-task-output"
        className="max-h-[260px] min-h-[72px] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-[1.55] text-zinc-300">
        <span className="text-emerald-400/90">$ </span><span className="text-zinc-100">{cmd}</span>
        {'\n'}
        {text ? text : <span className="text-zinc-500">{running ? t('（等待输出…）') : t('（这条命令没有打印任何内容）')}</span>}
        {running ? <span className="ml-0.5 inline-block h-[1.05em] w-[0.55em] translate-y-[2px] animate-pulse bg-zinc-300/80 motion-reduce:animate-none" aria-hidden="true" /> : null}
        {footer ? <>{'\n'}<span className={footerTone}>── {footer} ──</span></> : null}
      </pre>
    </div>
  );
}

function TaskRow({ task, y, onOpenStep, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [detail, setDetail] = useState(null);
  const running = task.status === 'running';
  useEffect(() => {
    if (!open || !y?.bgTaskOutput) return undefined;
    let alive = true;
    const load = async () => {
      try { const r = await y.bgTaskOutput(task.id); if (alive) setDetail(r); } catch { /* 忽略 */ }
    };
    void load();
    const timer = running ? setInterval(load, 1000) : null;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [open, running, task.id, task.status, y]);
  const tone = task.status === 'failed' ? 'text-red-300/85' : task.status === 'done' ? 'text-jade/85' : task.status === 'stopped' ? 'text-mute/65' : 'text-goldSoft';
  const agentBody = detail ? (detail.result || detail.output || '') : '';
  return (
    <li data-testid="bg-task-row" data-status={task.status} data-kind={task.kind} className="border-b border-lift/[0.06] last:border-b-0">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-[11.5px]">
        <span className={tone}><StatusIcon task={task} /></span>
        <button type="button" onClick={() => setOpen((v) => !v)} title={task.command || task.title} aria-expanded={open}
          className={`min-w-0 flex-1 truncate text-left text-ink/80 hover:text-ink focus-visible:outline-none focus-visible:underline ${task.kind === 'agent' ? '' : 'font-mono text-[11px]'}`}>
          {task.kind === 'agent' ? <KindIcon kind="agent" /> : null} {task.title || task.id}
        </button>
        <span className={`shrink-0 tabular-nums text-[10.5px] ${tone}`}>{statusLabel(task)} · {fmtSecs(task.ms)}</span>
        {running ? (
          <button type="button" data-testid="bg-task-stop" onClick={() => { void y?.bgTaskStop?.(task.id); }}
            title={t('停止这个后台任务')} aria-label={t('停止这个后台任务')}
            className="shrink-0 rounded px-1 text-[10.5px] text-mute/60 hover:bg-red-400/10 hover:text-red-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-300/50">
            {t('停止')}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="px-3 pb-3 animate-[fadeIn_.16s_ease]">
          {task.kind === 'agent' ? (
            <>
              <div className="mb-1 flex items-center gap-2 text-[10.5px] text-mute/55">
                <span>{t('子代理')} {task.id}</span>
                {task.agentId && onOpenStep ? (
                  <button type="button" onClick={() => onOpenStep({ id: task.agentId, name: task.title, role: t('后台子代理') })} className="text-goldSoft/80 hover:text-goldSoft hover:underline">{t('打开过程')}</button>
                ) : null}
              </div>
              <pre data-testid="bg-task-output" className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-lift/[0.04] p-2.5 text-[11px] leading-relaxed text-ink/80">
                {agentBody || (running ? t('子代理还在干活，做完会把报告放在这里。') : t('（没有报告）'))}
              </pre>
            </>
          ) : (
            <TerminalView task={task} output={detail?.output || ''} running={running} />
          )}
        </div>
      ) : null}
    </li>
  );
}

export default function BgTasksPanel({ y, sessionId, onOpenStep = null }) {
  const [tasks, setTasks] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    setTasks([]);
    if (!sessionId || !y?.bgTasksList) return undefined;
    let alive = true;
    Promise.resolve(y.bgTasksList(sessionId)).then((r) => { if (alive && Array.isArray(r?.tasks)) setTasks(r.tasks); }).catch(() => {});
    const off = y.onBgTasks?.((p) => { if (p?.sessionId === sessionId && Array.isArray(p.tasks)) setTasks(p.tasks); });
    return () => { alive = false; off?.(); };
  }, [sessionId, y]);
  const summary = useMemo(() => bgChipSummary(tasks), [tasks]);
  // 在跑的任务每秒刷新一次已用时间（本地推算，不打 IPC）
  useEffect(() => {
    if (!summary.running) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [summary.running]);
  if (!tasks.length) return null;
  const now = Date.now();
  const live = tasks.map((x) => (x.status === 'running' ? { ...x, ms: now - x.startedAt } : x));
  const label = summary.running ? t('后台 {n}', { n: summary.running }) : t('后台 {n} 已结束', { n: summary.total });
  return (
    <div data-testid="bg-tasks-panel" data-running={summary.running} className="pointer-events-auto flex flex-col items-end gap-2">
      <button type="button" data-testid="bg-tasks-chip" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
        title={t('后台任务')}
        className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border bg-base/95 px-2.5 text-[11px] leading-none shadow-[0_6px_20px_rgba(0,0,0,0.45)] backdrop-blur-sm transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 ${summary.running ? 'border-jade/45 text-jade hover:border-jade/80' : 'border-lift/20 text-mute/75 hover:border-lift/40'}`}>
        {summary.running ? <Spinner /> : <KindIcon kind="command" />}
        <span className="font-medium tracking-[0.08em]">{label}</span>
        {summary.failed ? <span className="text-red-300/80">{t('失败 {n}', { n: summary.failed })}</span> : null}
      </button>
      {expanded ? (
        <div data-testid="bg-tasks-card" className="w-[min(460px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-lift/15 bg-card/95 shadow-[0_10px_30px_rgba(0,0,0,0.5)] backdrop-blur-md animate-[fadeIn_.16s_ease]">
          <div className="flex items-center justify-between border-b border-lift/[0.08] px-3 py-2 text-[11px] text-mute/70">
            <span className="tracking-[0.12em]">{t('后台任务')}</span>
            <span className="text-[10.5px] text-mute/45">{t('完成后会自动告诉 AI')}</span>
          </div>
          <ul className="max-h-[420px] overflow-y-auto overscroll-contain">
            {live.map((task, i) => <TaskRow key={task.id} task={task} y={y} onOpenStep={onOpenStep} defaultOpen={i === 0 && task.kind === 'command'} />)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
