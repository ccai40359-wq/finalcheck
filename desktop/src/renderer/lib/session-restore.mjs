// 切回一个「后台还在跑」的会话时，把内存里的实时回合叠回磁盘历史。
// 这里单独抽出来是因为之前踩过一个真 bug：只恢复了 content/events，没恢复 workflow 快照，
// 结果用户切走再切回来，正在跑的工作流卡片整块消失（工作流其实还在跑）。
export function mergeRunningRun(loaded, run, { stopped = false, now = Date.now() } = {}) {
  const messages = Array.isArray(loaded) ? loaded.slice() : [];
  if (!run || typeof run !== 'object') return { messages, appended: false };
  const last = messages[messages.length - 1];
  // 用户消息已即时落盘；万一读到的还是旧盘（落盘竞态），用内存里的补上，防止「消息不见了」
  if (run.userMessage && !(last?.role === 'user' && last.content === run.userMessage)) {
    messages.push({ role: 'user', content: run.userMessage });
  }
  const workflow = run.workflow && typeof run.workflow === 'object'
    ? { ...run.workflow, updatedAt: now }
    : null;
  messages.push({
    role: 'assistant',
    content: run.content || '',
    ...(stopped ? { streaming: false, interrupted: true } : { streaming: true }),
    events: run.events || [],
    startedAt: run.startedAt,
    trace: [],
    // 关键：把工作流实时快照一起恢复，卡片才不会在切会话后消失
    ...(workflow ? { workflow } : {}),
    ...(run.workflowStarting ? { workflowStarting: true } : {})
  });
  return { messages, appended: true };
}
