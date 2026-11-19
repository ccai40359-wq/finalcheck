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

/**
 * 把上下文里「只有最终回答」的历史 assistant 消息展开成完整工具过程 + 最终回答。
 * 对齐方式：按顺序扫库里的 assistant 消息，用正文相等找到上下文里对应的那条（渲染层送来的就是库里的 content）。
 * 中断 / 出错的回合不在这里处理（interrupted-replay 负责最后一轮的回放）。
 * @returns {{messages:Array, expanded:number, steps:number}}
 */
export function expandToolHistory(contextMessages, dbMessages) {
  const ctx = Array.isArray(contextMessages) ? contextMessages : [];
  const db = (Array.isArray(dbMessages) ? dbMessages : []).filter((m) => m?.role === 'assistant'
    && !m.error && !m.interrupted && Array.isArray(m.trace) && m.trace.some((x) => x && (x.tool || x.name)));
  if (!db.length) return { messages: ctx, expanded: 0, steps: 0 };
  const lastUser = ctx.map((m) => m?.role).lastIndexOf('user'); // 本轮用户消息之后的内容不动
  const out = [];
  let di = 0;
  let expanded = 0;
  let steps = 0;
  ctx.forEach((m, idx) => {
    if (idx < lastUser && m?.role === 'assistant' && typeof m.content === 'string' && !m.tool_calls) {
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
  return { messages: out, expanded, steps };
}
