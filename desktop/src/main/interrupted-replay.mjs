// 中断后「继续」：像 Claude Code 一样把上一轮的完整工具过程原样放回上下文（2026-11-19 用户定案）。
//
// FC 平时跨轮只带文字（工具结果靠每轮摘要 / 账本补）；但被中断的回合（网关断开、手动停止、
// 中途关 app）没有正常收尾——摘要和账本都没写、最终回答是空的，用户说「继续」时 AI 对刚才
// 几百步一无所知，只能从头 ls / 读文件 / 看截图（用户实测 281 步的回合）。
//
// 做法：上一轮（紧挨着本轮用户消息的那条 assistant）是中断的且跑过工具 → 从库里读它的工具记录，
// 还原成标准的 assistant(tool_calls) + tool(result) 消息序列，替换掉渲染层送来的那条摘要/半句正文。
// 超预算时：最近的步骤原样保留，更早的压成一段摘要（每步一行）。

const PER_TOOL_MAX = 6000;     // 单个工具结果最多带回的字符数
const DEFAULT_BUDGET = 200000; // 整段回放的字符预算（约 6~10 万 token）

function oneLine(v, n) {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function argsJson(args) {
  if (args == null || args === '') return '{}';
  if (typeof args === 'string') {
    try { JSON.parse(args); return args; } catch { return JSON.stringify({ _raw: args.slice(0, 4000) }); }
  }
  try { return JSON.stringify(args); } catch { return '{}'; }
}

function resultText(tr) {
  const r = tr?.result;
  if (r == null) {
    if (tr?.error) return JSON.stringify({ error: String(tr.error) });
    return tr?.status === 'running' || tr?.status === 'interrupted'
      ? '（中断时这个工具还没跑完，没有结果）'
      : '（没有记录到结果）';
  }
  let s;
  try { s = typeof r === 'string' ? r : JSON.stringify(r); } catch { s = String(r); }
  return s.length > PER_TOOL_MAX ? `${s.slice(0, PER_TOOL_MAX)}…[结果过长已截断，原长 ${s.length} 字符；需要全文请重新调用工具]` : s;
}

/**
 * 把一条中断回合的 trace 还原成 OpenAI 消息序列。
 * @returns {{messages:Array, replayed:number, summarized:number, chars:number}}
 */
export function buildReplayMessages(turn, { budgetChars = DEFAULT_BUDGET } = {}) {
  const trace = (Array.isArray(turn?.trace) ? turn.trace : []).filter((x) => x && (x.tool || x.name));
  // 从最近往前装，装满预算为止；装不下的更早步骤压成摘要
  const full = [];
  let used = 0;
  let cut = trace.length;
  for (let i = trace.length - 1; i >= 0; i--) {
    const tr = trace[i];
    const cost = resultText(tr).length + argsJson(tr.args).length + String(tr.say || tr.thought || '').length + 120;
    if (used + cost > budgetChars && full.length) break;
    used += cost;
    full.unshift(i);
    cut = i;
  }
  const messages = [];
  if (cut > 0) {
    const lines = trace.slice(0, cut).map((tr, i) => `${i + 1}. ${tr.tool || tr.name}(${oneLine(tr.args, 120)}) → ${oneLine(tr.result?.error ? `失败：${tr.result.error}` : tr.result, 160)}`);
    messages.push({ role: 'assistant', content: `[上一轮较早的 ${cut} 步（只保留摘要，原文超出预算）]\n${lines.join('\n')}` });
  }
  const seen = new Set();
  for (const i of full) {
    const tr = trace[i];
    let id = String(tr.callId || tr.id || `replay_${i}`);
    if (seen.has(id)) id = `${id}_${i}`;
    seen.add(id);
    const said = String(tr.say || '').trim();
    const thought = String(tr.thought || '').trim();
    const content = said || (thought ? `（当时的思路）${thought.slice(0, 1500)}` : null);
    messages.push({ role: 'assistant', content, tool_calls: [{ id, type: 'function', function: { name: String(tr.tool || tr.name), arguments: argsJson(tr.args) } }] });
    messages.push({ role: 'tool', tool_call_id: id, content: resultText(tr) });
  }
  messages.push(replayNote(turn, { summarized: cut > 0 }));
  return { messages, replayed: full.length, summarized: cut, chars: used };
}

/** 回放末尾那条说明：这一轮在哪里、为什么中断（full-history 跨轮展开时也用同一条，保证前后轮字节一致） */
export function replayNote(turn, { summarized = false } = {}) {
  const why = turn?.error ? `因为「${oneLine(turn.error, 120)}」中断` : '被中断（手动停止，或软件中途关闭）';
  const partial = String(turn?.content || '').trim();
  return {
    role: 'assistant',
    content: `[上一轮在这里${why}。以上是中断前的${summarized ? '全部工具调用（较早部分为摘要）' : '全部工具调用'}与真实结果。用户说「继续」时直接从这里接着做：已经读过、跑过、确认过的不要重做。]${partial ? `\n中断前已输出的正文：${partial.slice(0, 2000)}` : ''}`,
  };
}

/**
 * 若上一轮是中断的（error / interrupted）且跑过工具：把上下文里代表它的那条 assistant
 * （渲染层送来的进展摘要或半句正文）替换成完整回放。否则原样返回。
 * @param {Array} contextMessages 即将发给模型的历史（最后一条是本轮用户消息）
 * @param {Array} dbMessages 库里的会话消息（loadSession().messages）
 */
export function replayInterruptedTurn(contextMessages, dbMessages, opts = {}) {
  const ctx = Array.isArray(contextMessages) ? contextMessages : [];
  const db = Array.isArray(dbMessages) ? dbMessages : [];
  const lastAssistantDb = [...db].reverse().find((m) => m?.role === 'assistant');
  if (!lastAssistantDb || !(lastAssistantDb.error || lastAssistantDb.interrupted)) return { messages: ctx, replay: null };
  const trace = Array.isArray(lastAssistantDb.trace) ? lastAssistantDb.trace.filter((x) => x && (x.tool || x.name)) : [];
  if (!trace.length) return { messages: ctx, replay: null };
  // 上下文里：本轮用户消息之前紧挨着的那条 assistant 就是它（渲染层的摘要 / 半句正文）
  const lastUser = ctx.map((m) => m?.role).lastIndexOf('user');
  if (lastUser <= 0) return { messages: ctx, replay: null };
  const prev = ctx[lastUser - 1];
  const replay = buildReplayMessages(lastAssistantDb, opts);
  const before = prev?.role === 'assistant' ? ctx.slice(0, lastUser - 1) : ctx.slice(0, lastUser);
  return { messages: [...before, ...replay.messages, ...ctx.slice(lastUser)], replay };
}
