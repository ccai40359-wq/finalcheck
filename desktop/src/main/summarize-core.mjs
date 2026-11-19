// 摘要请求的纯逻辑（2026-11-17，fix/zcode-codex-review）。
//
// 从 ipc/config-store.mjs 的 summarizeWithProvider 里拆出来，原因是旧实现有三个
// 只能在真实长会话里暴露的问题，必须能单测：
//
//   ① **超时是整段共用的 30 秒**。长文本切成 N 块串行请求 + 1 次合并，全部挤在同一个
//      30 秒里 —— 手动压缩一个长会话几乎必然「This operation was aborted」。
//      现在每个请求单独计时（requestTimeoutMs），调用方的取消信号仍然对所有请求生效。
//
//   ② **合并输入被 slice(0, maxChars) 截断**。分块摘要拼起来超过上限时，后半部分
//      分块摘要直接丢掉 —— 违反「压缩不许截头/尾」。现在按 maxChars 分组逐层合并，
//      直到只剩一份，任何一份分块摘要都会进合并输入。
//
//   ③ **轮摘要的提示词被二次包裹**。调用方已经写好完整指令（6 段模板），这里又在前面
//      加一句「请把以下对话历史压缩成要点摘要」，模型会把指令当成要压缩的内容。
//      现在 raw=true 时原样发送、不切块。

export const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

/** 读完一次 chat/completions 响应的正文（流式 SSE 或普通 JSON 都行）。 */
export async function readChatText(res) {
  const raw = await res.text();
  if (!/^\s*data:/m.test(raw)) {
    try { const j = JSON.parse(raw); return String(j?.choices?.[0]?.message?.content ?? ''); } catch { return ''; }
  }
  let out = '';
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const d = l.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      const c = j?.choices?.[0]?.delta?.content ?? j?.choices?.[0]?.message?.content;
      if (typeof c === 'string') out += c;
    } catch { /* 心跳 / 非 JSON 行 */ }
  }
  return out;
}

const MAX_MERGE_LEVELS = 6; // 每层把分组数缩小到 1/k，6 层足以覆盖任何实际长度

const CHUNK_PROMPT = '请把以下对话历史压缩成要点摘要，使用与对话相同的语言，保留关键结论、路径与数字，直接输出摘要本身：\n\n';
const MERGE_PROMPT = '下面是把同一段对话历史分块压缩后得到的多份摘要（按时间先后排列）。请合并成一份完整摘要，使用与对话相同的语言，保留关键结论、文件路径与数字，去掉重复；更晚的内容推翻更早的内容时以更晚的为准。直接输出摘要本身：\n\n';

/** 按字符上限切块；尽量在换行处断开，避免把一行（比如一条消息）劈成两半。 */
export function splitForSummary(text, maxChars) {
  const s = String(text ?? '');
  const limit = Math.max(1000, Number(maxChars) || 30000);
  if (s.length <= limit) return [s];
  const out = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + limit);
    if (end < s.length) {
      const nl = s.lastIndexOf('\n', end);
      if (nl > i + limit * 0.5) end = nl + 1;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

/** 把若干份摘要按字符上限分组（每组至少 1 份，单份超长也独占一组，不截断）。 */
export function groupForMerge(parts, maxChars) {
  const limit = Math.max(1000, Number(maxChars) || 30000);
  const groups = [];
  let cur = [];
  let used = 0;
  for (const p of parts) {
    const len = String(p).length + 7;
    if (cur.length && used + len > limit) { groups.push(cur); cur = []; used = 0; }
    cur.push(p);
    used += len;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * 分块摘要 + 逐层合并。
 * @param {object} o
 * @param {string} o.text
 * @param {(prompt:string, meta:{kind:'raw'|'chunk'|'merge'}) => Promise<string>} o.ask 发一次请求
 * @param {number} [o.maxChars=30000]
 * @param {boolean} [o.raw=false] true：text 本身就是完整提示词，原样发一次
 */
export async function summarizeChunked({ text, ask, maxChars = 30000, raw = false }) {
  const full = String(text ?? '');
  if (raw) return ask(full, { kind: 'raw' });
  const chunks = splitForSummary(full, maxChars);
  if (chunks.length === 1) return ask(CHUNK_PROMPT + chunks[0], { kind: 'chunk' });
  let parts = [];
  for (const c of chunks) parts.push(await ask(CHUNK_PROMPT + c, { kind: 'chunk' }));
  for (let level = 0; level < MAX_MERGE_LEVELS; level++) {
    const groups = groupForMerge(parts, maxChars);
    const merged = [];
    for (const g of groups) {
      merged.push(g.length === 1 && groups.length > 1 ? g[0] : await ask(MERGE_PROMPT + g.join('\n\n---\n\n'), { kind: 'merge' }));
    }
    parts = merged;
    if (parts.length === 1) return parts[0];
    // 合并没有让分组变少（每份摘要都超过上限）：最后整体合并一次，宁可超长也不截断
    if (groups.length === merged.length && groups.every((g) => g.length === 1)) break;
  }
  return ask(MERGE_PROMPT + parts.join('\n\n---\n\n'), { kind: 'merge' });
}

/**
 * 为单个请求建一个「自带超时 + 跟随外部取消」的 AbortSignal。
 * @returns {{signal: AbortSignal, done: () => void, timedOut: () => boolean}}
 */
export function requestSignal(outer, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const ctl = new AbortController();
  let timed = false;
  const timer = setTimeout(() => { timed = true; ctl.abort(); }, Math.max(1000, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS));
  const onAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    timedOut: () => timed,
    done: () => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    }
  };
}
