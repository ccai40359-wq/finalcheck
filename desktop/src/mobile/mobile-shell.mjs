// 手机外壳：只做「窄屏 / 触屏」相关的最少的事，不改桌面界面本身。
//   · <html> 打标记：fc-mobile（网页版）、fc-narrow（≤820px）、fc-touch（触屏），样式见 mobile.css
//   · 窄屏左栏是抽屉：默认收起；点遮罩 / 选了会话 / 新建会话后自动收回
//   · 长按 = 桌面的右键（iOS Safari 不发 contextmenu，这里补上）
const root = document.documentElement;
root.classList.add('fc-mobile');
const narrowMq = window.matchMedia('(max-width: 820px)');
const touchMq = window.matchMedia('(hover: none), (pointer: coarse)');
const sync = () => {
  root.classList.toggle('fc-narrow', narrowMq.matches);
  root.classList.toggle('fc-touch', touchMq.matches);
};
sync();
narrowMq.addEventListener?.('change', sync);
touchMq.addEventListener?.('change', sync);

// 0.34.3 双指缩放（字太小 / 看图细节）：viewport 里的 maximum-scale=1 是给 iOS 挡「点输入框整页放大」的——
// iOS 本来就忽略它对双指缩放的限制；但 Android 会照做，结果双指缩放被锁死。非 iOS 去掉它。
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (!isIOS) {
  const vp = document.querySelector('meta[name="viewport"]');
  if (vp) vp.setAttribute('content', vp.getAttribute('content').replace(/,?\s*maximum-scale=[\d.]+/, ''));
}

// 窄屏首次打开：左栏默认收起（桌面界面自己记 localStorage 里的这个键）
if (narrowMq.matches) {
  try { localStorage.setItem('fc.sidebarCollapsed', '1'); } catch { /* 无痕模式 */ }
}

// iOS：可视高度随地址栏 / 键盘变化，用真实可视高度撑满
const vh = () => root.style.setProperty('--fc-vh', `${Math.round(window.visualViewport?.height || window.innerHeight)}px`);
vh();
window.visualViewport?.addEventListener('resize', vh);
window.addEventListener('resize', vh);
// 键盘弹起时 iOS 会把整页往上推，收起键盘后不回位：滚回顶
window.visualViewport?.addEventListener('resize', () => { if (window.scrollY) window.scrollTo(0, 0); });

// ---------------- 左栏抽屉 ----------------
const sidebarOpen = () => {
  const el = document.querySelector('.fc-sidebar');
  return !!el && !el.classList.contains('fc-sidebar-collapsed');
};
const settingsNav = () => document.querySelector('nav.glass-side');
const setSettingsNav = (open) => root.classList.toggle('fc-settings-nav-open', !!open && narrowMq.matches && !!settingsNav());
const closeDrawer = () => {
  if (root.classList.contains('fc-settings-nav-open')) { setSettingsNav(false); return; }
  if (narrowMq.matches && sidebarOpen()) document.querySelector('[data-ui="sidebar-toggle"]')?.click();
};

function mountScrim() {
  if (document.getElementById('fc-mobile-scrim')) return;
  const scrim = document.createElement('div');
  scrim.id = 'fc-mobile-scrim';
  scrim.addEventListener('click', closeDrawer);
  document.body.appendChild(scrim);
}
// 设置页会把侧栏整个换掉，侧栏「展开」的状态还留着：从设置页回来时抽屉会自己弹开盖住聊天。
// 点「Settings」时记一笔，侧栏重新出现时把它收起来。
let collapseOnReturn = false;
// 设置页导航（窄屏是左侧抽屉）：一进设置页就展开，像桌面那样先看到全部分节；离开设置页就收掉
let settingsShown = false;
const watchSettings = () => {
  const has = !!settingsNav();
  if (has && !settingsShown) setSettingsNav(true);
  if (!has && settingsShown) root.classList.remove('fc-settings-nav-open');
  settingsShown = has;
};
const watchDrawer = () => {
  if (collapseOnReturn && document.querySelector('.fc-sidebar')) {
    collapseOnReturn = false;
    if (narrowMq.matches && sidebarOpen()) { document.querySelector('[data-ui="sidebar-toggle"]')?.click(); return; }
  }
  root.classList.toggle('fc-drawer-open', sidebarOpen());
};
new MutationObserver(() => { mountScrim(); watchDrawer(); watchSettings(); }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });

// 设置页：左上角侧栏按钮开关的是设置导航抽屉（设置页没有会话侧栏）；导航里选了一项就收回
document.addEventListener('click', (e) => {
  if (!narrowMq.matches || !settingsNav()) return;
  if (e.target.closest?.('[data-ui="sidebar-toggle"]')) {
    e.preventDefault(); e.stopPropagation();
    setSettingsNav(!root.classList.contains('fc-settings-nav-open'));
    return;
  }
  const btn = e.target.closest?.('nav.glass-side button');
  if (btn && !btn.hasAttribute('aria-expanded')) setTimeout(() => setSettingsNav(false), 120); // 「高级」展开按钮不收
}, true);

// 抽屉里点了「会话」或「New Session」：桌面是侧栏常驻，手机上要让出屏幕给聊天
document.addEventListener('click', (e) => {
  if (!narrowMq.matches || !sidebarOpen()) return;
  const side = e.target.closest?.('.fc-sidebar');
  if (!side) return;
  const btn = e.target.closest('button, [role="button"], a');
  // 会话行是 div（整行可点）；行里的小按钮（归档等）不算
  // 项目行也是可点的 div（展开 / 收起），它是 pl-1；会话行是 pl-2
  const isSession = !btn && !!e.target.closest('div.cursor-pointer.rounded-lg.pl-2');
  if (isSession) { setTimeout(closeDrawer, 120); return; }
  if (!btn) return;
  const label = (btn.textContent || '').trim();
  const isNew = /^(\+\s*)?(New Session|新会话|新建会话)$/i.test(label) || btn.getAttribute('aria-label') === '新建会话'
    || /在这个项目里新建对话|New session in this workspace/i.test(btn.title || ''); // 项目行上的「＋」
  const isSettings = /^(Settings|设置)$/i.test(label);
  if (isSettings) { collapseOnReturn = true; return; }
  if (isNew) setTimeout(closeDrawer, 120);
}, true);

// ---------------- 长按 → 右键菜单 ----------------
let pressTimer = null;
let pressStart = null;
document.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  pressStart = { x: t.clientX, y: t.clientY, target: e.target };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (!pressStart) return;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: pressStart.x, clientY: pressStart.y, button: 2 });
    pressStart.target.dispatchEvent(ev);
    if (ev.defaultPrevented) {
      navigator.vibrate?.(10);
      // 长按触发了菜单：吞掉随后那次 click，不然手指一抬又打开了会话
      const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 600);
    }
    pressStart = null;
  }, 480);
}, { passive: true });
const cancelPress = (e) => {
  if (!pressStart) return;
  const t = e.touches?.[0];
  if (e.type === 'touchmove' && t && Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) < 10) return;
  clearTimeout(pressTimer);
  pressStart = null;
};
document.addEventListener('touchmove', cancelPress, { passive: true });
document.addEventListener('touchend', cancelPress, { passive: true });
document.addEventListener('touchcancel', cancelPress, { passive: true });
// Android Chrome 自己会发 contextmenu：和上面的合成事件撞车时只认一次
let lastCtx = 0;
document.addEventListener('contextmenu', (e) => {
  const now = Date.now();
  if (now - lastCtx < 700 && e.isTrusted) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  lastCtx = now;
}, true);
