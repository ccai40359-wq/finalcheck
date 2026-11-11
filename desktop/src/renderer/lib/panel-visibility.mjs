// 右侧子代理面板（SubagentPanel）的可见性判定。
// 真实 bug：在对话里点开某个子代理后进「设置/用量」页，面板还挂在右边；返回对话时又自动弹回来。
// 规则：面板只属于「它绑定的那次对话」——非聊天视图或换了会话都必须卸载。
// 抽成纯函数便于单测（App.jsx 的渲染条件与清理 effect 共用同一份判定）。
export function shouldShowStepPanel({ view, stepView, activeSessionId = null } = {}) {
  if (!stepView || typeof stepView !== 'object') return false;
  if (view !== 'chat') return false;
  // 草稿（没有会话 id）上的面板不受会话比对影响；有 id 时必须是当前会话
  if (stepView.sessionId == null) return true;
  return stepView.sessionId === activeSessionId;
}
