// 右侧产物预览：图片 / HTML / 视频 / PDF·PPT·Word（分页）/ 文本（agent 生成的文件可直接点开看）
// .md/.markdown 走 markdown 渲染（与聊天气泡同一套净化渲染器），其余文本保持等宽原文
import React, { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/core.mjs';
import { renderMarkdown } from './md.jsx';
import { PdfPager } from './PdfPager.jsx';
import { planPanelLayout, clampPanelWidth, shouldClosePanel } from '../lib/panel-layout.mjs';
import { useWindowWidth } from '../lib/use-window-width.mjs';
import { partitionArtifacts, shotGroupView, SHOT_GROUP_DEFAULT_EXPANDED } from '../lib/artifact-groups.mjs';

export const PREVIEW_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
  '.html', '.htm', '.pdf',
  '.mp4', '.m4v', '.webm', '.mov', '.ogv',
  '.pptx', '.ppt', '.pps', '.ppsx', '.odp', '.key', '.docx', '.doc', '.odt', '.rtf',
  '.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.css', '.csv', '.log', '.xml', '.yml', '.yaml'
]);

const VIDEO_RE = /^\.(mp4|m4v|webm|mov|ogv)$/;
const SLIDES_RE = /^\.(pptx?|ppsx?|odp|key|pdf|docx?|odt|rtf)$/;

export const isMarkdownArtifact = (p) => /\.(md|markdown)$/i.test(String(p || ''));

