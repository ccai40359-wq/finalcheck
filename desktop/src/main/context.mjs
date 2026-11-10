// 上下文预算压缩（对齐 deepseek-harness 设计①）：
// 模型可见历史在"发给模型的时刻"派生——压缩只改本次请求的视图，不改存储的历史（审计可回放）。
// replace 语义：被压缩区由一条 [历史摘要] 消息顶替，仅影响发给模型的内容。
const KEEP_RECENT = 4; // 最近 N 条永远原文保留
const TOOL_INLINE_LIMIT = 1500; // 保留区 tool 消息超过此长度才截
const TOOL_KEEP_CHARS = 1200; // 截后保留头部字符数

const charLen = (m) => String(m?.content ?? '').length;

// 抽取式摘要（LLM 总结不可用/失败时的兜底）：每轮 user 问题前 60 字 + 工具调用名列表
function extractiveSummary(zone) {
  const lines = [];
  for (const m of zone) {
    const text = String(m?.content ?? '');
    if (m?.role === 'user') {
      lines.push('- 用户：' + text.slice(0, 60));
    } else if (m?.role === 'assistant') {
      const names = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((tc) => tc?.function?.name).filter(Boolean);
      if (names.length) lines.push('- 助手调用工具：' + names.join(', '));
      else if (Array.isArray(m.trace) && m.trace.length) lines.push('- 助手调用工具：' + m.trace.map((t) => t?.tool).filter(Boolean).join(', '));
      else if (text) lines.push('- 助手：' + text.slice(0, 60));
    } else if (m?.role === 'tool') {
      // 工具结果不进摘要（调用名已在 assistant 行列出），跳过正文
    } else if (text) {
      lines.push(`- ${m?.role ?? 'unknown'}：` + text.slice(0, 60));
    }
  }
  return lines.join('\n') || '（较早对话无可用摘要）';
}

// 保留区 tool 消息超长截断（不改原对象，替换语义）
function truncateTool(m) {
  const text = String(m?.content ?? '');
  if (m?.role !== 'tool' || text.length <= TOOL_INLINE_LIMIT) return m;
  return { ...m, content: text.slice(0, TOOL_KEEP_CHARS) + `…[截断 ${text.length - TOOL_KEEP_CHARS} 字符]` };
}

export async function assembleContext(messages, { budgetTokens, budgetChars = 80000, summarize } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  // 传了正数 budgetTokens 就按 token 估（长上下文模型），否则沿用旧的 80k 字符口径
  const tokenBudget = Number(budgetTokens);
  const useTokens = Number.isFinite(tokenBudget) && tokenBudget > 0;
  const limit = useTokens ? tokenBudget : budgetChars;
  const total = useTokens
    ? estimateMessagesTokens(list)
    : list.reduce((n, m) => n + charLen(m), 0);
  if (total <= limit) return { messages: list, compacted: false };

  // 从尾部往回累积；最近 KEEP_RECENT 条无条件保留，更早的进"被压缩区"
  const costOf = useTokens ? (m) => estimateMessagesTokens([m]) : charLen;
  let keptChars = 0;
  let keepFrom = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    const c = costOf(list[i]);
    if (i < list.length - KEEP_RECENT && keptChars + c > limit) break;
    keptChars += c;
    keepFrom = i;
  }
  const zone = list.slice(0, keepFrom);
  const kept = list.slice(keepFrom);

  let summaryText = null;
  if (zone.length) {
    const raw = zone.map((m) => `[${m?.role ?? 'unknown'}] ${String(m?.content ?? '')}`).join('\n');
    if (typeof summarize === 'function') {
      try { summaryText = await summarize(raw); } catch { /* 总结失败静默回退抽取式 */ }
    }
    if (typeof summaryText !== 'string' || !summaryText.trim()) summaryText = extractiveSummary(zone);
  }

  const view = summaryText != null
    ? [{ role: 'user', content: '[历史摘要]\n' + summaryText }, ...kept.map(truncateTool)]
    : kept.map(truncateTool); // 压缩区为空（如仅末尾几条就超预算）也要做保留区截断
  return { messages: view, compacted: true };
}

// ---------------------------------------------------------------------------
// token 口径估算 + 两级压缩（Wave 2）
// 旧的 budgetChars / CONVO_BUDGET 是"字符"口径，混排中英文时严重低估上下文；
// 这里统一按 token 估算：CJK 字符 1 个≈1 token，其余 4 字符≈1 token。
// 这里只提供纯函数原语，何时触发由调用方（agent-service 的工具循环）决定。
// ---------------------------------------------------------------------------

// CJK 及全角标点/假名/谚文：1 字符≈1 token（按 tokenizer 常见切分近似）。
// 用 charCodeAt 逐字符判断而不是正则 match，避免大历史下分配百万级匹配数组。
const isCjkCode = (c) =>
  (c >= 0x2e80 && c <= 0x303f) || // CJK 部首/符号/全角标点
  (c >= 0x3040 && c <= 0x30ff) || // 平假名/片假名
  (c >= 0x3400 && c <= 0x4dbf) || // CJK 扩展 A
  (c >= 0x4e00 && c <= 0x9fff) || // CJK 基本区
  (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容
  (c >= 0xff00 && c <= 0xffef) || // 全角 ASCII / 半角片假名
  (c >= 0xac00 && c <= 0xd7af);   // 谚文

export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i++) if (isCjkCode(s.charCodeAt(i))) cjk++;
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

