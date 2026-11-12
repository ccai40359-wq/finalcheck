// 渗透探测：对用户自跑的本机应用做无认证复现 / CORS 反射 / 安全头检查（DESKTOP-ACCEPTANCE §4）
// 边界：只对主进程 assertAllowedTarget 放行的目标调用；单请求总预算 5s（含响应体）
//
// 自食教训（2026-11-08 真站自查）：
//   只看状态码会把典型 SPA 判成 7/7 复现——任何未知路径都回 200 + index.html。
//   现在必须看「返回的是什么」：HTML 外壳/与首页同体/200 但正文是未授权错误 → 都不算复现；
//   匿名可访问的数据/调试页只记线索，公开意图和敏感性仍需人工确认。
const TIMEOUT = 5000;
const MAX_BODY_BYTES = 8192; // 只读前 8KB：判定只需开头，不把大响应整个拉进内存
const SNIPPET_CHARS = 160;
const SECURITY_HEADERS = ['content-security-policy', 'x-frame-options', 'strict-transport-security', 'x-content-type-options'];
const COMMON_PATHS = ['/api/users', '/api/orders', '/api/admin', '/api/config', '/debug', '/actuator', '/api/me'];
// SPA 外壳特征：框架根节点，或构建产物入口脚本（Vite/Next/CRA 都长这样）
const SPA_SHELL_RE = /<div[^>]+id=["'](?:root|app|__next|__nuxt)["']|<script[^>]+src=["'][^"']*(?:\/assets\/|\/static\/|\/src\/|main\.[A-Za-z0-9_-]+\.js)/i;
const AUTH_ERROR_RE = /\b(?:unauthorized|forbidden|not\s+authori[sz]ed|access\s+denied|login\s+required|authentication\s+required)\b|未授权|请先登录|无权限/i;

// 封顶读取响应体：超上限/超时都保留已读部分（判定用开头，不需要全文）
async function readCapped(res, max = MAX_BODY_BYTES) {
  if (!res.body) return { text: '', bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (bytes < max) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        chunks.push(value);
        bytes += value.length;
      }
    }
  } catch {
    /* abort/网络中断：用已读到的部分继续判定 */
  } finally {
    try { await reader.cancel(); } catch { /* 流已结束 */ }
  }
  const buf = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, bytes - off);
    buf.set(c.subarray(0, take), off);
    off += take;
  }
  return { text: new TextDecoder().decode(buf), bytes, truncated: bytes >= max };
}

async function fetchPage(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT); // 总预算覆盖「拿响应头 + 读响应体」
  const started = performance.now();
  try {
    // 终审 P1#2：不跟随重定向——本机目标 302 跳外网 = 越出边界；3xx 只记录不跟进
    const r = await fetch(url, { ...opts, redirect: 'manual', signal: ctl.signal });
    const ttfbMs = performance.now() - started; // fetch resolve = 收到响应头 = 首字节
    const body = await readCapped(r);
    return {
      status: r.status,
      headers: r.headers,
      contentType: (r.headers.get('content-type') || '').toLowerCase(),
      location: r.headers.get('location'),
      body: body.text,
      bodyBytes: body.bytes,
      bodyTruncated: body.truncated,
      ttfbMs,
      totalMs: performance.now() - started,
    };
  } finally {
    clearTimeout(t);
  }
}

