// 本轮动态实测记账（probe / stress）——只存在内存里，不进磁盘、不外传。
// 用途：证据等级判定（src/profile.mjs 的 evidenceMatrix）必须区分「用户声明了授权」和
// 「本轮真的跑过」。声明只能给 static-only；有实测记录才能升 full。
// 记账不拦截任何调用（授权语义仍是「给出目标即授权」），只是留证据。

import path from 'node:path';

const MAX_RECORDS = 200;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const records = [];
const scopeOf = ({ sessionId = null, projectPath = null } = {}) => JSON.stringify([sessionId, projectPath ? path.resolve(projectPath) : null]);
const targetOf = (url) => {
  try {
    const u = new URL(String(url));
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.origin + (u.pathname.replace(/\/+$/, '') || '/') + u.search;
  } catch { return null; }
};

/** @param {'probe'|'stress'} kind */
function push(kind, url, rec) {
  const target = targetOf(url);
  if (!target) return;
  records.push({ ...rec, kind, url: String(url), target, scope: scopeOf(rec), at: Date.now() });
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

export function recordProbe(url, { ms = 0, ok = true, samples = 0, sessionId = null, projectPath = null } = {}) {
  push('probe', url, { ms: Math.max(0, Number(ms) || 0), ok: ok === true, samples: Number.isFinite(Number(samples)) ? Math.max(0, Number(samples)) : 0, sessionId, projectPath });
}

export function recordStress(url, { ms = 0, ok = true, samples = 0, sessionId = null, projectPath = null } = {}) {
  push('stress', url, { ms: Math.max(0, Number(ms) || 0), ok: ok === true, samples: Number.isFinite(Number(samples)) ? Math.max(0, Number(samples)) : 0, sessionId, projectPath });
}

/**
 * 取本轮实测记录（调用方可限定时间窗与 URL host）。
 * @param {{sinceMs?:number, url?:string|null, kind?:'probe'|'stress'|null}} [opts]
 * @returns {Array<object>}
 */
export function getDynamicEvidence({ sinceMs = 0, url = null, kind = null, sessionId = null, projectPath = null } = {}) {
  const target = url ? targetOf(url) : null;
  if (url && !target) return [];
  const scope = scopeOf({ sessionId, projectPath });
  const since = Math.max(Number(sinceMs) || 0, Date.now() - MAX_AGE_MS);
  return records.filter((r) => r.at >= since && r.scope === scope
    && (!kind || r.kind === kind)
    && (!target || r.target === target)).map((r) => ({ ...r }));
}

/** 聚合成 profile.mjs 认的形状：{probe:[…], stress:[…]}。 */
export function dynamicRuntime(opts = {}) {
  if (!opts.url) return { probe: [], stress: [] };
  const rows = getDynamicEvidence(opts).filter((r) => r.ok && r.samples > 0);
  return {
    probe: rows.filter((r) => r.kind === 'probe'),
    stress: rows.filter((r) => r.kind === 'stress'),
  };
}

export function resetDynamicEvidence() {
  records.length = 0;
}
