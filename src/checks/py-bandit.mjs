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
// 只是「提醒你注意」的规则：导入了 pickle/subprocess（B4xx 黑名单导入）、用了 assert（B101）、
// 列表参数调用子进程（B603）、命令没写绝对路径（B607）——本身不是漏洞，真正的危险调用另有规则报。
const ADVISORY_TESTS = new Set(['B101', 'B403', 'B404', 'B405', 'B406', 'B407', 'B408', 'B409', 'B410', 'B411', 'B412', 'B413', 'B603', 'B607']);

// 2026-11-17 基准实测：以前所有 Bandit 结果一律 force:'card'，LOW 级提醒也算卡项进结论
// （Requests 的 16 条「S2」大多是测试辅助代码以外的 assert）。按 Bandit 自己给的分级落档：
//   提醒类 / LOW 严重度 → tip（列出但不计入结论）；LOW 置信度 → check（人工复核）；其余 card。
function banditForce(item) {
  const sev = String(item.issue_severity || '').toUpperCase();
  const conf = String(item.issue_confidence || '').toUpperCase();
  if (ADVISORY_TESTS.has(String(item.test_id))) return 'tip';
  // 硬编码口令/密钥（B105/B106/B107）Bandit 定为 LOW 严重度，但 S3 是各档都认的硬卡：不降档
  if (/^B10[567]$/.test(String(item.test_id))) return conf === 'LOW' ? 'check' : 'card';
  if (sev === 'LOW') return 'tip';
  if (conf === 'LOW') return 'check';
  return 'card';
}
const PY_CANDIDATES = ['python', 'python3', 'py'];
const EXCLUDE_DIRS = ['venv', '.venv', 'env', 'node_modules', '.git', 'dist', 'build', 'coverage', '.finalcheck'];
const SANITIZE_RE = /(['"])[^'"]{6,}\1/g;

function mask(raw) {
  return String(raw || '').replace(SANITIZE_RE, (m, q) => `${q}***${q}`).slice(0, 120);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
function validBanditResult(item) {
  return isObject(item) && /^B\d{3}$/.test(item.test_id)
    && hasText(item.filename) && Number.isInteger(item.line_number) && item.line_number > 0
    && ['HIGH', 'MEDIUM', 'LOW', 'UNDEFINED'].includes(item.issue_severity)
    && hasText(item.issue_text)
    && (item.code === undefined || typeof item.code === 'string')
    && (item.test_name === undefined || typeof item.test_name === 'string');
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
    if (!validBanditResult(item)) continue;
    const testId = String(item.test_id || '');
    const checkId = CHECK_MAP[testId] || 'S2';
    const file = String(item.filename || '').replace(/\\/g, '/');
    const line = Number(item.line_number) || 0;
    const key = `${checkId}|${file}|${line}`;
    if (skipSet.has(key)) continue;
    findings.push({
      checkId,
      severity: SEVERITY_MAP[String(item.issue_severity || '').toUpperCase()] || 'high',
      force: banditForce(item),
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
// ran 只表示完整扫描；部分扫描的已确认 findings 仍返回，但同时保留 coverageGap。
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
  let run;
  try {
    run = (runner
      ? await runner(projectDir)
      : await runProcess(resolved.pythonBin, ['-m', 'bandit', '-r', projectDir, '-q', '-f', 'json', '-x', EXCLUDE_DIRS.join(',')], { timeoutMs: 180000, maxOut: 64 * 1024 * 1024 })) || {};
  } catch (error) { run = { status: null, error }; }
  // exit 1 是发现漏洞；exit 2/超时/启动错误即使输出 JSON，也不能证明完整覆盖。
  const incomplete = [];
  if (![0, 1].includes(run.status) || run.error || run.timedOut || run.timed_out) {
    incomplete.push(`运行失败（exit ${run.status ?? 'null'}${run.error ? `：${String(run.error.message || run.error).slice(0, 160)}` : ''}）`);
  }
  const hasJson = typeof run.stdout === 'string' && run.stdout.trim().startsWith('{');
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
  if (!isObject(parsed) || !Array.isArray(parsed.results) || !Array.isArray(parsed.errors)) {
    incomplete.push('输出缺少合法 results/errors 数组');
  }
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  if (results.some((item) => !validBanditResult(item))) incomplete.push('results 含畸形条目');
  if (Array.isArray(parsed?.errors) && parsed.errors.length) {
    incomplete.push(`扫描 errors 非空（${parsed.errors.length} 个文件未完成）`);
  }
  // 路径转相对：Bandit 给绝对路径（-r 指向项目根时 filename 为绝对或相对，取决于调用）
  const rootAbs = path.resolve(projectDir).replace(/\\/g, '/').toLowerCase();
  const validResults = results.filter(validBanditResult).map((item) => ({ ...item }));
  for (const f of validResults) {
    const abs = String(f.filename || '').replace(/\\/g, '/');
    if (abs.toLowerCase().startsWith(`${rootAbs}/`)) f.filename = abs.slice(rootAbs.length + 1);
  }
  const findings = mapBanditResults({ results: validResults });
  // 夹具豁免口径与 audit 一致：非产品路径（tests/examples/...）不进产品结论
  const product = findings.filter((f) => !isNonProductPath(f.file));
  const skipped = findings.length - product.length;
  if (skipped) warnings.push(`Bandit：已跳过 ${skipped} 条非产品路径发现（tests/examples 等）`);
  // tier 语义与 FC 一致：L1 只认 S3 硬卡，其余降 tip（audit L1 映射也会兜一层）
  if (String(tier || 'L2').toUpperCase() === 'L1') {
    for (const f of product) if (f.checkId !== 'S3') f.force = 'tip';
  }
  const coverageGap = incomplete.length ? `Bandit 未完成：${incomplete.join('；')}，Python SAST 未完整覆盖` : null;
  return { ran: !coverageGap, findings: product, warnings, coverageGap, pyCount };
}
