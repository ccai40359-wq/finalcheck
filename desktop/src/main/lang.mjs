// 输出语言规则：英文模式下所有面向用户/报告的文字都用英文（代码、路径、标识符、原文引用保持原样）。
// 只影响「写给人看的内容」，不改变工具的判定口径与结构化字段。
import { getLanguage } from '../renderer/i18n/core.mjs';

export const isEnglish = () => getLanguage() === 'en';

export const outputLanguageRule = () => (isEnglish()
  ? '\n\nOUTPUT LANGUAGE: English. Write every user-facing word — replies, reports, section text, summaries, progress notes — in English, even when the task, filenames or upstream notes are in Chinese. Keep code, commands, paths, identifiers and quoted source lines unchanged.'
  : '');

// 系统提示词追加输出语言规则（传 null/'' 时也安全）
export const withOutputLanguage = (prompt) => String(prompt || '') + outputLanguageRule();
