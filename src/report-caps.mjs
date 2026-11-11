// 报告条数上限（reportCaps）：只影响「报告里列几条」，不改任何规则判定。
//
// 默认全部不截断（Infinity）：结论里的条数就是检查真实命中的条数。
// 需要压报告长度时，在 finalcheck.config.json 顶层显式配置，例如：
//   { "reportCaps": { "Q4.perRule": 20, "Q3.largeFile": 20, "Q5.perRule": 20 } }
// 非法值（负数、字符串、0 等）一律回落到不截断，并写 warning，绝不静默吞条目。
//
// 解析集中在这一个纯函数里；检查从 audit() 收 caps，不各自读配置文件。

export const REPORT_CAP_KEYS = Object.freeze({
  'Q3.largeFile': 'Q3 超大文件最多报告几条',
  'Q3.unusedExport': 'Q3 未使用导出最多报告几条',
  'Q3.duplicateBlock': 'Q3 重复代码块最多报告几条',
  'Q4.perRule': 'Q4 同一规则全局最多报告几条',
  'Q4.perFile': 'Q4 单文件单规则最多报告几条',
  'Q5.perRule': 'Q5 同一规则全局最多报告几条',
});

export const DEFAULT_REPORT_CAPS = Object.freeze({
  'Q3.largeFile': Infinity,
  'Q3.unusedExport': Infinity,
  'Q3.duplicateBlock': Infinity,
  'Q4.perRule': Infinity,
  'Q4.perFile': Infinity,
  'Q5.perRule': Infinity,
});

// 「命中过多，可能含噪声」的提示阈值：默认不截断，但仍保留提示能力（只提示，不吞条目）。
// 取上一轮硬上限的原值，避免提示口径突然放宽。
export const DEFAULT_NOISE_HINTS = Object.freeze({
  'Q3.largeFile': 10,
  'Q3.unusedExport': 10,
  'Q3.duplicateBlock': 5,
  'Q4.perRule': 5,
  'Q4.perFile': 10,
  'Q5.perRule': 10,
});

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function normalizeCap(key, value, warnings) {
  // Infinity 只能由代码直接构造（JSON 里写不出来）；显式给 Infinity 视为不截断
  if (typeof value === 'number' && value === Infinity) return Infinity;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    warnings.push(`报告上限：reportCaps["${key}"] 的值 ${String(value)} 无效（需正整数），已按不截断处理`);
    return Infinity;
  }
  return Math.floor(value);
}

/**
 * 解析 finalcheck.config.json 顶层的 reportCaps 段。
 * 纯函数：不读文件、不修改入参；所有问题通过返回的 warnings 暴露。
 *
 * @param {object|null|undefined} cfg 已解析的配置对象
 * @param {{noCaps?:boolean}} [options] noCaps=true 时忽略配置，全部不截断（命令行 --no-caps）
 * @returns {{caps:Record<string,number>, warnings:string[]}}
 */
export function resolveReportCaps(cfg, { noCaps = false } = {}) {
  const caps = { ...DEFAULT_REPORT_CAPS };
  const warnings = [];
  if (noCaps) {
    if (cfg && typeof cfg === 'object' && hasOwn(cfg, 'reportCaps')) {
      warnings.push('报告上限：命令行 --no-caps 已忽略 finalcheck.config.json 的 reportCaps（本轮不截断）');
    }
    return { caps, warnings };
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { caps, warnings };
  if (!hasOwn(cfg, 'reportCaps') || cfg.reportCaps === undefined) return { caps, warnings };
  const raw = cfg.reportCaps;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('报告上限：finalcheck.config.json 的 reportCaps 必须是对象，已按不截断处理');
    return { caps, warnings };
  }
  for (const key of Object.keys(raw)) {
    if (!hasOwn(DEFAULT_REPORT_CAPS, key)) {
      warnings.push(`报告上限：未知配置项 reportCaps["${key}"] 已忽略（可用：${Object.keys(DEFAULT_REPORT_CAPS).join('、')}）`);
      continue;
    }
    caps[key] = normalizeCap(key, raw[key], warnings);
  }
  return { caps, warnings };
}

/**
 * 读取已解析的 cap；缺省或非法时用 fallback（默认 Infinity=不截断）。
 * 检查拿到的通常是 resolveReportCaps 的结果，这里仍做一次防御。
 */
export function reportCap(caps, key, fallback = Infinity) {
  if (caps && typeof caps === 'object' && hasOwn(caps, key)) {
    const value = caps[key];
    if (value === Infinity) return Infinity;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return fallback;
}

/**
 * 按 cap 截断列表，并返回结构化截断信息（total/reported/cap）；未截断时 truncation=null。
 * cap=Infinity 时原样返回，不做任何隐藏。
 */
export function truncateList(list, cap) {
  const items = Array.isArray(list) ? list : [];
  if (cap === Infinity) return { kept: items, truncation: null };
  if (items.length <= cap) return { kept: items, truncation: null };
  return {
    kept: items.slice(0, cap),
    truncation: { total: items.length, reported: cap, cap },
  };
}

/** 构造审计结果里的截断记录，报告层用它在 ## Not covered 里点名。 */
export function truncationRecord({ checkId, rule, configKey, total, reported, cap, file }) {
  return {
    checkId, rule, configKey, total, reported, cap, ...(file ? { file } : {}),
  };
}

/** warnings 里的截断提示：必须写清规则、总量、配置上限和未列出的条数。 */
export function truncationWarning({ checkId, rule, configKey, total, reported, cap, file }) {
  const where = file ? `（${file}）` : ' ';
  return `${checkId}：规则 ${rule}${where}命中 ${total} 条，按配置 reportCaps["${configKey}"]=${cap} 只报前 ${reported} 条，其余 ${total - reported} 条未列出`;
}

/** ## Not covered 里的同一句话（不是只有 warnings 才提）。 */
export function truncationNotCoveredLine({ checkId, rule, configKey, total, reported, cap, file }) {
  const where = file ? `（${file}）` : ' ';
  return `- ${checkId}：规则 ${rule}${where}命中 ${total} 条，按配置 reportCaps["${configKey}"]=${cap} 只报前 ${reported} 条，其余 ${total - reported} 条未列出`;
}

/** 未截断但单规则命中偏多：保留「可能是噪声」的提示，同时明确全部条目都在。 */
export function noiseWarning({ checkId, rule, total, configKey }) {
  const hint = DEFAULT_NOISE_HINTS[configKey] ?? Infinity;
  return `${checkId}：规则 ${rule} 命中 ${total} 条，超过噪声提示阈值 ${hint}，可能含噪声，建议人工复核（默认不截断，全部条目已保留）`;
}
