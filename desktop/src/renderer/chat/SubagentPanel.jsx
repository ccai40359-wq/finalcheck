// 右侧「子代理上下文」面板：点工作流卡片里的子代理 chip → 看它自己的完整上下文
// 呈现方式和普通会话一样（用户消息＝主 Agent 派发的任务 → Worked for … 工具/思考时间线 → 最终回答），
// 只是说话的人是主 Agent，不是用户。数据来自主进程按步骤记下的 transcript。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/ui.jsx';
import { isProgramStep } from '../lib/step-view.mjs';
import { t } from '../i18n/core.mjs';
import { ProcessTimeline, WorkingStatus } from './ProcessTimeline.jsx';
import { SwarmResult } from './SwarmResult.jsx';

// ProcessTimeline 行内只露「工具名 + 具体对象」：这些工具它自己能抽出 path / command / URL，
// 所以原样传全量 args（展开面板才看得到完整命令与 diff）。其余工具只传一行摘要，
// 避免把整段 args JSON 铺在面板里。
const FULL_ARG_TOOLS = new Set([
  'run_command', 'read_file', 'edit_file', 'write_file',
  'read_playbook', 'list_playbooks', 'remember_project', 'present_artifact',
  'audit_project', 'get_report', 'probe_target', 'stress_target',
  'download_gate', 'run_workflow'
]);
const ARG_PICK = ['path', 'file', 'dir', 'url', 'command', 'query', 'pattern', 'name', 'target', 'id', 'prompt', 'goal', 'summary'];

/** 第一行 + 去多余空白 + 截断（面板里不放整段参数） */
function firstLine(value, max = 110) {
  const line = String(value ?? '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 工具参数 → 一行摘要（文件路径 / 命令首段 / 查询词） */
function summarizeArgs(name, raw) {
  if (raw == null) return '';
  const asJson = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (FULL_ARG_TOOLS.has(name)) return asJson;
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ARG_PICK) {
      const pick = value[key];
      if (typeof pick === 'string' && pick.trim()) return firstLine(pick);
    }
    for (const pick of Object.values(value)) {
      if (typeof pick === 'string' && pick.trim()) return firstLine(pick);
    }
    return firstLine(Object.keys(value).slice(0, 4).join(', '), 90);
  }
  return firstLine(raw);
}

/** transcript（system/user/assistant±toolCalls/tool）→ ProcessTimeline 的 events + 最终答案 */
function buildThread(messages) {
  const events = [];
  let answer = '';
  let finalReasoning = '';
  for (const m of messages || []) {
    if (m.role === 'assistant') {
      const reasoning = String(m.reasoning || '').trim();
      const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
      if (calls.length) {
        if (reasoning) events.push({ type: 'thought', text: reasoning, ms: m.ms ?? null, live: false });
        for (const c of calls) {
          const args = summarizeArgs(c?.name, c?.args);
          events.push({ type: 'tool', name: c?.name || 'tool', args, status: 'running' });
        }
      } else if (String(m.content || '').trim()) {
        if (reasoning) finalReasoning = reasoning;
        answer = String(m.content || '');
      }
    } else if (m.role === 'tool') {
      const hit = events.findIndex((e) => e.type === 'tool' && e.status === 'running' && e.name === (m.name || 'tool'));
      if (m.pending) {
        if (hit < 0) events.push({ type: 'tool', name: m.name || 'tool', args: summarizeArgs(m.name, m.args), status: 'running' });
        continue;
      }
      const patch = { status: m.ok === false ? 'fail' : 'ok', result: m.content };
      if (m.ms != null) patch.ms = m.ms;
      if (hit >= 0) events[hit] = { ...events[hit], ...patch };
      else events.push({ type: 'tool', name: m.name || 'tool', args: summarizeArgs(m.name, m.args), ...patch });
    }
  }
  return { events, answer, finalReasoning };
}

function SystemPrompt({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="mb-3">
      <button onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] text-mute/55 hover:text-ink transition-colors">
        <span className="text-goldDeep/80">⚙</span> System prompt
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open ? (
        <pre className="mt-1.5 whitespace-pre-wrap break-words rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-mute/60 font-mono">{text}</pre>
      ) : null}
    </div>
  );
}

