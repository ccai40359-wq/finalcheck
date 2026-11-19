// 剧本断言：每一轮结束后检查「真人能看到/会在意」的结果。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ser = (m) => JSON.stringify({ r: m?.role, c: m?.content ?? null, t: m?.tool_calls ?? null, i: m?.tool_call_id ?? null });

/** 主 agent 相邻两次请求：上一次发出的消息是不是这一次的前缀（不是 = 前缀缓存从那里断开） */
export function prefixReport(mainRequests) {
  let breaks = 0;
  const at = [];
  let est = 0;
  let cached = 0;
  for (let i = 0; i < mainRequests.length; i++) {
    const r = mainRequests[i];
    est += r.estPromptTokens || 0;
    cached += r.estCachedTokens || 0;
    if (i === 0) continue;
    const prev = (mainRequests[i - 1].messages || []).map(ser);
    const cur = (r.messages || []).map(ser);
    const ok = prev.length <= cur.length && prev.every((x, k) => x === cur[k]);
    if (!ok) { breaks++; at.push(r.n); }
  }
  return { total: mainRequests.length, breaks, at, cachedRatio: est ? Math.round((cached / est) * 100) : 0 };
}

const re = (s) => new RegExp(s, 'i');

/**
 * @param {any} turn  client.send() 的返回
 * @param {Record<string, any>} ex
 * @param {{ projectDir: string, sim: any }} ctx
 */
export async function checkTurn(turn, ex, { projectDir, sim }) {
  const out = [];
  const add = (name, ok, detail = '') => out.push({ name, ok: !!ok, detail });
  if (ex.error) add(`报错匹配 /${ex.error}/`, turn.error && re(ex.error).test(turn.error), `实际：${turn.error || '没有报错'}`);
  else if (ex.cancelled) add('本轮被停止', turn.cancelled || turn.interrupted, `实际：cancelled=${turn.cancelled}`);
  else add('没有报错', !turn.error, `报错：${turn.error}`);
  if (ex.answerMatches) add(`回答匹配 /${ex.answerMatches}/`, re(ex.answerMatches).test(turn.answer || ''), `回答：${String(turn.answer || '').slice(0, 200)}`);
  if (ex.answerNotMatches) add(`回答不含 /${ex.answerNotMatches}/`, !re(ex.answerNotMatches).test(turn.answer || ''), `回答：${String(turn.answer || '').slice(0, 200)}`);
  for (const t of ex.toolsInclude || []) add(`调用了 ${t}`, turn.tools.includes(t), `实际工具：${turn.tools.join(', ') || '无'}`);
  for (const t of ex.toolsExclude || []) add(`没有调用 ${t}`, !turn.tools.includes(t), `实际工具：${turn.tools.join(', ')}`);
  if (ex.firstTool) add(`第一个工具是 ${ex.firstTool}`, turn.tools[0] === ex.firstTool, `实际：${turn.tools[0] || '无'}`);
  if (ex.maxTools != null) add(`工具 ≤ ${ex.maxTools} 次`, turn.tools.length <= ex.maxTools, `实际 ${turn.tools.length}`);
  if (ex.minTools != null) add(`工具 ≥ ${ex.minTools} 次`, turn.tools.length >= ex.minTools, `实际 ${turn.tools.length}`);
  if (ex.maxRequests != null) add(`请求 ≤ ${ex.maxRequests} 次`, turn.requests.length <= ex.maxRequests, `实际 ${turn.requests.length}`);
  if (ex.maxMs != null) add(`耗时 ≤ ${ex.maxMs}ms`, turn.ms <= ex.maxMs, `实际 ${turn.ms}ms`);
  const main = turn.requests.filter((r) => r.kind === 'main');
  if (ex.requestIncludes) {
    const first = main[0];
    const hay = JSON.stringify(first?.messages || []);
    add(`本轮第一次请求带着 /${ex.requestIncludes}/`, re(ex.requestIncludes).test(hay), '上下文里找不到（模型看不到之前的内容）');
  }
  // 本轮主 agent 最后一次请求（看子代理报告进没进来、子代理读的原文有没有漏进主上下文）
  if (ex.lastMainIncludes || ex.lastMainExcludes) {
    const hay = JSON.stringify(main.at(-1)?.messages || []);
    if (ex.lastMainIncludes) add(`主 agent 上下文里有 /${ex.lastMainIncludes}/`, re(ex.lastMainIncludes).test(hay), '没找到');
    if (ex.lastMainExcludes) add(`主 agent 上下文里没有 /${ex.lastMainExcludes}/`, !re(ex.lastMainExcludes).test(hay), '漏进来了');
  }
  if (ex.subagentRequestsMin != null) {
    const n = turn.requests.filter((r) => r.kind === 'subagent').length;
    add(`子代理请求 ≥ ${ex.subagentRequestsMin} 次`, n >= ex.subagentRequestsMin, `实际 ${n}`);
  }
  if (ex.parallelSubagents) {
    // 子代理请求的时间区间有重叠 = 真的并行
    const subs = turn.requests.filter((r) => r.kind === 'subagent').map((r) => [r.at, r.at + (r.ms || 0)]);
    const overlap = subs.some((a, i) => subs.some((b, j) => i !== j && a[0] < b[1] && b[0] < a[1]));
    add('子代理并行执行', overlap, `区间：${JSON.stringify(subs.map((x) => x[0] - (subs[0]?.[0] || 0)))}`);
  }
  if (ex.prefixStable) {
    const p = prefixReport(main);
    add('本轮内前缀不断开', p.breaks === 0, `断开 ${p.breaks} 次（请求 ${p.at.join('、')}）`);
  }
  for (const k of ex.eventsInclude || []) add(`界面收到 ${k} 事件`, turn.events.some((e) => e.kind === k), `事件种类：${[...new Set(turn.events.map((e) => e.kind))].join(', ')}`);
  for (const [rel, rule] of Object.entries(ex.files || {})) {
    let text = null;
    try { text = readFileSync(path.join(projectDir, rel), 'utf8'); } catch { /* 不存在 */ }
    if (rule.exists === false) { add(`${rel} 不存在`, text == null, '文件存在'); continue; }
    if (text == null) { add(`${rel} 存在`, false, '文件不存在'); continue; }
    if (rule.contains) add(`${rel} 包含 ${rule.contains}`, text.includes(rule.contains), `内容：${text.slice(0, 160)}`);
    if (rule.notContains) add(`${rel} 不含 ${rule.notContains}`, !text.includes(rule.notContains), `内容：${text.slice(0, 160)}`);
  }
  if (ex.dbMessages != null || ex.dbLastTraceMin != null) {
    const s = await sim.loadSession(turn.sessionId);
    const msgs = s.messages || [];
    if (ex.dbMessages != null) add(`库里有 ${ex.dbMessages} 条消息`, msgs.length === ex.dbMessages, `实际 ${msgs.length}`);
    if (ex.dbLastTraceMin != null) {
      const last = msgs.filter((m) => m.role === 'assistant').at(-1);
      add(`库里最后一条回答带 ≥ ${ex.dbLastTraceMin} 步工具记录`, (last?.trace?.length || 0) >= ex.dbLastTraceMin, `实际 ${last?.trace?.length || 0}`);
    }
  }
  if (ex.workflow) {
    const wf = turn.trace.filter((x) => (x?.tool || x?.name) === 'run_workflow');
    const ok = wf.some((x) => x?.result && !x.result.error);
    add('工作流跑成功', ok, wf.length ? `结果：${JSON.stringify(wf.at(-1)?.result || {}).slice(0, 300)}` : '没有调用 run_workflow');
  }
  return out;
}
