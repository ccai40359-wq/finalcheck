import React, { forwardRef, useState } from 'react';
import { t } from '../i18n/core.mjs';

export const api = () => (typeof window !== 'undefined' ? window.finalcheck : undefined);

/** severity → 配色（红 / 琥珀 / 金） */
export const sevStyle = {
  high: 'bg-red-500/15 text-red-400 border border-red-500/30',
  medium: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  low: 'bg-gold/15 text-goldSoft border border-gold/30'
};
export const sevLabel = { high: '高危', medium: '中危', low: '低危' };

export const SEV_ORDER = { high: 0, medium: 1, low: 2 };

// AgentPage 给 Card 传 ref（聊天滚动到底用）——函数组件须 forwardRef 才能接（console error 修复）
export const Card = forwardRef(function Card({ className = '', children, ...rest }, ref) {
  return (
    <div ref={ref} className={`glass-card rounded-2xl ${className}`} {...rest}>
      {children}
    </div>
  );
});

export function SectionTitle({ children, right }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-sm font-semibold text-mute uppercase tracking-wider">{children}</h2>
      {right}
    </div>
  );
}

/** 带已复制反馈的复制按钮 */
export function CopyButton({ text, children, className = '' }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button
      onClick={onCopy}
      className={`btn-ghost text-xs px-2.5 py-1 ${copied ? '!bg-emerald-600/20 !text-emerald-400 !border-emerald-600/40' : ''} ${className}`}
    >
      {copied ? t('已复制') : (children ?? t('复制修复提示词'))}
    </button>
  );
}

export function Empty({ children }) {
  return <div className="text-center text-mute text-sm py-10">{children}</div>;
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm px-4 py-3 transition-all duration-200">
      {children}
    </div>
  );
}
