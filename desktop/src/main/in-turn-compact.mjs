// 回合内「全面压缩」由模型写摘要（2026-11-19，对齐 Claude Code 的 auto-compact）。
//
// 旧做法（context.mjs fullCompact）是纯本地拼接：用户原话只留前 60 字、每条结论只留前 80 字，
// 工具清单只有名字——压一次就丢掉「用户要什么、做到哪、踩过什么坑」，模型只能从头摸索。
// Claude Code 的做法是到线时让模型自己写一份交接摘要，再带着摘要继续干。这里同样：
//   ① 用户的真实原话原样保留（不是摘要，是原文）；
//   ② 其余历史交给模型写结构化交接摘要（要求/已完成/关键发现/当前进度/下一步）；
//   ③ 模型摘要失败或超时 → 回落到本地 fullCompact，绝不阻断回合；
//   ④ 保留最近若干条消息原样（配对安全：不从 tool 消息开头）。
import { fullCompact } from './context.mjs';

export const KEEP_RECENT_MODEL_COMPACT = 8;
const PER_MSG_CHARS = 2000;
const PER_TOOL_CHARS = 1200;
const TRANSCRIPT_MAX_CHARS = 120000;
const USER_TEXT_MAX_CHARS = 8000;
const SUMMARY_TIMEOUT_MS = 120000;
const USER_BLOCK_HEAD = '【用户原话（原样保留）】';
const SUMMARY_HEAD = '【交接摘要】';

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p?.type === 'text' ? p.text : p?.type === 'image_url' ? '[图片]' : '')).join(' ');
  return String(content);
}

const cut = (s, n) => (s.length > n ? s.slice(0, n) + `…（截断，原长 ${s.length} 字）` : s);

/** 用户亲口说的话（排除 [系统] 提醒、旧摘要、图片附带的系统说明）。 */
export function isRealUserText(m) {
  if (m?.role !== 'user') return false;
  const t = textOf(m.content).trim();
  return !!t && !t.startsWith('[系统]') && !t.startsWith('[历史摘要]');
}

/** 压缩区的可读转写：给模型写摘要用。超长时保头保尾（开头是需求，结尾是当前进度）。 */
export function transcriptOf(zone) {
  const calls = new Map();
  for (const m of zone) for (const tc of (Array.isArray(m?.tool_calls) ? m.tool_calls : [])) if (tc?.id) calls.set(tc.id, tc?.function?.name || '工具');
  const lines = [];
  for (const m of zone) {
    if (m?.role === 'user') lines.push(`【${isRealUserText(m) ? '用户' : '系统提示'}】${cut(textOf(m.content), PER_MSG_CHARS)}`);
    else if (m?.role === 'assistant') {
      const say = textOf(m.content).trim();
      if (say) lines.push(`【助手】${cut(say, PER_MSG_CHARS)}`);
      for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
        lines.push(`【调用 ${tc?.function?.name || '工具'}】${cut(String(tc?.function?.arguments ?? ''), 400)}`);
      }
    } else if (m?.role === 'tool') {
      lines.push(`【结果 ${calls.get(m.tool_call_id) || ''}】${cut(textOf(m.content), PER_TOOL_CHARS)}`);
    } else if (m?.role === 'system') {
      lines.push(`【系统】${cut(textOf(m.content), 600)}`);
    }
  }
  let text = lines.join('\n');
  if (text.length > TRANSCRIPT_MAX_CHARS) {
    const head = Math.floor(TRANSCRIPT_MAX_CHARS * 0.3);
    text = text.slice(0, head) + `\n…（中间 ${text.length - TRANSCRIPT_MAX_CHARS} 字省略）…\n` + text.slice(-(TRANSCRIPT_MAX_CHARS - head));
  }
  return text;
}

export function compactPromptFor(transcript) {
  return [
    '你在为一个**正在进行中**的长任务写交接摘要：上下文快满了，下面这段较早的过程会被你的摘要替换，之后你只能看到摘要和最近几步。',
    '请用中文按以下小节输出（每节用「## 」开头），不超过 1500 字，只写事实，不要客套：',
    '## 用户要求：所有明确的要求、约束、偏好（尽量引用原话，不要遗漏任何一条）',
    '## 已完成：做了什么、产出了哪些文件（写完整路径）、跑过哪些关键命令及结果',
    '## 关键发现与决定：确认过的事实、选定的方案、踩过的坑和原因（避免之后重复踩）',
    '## 当前进度：最后正在做什么、做到哪一步',
    '## 下一步：接下来要做的具体动作',
    '',
    '--- 过程记录 ---',
    transcript,
  ].join('\n');
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`摘要超时（${Math.round(ms / 1000)}s）`)), ms); }),
  ]);
}

/**
 * 模型写摘要的全面压缩。原地修改 list（list[0] 是 system）。
 * @returns {Promise<{ok:boolean, mode?:'model'|'local', error?:string}>}
 */
export async function modelFullCompact(list, { summarize, keepRecent = KEEP_RECENT_MODEL_COMPACT, timeoutMs = SUMMARY_TIMEOUT_MS } = {}) {
  if (!Array.isArray(list) || list.length <= 1 + keepRecent) return { ok: false };
  let keepFrom = list.length - keepRecent;
  while (keepFrom > 1 && list[keepFrom]?.role === 'tool') keepFrom--;
  if (keepFrom <= 1) return { ok: false };
  const zone = list.slice(1, keepFrom);
  if (typeof summarize !== 'function') return { ok: fullCompact(list), mode: 'local' };
  let summary = '';
  let error = '';
  try {
    summary = String(await withTimeout(Promise.resolve().then(() => summarize(compactPromptFor(transcriptOf(zone)))), timeoutMs) || '').trim();
  } catch (e) {
    error = e?.message || String(e);
  }
  if (!summary) return { ok: fullCompact(list), mode: 'local', error: error || '摘要为空' };
  // 用户原话原样保留：这是最不能丢的东西（旧做法只留前 60 字）
  // 第二次及以后的压缩：上一份摘要里保留的用户原话要接着带上，否则第一次的需求会在第二次压缩时丢掉
  const userTexts = [];
  for (const m of zone) {
    if (isRealUserText(m)) { userTexts.push(textOf(m.content).trim()); continue; }
    const t = m?.role === 'user' ? textOf(m.content) : '';
    if (t.startsWith('[历史摘要]')) {
      const start = t.indexOf(USER_BLOCK_HEAD);
      if (start >= 0) {
        const end = t.indexOf(SUMMARY_HEAD, start);
        const carried = t.slice(start + USER_BLOCK_HEAD.length, end >= 0 ? end : undefined).trim();
        if (carried) userTexts.push(carried);
      }
    }
  }
  let userBlock = userTexts.join('\n---\n');
  if (userBlock.length > USER_TEXT_MAX_CHARS) userBlock = userTexts[0].slice(0, USER_TEXT_MAX_CHARS / 2) + '\n…\n' + userBlock.slice(-USER_TEXT_MAX_CHARS / 2);
  const content = [
    '[历史摘要] 上下文快满，较早的过程已压缩。以下是用户原话（原样）和你自己写的交接摘要；最近几步保持原样。需要旧文件内容就重新读取，已确认的结论不要重复验证。',
    userBlock ? `\n${USER_BLOCK_HEAD}\n${userBlock}` : '',
    `\n${SUMMARY_HEAD}\n${summary}`,
  ].join('\n');
  list.splice(1, keepFrom - 1, { role: 'user', content });
  return { ok: true, mode: 'model' };
}
