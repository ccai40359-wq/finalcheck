import React from 'react';

// 出错回合下的「继续」按钮：错误文案里写了「可点继续」，但按钮之前根本不存在（文案与 UI 脱节的真 bug）。
// 抽成组件是为了能在独立 harness 里真实渲染 + 点击验证（子代理没有浏览器，视觉自检在主会话做）。
export function ContinueButton({ onClick, disabled = false }) {
  return (
    <button data-testid="continue-btn" onClick={onClick} disabled={disabled}
      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-gold/40 bg-gold/[0.08] px-2.5 py-1 text-[11px] text-goldSoft hover:bg-gold/[0.16] transition-colors">
      ↻ 继续
    </button>
  );
}

// 什么样的错误值得给「继续」：证据还在时间线里、或者只是预算/网关抖动。
// 402（余额不足）这类不给——点了也白点。
export function errorIsRecoverable(error) {
  const t = String(error || '');
  return t.includes('时间线') || t.includes('预算') || t.includes('收尾');
}
