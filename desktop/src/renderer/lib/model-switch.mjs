// 模型切换分隔线（round9，对齐 ZCode 的「Model switched A → B」提示）：
// 相邻两条 assistant 消息的 model 不同 → 中间插一条 notice 行，渲染成消息流里的分隔线。
// model 字符串约定："providerId/model"（ipc-agent 落库时拼好）。
// 纯函数：不改入参；model 缺失的旧历史消息不参与比较（不误报切换）。
export function withModelDividers(messages, labelOf = (from, to) => `⇄ 模型切换：${from} → ${to}`) {
  if (!Array.isArray(messages)) return messages;
  const out = [];
  let lastModel = null;
  for (const m of messages) {
    if (m && m.role === 'assistant' && m.model) {
      const model = String(m.model);
      if (lastModel && model !== lastModel) out.push({ role: 'notice', kind: 'model-switch', content: labelOf(lastModel, model) });
      lastModel = model;
    }
    out.push(m);
  }
  return out;
}
