// 每轮摘要的接线辅助（2026-11-17 规格 §4 步 6）。
//
// 职责：回合结束后
//   ① 把本轮工具调用压成一段「可抄行号」的文本（供 LLM 写摘要用）
//   ② 调 LLM 生成 6 段摘要
//   ③ 追加到 roundSummaries[]，并按 KEEP_RECENT_ROUNDS 滚动合并
//
// 为什么工具摘要要单独拼：规格 §3.4 要求「行号必须逐字抄自工具结果，不许估算」。
// 所以不能让 LLM 凭记忆写文件行号，得把真实的 path/command/结果摘要摆给它看。
import { SUMMARY_FIELDS, SUMMARY_MAX_TOKENS, KEEP_RECENT_ROUNDS, planRollup, summaryPromptFor, mergePromptFor, checkSummaryLength, buildMergeGroups, truncateSummaryText } from './round-summary.mjs';
import { traceArgsOf } from './ledger.mjs';

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 一条工具调用 → 一行「可抄行号」的清单。
 *
 * 2026-11-17 修复：
 *   · agent-service 的 trace 里 args 是 JSON **字符串**，旧实现按对象读 → 路径/命令全是空，
 *     清单里只剩工具名，模型「逐字抄行号」根本无处可抄。
 *   · 旧实现不看 result —— 行号恰恰在 result 里（grep 命中行、edit 的起始行、
 *     read 的总行数、命令退出码与 stderr）。现在按工具把这些确定性字段摘出来。
 */
function digestLine(t) {
  const name = String(t.tool || t.name || '');
  const args = traceArgsOf(t);
  const r = t.result && typeof t.result === 'object' ? t.result : {};
  const err = t.error || r.error;
  const target = clip(args.path || args.dir || args.target || '', 160);
  let detail = '';
  if (name === 'read_file') {
    const total = Number(r.totalLines);
    const off = Number(r.offset);
    detail = [total > 0 ? `共 ${total} 行` : '', off > 0 ? `从第 ${off} 字符起` : '', r.truncated ? '未读完' : ''].filter(Boolean).join('，');
  } else if (name === 'grep_code') {
    const rows = Array.isArray(r.results) ? r.results : [];
    const hits = rows.slice(0, 8).map((x) => `${clip(x.file, 120)}:${Number(x.line) || '?'}`);
    detail = `"${clip(args.pattern, 60)}" 命中 ${Number(r.total) || rows.length} 处${hits.length ? '：' + hits.join('、') : ''}`;
  } else if (name === 'edit_file') {
    const line = Number(r.line);
    detail = [line > 0 ? `改动起始于第 ${line} 行` : '', Number.isFinite(Number(r.added)) ? `+${Number(r.added)}/-${Number(r.removed) || 0}` : ''].filter(Boolean).join(' ');
  } else if (name === 'write_file') {
    detail = Number(r.totalLines) > 0 ? `写入 ${Number(r.totalLines)} 行` : '';
  } else if (name === 'run_command') {
    const code = r.code;
    detail = `${clip(args.command, 140)}${code === undefined || code === null ? '' : ` 退出码 ${code}`}`;
    if (Number(code) && r.stderr) detail += ` stderr：${clip(String(r.stderr).split('\n').find((l) => l.trim()) || '', 200)}`;
  } else if (!target) {
    detail = clip(args.command || args.pattern || '', 120);
  }
  const status = t.status || (err ? 'fail' : 'ok');
  let line = `- ${name}${target ? ' ' + target : ''}${detail ? ' ' + detail : ''} [${status}]`;
  if (err) line += ' 报错：' + clip(err, 200);
  return line;
}

/** 把一轮的 trace 压成「工具调用清单」（含路径与关键结果，供摘要抄行号）。超长时保头保尾。 */
export function toolDigestOf(trace, { maxChars = 20000 } = {}) {
  const list = Array.isArray(trace) ? trace : [];
  const lines = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    lines.push(digestLine(t));
  }
  const joined = lines.join('\n');
  if (joined.length <= maxChars) return joined;
  // 保头保尾：开头是任务起点，结尾是最近的改动/报错（下一轮最需要的）
  const head = joined.slice(0, Math.floor(maxChars * 0.4));
  const tail = joined.slice(-Math.floor(maxChars * 0.6));
  return head.slice(0, head.lastIndexOf('\n') + 1) + `…（中间 ${lines.length} 条里省略了一部分）\n` + tail.slice(tail.indexOf('\n') + 1);
}

// ── 同一会话的摘要写入串行化 + 「下一轮开头等上一轮摘要」──
//
// 2026-11-17 修复：writeRoundSummary 是「读 → 调模型（几十秒）→ 写」，回合结束后
// fire-and-forget 地跑。两个后果：
//   ① 用户紧接着发下一句：上一轮摘要还没落盘，下一轮开头读不到 → 恰好在最需要跨轮记忆的
//      时候没有记忆。
//   ② 两份摘要同时在跑：各自读到同一份旧列表，后写者覆盖先写者 → 一轮摘要永久丢失。
// 现在每个会话一条 Promise 链：写入严格按回合顺序排队；下一轮开头调用
// awaitPendingRoundSummary 最多等一小会儿（不会因为摘要慢把回合卡死）。
const sessionChains = new Map();

function enqueue(sessionId, fn) {
  const key = String(sessionId);
  const prev = sessionChains.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  sessionChains.set(key, tail);
  tail.then(() => { if (sessionChains.get(key) === tail) sessionChains.delete(key); });
  return run;
}