export const extOf = (p) => {
  const s = String(p || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
};

/** 从 trace 里挑出「本轮生成/修改过的、可预览的」文件（edit_file / write_file / present_artifact / capture_screenshot）
 *  capture_screenshot 打 shot:true 标记（AI 自查证据，渲染层收成「检查截图 ×N」分组条，见 lib/artifact-groups.mjs）；
 *  返回值仍是扁平数组，签名与调用方（MessageList / TraceCards 生态）保持兼容。 */
export function collectArtifacts(trace) {
  const out = [];
  const seen = new Set();
  for (const entry of trace || []) {
    if (!['edit_file', 'write_file', 'present_artifact', 'capture_screenshot'].includes(entry?.tool)) continue;
    const r = entry.result;
    if (!r || typeof r !== 'object' || r.error || !r.path) continue;
    if (!PREVIEW_EXTS.has(extOf(r.path)) || seen.has(r.path)) continue;
    seen.add(r.path);
    out.push({
      path: r.path,
      name: r.title || r.file || String(r.path).split(/[\\/]/).pop(),
      added: r.added, removed: r.removed,
      shot: entry.tool === 'capture_screenshot'
    });
  }
  return out;
}

// 单个产物 chip：edit_file / write_file / present_artifact 与展开后的截图 chip 走同一渲染与 onOpen 链路
function artifactChip(a, activePath, onOpen) {
  const ext = extOf(a.path);
  const isImg = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext);
  return (
    <button key={a.path} onClick={() => onOpen(a.path)} title={a.path}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-mono transition-colors ${activePath === a.path ? 'bg-gold/12 text-goldSoft' : 'bg-lift/[0.035] text-mute hover:bg-lift/[0.06] hover:text-goldSoft'}`}>
      <span className="text-goldDeep">{isImg ? '▣' : ext === '.html' || ext === '.htm' ? '◇' : VIDEO_RE.test(ext) ? '▶' : SLIDES_RE.test(ext) ? '▦' : '▤'}</span>
      <span className="max-w-[220px] truncate text-ink/85">{a.name}</span>
      {a.added != null ? <span className="text-jade">+{a.added}</span> : null}
      {a.removed != null ? <span className="text-red-400">-{a.removed}</span> : null}
    </button>
  );
}

export function ArtifactChips({ artifacts, activePath, onOpen }) {
  // WF2：AI 自查截图分组。展开态是每条消息自己的（组件随消息键重建，不跨会话继承）；默认收起。
  const [shotsOpen, setShotsOpen] = useState(SHOT_GROUP_DEFAULT_EXPANDED);
  if (!artifacts?.length) return null;
  const { regular, shotGroup } = partitionArtifacts(artifacts);
  const group = shotGroupView(shotGroup, shotsOpen);
  if (!regular.length && !group) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-1.5">
      {regular.map((a) => artifactChip(a, activePath, onOpen))}
      {group ? (
        <div className="w-full">
          {/* 分组条只是计数按钮：收起态 DOM 不渲染任何 chip / 图片标签，点开才展开 N 个 chip */}
          <button onClick={() => setShotsOpen((v) => !v)}
            title={group.expanded ? t('收起检查截图') : t('展开检查截图（AI 自查证据，点击单张可在右侧打开）')}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-mono transition-colors bg-gold/[0.10] text-goldSoft hover:bg-gold/[0.18]">
            <span aria-hidden="true" className="text-goldDeep">{group.expanded ? '▾' : '▸'}</span>
            <span>{t(group.labelKey, group.params)}</span>
          </button>
          {group.expanded ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {group.chips.map((a) => artifactChip(a, activePath, onOpen))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ArtifactPanel({ y, artifact, loading, error, onClose, onReload, onOpen, sidebarWidth = 212 }) {
  const a = artifact;
  // 拖左边缘调宽度；拖到头（<220px）直接关闭。宽度记在本机。
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem('fc.artifactWidth'));
    return Number.isFinite(v) && v >= 260 ? v : 560;
  });
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);

  // 宽度策略：始终并排，但右栏给正文让出位置（不再有浮层/遮罩）。
  // 旧逻辑上限是「窗口 72%」，1010px 窗口下右栏能占 727px、正文只剩 71px。
  const winW = useWindowWidth();
  const layout = planPanelLayout({ windowWidth: winW, desiredWidth: width, sidebar: sidebarWidth });
  const panelW = layout.width;

  const startDrag = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const move = (ev) => {
      const raw = Math.max(0, startW + (startX - ev.clientX));
      if (shouldClosePanel(raw)) { cleanup(); onClose?.(); return; } // 拖到头 = 关上
      setWidth(clampPanelWidth({ windowWidth: winW, width: raw, sidebar: sidebarWidth }));
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
    <aside
      style={{ width: panelW }}
      data-panel-mode="rail"
      className="shrink-0 border-l border-edge bg-panel flex flex-col min-h-0 relative"
    >
      <div onMouseDown={startDrag} onDoubleClick={() => setWidth(560)} title={t('拖动调整宽度（拖到头关闭，双击复位）')}
        className="group absolute left-0 top-0 h-full w-2 -ml-1 cursor-col-resize z-10">
        <div className="w-px h-full mx-auto bg-edge/70 group-hover:bg-gold/60 transition-colors" />
      </div>
      <div className="shrink-0 h-11 px-3.5 flex items-center gap-2">
        <span className="text-goldDeep text-sm">▤</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-ink/90 truncate">{a?.name || t('产物预览')}</div>
          <div className="text-[10px] text-mute/50 font-mono truncate">{a?.path || ''}</div>
        </div>
        {a?.path ? (
          <>
            <button onClick={() => onReload?.(a.path)} title={t('重新读取')}
              className="rounded-md px-2 py-1 text-[11px] text-mute hover:bg-lift/[0.04] hover:text-goldSoft transition-colors">{t('刷新')}</button>
            <button onClick={() => onOpen?.(a.path)} title={t('用系统程序打开')}
              className="rounded-md px-2 py-1 text-[11px] text-mute hover:bg-lift/[0.04] hover:text-goldSoft transition-colors">{t('外部打开')}</button>
          </>
        ) : null}
        <button onClick={onClose} title={t('关闭预览')}
          className="h-7 w-7 rounded-md text-mute hover:text-ink hover:bg-lift/5 transition-colors">✕</button>
      </div>
      <div aria-hidden className="h-px shrink-0 bg-edge/70" />
      <div className="flex-1 min-h-0 overflow-hidden bg-base">
        {loading ? <div className="p-4 text-xs text-mute animate-pulse">{t('读取中…')}</div>
          : error ? <div className="p-4 text-xs text-red-300 whitespace-pre-wrap">{error}</div>
            : !a ? null
              : a.kind === 'image' ? (
                <div className="w-full h-full flex items-center justify-center p-4 overflow-auto">
                  <img src={a.dataUrl} alt={a.name} className="max-w-full max-h-full object-contain rounded-lg" />
                </div>
              ) : a.kind === 'html' ? (
                <iframe title={a.name} srcDoc={a.content} sandbox="allow-scripts allow-forms allow-modals allow-popups"
                  className="w-full h-full bg-white border-0" />
              ) : a.kind === 'video' ? (
                <div className="w-full h-full flex items-center justify-center p-4 bg-black">
                  <video key={a.path} src={a.url} controls preload="metadata" className="max-w-full max-h-full rounded-lg" />
                </div>
              ) : a.kind === 'pdf' && a.pdfPath ? (
                <PdfPager key={a.pdfPath} y={y} artifact={a} />
              ) : isMarkdownArtifact(a.path || a.name) ? (
                <div
                  title={t('Markdown 渲染（原文本可外部打开查看）')}
                  className="md text-[13px] leading-relaxed p-5 h-full overflow-auto text-ink/90"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(a.content) }}
                />
              ) : (
                <pre className="w-full h-full overflow-auto p-4 text-[11px] leading-relaxed font-mono text-ink/80 whitespace-pre-wrap break-words">{a.content}</pre>
              )}
      </div>
    </aside>
  );
}
