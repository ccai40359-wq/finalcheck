// 实时提问卡（App.askCards）与历史 ask_user trace 的互斥渲染：同一个 callId 只允许一张卡。
// 之前踩过的 bug：切回运行中的会话时，TraceCards 从磁盘 trace 还原一张已答卡，
// 实时 askCards 又渲染一张，两张卡同时出现。
//
// 策略（明确二选一）：
// - 历史 trace 里的 ask_user 已是终态（answered/cancelled/expired/rejected）→ 历史卡优先，
//   filterAskCardsByTrace 把同一 callId 的实时卡藏掉；
// - trace 仍是 running/pending/无状态 → 实时卡优先，hideAskTracesForCards 把同一 callId 的
//   历史 trace 藏掉（运行中的提问必须保持可回答，不能退化成只读的「已失效」卡）。
// 两个函数配合使用，任何 callId 最终只渲染一张卡（App 不会只按 callId 在 askCards 内部去重）。

export const ASK_USER_TOOL = 'ask_user';

const toolNameOf = (entry) => String(entry?.tool ?? entry?.name ?? '');
const statusOf = (entry) => String(entry?.status ?? '').trim().toLowerCase();

export function isAskUserTrace(entry) {
  return toolNameOf(entry) === ASK_USER_TOOL;
}

/** trace 里的 ask_user 是否已经收尾（终态）；running/pending/答案未落盘 → false */
export function isSettledAskTrace(entry) {
  if (!isAskUserTrace(entry)) return false;
  const status = statusOf(entry);
  if (status === 'running' || status === 'pending' || status === 'waiting') return false;
  if (!status) {
    // 旧会话/旧版本可能没有 status：用结果/错误兜底判断是否已回答/已失败
    return entry?.result != null || entry?.error != null || entry?.cancelled === true;
  }
  return true;
}

function settledCallIds(messages) {
  const ids = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    const trace = Array.isArray(m?.trace) ? m.trace : [];
    for (const t of trace) {
      if (!isSettledAskTrace(t) || t?.callId == null) continue;
      ids.add(String(t.callId));
    }
  }
  return ids;
}

/**
 * 渲染实时 askCards 前过滤：callId 已在 messages trace 里以终态出现 → 保留历史卡，藏实时卡。
 * 同 callId 只留 1 张；不同 callId 全保留。
 * @param {Array<{callId?:string}>} cards
 * @param {Array<{trace?:Array}>} messages
 */
export function filterAskCardsByTrace(cards, messages) {
  const list = Array.isArray(cards) ? cards : [];
  const settled = settledCallIds(messages);
  if (!settled.size) return list;
  return list.filter((c) => !(c?.callId != null && settled.has(String(c.callId))));
}

/**
 * 反向过滤：canonical 的实时卡还在（未终态）→ 把它对应的历史 trace 条目从消息里摘掉，
 * 避免 TraceCards 再还原一张只读卡。返回原数组（无变化时保持引用稳定）。
 * @param {Array<{trace?:Array}>} messages
 * @param {Array<{callId?:string}>} cards 已通过 filterAskCardsByTrace 的实时卡
 */
export function hideAskTracesForCards(messages, cards) {
  const liveIds = new Set((Array.isArray(cards) ? cards : [])
    .map((c) => c?.callId)
    .filter((id) => id != null && id !== '')
    .map(String));
  if (!liveIds.size) return messages;
  let changed = false;
  const next = (Array.isArray(messages) ? messages : []).map((m) => {
    const trace = Array.isArray(m?.trace) ? m.trace : null;
    if (!trace?.length) return m;
    const kept = trace.filter((t) => !(isAskUserTrace(t) && t.callId != null && liveIds.has(String(t.callId))));
    if (kept.length === trace.length) return m;
    changed = true;
    return { ...m, trace: kept };
  });
  return changed ? next : messages;
}