/**
 * 等这个会话已排队的摘要写完（最多 timeoutMs）。超时返回 false，调用方照常继续。
 * @returns {Promise<boolean>} true = 已全部落盘（或本来就没有）
 */
export async function awaitPendingRoundSummary(sessionId, { timeoutMs = 15000 } = {}) {
  const p = sessionChains.get(String(sessionId));
  if (!p) return true;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); });
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 测试用：是否还有排队中的摘要 */
export function hasPendingRoundSummary(sessionId) {
  return sessionChains.has(String(sessionId));
}

/**
 * 逐层合并：已有古老摘要永远排在第一份，任何一份都不截断。
 * 输入超过 charBudget 时按组先合并，再把组结果合并，直到只剩一份。
 * （2026-11-17 修复：旧实现超预算时从最老的开始丢——而最老的那份恰恰是古老摘要，
 *  也就是之前修过的「第 1 轮永久消失」在合并失败积压后会重新出现。）
 */
async function mergeAll(items, summarize, charBudget = 30000) {
  let texts = items.map((x) => String(x?.text || '')).filter((t) => t.trim());
  if (!texts.length) return '';
  for (let level = 0; level < 6; level++) {
    const groups = buildMergeGroups(texts, charBudget);
    if (groups.length === 1) {
      return String(await summarize(mergePromptFor() + '\n\n' + groups[0]) || '').trim();
    }
    const next = [];
    for (const g of groups) {
      const out = String(await summarize(mergePromptFor() + '\n\n' + g) || '').trim();
      if (!out) throw new Error('合并摘要为空');
      next.push(out);
    }
    if (next.length >= texts.length) { texts = next; break; } // 没有收敛：直接整体合并
    texts = next;
  }
  return String(await summarize(mergePromptFor() + '\n\n' + buildMergeGroups(texts, Infinity)[0]) || '').trim();
}

/**
 * 生成并保存本轮摘要（含滚动合并）。同一会话的调用自动排队，严格按调用顺序落盘。
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} [opts.roundId] 稳定的回合 id（同一回合重跑不会产生第二份摘要）
 * @param {string} opts.userMessage 用户本轮原话（摘要里要逐字引用）
 * @param {Array} opts.trace 本轮工具调用记录
 * @param {string} opts.answer 本轮最终回答
 * @param {number} [opts.at] 这一轮结束的时间（默认现在）；用于和 /compact 的切分点比较
 * @param {function} opts.summarize (prompt: string) => Promise<string>  —— 提示词须原样发送
 * @param {object} opts.sessions 会话存储（需有 loadRoundSummaries / saveRoundSummaries）
 * @returns {Promise<{ok:boolean, count?:number, merged?:boolean, skipped?:boolean, error?:string}>}
 */
export function writeRoundSummary(opts) {
  const { sessionId, summarize, sessions } = opts || {};
  if (!sessionId || typeof summarize !== 'function') return Promise.resolve({ ok: false, error: '缺少 sessionId 或 summarize' });
  if (!sessions || typeof sessions.loadRoundSummaries !== 'function') return Promise.resolve({ ok: false, error: '会话存储缺少 summary 接口' });
  const at = Number(opts.at) || Date.now();
  return enqueue(sessionId, () => writeRoundSummaryNow({ ...opts, at }));
}

async function writeRoundSummaryNow({ sessionId, roundId, userMessage, trace, answer, summarize, sessions, at }) {
	let prev = [];
	try { prev = await sessions.loadRoundSummaries(sessionId); } catch { prev = []; }
	if (!Array.isArray(prev)) prev = [];

	const id = roundId ? 'r:' + String(roundId) : 'r' + at;
	// 幂等：同一回合（重试 / 重放）已经有摘要就不再写第二份
	if (roundId && prev.some((x) => x && x.id === id)) return { ok: true, count: prev.length, skipped: true };

	// ① 拼提示词：6 段模板 + 用户原话 + 工具清单 + 本轮回答
	const digest = toolDigestOf(trace);
	const prompt = summaryPromptFor(userMessage, digest);
	const withAnswer = answer ? prompt + '\n\n--- 本轮最终回答 ---\n' + String(answer).slice(0, 8000) : prompt;

	let text = '';
	try {
		text = String(await summarize(withAnswer) || '').trim();
	} catch (e) {
		return { ok: false, error: '摘要生成失败：' + (e?.message || String(e)) };
	}
	if (!text) return { ok: false, error: '摘要为空' };
	// 超上限时截断：保头保尾（末尾的「待办 / 当前正在做什么」是下一轮最需要的）
	const len = checkSummaryLength(text);
	if (!len.ok) text = truncateSummaryText(text, { maxTokens: SUMMARY_MAX_TOKENS });

	const entry = { id, text, at };
	const next = [...prev, entry];
	const plan = planRollup(next, { keepRecent: KEEP_RECENT_ROUNDS });

	// ② 需要合并时：把「已有古老摘要 + 溢出的轮摘要」合成一份新的「古老摘要」
	let merged = false;
	let finalList = next;
	if (plan.needsMerge) {
		try {
			// 已有古老摘要作为「第 0 份」放在最前面一起合并（否则第 1 轮的历史会永久消失）
			const ancientPrev = plan.ancient[plan.ancient.length - 1] || null;
			const mergeItems = [
				...(ancientPrev ? [ancientPrev] : []),
				...plan.toMerge
			];
			const mergedText = await mergeAll(mergeItems, summarize, 30000);
			if (mergedText) {
				// coversUntil = 这份古老摘要「最晚覆盖到哪一轮结束」（at 只是写入时间，不能用来判断覆盖范围）
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
