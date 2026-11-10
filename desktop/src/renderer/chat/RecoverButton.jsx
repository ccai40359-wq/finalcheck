import React from 'react';

// ZCode 的 recover 键：只在中断/失败的工作流卡片底栏出现（输入框那一排不再有它）。
// 抽成组件是为了能在独立 harness 里真实渲染 + 点击验证（视觉自检由主会话做）。
export function RecoverButton({ onClick, disabled = false, title = '恢复上一回合：带着已有证据继续，不重复跑过的步骤', compact = false }) {
  return (
    <button data-testid="recover-btn" onClick={onClick} disabled={disabled}
      title={title}
      className={`shrink-0 flex items-center justify-center transition-colors duration-200 ${compact ? 'h-6 w-6 rounded-md border border-gold/35 text-goldSoft/85 hover:border-gold/60 hover:bg-gold/15 hover:text-goldSoft' : 'ml-1.5 h-7 w-7 rounded-[9px] border border-gold/45 text-goldSoft hover:bg-gold/15'}`}>
      <svg width={compact ? 11 : 12} height={compact ? 11 : 12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4v6h6" /><path d="M4.6 10a9 9 0 1 0 3.2-6.4" />
      </svg>
    </button>
  );
}
