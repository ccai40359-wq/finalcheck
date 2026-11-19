// 界面主题：深色（墨黑鎏金，默认）/ 浅色（宣纸暖白）。
//
// 为什么只有两个值、默认深色：0.23.0 之前的界面是唯一一套深色皮肤，浅色是新增选项；
// 默认值必须保持 dark，否则老用户升级后界面会突然变白。
//
// 颜色本身不在这里，而是 CSS 变量（styles.css 的 :root / [data-theme="light"]）。
// 这里只负责「哪个主题」「怎么落到 DOM 上」「怎么从磁盘/本地缓存读回」这些纯逻辑，
// 便于 tests 直接 import 单测（无 React、无 DOM 依赖）。

export const THEMES = Object.freeze(['dark', 'light']);
export const DEFAULT_THEME = 'dark';

// 首屏防闪：index.html 的内联脚本读 localStorage（同步、早于 React 挂载），
// React 挂载后再以 config.json 为准纠正。两边必须用同一个 key。
export const THEME_STORAGE_KEY = 'fc.theme';

/** 任何输入 → 'dark' | 'light'（未知值一律回落到默认深色，不抛错） */
export function normalizeTheme(value) {
  return value === 'light' ? 'light' : DEFAULT_THEME;
}

/** 切换用：dark ⇄ light */
export function nextTheme(value) {
  return normalizeTheme(value) === 'dark' ? 'light' : 'dark';
}

export function isLight(value) {
  return normalizeTheme(value) === 'light';
}

/**
 * 读本地缓存主题（首屏用）。storage 可以是 localStorage 或任何 getItem 实现；
 * 读不到/抛错 → 默认深色。
 */
export function readCachedTheme(storage) {
  try {
    return normalizeTheme(storage?.getItem?.(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** 写本地缓存（只影响下次首屏，不写配置文件） */
export function writeCachedTheme(storage, value) {
  try {
    storage?.setItem?.(THEME_STORAGE_KEY, normalizeTheme(value));
  } catch { /* 隐私模式 / 配额满：缓存失败不影响定稿主题，忽略 */ }
}

/**
 * 落到 DOM：给 <html> 加 data-theme。
 * CSS 用 [data-theme="light"] 覆盖变量，所以这里只要改这一个属性，全树自动跟随。
 */
export function applyThemeToDocument(doc, value) {
  const theme = normalizeTheme(value);
  const root = doc?.documentElement;
  if (!root) return theme;
  root.dataset.theme = theme;
  // color-scheme 让原生控件（滚动条、输入框、日期选择器）跟着变，否则浅色下滚动条还是黑的
  root.style.colorScheme = theme;
  return theme;
}
