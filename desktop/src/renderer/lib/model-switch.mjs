// 模型切换分隔线（round9，对齐 ZCode 的「Model switched A → B」提示）：
// 相邻两条 assistant 消息的 model 不同 → 中间插一条 notice 行，渲染成消息流里的分隔线。
// model 字符串约定："providerId/model"（ipc-agent 落库时拼好）。
// 纯函数：不改入参；model 缺失的旧历史消息不参与比较（不误报切换）。
//
// 位置规则（2026-11-16 用户反馈）：分隔线必须紧贴在「新模型的这一轮」之前。
// 早先的实现用 out.push 在遍历中插入，于是当两条 assistant 之间夹着 notice / 报错行时，
// 分隔线会落在这些行之后，视觉上像是「切换提示跟在错误后面」。
// 现在改成：先扫一遍找到每个需要断线的位置，再按位置插到**目标 assistant 之前**，
// 中间夹着的 notice/error 仍然留在线上方——因为它们属于上一轮，不属于新一轮。

export function withModelDividers(messages, labelOf = (from, to) => `⇄ 模型切换：${from} → ${to}`) {
  if (!Array.isArray(messages)) return messages;
  const out = [];
  let lastModel = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === 'assistant' && m.model) {
      const model = String(m.model);
      if (lastModel && model !== lastModel) {
        // 回看：如果紧邻前面已有同一条 model-switch 分隔线（消息被重建过一次），不重复插。
        const prev = out[out.length - 1];
        const alreadyDivided = prev && prev.kind === 'model-switch';
        if (!alreadyDivided) out.push({ role: 'notice', kind: 'model-switch', content: labelOf(lastModel, model) });
      }
      lastModel = model;
    }
    out.push(m);
  }
  return out;
}

/**
 * 判断某个 notice 行是不是「上一轮的尾巴」而不是「下一轮的开头」。
 * 用于给渲染层选锚点：报错/系统提示属于它上方那一轮，切换线应插在它下面；
 * 而用户新消息属于下一轮，切换线应插在它上面。
 */
export function isTrailingNotice(msg) {
  return !!msg && (msg.role === 'notice' || msg.role === 'error');
}