// content 可能是字符串、多段 parts（图片/文本）或空
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (typeof p?.text === 'string' ? p.text : JSON.stringify(p)))).join('\n');
  }
  return content == null ? '' : String(content);
}

// 单条消息的 token：正文 + tool_calls 的 JSON 长度（工具参数也会占上下文）
export function estimateMessagesTokens(list) {
  return (Array.isArray(list) ? list : []).reduce((n, m) => {
    const calls = Array.isArray(m?.tool_calls) ? JSON.stringify(m.tool_calls) : '';
    return n + estimateTokens(contentText(m?.content)) + estimateTokens(calls);
  }, 0);
}

// 预算公式（与 Wave 2 规格一致）：
//   effective     = contextWindow - min(maxOutputTokens, 21000)
//   fullThreshold = effective - 13000
//   microThreshold= min(0.9 * effective, effective - 2000)
export function contextBudget(config = {}) {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const contextWindow = num(config?.contextWindow, 200000);
  const maxOutputTokens = num(config?.maxOutputTokens, 32000);
  const effective = contextWindow - Math.min(maxOutputTokens, 21000);
  return {
    contextWindow,
    maxOutputTokens,
    effective,
    fullThreshold: effective - 13000,
    microThreshold: Math.min(0.9 * effective, effective - 2000)
  };
}

const CLEANED_TOOL_PREFIX = '[旧工具结果已清理：';

// microcompact：最近 5 条 tool 结果保留原文，更早的正文换成固定占位说明。
// 只改 tool 消息的 content，保留 tool_call_id（不破坏 assistant tool_calls ↔ tool 配对）。
export function microcompact(list, { keepRecentTool = 5 } = {}) {
  if (!Array.isArray(list)) return false;
  const toolIdx = [];
  list.forEach((m, i) => { if (m?.role === 'tool') toolIdx.push(i); });
  const keep = new Set(toolIdx.slice(-Math.max(0, keepRecentTool)));
  if (toolIdx.length <= keep.size) return false;
  // tool_call_id → 工具名（清理提示里点名，模型才知道被清掉的是什么结果）
  const names = new Map();
  for (const m of list) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) names.set(tc.id, tc?.function?.name || '工具');
    }
  }
  let changed = false;
  for (const i of toolIdx) {
    if (keep.has(i)) continue;
    const old = contentText(list[i]?.content);
    if (old.startsWith(CLEANED_TOOL_PREFIX)) continue; // 已清理过，避免重复改写
    const name = names.get(list[i]?.tool_call_id) || '工具';
    list[i] = { ...list[i], content: `${CLEANED_TOOL_PREFIX}${name}；需要时用更小参数重跑或读 spill 文件]` };
    changed = true;
  }
  return changed;
}

// full compact 的本地抽取式摘要：用户问题前 60 字 + 助手调用的工具名列表 + 结论前 80 字。
// 纯本地，不额外调用模型（避免压缩本身又烧一次上下文）。
function summarizeZone(zone) {
  const lines = [];
  for (const m of zone) {
    if (m?.role === 'user') {
      const t = contentText(m.content).replace(/\s+/g, ' ').trim();
      if (t) lines.push('- 用户：' + t.slice(0, 60));
    } else if (m?.role === 'assistant') {
      const names = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((tc) => tc?.function?.name).filter(Boolean);
      if (names.length) lines.push('- 助手调用工具：' + names.join(', '));
      const t = contentText(m.content).replace(/\s+/g, ' ').trim();
      if (t) lines.push('- 结论：' + t.slice(0, 80));
    }
  }
  return lines.join('\n') || '（较早对话无可用摘要）';
}

// full compact：把最老的 user/assistant 正文区压成一条 [历史摘要]（tool 消息随区删除，配对不留孤儿）。
// 保留最近 6 条消息；若保留区第一条是 tool，则连同它的 assistant tool_calls 一起回退保留，
// 否则 API 会因孤立 tool 消息返回 400。
export function fullCompact(list) {
  if (!Array.isArray(list)) return false;
  const KEEP_RECENT_FULL = 6;
  if (list.length <= 1 + KEEP_RECENT_FULL) return false; // 除 system 外不足 6 条，没东西可压
  let keepFrom = list.length - KEEP_RECENT_FULL;
  while (keepFrom > 1 && list[keepFrom]?.role === 'tool') keepFrom--;
  if (keepFrom <= 1) return false;
  const zone = list.slice(1, keepFrom);
  if (!zone.length) return false;
  const summary = summarizeZone(zone);
  list.splice(1, keepFrom - 1, { role: 'user', content: '[历史摘要]\n' + summary });
  return true;
}
