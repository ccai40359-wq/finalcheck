// 自定义标题栏（frame:false，用户嫌原生标题栏丑）：可拖拽 + 自绘最小化/最大化/关闭。
import React from 'react';
import { t } from '../i18n/core.mjs';

export default function TitleBar({ y }) {
  return (
    <div className="relative z-[1] shrink-0 h-9 flex items-center justify-between border-b border-white/[0.06] bg-white/[0.025] backdrop-blur-2xl select-none" style={{ WebkitAppRegion: 'drag' }}>
      <div className="flex items-center gap-2 pl-3">
        <span className="w-4 h-4 rounded-[4px] bg-gold/15 border border-gold/50 flex items-center justify-center text-[9px] font-bold text-goldSoft">FC</span>
        <span className="text-[12px] tracking-widest text-mute">FinalCheck</span>
      </div>
      <div className="flex items-center h-full" style={{ WebkitAppRegion: 'no-drag' }}>
        <button onClick={() => y?.windowCtl('minimize')} className="h-full px-3.5 text-mute hover:text-ink hover:bg-white/5 transition-colors" title={t('最小化')}>─</button>
        <button onClick={() => y?.windowCtl('maximize')} className="h-full px-3.5 text-mute hover:text-ink hover:bg-white/5 transition-colors" title={t('最大化')}>▢</button>
        <button onClick={() => y?.windowCtl('close')} className="h-full px-3.5 text-mute hover:text-red-300 hover:bg-red-500/15 transition-colors" title={t('关闭')}>✕</button>
      </div>
    </div>
  );
}
