// 截图专用页（隐藏窗口里打开，不给用户看）：把 PDF（含 PPT/Word 转出的 PDF）的某一页、
// 或视频的某一帧画到整窗口，画完把 document.title 设成 fc-snapshot-ready:<信息>，
// 主进程看到后 capturePage() 截图交给 AI 看。出错设 fc-snapshot-error:<原因>。
import React, { useEffect, useRef } from 'react';

const y = typeof window !== 'undefined' ? window.finalcheck : null;

export function snapshotParams() {
  const h = String(window.location.hash || '');
  if (!h.startsWith('#fc-snapshot?')) return null;
  return Object.fromEntries(new URLSearchParams(h.slice('#fc-snapshot?'.length)));
}

export default function SnapshotPage({ params }) {
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  useEffect(() => {
    // 截图页：去掉页面边距和滚动条，画布贴左上角，截出来不带杂边
    for (const el of [document.documentElement, document.body]) { el.style.margin = '0'; el.style.padding = '0'; el.style.overflow = 'hidden'; el.style.background = '#fff'; }
    const done = (info) => { document.title = `fc-snapshot-ready:${info}`; };
    const fail = (e) => { document.title = `fc-snapshot-error:${String(e?.message || e).slice(0, 200)}`; };
    const width = Math.max(200, Number(params.width) || 1280);
    (async () => {
      if (params.kind === 'pdf') {
        const [lib, worker] = await Promise.all([
          import('pdfjs-dist/build/pdf.min.mjs'),
          import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
        ]);
        lib.GlobalWorkerOptions.workerSrc = worker.default;
        const bytes = await y.artifactBytes(params.pdfPath);
        const doc = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
        const n = Math.min(Math.max(1, Number(params.page) || 1), doc.numPages);
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: width / base.width });
        const c = canvasRef.current;
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        done(`${n}/${doc.numPages}/${c.width}x${c.height}`);
      } else if (params.kind === 'video') {
        const v = videoRef.current;
        v.muted = true;
        v.src = params.url;
        await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('视频无法解码')); });
        const t = Math.min(Math.max(0, Number(params.time) || 0), Math.max(0, v.duration - 0.05));
        await new Promise((res) => { v.onseeked = res; v.currentTime = t; });
        const c = canvasRef.current;
        const scale = Math.min(1, width / v.videoWidth);
        c.width = Math.floor(v.videoWidth * scale);
        c.height = Math.floor(v.videoHeight * scale);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        done(`${t.toFixed(2)}/${v.duration.toFixed(2)}/${c.width}x${c.height}`);
      } else {
        fail('unknown kind');
      }
    })().catch(fail);
  }, []);
  return (
    <div style={{ margin: 0, padding: 0, background: '#fff', display: 'inline-block' }}>
      <canvas ref={canvasRef} style={{ display: 'block' }} />
      <video ref={videoRef} style={{ display: 'none' }} preload="auto" />
    </div>
  );
}
