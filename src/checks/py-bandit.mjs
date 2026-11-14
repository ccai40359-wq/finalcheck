// Python SAST 接入（round3 定案）：Bandit 是成熟工具，B608 SQLi / pickle / XXE /
// yaml.load / shell=True / 弱随机等 14 类是 FC 自研规则的空白面（pygoat 实测）。
// 本模块只做三件事：找 python+bandit、跑 JSON 扫描、把结果映射成 FC finding；
// 不复述 Bandit 的判定逻辑。没装 → coverageGap（fail-closed），不冒充通过。
import path from 'node:path';
import { runProcess } from '../run-async.mjs';
import { listTextFiles } from '../walk.mjs';
import { isNonProductPath } from '../scope-policy.mjs';

// Bandit test_id → FC checkId（B105/106/107 硬编码口令 → S3；B324/B303 弱哈希 → S8；
// B104 绑 0.0.0.0 → O1；B201 Flask debug / B110 吞异常 / B113 无超时 → S5；其余安全类 → S2）
const CHECK_MAP = {
  B104: 'O1',
  B105: 'S3', B106: 'S3', B107: 'S3',
  B110: 'S5', B113: 'S5', B201: 'S5',
  B303: 'S8', B324: 'S8',
};
const SEVERITY_MAP = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };
const PY_CANDIDATES = ['python', 'python3', 'py'];
const EXCLUDE_DIRS = ['venv', '.venv', 'env', 'node_modules', '.git', 'dist', 'build', 'coverage', '.finalcheck'];
const SANITIZE_RE = /(['"])[^'"]{6,}\1/g;

function mask(raw) {
  return String(raw || '').replace(SANITIZE_RE, (m, q) => `${q}***${q}`).slice(0, 120);
}

// python + bandit 可用性：找到第一个能跑 `-m bandit --version` 的解释器并缓存。
// 没有就返回 null（调用方记 unavailable，不冒充通过）。
let cachedTooling = null;
export async function resolvePyBandit({ pythonBin = null } = {}) {
  if (pythonBin) {
    const r = await runProcess(pythonBin, ['-m', 'bandit', '--version'], { timeoutMs: 30000 });
    return r.status === 0 ? { pythonBin } : null;
  }
  if (cachedTooling !== null) return cachedTooling;
  for (const bin of PY_CANDIDATES) {
    const r = await runProcess(bin, ['-m', 'bandit', '--version'], { timeoutMs: 30000 });
    if (r.status === 0) {
      cachedTooling = { pythonBin: bin };
      return cachedTooling;
    }
  }
  cachedTooling = null;
  return null;
}

// 仓库里有多少「产品 .py 文件」：≥1 才值得跑 Bandit；缺口口径与语言缺口一致（≥5 才封顶结论）。
async function countPyProductFiles(projectDir, excludes, includeFixtures) {
  const { files } = await listTextFiles(projectDir, excludes, { includeFixtures });
  return files.filter((f) => /\.py$/i.test(f) && !isNonProductPath(path.relative(projectDir, f).replace(/\\/g, '/'))).length;
}

// 把 Bandit JSON 结果映射成 FC finding（checkId 按 CHECK_MAP，severity 高/中/低，
// rule 带原始 test_id 可追溯）。skipExisting = FC 自研规则已命中的 (checkId,file,line)，
// 避免同位双报（如 B105 与 S3.secret-literal 同行）。
export function mapBanditResults(json, { skipExisting = [] } = {}) {
  const parsed = typeof json === 'string' ? JSON.parse(json) : json;
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const skipSet = new Set(skipExisting.map((f) => `${f.checkId}|${String(f.file).replace(/\\/g, '/')}|${f.line}`));
  const findings = [];
  for (const item of results) {
    const testId = String(item.test_id || '');
    const checkId = CHECK_MAP[testId] || 'S2';
    const file = String(item.filename || '').replace(/\\/g, '/');
    const line = Number(item.line_number) || 0;
    const key = `${checkId}|${file}|${line}`;
    if (skipSet.has(key)) continue;
    findings.push({
      checkId,
      severity: SEVERITY_MAP[String(item.issue_severity || '').toUpperCase()] || 'high',
      force: 'card',
      file,
      line,
      rule: `bandit-${testId}`,
      snippet: mask(item.code),
      message: `${String(item.issue_text || '').trim()}（Bandit ${testId} ${item.test_name || ''}）`,
      source: 'program',
    });
  }
  return findings;
}

// 主入口：返回 { ran, findings, warnings, coverageGap }。
// ran=false 时 coverageGap 说明缺什么；ran=true 时 findings 可直接并入各 checkId。
export async function runPyBandit(projectDir, { excludes = [], includeFixtures = false, tooling = null, runner = null, minFiles = 1, gapThreshold = 5, tier = 'L2' } = {}) {
  const warnings = [];
  const pyCount = await countPyProductFiles(projectDir, excludes, includeFixtures);
  if (pyCount < minFiles) return { ran: false, findings: [], warnings, coverageGap: null, pyCount };

  const resolved = tooling || await resolvePyBandit();
  if (!resolved) {
    // 少量 .py 的 JS 仓不封顶；成规模 Python 仓按语言缺口口径封顶（与 scope-policy 同阈值）。
    const coverageGap = pyCount >= gapThreshold
      ? 'Bandit 未安装：Python SAST 未跑（SQLi/pickle/XXE/shell=True 等 14 类无法检查），pip install bandit 后重试'
      : null;
    return { ran: false, findings: [], warnings, coverageGap, pyCount };
  }
  const run = runner
    ? await runner(projectDir)
    : await runProcess(resolved.pythonBin, ['-m', 'bandit', '-r', projectDir, '-q', '-f', 'json', '-x', EXCLUDE_DIRS.join(',')], { timeoutMs: 180000, maxOut: 64 * 1024 * 1024 });
  // Bandit 语义：exit 0 = 没发现问题，exit 1 = 发现了问题（JSON 仍有效）。
  // 所以「有 JSON 就解析」，只有真的没输出/崩溃才记缺口——别把"发现了问题"当成"运行失败"。
  const hasJson = run.stdout && run.stdout.trim().startsWith('{');
  if (!hasJson) {
    return {
      ran: false, findings: [], warnings,
      coverageGap: `Bandit 运行失败（exit ${run.status ?? 'null'}${run.stderr ? `：${String(run.stderr).trim().slice(0, 160)}` : ''}），Python SAST 未覆盖`,
      pyCount,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (e) {
    return { ran: false, findings: [], warnings: [`Bandit 输出解析失败：${e.message}`], coverageGap: 'Bandit 输出无法解析，Python SAST 未覆盖', pyCount };
  }
  // 路径转相对：Bandit 给绝对路径（-r 指向项目根时 filename 为绝对或相对，取决于调用）
  const rootAbs = path.resolve(projectDir).replace(/\\/g, '/').toLowerCase();
  for (const f of parsed.results || []) {
    const abs = String(f.filename || '').replace(/\\/g, '/');
    if (abs.toLowerCase().startsWith(rootAbs)) f.filename = abs.slice(rootAbs.length).replace(/^\//, '');
  }
  const findings = mapBanditResults(parsed);
  // 夹具豁免口径与 audit 一致：非产品路径（tests/examples/...）不进产品结论
  const product = findings.filter((f) => !isNonProductPath(f.file));
  const skipped = findings.length - product.length;
  if (skipped) warnings.push(`Bandit：已跳过 ${skipped} 条非产品路径发现（tests/examples 等）`);
  // tier 语义与 FC 一致：L1 只认 S3 硬卡，其余降 tip（audit L1 映射也会兜一层）
  if (String(tier || 'L2').toUpperCase() === 'L1') {
    for (const f of product) if (f.checkId !== 'S3') f.force = 'tip';
  }
  return { ran: true, findings: product, warnings, coverageGap: null, pyCount };
}
