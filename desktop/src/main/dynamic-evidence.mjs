// 本轮动态实测记账（probe / stress）——只存在内存里，不进磁盘、不外传。
// 用途：证据等级判定（src/profile.mjs 的 evidenceMatrix）必须区分「用户声明了授权」和
// 「本轮真的跑过」。声明只能给 static-only；有实测记录才能升 full。
// 记账不拦截任何调用（授权语义仍是「给出目标即授权」），只是留证据。

const MAX_RECORDS = 200;
const records = [];

/** @param {'probe'|'stress'} kind */
function push(kind, url, rec) {
  let host = '';
  try { host = new URL(String(url || '')).hostname.toLowerCase(); } catch { host = ''; }
  records.push({ kind, url: String(url || ''), host, at: Date.now(), ...rec });
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

export function recordProbe(url, { ms = 0, ok = true, samples = 0 } = {}) {
  push('probe', url, { ms: Math.max(0, Number(ms) || 0), ok: !!ok, samples: Math.max(0, Number(samples) || 0) });
}

export function recordStress(url, { ms = 0, ok = true, samples = 0 } = {}) {
  push('stress', url, { ms: Math.max(0, Number(ms) || 0), ok: !!ok, samples: Math.max(0, Number(samples) || 0) });
}

/**
 * 取本轮实测记录（调用方可限定时间窗与 URL host）。
 * @param {{sinceMs?:number, url?:string|null, kind?:'probe'|'stress'|null}} [opts]
 * @returns {Array<object>}
 */
export function getDynamicEvidence({ sinceMs = 0, url = null, kind = null } = {}) {
  let host = null;
  if (url) { try { host = new URL(String(url)).hostname.toLowerCase(); } catch { host = null; } }
  return records.filter((r) => r.at >= sinceMs
    && (!kind || r.kind === kind)
    && (!host || r.host === host));
}

/** 聚合成 profile.mjs 认的形状：{probe:[…], stress:[…]}。 */
export function dynamicRuntime(opts = {}) {
  const rows = getDynamicEvidence(opts);
  return {
    probe: rows.filter((r) => r.kind === 'probe').map(({ ms, samples, at }) => ({ ms, samples, at })),
    stress: rows.filter((r) => r.kind === 'stress').map(({ ms, samples, at }) => ({ ms, samples, at })),
  };
}

export function resetDynamicEvidence() {
  records.length = 0;
}
