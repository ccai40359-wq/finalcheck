// 右侧产物预览：图片 / HTML / PDF / 文本（agent 生成的文件可直接点开看）
import React, { useEffect, useRef, useState } from 'react';

export const PREVIEW_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
  '.html', '.htm', '.pdf',
  '.txt', '.md', '.json', '.js', '.mjs', '.css', '.csv', '.log', '.xml', '.yml', '.yaml'
]);

export const extOf = (p) => {
  const s = String(p || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
};

/** 从 trace 里挑出「本轮生成/修改过的、可预览的」文件（edit_file / write_file） */
export function collectArtifacts(trace) {
  const out = [];
  const seen = new Set();
  for (const t of trace || []) {
    if (!['edit_file', 'write_file', 'present_artifact'].includes(t?.tool)) continue;
    const r = t.result;
    if (!r || typeof r !== 'object' || r.error || !r.path) continue;
    if (!PREVIEW_EXTS.has(extOf(r.path)) || seen.has(r.path)) continue;
    seen.add(r.path);
    out.push({ path: r.path, name: r.title || r.file || String(r.path).split(/[\\/]/).pop(), added: r.added, removed: r.removed });
  }
  return out;
}

export function ArtifactChips({ artifacts, activePath, onOpen }) {
  if (!artifacts?.length) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {artifacts.map((a) => {
        const ext = extOf(a.path);
        const isImg = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext);
        return (
          <button key={a.path} onClick={() => onOpen(a.path)} title={a.path}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-mono transition-colors ${activePath === a.path ? 'border-gold/60 bg-gold/10 text-goldSoft' : 'border-edge bg-[#0d0d10] text-mute hover:border-gold/40 hover:text-goldSoft'}`}>
            <span className="text-goldDeep">{isImg ? '▣' : ext === '.html' || ext === '.htm' ? '◇' : '▤'}</span>
            <span className="max-w-[220px] truncate text-ink/85">{a.name}</span>
            {a.added != null ? <span className="text-jade">+{a.added}</span> : null}
            {a.removed != null ? <span className="text-red-400">-{a.removed}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function ArtifactPanel({ artifact, loading, error, onClose, onReload, onOpen }) {
  const a = artifact;
  // 拖左边缘调宽度；拖到头（<220px）直接关闭。宽度记在本机。
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem('fc.artifactWidth'));
    return Number.isFinite(v) && v >= 260 ? v : 560;
  });
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);
  const startDrag = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const max = Math.round(window.innerWidth * 0.72);
    const move = (ev) => {
      const next = Math.min(max, Math.max(0, startW + (startX - ev.clientX)));
      if (next < 220) { cleanup(); onClose?.(); return; } // 拉到头 = 关上
      setWidth(next);
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    const up = () => { cleanup(); localStorage.setItem('fc.artifactWidth', String(widthRef.current)); };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <aside style={{ width }} className="shrink-0 border-l border-edge bg-[#0b0b0e] flex flex-col min-h-0 relative">
      <div onMouseDown={startDrag} onDoubleClick={() => setWidth(560)} title="拖动调整宽度（拖到头关闭，双击复位）"
        className="group absolute left-0 top-0 h-full w-2 -ml-1 cursor-col-resize z-10">
        <div className="w-px h-full mx-auto bg-edge/70 group-hover:bg-gold/60 transition-colors" />
      </div>
      <div className="shrink-0 h-11 px-3.5 flex items-center gap-2 border-b border-edge">
        <span className="text-goldDeep text-sm">▤</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-ink/90 truncate">{a?.name || '产物预览'}</div>
          <div className="text-[10px] text-mute/50 font-mono truncate">{a?.path || ''}</div>
        </div>
        {a?.path ? (
          <>
            <button onClick={() => onReload?.(a.path)} title="重新读取"
              className="text-[11px] px-2 py-1 rounded-md border border-edge text-mute hover:text-goldSoft hover:border-gold/40 transition-colors">刷新</button>
            <button onClick={() => onOpen?.(a.path)} title="用系统程序打开"
              className="text-[11px] px-2 py-1 rounded-md border border-edge text-mute hover:text-goldSoft hover:border-gold/40 transition-colors">外部打开</button>
          </>
        ) : null}
        <button onClick={onClose} title="关闭预览"
          className="h-7 w-7 rounded-md text-mute hover:text-ink hover:bg-white/5 transition-colors">✕</button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden bg-[#0a0a0c]">
        {loading ? <div className="p-4 text-xs text-mute animate-pulse">读取中…</div>
          : error ? <div className="p-4 text-xs text-red-300 whitespace-pre-wrap">{error}</div>
            : !a ? null
              : a.kind === 'image' ? (
                <div className="w-full h-full flex items-center justify-center p-4 overflow-auto">
                  <img src={a.dataUrl} alt={a.name} className="max-w-full max-h-full object-contain rounded-lg border border-edge" />
                </div>
              ) : a.kind === 'html' ? (
                <iframe title={a.name} srcDoc={a.content} sandbox="allow-scripts allow-forms allow-modals allow-popups"
                  className="w-full h-full bg-white border-0" />
              ) : a.kind === 'pdf' ? (
                <iframe title={a.name} src={a.dataUrl} className="w-full h-full border-0 bg-white" />
              ) : (
                <pre className="w-full h-full overflow-auto p-4 text-[11px] leading-relaxed font-mono text-ink/80 whitespace-pre-wrap break-words">{a.content}</pre>
              )}
      </div>
    </aside>
  );
}
