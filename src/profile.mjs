// 维度配置地基：11 个验收维度 × 3 档（L1/L2/L3），外加可选的第 12 维「成本」。
//
// 这一层只负责「档位 → 检查计划」的映射，不执行任何检查，也不改现有 GATES 路径。
// 设计约束：
// 1) 全 L2 的合并计划必须与 audit.mjs 的 GATES.L2 完全一致（顺序也一致）；
// 2) 某维度在某一档没有检查（例如 L1 不要求可读性）不是「未实现」——只有整维三档都没有
//    检查的维度才记 coverageGap「该维度尚未接入检查」；
// 3) dynamic / verify / modelTier / fanoutCap 按维度取最大值合并，供后续动态复现、
//    多模型复核和 fan-out 调度使用。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const PROFILE_FILE = 'finalcheck.profile.json';
export const LEVELS = ['L1', 'L2', 'L3'];
export const UNIMPLEMENTED_REASON = '该维度尚未接入检查';
export const EVIDENCE_LEVELS = ['full', 'static-only', 'unverified', 'not-covered'];
// 压测缺省与 src/dynamic/stress.mjs 保持一致；上限沿用主进程的 60s / 50 连接。
export const DEFAULT_LOAD_LIMIT = Object.freeze({ seconds: 10, connections: 10 });
const LOAD_LIMIT_CAPS = { seconds: 60, connections: 50 };

// 计划内检查的规范顺序：与 GATES.L2 / GATES.L3 的书写顺序保持一致，
// 全 L2/L3 profile 合并后与老路径逐项相等（而不是仅集合相等）。
const CHECK_ORDER = [
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8',
  'Q1', 'Q2', 'H1', 'Q3', 'Q4', 'Q5',
  'C1', 'O1', 'D1', 'D2', 'D3',
];
const CHECK_RANK = new Map(CHECK_ORDER.map((id, i) => [id, i]));

const DYNAMIC_RANK = new Map([[false, 0], ['local', 1], ['authorized', 2]]);
const VERIFY_RANK = new Map([[false, 0], ['single', 1], ['adversarial', 2]]);
const MODEL_RANK = new Map([['small', 0], ['standard', 1], ['strong', 2]]);

const level = (checks, dynamic, verify, modelTier, fanoutCap) => ({
  checks: [...checks], dynamic, verify, modelTier, fanoutCap,
});

const emptyLevel = () => level([], false, false, 'small', 1);

// 维度 → 三档。checks 沿用现有 checkId（S1-S8 / D1-D3 / Q1-Q5 / H1 / C1 / O1）。
// 同一 checkId 可以服务多个维度（例如 S3 同时属于安全性与数据隐私），
// planFromProfile 会按 checkId 去重，不会重复执行。
export const DIMENSIONS = {
  安全性: {
    L1: level(['S2', 'S3', 'S5'], false, false, 'small', 1),
    L2: level(['S1', 'S2', 'S3', 'S5', 'S6', 'S7', 'S8'], 'local', 'single', 'standard', 8),
    L3: level(['S1', 'S2', 'S3', 'S5', 'S6', 'S7', 'S8'], 'authorized', 'adversarial', 'strong', 20),
  },
  数据与隐私: {
    L1: emptyLevel(),
    L2: level(['S3', 'S8'], 'local', 'single', 'standard', 8),
    L3: level(['S3', 'S8', 'D1', 'D2', 'D3'], 'authorized', 'adversarial', 'strong', 20),
  },
  供应链与许可证: {
    L1: level(['S4'], false, false, 'small', 1),
    L2: level(['S4'], false, 'single', 'standard', 8),
    L3: level(['S4', 'C1'], false, 'adversarial', 'strong', 20),
  },
  可维护性: {
    L1: emptyLevel(),
    L2: level(['Q3'], false, 'single', 'standard', 8),
    L3: level(['Q3'], false, 'single', 'strong', 20),
  },
  代码可读性: {
    L1: emptyLevel(),
    L2: level(['Q4'], false, 'single', 'standard', 8),
    L3: level(['Q4'], false, 'single', 'strong', 20),
  },
  可测试性: {
    L1: emptyLevel(),
    L2: level(['Q1'], 'local', 'single', 'standard', 8),
    L3: level(['Q1'], 'authorized', 'adversarial', 'strong', 20),
  },
  鲁棒性: {
    L1: level(['S2'], false, false, 'small', 1),
    L2: level(['S2', 'S5'], 'local', 'single', 'standard', 8),
    L3: level(['S2', 'S5'], 'local', 'adversarial', 'strong', 20),
  },
  运行稳定性: {
    L1: emptyLevel(),
    L2: level(['S5'], 'local', 'single', 'standard', 8),
    L3: level(['S5', 'O1'], 'authorized', 'adversarial', 'strong', 20),
  },
  性能: {
    L1: emptyLevel(),
    L2: level(['Q5'], 'local', 'single', 'standard', 8),
    L3: level(['Q5'], 'authorized', 'adversarial', 'strong', 20),
  },
  可观测性与可运维: {
    L1: emptyLevel(),
    L2: level(['Q3'], false, 'single', 'standard', 8),
    L3: level(['Q3', 'O1'], 'local', 'adversarial', 'strong', 20),
  },
  可移交性: {
    L1: emptyLevel(),
    L2: level(['H1'], false, 'single', 'standard', 8),
    L3: level(['H1'], false, 'single', 'standard', 20),
  },
  // 第 12 维：可选。当前没有成本检查，显式选入时按「未实现维度」记 coverageGap；
  // loadProfile 的缺省档位不包含它，避免缺省 profile 平白多出覆盖缺口。
  成本: {
    L1: emptyLevel(),
    L2: emptyLevel(),
    L3: emptyLevel(),
  },
};

