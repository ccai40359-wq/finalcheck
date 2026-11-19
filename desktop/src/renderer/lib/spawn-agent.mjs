// 轻量子代理（spawn_agent，0.26）：主进程与界面共用的小工具。
// 子代理 id 由工具调用 id 推出来（两边各算一次也对得上），右侧子代理面板按它取过程记录。
export function spawnAgentStepId(callId, fallback = 1) {
  const s = String(callId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(-20);
  return `agent-${s || fallback}`;
}

/** 界面里「打开子代理过程」：用窗口事件通知 App（时间线组件不必层层透传回调） */
export const OPEN_STEP_EVENT = 'fc-open-step';
export function requestOpenStep(step) {
  try { window.dispatchEvent(new CustomEvent(OPEN_STEP_EVENT, { detail: step })); } catch { /* 非浏览器环境忽略 */ }
}
