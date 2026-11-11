// 验收单卡片（todo_write）：插在助手消息里，实时显示每条任务的勾选状态与验收标准。
// 数据源：
// - 实时：msg.events 里的 todo_write 工具条目（tool-start 带 args；同一回合多次调用只渲染最新一张）
// - 历史：msg.trace 里的 todo_write tool part（args 落库，结果从 result 还原）——不改会话 schema
// 状态机：pending ☐ / running ◐ / done ✓ / failed ✕ / skipped —
// 外观（对齐 ZCode）：单卡单边框；头部一行「验收单 + 首条任务 + done/total + 右上角折叠箭头」；
//   展开后是未完成项、Progress 行（细进度条）、「n 已完成」折叠条（默认收起）。
// 整卡折叠：默认展开；折叠后只剩头部一行，状态按 sessionId + 任务 id 签名存 localStorage（切会话/刷新不丢）。
import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/core.mjs';
import {
  latestTodoEntry, todoCardFromTrace, todoCardSummary, todoCollapseKey,
  readTodoCollapsed, writeTodoCollapsed, displayStatus
} from '../lib/todo.mjs';

// 按「展示态」着色：interrupted 是 running 在回合已结束后的展示（灰、无脉冲），
// 数据里的 status 仍然是 running（见 lib/todo.mjs displayStatus）。
const STATUS_META = {
  pending: { box: 'text-mute/55', labelCls: 'text-mute/45' },
  running: { box: 'text-goldSoft animate-pulse', labelCls: 'text-mute/50' },
  done: { box: 'rounded-[3px] bg-jade/15 text-jade', labelCls: 'text-mute/40' },
  failed: { box: 'text-red-400', labelCls: 'text-red-300/75' },
  skipped: { box: 'text-mute/30', labelCls: 'text-mute/40' },
  interrupted: { box: 'text-mute/35', labelCls: 'text-mute/45' }
};

function metaOf(status) {
  return STATUS_META[status] || STATUS_META.pending;
}

// 分割线用 1px 底色条，而不是 border：整卡只保留最外层一条边框（用户要求「最多一个框」）。
function Separator() {
  return <div role="presentation" aria-hidden="true" className="h-px shrink-0 bg-white/[0.06]" />;
}