export function SubagentPanel({ target, onClose }) {
  const y = api();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem('fc.subagentWidth'));
    return Number.isFinite(v) && v >= 300 ? v : 620;
  });
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);

  // gate / aggregate 是确定性程序节点，没有子代理对话：直接说明，不要去轮询
  // 判定收口在 lib/step-view.mjs（DSL 用 op，旧卡片用 opType/kind），并有单测
  const isProgramNode = isProgramStep(target);
  useEffect(() => {
    let alive = true;
    let tries = 0;
    let timer = null;
    setData(null); setErr('');
    if (isProgramNode) {
      setErr(t('这是确定性检查节点（gate / aggregate）：由程序直接执行，没有子代理对话。结论请看工作流卡片里该步骤的结果。'));
      return () => { alive = false; };
    }
    const load = async () => {
      try {
        const r = await y?.workflowStepContext?.(target?.sessionId, target?.stepId);
        if (!alive) return;
        if (r) {
          setData(r);
          if (r.done) return;
          timer = setTimeout(load, 1200);
          return;
        }
        tries += 1;
        if (tries >= 6) { setErr(t('这次子代理的上下文没有留下（只保留最近一次工作流的记录）')); return; }
        timer = setTimeout(load, 1200);
      } catch (e) {
        if (alive) setErr(e?.message || t('读取失败'));
      }
    };
    load();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [target?.sessionId, target?.stepId, target?.key, isProgramNode]);

  const startDrag = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const max = Math.round(window.innerWidth * 0.72);
    const move = (ev) => {
      const next = Math.min(max, Math.max(0, startW + (startX - ev.clientX)));
      if (next < 260) { cleanup(); onClose?.(); return; }
      setWidth(next);
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    const up = () => { cleanup(); localStorage.setItem('fc.subagentWidth', String(widthRef.current)); };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const msgs = data?.messages || [];
  const system = msgs.find((m) => m.role === 'system')?.content || '';
  const task = msgs.find((m) => m.role === 'user')?.content || '';
  const { events, answer } = useMemo(() => buildThread(msgs), [msgs]);
  const running = !!data && !data.done;

  // 头部耗时：运行中按 startedAt 自己走秒（不依赖轮询节奏，和 Working 计时一致）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);
  const elapsedMs = running && data?.startedAt ? Math.max(0, now - data.startedAt) : (data?.ms || 0);
  const bodyRef = useRef(null);
  const stickRef = useRef(true);
  // 像普通会话一样：新内容来了跟到底部；用户往上翻过就不再抢夺
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs.length, answer, data?.done]);
  const assistantMsg = {
    role: 'assistant',
    events,
    streaming: running,
    startedAt: running ? (data?.startedAt || (Date.now() - (data?.ms || 0))) : null,
    workedMs: running ? null : (data?.ms || 0)
  };

  return (
    <aside style={{ width }} className="shrink-0 border-l border-white/[0.07] bg-[#0b0b0e] flex flex-col min-h-0 relative">
      <div onMouseDown={startDrag} onDoubleClick={() => setWidth(620)} title={t('拖动调整宽度（拖到头关闭，双击复位）')}
        className="group absolute left-0 top-0 h-full w-2 -ml-1 cursor-col-resize z-10">
        <div className="w-px h-full mx-auto bg-white/[0.08] group-hover:bg-gold/60 transition-colors" />
      </div>
      <div className="shrink-0 h-11 px-3.5 flex items-center gap-2 border-b border-white/[0.07]">
        <span className="text-goldSoft text-sm">◈</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-ink/90 truncate">{data?.role || target?.name || t('子代理')}</div>
          <div className="text-[10px] text-mute/50 truncate">
            {isProgramNode
              ? t('确定性节点 · 无子代理对话')
              : (data
                ? (running
                  ? t('{n} 次工具调用 · {s}s · 运行中', { n: data.toolCount || 0, s: Math.round(elapsedMs / 1000) })
                  : t('{n} 次工具调用 · {s}s', { n: data.toolCount || 0, s: Math.round(elapsedMs / 1000) }))
                : t('读取中…'))}
          </div>
        </div>
        <button onClick={onClose} title={t('关闭')}
          className="h-7 w-7 rounded-md text-mute hover:text-ink hover:bg-white/5 transition-colors">✕</button>
      </div>

      <div ref={bodyRef} onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {err ? <div className="text-xs text-amber-300/90 whitespace-pre-wrap">{err}</div> : null}
        {!err && !data ? <div className="text-xs text-mute/60 animate-pulse">{t('读取子代理上下文…')}</div> : null}
        {data ? (
          <div className="w-full mx-auto space-y-4">
            <SystemPrompt text={system} />
            {task ? (
              <div className="flex flex-col items-end">
                <span className="mb-1 text-[10px] text-mute/45">{t('主 Agent · 派发任务')}</span>
                <div className="glass-bubble max-w-[88%] rounded-2xl rounded-br-md px-3.5 py-2 text-sm whitespace-pre-wrap break-words leading-relaxed text-ink/90">
                  {task}
                </div>
              </div>
            ) : null}
            <div className={`w-full border-l-2 pl-4 ${running ? 'border-gold/25' : 'border-gold/45'}`}>
              <ProcessTimeline msg={assistantMsg} />
              {answer ? <SwarmResult answer={answer} streaming={running} /> : null}
              {!answer && !running ? (
                <div className="text-[12px] text-mute/60">
                  {data?.messages?.length
                    ? t('（这一步没有留下交付物，上面是它跑过的工具）')
                    : t('（这一步没有留下交付物）')}
                </div>
              ) : null}
              {running && assistantMsg.startedAt ? <WorkingStatus startedAt={assistantMsg.startedAt} className="mt-2" /> : null}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
