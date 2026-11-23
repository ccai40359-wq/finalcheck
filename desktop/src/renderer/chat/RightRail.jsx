// 0.32.0：右栏（对标 ZCode 的右栏）——一条 tab 条，里面并存三类内容：
//   · 产物预览（html/png/pdf/…，一个产物一个 tab）
//   · 内嵌浏览器（多个网页在它自己的标签条里，右栏里只占一个 tab）
//   · 子代理会话（一个步骤一个 tab）
//
// 为什么改（用户两次截图）：以前右侧是「子代理面板 / 产物面板」二选一，AI 一开网页
// 你就什么都看不见（页面画在一个从不显示的隐藏窗口上）。现在浏览器成为右栏里的一等公民。
//
// 宽度策略沿用 panel-layout.mjs（MIN_MAIN_WIDTH = 420，用户拍板保持不变）；
// 拖左边缘调宽、拖到头关闭、双击复位——与旧面板的手感一致。
import { useState, useRef, useEffect } from 'react';
import { useWindowWidth } from '../lib/use-window-width.mjs';
import { planPanelLayout, clampPanelWidth, shouldClosePanel } from '../lib/panel-layout.mjs';
import { railTabLabel } from '../lib/rail-tabs.mjs';
import { t } from '../i18n/core.mjs';
import { ArtifactPanel } from './ArtifactPanel.jsx';
import { SubagentPanel } from './SubagentPanel.jsx';
import { BrowserPane } from './BrowserPane.jsx';

const KIND_ICON = { artifact: '▤', browser: '🌐', subagent: '◈' };

export function RightRail({
  rail, onActivate, onCloseTab, onClose, sidebarWidth = 212,
  y, artifact, artifactLoading, artifactError, artifactHandlers,
  subagentTarget
}) {
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem('fc.railWidth'));
    return Number.isFinite(v) && v >= 300 ? v : 620;
  });
  const widthRef = useRef(width);
  useEffect(() => { widthRef.current = width; }, [width]);

  const winW = useWindowWidth();
  const layout = planPanelLayout({ windowWidth: winW, desiredWidth: width, sidebar: sidebarWidth });
  const panelW = layout.width;

  const startDrag = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    const move = (ev) => {
      const raw = Math.max(0, startW + (startX - ev.clientX));
      if (shouldClosePanel(raw)) { cleanup(); onClose?.(); return; }
      setWidth(clampPanelWidth({ windowWidth: winW, width: raw, sidebar: sidebarWidth }));
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    const up = () => { cleanup(); localStorage.setItem('fc.railWidth', String(widthRef.current)); };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const active = rail?.tabs?.find((x) => x.key === rail.activeKey) || null;
  // 浏览器 tab 在「不在前台」时也必须让主进程把画面藏起来——
  // 否则切到产物 tab 后，网页画面会继续盖在产物上（PoC 实测：view 不会自动隐藏）。
  const browserVisible = Boolean(active && active.kind === 'browser');

  return (
    <aside
      style={{ width: panelW }}
      data-panel-mode="rail"
      data-rail="tabs"
      className="shrink-0 border-l border-edge bg-panel flex flex-col min-h-0 relative"
    >
      <div onMouseDown={startDrag} onDoubleClick={() => setWidth(620)} title={t('拖动调整宽度（拖到头关闭，双击复位）')}
        className="group absolute left-0 top-0 h-full w-2 -ml-1 cursor-col-resize z-10">
        <div className="w-px h-full mx-auto bg-edge/70 group-hover:bg-gold/60 transition-colors" />
      </div>

      {/* tab 条 */}
      <div className="shrink-0 flex items-stretch gap-0.5 px-1.5 h-9 border-b border-edge/70 overflow-x-auto">
        {(rail?.tabs || []).map((tab) => (
          <div key={tab.key}
            data-rail-tab
            data-rail-kind={tab.kind}
            onClick={() => onActivate?.(tab.key)}
            title={tab.key}
            className={`group inline-flex items-center gap-1 max-w-[190px] shrink-0 cursor-pointer rounded-t px-2 text-[11px] ${
              tab.key === rail.activeKey ? 'bg-lift/[0.10] text-goldSoft' : 'text-mute/70 hover:bg-lift/[0.05]'}`}>
            <span className="shrink-0 text-[10px] opacity-80">{KIND_ICON[tab.kind] || '▫'}</span>
            <span className="truncate">{railTabLabel(tab)}</span>
            <button onClick={(e) => { e.stopPropagation(); onCloseTab?.(tab.key); }}
              title={t('关闭这个标签')}
              className="opacity-0 group-hover:opacity-100 text-mute/60 hover:text-red-400">✕</button>
          </div>
        ))}
        {(!rail || rail.tabs.length === 0) && (
          <span className="self-center px-2 text-[11px] text-mute/40">{t('没有打开的面板')}</span>
        )}
        <button onClick={() => onClose?.()} title={t('收起右栏')}
          className="ml-auto shrink-0 self-center rounded px-1.5 text-[12px] text-mute/60 hover:text-goldSoft">✕</button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 flex flex-col">
        {active?.kind === 'browser' && (
          <BrowserPane y={y} visible={browserVisible}
            onTabsChange={(list, activeId) => {
              // 浏览器里的当前网页标题回填到右栏 tab 上（用户一眼看出是哪一页）
              const page = list.find((x) => x.id === activeId);
              if (page) onActivate?.(rail.activeKey, { pageTitle: page.title || page.url || '' });
            }} />
        )}
        {active?.kind === 'artifact' && (
          <ArtifactPanel
            embedded
            y={y}
            artifact={artifact}
            loading={artifactLoading}
            error={artifactError}
            onClose={() => onCloseTab?.(active.key)}
            onReload={artifactHandlers?.onReload}
            onOpen={artifactHandlers?.onOpen}
            sidebarWidth={sidebarWidth} />
        )}
        {active?.kind === 'subagent' && (
          <SubagentPanel
            embedded
            target={subagentTarget}
            onClose={() => onCloseTab?.(active.key)}
            sidebarWidth={sidebarWidth} />
        )}
      </div>
    </aside>
  );
}
