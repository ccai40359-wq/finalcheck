// 0.33.9 图片大图：点输入框里的附件缩略图、或者你发出去的消息里的图片，弹出来看清楚。
//   · 背景压暗，图片居中、按窗口自适应（不放大糊掉的小图）
//   · Esc / 点背景 / 右上角 ✕ 关闭；多张时 ← → 切换（循环）
//   · 有本地路径的可以「在右栏打开」（走原来的产物预览，能缩放、能看原文件）
//   · 0.34.3：消息 / 输入框里的图是压到 480px 的缩略图（省内存），大图里直接放它就又小又糊——
//     打开时按路径读**原图**换上去（先显示缩略图占位）；点图片在「适应窗口」和「原始像素」之间切换
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/core.mjs';
import { api } from '../lib/ui.jsx';
import { LIGHTBOX_EVENT, stepLightbox } from '../lib/lightbox.mjs';

/** 按路径读原图（data URL）；读不到就继续用缩略图。只在大图打开期间留在内存里 */
function useFullImage(path) {
  const [full, setFull] = useState({ path: '', src: '' });
  useEffect(() => {
    if (!path) return undefined;
    let alive = true;
    Promise.resolve(api()?.artifactRead?.(path))
      .then((r) => { if (alive && r?.dataUrl) setFull({ path, src: r.dataUrl }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [path]);
  return full.path === path ? full.src : '';
}

export default function ImageLightbox({ onOpenInRail = null }) {
  const [state, setState] = useState(null);
  const [actual, setActual] = useState(false); // false = 适应窗口；true = 原始像素（可滚动）
  const close = useCallback(() => setState(null), []);
  const cur = state?.items?.[state.index];
  const fullSrc = useFullImage(cur?.path || '');
  useEffect(() => { setActual(false); }, [state?.index, cur?.src]);
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
      {actual ? (
        // 原始像素：超出窗口就在这个区域里滚动看细节；点一下回到适应窗口
        <div className="absolute inset-x-0 bottom-0 top-[84px] overflow-auto" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
          <img src={fullSrc || item.src} alt={item.name || ''} draggable={false} data-testid="lightbox-image" data-full={fullSrc ? '1' : '0'}
            onClick={() => setActual(false)} title={t('点击适应窗口')}
            className="mx-auto block max-w-none cursor-zoom-out select-none" />
        </div>
      ) : (
        // 适应窗口：原图按窗口等比放大 / 缩小，占满可视区（缩略图只是加载原图前的占位）
        <img key={item.src} src={fullSrc || item.src} alt={item.name || ''} draggable={false} data-testid="lightbox-image" data-full={fullSrc ? '1' : '0'}
          onClick={() => { if (fullSrc) setActual(true); }} title={fullSrc ? t('点击查看原始大小') : ''}
          className={`h-[calc(100vh-120px)] w-[92vw] select-none object-contain animate-[fadeIn_.16s_ease] ${fullSrc ? 'cursor-zoom-in' : ''}`} />
      )}
      {many ? (
        <button type="button" aria-label={t('下一张')} onClick={() => setState((s) => stepLightbox(s, 1))}
          className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-zinc-100/5 text-zinc-200 hover:bg-zinc-100/15">›</button>
      ) : null}
    </div>,
    document.body
  );
}
