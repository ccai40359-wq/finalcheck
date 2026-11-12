// 验收单卡片（todo_write）：会话内容区右上角的 absolute 覆盖层（ZCode 样式），不占布局宽度。
// 数据源：
// - 实时：msg.events 里的 todo_write 工具条目（tool-start 带 args；同一回合多次调用只渲染最新一张）
// - 历史：msg.trace 里的 todo_write tool part（args 落库，结果从 result 还原）——不改会话 schema
// 状态机：pending ☐ / running ◐ / done ✓ / failed ✕ / skipped —
// 外观（对齐 ZCode）：单卡单边框；头部一行「验收单 + 首条任务 + done/total + 右上角折叠箭头」；
//   展开后是未完成项、Progress 行（细进度条）、「n 已完成」折叠条（默认收起）。
// 整卡折叠：默认展开；展开=右上方浮层卡片，折叠=右上角小 chip；状态按 sessionId + 任务 id 签名存 localStorage。
// 布局：TodoPanel 自己就是 absolute overlay（见 MessageList），覆盖在消息列上而不挤占宽度；
//   外层 pointer-events-none 让透明区域可穿透滚动，卡片/chip 再打开 pointer-events-auto。
import React, { useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n/core.mjs';
import {
  todoCardSummary, todoCollapseKey, todoFromMessage,
  readTodoCollapsed, writeTodoCollapsed, displayStatus
} from '../lib/todo.mjs';

// 按「展示态」着色：interrupted 是 running 在回合已结束后的展示（灰、无脉冲），
// 数据里的 status 仍然是 running（见 lib/todo.mjs displayStatus）。
const STATUS_META = {
  pending: { box: 'text-mute/55', labelCls: 'text-mute/45' },
  running: { box: 'text-goldSoft animate-pulse motion-reduce:animate-none', labelCls: 'text-mute/50' },
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
      className={`transition-transform duration-150 motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`}>
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

// 折叠状态：按 sessionId + 任务 id 签名存 localStorage；浮层与卡片共用一个 hook，
// 展开=右上角卡片，折叠=右上角小 chip（不再按宽度自动折叠）。
function useTodoCollapse(sessionId, items) {
  const storageKey = todoCollapseKey(sessionId, items);
  const [collapsed, setCollapsed] = useState(() => readTodoCollapsed(storageKey));
  const keyRef = useRef(storageKey);

  // 切换到另一张卡/另一个会话时重新读一次折叠状态（同一张卡内不覆盖用户操作）
  useEffect(() => {
    if (keyRef.current === storageKey) return;
    keyRef.current = storageKey;
    setCollapsed(readTodoCollapsed(storageKey));
  }, [storageKey]);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      writeTodoCollapsed(storageKey, next);
      return next;
    });
  };

  return [collapsed, toggle];
}

