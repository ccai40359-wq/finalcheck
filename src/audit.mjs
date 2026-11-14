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
import { isFixturePath, listTextFiles } from './walk.mjs';
import { dedupeCrossCopies } from './dedupe.mjs';
import { resolveReportCaps } from './report-caps.mjs';
import { ACCEPT_FILE, applyAcceptances } from './accept.mjs';
import { applyScopePolicy, detectLanguageGap } from './scope-policy.mjs';
import { runPyBandit } from './checks/py-bandit.mjs';
import { checkAiToolPerms, checkAiPromptInjection, checkAiSandbox, checkAiDataBoundary } from './checks/ai-agent.mjs';
import { isLibraryRepo } from './project-kind.mjs';

// 覆盖关（ACCEPTANCE §4 矩阵已实现子集）：S6/D/E/X 接线中
// L2 = 安全/供应链/测试 + 交接(H1) + 可维护性(Q3)
// L3 = L2 + 许可证(C1) + 运维就绪(O1)
// L1 = 个人底线：只有 S3（含 git 历史密钥）与 A1 hard（入库配置把 agent 执行权开到不受限）是硬卡
// L2 = 安全/供应链/测试 + 外部入口(S6) + AI Agent 检查面(A1-A4) + 交接(H1) + 可维护性(Q3)
// L3 = L2 + 数据层(D1 事务/D2 备份/D3 隐私) + 许可证(C1) + 运维就绪(O1)
export const GATES = {
  L1: ['S2', 'S3', 'S4', 'S5', 'A1'],
  L2: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'A1', 'A2', 'A3', 'A4', 'Q1', 'H1', 'Q3', 'Q4', 'Q5'],
  L3: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'A1', 'A2', 'A3', 'A4', 'Q1', 'H1', 'Q3', 'Q4', 'Q5', 'C1', 'O1', 'D1', 'D2', 'D3'],
};
// Q2 只在项目根有 finalcheck.quality.json 时才加入计划：没声明就不假装查过质量
const QUALITY_TIERS = new Set(['L2', 'L3']);

const NEXT = { L1: 'L2', L2: 'L3', L3: 'L3' };

export async function loadConfig(projectDir) {
  try {
    return JSON.parse(await readFile(path.join(projectDir, 'finalcheck.config.json'), 'utf8'));
  } catch { return {}; }
}

