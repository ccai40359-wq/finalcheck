// 0.32.5 P0：这一整块都是给「打开浏览器时 App 巨卡」治根的。
//
// 根因（真机可复现，不是推测）：refreshTabs 是这个组件的 useCallback，依赖里有 onTabsChange。
// 而父组件 RightRail 传的是**内联箭头函数**（每次渲染都是新引用），所以
//   App 任一处 setState → RightRail 重渲染 → onTabsChange 新引用 →
//   refreshTabs 新引用 → 下面的 effect 重跑 → 再调一次 IPC → setTabs(全新数组) →
//   onTabsChange(...) → 父组件 setRail(新对象) → App 重渲染 → …… 无限正反馈。
// 每轮一次 IPC 往返，实测能把主进程的事件循环打满，于是"切会话、打字都巨卡"。
// 而那个闭包里捕获的 rail.activeKey 是旧的（'browser'），所以用户点 PNG tab 后被切回去
// ——这就是"开了浏览器就点不了图片。
//
// 三条断环规则：
//   ① 回调走 ref（yRef/callbackRef），**不进依赖数组**（函数换引用不再触发重跑）
//   ② 标签数组做**结构化比较**，真没变就保留上一个数组引用（React bail out）
//   ③ 轮询周期从 3s 放宽到 5s，且只在面板可见且窗口有焦点时才轮询
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

