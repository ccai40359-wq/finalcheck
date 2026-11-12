import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectTier } from './tiers.mjs';
import { extractRoutes } from './extract-routes.mjs';
import { checkAuthCoverage } from './checks/routes.mjs';
import { checkSecrets, sanitizeS3Excludes } from './checks/secrets.mjs';
import { checkSecretsHistory } from './checks/secrets-history.mjs';
import { checkExternal } from './checks/external.mjs';
import { checkData, checkBackup, checkPrivacy } from './checks/data.mjs';
import { checkConfig } from './checks/config.mjs';
import { checkDeps } from './checks/deps.mjs';
import { checkQ1 } from './checks/q1.mjs';
import { checkInject } from './checks/inject.mjs';
import { checkAuthz } from './checks/authz.mjs';
import { checkPassword } from './checks/password.mjs';
import { checkQuality, hasQualityConfig } from './checks/quality.mjs';
import { checkHandover } from './checks/handover.mjs';
import { checkMetrics } from './checks/metrics.mjs';
import { checkReadability } from './checks/readability.mjs';
import { checkPerfStatic } from './checks/perf-static.mjs';
import { checkLicense } from './checks/license.mjs';
import { checkOps } from './checks/ops.mjs';
import { planFromProfile, highestLevel, evidenceMatrix } from './profile.mjs';
import { isFixturePath } from './walk.mjs';
import { dedupeCrossCopies } from './dedupe.mjs';
import { resolveReportCaps } from './report-caps.mjs';
import { ACCEPT_FILE, applyAcceptances } from './accept.mjs';

// 覆盖关（ACCEPTANCE §4 矩阵已实现子集）：S6/D/E/X 接线中
// L2 = 安全/供应链/测试 + 交接(H1) + 可维护性(Q3)
// L3 = L2 + 许可证(C1) + 运维就绪(O1)
// L1 = 个人底线：只有 S3（含 git 历史密钥）是硬卡
// L2 = 安全/供应链/测试 + 外部入口(S6) + 交接(H1) + 可维护性(Q3)
// L3 = L2 + 数据层(D1 事务/D2 备份/D3 隐私) + 许可证(C1) + 运维就绪(O1)
export const GATES = {
  L1: ['S2', 'S3', 'S4', 'S5'],
  L2: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'Q1', 'H1', 'Q3', 'Q4', 'Q5'],
  L3: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'Q1', 'H1', 'Q3', 'Q4', 'Q5', 'C1', 'O1', 'D1', 'D2', 'D3'],
};
// Q2 只在项目根有 finalcheck.quality.json 时才加入计划：没声明就不假装查过质量
const QUALITY_TIERS = new Set(['L2', 'L3']);

const NEXT = { L1: 'L2', L2: 'L3', L3: 'L3' };

export async function loadConfig(projectDir) {
  try {
    return JSON.parse(await readFile(path.join(projectDir, 'finalcheck.config.json'), 'utf8'));
  } catch { return {}; }
}

