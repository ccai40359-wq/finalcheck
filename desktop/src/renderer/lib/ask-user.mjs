// 回合中途提问（ask_user）：主进程与渲染层共用的纯函数。
// - 工具参数/结果的解析（落库后从 trace.parts 还原成卡片）
// - 回答文本归一（选项 + 自由输入）
// - 历史卡片状态判定：running/无结果 = 未回答（已失效），result.answer = 已回答，取消/中断 = 用户取消
import { t } from '../i18n/core.mjs';

export const ASK_USER_MAX_OPTIONS = 6;
export const ASK_USER_MAX_PER_TURN = 3;
export const ASK_USER_TOOL = 'ask_user';

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return null;
}

/** 工具参数可能是 JSON 字符串（function.arguments）或对象；非法 JSON 返回空对象 */
export function parseAskArgs(args) {
  let raw = args;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const obj = asObject(raw) || {};
  const question = String(obj.question ?? '').trim();
  const options = (Array.isArray(obj.options) ? obj.options : [])
    .slice(0, ASK_USER_MAX_OPTIONS)
    .map((opt) => {
      if (opt == null) return null;
      if (typeof opt === 'string') return { label: opt.trim(), description: '' };
      const o = asObject(opt);
      if (!o) return null;
      return { label: String(o.label ?? '').trim(), description: String(o.description ?? '').trim() };
    })
    .filter((opt) => opt && opt.label);
  return { question, options, multiSelect: obj.multiSelect === true };
}

/** 归一回答：字符串直接当回答；{selected,text} 合并成一句可读文本 */
export function formatAskAnswer(input = {}) {
  const obj = asObject(input) || {};
  const selected = (Array.isArray(obj.selected) ? obj.selected : (obj.selected == null ? [] : [obj.selected]))
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
  const text = String(obj.text ?? '').trim();
  const direct = String(obj.answer ?? '').trim();
  if (direct) return direct.slice(0, 4000);
  if (!selected.length) return text.slice(0, 4000);
  const list = selected.join(' / ');
  return (text ? `${list}${t('；补充：')}${text}` : list).slice(0, 4000);
}

/**
 * trace 里的 ask_user 条目 → 卡片数据。
 * 历史加载时 waiting/running 的 part 已不可能再被回答（进程重启或回合已结束）→ expired。
 * @returns {{callId:string|null, question:string, options:Array<{label:string,description:string}>, multiSelect:boolean, status:'answered'|'cancelled'|'expired'|'rejected', answer:string, error:string|null}}
 */
export function askUserCardFromTrace(entry) {
  const args = parseAskArgs(entry?.args);
  const result = asObject(entry?.result);
  const error = String(entry?.error ?? result?.error ?? '').trim();
  const rawAnswer = result && typeof result.answer === 'string' ? result.answer.trim() : '';
  const interrupted = !!error && /未完成|进程中断|已中断/.test(error) && !result?.cancelled;
  let cardStatus = 'expired';
  if (rawAnswer) cardStatus = 'answered';
  else if (result?.cancelled || entry?.cancelled || (error && /用户取消|cancel/i.test(error))) cardStatus = 'cancelled';
  else if (error && !interrupted) cardStatus = 'rejected';
  else cardStatus = 'expired';
  return {
    callId: entry?.callId == null ? null : String(entry.callId),
    question: args.question,
    options: args.options,
    multiSelect: args.multiSelect,
    status: cardStatus,
    answer: rawAnswer,
    error: error || null
  };
}

export function isAskUserTrace(entry) {
  return String(entry?.tool ?? entry?.name ?? '') === ASK_USER_TOOL;
}
