// 0.34.3 界面缩放快捷键的渲染层兜底。
// 主进程 before-input-event 是主路径（拦到就 preventDefault，页面收不到这次按键，所以不会缩两档）；
// 万一主进程没拦到（输入法 / 键盘布局 / 焦点在特殊控件上），页面这里再接一次。
/** Ctrl/Cmd + = / + / - / 0 → 'zoom-in' | 'zoom-out' | 'zoom-reset'；其它返回 null */
export function zoomActionForKey(e, isMac = false) {
  if (!e || e.altKey) return null;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod) return null;
  const key = String(e.key || '');
  const code = String(e.code || '');
  if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') return 'zoom-in';
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') return 'zoom-out';
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'zoom-reset';
  return null;
}
