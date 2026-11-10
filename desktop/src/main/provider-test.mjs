// 供应商连通性测试（从 index.mjs 抽出：可单测）
// 成功判据 = 真的问一句 hi 并收到模型回复；只列 /models 不算连通。
// （用户定案 2026-11-08：模型列表能拉 ≠ 能对话，测试必须以「有回复」为准。）
const MODELS_TIMEOUT = 10000;
const CHAT_TIMEOUT = 30000;
const PING_MESSAGES = [{ role: 'user', content: 'hi' }];
// max_tokens 必须留够：16 时真网关会先把预算烧在推理上、choices[0].message 直接为 null（实测 2026-11-08）
const PING_MAX_TOKENS = 64;

const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '');
const isTimeout = (e) => e && (e.name === 'AbortError' || e.name === 'TimeoutError' || /abort|timeout/i.test(e.message || ''));

async function request(fetchImpl, url, opts, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...opts, signal: ctl.signal });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { res, json, text };
  } finally { clearTimeout(timer); }
}

function parseModels(json) {
  if (Array.isArray(json?.data)) return json.data.map((m) => m?.id).filter(Boolean);
  if (Array.isArray(json?.models)) return json.models.map((m) => m?.id || m?.name).filter(Boolean);
  return [];
}

export async function testProviderConnection({ baseUrl, apiKey, model, fetchImpl = fetch } = {}) {
  const base = trimBase(baseUrl);
  if (!base) return { ok: false, reason: 'Base URL 未填写', hint: '请填写网关地址，通常以 https:// 开头、/v1 结尾' };
  let u;
  try { u = new URL(base); } catch {
    return { ok: false, reason: 'Base URL 不是合法 URL', hint: '请检查是否漏了 https:// 前缀，例如 https://api.example.com/v1' };
  }
  if (!/^https?:$/.test(u.protocol)) {
    return { ok: false, reason: `不支持的协议：${u.protocol.replace(':', '')}`, hint: '请使用 https:// 开头的地址' };
  }
  const key = String(apiKey || '');
  const headers = key ? { authorization: 'Bearer ' + key } : {};

  // 1) /models：只用来给界面补模型清单；404/非 JSON 不算失败（有些网关不实现）
  let models = [];
  let modelsError = null;
  try {
    const r = await request(fetchImpl, base + '/models', { headers }, MODELS_TIMEOUT);
    if (r.res.status === 401 || r.res.status === 403) {
      return { ok: false, reason: `认证失败（HTTP ${r.res.status}）`, hint: 'API Key 无效或无权限，请核对后重新填写' };
    }
    if (r.res.ok) models = parseModels(r.json);
    else modelsError = `HTTP ${r.res.status}`;
  } catch (e) {
    modelsError = isTimeout(e) ? '超时' : (e.message || '网络错误');
  }

  // 2) 真问一句 hi：有 choices[0].message 内容才算连通
  const useModel = String(model || '').trim() || models[0] || '';
  if (!useModel) {
    return {
      ok: false,
      reason: '没有可用模型，无法发测试消息',
      hint: modelsError
        ? `模型列表拉取失败（${modelsError}），且没有手动填写的模型名：请先在模型列表里添加一个模型名称（如 deepseek-v4.1-flash）`
        : '请先在模型列表里添加一个模型名称（如 deepseek-v4.1-flash），再点测试连接',
      count: models.length,
      models: models.slice(0, 20),
    };
  }
  let r;
  try {
    r = await request(fetchImpl, base + '/chat/completions', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: useModel, messages: PING_MESSAGES, max_tokens: PING_MAX_TOKENS, temperature: 0, stream: false }),
    }, CHAT_TIMEOUT);
  } catch (e) {
    return isTimeout(e)
      ? { ok: false, model: useModel, reason: '对话请求超时（30s）', hint: `模型 ${useModel} 没有在 30 秒内回应：检查网络/代理，或换一个更快的模型`, count: models.length, models: models.slice(0, 20) }
      : { ok: false, model: useModel, reason: '网络错误：' + (e.message || 'fetch failed'), hint: '请检查 Base URL 是否含 https:// 前缀与 /v1 结尾，以及本机代理是否可达', count: models.length, models: models.slice(0, 20) };
  }

  const apiErr = String(r.json?.error?.message || r.json?.message || r.text || '').slice(0, 200);
  if (r.res.status === 401 || r.res.status === 403) {
    return { ok: false, model: useModel, reason: `对话接口认证失败（HTTP ${r.res.status}）`, hint: apiErr || 'API Key 无效或无权限', count: models.length, models: models.slice(0, 20) };
  }
  if (!r.res.ok) {
    return {
      ok: false,
      model: useModel,
      reason: `对话接口返回 HTTP ${r.res.status}`,
      hint: apiErr || (r.res.status === 404 ? '未找到 /chat/completions：请确认 Base URL 以 /v1 结尾' : '服务端拒绝，请检查 Base URL / 模型名是否正确'),
      count: models.length,
      models: models.slice(0, 20),
    };
  }

  const msg = r.json?.choices?.[0]?.message;
  const reply = String(msg?.content || msg?.reasoning_content || msg?.reasoning || '').trim();
  if (!reply) {
    return {
      ok: false,
      model: useModel,
      reason: '网关回应了，但模型没有返回内容',
      hint: `模型 ${useModel} 的 choices[0].message 为空：可能模型名不对、额度用尽或被网关拦截`,
      count: models.length,
      models: models.slice(0, 20),
    };
  }
  return { ok: true, reply: reply.slice(0, 160), model: useModel, count: models.length, models: models.slice(0, 20) };
}
