// 「继续」时要把证据带上：主 agent 的新回合看不到上一条失败消息的 tool trace（会话重建只带正文），
// 所以如果上一轮跑过 run_workflow，就从 trace 里取一份紧凑摘要拼进继续指令里——模型不用重跑也能给结论。
export function buildContinueText(message) {
  const plain = '继续：基于上面时间线里已收集的证据接着做；如果工作流结果已经在上面，直接基于它给出最终结论，不要重复已经跑过的步骤。';
  const trace = Array.isArray(message?.trace) ? message.trace : [];
  const wf = trace.find((t) => t && t.tool === 'run_workflow' && t.result && typeof t.result === 'object');
  const r = wf?.result;
  if (!r || r.error) return plain;

  const lines = ['【继续：附上一轮工作流结果（已跑完，禁止重跑任何步骤）】'];
  if (r.goal) lines.push(`目标：${String(r.goal).slice(0, 300)}`);
  const rows = Array.isArray(r.results) ? r.results : [];
  if (rows.length) {
    lines.push('节点执行情况：');
    for (const row of rows) {
      const name = String(row?.name || row?.id || '节点');
      const ms = Math.round((Number(row?.ms) || 0) / 1000);
      const tools = Number(row?.tools) || 0;
      const state = row?.ok ? '成功' : `失败${row?.errorCode ? `（${row.errorCode}）` : ''}`;
      lines.push(`- ${name}：${state}，${ms}s，${tools} 次工具`);
    }
  }
  // 优先带「汇总/报告」节点的正文：它本身就是上游证据的浓缩
  const report = rows.find((row) => String(row?.kind || '').toLowerCase() === 'report' || /汇总|报告/.test(String(row?.name || '')));
  const reportText = String(report?.content || '').trim();
  if (reportText) lines.push('', '【汇总报告正文（节选）】', reportText.slice(0, 6000));
  lines.push('', '请基于以上证据直接给出最终结论：总体判定、按严重度排列的问题（带 file:line）、没跑的关及原因；不要再调用任何工具。');
  return lines.join('\n');
}
