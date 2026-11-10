// 每模型上下文窗口 / 输出预算解析（纯函数，供 index / agent-service / 测试共用）。
// provider.models 兼容两种形状：
//   - 旧形状：string[]（窗口/输出按 provider.contextWindow / provider.maxOutputTokens 解释）
//   - 新形状：混合 (string | { id, contextWindow?, maxOutputTokens?, vision? })[]
// 这里只做读路径归一化；不做写入迁移（UI 保存配置时再转成对象）。

export const DEFAULT_CONTEXT_WINDOW = 1000000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 32000;

const positiveInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

// 单条模型配置 → { id, contextWindow, maxOutputTokens, vision, legacy }
// 字符串：id 取字符串本身，窗口/输出回落 provider；legacy=true
// 对象：缺字段同样回落 provider；非法值（0/负数/非数字）视为缺字段
export function normalizeModelEntry(entry, provider) {
  const p = provider && typeof provider === 'object' ? provider : {};
  const providerWindow = positiveInt(p.contextWindow);
  const providerMaxOutput = positiveInt(p.maxOutputTokens);
  const providerVision = p.vision === true;

  if (typeof entry === 'string') {
    return {
      id: entry.trim(),
      contextWindow: providerWindow ?? undefined,
      maxOutputTokens: providerMaxOutput ?? undefined,
      vision: providerVision,
      legacy: true
    };
  }

  const o = entry && typeof entry === 'object' ? entry : {};
  return {
    id: typeof o.id === 'string' ? o.id.trim() : '',
    contextWindow: positiveInt(o.contextWindow) ?? providerWindow ?? undefined,
    maxOutputTokens: positiveInt(o.maxOutputTokens) ?? providerMaxOutput ?? undefined,
    vision: typeof o.vision === 'boolean' ? o.vision : providerVision,
    legacy: false
  };
}

// 在 provider.models 中找 modelId；没找到（或 modelId 为空）回退第一个可用模型。
// models 为空 / 全部非法时返回 null（调用方自行回落默认窗口）。
export function resolveModel(provider, modelId) {
  const entries = Array.isArray(provider?.models) ? provider.models : [];
  if (!entries.length) return null;
  const wanted = typeof modelId === 'string' ? modelId.trim() : '';
  const normalized = entries
    .map((e) => normalizeModelEntry(e, provider))
    .filter((m) => m.id);
  if (!normalized.length) return null;
  if (wanted) {
    const hit = normalized.find((m) => m.id === wanted);
    if (hit) return hit;
  }
  return normalized[0];
}

// 有效窗口：model.contextWindow > provider.contextWindow > 1M
export function effectiveWindow(modelEntry, provider) {
  return positiveInt(modelEntry?.contextWindow)
    ?? positiveInt(provider?.contextWindow)
    ?? DEFAULT_CONTEXT_WINDOW;
}

// 有效输出预留：model.maxOutputTokens > provider.maxOutputTokens > 32k
export function effectiveMaxOutputTokens(modelEntry, provider) {
  return positiveInt(modelEntry?.maxOutputTokens)
    ?? positiveInt(provider?.maxOutputTokens)
    ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

// 跨轮历史预算（token 口径）：
//   min(max(0.6 * (window - min(maxOutput, 21000)), 30000), 400000)
// 1M 窗口 ≈ 400k token 上限；200k 窗口 ≈ 107k；再小的窗口兜底 30k。
export function crossTurnBudgetTokens(window, maxOutput) {
  const w = positiveInt(window) ?? DEFAULT_CONTEXT_WINDOW;
  const outRaw = Number(maxOutput);
  const out = Number.isFinite(outRaw) && outRaw >= 0 ? Math.trunc(outRaw) : DEFAULT_MAX_OUTPUT_TOKENS;
  const raw = Math.floor(0.6 * (w - Math.min(out, 21000)));
  return Math.trunc(Math.min(Math.max(raw, 30000), 400000));
}