export async function audit(projectDir, { tier = null, interactive = false, runTests = false, profile = null, runtime = null, sources = null, includeFixtures = false, noCaps = false } = {}) {
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
    unsupportedFrameworks: (raw.unsupportedFrameworks || []).filter((s) => !excl(s.split(': ')[0]) && !fixtureBlocked(s.split(': ')[0])),
    ineffectiveGuards: (raw.ineffectiveGuards || []).filter((guard) => !excl(guard.file) && !fixtureBlocked(guard.file)),
    routes: (raw.routes || []).filter((r) => !excl(r.file) && !fixtureBlocked(r.file)),
    publicRoutes: raw.publicRoutes || [],
    // HTTP 面存在但路由表没解析出来（node:http / 自定义 table / NodeGoat 式 routes(app) 挂载）：
    // 只透传信号，让 S1/S7 记 unavailable，而不是把「没解析到」说成「没有 HTTP 面」。
    httpSurface: raw.httpSurface || { exists: false, hints: [], mounts: [] },
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
    if (id === 'A1') results.push(await checkAiToolPerms(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'A2') results.push(await checkAiPromptInjection(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'A3') results.push(await checkAiSandbox(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'A4') results.push(await checkAiDataBoundary(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'H1') results.push(await checkHandover(projectDir, { tier: effective, excludes, includeFixtures }));
    if (id === 'Q3') results.push(await checkMetrics(projectDir, { tier: effective, excludes, includeFixtures, reportCaps }));
    if (id === 'Q4') results.push(await checkReadability(projectDir, { tier: effective, excludes, includeFixtures, reportCaps }));
    if (id === 'Q5') results.push(await checkPerfStatic(projectDir, { tier: effective, excludes, includeFixtures, reportCaps }));
    if (id === 'C1') results.push(await checkLicense(projectDir, { tier: effective, excludes }));
    if (id === 'O1') results.push(await checkOps(projectDir, { tier: effective, excludes, includeFixtures }));
  }

  // Python SAST（Bandit，round3 定案）：B608 SQLi / pickle / XXE / shell=True / 弱随机等
  // 14 类是 FC 自研规则的空白面（pygoat 实测）。没装 → S2 语言缺口照旧 unavailable（fail-closed）；
  // 跑成 → findings 按 checkId 并入（S2/S3/S8/O1），同位发现与 FC 自研规则去重。
  const py = await runPyBandit(projectDir, { excludes, includeFixtures, tier: effective }).catch((e) => ({
    ran: false, findings: [], warnings: [`Bandit 运行异常：${e.message}`],
    coverageGap: 'Bandit 运行异常，Python SAST 未覆盖', pyCount: 0,
  }));
  const resultsByCheck = new Map(results.map((r) => [r.checkId, r]));
  for (const f of py.findings) {
    const entry = resultsByCheck.get(f.checkId);
    if (entry) entry.findings.push(f);
    else {
      const created = { checkId: f.checkId, findings: [f], warnings: [], coverageGap: null };
      results.push(created);
      resultsByCheck.set(f.checkId, created);
    }
  }
  if (py.coverageGap) {
    const entry = resultsByCheck.get('S2');
    if (entry) {
      if (!entry.coverageGap) { entry.coverageGap = py.coverageGap; entry.gapKind = 'unavailable'; }
    } else {
      const created = { checkId: 'S2', findings: [], warnings: [], coverageGap: py.coverageGap, gapKind: 'unavailable' };
      results.push(created);
      resultsByCheck.set('S2', created);
    }
  }
  const pyBanditRan = py.ran;

  let findings = results.flatMap((r) => r.findings);
  const warnings = [...reportCapWarnings, ...routeResult.warnings, ...results.flatMap((r) => r.warnings || [])];
  warnings.push(...py.warnings); // Bandit 的警告在 results 合并后统一入账（上面对 results 的改动不携带 warnings）
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
  // 非产品路径（tests/examples/docs/benchmarks）上的产品类发现只作提示，不计入结论；
  // S3 真实密钥硬规则与 H1/C1/O1/D1-D3 不降级（README/docs 就是它们的产品面）。
  const scoped = applyScopePolicy(findings);
  findings = scoped.findings;
  if (scoped.downgraded) warnings.push(`非产品路径发现 ${scoped.downgraded} 条已降为提示（tests/examples/docs/benchmarks，不计入结论）`);
  // 库/框架仓（fastapi/flask/requests/gin）：路由全是文档示例与框架内部代码，不是产品 HTTP 面。
  // 降 card→check 留人工确认，不硬卡也不冒充通过；服务信号（Dockerfile/start/Django/requirements
  // 带 web 框架）优先，识别失败按服务仓处理。
  let libraryMode = false;
  try {
    libraryMode = await isLibraryRepo(projectDir, { excludes, includeFixtures });
  } catch { libraryMode = false; }
  if (libraryMode) {
    let downgraded = 0;
    findings = findings.map((f) => {
      if (f.checkId === 'S1' && f.rule === 'S1.no-guard' && f.force === 'card') {
        downgraded++;
        return { ...f, force: 'check', message: `${f.message}（库/框架仓库：路由为文档示例或框架内部代码，需人工确认）` };
      }
      return f;
    });
    if (downgraded) warnings.push(`库/框架仓库：S1 的 ${downgraded} 条路由发现降为 check（无部署/服务信号，需人工确认）`);
  }
  if (effective === 'L1') findings = findings.map((f) => (f.checkId === 'S3' || (f.checkId === 'A1' && f.hard === true) ? f : { ...f, force: 'tip' })); // L1 只有 S3 与 A1 hard 是硬卡
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
  // 语言覆盖缺口：仓库只有 .py/.php/.java/.go/.rb 时，只解析 JS/TS 的检查不能算「已执行」，
  // 更不能把空结果当通过。文件列表只扫一次（复用 walk.mjs 的统一排除/夹具口径）。
  const { files: textFiles } = await listTextFiles(projectDir, excludes, { includeFixtures: false });
  const languageGap = detectLanguageGap(textFiles, projectDir);
  if (languageGap) {
    const reason = languageGap.jsCount > 0
      ? `仓库有 ${languageGap.nonJsCount} 个非 JS 源码（${languageGap.exts.join('/')}），该检查只解析 JS/TS，非 JS 部分未覆盖`
      : `仓库仅有 ${languageGap.exts.join('/')} 源码（${languageGap.nonJsCount} 个文件），该检查目前只解析 JS/TS，未覆盖`;
    // Bandit 已跑成时，S2（注入/反序列化/弱哈希）由它提供部分覆盖，语言缺口不再封顶 S2；
    // 路由表里已有非 JS 路由（FastAPI/Flask 提取成功）时，S1 的路由/鉴权面也已真覆盖。
    const nonJsRoutesCovered = (routeResult.routes || []).some((r) => !/\.[cm]?[jt]sx?$/i.test(String(r.file || '')));
    const gapCheckIds = languageGap.checkIds.filter((id) => {
      if (pyBanditRan && id === 'S2') return false;
      if (nonJsRoutesCovered && id === 'S1') return false;
      return true;
    });
    if (pyBanditRan && gapCheckIds.length !== languageGap.checkIds.length) {
      warnings.push('S2 的语言缺口已由 Bandit 部分覆盖（Python SAST：注入/反序列化/弱哈希），框架路由与鉴权面由路由提取结果决定');
    } else if (nonJsRoutesCovered && gapCheckIds.length !== languageGap.checkIds.length) {
      warnings.push('S1 的语言缺口已解除：Python（FastAPI/Flask）路由提取成功，路由鉴权面已真覆盖');
    }
    for (const checkId of gapCheckIds) {
      const existing = gapItems.find((g) => g.checkId === checkId);
      // 已有 unavailable/unauthorized 的缺口保留原条目（不重复追加）；N/A 升级为能力缺失。
      if (!existing) gapItems.push({ checkId, kind: 'unavailable', reason });
      else if (existing.kind === 'not-applicable') Object.assign(existing, { kind: 'unavailable', reason });
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
      // 被 unavailable 缺口覆盖的检查不算已执行（例如纯 Python 仓库里的 Q3/Q4/Q5）。
      executed: results
        .filter((r) => !r.coverageGap && !gapItems.some((g) => g.checkId === r.checkId && g.kind === 'unavailable'))
        .map((r) => r.checkId),
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
    const reason = `覆盖不足（${unavailable.length} 关未跑）：${unavailable.map(gapLabel).join('；')}`;
    // 未授权项不能因为有能力缺口就从 reason 里消失：结论仍是无法验收，但要同时点名待授权。
    if (!unauthorized.length) return { verdict: '无法验收', reason };
    return {
      verdict: '无法验收',
      reason: `${reason}；另待授权：${unauthorized.map(gapLabel).join('；')}`,
      pendingAuth: unauthorized.map((g) => ({ checkId: g.checkId, reason: g.reason })),
    };
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
    // P0#2：只认 S3 高危实锤（程序判定），文档线索不算；A1 hard（入库配置不受限执行权）同权
    if (findings.some((f) => f.checkId === 'S3' && f.severity === 'high' && f.force === 'card')) return { verdict: '拦', reason: 'S3 密钥项高危实锤（L1 唯一硬卡）' };
    if (findings.some((f) => f.checkId === 'A1' && f.severity === 'high' && f.force === 'card' && f.hard === true)) return { verdict: '拦', reason: 'A1 工具权限不受限（入库配置硬卡，L1 底线）' };
    return { verdict: '过', reason: 'L1 底线达标（其余项为提醒）' };
  }
  if (tier === 'L2') {
    if (high.length) return { verdict: '拦', reason: `${high.length} 条高危实锤` };
    if (card.length) return { verdict: '修完再过', reason: `${card.length} 项卡条目未过` };
    const manual = findings.filter((f) => f.force === 'check' && ['high', 'medium'].includes(f.severity));
    if (manual.length) return { verdict: '修完再过', reason: `${manual.length} 项中高风险仍待人工确认` };
    return { verdict: '过', reason: 'L2 全部卡条目通过' };
  }
  if (card.length) return { verdict: '拦', reason: `L3 存在未过卡项 ${card.length} 处（人工确认项机制下轮接入）` };
  const manual = findings.filter((f) => f.force === 'check' && ['high', 'medium'].includes(f.severity));
  if (manual.length) return { verdict: '修完再过', reason: `${manual.length} 项中高风险仍待人工确认，尚未完成 L3 验收` };
  return { verdict: '过', reason: '本轮已覆盖的 L3 检查通过；适用范围以报告覆盖清单为准' };
}
