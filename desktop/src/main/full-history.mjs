// 跨轮完整历史（0.25，对齐 Claude Code）：之前每一轮的工具调用与结果原样留在对话里。
//
// 0.24 及以前：渲染层只把每轮「最终回答」文字发回来，工具过程全部丢掉，靠后台每轮 LLM 摘要 + 账本索引
// 补记忆 —— 上下文再充裕，下一轮也看不到上一轮读过的文件原文，只能重读；每轮末尾插入的摘要/索引
// 到下一轮又被拿掉，前缀缓存从上一轮的位置断开。
//
// 现在：从库里读每条 assistant 消息的工具记录（每一步：调用 id / 参数 / 结果 / 当时说的话），
// 还原成和回合内完全同形的 assistant(tool_calls) + tool 消息序列，插在该轮最终回答之前。
// 回合内发出去的是什么，下一轮带上的就尽量是什么（字节一致 → 网关前缀缓存可以接着命中）。
// 真正逼近窗口时由 assembleContext / 回合内 compactNow 统一压缩（模型写交接摘要）。

import { buildReplayMessages, replayNote } from './interrupted-replay.mjs';

const MAX_INLINE_RESULT = 20000; // 与 agent-service 回合内的工具结果上限一致

function argsJson(args) {
  if (args == null || args === '') return '{}';
  if (typeof args === 'string') {
    try { JSON.parse(args); return args; } catch { return JSON.stringify({ _raw: args.slice(0, 4000) }); }
  }
  try { return JSON.stringify(args); } catch { return '{}'; }
}

/** 还原回合内发给模型的工具结果文本（与 runToolCall 的 modelContent 同一口径）。 */
export function toolContentOf(step) {
  const r = step?.result;
  if (r == null) {
    if (step?.error) return JSON.stringify({ error: String(step.error) });
    return JSON.stringify({ error: '（没有记录到结果：工具可能被中断）' });
  }
  // 0.26：落盘结果存了当轮发给模型的原文（inline），原样用它；老数据没有 inline 才按预览拼
  if (r && typeof r === 'object' && r.truncated === true && typeof r.inline === 'string') return r.inline;
  if (r && typeof r === 'object' && r.truncated === true && r.spillFile !== undefined && r.preview !== undefined) {
    // 回合内超长结果是「头 + 尾 + 落盘路径」；库里只存了预览，按同样的提示格式还原
    return `[结果过长 ${r.chars} 字符，已完整落盘]\n完整输出: ${r.spillFile || '(落盘失败)'}\n可用 run_command 在该文件上检索（findstr / Select-String），或用更小的参数重跑。\n--- 前 2000 字符 ---\n${r.preview}`;
  }
  let s;
  try { s = typeof r === 'string' ? r : JSON.stringify(r); } catch { s = String(r); }
  return s.length > MAX_INLINE_RESULT ? `${s.slice(0, MAX_INLINE_RESULT)}…[已截断，原长 ${s.length} 字符]` : s;
}

/**
 * 把一轮的工具记录还原成消息序列。同一次模型回复里并发的多个调用（同一个 round）合成一条
 * assistant(tool_calls)；老数据没有 round 字段时，按「带 say/thought 的步骤开启新一轮」近似。
 */
export function turnToolMessages(trace) {
  const steps = (Array.isArray(trace) ? trace : []).filter((x) => x && (x.tool || x.name));
  const out = [];
  const seen = new Set();
  let group = null;
  let groupRound;
  const flush = () => {
    if (!group) return;
    out.push(group.assistant, ...group.tools);
    group = null;
  };
  steps.forEach((st, i) => {
    const hasRound = st.round !== undefined && st.round !== null;
    const startsNew = !group
      || (hasRound ? st.round !== groupRound : !!(st.say || st.thought));
    if (startsNew) {
      flush();
      groupRound = hasRound ? st.round : undefined;
      const say = String(st.say || '').trim();
      group = { assistant: { role: 'assistant', content: say || null, tool_calls: [] }, tools: [] };
    }
    let id = String(st.callId || st.id || `h_${i}`);
    if (seen.has(id)) id = `${id}_${i}`;
    seen.add(id);
    group.assistant.tool_calls.push({ id, type: 'function', function: { name: String(st.tool || st.name), arguments: argsJson(st.args) } });
    group.tools.push({ role: 'tool', tool_call_id: id, content: toolContentOf(st) });
  });
  flush();
  return out;
}

