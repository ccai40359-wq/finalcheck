// 0.33.9 图片大图：点输入框里的附件缩略图、或者你发出去的消息里的图片，弹出来看清楚。
//   · 背景压暗，图片居中、按窗口自适应（不放大糊掉的小图）
//   · Esc / 点背景 / 右上角 ✕ 关闭；多张时 ← → 切换（循环）
//   · 有本地路径的可以「在右栏打开」（走原来的产物预览，能缩放、能看原文件）
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/core.mjs';
import { LIGHTBOX_EVENT, stepLightbox } from '../lib/lightbox.mjs';

export default function ImageLightbox({ onOpenInRail = null }) {
  const [state, setState] = useState(null);
  const close = useCallback(() => setState(null), []);
  useEffect(() => {
    const onOpen = (e) => setState(e.detail || null);
    window.addEventListener(LIGHTBOX_EVENT, onOpen);
    return () => window.removeEventListener(LIGHTBOX_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (!state) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowLeft') setState((s) => stepLightbox(s, -1));
      else if (e.key === 'ArrowRight') setState((s) => stepLightbox(s, 1));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state, close]);
  if (!state) return null;
  const item = state.items[state.index];
  const many = state.items.length > 1;
  // 挂到 body 上：消息气泡等元素自带层叠上下文，留在原位置会盖住大图（真界面实测）；
  // no-drag：标题栏是窗口拖动区，不声明的话盖在上面的按钮点不到
  return createPortal(
    <div data-testid="image-lightbox" role="dialog" aria-modal="true" aria-label={item.name || t('图片')}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      style={{ WebkitAppRegion: 'no-drag' }}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-[2px] animate-[fadeIn_.14s_ease]">
      <div className="pointer-events-none absolute inset-x-0 top-9 flex items-center gap-3 px-4 py-3 text-[12px] text-zinc-300">
        <span className="min-w-0 truncate font-mono" title={item.path || item.name}>{item.name || item.path}</span>
        {many ? <span className="shrink-0 tabular-nums text-zinc-500">{state.index + 1} / {state.items.length}</span> : null}
        <span className="ml-auto" />
        {item.path && onOpenInRail ? (
          <button type="button" onClick={() => { onOpenInRail(item.path); close(); }}
            className="pointer-events-auto rounded-md px-2.5 py-1 text-zinc-200 hover:bg-zinc-100/10 hover:text-zinc-50">
            {t('在右栏打开')}
          </button>
        ) : null}
        <button type="button" data-testid="lightbox-close" onClick={close} aria-label={t('关闭')} title={t('关闭（Esc）')}
          className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full text-zinc-200 hover:bg-zinc-100/10 hover:text-zinc-50">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      {many ? (
        <button type="button" aria-label={t('上一张')} onClick={() => setState((s) => stepLightbox(s, -1))}
          className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-100/5 text-zinc-200 hover:bg-zinc-100/15">‹</button>
      ) : null}
      <img key={item.src} src={item.src} alt={item.name || ''} draggable={false}
        className="max-h-[86vh] max-w-[90vw] select-none rounded-lg object-contain shadow-[0_20px_60px_rgba(0,0,0,0.6)] animate-[fadeIn_.16s_ease]" />
      {many ? (
        <button type="button" aria-label={t('下一张')} onClick={() => setState((s) => stepLightbox(s, 1))}
          className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-100/5 text-zinc-200 hover:bg-zinc-100/15">›</button>
      ) : null}
    </div>,
    document.body
  );
}
