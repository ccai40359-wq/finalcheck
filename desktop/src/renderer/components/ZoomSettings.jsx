// 0.34.3 设置 → 外观 → 界面缩放：以前只有快捷键（Ctrl + = / - / 0），界面上看不到，用户不知道有这功能。
// 这里给按钮 + 当前倍率 + 快捷键提示；按钮和快捷键走同一条主进程缩放逻辑（会记住，下次打开还是这个大小）。
import React, { useEffect, useState } from 'react';
import { api, Card } from '../lib/ui.jsx';
import { t } from '../i18n/core.mjs';

export const ZOOM_EVENT = 'fc:zoom-changed';

export default function ZoomSettings() {
  const ctl = api()?.windowCtl;
  const [zoom, setZoom] = useState(null);
  const read = (r) => { if (r && Number.isFinite(r.zoom)) setZoom(r.zoom); };
  useEffect(() => {
    if (!ctl) return undefined;
    ctl('state').then(read).catch(() => {});
    // 快捷键改了倍率（渲染层兜底那条路径会广播）：跟着刷新
    const on = () => ctl('state').then(read).catch(() => {});
    window.addEventListener(ZOOM_EVENT, on);
    window.addEventListener('resize', on); // 主进程快捷键改缩放会触发视口变化
    return () => { window.removeEventListener(ZOOM_EVENT, on); window.removeEventListener('resize', on); };
  }, [ctl]);
  if (!ctl || window.__FC_MOBILE__) return null; // 手机上用双指缩放
  const act = (a) => ctl(a).then(read).catch(() => {});
  const mod = /Mac/i.test(navigator.platform || '') ? 'Cmd' : 'Ctrl';
  const btn = 'btn-ghost h-8 min-w-8 px-2 text-[13px]';
  return (
    <Card className="p-5 mt-4" data-testid="zoom-settings">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm text-ink font-medium">{t('界面缩放')}</div>
          <div className="text-xs text-mute mt-0.5 leading-relaxed">
            {t('字太小就放大，整个界面一起缩放，会记住。快捷键：{mod} + = 放大，{mod} + - 缩小，{mod} + 0 复位。', { mod })}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" className={btn} onClick={() => act('zoom-out')} aria-label={t('缩小')}>−</button>
          <span className="w-14 text-center text-[13px] tabular-nums text-ink" data-testid="zoom-value">{zoom ? `${Math.round(zoom * 100)}%` : '—'}</span>
          <button type="button" className={btn} onClick={() => act('zoom-in')} aria-label={t('放大')}>+</button>
          <button type="button" className={`${btn} ml-1`} onClick={() => act('zoom-reset')} disabled={zoom != null && Math.abs(zoom - 1) < 0.001}>{t('复位')}</button>
        </div>
      </div>
    </Card>
  );
}
