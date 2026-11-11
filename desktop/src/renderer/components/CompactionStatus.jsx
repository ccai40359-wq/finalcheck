// 上下文压缩的进行中活动行（ZCode「Compressing context」语义：等同一次任务在跑，不是压缩完才冒一行灰字）。
// 输入区/停止键/排队规则由 App 复用现有的 running 状态（runningIds），这里只负责这条活动行：
// - running：呼吸点 +「正在压缩上下文…」（.12s 延迟出现，本地瞬时压缩不会闪一下）
// - failed：一行红字「压缩失败：…」，静态、不转圈
// - done / idle：不渲染 —— 完成提示由会话里已落库的 notice 负责，避免出现两条重复提示
import React from 'react';
import { t } from '../i18n/core.mjs';

export default function CompactionStatus({ state }) {
  const phase = state?.phase;
  if (phase !== 'running' && phase !== 'failed') return null;

  if (phase === 'failed') {
    return (
      <div className="shrink-0 px-5 pb-1" data-testid="compaction-status" data-phase="failed">
        <div className="w-full max-w-[96%] mx-auto">
          <div role="status"
            className="inline-flex max-w-full items-center gap-2 rounded-full border border-red-500/35 bg-red-500/[0.06] px-3 py-1 text-[11px] text-red-300">
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
            <span className="truncate">{t('压缩失败：{msg}', { msg: state.error || t('未知原因') })}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 px-5 pb-1" data-testid="compaction-status" data-phase="running">
      <div className="w-full max-w-[96%] mx-auto">
        <div role="status" aria-live="polite"
          className="fc-compact-row inline-flex items-center gap-2 rounded-full border border-gold/25 bg-gold/[0.05] px-3 py-1 text-[11px] text-goldSoft">
          <span aria-hidden="true" className="fc-compact-dots inline-flex items-center gap-[3px]">
            <span className="fc-compact-dot h-1 w-1 rounded-full bg-goldSoft" />
            <span className="fc-compact-dot h-1 w-1 rounded-full bg-goldSoft" />
            <span className="fc-compact-dot h-1 w-1 rounded-full bg-goldSoft" />
          </span>
          <span className="tracking-wide">{t('正在压缩上下文…')}</span>
        </div>
      </div>
    </div>
  );
}