export function BrowserPane({ y, visible, onPageTitle }) {
  const boxRef = useRef(null);
  const addrRef = useRef(null);
  const [tabs, setTabs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [addr, setAddr] = useState('');
  const [addrBusy, setAddrBusy] = useState(false);
  const [note, setNote] = useState('');

  // 0.32.5：把会变的输入全部搬进 ref——它们是**读**用的，不该出现在依赖数组里。
  // y / visible / onTabsChange 每次渲染都可能是新引用，一旦进 useCallback 依赖，
  // 就会形成「父组件重渲染 → 回调换引用 → effect 重跑 → 调 IPC → 父组件再重渲染」的死循环。
  const yRef = useRef(y);
  yRef.current = y;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const onPageTitleRef = useRef(onPageTitle);
  onPageTitleRef.current = onPageTitle;
  // addrBusy 也只读不依赖：它是「用户正在提交地址栏」，进依赖数组同样会让 refreshTabs 换实例
  const addrBusyRef = useRef(addrBusy);
  addrBusyRef.current = addrBusy;
  // 上一次的状态（用于结构化比较，避免每次 setTabs 都换新数组/新对象）
  const tabsKeyRef = useRef('');
  const lastActiveRef = useRef(null);
  const lastTitleRef = useRef('');

  // 上报内容区 rect：浏览器画面就画在这块 div 的位置上。
  // 0.32.4「丝滑」：ResizeObserver 在拖动右栏时**每帧都触发**，每次都走一次 IPC 往返，
  // 而 WebContentsView 是原生层（不在渲染管线里），跟着这种高频往返会抖。
  // 做法：rAF 合并（一帧最多一次）+ 只在 rect 真变了才发（相同 rect 直接跳过）。
  const rectRaf = useRef(0);
  const lastRect = useRef('');
  const reportRect = useCallback(() => {
    const el = boxRef.current;
    const api = yRef.current;
    if (!el || !api?.railRect) return;
    if (!visibleRef.current) { void api.railVisible?.(false); return; }
    if (rectRaf.current) return; // 本帧已经排好了
    rectRaf.current = requestAnimationFrame(() => {
      rectRaf.current = 0;
      const node = boxRef.current;
      if (!node) return;
      if (!visibleRef.current) { void yRef.current?.railVisible?.(false); return; }
      const r = node.getBoundingClientRect();
      // 宽高为 0（面板被折叠/还没布局）时按「不可见」处理，避免主进程按 0 尺寸画
      if (r.width < 8 || r.height < 8) { void yRef.current?.railVisible?.(false); return; }
      const payload = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      const key = `${payload.x},${payload.y},${payload.width},${payload.height}`;
      if (key === lastRect.current) return; // 没变就不发（拖到边界/抖动时省掉大量往返）
      lastRect.current = key;
      void yRef.current?.railRect(payload);
      void yRef.current?.railVisible?.(true);
    });
  }, []); // ← 依赖为空：回调只从 ref 读，实例永不重建（这是断环的关键）
  // 组件卸载时取消排队中的帧
  useEffect(() => () => { if (rectRaf.current) cancelAnimationFrame(rectRaf.current); }, []);

  /** 标签数组的结构签名：内容真的没变时，用它避免 setTabs 造出新引用 */
  const tabsSignature = (list) => list
    .map((x) => `${x?.id}\u0001${x?.url || ''}\u0001${x?.title || ''}`)
    .join('\u0002');

  /**
   * 0.32.5：读一次标签清单并**按需**更新本地状态。
   * 三条断环规则见文件头注释；这里落地的是 ①②（回调走 ref、结构比较 bail out）。
   */
  const refreshTabs = useCallback(async () => {
    const api = yRef.current;
    if (!api?.browserTabs) return;
    try {
      const r = await api.browserTabs();
      if (!r || r.ok === false) return;
      const list = Array.isArray(r.tabs) ? r.tabs : [];
      const sig = tabsSignature(list);
      if (sig !== tabsKeyRef.current) {
        tabsKeyRef.current = sig;
        setTabs(list);                       // ← 只有内容真的变了才换数组
      }
      const nextActive = r.activeId || null;
      if (nextActive !== lastActiveRef.current) {
        lastActiveRef.current = nextActive;
        setActiveId(nextActive);
      }
      const act = list.find((x) => x.id === nextActive);
      const pageTitle = String(act?.title || act?.url || '').trim();
      // 地址栏只在用户没在输入时跟随（否则会把他正在打的字冲掉）
      if (act?.url && !addrBusyRef.current) setAddr((prev) => (prev === act.url ? prev : act.url));
      // ← ③ 网页标题只在真的变化时上抛，且父组件那端是纯更新（不改 activeKey）
      if (pageTitle && pageTitle !== lastTitleRef.current) {
        lastTitleRef.current = pageTitle;
        try { onPageTitleRef.current?.(pageTitle); } catch { /* UI 回调故障不影响浏览器 */ }
      }
    } catch { /* 无宿主时静默（右栏可能只是还没打开网页） */ }
  }, []); // ← 依赖为空：所有输入都走 ref

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
    if (visible) reportRect();
    else void yRef.current?.railVisible?.(false);
  }, [visible, reportRect]);

  // ⚠️ 卸载时必须把画面藏起来（这是 0.32.1 修的两个真 bug 的同一个根因）：
  //   ① 切到产物/子代理 tab 后，网页那张 WebContentsView 仍盖在原位 → 下面的标签点不动（"被锁住"）
  //   ② 切到设置页时整个右栏卸载了，画面却还留在屏幕上（用户实测：设置页右边压着小红书）
  // 卸载后没有任何组件再持有它，所以只有这里能通知主进程。
  useEffect(() => () => { void yRef.current?.railVisible?.(false); }, []);

  // 标签状态：打开页面后由工具层推送，这里也做一次兜底轮询。
  // 0.32.5：3s → 5s，并且只在「面板可见」时轮询；页面标题由主进程的
  // browser-tabs 一次带回，不再由 UI 侧反复 setState 上抛（那正是卡顿的燃料）。
  useEffect(() => {
    void refreshTabs();
    if (!visible) return undefined;
    const id = setInterval(() => { void refreshTabs(); }, 5000);
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

  // 0.32.4：用户主动「在默认浏览器打开」当前网页。
  // 这是把内嵌页面送到系统浏览器的唯一正当入口——页面自己不会跑出去
  // （index.mjs 的全局守卫 + browser-view-host 的夺回逻辑保证页面内导航都留在内嵌浏览器里）。
  const openExternal = async () => {
    const cur = tabs.find((x) => x.id === activeId);
    const url = cur?.url || normalizeUrl(addr);
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
