// 切回一个「后台还在跑」的会话时，把内存里的实时回合叠回磁盘历史。
// 这里单独抽出来是因为之前踩过一个真 bug：只恢复了 content/events，没恢复 workflow 快照，
// 结果用户切走再切回来，正在跑的工作流卡片整块消失（工作流其实还在跑）。
export function mergeRunningRun(loaded, run, { stopped = false, now = Date.now() } = {}) {
  const messages = Array.isArray(loaded) ? loaded.slice() : [];
  if (!run || typeof run !== 'object') return { messages, appended: false };
  const userMessage = typeof run.userMessage === 'string' && run.userMessage ? run.userMessage : null;
  const hasUser = userMessage != null
    && messages.some((m) => m?.role === 'user' && String(m.content ?? '') === userMessage);
  // 用户消息已即时落盘；万一读到的还是旧盘（落盘竞态），用内存里的补上，防止「消息不见了」。
  // 去重不能只看最后一条：回合进行中磁盘末尾是 pending assistant，用户消息在它前面。
  if (userMessage != null && !hasUser) messages.push({ role: 'user', content: run.userMessage });
  const workflow = run.workflow && typeof run.workflow === 'object'
    ? { ...run.workflow, updatedAt: now }
    : null;
  const liveAssistant = {
    role: 'assistant',
    content: run.content || '',
    ...(stopped ? { streaming: false, interrupted: true } : { streaming: true }),
    events: run.events || [],
    startedAt: run.startedAt,
    trace: [],
    // 关键：把工作流实时快照一起恢复，卡片才不会在切会话后消失
    ...(workflow ? { workflow } : {}),
    ...(run.workflowStarting ? { workflowStarting: true } : {})
  };
  // 磁盘末尾若已是本回合的 pending assistant（loadSession 会把它标成 interrupted），
  // 原位替换成实时副本，不再 push 一条，否则同一条回复会显示两份（且误标「已停止」）。
  // 真正的崩溃不会走到这里：那时 runsRef/inflight 里没有这个会话，run 为 null。
  const last = messages[messages.length - 1];
  let lastUserIndex = -1;
  for (let i = messages.length - 2; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') { lastUserIndex = i; break; }
  }
  const isPendingTail = userMessage != null
    && last?.role === 'assistant'
    && (last.interrupted === true || last.streaming === true)
    && lastUserIndex >= 0
    && String(messages[lastUserIndex].content ?? '') === userMessage;
  if (isPendingTail) {
    // 保留磁盘里已落盘的本回合 trace（已完成的 ask 卡等），实时流负责刷新 content/events
    messages[messages.length - 1] = {
      ...liveAssistant,
      content: run.content || last.content || '',
      trace: Array.isArray(last.trace) ? last.trace : []
    };
  } else {
    messages.push(liveAssistant);
  }
  return { messages, appended: true };
}

/**
 * openSession 是否还应该从磁盘重建消息。
 * 同一条会话已经激活、且本进程还在跑这一回合时，磁盘里的 pending 副本会和内存实时副本
 * 同时进入 messages（用户/助手各出现两份）；这时直接跳过重建。
 * @param {{activeId?: string|null, sessionId?: string|null, liveRun?: boolean, inflight?: boolean}} [state]
 * @returns {boolean} true = 从磁盘读；false = 短路
 */
export function shouldReloadSessionFromDisk({ activeId = null, sessionId = null, liveRun = false, inflight = false } = {}) {
  if (sessionId == null || sessionId === '') return false;
  const same = activeId != null && String(activeId) === String(sessionId);
  return !(same && (liveRun || inflight));
}
