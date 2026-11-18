// /compact 之后，下一轮该发哪些历史消息给模型。
//
// 2026-11-17 修复：前端发来的历史只有 role/content（App.jsx 的 wireHistory），没有 at 时间戳。
// 旧实现按 `m.at >= summaryAt` 过滤，拿不到 at 的消息一律保留 →「摘要 + 全部原文」一起发，
// /compact 显示成功但下一轮反而更长。这里改成：用库里带时间戳的消息找出摘要覆盖的最后一条，
// 再按 role+原文在前端历史里定位它，只保留它之后的消息。

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
const isChat = (m) => m && (m.role === 'user' || m.role === 'assistant');
const same = (a, b) => a.role === b.role && norm(a.content) === norm(b.content);

/**
 * @param {Array<{role:string, content:any, at?:number}>} contextMessages 前端发来的历史（最后一条是本轮用户消息）
 * @param {Array<{role:string, content:any, at?:number}>} dbMessages sessions.loadSession 的 messages（带 at）
 * @param {number} cutAt 会话摘要的切分点（s.summaryAt）
 * @returns {{kept:Array, matched:boolean}} matched=false 表示没对上：保留全部（只会重复，不会丢）
 */
export function keepAfterCompactCut(contextMessages, dbMessages, cutAt) {
  const list = Array.isArray(contextMessages) ? contextMessages : [];
  const cut = Number(cutAt) || 0;
  if (!(cut > 0)) return { kept: list.slice(-6), matched: true };
  // 历史自带时间戳（测试/将来前端补上）：直接按时间切
  if (list.some((m) => Number.isFinite(Number(m?.at)) && m?.at != null)) {
    return {
      kept: list.filter((m) => { const at = Number(m?.at); return m?.at == null || !Number.isFinite(at) || at >= cut; }),
      matched: true
    };
  }
  const covered = (Array.isArray(dbMessages) ? dbMessages : [])
    .filter((m) => isChat(m) && Number.isFinite(Number(m.at)) && Number(m.at) < cut);
  if (!covered.length) return { kept: list, matched: true };

  // 只在 user/assistant 消息上对齐；最后一条（本轮用户消息）永远保留
  const idx = [];
  for (let i = 0; i < list.length - 1; i++) if (isChat(list[i])) idx.push(i);
  const tail = covered.slice(-4); // 末尾几条连续对上才算命中，避免内容重复的短句（「继续」）误配
  for (let j = idx.length - 1; j >= tail.length - 1; j--) {
    let ok = true;
    for (let k = 0; k < tail.length; k++) {
      if (!same(list[idx[j - k]], tail[tail.length - 1 - k])) { ok = false; break; }
    }
    // 前面注入的 system 消息（项目档案、任务包等）不属于对话历史，原样保留
    if (ok) return { kept: [...list.slice(0, idx[j] + 1).filter((m) => !isChat(m)), ...list.slice(idx[j] + 1)], matched: true };
  }
  return { kept: list, matched: false };
}
