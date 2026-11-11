// 验收单卡片（todo_write）：插在助手消息里，实时显示每条任务的勾选状态与验收标准。
// 数据源：
// - 实时：msg.events 里的 todo_write 工具条目（tool-start 带 args；同一回合多次调用只渲染最新一张）
// - 历史：msg.trace 里的 todo_write tool part（args 落库，结果从 result 还原）——不改会话 schema
// 状态机：pending ☐ / running ◐ / done ✓ / failed ✕ / skipped —
// 外观：金框圆角单卡；未完成项逐行展示，done 项收进底部「n 已完成」折叠区（默认收起）。
import React, { useState } from 'react';
import { t } from '../i18n/core.mjs';
import { latestTodoEntry, todoCardFromTrace, todoProgress } from '../lib/todo.mjs';

const STATUS_META = {
  pending: { mark: '☐', label: '待做', box: 'text-mute/55', labelCls: 'text-mute/45' },
  running: { mark: '◐', label: '进行中', box: 'text-goldSoft animate-pulse', labelCls: 'text-mute/50' },
  done: { mark: '✓', label: '完成', box: 'rounded-[3px] bg-jade/15 text-jade', labelCls: 'text-mute/40' },
  failed: { mark: '✕', label: '失败', box: 'text-red-400', labelCls: 'text-red-300/75' },
  skipped: { mark: '—', label: '跳过', box: 'text-mute/30', labelCls: 'text-mute/40' }
};

function metaOf(status) {
  return STATUS_META[status] || STATUS_META.pending;
}

function TodoRow({ item, done = false }) {
  const meta = metaOf(item.status);
  return (
    <li data-testid="todo-item" data-status={item.status}
      className="flex items-start gap-2 px-3.5 py-[5px] min-w-0">
      <span aria-hidden="true" title={t(meta.label)}
        className={`mt-[2px] inline-flex h-[14px] w-[14px] shrink-0 select-none items-center justify-center text-[10px] leading-none ${meta.box}`}>
        {meta.mark}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className={`min-w-0 flex-1 break-words text-[12.5px] leading-[1.55] ${
            done ? 'text-ink/45' : (item.status === 'failed' ? 'text-ink/80' : 'text-ink/90')
          }`}>
            {item.task || t('(未命名任务)')}
          </span>
          <span className={`shrink-0 text-[10px] leading-[1.7] ${meta.labelCls}`}>{t(meta.label)}</span>
        </div>
        <div className={`mt-[1px] break-words text-[11px] leading-[1.55] ${done ? 'text-mute/30' : 'text-mute/45'}`}>
          {t('验收：{acceptance}', { acceptance: item.acceptance || t('(未写验收标准)') })}
        </div>
        {item.evidence ? (
          <div className={`mt-[1px] break-words text-[10.5px] leading-[1.55] ${done ? 'text-mute/45' : 'text-mute/40'}`}>
            {t('证据：{evidence}', { evidence: item.evidence })}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export default function TodoCard({ items = [], error = null }) {
  const list = Array.isArray(items) ? items : [];
  const [showDone, setShowDone] = useState(false);
  if (!list.length && !error) return null;
  const p = todoProgress(list);
  // done 只出现在折叠区；其余状态留在主列表，长清单在卡片内滚动。
  const active = list.filter((it) => it.status !== 'done');
  const completed = list.filter((it) => it.status === 'done');
  return (
    <div data-testid="todo-card" data-done={p.done} data-total={p.total}
      className="my-3 flex max-h-[420px] flex-col overflow-hidden rounded-xl border border-gold/35 bg-[#0b0b0c] divide-y divide-white/[0.06] animate-[fadeIn_.2s_ease]">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium tracking-[0.14em] text-goldSoft">
          <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-[2px] bg-gold/50" />
          <span className="truncate">{t('验收单')}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {p.failed ? <span className="text-[10px] text-red-300/80">{t('失败 {n}', { n: p.failed })}</span> : null}
          {p.skipped ? <span className="text-[10px] text-mute/45">{t('跳过 {n}', { n: p.skipped })}</span> : null}
          <span data-testid="todo-progress"
            className="inline-flex items-center rounded-full bg-gold/10 px-2 py-[1px] text-[10.5px] font-medium tabular-nums text-goldSoft">
            {t('{done}/{total} 完成', { done: p.done, total: p.total })}
          </span>
        </span>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto divide-y divide-white/[0.06]">
        {active.length ? active.map((it, i) => <TodoRow key={`${it.id}-${i}`} item={it} />) : (
          <li className="px-3.5 py-2 text-[11px] leading-relaxed text-mute/40">{t('全部完成')}</li>
        )}
      </ul>

      {error ? (
        <div data-testid="todo-error"
          className="shrink-0 bg-red-500/[0.07] px-3.5 py-2 text-[11px] leading-relaxed text-red-300/90 break-words">
          {error}
        </div>
      ) : null}

      {completed.length ? (
        <div className="shrink-0">
          <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}
            aria-label={showDone ? t('收起已完成条目') : t('展开已完成条目')}
            className="flex w-full items-center gap-1.5 px-3.5 py-[5px] text-left text-[10.5px] tabular-nums text-mute/60 transition-colors hover:bg-white/[0.03] hover:text-mute/85">
            <span aria-hidden="true"
              className={`inline-block text-[9px] transition-transform duration-150 ${showDone ? 'rotate-90' : ''}`}>▸</span>
            <span>{t('{n} 已完成', { n: completed.length })}</span>
          </button>
          {showDone ? (
            <ul data-testid="todo-done-list" className="max-h-[210px] overflow-y-auto divide-y divide-white/[0.06]">
              {completed.map((it, i) => <TodoRow key={`${it.id}-done-${i}`} item={it} done />)}
            </ul>
          ) : null}
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
