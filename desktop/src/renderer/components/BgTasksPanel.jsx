// 0.33.5 后台任务面板（右上角，和验收单同一列）：
//   折叠 = 一个小胶囊「后台 N」（有在跑的显示转圈 + 运行数）；展开 = 任务列表：
//   命令 / 子代理、标题、状态、已用时间；在跑的可以停止；可以看输出（命令）或报告（子代理），
//   子代理还能打开它的完整过程（复用 SubagentPanel 的 onOpenStep）。
// 数据：主进程 finalcheck:bg-tasks 推送 + 打开会话时拉一次（bgTasksList）。
import React, { useEffect, useMemo, useState } from 'react';
import { t } from '../i18n/core.mjs';
import { bgChipSummary } from '../lib/bg-tasks-view.mjs';

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

function statusLabel(status) {
  if (status === 'running') return t('运行中');
  if (status === 'done') return t('已完成');
  if (status === 'failed') return t('失败');
  return t('已停止');
}

function TaskRow({ task, y, onOpenStep }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const running = task.status === 'running';
  useEffect(() => {
    if (!open || !y?.bgTaskOutput) return undefined;
    let alive = true;
    const load = async () => {
      try { const r = await y.bgTaskOutput(task.id); if (alive) setDetail(r); } catch { /* 忽略 */ }
    };
    void load();
    const timer = running ? setInterval(load, 2000) : null;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [open, running, task.id, y]);
  const tone = task.status === 'failed' ? 'text-red-300/80' : task.status === 'done' ? 'text-jade/80' : task.status === 'stopped' ? 'text-mute/60' : 'text-goldSoft';
  const body = detail ? (task.kind === 'agent' ? (detail.result || detail.output || '') : (detail.output || '')) : '';
  return (
    <li data-testid="bg-task-row" data-status={task.status} data-kind={task.kind} className="border-b border-lift/[0.06] last:border-b-0">
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-[11.5px]">
        <span className={tone}>{running ? <Spinner /> : <KindIcon kind={task.kind} />}</span>
        <button type="button" onClick={() => setOpen((v) => !v)} title={task.title}
          className="min-w-0 flex-1 truncate text-left text-mute/90 hover:text-goldSoft focus-visible:outline-none focus-visible:underline">
          {task.title || task.id}
        </button>
        <span className={`shrink-0 tabular-nums text-[10.5px] ${tone}`}>{statusLabel(task.status)} · {fmtSecs(task.ms)}</span>
        {running ? (
          <button type="button" data-testid="bg-task-stop" onClick={() => { void y?.bgTaskStop?.(task.id); }}
            title={t('停止这个后台任务')} aria-label={t('停止这个后台任务')}
            className="shrink-0 rounded px-1 text-[10.5px] text-mute/60 hover:bg-red-400/10 hover:text-red-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-300/50">
            {t('停止')}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="px-3 pb-2.5">
          <div className="mb-1 flex items-center gap-2 text-[10.5px] text-mute/50">
            <span>{task.kind === 'agent' ? t('子代理') : t('命令')} {task.id}{task.pid ? ` · PID ${task.pid}` : ''}{task.exitCode !== undefined ? ` · ${t('退出码 {n}', { n: task.exitCode })}` : ''}</span>
            {task.kind === 'agent' && task.agentId && onOpenStep ? (
              <button type="button" onClick={() => onOpenStep({ id: task.agentId, name: task.title, role: t('后台子代理') })} className="text-goldSoft/80 hover:text-goldSoft hover:underline">{t('打开过程')}</button>
            ) : null}
          </div>
          <pre data-testid="bg-task-output" className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 p-2 font-mono text-[10.5px] leading-relaxed text-mute/80">
            {body || (running ? t('（还没有输出）') : t('（没有输出）'))}
          </pre>
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
        <div data-testid="bg-tasks-card" className="w-[min(340px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-lift/15 bg-card/95 shadow-[0_10px_30px_rgba(0,0,0,0.5)] backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-lift/[0.08] px-3 py-2 text-[11px] text-mute/70">
            <span className="tracking-[0.12em]">{t('后台任务')}</span>
            <span className="text-[10.5px] text-mute/45">{t('完成后会自动告诉 AI')}</span>
          </div>
          <ul className="max-h-[360px] overflow-y-auto overscroll-contain">
            {live.map((task) => <TaskRow key={task.id} task={task} y={y} onOpenStep={onOpenStep} />)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
