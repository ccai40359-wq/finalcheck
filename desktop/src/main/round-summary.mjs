// 每轮任务摘要 + 滚动合并（2026-11-17 规格 §3.3-3.4、§4 步 6-7）。
//
// **为什么要单独做这一层（规格 §1.3 的实测）**：
// 跨轮重建历史时，`message` 表里只有 user 和 assistant 的最终回答，工具结果
// （part 表里的 tool part）**根本不进历史**。所以模型第 2 轮完全不知道第 1 轮
// 读过哪些文件、碰过什么报错——它只剩一段最终结论。这不是"压缩太狠"，
// 而是**跨轮根本没有记忆层**。本模块就是补这一层。
//
// 设计要点：
//   · 摘要字段固定 6 段（对齐 CC 模板），其中「用户原话」要求逐字引用，
//     防意图漂移（这是 CC 的 All user messages 字段的作用）。
//   · 目标 1.5k token / 上限 5k（规格 §1.4 的实测中位数），不是固定 3k。
//   · 滚动合并：最近 10 轮原文 + 更早合并成 1 份「古老摘要」，
//     所以摘要库恒定在 18-20k，压 1 次和压 100 次一样大。
//   · 行号必须逐字抄自工具结果，不许估算（规格 §3.4 硬约束）。

/** 摘要字段模板（6 段，顺序固定，便于解析与滚动合并） */
export const SUMMARY_FIELDS = [
  '用户本轮想要什么',
  '关键技术概念 / 决策',
  '涉及的文件与改动',
  '报过的错与怎么修的',
  '待办 / 未完成项',
  '当前正在做什么'
];

const SUMMARY_PROMPT = [
	'你是对话历史的记录员。请为这一轮任务写一份摘要，供后续轮次使用。',
	'严格按下面 6 个字段输出，字段名原样保留，不要加别的段落：',
	'',
	'## 用户本轮想要什么',
	'（逐字引用用户的原话，不要改写、不要总结成更短的句子）',
	'',
	'## 关键技术概念 / 决策',
	'（这一轮做出的技术判断、选型、放弃的方案与原因）',
	'',
	'## 涉及的文件与改动',
	'（文件路径 + 行号 + 改了什么。行号必须逐字抄自工具结果，不许估算）',
	'',
	'## 报过的错与怎么修的',
	'（报错原文 + 怎么解决的）',
	'',
	'## 待办 / 未完成项',
	'（还没做完的、被跳过或失败的，写清原因）',
	'',
	'## 当前正在做什么',
	'（下一步要做什么）',
	'',
	'硬约束：',
	'- 按信息量决定长度，300-5000 token，不要注水，也不要为了短而丢掉路径与行号',
	'- 用户原话必须逐字保留（这是防意图漂移的唯一依据）',
	'- 没有内容的字段写「（无）」，不要删掉字段本身',
	'- 使用与对话相同的语言'
].join('\n');

const MERGE_PROMPT = [
	'下面有多轮任务摘要。请合并成一份「更早的对话摘要」，供后续轮次使用。',
	'要求：',
	'- 保留所有仍然有效的结论、文件路径、行号、决策与未完成项',
	'- 去掉已经被后续轮次推翻的内容（以更晚的为准）',
	'- 按信息量决定长度，3000-5000 token，不要注水',
	'- 使用与对话相同的语言'
].join('\n');

/** 最近 N 轮摘要原样保留，更早的滚动合并（规格 §3.3 第 2 步） */
export const KEEP_RECENT_ROUNDS = 10;

/** 摘要长度约束（token 估算口径：CJK 1 字 ≈ 1 token，其他 4 字符 ≈ 1 token） */
export const SUMMARY_MIN_TOKENS = 300;
export const SUMMARY_MAX_TOKENS = 5120;
export const SUMMARY_TARGET_TOKENS = 1500;

/** 粗略 token 估算（与主会话同一口径，避免两处漂移） */
export function estimateSummaryTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x2e80 && c <= 0x303f) || (c >= 0x3040 && c <= 0x30ff)
      || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)
      || (c >= 0xac00 && c <= 0xd7af)) cjk++;
  }
  return cjk + Math.ceil((s.length - cjk) / 4);
}

/**
 * 把摘要列表整理成「最近 KEEP_RECENT_ROUNDS 份原文 + 1 份古老合并摘要」。
 * 纯函数，不调模型——合并动作由调用方决定何时做、用哪份文本喂模型。
 * @param {Array<{id?:string, text:string, at?:number}>} summaries 按时间升序
 * @returns {{recent: Array, ancient: Array, needsMerge: boolean}}
 */
export function planRollup(summaries, { keepRecent = KEEP_RECENT_ROUNDS } = {}) {
  const list = Array.isArray(summaries) ? summaries.filter((s) => s && typeof s.text === 'string' && s.text.trim()) : [];
  const keep = Math.max(1, Number(keepRecent) || KEEP_RECENT_ROUNDS);
  // 已经有一份古老摘要时，它算在「头部」——不重复合并
  const ancientMarked = list.filter((s) => s.ancient === true);
  const normal = list.filter((s) => s.ancient !== true);
  const recent = normal.slice(-keep);
  const toMerge = normal.slice(0, Math.max(0, normal.length - keep));
  return {
    recent,
    ancient: ancientMarked.length ? [ancientMarked[ancientMarked.length - 1]] : [],
    // 需要合并：有超过 keep 的部分，或已经有古老摘要但又有新的溢出
    needsMerge: toMerge.length > 0,
    toMerge
  };
}