function ChevronIcon({ collapsed }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={`transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function TodoRow({ item, done = false, live = true }) {
  const view = displayStatus(item, live);
  const meta = metaOf(view.status);
  return (
    <li data-testid="todo-item" data-status={item.status} data-display-status={view.status}
      className="flex items-start gap-2 px-3.5 py-[6px] min-w-0">
      <span aria-hidden="true" title={view.label}
        className={`mt-[2px] inline-flex h-[14px] w-[14px] shrink-0 select-none items-center justify-center text-[10px] leading-none ${meta.box}`}>
        {view.mark}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className={`min-w-0 flex-1 break-words text-[12.5px] leading-[1.55] ${
            done ? 'text-ink/45' : (item.status === 'failed' ? 'text-ink/80' : 'text-ink/90')
          }`}>
            {item.task || t('(未命名任务)')}
          </span>
          <span className={`shrink-0 text-[10px] leading-[1.7] ${meta.labelCls}`}>{view.label}</span>
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

// live：这条消息所属回合是否仍在流式（true/false）。false 时 running 展示为「已中断」，
// 避免停止/崩溃后卡片永远转圈（数据不动，只改展示）。
export default function TodoCard({ items = [], error = null, sessionId = null, live = true }) {
  const list = Array.isArray(items) ? items : [];
  const summary = todoCardSummary(list);
  const storageKey = todoCollapseKey(sessionId, list);
  const [collapsed, setCollapsed] = useState(() => readTodoCollapsed(storageKey));
  const [showDone, setShowDone] = useState(false);
  const keyRef = useRef(storageKey);

  // 切换到另一张卡/另一个会话时重新读一次折叠状态（同一张卡内不覆盖用户操作）
  useEffect(() => {
    if (keyRef.current === storageKey) return;
    keyRef.current = storageKey;
    setCollapsed(readTodoCollapsed(storageKey));
  }, [storageKey]);

  if (!list.length && !error) return null;

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeTodoCollapsed(storageKey, next);
      return next;
    });
  };

  // done 只出现在折叠区；其余状态留在主列表，长清单在卡片内滚动。
  const active = list.filter((it) => it.status !== 'done');
  const completed = list.filter((it) => it.status === 'done');
  const countText = `${summary.done}/${summary.total}`;

  return (
    <div data-testid="todo-card" data-done={summary.done} data-total={summary.total}
      data-collapsed={collapsed ? 'true' : 'false'}
      className={`my-3 flex overflow-hidden rounded-xl border border-gold/35 bg-[#0b0b0c] animate-[fadeIn_.2s_ease] ${
        collapsed ? '' : 'max-h-[420px] flex-col'
      }`}>
      {/* 头部：左侧标题 + 首条任务概览，右侧计数，最右整卡折叠箭头（卡片自己的右上角） */}
      <div className="flex w-full shrink-0 items-center gap-2 px-3.5 py-[7px]">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-[2px] bg-gold/50" />
          <span className="shrink-0 text-[11.5px] font-medium tracking-[0.14em] text-goldSoft">{t('验收单')}</span>
          {!collapsed && summary.firstTask ? (
            <span className="min-w-0 truncate text-[11px] leading-relaxed text-mute/40" title={summary.firstTask}>
              · {summary.firstTask}
            </span>
          ) : null}
        </div>
        {!collapsed && summary.failed ? (
          <span className="shrink-0 text-[10px] text-red-300/80">{t('失败 {n}', { n: summary.failed })}</span>
        ) : null}
        {!collapsed && summary.skipped ? (
          <span className="shrink-0 text-[10px] text-mute/45">{t('跳过 {n}', { n: summary.skipped })}</span>
        ) : null}
        <span data-testid="todo-count" title={t('{done}/{total} 完成', { done: summary.done, total: summary.total })}
          className="shrink-0 text-[10.5px] font-medium tabular-nums text-goldSoft/85">
          {countText}
        </span>
        <button type="button" data-testid="todo-collapse" onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('展开验收单') : t('收起验收单')}
          title={collapsed ? t('展开验收单') : t('收起验收单')}
          className="-mr-1 inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-mute/55 transition-colors hover:bg-white/[0.06] hover:text-goldSoft">
          <ChevronIcon collapsed={collapsed} />
        </button>
      </div>

      {!collapsed ? (
        <>
          {error ? (
            <div data-testid="todo-error"
              className="shrink-0 bg-red-500/[0.07] px-3.5 py-2 text-[11px] leading-relaxed text-red-300/90 break-words">
              {error}
            </div>
          ) : null}

          <ul className="min-h-0 flex-1 overflow-y-auto">
            {active.length ? active.map((it, i) => <TodoRow key={`${it.id}-${i}`} item={it} live={live} />) : (
              <li className="px-3.5 py-2 text-[11px] leading-relaxed text-mute/40">{t('全部完成')}</li>
            )}
          </ul>

          <Separator />
          {/* Progress：细进度条 + 计数（纯 CSS 宽度百分比） */}
          <div data-testid="todo-progress-row" className="flex shrink-0 items-center gap-2.5 px-3.5 py-[6px]">
            <span className="shrink-0 text-[10.5px] tracking-[0.06em] text-mute/45">{t('进度')}</span>
            <div role="progressbar" aria-label={t('进度')} aria-valuemin={0} aria-valuemax={Math.max(summary.total, 1)}
              aria-valuenow={summary.done} data-testid="todo-progress-bar"
              className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
              <div className="h-full rounded-full bg-jade/75 transition-[width] duration-300 ease-out"
                style={{ width: `${summary.percent}%` }} />
            </div>
            <span className="shrink-0 text-[10.5px] tabular-nums text-mute/50">{countText}</span>
          </div>

          {completed.length ? (
            <>
              <Separator />
              <div className="shrink-0">
                <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}
                  aria-label={showDone ? t('收起已完成条目') : t('展开已完成条目')}
                  className="flex w-full items-center gap-1.5 px-3.5 py-[6px] text-left text-[10.5px] tabular-nums text-mute/60 transition-colors hover:bg-white/[0.03] hover:text-mute/85">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                    className={`shrink-0 transition-transform duration-150 ${showDone ? '-rotate-90' : ''}`}>
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                  <span>{t('{n} 已完成', { n: completed.length })}</span>
                </button>
                {showDone ? (
                  <ul data-testid="todo-done-list" className="max-h-[210px] overflow-y-auto">
                    {completed.map((it, i) => <TodoRow key={`${it.id}-done-${i}`} item={it} done />)}
                  </ul>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** 助手消息里的验收单块：实时看 events，完成后看 trace（两者都只有最新一张卡） */
export function TodoBlock({ msg, sessionId = null }) {
  if (!msg || msg.role !== 'assistant') return null;
  const live = !!msg.streaming; // 回合是否仍在流式：停止/收尾后 running 一律展示为「已中断」
  const source = msg.streaming
    ? (msg.events || [])
    : (msg.trace?.length ? msg.trace : (msg.events || []));
  const entry = latestTodoEntry(source);
  if (!entry) return null;
  const { items, error } = todoCardFromTrace(entry);
  return <TodoCard items={items} error={error} sessionId={sessionId} live={live} />;
}
