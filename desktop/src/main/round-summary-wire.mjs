// 每轮摘要的接线辅助（2026-11-17 规格 §4 步 6）。
//
// 职责：回合结束后
//   ① 把本轮工具调用压成一段「可抄行号」的文本（供 LLM 写摘要用）
//   ② 调 LLM 生成 6 段摘要
//   ③ 追加到 roundSummaries[]，并按 KEEP_RECENT_ROUNDS 滚动合并
//
// 为什么工具摘要要单独拼：规格 §3.4 要求「行号必须逐字抄自工具结果，不许估算」。
// 所以不能让 LLM 凭记忆写文件行号，得把真实的 path/command/结果摘要摆给它看。
import { SUMMARY_FIELDS, KEEP_RECENT_ROUNDS, planRollup, summaryPromptFor, mergePromptFor, checkSummaryLength } from './round-summary.mjs';

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
	// 超上限时截断（保留头部，头部是「用户想要什么」等最关键字段）
	const len = checkSummaryLength(text);
	if (!len.ok) {
		const budgetChars = Math.floor(text.length * (5120 / len.tokens));
		text = text.slice(0, Math.max(200, budgetChars)) + '\n…（摘要过长已截断）';
	}

	const entry = { id: 'r' + Date.now(), text, at: Date.now() };
	const next = [...prev, entry];
	const plan = planRollup(next, { keepRecent: KEEP_RECENT_ROUNDS });

	// ② 需要合并时：把溢出的部分合成一份「古老摘要」
	let merged = false;
	let finalList = next;
	if (plan.needsMerge) {
		try {
			const mergeInput = plan.toMerge.map((s, i) => `### 第 ${i + 1} 份\n${s.text}`).join('\n\n');
			const mergedText = String(await summarize(mergePromptFor() + '\n\n' + mergeInput.slice(0, 30000)) || '').trim();
			if (mergedText) {
				finalList = [
					{ id: 'ancient', text: mergedText, at: Date.now(), ancient: true },
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

export { SUMMARY_FIELDS, KEEP_RECENT_ROUNDS };
