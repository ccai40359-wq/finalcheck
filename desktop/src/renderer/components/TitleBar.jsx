// 自定义标题栏（frame:false，用户嫌原生标题栏丑）：可拖拽 + 自绘最小化/最大化/关闭
// + 主题快捷切换（深/浅一键切，与设置页「外观」同一状态源）。
import React from 'react';
import { t } from '../i18n/core.mjs';
import { isLight } from '../lib/theme.mjs';

export default function TitleBar({ y, theme = 'dark', onToggleTheme }) {
  const light = isLight(theme);
  return (
    <div className="relative z-[1] shrink-0 h-9 flex items-center justify-between border-b border-lift/[0.06] bg-lift/[0.025] backdrop-blur-2xl select-none" style={{ WebkitAppRegion: 'drag' }}>
      <div className="flex items-center gap-2 pl-3">
        <span className="w-4 h-4 rounded-[4px] bg-gold/15 border border-gold/50 flex items-center justify-center text-[9px] font-bold text-goldSoft">FC</span>
        <span className="text-[12px] tracking-widest text-mute">FinalCheck</span>
      </div>
      <div className="flex items-center h-full" style={{ WebkitAppRegion: 'no-drag' }}>
        {onToggleTheme && (
          <button
            onClick={onToggleTheme}
            className="h-full px-3 text-mute hover:text-ink hover:bg-lift/5 transition-colors"
            title={light ? t('切换到深色主题') : t('切换到浅色主题')}
            aria-label={light ? t('切换到深色主题') : t('切换到浅色主题')}
            data-ui="theme-toggle"
          >
            {light ? '☾' : '☀'}
          </button>
        )}
        <button onClick={() => y?.windowCtl('minimize')} className="h-full px-3.5 text-mute hover:text-ink hover:bg-lift/5 transition-colors" title={t('最小化')}>─</button>
        <button onClick={() => y?.windowCtl('maximize')} className="h-full px-3.5 text-mute hover:text-ink hover:bg-lift/5 transition-colors" title={t('最大化')}>▢</button>
        <button onClick={() => y?.windowCtl('close')} className="h-full px-3.5 text-mute hover:text-red-300 hover:bg-red-500/15 transition-colors" title={t('关闭')}>✕</button>
      </div>
    </div>
  );
}