export async function audit(projectDir, { tier = null, interactive = false, runTests = true, profile = null, runtime = null, sources = null, includeFixtures = false, noCaps = false } = {}) {
  const cfg = await loadConfig(projectDir);
  // 报告条数上限集中解析一次，三个检查从参数拿，不各自读配置；默认不截断。
  const { caps: reportCaps, warnings: reportCapWarnings } = resolveReportCaps(cfg, { noCaps });
  const excludes = Array.isArray(cfg.exclude) ? cfg.exclude : [];
  // 只给输入面（sources）不给 profile 时：包成一个最小 profile，仍走维度计划（默认各维 L2）。
  // 这样「用户只填了 URL」也能得到维度视图，而不是悄悄退回老 GATES。
  const effProfile = sources && typeof sources === 'object' && !Array.isArray(sources)
    ? { ...(profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {}), sources: { ...(profile?.sources || {}), ...sources } }
    : profile;

  const auto = await detectTier(projectDir, { excludes });
  // profile 模式：计划由每维度档位决定，显式配置优先于自动定档（不再保守 +1）。
  // 不传 profile 时完全走原来的 GATES 路径，现有调用方与测试零变化。
  const profilePlan = effProfile ? planFromProfile(effProfile) : null;
  let effective;
  let conservativeNote = null;
  if (profilePlan) {
    effective = highestLevel(Object.values(profilePlan.dimensions).map((d) => d.level));
  } else {
    effective = tier || auto.suggestedTier;
    if (!tier && !interactive) {
      effective = NEXT[effective]; // §2 非交互：保守加一档
      conservativeNote = '非交互运行：已按保守策略加一档（--interactive 可关闭）';
    }
  }

  const raw = await extractRoutes(projectDir).catch((e) => ({ routes: [], publicRoutes: [], warnings: [`路由提取失败：${e.message}`] }));
  // 自食教训 #4：测试夹具=故意带洞样本 → 按 exclude 过滤路由，不放行到检查层。
  // 夹具目录即使没写进 exclude 也默认不进产品结论：那是故意写坏的样本（includeFixtures 可显式纳入）。
  const excl = (rel) => excludes.some((x) => { const n = String(x).replace(/\\/g, '/'); const r = (rel || '').replace(/\\/g, '/'); return r === n || r.startsWith(n + '/'); });
  const fixtureBlocked = (rel) => !includeFixtures && isFixturePath(rel);
  const routeResult = {
    routes: (raw.routes || []).filter((r) => !excl(r.file) && !fixtureBlocked(r.file)),
    publicRoutes: raw.publicRoutes || [],
    warnings: (raw.warnings || []).filter((w) => !excl(w)),
  };

  const qualityOn = QUALITY_TIERS.has(effective) && await hasQualityConfig(projectDir);
  // Q1/Q2 无论是否授权都进计划：没授权就记 coverageGap，绝不「静默不跑」
  const basePlanned = profilePlan ? profilePlan.planned : GATES[effective];
  const planned = basePlanned.slice().concat(qualityOn ? ['Q2'] : []);
  const results = [];
  for (const id of planned) {
    if (id === 'S1') results.push(await checkAuthCoverage(routeResult));
    if (id === 'S3') {
      // S3 = 工作树密钥 + git 历史密钥：历史查不了只降级为 warning（不能因没 .git 就把整份结论压成无法验收）
      // S3 的 exclude 只保留夹具/构建产物白名单：真实配置文件（如 desktop/config.json）不能被藏掉。
      const s3Excludes = sanitizeS3Excludes(excludes);
      const base = await checkSecrets(projectDir, { excludes, includeFixtures, gitleaks: cfg.gitleaks });
      const hist = await checkSecretsHistory(projectDir, { tier: effective, excludes: s3Excludes })
        .catch((e) => ({ checkId: 'S3', findings: [], warnings: [`S3 历史扫描异常：${e.message}`], coverageGap: null }));
      results.push({
        checkId: 'S3',
        findings: [...base.findings, ...(hist.findings || [])],
        warnings: [...(base.warnings || []), ...(hist.warnings || []), ...(hist.coverageGap ? [`未查历史：${hist.coverageGap}`] : [])],
        coverageGap: base.coverageGap || null
      });
    }
    if (id === 'S6') results.push(await checkExternal(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'D1') results.push(await checkData(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'D2') results.push(await checkBackup(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'D3') results.push(await checkPrivacy(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'S4') results.push(await checkDeps(projectDir));
    if (id === 'S5') results.push(await checkConfig(projectDir, effective, { excludes, includeFixtures }));
    if (id === 'Q1') results.push(await checkQ1(projectDir, { tier: effective, excludes, routeResult, run: runTests, includeFixtures }));
    if (id === 'Q2') results.push(await checkQuality(projectDir, { tier: effective, run: runTests }));
    if (id === 'S2') results.push(await checkInject(projectDir, { tier: effective, excludes, routeResult, includeFixtures }));
    if (id === 'S7') results.push(await checkAuthz(projectDir, { tier: effective, excludes, routeResult, includeFixtures }));
    if (id === 'S8') results.push(await checkPassword(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'H1') results.push(await checkHandover(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'Q3') results.push(await checkMetrics(projectDir, { tier: effective, excludes, includeFixtures, reportCaps }));
    if (id === 'Q4') results.push(await checkReadability(projectDir, { tier: effective, excludes, includeFixtures, reportCaps }));
    if (id === 'Q5') results.push(await checkPerfStatic(projectDir, { tier: effective, excludes, includeFixtures, reportCaps }));
    if (id === 'C1') results.push(await checkLicense(projectDir, { tier: effective, excludes }));
    if (id === 'O1') results.push(await checkOps(projectDir, { tier: effective, excludes, includeFixtures }));
  }

  let findings = results.flatMap((r) => r.findings);
  const warnings = [...reportCapWarnings, ...routeResult.warnings, ...results.flatMap((r) => r.warnings || [])];
  // 显式配置的上限真的截断时，检查已写 warning；这里汇总成结构化记录，供报告 ## Not covered 点名
  const reportTruncations = results.flatMap((r) => r.reportTruncations || []);
  // profile 文件里的解析/取值警告原样带进审计结果，不静默吞掉
  if (effProfile && Array.isArray(effProfile.warnings)) warnings.push(...effProfile.warnings);
  // profile 里写了不存在的维度：按警告暴露，不把用户笔误升级成「无法验收」
  if (profilePlan) {
    for (const gap of profilePlan.gapsForUnknown) {
      warnings.push(`profile：未知维度「${gap.dimension}」已忽略（${gap.reason}）`);
    }
  }
  // 夹具默认豁免的兜底：即使某个检查自带 walker 漏放行，这里也不让「故意写坏的样本」进入产品结论
  if (!includeFixtures) {
    const before = findings.length;
    findings = findings.filter((f) => !isFixturePath(f.file));
    const skipped = before - findings.length;
    if (skipped) warnings.push(`夹具目录默认不参与产品结论：已跳过 ${skipped} 条发现（includeFixtures 可显式纳入）`);
  }
  // 跨副本去重：同一检查/规则 + 归一化路径 + 行号只保留一条，优先真实源码路径
  const deduped = dedupeCrossCopies(findings);
  findings = deduped.findings;
  warnings.push(...deduped.warnings);
  // 可审计豁免：只认 rule+file+line+行指纹，文件改动/过期都会重新计入；生效清单进 warnings。
  const acceptance = await applyAcceptances(projectDir, findings);
  findings = acceptance.findings;
  warnings.push(...acceptance.warnings);
  if (effective === 'L1') findings = findings.map((f) => (f.checkId === 'S3' ? f : { ...f, force: 'tip' })); // L1 只有 S3 是硬卡
  // S7/S8 属文件级启发式，人工确认机制（v2）接入前一律 check 级，不自动锁死结论（三轮 reviewer P1#3/#13）
  findings = findings.map((f) => (f.checkId === 'S7' || f.checkId === 'S8') && f.force === 'card' ? { ...f, force: 'check', message: f.message + '（人工确认机制接入后升级为卡）' } : f);
  // gap 分两类：能力缺失（unavailable：缺 lockfile/二进制/配置）与未授权（unauthorized：runTests=false）。
  // 前者应封顶「无法验收」；后者只是证据待补，不能把整份结论压死，更不能因此判「拦」。
  const gapItems = results
    .filter((r) => r.coverageGap)
    .map((r) => ({ checkId: r.checkId, kind: gapKind(r), reason: r.coverageGap }));
  // 未实现维度（如可选的第 12 维「成本」）同样记 coverageGap，沿用 checkId 字段保证
  // 老报告/老调用方还能按 checkId 取到缺口，不静默跳过。
  if (profilePlan) {
    for (const gap of profilePlan.gapsForUnimplemented) {
      gapItems.push({ checkId: gap.dimension, dimension: gap.dimension, kind: 'unavailable', reason: gap.reason });
    }
  }
  const gaps = gapItems.map(gapLabel);
  // N/A 是「结构上不适用」，不是「能力缺失」，也不是「待授权」：结论引擎不封顶，
  // 但报告必须单独点名（notApplicable），让读者知道该项确实没验证。
  const notApplicable = gapItems
    .filter((g) => g.kind === 'not-applicable')
    .map((g) => ({ checkId: g.checkId, reason: g.reason }));
  const conclusion = conclude(effective, findings, gapItems);
  const dimensions = profilePlan ? dimensionResults(profilePlan, findings, gapItems) : null;
  // 证据等级是加法的：只有传了 profile 才出现，老调用方的结果形状不变。
  const evidence = profilePlan ? evidenceMatrix(effProfile, runtime) : null;

  return {
    projectDir,
    tier: {
      requested: tier,
      suggested: auto.suggestedTier,
      effective,
      signals: auto.signals,
      conservativeNote,
      ...(dimensions ? { dimensions } : {}),
    },
    gates: {
      planned,
      executed: results.filter((r) => !r.coverageGap).map((r) => r.checkId),
      gaps,
      gapItems, // 保留 gaps 字符串兼容老调用方；gapItems 带 kind 供结论分级
    },
    findings,
    conclusion,
    notApplicable,
    ...(acceptance.accepted.length ? { acceptance: { file: ACCEPT_FILE, accepted: acceptance.accepted } } : {}),
    ...(evidence ? { evidence } : {}),
    ...(reportTruncations.length ? { reportTruncations } : {}),
    warnings,
  };
}

// 每维度结论：只看本维度 checks 产生的发现与缺口。
// - 整维没有接入任何检查 → 无法验收（与 coverageGap 同口径）
// - 该档位不要求任何检查（例如 L1 的可读性）→ 不适用
// - 本维度有跑不了的关 → 无法验收；只有未授权 → 待授权
// - 其余沿用结论引擎，但按该维度自己的档位判（L1 只认 S3 硬卡）
function dimensionResults(plan, findings, gapItems) {
  const out = {};
  for (const [name, dim] of Object.entries(plan.dimensions)) {
    out[name] = { level: dim.level, verdict: dimensionVerdict(dim, findings, gapItems) };
  }
  return out;
}

export function dimensionVerdict(dim, findings, gapItems) {
  if (!dim.implemented) return '无法验收';
  if (!dim.checks.length) return '不适用';
  const ownGaps = gapItems.filter((g) => dim.checks.includes(g.checkId));
  // not-applicable 只是「本维度不适用」的结构性说明：不封顶、不算待授权。
  // 若该维度其余检查都过 → 该维度「过」，但报告 Not covered 会点名 N/A。
  if (ownGaps.some((g) => g.kind !== 'unauthorized' && g.kind !== 'not-applicable')) return '无法验收';
  if (ownGaps.some((g) => g.kind === 'unauthorized')) return '待授权';
  const ownFindings = findings.filter((f) => dim.checks.includes(f.checkId));
  const base = baseVerdict(dim.level, ownFindings).verdict;
  // check 级的高/中危是「需人工确认」而不是「已通过」：维度不能因为不卡结论就写成「过」。
  // low/check 是风格建议，仍按原语义不抬维度结论。
  const manual = ownFindings.filter((f) => f.force === 'check' && (f.severity === 'high' || f.severity === 'medium'));
  if (base === '过' && manual.length) return '修完再过';
  return base;
}

// gap 归类：检查自己声明了 gapKind 就照办；Q2 与 Q1 共用 runTests 开关，
// 未授权路径（quality.mjs 的「未授权 runTests」文案）不改源文件也能识别
export function gapKind(r) {
  if (r.gapKind === 'unauthorized' || r.gapKind === 'unavailable' || r.gapKind === 'not-applicable') return r.gapKind;
  if (r.checkId === 'Q2' && /未授权/.test(String(r.coverageGap || ''))) return 'unauthorized';
  return 'unavailable';
}

// coverageGap 可能自带「Q1：」前缀（历史文案），拼接时不重复加前缀
function gapLabel(g) {
  const reason = String(g.reason || '');
  return reason.startsWith(`${g.checkId}：`) ? reason : `${g.checkId}：${reason}`;
}

// 结论引擎（ACCEPTANCE §5，无歧义版）
export function conclude(tier, findings, gapItems = []) {
  // N/A（结构上不适用）不封顶、不算待授权：只在报告里列 Not covered。
  const unavailable = gapItems.filter((g) => g.kind !== 'unauthorized' && g.kind !== 'not-applicable');
  const unauthorized = gapItems.filter((g) => g.kind === 'unauthorized');
  // 能力缺失：应跑而本机跑不了 → 依旧封顶「无法验收」
  if (unavailable.length) {
    return { verdict: '无法验收', reason: `覆盖不足（${unavailable.length} 关未跑）：${unavailable.map(gapLabel).join('；')}` };
  }
  // 仅缺授权：结论是「待授权」，不是「无法验收」，更不是「拦」；同时给出其余检查的初判，不掩盖已发现的问题
  if (unauthorized.length) {
    const why = unauthorized.map(gapLabel).join('；');
    const base = baseVerdict(tier, findings);
    const tail = base.verdict === '过'
      ? '其余检查已通过，授权后重跑即可给出最终结论'
      : `其余检查初判「${base.verdict}」：${base.reason}（授权后重跑确认）`;
    return {
      verdict: '待授权',
      reason: `仅缺授权执行项：${why}；${tail}`,
      pendingAuth: unauthorized.map((g) => ({ checkId: g.checkId, reason: g.reason })),
    };
  }
  return baseVerdict(tier, findings);
}

function baseVerdict(tier, findings) {
  const high = findings.filter((f) => f.severity === 'high' && f.force === 'card'); // S7/S8 在 L2 是'check'级（只报不拦），不得误触发
  const card = findings.filter((f) => f.force === 'card');
  if (tier === 'L1') {
    // P0#2：只认 S3 高危实锤（程序判定），文档线索不算
    if (findings.some((f) => f.checkId === 'S3' && f.severity === 'high' && f.force === 'card')) return { verdict: '拦', reason: 'S3 密钥项高危实锤（L1 唯一硬卡）' };
    return { verdict: '过', reason: 'L1 底线达标（其余项为提醒）' };
  }
  if (tier === 'L2') {
    if (high.length) return { verdict: '拦', reason: `${high.length} 条高危实锤` };
    if (card.length) return { verdict: '修完再过', reason: `${card.length} 项卡条目未过` };
    return { verdict: '过', reason: 'L2 全部卡条目通过' };
  }
  if (card.length) return { verdict: '拦', reason: `L3 存在未过卡项 ${card.length} 处（人工确认项机制下轮接入）` };
  return { verdict: '过', reason: 'L3 全过（盖章报告待人工确认项接入）' };
}