// live：这条消息所属回合是否仍在流式（true/false）。false 时 running 展示为「已中断」，
// 避免停止/崩溃后卡片永远转圈（数据不动，只改展示）。
// pinned：overlay 浮层形态（不占布局宽度、max-h-full、pointer-events-auto、带浮起阴影）；
// collapsed / onToggle：由 TodoPanel 受控（浮层展开=卡片，折叠=chip）；
// toggleRef：展开后把焦点还给卡片内的折叠按钮。
export default function TodoCard({
  items = [], error = null, sessionId = null, live = true,
  pinned = false, collapsed: collapsedProp, onToggle = null, toggleRef = null, bodyId = null
}) {
  const list = Array.isArray(items) ? items : [];
  const summary = todoCardSummary(list);
  const [innerCollapsed, toggleInner] = useTodoCollapse(sessionId, list);
  const autoBodyId = useId();
  const contentId = bodyId || autoBodyId;
  const controlled = typeof collapsedProp === 'boolean';
  const collapsed = controlled ? collapsedProp : innerCollapsed;
  const [showDone, setShowDone] = useState(false);

  if (!list.length && !error) return null;

  const toggleCollapsed = () => {
    if (controlled) onToggle?.();
    else toggleInner();
  };

  // done 只出现在折叠区；其余状态留在主列表，长清单在卡片内滚动。
  const active = list.filter((it) => it.status !== 'done');
  const completed = list.filter((it) => it.status === 'done');
  const countText = `${summary.done}/${summary.total}`;
  const rootCls = pinned
    ? `pointer-events-auto flex w-full max-w-[320px] min-h-0 max-h-full flex-col overflow-hidden rounded-xl border border-gold/35 bg-[#0b0b0c] shadow-[0_12px_36px_rgba(0,0,0,0.55)]`
    : `my-3 flex overflow-hidden rounded-xl border border-gold/35 bg-[#0b0b0c] animate-[fadeIn_.2s_ease] motion-reduce:animate-none ${
      collapsed ? '' : 'max-h-[420px] flex-col'
    }`;

  return (
    <div data-testid="todo-card" data-done={summary.done} data-total={summary.total}
      data-collapsed={collapsed ? 'true' : 'false'}
      className={rootCls}>
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
        <button type="button" data-testid="todo-collapse" ref={toggleRef} onClick={toggleCollapsed}
          aria-expanded={!collapsed} aria-controls={contentId}
          aria-label={collapsed ? t('展开验收单') : t('收起验收单')}
          title={collapsed ? t('展开验收单') : t('收起验收单')}
          className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-mute/55 transition-colors motion-reduce:transition-none hover:bg-white/[0.06] hover:text-goldSoft focus-visible:bg-white/[0.10] focus-visible:text-goldSoft focus-visible:shadow-[inset_0_0_0_1px_rgba(227,197,107,0.55)] focus-visible:outline-none">
          <ChevronIcon collapsed={collapsed} />
        </button>
      </div>

      {!collapsed ? (
        <div id={contentId} className="flex min-h-0 flex-1 flex-col">
          {error ? (
            <div data-testid="todo-error"
              className="shrink-0 bg-red-500/[0.07] px-3.5 py-2 text-[11px] leading-relaxed text-red-300/90 break-words">
              {error}
            </div>
          ) : null}

          <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
              <div className="h-full rounded-full bg-jade/75 transition-[width] duration-300 ease-out motion-reduce:transition-none"
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
                  className="flex min-h-6 w-full items-center gap-1.5 px-3.5 py-[6px] text-left text-[10.5px] tabular-nums text-mute/60 transition-colors hover:bg-white/[0.03] hover:text-mute/85 focus-visible:bg-white/[0.06] focus-visible:text-mute/85 focus-visible:outline-none">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                    className={`shrink-0 transition-transform duration-150 ${showDone ? '-rotate-90' : ''}`}>
                    <path d="M15 18l-6-6 6-6" />
                  </svg>
                  <span>{t('{n} 已完成', { n: completed.length })}</span>
                </button>
                {showDone ? (
                  <ul data-testid="todo-done-list" className="max-h-[210px] overflow-y-auto overscroll-contain">
                    {completed.map((it, i) => <TodoRow key={`${it.id}-done-${i}`} item={it} done />)}
                  </ul>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 常驻浮层：absolute 覆盖在会话内容区右上角（由 MessageList 挂进消息列的 relative 容器）。
 * - 展开：卡片宽度 min(320px, 会话列可用宽度)，max-h-full，超出在卡片内滚动；
 * - 折叠：右上角小 chip（仍 absolute，不占布局宽度）；
 * - 外层 pointer-events-none：透明区域可继续滚动/选中消息，只有卡片/chip 接收事件；
 * - Esc 只在焦点位于浮层内时收起（不处理 Composer 里的 Esc，避免和清空输入冲突），
 *   收起后焦点还给 chip；展开时焦点落到卡片折叠按钮。
 * - 不再按会话列宽度自动折叠：浮层不占宽，窄屏/右面板打开时用户仍能自己开合。
 */
export function TodoPanel({ items = [], error = null, sessionId = null, live = true }) {
  const list = Array.isArray(items) ? items : [];
  const summary = todoCardSummary(list);
  const bodyId = useId();
  const [collapsed, toggleCollapse] = useTodoCollapse(sessionId, list);
  const chipRef = useRef(null);
  const cardToggleRef = useRef(null);
  const focusTargetRef = useRef(null);

  // 折叠/展开会卸载当前焦点节点，state 生效后把焦点交给另一形态的折叠按钮。
  useEffect(() => {
    if (focusTargetRef.current === 'chip' && collapsed) {
      focusTargetRef.current = null;
      chipRef.current?.focus();
    } else if (focusTargetRef.current === 'card' && !collapsed) {
      focusTargetRef.current = null;
      cardToggleRef.current?.focus();
    }
  }, [collapsed]);

  if (!list.length && !error) return null;

  const handleToggle = () => {
    focusTargetRef.current = collapsed ? 'card' : 'chip';
    toggleCollapse();
  };

  const handleKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    // 焦点在浮层内：Esc 归浮层处理，不再传给全局（Composer 的 Esc 清空输入不受影响）
    e.preventDefault();
    e.stopPropagation();
    if (collapsed || e.repeat) return;
    focusTargetRef.current = 'chip';
    toggleCollapse();
  };

  return (
    <aside data-testid="todo-panel-overlay" data-collapsed={collapsed ? 'true' : 'false'}
      aria-label={t('验收单面板')} onKeyDown={handleKeyDown}
      className="pointer-events-none absolute inset-y-0 right-0 z-30 flex w-full max-w-full flex-col items-end p-4">
      {collapsed ? (
        <button type="button" data-testid="todo-chip" ref={chipRef} onClick={handleToggle}
          data-done={summary.done} data-total={summary.total}
          aria-controls={bodyId} aria-expanded="false" aria-label={t('展开验收单')} title={t('展开验收单')}
          className="pointer-events-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-gold/35 bg-[#0b0b0c]/95 px-2.5 text-[11px] leading-none text-goldSoft shadow-[0_6px_20px_rgba(0,0,0,0.45)] backdrop-blur-sm transition-colors motion-reduce:transition-none hover:border-gold/70 hover:bg-[#141210]/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0c]">
          <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-[2px] bg-gold/50" />
          <span className="font-medium tracking-[0.12em]">{t('验收单')}</span>
          <span className="tabular-nums text-goldSoft/85">{summary.done}/{summary.total}</span>
          <ChevronIcon collapsed={false} />
        </button>
      ) : (
        <TodoCard items={list} error={error} sessionId={sessionId} live={live} pinned
          collapsed={false} onToggle={handleToggle} toggleRef={cardToggleRef} bodyId={bodyId} />
      )}
    </aside>
  );
}

/**
 * 历史轮次的验收单：当前最新一份已经在右上角面板里，消息流里不再重复整卡；
 * 旧回合只留一行灰字摘要（只读、不可折叠/展开），保住「这一轮产出过什么清单」的叙事。
 */
export function TodoHistoryRow({ msg }) {
  const data = todoFromMessage(msg);
  if (!data) return null;
  const { items, error } = data;
  const summary = todoCardSummary(items);
  const label = t('本轮验收单 {done}/{total}', { done: summary.done, total: summary.total });
  return (
    <div data-testid="todo-history" aria-label={label} title={error || summary.firstTask || label}
      className="my-2 flex min-w-0 items-center gap-2 text-[11px] leading-relaxed text-mute/35">
      <span aria-hidden="true" className="inline-block h-[3px] w-3 shrink-0 rounded-full bg-white/10" />
      <span className="shrink-0 tracking-[0.12em]">{t('验收单')}</span>
      <span className="shrink-0 tabular-nums">{summary.done}/{summary.total}</span>
      {summary.firstTask ? <span className="min-w-0 truncate">{summary.firstTask}</span> : null}
      {summary.failed ? (
        <span className="shrink-0 text-red-300/50">{t('失败 {n}', { n: summary.failed })}</span>
      ) : null}
    </div>
  );
}
