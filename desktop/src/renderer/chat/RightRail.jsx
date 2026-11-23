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

/** 右栏折叠图标：竖线 + 面板 + 左右箭头（与 TitleBar 的侧栏图标同一套语言） */
function IconRailToggle({ collapsed }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <line x1="15.5" y1="4" x2="15.5" y2="20" />
      {/* 收起时箭头朝右（→，往栏外收），展开时朝左（←，往栏内指） */}
      {collapsed
        ? <path d="M8.5 10.5 11 12l-2.5 1.5" />
        : <path d="M11.5 10.5 9 12l2.5 1.5" />}
    </svg>
  );
}

export function RightRail({
  rail, onActivate, onCloseTab, onClose, collapsed = false, onToggleCollapsed, sidebarWidth = 212,
  y, artifact, artifactLoading, artifactError, artifactHandlers,
  subagentTarget, onPatchBrowserTitle
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

  // 0.32.4「丝滑」：折叠不再换 DOM 树，改成**同一个 aside 变窄 + 内容淡出**。
  // 以前是 `if (collapsed) return <另一棵/>`——DOM 直接替换，CSS transition 无从谈起，
  // 实测宽度在一帧内从 649 跳到 38（12 帧采样只有 1 个值）。
  //
  // WebContentsView 无法逐帧动画（它是原生层，不是 DOM）：所以动画期间先藏画面，
  // 动画结束再按最终 rect 显示——避免看到画面抖动/拖影。
  const [animating, setAnimating] = useState(false);
  const asideRef = useRef(null);
  const firstRun = useRef(true);
  const collapsedW = 38;
  const expandedW = panelW;
  const railWidth = collapsed ? collapsedW : expandedW;

  // 动画窗口：切换折叠时置 true，transitionend（+ 兜底计时器）后置 false。
  // 与 Sidebar 同一套双保险：属性没变时 transitionend 不会触发（prefers-reduced-motion）。
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setAnimating(true);
    const el = asideRef.current;
    let done = false;
    const stop = () => { if (!done) { done = true; setAnimating(false); } };
    const onEnd = (e) => { if (e.propertyName === 'width' || e.propertyName === 'inline-size') stop(); };
    el?.addEventListener('transitionend', onEnd);
    const timer = setTimeout(stop, 300);
    return () => { el?.removeEventListener('transitionend', onEnd); clearTimeout(timer); };
  }, [collapsed]);

  // 浏览器 tab 在「不在前台」、折叠、或正在做宽度动画时都必须让主进程把画面藏起来——
  // ① 切到产物 tab：不藏就会盖住产物（用户实测"被锁住"）
  // ② 折叠/展开动画中：原生层跟不上逐帧动画，会抖动拖影；等动画结束再按最终 rect 显示
  const browserVisible = Boolean(active && active.kind === 'browser') && !collapsed && !animating;

  return (
    <aside
      ref={asideRef}
      // 宽度走 transition（200ms，与 Sidebar 同一节奏）；折叠时收到 38px
      style={{
        width: railWidth,
        transition: 'width 200ms cubic-bezier(.4,0,.2,1)',
        // 动画期间不加任何滤镜类工作：右栏本来就没有 backdrop-blur，不存在 Sidebar 那类卷积成本
        willChange: animating ? 'width' : 'auto'
      }}
      data-panel-mode="rail"
      data-rail={collapsed ? 'collapsed' : 'tabs'}
      data-rail-animating={animating ? '1' : '0'}
      className="shrink-0 border-l border-edge bg-panel flex flex-col min-h-0 relative overflow-hidden"
    >
      <div onMouseDown={collapsed ? undefined : startDrag} onDoubleClick={collapsed ? undefined : () => setWidth(620)}
        title={collapsed ? '' : t('拖动调整宽度（拖到头关闭，双击复位）')}
        className={`group absolute left-0 top-0 h-full w-2 -ml-1 z-10 ${collapsed ? 'hidden' : 'cursor-col-resize'}`}>
        <div className="w-px h-full mx-auto bg-edge/70 group-hover:bg-gold/60 transition-colors" />
      </div>

      {/* 折叠态的窄条内容：只放"展开"按钮 + 各标签图标。
          它与下面的展开态内容**同时存在于同一棵 DOM 里**，靠 opacity 交叉淡入淡出——
          这样折叠切换时 DOM 不重建，宽度 transition 才能生效（0.32.4 丝滑的关键）。 */}
      <div
        aria-hidden={!collapsed}
        data-rail-strip
        className={`absolute inset-0 flex flex-col items-center justify-start pt-1.5 gap-1 transition-opacity duration-150 ${
          collapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <button onClick={() => onToggleCollapsed?.(false)} title={t('展开右栏')}
          aria-label={t('展开右栏')} aria-expanded={false} data-rail-toggle="expand"
          className="w-8 h-8 rounded-md flex items-center justify-center bg-lift/[0.06] text-goldSoft hover:bg-lift/[0.12] transition-colors">
          <IconRailToggle collapsed />
        </button>
        <div className="w-5 h-px bg-edge/60 mt-0.5 mb-1" />
        {(rail?.tabs || []).map((tab) => (
          <button key={tab.key}
            onClick={() => { onToggleCollapsed?.(false); onActivate?.(tab.key); }}
            title={railTabLabel(tab)}
            className={`w-8 h-8 rounded-md flex items-center justify-center text-[13px] hover:bg-lift/[0.08] ${
              tab.key === rail.activeKey ? 'bg-lift/[0.08] text-goldSoft' : 'text-mute/60'}`}>
            {KIND_ICON[tab.kind] || '▫'}
          </button>
        ))}
      </div>

      {/* 展开态内容：折叠时整体淡出并禁用交互（不卸载，保留标签与面板状态） */}
      <div
        aria-hidden={collapsed}
        className={`flex flex-col min-h-0 h-full transition-opacity duration-150 ${
          collapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>

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
        {/* 两个不同操作，各自独立、用分隔线隔开（避免误点）：
            · 折叠（图标）：右栏收成窄条，标签与内容都保留，随时展开——这是用户要的主操作
            · 全部关闭（✕）：清掉所有标签收起右栏，只在鼠标悬停时淡显，避免和折叠混为一谈 */}
        <div className="ml-auto shrink-0 self-center flex items-center gap-0.5 pl-1 border-l border-edge/50">
          <button onClick={() => onToggleCollapsed?.(true)} title={t('折叠右栏（内容保留，随时展开）')}
            aria-label={t('折叠右栏')} aria-expanded
            data-rail-toggle="collapse"
            className="w-6 h-6 rounded flex items-center justify-center text-mute/70 hover:bg-lift/[0.08] hover:text-goldSoft">
            <IconRailToggle collapsed={false} />
          </button>
          <button onClick={() => onClose?.()} title={t('关闭右栏（清空所有标签）')}
            aria-label={t('关闭右栏')}
            className="w-6 h-6 rounded flex items-center justify-center text-[11px] text-mute/35 hover:bg-lift/[0.08] hover:text-red-400">
            ✕
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 flex flex-col" data-rail-body data-rail-active-kind={active?.kind || ''}>
        {active?.kind === 'browser' && (
          <BrowserPane y={y} visible={browserVisible}
            // 0.32.5 P0：这里**只能**回填标题，绝不能调 onActivate。
            // 以前是 `onActivate?.(rail.activeKey, {pageTitle})`——两个致命后果：
            //   ① 闭包捕获的 rail.activeKey 是当次渲染的旧值（'browser'），你点 PNG tab 后
            //      它异步回来把你切回浏览器 tab → 用户看到的是"点图片没反应/被锁住"
            //   ② 它让 App setRail → 整棵树重渲染 → 本组件的新内联回调 → 轮询 effect 重跑
            //      → IPC → setRail…… 正反馈，把主进程打满 → 用户看到"巨卡"
            // 现在走 setBrowserTabTitle：标题没变就返回同一引用（零重渲染），且永不改 activeKey。
            onPageTitle={(title) => onPatchBrowserTitle?.(title)} />
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
      </div>
    </aside>
  );
}
