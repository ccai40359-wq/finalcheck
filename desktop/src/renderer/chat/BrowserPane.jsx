// 0.32.0：右栏里那块「内嵌浏览器」的占位与工具条。
//
// 关键点（PoC 实测得出）：WebContentsView 画在主窗口的一个绝对位置，
// **不会跟随渲染层的布局**（窗口缩放、侧栏塌陷、tab 切换都不跟）。所以这里做三件事：
//   ① 用一个真实的空 div 占住那块布局（它决定了浏览器画面该出现在哪儿）
//   ② 用 ResizeObserver + window resize 把它的 getBoundingClientRect() 报给主进程
//   ③ 面板不可见时立刻告诉主进程「藏起来」（否则画面会停在错位置，看起来像"浏览器卡住了"）
// 所有坐标都用 DIP（与 Electron 的 setBounds 同一套单位），不做任何缩放换算。
import { useEffect, useRef, useState, useCallback } from 'react';
import { t } from '../i18n/core.mjs';

const ADDR_RE = /^(https?:\/\/|file:\/\/)/i;

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (ADDR_RE.test(raw)) return raw;
  // 用户手输「xiaohongshu.com」这种不带协议的，按 https 补上（这是浏览器的常识行为）
  if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?|#)/i.test(raw)) return `https://${raw}`;
  return raw;
}

