// Sidebar 底部 Settings 行的更新入口（纯函数，tests/ 直测，不依赖 React/DOM/i18n）。
//
// ≤0.29.3：红点（有新版本）+ 绿点（IPC 存活）。0.29.4 起改为金色「Update v{version}」按钮：
// - 只在发现新版本（version 非空）时渲染；无更新 = 按钮不渲染
// - 点击走既有下载流程（finalcheck:update:download），已下载后点击走重启安装（finalcheck:update:install）
// - 下载/安装中状态跟随主进程既有 update 事件（progress / downloaded / error），不新增协议
// - 不 openExternal、不硬编码 owner/repo（updater-state.mjs 红线）
// 绿点删除依据：IPC 断连提示不静默消失——Settings 页已有等效提示（App.jsx 全局琥珀横幅在
// Settings 页同样渲染 + SettingsPage 卡片内 ErrorNote「请在 Electron 中运行…」）。

const cleanVersion = (v) => {
  const s = String(v ?? '').replace(/^v/i, '').trim();
  if (!s || s === 'undefined' || s === 'null' || /[{}"[\]]/.test(s)) return '';
  return s.slice(0, 40);
};

export const SIDEBAR_UPDATE_INITIAL = Object.freeze({ version: '', phase: 'idle', percent: null });

// 主进程 update-event → 按钮状态。与 SettingsPage 的 reduceUpdateEvent 消费同一批事件，
// 但只保留按钮需要的最小投影：available / downloading / downloaded 三态 + 进度百分比。
// 未知事件保持原状态（与 updater-state.mjs 的容错约定一致）。
export function reduceSidebarUpdateEvent(prev, ev) {
  const base = prev && typeof prev === 'object' ? { ...SIDEBAR_UPDATE_INITIAL, ...prev } : { ...SIDEBAR_UPDATE_INITIAL };
  const type = ev && typeof ev === 'object' ? String(ev.type || '') : '';
  switch (type) {
    case 'available':
      return { version: cleanVersion(ev.version) || base.version, phase: 'available', percent: null };
    case 'not-available':
      // 没有新版本 = 按钮不渲染（回到初始态）
      return { ...SIDEBAR_UPDATE_INITIAL };
    case 'progress': {
      // progress 只在下载期出现；静默检查/其它阶段收到进度不改变按钮
      if (base.phase !== 'available' && base.phase !== 'downloading') return base;
      const n = Number(ev.percent);
      const percent = Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0;
      return { ...base, phase: 'downloading', percent };
    }
    case 'downloaded':
      return { version: cleanVersion(ev.version) || base.version, phase: 'downloaded', percent: 100 };
    case 'error':
      // 下载失败回到「可下载」态（按钮可重试）；静默检查期的报错不动按钮
      return base.phase === 'downloading' ? { ...base, phase: 'available', percent: null } : base;
    default:
      return base;
  }
}

/**
 * 按钮视图模型（Sidebar 渲染时用 t(labelKey, params) 出文案）：
 * - 无更新（version 空）       → { visible: false }
 * - available                 → 「Update v{v}」，点击 action='download'
 * - downloading               → 「下载中 {percent}%」，禁点（进度详情在 Settings 页）
 * - downloaded                → 「重启并安装」，点击 action='install'
 */
export function sidebarUpdateButton(state) {
  const s = state && typeof state === 'object' ? state : SIDEBAR_UPDATE_INITIAL;
  const version = cleanVersion(s.version);
  if (!version || s.phase === 'not-available') return { visible: false }; // 无更新 = 按钮不渲染
  if (s.phase === 'downloading') {
    const p = Number.isFinite(s.percent) ? s.percent : 0;
    return { visible: true, action: null, disabled: true, labelKey: '下载中 {percent}%', params: { percent: p } };
  }
  if (s.phase === 'downloaded') {
    return { visible: true, action: 'install', disabled: false, labelKey: '重启并安装', params: {} };
  }
  return { visible: true, action: 'download', disabled: false, labelKey: 'Update v{v}', params: { v: version } };
}
