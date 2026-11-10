import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { t } from '../../desktop/src/renderer/i18n/core.mjs';

// Q4 压测基线对比：只做「这次比上次慢了吗」的判定与落盘。
// 真正压测由 src/dynamic/stress.mjs + autocannon 完成；本模块不联网、不起服务、不装依赖。
// 基线硬件相关：不同机器/不同并发/不同数据量之间的对比只能当线索，不能当结论。
export const PERF_BASELINE_REL = path.join('.finalcheck', 'bench', 'latest.json');
const DEFAULT_RPS_DROP_RATIO = 0.2;
const DEFAULT_P97_5_RISE_RATIO = 0.2;
const MIN_SAMPLES = 2;

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => Math.round(v * 10) / 10;

function ratioOf(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function sampleCount(record) {
  const n = num(record?.samples);
  return n == null ? 1 : n; // 没写 samples 视为单次测量
}

function fmt(v) {
  return String(round1(v));
}

function normalizeRecord(record) {
  const src = isRecord(record) ? record : {};
  const out = {
    at: typeof src.at === 'string' && src.at ? src.at : new Date().toISOString(),
    target: typeof src.target === 'string' ? src.target : null,
  };
  for (const key of ['rps', 'p97_5', 'errors', 'durationSec', 'connections']) {
    out[key] = num(src[key]);
  }
  out.samples = Math.trunc(sampleCount(src));
  return out;
}

/**
 * 对比本轮压测与基线。
 * 判定口径（默认阈值，可用 opts 覆盖）：
 * - 吞吐 rps 下降 > 20%           → 退化
 * - p97.5 延迟上升 > 20%          → 退化
 * - errors 从 0 变为 > 0          → 退化（零错误是硬承诺，不看百分比）
 * - 任一侧 samples < 2            → 只给 warning，不判退化（噪声太大）
 * @param {object} current 本轮记录 { at,target,rps,p97_5,errors,durationSec,connections,samples }
 * @param {object|null} previous 上次记录（同形状）
 * @param {{rpsDropRatio?:number, p97_5RiseRatio?:number, errorsFromZero?:boolean}} [opts]
 * @returns {{regressed:boolean, reasons:string[], deltas:object, warnings:string[]}}
 */
export function comparePerfBaseline(current, previous, opts = {}) {
  const reasons = [];
  const warnings = [];
  const deltas = {};
  let regressed = false;
  const rpsDropRatio = ratioOf(opts?.rpsDropRatio, DEFAULT_RPS_DROP_RATIO);
  const latencyRiseRatio = ratioOf(opts?.p97_5RiseRatio, DEFAULT_P97_5_RISE_RATIO);
  const errorsFromZero = opts?.errorsFromZero !== false;

  if (!isRecord(current)) {
    return { regressed: false, reasons, deltas, warnings: [t('缺少本轮压测记录，无法与基线对比')] };
  }
  if (!isRecord(previous)) {
    return {
      regressed: false,
      reasons,
      deltas,
      warnings: [t('首次运行没有基线，仅记录本次数据；下次运行才能判断是否退化')],
    };
  }

  if (previous.target && current.target && previous.target !== current.target) {
    warnings.push(t('基线与本轮压测目标不同（{prev} → {cur}），对比结果仅供参考', {
      prev: previous.target,
      cur: current.target,
    }));
  }

  // 吞吐：下降为负 pct，越负越差
  const curRps = num(current.rps);
  const prevRps = num(previous.rps);
  if (curRps != null && prevRps != null) {
    const rawPct = prevRps > 0 ? ((curRps - prevRps) / prevRps) * 100 : null;
    const pct = rawPct == null ? null : round1(rawPct);
    deltas.rps = { previous: prevRps, current: curRps, delta: round1(curRps - prevRps), pct };
    if (rawPct == null) {
      warnings.push(t('基线 rps 为 0，无法计算吞吐下降比例'));
    } else if (rawPct < 0 && (-rawPct / 100) > rpsDropRatio) {
      reasons.push(t('吞吐下降 {pct}%（{prev} → {cur} rps）', {
        pct: fmt(Math.abs(pct)),
        prev: fmt(prevRps),
        cur: fmt(curRps),
      }));
      regressed = true;
    }
  } else {
    warnings.push(t('本轮或基线缺少 rps 数值，跳过吞吐对比'));
  }

  // 延迟：上升为正 pct，越大越差
  const curLatency = num(current.p97_5);
  const prevLatency = num(previous.p97_5);
  if (curLatency != null && prevLatency != null) {
    const rawPct = prevLatency > 0 ? ((curLatency - prevLatency) / prevLatency) * 100 : null;
    const pct = rawPct == null ? null : round1(rawPct);
    deltas.p97_5 = { previous: prevLatency, current: curLatency, delta: round1(curLatency - prevLatency), pct };
    if (rawPct == null) {
      warnings.push(t('基线 p97_5 为 0，无法计算延迟上升比例'));
    } else if (rawPct > 0 && (rawPct / 100) > latencyRiseRatio) {
      reasons.push(t('p97.5 延迟上升 {pct}%（{prev} → {cur} ms）', {
        pct: fmt(pct),
        prev: fmt(prevLatency),
        cur: fmt(curLatency),
      }));
      regressed = true;
    }
  } else {
    warnings.push(t('本轮或基线缺少 p97_5 数值，跳过延迟对比'));
  }

  // 错误数：0 → >0 单独判退化，不折算成比例（没有请求总数，比例会撒谎）
  const curErrors = num(current.errors);
  const prevErrors = num(previous.errors);
  if (curErrors != null && prevErrors != null) {
    deltas.errors = {
      previous: prevErrors,
      current: curErrors,
      delta: round1(curErrors - prevErrors),
    };
    if (errorsFromZero && prevErrors === 0 && curErrors > 0) {
      reasons.push(t('错误数从 0 变为 {cur}（零错误承诺被打破）', { cur: fmt(curErrors) }));
      regressed = true;
    } else if (prevErrors > 0 && curErrors > prevErrors) {
      warnings.push(t('错误数上升（{prev} → {cur}），但基线已有错误，未按「从零退化」口径判定', {
        prev: fmt(prevErrors),
        cur: fmt(curErrors),
      }));
    }
  } else {
    warnings.push(t('本轮或基线缺少 errors 数值，跳过错误数对比'));
  }

  const curSamples = sampleCount(current);
  const prevSamples = sampleCount(previous);
  if (curSamples < MIN_SAMPLES || prevSamples < MIN_SAMPLES) {
    return {
      regressed: false,
      reasons: [],
      deltas,
      warnings: [
        ...warnings,
        t('样本不足（本轮 {cur} 次 / 基线 {prev} 次，各需至少 {min} 次），本次不判定性能退化', {
          cur: curSamples,
          prev: prevSamples,
          min: MIN_SAMPLES,
        }),
      ],
    };
  }

  return { regressed, reasons, deltas, warnings };
}

/** 基线文件绝对路径：<dir>/.finalcheck/bench/latest.json */
export function perfBaselinePath(dir) {
  return path.join(dir, PERF_BASELINE_REL);
}

/**
 * 原子写入基线：先写同目录临时文件再 rename，避免进程中断留下半个 JSON。
 * @returns {Promise<{path:string, record:object}>}
 */
export async function savePerfBaseline(dir, record) {
  const target = perfBaselinePath(dir);
  const normalized = normalizeRecord(record);
  const body = JSON.stringify(normalized, null, 2) + '\n';
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, body, 'utf8');
  try {
    await rename(tmp, target);
  } catch (e) {
    // Windows 上目标被占用/已存在时 rename 可能报 EPERM/EEXIST：删旧再换
    if (e && (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES')) {
      await unlink(target).catch(() => {});
      await rename(tmp, target);
    } else {
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
  return { path: target, record: normalized };
}

/** 读基线；不存在、损坏、不是对象一律返回 null（不抛异常） */
export async function loadPerfBaseline(dir) {
  try {
    const raw = JSON.parse(await readFile(perfBaselinePath(dir), 'utf8'));
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}
