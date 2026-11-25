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

export function BrowserPane({ y, sessionId, visible, onPageTitle }) {
  const boxRef = useRef(null);
  const addrRef = useRef(null);
  const refreshSequence = useRef(0);
  const [view, setView] = useState({ tabs: [], activeId: null });
  const [draft, setDraft] = useState(null);
  const [focusId, setFocusId] = useState(null);
  const [addrBusy, setAddrBusy] = useState(false);
  const [note, setNote] = useState('');
  const { tabs, activeId } = view;
  const current = tabs.find((tab) => tab.id === activeId);
  const addr = draft?.tabId === activeId ? draft.text : current?.url || '';

  // WebContentsView 不会随 DOM 布局变化。用一帧中的最后一个尺寸更新原生视图。
  useEffect(() => {
    const box = boxRef.current;
    if (!visible || !box || !y?.railRect) {
      void y?.railVisible?.(false, sessionId);
      return undefined;
    }
    let frame = 0;
    let previous = '';
    const reportRect = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = box.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) {
          previous = '';
          void y.railVisible?.(false, sessionId);
          return;
        }
        const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
        const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
        if (key === previous) return;
        previous = key;
        void y.railRect(rect, sessionId);
        void y.railVisible?.(true, sessionId);
      });
    };
    const observer = new ResizeObserver(reportRect);
    observer.observe(box);
    window.addEventListener('resize', reportRect);
    reportRect();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', reportRect);
      void y.railVisible?.(false, sessionId);
    };
  }, [visible, y, sessionId]);

  const refreshTabs = useCallback(async () => {
    if (!y?.browserTabs) return;
    const sequence = ++refreshSequence.current;
    try {
      const r = await y.browserTabs(sessionId);
      if (sequence !== refreshSequence.current || !r || r.ok === false) return;
      const list = Array.isArray(r.tabs) ? r.tabs : [];
      const viewed = list.find((tab) => tab.id === r.activeId);
      setView({ tabs: list, activeId: viewed?.id || null });
      onPageTitle?.(viewed?.title || viewed?.url || '', sessionId);
    } catch { /* 无宿主时允许稍后重试 */ }
  }, [y, sessionId, onPageTitle]);

  useEffect(() => {
    const stop = y?.onBrowserTabsChanged?.((owner) => {
      if (owner === sessionId) void refreshTabs();
    });
    void refreshTabs();
    const timer = visible ? setInterval(refreshTabs, 3000) : null;
    return () => {
      stop?.();
      if (timer) clearInterval(timer);
      refreshSequence.current++;
    };
  }, [visible, refreshTabs, y, sessionId]);

  useEffect(() => {
    if (visible && focusId && focusId === activeId) {
      addrRef.current?.focus();
      setFocusId(null);
    }
  }, [activeId, focusId, visible]);

  const goto = async () => {
    const url = normalizeUrl(addr);
    if (!url) return setNote(t('请输入网址'));
    const submitted = draft;
    setAddrBusy(true);
    setNote('');
    try {
      const r = await y?.browserGoto?.(url, activeId, sessionId);
      if (!r || r.ok === false) setNote(String(r?.error || t('打开失败')));
      else {
        await refreshTabs();
        setDraft((value) => (value === submitted ? null : value));
      }
    } catch (e) {
      setNote(String(e?.message || e));
    } finally {
      setAddrBusy(false);
    }
  };

  const switchTo = async (id) => {
    if (id !== activeId) setDraft(null);
    setFocusId(null);
    setNote('');
    await y?.browserTabSwitch?.(id, sessionId);
    await refreshTabs();
  };
  const closeTab = async (e, id) => {
    e.stopPropagation();
    setDraft((value) => (value?.tabId === id ? null : value));
    setFocusId((value) => (value === id ? null : value));
    await y?.browserTabClose?.(id, sessionId);
    await refreshTabs();
  };

  const openBlank = async () => {
    setNote('');
    try {
      const r = await y?.browserTabOpen?.('', sessionId);
      if (!r || r.ok === false) {
        setNote(String(r?.error || t('新标签打开失败')));
        return;
      }
      setDraft(null);
      setFocusId(r.id);
      await refreshTabs();
    } catch (e) { setNote(String(e?.message || e)); }
  };

  // 0.33.4：刷新不再要求 tab.url 非空（加载失败的页面 url 是空的，以前点了没反应）——主进程按
  // 当前网址 / 最近要打开的网址重试；Shift+点击 = 强制刷新（忽略缓存）
  const reloadPage = async (e) => {
    if (!current) return;
    setNote('');
    try {
      const r = await y?.browserTabReload?.(current.id, sessionId, { hard: e?.shiftKey === true });
      if (!r || r.ok === false) setNote(String(r?.error || t('重新加载失败')));
      await refreshTabs();
    } catch (err) { setNote(String(err?.message || err)); }
  };
  const navPage = async (dir) => {
    if (!current) return;
    setNote('');
    try {
      const r = await y?.browserTabNav?.(current.id, dir, sessionId);
      if (r && r.ok === false && dir !== 'stop') setNote(String(r.error || ''));
      await refreshTabs();
    } catch (err) { setNote(String(err?.message || err)); }
  };

  const openExternal = async () => {
    const url = current?.url || normalizeUrl(addr);
    if (!url) return setNote(t('没有可打开的网址'));
    setNote('');
    try {
      const r = await y?.browserOpenExternal?.(url);
      if (!r || r.ok === false) setNote(String(r?.error || t('打开失败')));
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
          而且它挤占了地址栏宽度（用户反馈"这个 Open 是啥意思"）。
          0.32.4：右边换成「在默认浏览器打开」（用户点名的 ZCode 同款）——
          扫码登录时如果站点非要跳外部浏览器，用户可以主动在这里打开，而不是页面自己跑出去。 */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 h-9 border-b border-edge/60">
        {/* 0.33.4：和 Edge 一样的 ← → ↻（加载中变 ✕ 停止）；页面里 Alt+← / Alt+→ / F5 也能用 */}
        <button onClick={() => { void navPage('back'); }} disabled={!current?.canGoBack} title={t('后退（Alt+←）')}
          data-browser-back aria-label={t('后退')}
          className="shrink-0 h-6 w-6 inline-flex items-center justify-center rounded text-mute/70 hover:bg-lift/[0.06] hover:text-goldSoft disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-mute/70">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
        </button>
        <button onClick={() => { void navPage('forward'); }} disabled={!current?.canGoForward} title={t('前进（Alt+→）')}
          data-browser-forward aria-label={t('前进')}
          className="shrink-0 h-6 w-6 inline-flex items-center justify-center rounded text-mute/70 hover:bg-lift/[0.06] hover:text-goldSoft disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-mute/70">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
        {current?.loading ? (
          <button onClick={() => { void navPage('stop'); }} title={t('停止加载')}
            data-browser-stop aria-label={t('停止加载')}
            className="shrink-0 h-6 w-6 inline-flex items-center justify-center rounded text-mute/70 hover:bg-lift/[0.06] hover:text-goldSoft">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        ) : (
          <button onClick={(e) => { void reloadPage(e); }} disabled={!current} title={t('刷新（F5；Shift+点击强制刷新）')}
            data-browser-reload aria-label={t('刷新')}
            className="shrink-0 h-6 w-6 inline-flex items-center justify-center rounded text-mute/70 hover:bg-lift/[0.06] hover:text-goldSoft disabled:opacity-30">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
          </button>
        )}
        <input
          ref={addrRef}
          data-browser-address
          value={addr}
          onChange={(e) => setDraft({ tabId: activeId, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
            if (e.key === 'Enter') { e.preventDefault(); void goto(); }
          }}
          placeholder={t('输入网址后回车（例如 xiaohongshu.com）')}
          spellCheck={false}
          className="flex-1 min-w-0 rounded bg-lift/[0.06] px-2 py-1 text-[12px] text-ink/90 outline-none focus:ring-1 focus:ring-gold/40" />
        {/* 只在输入了东西时给一个极简的"去"提示（回车即可，不需要按钮） */}
        {addrBusy && <span className="shrink-0 text-[11px] text-mute/60">{t('打开中…')}</span>}
        {/* 0.33.4：这个标签用的存储——长期保留（登录态写盘，重启还在）还是无痕（关掉就没） */}
        {current && (
          <span data-browser-mode={current.persistent ? 'persistent' : 'oneshot'}
            title={current.persistent ? t('长期保留：登录状态会保存，重启 FinalCheck 后仍在') : t('无痕：登录状态只在本次会话有效，关掉就没了')}
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none ${current.persistent ? 'bg-jade/10 text-jade/90' : 'bg-lift/[0.06] text-mute/70'}`}>
            {current.persistent ? t('长期保留') : t('无痕')}
          </span>
        )}
        <button onClick={() => { void openExternal(); }} title={t('在默认浏览器打开（当前网页）')}
          data-browser-external
          className="shrink-0 rounded px-1.5 py-0.5 text-[13px] leading-none text-mute/60 hover:bg-lift/[0.06] hover:text-goldSoft">⧉</button>
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
