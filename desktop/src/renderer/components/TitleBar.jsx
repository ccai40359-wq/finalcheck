// 自定义标题栏（frame:false，用户嫌原生标题栏丑）：可拖拽 + 自绘最小化/最大化/关闭
// + 主题快捷切换（深/浅一键切，与设置页「外观」同一状态源）
// + 侧边栏折叠开关（**与 FC logo 同位置**：平时显示 FC，鼠标悬停时换成侧栏图标，
//   点一下收起/展开会话侧栏。这样不额外占标题栏空间，也不会多出一个按钮。）
import React from 'react';
import { t } from '../i18n/core.mjs';
import { isLight } from '../lib/theme.mjs';
import { LogoMark } from './Logo.jsx';

// 窗口控制图标：Windows 11 式细线（原来是 ─ ▢ ✕ ☀ 字符，随字体渲染粗细不一、也对不齐）
const WinIcon = ({ children }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">{children}</svg>
);
function IconSun() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </svg>
  );
}
function IconMoon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </svg>
  );
}

/** 侧栏图标：竖线 + 面板 + 左右箭头（收/展两个方向） */
function IconSidebarToggle({ collapsed }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <line x1="8.5" y1="4" x2="8.5" y2="20" />
      {/* 收起时箭头朝外（←），展开时朝内（→） */}
      {collapsed
        ? <path d="M15.5 10.5 13 12l2.5 1.5" />
        : <path d="M11.5 10.5 14 12l-2.5 1.5" />}
    </svg>
  );
}

export default function TitleBar({
  y, theme = 'dark', onToggleTheme,
  sidebarCollapsed = false, onToggleSidebar
}) {
  const light = isLight(theme);
  return (
    <div className="relative z-[1] shrink-0 h-9 flex items-center justify-between border-b border-lift/[0.06] bg-lift/[0.025] backdrop-blur-2xl select-none" style={{ WebkitAppRegion: 'drag' }}>
      <div className="flex items-center gap-2 pl-3">
        {/* FC logo 与「折叠侧栏」按钮重合：
            平时只显示 FC 标记；鼠标移上去（或键盘聚焦）时淡出 logo、显出侧栏图标。
            这样既不多占地方，也不破坏品牌标识。 */}
        <button
          onClick={() => onToggleSidebar?.()}
          disabled={!onToggleSidebar}
          title={sidebarCollapsed ? t('展开会话侧栏') : t('收起会话侧栏')}
          aria-label={sidebarCollapsed ? t('展开会话侧栏') : t('收起会话侧栏')}
          aria-expanded={!sidebarCollapsed}
          data-ui="sidebar-toggle"
          className={`group/logo relative w-5 h-5 shrink-0 rounded-[5px] flex items-center justify-center transition-colors duration-150 ${
            onToggleSidebar
              ? 'hover:bg-lift/[0.10] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60'
              : ''
          }`}
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          {/* FC 常态（金色小方牌）；悬停时整块淡出 */}
          <span
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-150 ${
              onToggleSidebar ? 'group-hover/logo:opacity-0 group-focus-visible/logo:opacity-0' : ''
            }`}
          ><LogoMark size={20} /></span>
          {/* 悬停态：纯侧栏图标（不带金框，颜色跟着标题栏文字走，像原生控件） */}
          {onToggleSidebar && (
            <span className="absolute inset-0 flex items-center justify-center text-mute opacity-0 group-hover/logo:text-ink group-hover/logo:opacity-100 group-focus-visible/logo:text-ink group-focus-visible/logo:opacity-100 transition-opacity duration-150">
              <IconSidebarToggle collapsed={sidebarCollapsed} />
            </span>
          )}
        </button>
        <span className="text-[12px] font-medium tracking-[0.02em] text-ink/75">Final<span className="text-mute">Check</span></span>
      </div>
      <div className="flex items-center h-full" style={{ WebkitAppRegion: 'no-drag' }}>
        {onToggleTheme && (
          <button
            onClick={onToggleTheme}
            className="h-full w-11 flex items-center justify-center text-mute hover:text-ink hover:bg-lift/[0.07] transition-colors"
            title={light ? t('切换到深色主题') : t('切换到浅色主题')}
            aria-label={light ? t('切换到深色主题') : t('切换到浅色主题')}
            data-ui="theme-toggle"
          >
            {light ? <IconMoon /> : <IconSun />}
          </button>
        )}
        <button onClick={() => y?.windowCtl('minimize')} className="h-full w-11 flex items-center justify-center text-mute hover:text-ink hover:bg-lift/[0.07] transition-colors" title={t('最小化')} aria-label={t('最小化')}><WinIcon><path d="M0 5.5h10" /></WinIcon></button>
        <button onClick={() => y?.windowCtl('maximize')} className="h-full w-11 flex items-center justify-center text-mute hover:text-ink hover:bg-lift/[0.07] transition-colors" title={t('最大化')} aria-label={t('最大化')}><WinIcon><rect x="0.5" y="0.5" width="9" height="9" rx="1.5" /></WinIcon></button>
        <button onClick={() => y?.windowCtl('close')} className="h-full w-11 flex items-center justify-center text-mute hover:text-white hover:bg-[#c42b1c] transition-colors" title={t('关闭')} aria-label={t('关闭')}><WinIcon><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></WinIcon></button>
      </div>
    </div>
  );
}
