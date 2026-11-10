import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectTier } from './tiers.mjs';
import { extractRoutes } from './extract-routes.mjs';
import { checkAuthCoverage } from './checks/routes.mjs';
import { checkSecrets } from './checks/secrets.mjs';
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
import { checkLicense } from './checks/license.mjs';
import { checkOps } from './checks/ops.mjs';

// 覆盖关（ACCEPTANCE §4 矩阵已实现子集）：S6/D/E/X 接线中
// L2 = 安全/供应链/测试 + 交接(H1) + 可维护性(Q3)
// L3 = L2 + 许可证(C1) + 运维就绪(O1)
// L1 = 个人底线：只有 S3（含 git 历史密钥）是硬卡
// L2 = 安全/供应链/测试 + 外部入口(S6) + 交接(H1) + 可维护性(Q3)
// L3 = L2 + 数据层(D1 事务/D2 备份/D3 隐私) + 许可证(C1) + 运维就绪(O1)
const GATES = {
  L1: ['S2', 'S3', 'S4', 'S5'],
  L2: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'Q1', 'H1', 'Q3'],
  L3: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'Q1', 'H1', 'Q3', 'C1', 'O1', 'D1', 'D2', 'D3'],
};
// Q2 只在项目根有 finalcheck.quality.json 时才加入计划：没声明就不假装查过质量
const QUALITY_TIERS = new Set(['L2', 'L3']);

const NEXT = { L1: 'L2', L2: 'L3', L3: 'L3' };

export async function loadConfig(projectDir) {
  try {
    return JSON.parse(await readFile(path.join(projectDir, 'finalcheck.config.json'), 'utf8'));
  } catch { return {}; }
}

