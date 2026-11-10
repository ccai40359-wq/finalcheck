// 验收单卡片（todo_write）：插在助手消息里，实时显示每条任务的勾选状态与验收标准。
// 数据源：
// - 实时：msg.events 里的 todo_write 工具条目（tool-start 带 args；同一回合多次调用只渲染最新一张）
// - 历史：msg.trace 里的 todo_write tool part（args 落库，结果从 result 还原）——不改会话 schema
// 状态机：pending ☐ / running ◐ / done ☑ / failed ✕ / skipped —
import React from 'react';
import { t } from '../i18n/core.mjs';
import { latestTodoEntry, todoCardFromTrace, todoProgress } from '../lib/todo.mjs';

const MARKS = {
  pending: { icon: '☐', cls: 'text-mute/60' },
  running: { icon: '◐', cls: 'text-goldSoft animate-pulse' },
  done: { icon: '☑', cls: 'text-jade' },
  failed: { icon: '✕', cls: 'text-red-400' },
  skipped: { icon: '—', cls: 'text-mute/45' }
};

function statusLabel(status) {
  if (status === 'running') return t('进行中');
  if (status === 'done') return t('已完成');
  if (status === 'failed') return t('失败');
  if (status === 'skipped') return t('已跳过');
  return t('待做');
}

export default function TodoCard({ items = [], error = null }) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length && !error) return null;
  const p = todoProgress(list);
  return (
    <div data-testid="todo-card" data-done={p.done} data-total={p.total}
      className="my-3 rounded-xl border border-gold/30 bg-gold/[0.04] px-4 py-3 animate-[fadeIn_.2s_ease]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="badge shrink-0 bg-gold/15 text-goldSoft border border-gold/40">{t('验收单')}</span>
        <span data-testid="todo-progress" className="text-[11px] tabular-nums text-mute/65">
          {t('{done}/{total} 完成', { done: p.done, total: p.total })}
        </span>
        {p.failed ? <span className="text-[10px] text-red-300/85">{t('失败 {n}', { n: p.failed })}</span> : null}
        {p.skipped ? <span className="text-[10px] text-mute/55">{t('跳过 {n}', { n: p.skipped })}</span> : null}
      </div>

      <ul className="mt-2 space-y-1.5">
        {list.map((it, i) => {
          const mark = MARKS[it.status] || MARKS.pending;
          return (
            <li key={`${it.id}-${i}`} data-testid="todo-item" data-status={it.status}
              className="flex items-start gap-2 min-w-0">
              <span aria-hidden="true" title={statusLabel(it.status)}
                className={`mt-[1px] shrink-0 select-none text-[13px] leading-5 ${mark.cls}`}>{mark.icon}</span>
              <div className="min-w-0 flex-1">
                <div className={`text-[12.5px] leading-relaxed break-words ${it.status === 'done' ? 'text-ink/70 line-through decoration-mute/30' : 'text-ink/90'}`}>
                  {it.task || t('(未命名任务)')}
                </div>
                <div className="text-[11px] leading-relaxed text-mute/55 break-words">
                  {t('验收：{acceptance}', { acceptance: it.acceptance || t('(未写验收标准)') })}
                </div>
                {it.evidence ? (
                  <div className="text-[10.5px] leading-relaxed text-mute/40 break-words">
                    {t('证据：{evidence}', { evidence: it.evidence })}
                  </div>
                ) : null}
              </div>
              <span className="shrink-0 text-[10px] leading-5 text-mute/40">{statusLabel(it.status)}</span>
            </li>
          );
        })}
      </ul>

      {error ? (
        <div data-testid="todo-error"
          className="mt-2 rounded-lg border border-red-500/30 bg-red-500/[0.08] px-2.5 py-1.5 text-[11px] leading-relaxed text-red-300/90 break-words">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** 助手消息里的验收单块：实时看 events，完成后看 trace（两者都只有最新一张卡） */
export function TodoBlock({ msg }) {
  if (!msg || msg.role !== 'assistant') return null;
  const source = msg.streaming
    ? (msg.events || [])
    : (msg.trace?.length ? msg.trace : (msg.events || []));
  const entry = latestTodoEntry(source);
  if (!entry) return null;
  const { items, error } = todoCardFromTrace(entry);
  return <TodoCard items={items} error={error} />;
}
