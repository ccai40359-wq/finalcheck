// WorkingStatus 文案（纯函数，渲染层与单测共用；不含 JSX，node --test 可直接导入）
// 原则：只由真实事件驱动，没有事件时保持默认 "Working"，不伪造百分比/进度。
// 英文模式：固定文案走 t()（zh 下原样返回，中文输出不变）；主进程动态 label 也在此翻译。
import { t } from '../i18n/core.mjs';

export const DEFAULT_WORKING_LABEL = 'Working';
export const RETRY_REASON_MAX = 40;

/** 重试原因人话化：网关 5xx / 网络错误 / 超时统一说「网关无响应」，其余原样截断 40 字 */
export function humanizeRetryReason(reason) {
  const text = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (
    /HTTP\s*5\d\d/i.test(text)
    || /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|connection reset/i.test(text)
    || /超时|timeout|aborted/i.test(text)
  ) return t('网关无响应');
  return text.length > RETRY_REASON_MAX ? text.slice(0, RETRY_REASON_MAX) + '…' : text;
}

/** retry 事件 → 用户文案：`重试 2/5 · 网关无响应` */
export function retryLabel(ev) {
  const attempt = Number(ev?.attempt) || 0;
  const max = Number(ev?.max) || 0;
  const head = max ? t('重试 {attempt}/{max}', { attempt, max }) : t('重试');
  const reason = humanizeRetryReason(ev?.reason);
  return reason ? `${head} · ${reason}` : head;
}

/** 最近一条 activity / retry → WorkingStatus 文案；没有则回默认 Working */
export function activityText(activity) {
  if (!activity || typeof activity !== 'object') return DEFAULT_WORKING_LABEL;
  if (activity.kind === 'retry') return retryLabel(activity);
  const label = typeof activity.label === 'string' ? activity.label.trim() : '';
  if (!label) return DEFAULT_WORKING_LABEL;
  // 主进程的静默提示带秒数（「网关已静默 90s…」），走带占位符的词条
  const silent = label.match(/^网关已静默\s*(\d+)s…$/);
  if (silent) return t('网关已静默 {sec}s…', { sec: silent[1] });
  return t(label);
}

/** 颜色语义：retry 用琥珀（异常/等待），activity 用金色（正常工作） */
export function activityTone(activity) {
  return activity?.kind === 'retry' ? 'retry' : 'activity';
}
