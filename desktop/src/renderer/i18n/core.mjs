// 双语核心（无 React 依赖，主进程与渲染层共用同一份词典）
// 约定：词典的 key 就是界面上的中文原文，value 是英文译文。
// - 中文模式：t() 原样返回 key（只做占位符替换），所以 zh 不需要词典
// - 英文模式：查表，查不到就回退中文原文（缺译不会渲染成空白）
// - 动态文本用占位符：t('共 {n} 条', { n: 3 })；词典里写 '共 {n} 条': '{n} items'
import { EN_COMMON } from './en/common.js';
import { EN_APP } from './en/app.js';
import { EN_CHAT } from './en/chat.js';
import { EN_SETTINGS } from './en/settings.js';
import { EN_MAIN } from './en/main.js';
import { EN_CHECKS } from './en/checks.js';
import { EN_TITLES } from './en/titles.js';

const DICTS = [EN_COMMON, EN_APP, EN_CHAT, EN_SETTINGS, EN_MAIN, EN_CHECKS, EN_TITLES];
const EN = Object.freeze(Object.assign({}, ...DICTS));

// 只有两个态：界面语言不再有 auto（旧配置的 auto 由 resolveLanguage 落成实际值）
export const LANGUAGES = Object.freeze(['zh', 'en']);

const listeners = new Set();
// 语言状态放在 globalThis 上：主进程里有些模块（agent-service / workflow / swarm）是
// 从 resources 目录 **动态 import** 进来的，拿到的是 core.mjs 的另一份实例。
// 只要各自用局部变量存语言，setLanguage() 就只影响其中一份，界面语言切换对另一份无效。
const LANG_KEY = '__finalcheck_i18n_language__';

function readLanguage() {
  return globalThis[LANG_KEY] === 'en' ? 'en' : 'zh';
}

export function getLanguage() {
  return readLanguage();
}

export function setLanguage(lang) {
  const next = lang === 'en' ? 'en' : 'zh';
  if (next === readLanguage()) return;
  globalThis[LANG_KEY] = next;
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* 单个订阅者出错不影响其他订阅者 */ }
  }
}

export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 设置值 zh/en → 实际语言。旧配置的 auto 与缺省值兼容：按系统语言落成 zh 或 en（中文系统→中文，其余→英文）。
export function resolveLanguage(setting, systemLang) {
  if (setting === 'zh' || setting === 'en') return setting;
  const s = String(systemLang || '').trim().toLowerCase();
  return s.startsWith('zh') ? 'zh' : 'en';
}

// 取译文：en 下查词典，其余（含 zh）返回原文；vars 做 {key} 占位符替换。
export function t(source, vars) {
  const src = source == null ? '' : String(source);
  const text = readLanguage() === 'zh' ? src : (Object.prototype.hasOwnProperty.call(EN, src) ? EN[src] : src);
  if (!vars || typeof vars !== 'object') return text;
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  ));
}

// 供测试/质检用：某条原文是否已有英文译文
export function hasTranslation(source) {
  return Object.prototype.hasOwnProperty.call(EN, String(source == null ? '' : source));
}

export function dictionarySize() {
  return Object.keys(EN).length;
}
