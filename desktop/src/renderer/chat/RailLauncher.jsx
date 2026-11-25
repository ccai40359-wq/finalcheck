// 0.33.9 用户自己打开右栏（用户：「加一个用户可以自主点右侧栏的功能，设计就看你了」）
//   以前右栏只在 AI 开网页 / 交付产物 / 派子代理时才出现，用户自己没法打开。
//   现在：顶栏右上角的按钮、或右栏标签条上的 +，打开「新标签」页，三选一：
//     · 浏览器   —— 打开内置浏览器（输网址，或预览自己的应用）
//     · 文件     —— 搜项目里的文件，点了在右栏预览（图片 / 网页 / PDF / 代码…）
//     · 后台任务 —— 后台命令的终端窗口、子代理的报告（和右上角胶囊同一份数据，这里空间更大）
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/core.mjs';
import { TaskRow } from '../components/BgTasksPanel.jsx';
import { bgChipSummary } from '../lib/bg-tasks-view.mjs';

function IconGlobe() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
    </svg>
  );
}
function IconFiles() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function IconTerminal() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="m7.5 10 3 2.5-3 2.5" /><path d="M13 15.5h4" />
    </svg>
  );
}

/** 「新标签」页 */
export function RailLauncher({ onChoose, bgCount = 0 }) {
  const items = [
    { kind: 'browser', icon: <IconGlobe />, title: t('浏览器'), desc: t('打开网页，或预览你正在做的应用') },
    { kind: 'files', icon: <IconFiles />, title: t('文件'), desc: t('搜项目里的文件，在这里预览') },
    { kind: 'tasks', icon: <IconTerminal />, title: t('后台任务'), desc: bgCount ? t('{n} 个后台任务，看实时输出', { n: bgCount }) : t('后台命令的终端输出、子代理的报告') }
  ];
  return (
    <div data-testid="rail-launcher" className="flex-1 min-h-0 overflow-y-auto px-6 py-6 animate-[fadeIn_.16s_ease]">
      <div className="mb-4 text-[15px] font-medium text-ink/90">{t('新标签')}</div>
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
        {items.map((it) => (
          <button key={it.kind} type="button" data-testid={`rail-launch-${it.kind}`} onClick={() => onChoose?.(it.kind)}
            className="group flex items-center gap-3 rounded-xl border border-lift/[0.07] bg-lift/[0.025] px-3.5 py-3 text-left transition-colors duration-150 hover:border-gold/25 hover:bg-lift/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/50">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-lift/[0.05] text-mute/80 transition-colors group-hover:text-goldSoft">{it.icon}</span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-ink/90">{it.title}</span>
              <span className="block truncate text-[11.5px] text-mute/60">{it.desc}</span>
            </span>
            <span className="ml-auto shrink-0 text-[11px] text-mute/40 transition-colors group-hover:text-goldSoft/80">{t('打开')}</span>
          </button>
        ))}
      </div>
      <div className="mt-6 text-[11px] leading-relaxed text-mute/45">{t('AI 打开网页、交付文件、派子代理时也会自动出现在这里。')}</div>
    </div>
  );
}

const EXT_TONE = [
  [/\.(png|jpe?g|gif|webp|svg|bmp)$/i, 'text-jade/80'],
  [/\.(html?|css)$/i, 'text-sky-300/80'],
  [/\.(m?jsx?|tsx?|py|go|rs|java|c|cpp|cs)$/i, 'text-goldSoft/80'],
  [/\.(md|txt|json|ya?ml|csv|log)$/i, 'text-mute/70']
];
const toneOf = (f) => (EXT_TONE.find(([re]) => re.test(f)) || [null, 'text-mute/55'])[1];

/** 「文件」：项目文件搜索 + 点了在右栏预览 */
export function RailFiles({ y, sessionId, onOpenFile }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ root: '', files: [], loading: true });
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const r = await y?.projectBrowse?.(sessionId, q);
        if (alive) setRes({ root: r?.root || '', files: Array.isArray(r?.files) ? r.files : [], loading: false });
      } catch { if (alive) setRes((s) => ({ ...s, loading: false })); }
    }, q ? 120 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, sessionId, y]);
  const sep = /\\/.test(res.root) ? '\\' : '/';
  const abs = (f) => `${res.root.replace(/[\\/]+$/, '')}${sep}${f.replace(/\//g, sep)}`;
  return (
    <div data-testid="rail-files" className="flex flex-1 min-h-0 flex-col">
      <div className="shrink-0 border-b border-edge/60 px-3 py-2">
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('搜文件名…')}
          data-testid="rail-files-search"
          className="w-full rounded-lg border border-transparent bg-lift/[0.04] px-3 py-1.5 text-[12px] text-ink placeholder:text-mute/45 focus:border-lift/[0.12] focus:outline-none" />
        {res.root ? <div className="mt-1.5 truncate font-mono text-[10.5px] text-mute/45" title={res.root}>{res.root}</div> : null}
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto py-1">
        {res.files.map((f) => {
          const slash = f.lastIndexOf('/');
          const name = f.slice(slash + 1);
          const dir = slash > 0 ? f.slice(0, slash) : '';
          return (
            <li key={f}>
              <button type="button" data-testid="rail-file" onClick={() => onOpenFile?.(abs(f))} title={abs(f)}
                className="flex w-full min-w-0 items-baseline gap-2 px-3 py-1 text-left font-mono text-[11.5px] hover:bg-lift/[0.05]">
                <span className={`shrink-0 ${toneOf(name)}`}>{name}</span>
                <span className="min-w-0 truncate text-[10.5px] text-mute/40">{dir}</span>
              </button>
            </li>
          );
        })}
        {!res.loading && !res.files.length ? (
          <li className="px-3 py-6 text-center text-[12px] text-mute/50">{res.root ? t('没有匹配的文件') : t('这个会话还没有项目目录')}</li>
        ) : null}
      </ul>
    </div>
  );
}

/** 「后台任务」：和右上角胶囊同一份数据，空间更大；第一条命令默认展开成终端 */
export function RailTasks({ y, sessionId, onOpenStep = null }) {
  const [tasks, setTasks] = useState([]);
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
  useEffect(() => {
    if (!summary.running) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [summary.running]);
  const now = Date.now();
  const live = tasks.map((x) => (x.status === 'running' ? { ...x, ms: now - x.startedAt } : x));
  const firstCmd = live.findIndex((x) => x.kind === 'command');
  return (
    <div data-testid="rail-tasks" className="flex flex-1 min-h-0 flex-col">
      <div className="shrink-0 flex items-center justify-between border-b border-edge/60 px-3 py-2 text-[11px] text-mute/65">
        <span>{summary.running ? t('{n} 个在跑', { n: summary.running }) : t('后台任务')}</span>
        <span className="text-[10.5px] text-mute/40">{t('完成后会自动告诉 AI')}</span>
      </div>
      {live.length ? (
        <ul className="flex-1 min-h-0 overflow-y-auto">
          {live.map((task, i) => <TaskRow key={task.id} task={task} y={y} onOpenStep={onOpenStep} defaultOpen={i === firstCmd} />)}
        </ul>
      ) : (
        <div className="flex-1 px-6 py-10 text-center text-[12px] leading-relaxed text-mute/50">
          {t('现在没有后台任务。')}<br />{t('AI 跑很久的命令、启动的服务、派出去的后台子代理会出现在这里。')}
        </div>
      )}
    </div>
  );
}
