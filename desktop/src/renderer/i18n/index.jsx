// React 绑定：语言切换后整棵界面重渲染（useSyncExternalStore 订阅 core 的语言状态）
import { useSyncExternalStore } from 'react';
import { getLanguage, setLanguage, subscribe, resolveLanguage, t } from './core.mjs';

export function useLanguage() {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

export function useI18n() {
  const lang = useLanguage();
  return { lang, t, setLanguage, resolveLanguage };
}

export { t, setLanguage, resolveLanguage, getLanguage };
