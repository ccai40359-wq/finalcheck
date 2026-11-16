// 正文交付物卡（报告 / 探测表 / 压测统计）的折叠规则。
// 抽成纯函数便于单测（不依赖 React）。
//
// 背景（2026-11-15 用户实测会话 9adde9d2）：模型把 probe_target 当成「服务还活着吗」的
// 心跳探针，夹在每次改文件之后重跑一遍——同一个 URL 在一个回合里被探测 7 次，正文区铺出
// 9 张渗透探测大表，用户实测「像是报告一样的重复发了好多好多次」。
// 循环守卫（agent-service.mjs 的 toolCallSig）拦不住：它只认「连续 N 轮完全相同」，
// 而这些调用被别的工具隔开，签名每轮都变。
//
// 关键设计（用真实数据验证过才敢定）：
//   key 必须按「卡片真正显示的内容」算，不能按整个 result blob 算。
//   实测里同一次 404 探测的 result 里 latency.p50 会在 2.9 / 2.2 / 2.3 之间抖动，
//   而界面根本不显示 latency——按整 blob 比对会让这些肉眼完全相同的表各占一张卡。
//   反过来，status 从 404 变成 null（服务被改后重启）时，表格内容真的变了，
//   这种必须各留一张，否则会把「404 → 服务正常」这条真实状态变化吞掉。

/** 参与折叠的工具（ask_user 不参与：每个问答是一次独立交互，合并会丢内容）。 */
export const COLLAPSIBLE_TOOLS = new Set(['probe_target', 'stress_target', 'audit_project', 'get_report']);

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
};

/** 参数规范化：能当 JSON 解析就按键排序后重排，否则退回原文字符串。 */
export function canonCardArgs(args) {
  if (args == null) return '';
  const raw = typeof args === 'string' ? args : (() => { try { return JSON.stringify(args); } catch { return String(args); } })();
  try {
    return JSON.stringify(sortKeys(JSON.parse(raw)));
  } catch {
    return String(raw);
  }
}

const asObject = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** probe_target 卡片实际显示的字段：路径 / 状态码 / 复现 三列 + CORS/安全头两行。
 *  latency、samples 这类跑一次抖一次的测量值不参与比对（界面不显示它们）。 */
function probeVisibleShape(result) {
  const r = asObject(result);
  if (!r) return null;
  const rows = (Array.isArray(r.results) ? r.results : [])
    .filter((x) => x && x.kind === 'unauth-access')
    .map((x) => [x.path, x.status, x.reproduced, x.accessible, x.note]);
  const cors = (Array.isArray(r.results) ? r.results : []).find((x) => x && x.kind === 'cors');
  const headers = (Array.isArray(r.results) ? r.results : []).find((x) => x && x.kind === 'security-headers');
  return {
    target: r.target || null,
    rows,
    cors: cors ? [cors.reflected, cors.allowOrigin || null, cors.error ? 'err' : null] : null,
    headers: headers ? [Array.isArray(headers.missing) ? headers.missing : [], headers.error ? 'err' : null] : null,
  };
}

/** stress_target 卡片实际显示的字段：RPS / p97.5 延迟 / 错误数 / 吞吐 + 状态码分布。 */
function stressVisibleShape(result) {
  const r = asObject(result);
  if (!r) return null;
  return {
    url: r.url || null,
    rpsAvg: r.rpsAvg ?? null,
    latency: r.p97_5LatencyMs ?? r.p95LatencyMs ?? null,
    errors: r.errors ?? null,
    throughput: r.throughputAvgBytes != null ? Number(r.throughputAvgBytes) : null,
    statusCodes: sortKeys(r.statusCodes || null),
  };
}

/** 卡片可见内容的签名：只取界面上真会画出来的字段。 */
export function cardVisibleSignature(tool, args, result) {
  if (tool === 'probe_target') {
    const shape = probeVisibleShape(result);
    // 结果不可解析时退回整 blob（保守：宁可多留一张，也不误合并）
    return shape ? JSON.stringify(sortKeys(shape)) : `raw:${canonCardArgs(result)}`;
  }
  if (tool === 'stress_target') {
    const shape = stressVisibleShape(result);
    return shape ? JSON.stringify(sortKeys(shape)) : `raw:${canonCardArgs(result)}`;
  }
  // 报告类：结果文本本身就是卡片主体，直接比原文
  return canonCardArgs(result);
}

/**
 * 把白名单工具的结果条目折叠成「每张可见内容相同的卡只留一张」。
 * 输入顺序保留第一次出现的位置；重复项只累加 count。
 * @param {Array<{tool?:string, args?:any, result?:any}>} entries
 * @returns {Array<{entry:object, count:number}>}
 */
export function collapseResultCards(entries, { collapsible = COLLAPSIBLE_TOOLS } = {}) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const out = [];
  const seen = new Map();
  for (const entry of entries) {
    if (!entry) continue;
    if (!collapsible.has(entry.tool)) {
      out.push({ entry, count: 1 });
      continue;
    }
    const key = `${entry.tool}\u0000${canonCardArgs(entry.args)}\u0000${cardVisibleSignature(entry.tool, entry.args, entry.result)}`;
    const hit = seen.get(key);
    if (hit) {
      hit.count += 1;
      continue;
    }
    const slot = { entry, count: 1 };
    seen.set(key, slot);
    out.push(slot);
  }
  return out;
}