export async function audit(projectDir, { tier = null, interactive = false, runTests = true } = {}) {
  const cfg = await loadConfig(projectDir);
  const excludes = Array.isArray(cfg.exclude) ? cfg.exclude : [];

  const auto = await detectTier(projectDir, { excludes });
  let effective = tier || auto.suggestedTier;
  let conservativeNote = null;
  if (!tier && !interactive) {
    effective = NEXT[effective]; // §2 非交互：保守加一档
    conservativeNote = '非交互运行：已按保守策略加一档（--interactive 可关闭）';
  }

  const raw = await extractRoutes(projectDir).catch((e) => ({ routes: [], publicRoutes: [], warnings: [`路由提取失败：${e.message}`] }));
  // 自食教训 #4：测试夹具=故意带洞样本 → 按 exclude 过滤路由，不放行到检查层
  const excl = (rel) => excludes.some((x) => { const n = String(x).replace(/\\/g, '/'); const r = (rel || '').replace(/\\/g, '/'); return r === n || r.startsWith(n + '/'); });
  const routeResult = {
    routes: (raw.routes || []).filter((r) => !excl(r.file)),
    publicRoutes: raw.publicRoutes || [],
    warnings: (raw.warnings || []).filter((w) => !excl(w)),
  };

  const qualityOn = QUALITY_TIERS.has(effective) && await hasQualityConfig(projectDir);
  // Q1/Q2 无论是否授权都进计划：没授权就记 coverageGap，绝不「静默不跑」
  const planned = GATES[effective].slice().concat(qualityOn ? ['Q2'] : []);
  const results = [];
  for (const id of planned) {
    if (id === 'S1') results.push(await checkAuthCoverage(routeResult));
    if (id === 'S3') {
      // S3 = 工作树密钥 + git 历史密钥：历史查不了只降级为 warning（不能因没 .git 就把整份结论压成无法验收）
      const base = await checkSecrets(projectDir, { excludes });
      const hist = await checkSecretsHistory(projectDir, { tier: effective, excludes })
        .catch((e) => ({ checkId: 'S3', findings: [], warnings: [`S3 历史扫描异常：${e.message}`], coverageGap: null }));
      results.push({
        checkId: 'S3',
        findings: [...base.findings, ...(hist.findings || [])],
        warnings: [...(base.warnings || []), ...(hist.warnings || []), ...(hist.coverageGap ? [`未查历史：${hist.coverageGap}`] : [])],
        coverageGap: base.coverageGap || null
      });
    }
    if (id === 'S6') results.push(await checkExternal(projectDir, { tier: effective, excludes }));
    if (id === 'D1') results.push(await checkData(projectDir, { tier: effective, excludes }));
    if (id === 'D2') results.push(await checkBackup(projectDir, { tier: effective, excludes }));
    if (id === 'D3') results.push(await checkPrivacy(projectDir, { tier: effective, excludes }));
    if (id === 'S4') results.push(await checkDeps(projectDir));
    if (id === 'S5') results.push(await checkConfig(projectDir, effective, { excludes }));
    if (id === 'Q1') results.push(await checkQ1(projectDir, { tier: effective, excludes, routeResult, run: runTests }));
    if (id === 'Q2') results.push(await checkQuality(projectDir, { tier: effective, run: runTests }));
    if (id === 'S2') results.push(await checkInject(projectDir, { tier: effective, excludes, routeResult }));
    if (id === 'S7') results.push(await checkAuthz(projectDir, { tier: effective, excludes, routeResult }));
    if (id === 'S8') results.push(await checkPassword(projectDir, { tier: effective, excludes }));
    if (id === 'H1') results.push(await checkHandover(projectDir, { tier: effective, excludes }));
    if (id === 'Q3') results.push(await checkMetrics(projectDir, { tier: effective, excludes }));
    if (id === 'C1') results.push(await checkLicense(projectDir, { tier: effective, excludes }));
    if (id === 'O1') results.push(await checkOps(projectDir, { tier: effective, excludes }));
  }

  let findings = results.flatMap((r) => r.findings);
  const warnings = [...routeResult.warnings, ...results.flatMap((r) => r.warnings || [])];
  if (effective === 'L1') findings = findings.map((f) => (f.checkId === 'S3' ? f : { ...f, force: 'tip' })); // L1 只有 S3 是硬卡
  // S7/S8 属文件级启发式，人工确认机制（v2）接入前一律 check 级，不自动锁死结论（三轮 reviewer P1#3/#13）
  findings = findings.map((f) => (f.checkId === 'S7' || f.checkId === 'S8') && f.force === 'card' ? { ...f, force: 'check', message: f.message + '（人工确认机制接入后升级为卡）' } : f);
  // gap 分两类：能力缺失（unavailable：缺 lockfile/二进制/配置）与未授权（unauthorized：runTests=false）。
  // 前者应封顶「无法验收」；后者只是证据待补，不能把整份结论压死，更不能因此判「拦」。
  const gapItems = results
    .filter((r) => r.coverageGap)
    .map((r) => ({ checkId: r.checkId, kind: gapKind(r), reason: r.coverageGap }));
  const gaps = gapItems.map(gapLabel);
  const conclusion = conclude(effective, findings, gapItems);

  return {
    projectDir,
    tier: { requested: tier, suggested: auto.suggestedTier, effective, signals: auto.signals, conservativeNote },
    gates: {
      planned,
      executed: results.filter((r) => !r.coverageGap).map((r) => r.checkId),
      gaps,
      gapItems, // 保留 gaps 字符串兼容老调用方；gapItems 带 kind 供结论分级
    },
    findings,
    conclusion,
    warnings,
  };
}

// gap 归类：检查自己声明了 gapKind 就照办；Q2 与 Q1 共用 runTests 开关，
// 未授权路径（quality.mjs 的「未授权 runTests」文案）不改源文件也能识别
function gapKind(r) {
  if (r.gapKind === 'unauthorized' || r.gapKind === 'unavailable') return r.gapKind;
  if (r.checkId === 'Q2' && /未授权/.test(String(r.coverageGap || ''))) return 'unauthorized';
  return 'unavailable';
}

// coverageGap 可能自带「Q1：」前缀（历史文案），拼接时不重复加前缀
function gapLabel(g) {
  const reason = String(g.reason || '');
  return reason.startsWith(`${g.checkId}：`) ? reason : `${g.checkId}：${reason}`;
}

// 结论引擎（ACCEPTANCE §5，无歧义版）
function conclude(tier, findings, gapItems = []) {
  const unavailable = gapItems.filter((g) => g.kind !== 'unauthorized');
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
