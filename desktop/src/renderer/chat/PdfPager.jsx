// 分页查看器：PDF（以及由 LibreOffice 转成 PDF 的 PPT / Word）一页一页地看。
// 主画面按面板宽度渲染当前页；底部缩略图条可点选跳页；← → / PageUp PageDown 翻页。
import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/core.mjs';

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist/build/pdf.min.mjs'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

const THUMB_W = 96;

function PageCanvas({ doc, pageNo, width, className, onRendered }) {
  const ref = useRef(null);
  useEffect(() => {
    let cancelled = false;
    let task = null;
    (async () => {
      if (!doc || !width) return;
      const page = await doc.getPage(pageNo);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: (width / base.width) * dpr });
      const canvas = ref.current;
      if (!canvas) return;
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
      canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
      task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
      try { await task.promise; onRendered?.(); } catch { /* 翻页时取消上一次渲染 */ }
    })();
    return () => { cancelled = true; try { task?.cancel(); } catch { /* ignore */ } };
  }, [doc, pageNo, width]);
  return <canvas ref={ref} className={className} />;
}

export function PdfPager({ y, artifact }) {
  const [doc, setDoc] = useState(null);
  const [err, setErr] = useState('');
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(0);
  const boxRef = useRef(null);
  const stripRef = useRef(null);
  const total = doc?.numPages || 0;

  useEffect(() => {
    let cancelled = false;
    let loaded = null;
    setDoc(null); setErr(''); setPage(1);
    (async () => {
      try {
        const [lib, bytes] = await Promise.all([loadPdfjs(), y.artifactBytes(artifact.pdfPath)]);
        if (cancelled) return;
        loaded = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
        if (cancelled) { loaded.destroy(); return; }
        setDoc(loaded);
      } catch (e) {
        if (!cancelled) setErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; try { loaded?.destroy(); } catch { /* ignore */ } };
  }, [artifact.pdfPath]);

  // 面板宽度变化（拖动调宽）时按新宽度重渲
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setWidth(Math.max(120, Math.floor(el.clientWidth - 32))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const go = (n) => setPage((p) => Math.min(Math.max(1, typeof n === 'function' ? n(p) : n), total || 1));
  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go((p) => p + 1); }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go((p) => p - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total]);
  // 当前页的缩略图滚进可见区
  useEffect(() => {
    stripRef.current?.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [page]);

  if (err) return <div className="p-4 text-xs text-red-300 whitespace-pre-wrap">{t('无法打开：{msg}', { msg: err })}</div>;
  return (
    <div className="w-full h-full flex flex-col">
      {/* 居中用子元素 my-auto，不用 items-center：后者在竖版长页超出面板高度时会把页顶裁掉、滚不上去 */}
      <div ref={boxRef} className="flex-1 min-h-0 overflow-auto flex justify-center p-4">
        {doc ? <PageCanvas doc={doc} pageNo={page} width={width} className="my-auto rounded shadow-lg bg-white" />
          : <div className="text-xs text-mute animate-pulse">{artifact.converted ? t('正在加载转换后的页面…') : t('读取中…')}</div>}
      </div>
      {doc ? (
        <div className="shrink-0 border-t border-edge/70">
          <div className="flex items-center justify-center gap-3 py-1.5 text-[11px] text-mute">
            <button onClick={() => go(1)} disabled={page <= 1} className="px-1.5 disabled:opacity-30 hover:text-goldSoft">«</button>
            <button onClick={() => go((p) => p - 1)} disabled={page <= 1} className="px-2 py-0.5 rounded disabled:opacity-30 hover:bg-lift/5 hover:text-goldSoft">{t('上一页')}</button>
            <span className="font-mono text-ink/80">{page} / {total}</span>
            <button onClick={() => go((p) => p + 1)} disabled={page >= total} className="px-2 py-0.5 rounded disabled:opacity-30 hover:bg-lift/5 hover:text-goldSoft">{t('下一页')}</button>
            <button onClick={() => go(total)} disabled={page >= total} className="px-1.5 disabled:opacity-30 hover:text-goldSoft">»</button>
          </div>
          {total > 1 ? (
            <div ref={stripRef} className="flex gap-2 overflow-x-auto px-3 pb-2.5">
              {Array.from({ length: Math.min(total, 300) }, (_, i) => i + 1).map((n) => (
                <button key={n} data-page={n} onClick={() => go(n)} title={t('第 {n} 页', { n })}
                  className={`shrink-0 rounded border ${n === page ? 'border-gold' : 'border-transparent opacity-70 hover:opacity-100'}`}>
                  <PageCanvas doc={doc} pageNo={n} width={THUMB_W} className="block rounded-sm bg-white" />
                  <div className="text-[9px] text-mute/70 text-center">{n}</div>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
