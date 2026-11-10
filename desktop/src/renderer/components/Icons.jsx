// 内联 SVG 图标（stroke 继承 currentColor）：从 App.jsx 原样搬出，DOM/属性一字未改。
import React from 'react';

// 能力卡图标映射（CAPABILITIES 里的 icon 名 → 组件；play 目前没有能力卡用到，保留兼容）
export const CAP_ICON = { shield: IconShield, radar: IconRadar, download: IconDownload, flow: IconFlow, report: IconReport, terminal: IconTerminal, play: IconPlay };

// 会话「正在跑」的转圈（苹果式 8 段 spinner）
export function Spinner({ size = 11, className = '', ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={`fc-spin ${className}`} aria-hidden="true" {...rest}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <rect key={i} x="11" y="2.4" width="2" height="5.6" rx="1" fill="currentColor"
          opacity={0.15 + i * 0.106} transform={`rotate(${i * 45} 12 12)`} />
      ))}
    </svg>
  );
}

// 新建会话：圆圈加号（ZCode 的 New Session 图标）
export function IconPlusCircle() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

// 添加项目文件夹：方框 + 右上角加号（对齐 ZCode workspace 图标）
export function IconFolderPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13.5V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5.5" />
      <path d="M18 3v6M15 6h6" />
    </svg>
  );
}

export function IconPlus() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// 上下文用量：只有一个小圆圈（hover 看明细）；颜色按占用率变化
export function ContextRing({ percent = 0 }) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const r = 7.5;
  const c = 2 * Math.PI * r;
  const color = p >= 85 ? '#f87171' : p >= 60 ? '#fbbf24' : '#34d399';
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="block">
      <circle cx="10" cy="10" r={r} fill="none" stroke="#3a3a42" strokeWidth="2.5" />
      <circle cx="10" cy="10" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={`${Math.max(0.6, (p / 100) * c)} ${c}`} transform="rotate(-90 10 10)" />
    </svg>
  );
}

export function IconCopy() {  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

export function IconChevron() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export function IconEdit() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export function IconFolder({ active }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 ${active ? 'text-goldSoft' : 'text-mute/60'}`}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}
export function IconArchive() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" rx="1" />
      <polyline points="10 12.5 12 14.5 14 12.5" />
    </svg>
  );
}
export function IconUnarchive() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" rx="1" />
      <path d="M12 18.5v-6" />
      <polyline points="9.5 15 12 12.5 14.5 15" />
    </svg>
  );
}
// 粘贴文本块图标（剪贴板）：小号、灰色，不抢金色语义
export function IconPaste() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      className="shrink-0 text-mute/55">
      <rect x="8" y="3" width="8" height="3" rx="1" />
      <path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
      <path d="M8 11h8M8 15h5" />
    </svg>
  );
}
export function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" /><path d="M14 11v6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
export function IconSparkle() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="text-goldSoft shrink-0">
      <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  );
}
export function IconShield() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z" />
      <polyline points="9 11.5 11.2 13.7 15.5 9.5" />
    </svg>
  );
}
export function IconSend() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19.5V5" /><path d="M5.8 11.2 12 5l6.2 6.2" />
    </svg>
  );
}
export function IconRadar() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 12l6.5-6.5" /><circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}
export function IconDownload() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v11" /><path d="M7.5 10.5 12 15l4.5-4.5" /><path d="M4 19h16" />
    </svg>
  );
}
export function IconFlow() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="15" y="15" width="6" height="6" rx="1.5" />
      <path d="M9 6h4a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" /><path d="M6 9v6a2 2 0 0 0 2 2h4" />
    </svg>
  );
}
export function IconReport() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5" /><path d="M8.5 13h7M8.5 17h5" />
    </svg>
  );
}
export function IconTerminal() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7 9.5l3 2.5-3 2.5" /><path d="M13 15h4" />
    </svg>
  );
}
export function IconPlay() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4.5v15l11-7.5z" />
    </svg>
  );
}
export function IconGear({ active }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={active ? 'text-goldSoft' : ''}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