/**
 * 生成一份「古老摘要」的输入文本（把待合并的摘要拼起来，供一次 LLM 调用）。
 * 超过 charBudget 时按顺序截断（保留更近的，因为更近的结论更可能仍然有效）。
 */
export function buildMergeInput(toMerge, charBudget = 30000) {
  const list = (Array.isArray(toMerge) ? toMerge : []).filter((s) => s && typeof s.text === 'string');
  if (!list.length) return '';
  const pieces = list.map((s, i) => `### 第 ${i + 1} 份\n${s.text}`);
  const joined = pieces.join('\n\n');
  if (joined.length <= charBudget) return joined;
  // 超预算：从近往远取（更近的更有效），再按原顺序拼回去
  const kept = [];
  let used = 0;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const len = pieces[i].length;
    if (used + len > charBudget && kept.length) break;
    kept.unshift(pieces[i]);
    used += len;
  }
  return kept.join('\n\n');
}

/** 校验一份摘要是否落在 300-5120 token（规格 §5.1 数值验收）。返回 {ok, tokens, reason} */
export function checkSummaryLength(text) {
  const tokens = estimateSummaryTokens(text);
  if (tokens < SUMMARY_MIN_TOKENS) return { ok: true, tokens, note: '偏短（内容少时可接受）' };
  if (tokens > SUMMARY_MAX_TOKENS) return { ok: false, tokens, reason: `摘要超上限（${tokens} > ${SUMMARY_MAX_TOKENS} token）` };
  return { ok: true, tokens };
}

/**
 * 超上限时的截断：**保头保尾，优先砍中间段**。
 *
 * 为什么不能 `slice(0, N)`（2026-11-17 缺陷）：6 段模板里「当前正在做什么 / 待办」
 * 在**末尾**，`slice(0, ...)` 每次都先砍掉它——而这个会话下一轮最需要的恰好就是它。
 * 旧实现还能把「用户本轮想要什么」留下来，等于把「下一步」换成「更早的背景」，方向反了。
 *
 * 规则：
 *   · 能按 `## ` 分段时：第 1 段（用户原话）与最后一段（下一步）**全额保留**，
 *     中间各段按可用预算均分截断，每段带 `…（本节过长已截断）` 标记。
 *   · 分不出段时：保头 60% + 保尾 40%。
 *   · 预算按当前文本的「字符/token」实测比例反推，不用固定系数（CJK 与英文差 4 倍）。
 * @returns {string}
 */
export function truncateSummaryText(text, { maxTokens = SUMMARY_MAX_TOKENS } = {}) {
	const s = String(text ?? '');
	if (!s) return s;
	const tokens = estimateSummaryTokens(s);
	if (tokens <= maxTokens) return s;
	// 字符预算：留 5% 给截断标记，避免加了标记又超限
	const charsPerToken = s.length / Math.max(1, tokens);
	const budget = Math.max(400, Math.floor(maxTokens * charsPerToken * 0.95));

	const heads = [...s.matchAll(/^##\s+/gm)].map((m) => m.index);
	if (heads.length >= 3) {
		const sections = [];
		for (let k = 0; k < heads.length; k++) {
			const start = heads[k];
			const end = k + 1 < heads.length ? heads[k + 1] : s.length;
			sections.push(s.slice(start, end).replace(/\s+$/, ''));
		}
		// 首段与末段全额保留；中间段均分剩余预算
		const firstSec = sections[0];
		const lastSec = sections[sections.length - 1];
		const middleSec = sections.slice(1, -1);
		const reserved = firstSec.length + lastSec.length;
		const remaining = Math.max(0, budget - reserved);
		const perMiddle = middleSec.length ? Math.floor(remaining / middleSec.length) : 0;
		const out = [firstSec];
		for (const sec of middleSec) {
			if (sec.length <= perMiddle) { out.push(sec); continue; }
			if (perMiddle < 40) { out.push(sec.slice(0, 20) + '…（本节过长已截断）'); continue; }
			out.push(sec.slice(0, perMiddle - 20) + '\n…（本节过长已截断）');
		}
		out.push(lastSec);
		return out.join('\n\n');
	}
	// 无段结构：保头保尾
	const headLen = Math.floor(budget * 0.6);
	const tailLen = Math.floor(budget * 0.4) - 30;
	if (s.length <= headLen + tailLen) return s;
	return s.slice(0, headLen) + '\n…（中间已截断）\n' + s.slice(-Math.max(120, tailLen));
}

/** 导出提示词，供调用方（IPC 层）直接喂给 summarizeWithProvider 之外的路径 */
export function summaryPromptFor(userMessage, toolDigest = '') {
  const parts = [SUMMARY_PROMPT];
  if (userMessage) parts.push('', '--- 用户本轮原话（必须逐字引用）---', String(userMessage).slice(0, 4000));
  if (toolDigest) parts.push('', '--- 本轮工具调用与结果摘要（行号从这里抄，不许估算）---', String(toolDigest).slice(0, 20000));
  return parts.join('\n');
}

export function mergePromptFor() {
  return MERGE_PROMPT;
}
