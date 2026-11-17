// 每轮摘要的接线辅助（2026-11-17 规格 §4 步 6）。
//
// 职责：回合结束后
//   ① 把本轮工具调用压成一段「可抄行号」的文本（供 LLM 写摘要用）
//   ② 调 LLM 生成 6 段摘要
//   ③ 追加到 roundSummaries[]，并按 KEEP_RECENT_ROUNDS 滚动合并
//
// 为什么工具摘要要单独拼：规格 §3.4 要求「行号必须逐字抄自工具结果，不许估算」。
// 所以不能让 LLM 凭记忆写文件行号，得把真实的 path/command/结果摘要摆给它看。
import { SUMMARY_FIELDS, SUMMARY_MAX_TOKENS, KEEP_RECENT_ROUNDS, planRollup, summaryPromptFor, mergePromptFor, checkSummaryLength, buildMergeInput, truncateSummaryText } from './round-summary.mjs';

/** 把一轮的 trace 压成「工具调用清单」（含路径与关键结果，供摘要抄行号）。 */
export function toolDigestOf(trace, { maxChars = 20000 } = {}) {
  const list = Array.isArray(trace) ? trace : [];
  const lines = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const name = String(t.tool || t.name || '');
    const args = t.args && typeof t.args === 'object' ? t.args : {};
    const path = String(args.path || args.dir || args.target || args.command || args.pattern || '');
    const status = t.status || (t.error ? 'fail' : 'ok');
    const line = `- ${name}${path ? ' ' + path.slice(0, 120) : ''} [${status}]`;
    if (t.error) lines.push(line + ' 报错：' + String(t.error).slice(0, 200));
    else lines.push(line);
  }
  const joined = lines.join('\n');
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

/**
 * 生成并保存本轮摘要（含滚动合并）。
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.userMessage 用户本轮原话（摘要里要逐字引用）
 * @param {Array} opts.trace 本轮工具调用记录
 * @param {string} opts.answer 本轮最终回答
 * @param {function} opts.summarize (prompt: string) => Promise<string>
 * @param {object} opts.sessions 会话存储（需有 loadRoundSummaries / saveRoundSummaries）
 * @returns {Promise<{ok:boolean, count?:number, merged?:boolean, error?:string}>}
 */
export async function writeRoundSummary({ sessionId, userMessage, trace, answer, summarize, sessions }) {
  if (!sessionId || typeof summarize !== 'function') return { ok: false, error: '缺少 sessionId 或 summarize' };
  if (!sessions || typeof sessions.loadRoundSummaries !== 'function') return { ok: false, error: '会话存储缺少 summary 接口' };

	let prev = [];
	try { prev = await sessions.loadRoundSummaries(sessionId); } catch { prev = []; }

	// ① 拼提示词：6 段模板 + 用户原话 + 工具清单
	const digest = toolDigestOf(trace);
	const prompt = summaryPromptFor(userMessage, digest);
	// 回答也给它（结论是从回答里提炼的）
	const withAnswer = answer ? prompt + '\n\n--- 本轮最终回答 ---\n' + String(answer).slice(0, 8000) : prompt;

	let text = '';
	try {
		text = String(await summarize(withAnswer) || '').trim();
	} catch (e) {
		return { ok: false, error: '摘要生成失败：' + (e?.message || String(e)) };
	}
	if (!text) return { ok: false, error: '摘要为空' };
	// 超上限时截断：保头保尾（2026-11-17 修复：旧实现 slice(0, ...) 每次都先砍掉
	// 末尾的「待办 / 当前正在做什么」，而下一轮最需要的恰好是它）
	const len = checkSummaryLength(text);
	if (!len.ok) text = truncateSummaryText(text, { maxTokens: SUMMARY_MAX_TOKENS });

	const entry = { id: 'r' + Date.now(), text, at: Date.now() };
	const next = [...prev, entry];
	const plan = planRollup(next, { keepRecent: KEEP_RECENT_ROUNDS });

	// ② 需要合并时：把「已有古老摘要 + 溢出的轮摘要」合成一份新的「古老摘要」
	let merged = false;
	let finalList = next;
	if (plan.needsMerge) {
		try {
			// 2026-11-17 P0 修复：旧实现只喂 plan.toMerge，**把已有的古老摘要整份丢掉**——
			// 第 11 轮合并出 ancient#1（覆盖 1-1 轮），第 21 轮合并时 ancient#1 不在输入里，
			// 新 ancient#2 只覆盖 2-11 轮，第 1 轮的历史就**永久消失**（20 轮模拟已复现）。
			// 现在把 ancient 作为「第 0 份」放在最前面一起喂给合并模型，并显式要求它保留。
			const ancientPrev = plan.ancient[plan.ancient.length - 1] || null;
			const mergeItems = [
				...(ancientPrev ? [ancientPrev] : []),
				...plan.toMerge
			];
			const mergeInput = buildMergeInput(mergeItems, 30000);
			const mergedText = String(await summarize(mergePromptFor() + '\n\n' + mergeInput) || '').trim();
			if (mergedText) {
				// coversUntil = 这份古老摘要「最晚覆盖到哪一轮结束」。createdAt（at）只是写入时间，
				// 不能用来判断覆盖范围——注入侧要靠 coversUntil 精确剔除已被会话级摘要覆盖的部分
				// （2026-11-17 P1：手动 /compact 摘要 + 轮摘要双重注入，同一段历史进两次）。
				const coversUntil = Math.max(
					Number(ancientPrev?.coversUntil) || 0,
					...mergeItems.map((s) => Number(s?.at) || 0)
				);
				finalList = [
					{ id: 'ancient', text: mergedText, at: Date.now(), ancient: true, coversUntil },
					...plan.recent
				];
				merged = true;
			}
		} catch { /* 合并失败：保留不合并的列表，下次再试（不会丢摘要） */ }
	}

	try {
		await sessions.saveRoundSummaries(sessionId, finalList);
	} catch (e) {
		return { ok: false, error: '摘要落盘失败：' + (e?.message || String(e)) };
	}
	return { ok: true, count: finalList.length, merged };
}

