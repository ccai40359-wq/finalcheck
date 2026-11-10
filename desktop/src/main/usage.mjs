// usage 归一化：OpenAI / DeepSeek / Anthropic 及各种中转网关的字段形状不同，
// 统一成 { prompt, completion, cached, cacheRead, raw }；缺字段保持 null（不冒充 0%）。
const toNum = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const firstNum = (...vals) => vals.find((v) => v != null) ?? null;

export function extractUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = toNum(raw.prompt_tokens ?? raw.input_tokens);
  const completion = toNum(raw.completion_tokens ?? raw.output_tokens);
  // 优先级：OpenAI 明细 → Anthropic 明细 → DeepSeek 命中 → Anthropic 顶层 → 通用顶层
  const cached = firstNum(
    toNum(raw.prompt_tokens_details?.cached_tokens),
    toNum(raw.input_tokens_details?.cached_tokens),
    toNum(raw.prompt_cache_hit_tokens),
    toNum(raw.cache_read_input_tokens),
    toNum(raw.cached_tokens),
    toNum(raw.cache_read_tokens)
  );
  const cacheRead = firstNum(toNum(raw.cache_read_input_tokens), toNum(raw.cache_read_tokens));
  if (prompt == null && completion == null && cached == null && cacheRead == null) return null;
  return { prompt, completion, cached, cacheRead, raw };
}

export function cacheHitOf(u) {
  return u?.prompt > 0 && u?.cached != null ? (u.cached / u.prompt) * 100 : null;
}