export const CORE_DIMENSION_NAMES = Object.keys(DIMENSIONS).filter((n) => n !== '成本');
export const OPTIONAL_DIMENSION_NAMES = ['成本'];

const META_KEYS = new Set(['version', 'schema', '$schema', 'comment', 'description', 'level', 'tier', 'sources']);

function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeLoadLimit(raw, warnings) {
  const out = { ...DEFAULT_LOAD_LIMIT };
  if (raw === undefined) return out;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`profile：sources.loadLimit 必须是对象，已回落 ${out.seconds}s/${out.connections} 连接`);
    return out;
  }
  for (const key of ['seconds', 'connections']) {
    if (raw[key] === undefined) continue;
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n <= 0) {
      warnings.push(`profile：sources.loadLimit.${key} 非法，已回落 ${out[key]}`);
      continue;
    }
    const clamped = Math.min(LOAD_LIMIT_CAPS[key], Math.max(1, Math.trunc(n)));
    if (clamped !== Math.trunc(n)) {
      warnings.push(`profile：sources.loadLimit.${key} 超出 ${LOAD_LIMIT_CAPS[key]} 上限，已封顶`);
    }
    out[key] = clamped;
  }
  return out;
}

// sources 只做形状与取值校验，不碰文件系统：code 是用户声明的源码入口，不是本轮要读的目录。
export function normalizeSources(raw, warnings = []) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('profile：sources 必须是对象，已按空输入面处理');
    return {};
  }
  const out = {};
  if (raw.code !== undefined) {
    if (typeof raw.code === 'string' && raw.code.trim()) out.code = raw.code.trim();
    else warnings.push('profile：sources.code 必须是非空字符串，已忽略');
  }
  if (raw.url !== undefined) {
    if (isHttpUrl(raw.url)) out.url = raw.url.trim();
    else warnings.push('profile：sources.url 必须是 http(s) URL，已忽略');
  }
  if (raw.dynamicAuth !== undefined) {
    if (typeof raw.dynamicAuth === 'boolean') out.dynamicAuth = raw.dynamicAuth;
    else {
      out.dynamicAuth = false;
      warnings.push('profile：sources.dynamicAuth 必须是布尔值，已回落 false');
    }
  } else {
    out.dynamicAuth = false;
  }
  out.loadLimit = normalizeLoadLimit(raw.loadLimit, warnings);
  return out;
}

/** 把 L1 / l2 / 2 / {level:'L3'} 统一成合法档位；非法返回 null。 */
export function normalizeLevel(value) {
  if (typeof value === 'number') return LEVELS[value - 1] || null;
  if (typeof value === 'string') {
    const s = value.trim().toUpperCase();
    if (s === 'L1' || s === '1') return 'L1';
    if (s === 'L2' || s === '2') return 'L2';
    if (s === 'L3' || s === '3') return 'L3';
  }
  return null;
}