export function BrowserPane({ y, visible, onTabsChange }) {
  const boxRef = useRef(null);
  const addrRef = useRef(null);
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [addr, setAddr] = useState('');
  const [addrBusy, setAddrBusy] = useState(false);
  const [note, setNote] = useState('');

  // 上报内容区 rect：浏览器画面就画在这块 div 的位置上
  const reportRect = useCallback(() => {
    const el = boxRef.current;
    if (!el || !y?.railRect) return;
    if (!visible) { void y.railVisible?.(false); return; }
    const r = el.getBoundingClientRect();
    // 宽高为 0（面板被折叠/还没布局）时按「不可见」处理，避免主进程按 0 尺寸画
    if (r.width < 8 || r.height < 8) { void y.railVisible?.(false); return; }
    void y.railRect({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
    void y.railVisible?.(true);
  }, [y, visible]);

  const refreshTabs = useCallback(async () => {
    if (!y?.browserTabs) return;
    try {
      const r = await y.browserTabs();
      if (!r || r.ok === false) return;
      const list = Array.isArray(r.tabs) ? r.tabs : [];
      setTabs(list);
      setActiveId(r.activeId || null);
      const act = list.find((x) => x.id === r.activeId);
      if (act?.url) setAddr((prev) => (prev && addrBusy ? prev : act.url));
      try { onTabsChange?.(list, r.activeId); } catch { /* UI 回调故障不影响浏览器 */ }
    } catch { /* 无宿主时静默（右栏可能只是还没打开网页） */ }
  }, [y, onTabsChange, addrBusy]);

  // 布局变化就重报 rect（ResizeObserver 覆盖右栏拖宽、侧栏塌陷、tab 切换）
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => reportRect());
    ro.observe(el);
    const onWinResize = () => reportRect();
    window.addEventListener('resize', onWinResize);
    reportRect();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
    };
  }, [reportRect]);

  // 面板显隐切换：立刻告知主进程（藏的时候不能再报 rect，否则画面会一直挂着）
  useEffect(() => {
    reportRect();
    if (!visible) void y?.railVisible?.(false);
  }, [visible, reportRect, y]);

  // ⚠️ 卸载时必须把画面藏起来（这是 0.32.1 修的两个真 bug 的同一个根因）：
  //   ① 切到产物/子代理 tab 后，网页那张 WebContentsView 仍盖在原位 → 下面的标签点不动（"被锁住"）
  //   ② 切到设置页时整个右栏卸载了，画面却还留在屏幕上（用户实测：设置页右边压着小红书）
  // 卸载后没有任何组件再持有它，所以只有这里能通知主进程。
  // 用 ref 存 y：这样 effect 只在真正卸载时清一次，不会因为 y 变化而提前触发。
  const yRef = useRef(y);
  yRef.current = y;
  useEffect(() => () => { void yRef.current?.railVisible?.(false); }, []);

  // 标签状态：打开页面后由工具层推送，这里也做一次兜底轮询（3s，仅本面板可见时）
  useEffect(() => {
    refreshTabs();
    if (!visible) return undefined;
    const id = setInterval(() => { void refreshTabs(); }, 3000);
    return () => clearInterval(id);
  }, [visible, refreshTabs]);

  const goto = async () => {
    const url = normalizeUrl(addr);
    if (!url) return setNote(t('请输入网址'));
    setAddrBusy(true);
    setNote('');
    try {
      const r = await y?.browserGoto?.(url);
      if (!r || r.ok === false) setNote(String(r?.error || t('打开失败')));
      await refreshTabs();
    } finally { setAddrBusy(false); }
  };

  const switchTo = async (id) => {
    try { await y?.browserTabSwitch?.(id); } finally { await refreshTabs(); }
  };
  const closeTab = async (e, id) => {
    e.stopPropagation();
    try { await y?.browserTabClose?.(id); } finally { await refreshTabs(); }
  };
  // 0.32.1 修复：加号以前只清空地址栏（什么都没发生，用户实测"点了没效果"）。
  // 现在真的开一个新标签——空白页，然后把焦点给地址栏。
  const openBlank = async () => {
    setNote('');
    setAddr('');
    try {
      const r = await y?.browserTabOpen?.('');
      if (!r || r.ok === false) setNote(String(r?.error || t('新标签打开失败')));
      await refreshTabs();
      addrRef.current?.focus();
    } catch (e) { setNote(String(e?.message || e)); }
  };
  // 0.32.1 修复：这个圈以前只"刷新标签列表"（对用户没有任何可感知效果），
  // 现在改成真正的**重新加载当前网页**（浏览器的刷新语义）。
  const reloadPage = async () => {
    const cur = tabs.find((x) => x.id === activeId);
    if (!cur?.url) return;
    setNote('');
    try {
      const r = await y?.browserGoto?.(cur.url);
      if (!r || r.ok === false) setNote(String(r?.error || t('重新加载失败')));
      await refreshTabs();
    } catch (e) { setNote(String(e?.message || e)); }
  };

  if (!visible) return null;

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* 浏览器自己的标签条（与右栏的 tab 条是两层：这一层是"网页"） */}
      <div className="shrink-0 flex items-center gap-1 px-2 h-8 border-b border-edge/60 overflow-x-auto">
        {tabs.map((tab) => (
          <span key={tab.id}
            onClick={() => switchTo(tab.id)}
            title={tab.url || ''}
            className={`group inline-flex items-center gap-1 max-w-[180px] shrink-0 rounded px-2 py-0.5 text-[11px] cursor-pointer ${
              tab.id === activeId ? 'bg-gold/15 text-goldSoft' : 'text-mute/70 hover:bg-lift/[0.06]'}`}>
            <span className="truncate">{tab.title || tab.url || t('新标签')}</span>
            <button onClick={(e) => closeTab(e, tab.id)} title={t('关闭这个网页')}
              className="opacity-0 group-hover:opacity-100 text-mute/60 hover:text-red-400">✕</button>
          </span>
        ))}
        {tabs.length === 0 && <span className="text-[11px] text-mute/40">{t('还没有网页')}</span>}
        <button onClick={openBlank} title={t('新标签页（开一个空白页，在上面地址栏输入网址）')}
          data-browser-new-tab
          className="shrink-0 ml-1 rounded px-1.5 py-0.5 text-[13px] leading-none text-mute/70 hover:bg-lift/[0.06] hover:text-goldSoft">＋</button>
      </div>

      {/* 地址栏：用户自己输网址的地方。
          0.32.1：去掉了右边的 "Open" 按钮——回车就是打开，按钮和回车重复，
          而且它挤占了地址栏宽度（用户反馈"这个 Open 是啥意思"）。 */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 h-9 border-b border-edge/60">
        <button onClick={() => { void reloadPage(); }} title={t('重新加载当前网页')}
          data-browser-reload
          className="shrink-0 rounded px-1.5 py-0.5 text-[13px] leading-none text-mute/60 hover:bg-lift/[0.06] hover:text-goldSoft">↻</button>
        <input
          ref={addrRef}
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void goto(); } }}
          placeholder={t('输入网址后回车（例如 xiaohongshu.com）')}
          spellCheck={false}
          className="flex-1 min-w-0 rounded bg-lift/[0.06] px-2 py-1 text-[12px] text-ink/90 outline-none focus:ring-1 focus:ring-gold/40" />
        {/* 只在输入了东西时给一个极简的"去"提示（回车即可，不需要按钮） */}
        {addrBusy && <span className="shrink-0 text-[11px] text-mute/60">{t('打开中…')}</span>}
      </div>

      {/* 这一块是浏览器画面的位置：主进程按它的 rect 画 WebContentsView。
          背景用语义色 bg-base（不是 white-alpha：浅色主题下白叠白会看不见边界）。 */}
      <div ref={boxRef} data-browser-box className="flex-1 min-h-0 relative bg-base">
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-mute/40">
            {t('在上面输入网址，或让 AI 打开一个网页')}
          </div>
        )}
      </div>
      {note && <div className="shrink-0 px-3 py-1 text-[11px] text-red-400/90">{note}</div>}
    </div>
  );
}