// 中断 / 出错回合在渲染层被换成「进展摘要」，开头固定是这句（renderer/lib/interrupted-digest.mjs）
const DIGEST_HEAD = '[上一轮在执行中';
// 中断回合按回合内原样还原时的总字符上限；超过就退回 interrupted-replay 的「近的原样 + 早的摘要」
const BROKEN_FULL_MAX_CHARS = 400000;

const isBroken = (m) => !!(m?.error || m?.interrupted);
const toolSteps = (m) => (Array.isArray(m?.trace) ? m.trace.filter((x) => x && (x.tool || x.name)) : []);

/**
 * 中断 / 出错回合的完整工具过程：和回合内发出去的一致（同一套 turnToolMessages），末尾加一条「在这里中断」的说明。
 * 不管它是上一轮还是更早的轮次，表示都一样 → 之后每一轮前缀不变、缓存接着命中，模型也一直看得到原始结果。
 */
export function brokenTurnMessages(dbMsg) {
  const seq = turnToolMessages(dbMsg.trace);
  const chars = seq.reduce((a, m) => a + String(m.content ?? '').length + JSON.stringify(m.tool_calls ?? '').length, 0);
  if (chars <= BROKEN_FULL_MAX_CHARS) return { messages: [...seq, replayNote(dbMsg)], steps: seq.filter((x) => x.role === 'tool').length };
  const r = buildReplayMessages(dbMsg);
  return { messages: r.messages, steps: r.replayed };
}

/**
 * 把上下文里「只有最终回答」的历史 assistant 消息展开成完整工具过程 + 最终回答；
 * 中断 / 出错回合（渲染层送来的是进展摘要）换成完整工具过程 + 中断说明。
 * 对齐方式：
 *  - 正常回合按顺序扫库里的 assistant 消息，用正文相等找到上下文里对应的那条（渲染层送来的就是库里的 content）；
 *  - 中断回合：上下文里以「[上一轮在执行中」开头的摘要，按顺序对应库里「中断且有进展」的回合。
 * 本轮用户消息之后的内容不动。
 * @returns {{messages:Array, expanded:number, steps:number, replayed:number}}
 */
export function expandToolHistory(contextMessages, dbMessages) {
  const ctx = Array.isArray(contextMessages) ? contextMessages : [];
  const all = (Array.isArray(dbMessages) ? dbMessages : []).filter((m) => m?.role === 'assistant');
  const db = all.filter((m) => !isBroken(m) && toolSteps(m).length);
  // 渲染层只给「跑过工具或有正文」的中断回合生成摘要（没进展的直接丢掉），这里用同一条件对齐
  const broken = all.filter((m) => isBroken(m) && (toolSteps(m).length || String(m.content || '').trim()));
  if (!db.length && !broken.some((m) => toolSteps(m).length)) return { messages: ctx, expanded: 0, steps: 0, replayed: 0 };
  const lastUser = ctx.map((m) => m?.role).lastIndexOf('user');
  const out = [];
  let di = 0;
  let bi = 0;
  let expanded = 0;
  let steps = 0;
  let replayed = 0;
  ctx.forEach((m, idx) => {
    if (idx < lastUser && m?.role === 'assistant' && typeof m.content === 'string' && !m.tool_calls) {
      if (m.content.startsWith(DIGEST_HEAD)) {
        const b = broken[bi++];
        if (b && toolSteps(b).length) {
          const r = brokenTurnMessages(b);
          out.push(...r.messages);
          replayed++;
          steps += r.steps;
          return; // 摘要被完整过程替换
        }
        out.push(m);
        return;
      }
      let k = di;
      while (k < db.length && String(db[k].content ?? '') !== m.content) k++;
      if (k < db.length) {
        di = k + 1;
        const seq = turnToolMessages(db[k].trace);
        if (seq.length) {
          out.push(...seq);
          expanded++;
          steps += seq.filter((x) => x.role === 'tool').length;
        }
      }
    }
    out.push(m);
  });
  return { messages: out, expanded, steps, replayed };
}