/** 一组维度档位里的最高档（空数组按 L1）。 */
export function highestLevel(levels = []) {
  let top = 'L1';
  for (const item of levels) {
    const lv = normalizeLevel(item);
    if (lv && LEVELS.indexOf(lv) > LEVELS.indexOf(top)) top = lv;
  }
  return top;
}

function defaultDimensions() {
  const dims = {};
  for (const name of CORE_DIMENSION_NAMES) dims[name] = 'L2';
  return dims;
}

function failedProfile(reason) {
  return { source: 'default', dimensions: defaultDimensions(), sources: {}, warnings: [reason] };
}

/**
 * 读取项目根 finalcheck.profile.json。
 * 支持两种写法：
 *   { "dimensions": { "安全性": "L3" } }
 *   { "安全性": "L3" }
 * 文件缺失 / 解析失败 / 非法值 → 回落全 L2，并把原因写进 warnings（从不静默）。
 * @param {string} projectDir
 * @returns {Promise<{source:string, dimensions:Record<string,string>, sources:object, warnings:string[]}>}
 */
export async function loadProfile(projectDir) {
  const file = path.join(projectDir, PROFILE_FILE);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { source: 'default', dimensions: defaultDimensions(), sources: {}, warnings: [] };
    return failedProfile(`profile：读取 ${PROFILE_FILE} 失败（${e.message}），使用全 L2 缺省`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return failedProfile(`profile：解析 ${PROFILE_FILE} 失败（${e.message}），使用全 L2 缺省`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return failedProfile(`profile：${PROFILE_FILE} 顶层必须是对象，使用全 L2 缺省`);
  }

  const nested = raw.dimensions;
  const provided = nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : raw;
  if (!provided || typeof provided !== 'object' || Array.isArray(provided)) {
    return failedProfile(`profile：${PROFILE_FILE} 的 dimensions 必须是对象，使用全 L2 缺省`);
  }

  const dimensions = defaultDimensions();
  const warnings = [];
  for (const [name, value] of Object.entries(provided)) {
    if (META_KEYS.has(name) || name.startsWith('$')) continue;
    const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value.level : value;
    const lv = normalizeLevel(candidate);
    dimensions[name] = lv || 'L2';
    if (!lv) {
      warnings.push(`profile：维度「${name}」的档位 ${JSON.stringify(value)} 非法，已回落 L2`);
    }
  }
  const sources = Object.prototype.hasOwnProperty.call(raw, 'sources')
    ? normalizeSources(raw.sources, warnings)
    : {};
  return { source: PROFILE_FILE, dimensions, sources, warnings };
}

function resolveDimensions(profile) {
  const raw = profile && typeof profile === 'object' && profile.dimensions && typeof profile.dimensions === 'object'
    ? profile.dimensions
    : profile;
  const dimensions = defaultDimensions();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return dimensions;
  for (const [name, value] of Object.entries(raw)) {
    if (META_KEYS.has(name) || name.startsWith('$')) continue;
    const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value.level : value;
    dimensions[name] = normalizeLevel(candidate) || 'L2';
  }
  return dimensions;
}

function maxBy(current, next, rank) {
  const a = rank.get(current);
  const b = rank.get(next);
  return b !== undefined && (a === undefined || b > a) ? next : current;
}

/**
 * 合并每维度档位，得出本轮检查计划与调度参数。
 * @param {object} [profile] loadProfile 的返回值，或 {维度名:档位} 的平铺对象
 * @returns {{
 *   planned:string[],
 *   gapsForUnknown:Array<{dimension:string, reason:string}>,
 *   gapsForUnimplemented:Array<{dimension:string, level:string, reason:string}>,
 *   dimensions:Record<string,{level:string, checks:string[], dynamic:boolean|string, verify:boolean|string, modelTier:string, fanoutCap:number, implemented:boolean}>,
 *   dynamic:boolean|string, verify:boolean|string, modelTier:string, fanoutCap:number,
 *   levels:Record<string,string>
 * }}
 */
export function planFromProfile(profile = null) {
  const levels = resolveDimensions(profile);
  const names = [...CORE_DIMENSION_NAMES];
  for (const name of Object.keys(levels)) {
    if (!names.includes(name)) names.push(name);
  }

  const planned = new Set();
  const dimensions = {};
  const gapsForUnknown = [];
  const gapsForUnimplemented = [];
  let dynamic = false;
  let verify = false;
  let modelTier = 'small';
  let fanoutCap = 1;

  for (const name of names) {
    const def = DIMENSIONS[name];
    const lv = levels[name] || 'L2';
    if (!def) {
      gapsForUnknown.push({ dimension: name, reason: '未知维度：未在 DIMENSIONS 中定义（已忽略）' });
      continue;
    }
    const spec = def[lv] || def.L2;
    const implemented = LEVELS.some((x) => (def[x]?.checks?.length || 0) > 0);
    dimensions[name] = {
      level: lv,
      checks: [...spec.checks],
      dynamic: spec.dynamic,
      verify: spec.verify,
      modelTier: spec.modelTier,
      fanoutCap: spec.fanoutCap,
      implemented,
    };
    for (const id of spec.checks) planned.add(id);
    if (!implemented) {
      gapsForUnimplemented.push({ dimension: name, level: lv, reason: UNIMPLEMENTED_REASON });
      continue;
    }
    dynamic = maxBy(dynamic, spec.dynamic, DYNAMIC_RANK);
    verify = maxBy(verify, spec.verify, VERIFY_RANK);
    modelTier = maxBy(modelTier, spec.modelTier, MODEL_RANK);
    if (spec.fanoutCap > fanoutCap) fanoutCap = spec.fanoutCap;
  }

  const ordered = [...planned].sort((a, b) => {
    const ra = CHECK_RANK.has(a) ? CHECK_RANK.get(a) : Number.MAX_SAFE_INTEGER;
    const rb = CHECK_RANK.has(b) ? CHECK_RANK.get(b) : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });

  return {
    planned: ordered,
    gapsForUnknown,
    gapsForUnimplemented,
    dimensions,
    dynamic,
    verify,
    modelTier,
    fanoutCap,
    levels: { ...levels },
  };
}

// 输入面判定：完整源码就能直接取证的维度（不依赖实测）。
const CODE_FULL = new Set(['可维护性', '代码可读性', '可移交性', '供应链与许可证', '可测试性']);
// 需要实测/压测才能给 full 的维度；只有 URL 或两者都有时，dynamicAuth=false 只能给 static-only。
const DYNAMIC_DIMENSIONS = new Set(['安全性', '鲁棒性', '性能', '运行稳定性']);
// 只有 URL 时仍能拿到部分静态证据的维度（供应链看响应/版本线索，可观测性探活与响应头）。
const URL_STATIC = new Set(['供应链与许可证', '可观测性与可运维']);

/**
 * 归一化「本轮实测记录」，供证据等级判定使用。
 * 接受两种写法：
 *   { probe:{count,ms,samples,at}, stress:{count,ms,samples,at} }  （主路径：App 现场记账）
 *   { probe:[{ms,samples,at},…], stress:[…] }                     （CLI / 测试直传）
 * 有任何一条 probe/stress 记录才算 measured；声明了 dynamicAuth 但没有记录 = 只有声明。
 * @param {object|null} [runtime]
 * @returns {{probe:{count:number,ms:number,samples:number,at:number},stress:{count:number,ms:number,samples:number,at:number},measured:boolean}}
 */
export function normalizeRuntime(runtime = null) {
  const zero = () => ({ count: 0, ms: 0, samples: 0, at: 0 });
  const agg = (v) => {
    if (!v) return zero();
    if (Array.isArray(v)) {
      const rows = v.filter((r) => r && typeof r === 'object');
      return {
        count: rows.length,
        ms: rows.reduce((s, r) => s + (Number(r.ms) || 0), 0),
        samples: rows.reduce((s, r) => s + (Number(r.samples) || 0), 0),
        at: rows.reduce((s, r) => Math.max(s, Number(r.at) || 0), 0),
      };
    }
    if (typeof v === 'object') {
      return { count: Number(v.count) || 0, ms: Number(v.ms) || 0, samples: Number(v.samples) || 0, at: Number(v.at) || 0 };
    }
    return zero();
  };
  const probe = agg(runtime?.probe);
  const stress = agg(runtime?.stress);
  return { probe, stress, measured: probe.count > 0 || stress.count > 0 };
}

function measuredText(rt) {
  const parts = [];
  if (rt.probe.count) parts.push(`probe ${rt.probe.count} 次/${Math.round(rt.probe.ms)}ms`);
  if (rt.stress.count) parts.push(`stress ${rt.stress.count} 次/${rt.stress.samples} 样本/${Math.round(rt.stress.ms)}ms`);
  return parts.join('、');
}

function evidenceOf(name, dim, sources, runtime = null) {
  // 成本是可选维度：当前没有接入检查，但证据等级仍按输入面给出（有源码=static-only，
  // 源码+URL=full）；它是否有检查由 coverageGap 单独表达，不在证据轴上重复降级。
  if (!dim.checks.length && name !== '成本') {
    return { level: 'not-covered', reason: '未覆盖（该档位不要求检查）' };
  }

  const hasCode = Boolean(sources.code);
  const hasUrl = Boolean(sources.url);
  const dynamicAuth = sources.dynamicAuth === true;
  const limit = sources.loadLimit || DEFAULT_LOAD_LIMIT;
  const limitText = `${limit.seconds}s/${limit.connections} 连接`;
  const rt = normalizeRuntime(runtime);
  // 「声明 + 实测」双条件：dynamicAuth 只代表用户点了头，不能代替真的 probe/stress 记录。
  // 没有记录就给 static-only，并把 dynamic 明细挂到证据上，报告里能看出是实测还是只声明。
  const dynamicBlock = () => ({
    declared: dynamicAuth,
    measured: rt.measured,
    probe: { ...rt.probe },
    stress: { ...rt.stress },
    limit: { ...limit },
  });
  const dynamicFullOrStatic = (fullReason) => {
    if (!dynamicAuth) return { level: 'static-only', reason: '仅静态（未授权压测）', dynamic: dynamicBlock() };
    if (!rt.measured) {
      return {
        level: 'static-only',
        reason: '仅静态（已声明授权，但本轮没有 probe/stress 实测记录）',
        dynamic: dynamicBlock(),
      };
    }
    return { level: 'full', reason: `${fullReason}，${measuredText(rt)}`, dynamic: dynamicBlock() };
  };

  if (!hasCode && !hasUrl) return { level: 'unverified', reason: '未验证（缺源码与 URL）' };

  if (hasCode && !hasUrl) {
    if (CODE_FULL.has(name)) return { level: 'full', reason: '证据充分（源码可查）' };
    return { level: 'static-only', reason: '仅静态（缺 URL，无实测证据）' };
  }

  if (!hasCode && hasUrl) {
    if (DYNAMIC_DIMENSIONS.has(name)) {
      return dynamicFullOrStatic(`证据充分（URL 实测已授权，${limitText}）`);
    }
    if (URL_STATIC.has(name)) {
      return name === '供应链与许可证'
        ? { level: 'static-only', reason: '仅静态（缺源码，只能从响应推断）' }
        : { level: 'static-only', reason: '仅静态（仅有 URL，只能探活/看响应头）' };
    }
    return { level: 'not-covered', reason: '未覆盖（缺源码）' };
  }

  // 源码 + URL：静态维度 full；动态维度仍需「授权 + 实测」两条都成立。
  if (DYNAMIC_DIMENSIONS.has(name)) {
    return dynamicFullOrStatic(`证据充分（源码 + URL 实测，${limitText}）`);
  }
  return { level: 'full', reason: '证据充分（源码 + URL）' };
}

/**
 * 按 输入面（sources.code / sources.url）× 维度 × 档位，给出每个维度的证据等级。
 * 返回 { [维度]: { level: 'full'|'static-only'|'unverified'|'not-covered', reason } }。
 * 注意：这里的 level 是「证据等级」，不是 L1/L2/L3 档位。
 * @param {object} [profile] loadProfile 的返回值，或包含 sources 的平铺对象
 * @param {object|null} [runtime] 本轮实测记录（probe/stress）；没有就只能是 static-only
 */
export function evidenceMatrix(profile = null, runtime = null) {
  const levels = resolveDimensions(profile);
  const rawSources = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile.sources : undefined;
  const sources = normalizeSources(rawSources, []);
  const out = {};
  for (const [name, lv] of Object.entries(levels)) {
    const def = DIMENSIONS[name];
    if (!def) continue;
    const spec = def[lv] || def.L2;
    out[name] = evidenceOf(name, { checks: spec.checks }, sources, runtime);
  }
  return out;
}