/** 把摘要库渲染成一段可注入上下文的文本（最近 10 份 + 古老摘要）。 */
export function renderRoundSummaries(list) {
	const arr = Array.isArray(list) ? list : [];
	if (!arr.length) return '';
	const ancient = arr.filter((x) => x && x.ancient);
	const recent = arr.filter((x) => x && !x.ancient);
	const parts = ['【历史轮次摘要】'];
	if (ancient.length) parts.push('## 更早的对话（已合并）', String(ancient[ancient.length - 1].text || ''));
	if (recent.length) {
		parts.push(`## 最近 ${recent.length} 轮`);
		for (const s of recent) parts.push(String(s.text || ''));
	}
	return parts.join('\n\n');
}

/**
 * 剔除「已经被会话级摘要（手动 /compact）覆盖」的轮摘要（2026-11-17 缺陷 P1）。
 *
 * 双重注入的实际后果：同一段历史既在 `[此前对话摘要]` 里、又在轮摘要里进一次，
 * 上下文被无谓撑大一倍 → 更早触发下一轮压缩 → 越快越丢东西。
 *
 * **只丢「整份都落在摘要覆盖范围之内」的条目**，宁可重复也不丢内容：
 *   · 普通轮摘要：`at`（该轮结束时间）<= summaryAt → 已被覆盖 → 丢
 *   · 古老摘要：看它自己声明的 `coversUntil`；只有「覆盖到的时间点也 <= summaryAt」才丢。
 *     没有 coversUntil 的老数据回落用 `at`（写入时间），此时它通常 > summaryAt → 保留（只会重复，不会丢）。
 * @param {Array} list 轮摘要列表
 * @param {number} summaryAt 会话级摘要的切分时间戳（sessions.loadSession 的 s.summaryAt）
 */
export function dropRoundSummariesCoveredBy(list, summaryAt) {
	const arr = Array.isArray(list) ? list : [];
	const cut = Number(summaryAt) || 0;
	if (!(cut > 0)) return arr;
	const kept = arr.filter((s) => {
		if (!s) return false;
		const at = Number(s.at) || 0;
		const until = s.ancient ? (Number(s.coversUntil) || at) : at;
		return until > cut;
	});
	return kept;
}

export { SUMMARY_FIELDS, KEEP_RECENT_ROUNDS };
