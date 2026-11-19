// 出错中断的回合怎么带进下一轮（2026-11-18 用户实测）：
// 网关断开后回合以 error 结束，用户说「继续」时，旧逻辑把所有 error 消息整条过滤掉——
// 界面上 10 分钟 / 91 步的工具记录直接消失，模型也完全不知道刚才做到哪，只能从头再来。
// 现在：界面照常显示；发给模型时，把这一轮「已经做了什么」压成一段摘要代替。

const MAX_ITEMS = 24;
const MAX_CHARS = 6000;

function oneLine(v, n) {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function argSummary(args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return oneLine(a, 140); } }
  if (!a || typeof a !== 'object') return '';
  const key = a.command ?? a.path ?? a.target ?? a.dir ?? a.url ?? a.pattern ?? a.topic ?? a.question ?? a.file;
  return oneLine(key ?? a, 140);
}

function resultSummary(r) {
  if (r == null) return '';
  if (typeof r === 'object') {
    if (r.error) return `失败：${oneLine(r.error, 160)}`;
    if (r.verdict) return `verdict=${r.verdict}${r.reason ? `（${oneLine(r.reason, 120)}）` : ''}`;
    if (typeof r.stdout === 'string') return oneLine(r.stdout, 200) || `exit ${r.code ?? '?'}`;
    if (typeof r.content === 'string') return `${r.totalLines ? `${r.totalLines} 行 ` : ''}${oneLine(r.content, 120)}`;
    if (r.truncated && r.spillFile) return `结果过长已落盘 ${r.spillFile}`;
  }
  return oneLine(r, 200);
}

/**
 * 出错回合 → 发给模型的 assistant 内容；没有可交代的进展（没跑过工具、也没正文）返回 null（继续不带它）。
 * @param {{content?:string, error?:string, trace?:Array, workedMs?:number}} m
 */
export function interruptedTurnDigest(m) {
  const trace = Array.isArray(m?.trace) ? m.trace.filter((x) => x && x.tool) : [];
  const text = String(m?.content || '').trim();
  if (!trace.length && !text) return null;
  const mins = m?.workedMs ? Math.max(1, Math.round(m.workedMs / 60000)) : null;
  const why = m?.error ? `被中断（${oneLine(m.error, 120)}）` : '被用户手动停止';
  const head = `[上一轮在执行中${why}${mins ? `，已工作约 ${mins} 分钟` : ''}，共调用工具 ${trace.length} 次。以下是停下前已经完成的工作（含你当时的思路），用户说继续时就从这里接着做，不要从头重来；已确认的结论不必重查。]`;
  const items = trace.slice(-MAX_ITEMS).map((x, i) => {
    const line = `${trace.length - Math.min(trace.length, MAX_ITEMS) + i + 1}. ${x.tool}(${argSummary(x.args)}) → ${resultSummary(x.result)}`;
    const note = oneLine(x.say || x.thought || '', 160);
    return note ? `   （当时的思路：${note}）
${line}` : line;
  });
  const skipped = trace.length > MAX_ITEMS ? [`（更早的 ${trace.length - MAX_ITEMS} 次调用略）`] : [];
  const body = [head, ...skipped, ...items, ...(text ? ['中断前已输出的正文：', text.slice(0, 1500)] : [])].join('\n');
  return body.length > MAX_CHARS ? body.slice(0, MAX_CHARS) + '…' : body;
}

/**
 * 发送前整理历史：返回 { display, wire }。
 * display：本地渲染用（出错回合保留）；wire：发给主进程的 role/content（出错回合换成进展摘要，没进展的丢掉）。
 */
export function buildSendHistory(baseMessages) {
  const kept = (Array.isArray(baseMessages) ? baseMessages : [])
    .filter((m) => !m.local && !m.steer && (m.role === 'user' || m.role === 'assistant'))
    // 只剥流式瞬态字段；已完成消息的 events（含每轮思考）必须保留——以前一起剥掉，
    // 发下一条消息后上一轮的模型输出从界面消失，只剩工具（用户实测）
    .map((m) => { const { streaming, startedAt, ...rest } = m; if (streaming) delete rest.events; return rest; });
  const wire = [];
  for (const m of kept) {
    // 出错中断 / 手动停止且已经干了活的回合：都换成进展摘要（停止的回合以前只带已流出的半句正文，AI 不知道做过什么）
    const stoppedWithWork = m.role === 'assistant' && m.interrupted && Array.isArray(m.trace) && m.trace.length > 0;
    if (m.error || stoppedWithWork) {
      if (m.role !== 'assistant') continue;
      const digest = interruptedTurnDigest(m);
      if (digest) wire.push({ role: 'assistant', content: digest });
      continue;
    }
    wire.push({ role: m.role, content: m.content });
  }
  return { display: kept, wire };
}