function looksJson(r) {
  if (r.contentType.includes('json')) return true;
  return /^\s*[[{]/.test(r.body);
}

// 与首页同体 = 最强证据；否则看框架外壳特征。真调试页（H2 console/stack trace）没有这些特征，仍会算复现。
function isSpaShell(r, homeBody) {
  const html = r.contentType.includes('html') || /<(!doctype\s+html|html[\s>])/i.test(r.body);
  if (!html) return false;
  if (homeBody && r.body.trim() === homeBody.trim()) return true;
  return SPA_SHELL_RE.test(r.body);
}

function classify(r, homeBody) {
  if (r.status !== null && (r.status < 200 || r.status >= 300)) {
    const why = r.status === 401 || r.status === 403 ? '需要认证' : '非 2xx';
    return { reproduced: false, note: `${r.status} ${why}${r.location ? ' → ' + r.location : ''}` };
  }
  if (!r.body.trim()) return { reproduced: false, note: `${r.status} 空响应体（无法确认返回了数据）` };
  if (isSpaShell(r, homeBody)) return { reproduced: false, note: '返回 HTML 外壳（疑似 SPA 兜底页），不是接口数据' };
  if (looksJson(r) && AUTH_ERROR_RE.test(r.body)) return { reproduced: false, note: '返回 200 但正文是未授权错误' };
  if (looksJson(r)) {
    try {
      const value = JSON.parse(r.body);
      const errorCode = Number(value?.code ?? value?.status ?? value?.statusCode);
      if (errorCode >= 400 || value?.success === false || value?.ok === false || value?.error || /not[ -]?found|no such|不存在|未找到/i.test(String(value?.message || value?.msg || ''))) {
        return { reproduced: false, note: '返回业务错误，未证实数据泄漏' };
      }
    } catch { return { reproduced: false, note: '响应正文无法解析，未证实数据泄漏' }; }
  }
  return { reproduced: false, accessible: true, note: `匿名可访问，需确认是否应公开及是否含敏感数据${r.bodyTruncated ? '（正文已按 8KB 截断）' : ''}` };
}

// 最近秩次百分位：p50 ≤ p95 恒成立；空样本返回 null（调用方决定怎么展示）
export function percentile(sortedAsc, p) {
  const arr = Array.isArray(sortedAsc) ? sortedAsc : [];
  if (!arr.length) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[idx];
}

const oneDecimal = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

export function latencyStats(samples = []) {
  const rows = (Array.isArray(samples) ? samples : [])
    .map((s) => ({ totalMs: Number(s?.totalMs), ttfbMs: Number(s?.ttfbMs) }))
    .filter((s) => Number.isFinite(s.totalMs) && s.totalMs >= 0);
  if (!rows.length) return null; // 没有样本：不编数字
  const totals = rows.map((s) => s.totalMs).sort((a, b) => a - b);
  return {
    p50: oneDecimal(percentile(totals, 50)),
    p95: oneDecimal(percentile(totals, 95)),
    min: oneDecimal(totals[0]),
    max: oneDecimal(totals[totals.length - 1]),
    firstByteMs: oneDecimal(rows.find((s) => Number.isFinite(s.ttfbMs) && s.ttfbMs >= 0)?.ttfbMs)
  };
}

function clampRequests(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 10;
  return Math.min(20, Math.max(3, Math.trunc(n)));
}

export async function probeTarget(baseUrl, { requests = 10 } = {}) {
  const base = baseUrl.replace(/\/+$/, '');
  const sampleCount = clampRequests(requests);
  // 先取首页正文当 SPA 兜底的比对基线（失败不影响后续探测）
  let homeBody = '';
  try {
    const home = await fetchPage(base + '/');
    homeBody = home.body;
    void home;
  } catch { /* 首页不可达：SPA 判定退化为只看外壳特征 */ }

  const results = [];
  for (const p of COMMON_PATHS) {
    try {
      const r = await fetchPage(base + p);
      const verdict = classify(r, homeBody);
      results.push({
        kind: 'unauth-access',
        path: p,
        status: r.status,
        contentType: r.contentType,
        reproduced: verdict.reproduced,
        accessible: Boolean(verdict.accessible),
        note: verdict.note,
        bodySnippet: r.body.slice(0, SNIPPET_CHARS),
        bodyTruncated: r.bodyTruncated,
      });
    } catch (e) {
      results.push({ kind: 'unauth-access', path: p, status: null, contentType: '', reproduced: false, note: 'unreachable: ' + e.message, bodySnippet: 'unreachable: ' + e.message });
    }
  }
  try {
    const r = await fetchPage(base + '/', { headers: { Origin: 'https://probe.example' } });
    const acao = r.headers.get('access-control-allow-origin');
    results.push({ kind: 'cors', reflected: acao === '*' || acao === 'https://probe.example', allowOrigin: acao });
  } catch (e) { results.push({ kind: 'cors', reflected: false, error: e.message }); }
  // 延迟百分位：顺序采样 base/（默认 10 次，3–20 次封顶），顺带复用首个成功响应的安全头；
  // 部分失败只用成功样本计算，全部失败 → latency=null（绝不编数字）
  const samples = [];
  let headerSample = null;
  let headerError = null;
  for (let i = 0; i < sampleCount; i++) {
    try {
      const r = await fetchPage(base + '/');
      if (r.status >= 200 && r.status < 400) samples.push({ totalMs: r.totalMs, ttfbMs: r.ttfbMs });
      if (!headerSample) headerSample = r;
    } catch (e) {
      headerError = e;
    }
  }
  if (headerSample) {
    results.push({ kind: 'security-headers', missing: SECURITY_HEADERS.filter((h) => !headerSample.headers.has(h)) });
  } else {
    results.push({ kind: 'security-headers', missing: [], error: headerError?.message || 'unreachable' });
  }
  return { target: base, results, samples: samples.length, latency: latencyStats(samples) };
}
