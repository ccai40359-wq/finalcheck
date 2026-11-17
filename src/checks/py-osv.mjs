// Python 依赖漏洞查询：OSV 批量接口（2026-11-17）。
//
// 为什么不用 pip-audit 查锁文件：
//   pip-audit 对 requirements 是**逐包**去 PyPI/OSV 查询 + 建临时 venv 解析依赖树。
//   实测 5 个包 56 秒、199 个包超过 10 分钟（必然超时）。而 uv.lock / poetry.lock 里
//   已经是**完整解析结果**，不需要再解析依赖树——真正需要的只是「这些 name@version 有没有已知漏洞」。
//
// OSV 的 /v1/querybatch 一次请求可以查几百个包：实测 201 个包 **1.9 秒**。
// 所以锁文件路线走 OSV 批量，requirements.txt 路线仍走 pip-audit（它要处理 `.`/-e 这类
// 非常规条目，只有 pip 能正确解析）。
//
// 设计约束：
//   · 不联网时**必须诚实失败**（返回 error，由调用方记 coverageGap），绝不返回「0 漏洞」
//   · 分批上限 500（OSV 文档建议 ≤1000，取保守值），超出的部分接着发下一批
//   · 只做只读 POST，不带任何凭据；OSV 是公开服务，不需要 key

const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_BATCH_CHUNK = 500;
const OSV_DETAIL_URL = 'https://api.osv.dev/v1/vulns/';

/**
 * 批量查询 PyPI 包漏洞。
 * @param {Array<{name:string, version:string}>} deps
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl] 注入口（测试用）
 * @param {number} [opts.timeoutMs=60000]
 * @returns {Promise<{ok:true, affected:Array<{name,version,ids:string[]}>, queried:number} | {ok:false, error:string}>}
 */
export async function queryOsvBatch(deps, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const list = (Array.isArray(deps) ? deps : []).filter((d) => d && d.name && d.version);
  if (!list.length) return { ok: false, error: '没有可查询的包（锁文件为空或未锁定版本）' };

  const affected = [];
  let queried = 0;
  try {
    for (let start = 0; start < list.length; start += OSV_BATCH_CHUNK) {
      const chunk = list.slice(start, start + OSV_BATCH_CHUNK);
      const queries = chunk.map((d) => ({ package: { name: String(d.name), ecosystem: 'PyPI' }, version: String(d.version) }));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(OSV_BATCH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ queries }),
          signal: ac.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return { ok: false, error: `OSV 批量查询失败（HTTP ${res.status}）` };
      const json = await res.json();
      // 形状校验：results 必须是与 queries 等长的数组，每项是对象（允许空对象 = 无漏洞）。
      // 为什么必须严格：OSV / 中间代理 / CDN 拦截都可能返回 2xx 但内容不是预期结构
      // （例如 {"error":"rate limited"}）。若此时回落到 [] 再按下标读 undefined，
      // 就会被当成「该包无漏洞」并继续计数 —— 正好是这类工具最致命的错方向。
      const results = json?.results;
      if (!Array.isArray(results) || results.length !== chunk.length) {
        const got = Array.isArray(results) ? `${results.length} 条` : '缺失/非数组';
        return { ok: false, error: `OSV 返回结构异常（本批 ${chunk.length} 个包，results ${got}）；不判为 0 漏洞` };
      }
      for (let k = 0; k < chunk.length; k++) {
        const r = results[k];
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
          return { ok: false, error: `OSV 返回结构异常（第 ${k + 1} 条 results 不是对象）；不判为 0 漏洞` };
        }
        const ids = (r.vulns || []).map((v) => String(v?.id || '')).filter(Boolean);
        if (ids.length) affected.push({ name: chunk[k].name, version: chunk[k].version, ids });
        queried++;
      }
    }
  } catch (e) {
    const msg = e?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : String(e?.message || e);
    return { ok: false, error: `OSV 查询异常：${msg}` };
  }
  return { ok: true, affected, queried };
}

/** 取单条 advisory 的摘要（失败返回空串，不阻断结论） */
export async function osvSummary(id, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${OSV_DETAIL_URL}${encodeURIComponent(String(id))}`, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return '';
    const j = await res.json();
    return String(j?.summary || j?.details || '').split('\n')[0].slice(0, 140);
  } catch { return ''; }
}
