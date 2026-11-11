import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles } from '../walk.mjs';
import { runProcess } from '../run-async.mjs';

// Q1 测试真跑（ACCEPTANCE §4-C）：不认"写了测试"认"npm test 绿"；L2 加写接口测试引用检查
// L3 覆盖率门槛（≥40%）只认 c8/nyc 的真实产物；没有产物 → coverageGap，绝不当成通过。
export const MIN_COVERAGE_PCT = 40;
const COVERAGE_SUMMARY_NAME = 'coverage-summary.json';
const COVERAGE_SKIP_DIRS = new Set(['node_modules', '.git', '.finalcheck', 'workflow-runs', '.next', 'vendor']);
const COVERAGE_BUILD_RE = /^(?:dist|build|out|release|release-[A-Za-z0-9._-]+|dist-[A-Za-z0-9._-]+|[A-Za-z0-9._-]+-unpacked)$/i;

async function npmTest(projectDir) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) return { error: new Error('npm-cli.js 未找到') };
  return runProcess(process.execPath, [npmCli, 'test'], { cwd: projectDir, timeoutMs: 180000 });
}

// 发现所有 coverage-summary.json（c8/nyc 的 json-summary reporter 产物）。
// 根 coverage/ 优先，其次浅层目录（monorepo 的 desktop/coverage/...）。
export async function findCoverageSummaries(projectDir, { maxDepth = 6 } = {}) {
  const out = [];
  const rootDir = path.resolve(String(projectDir || '.'));
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(rootDir, p).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        const lower = e.name.toLowerCase();
        if (COVERAGE_SKIP_DIRS.has(lower) || lower === 'fixtures' || COVERAGE_BUILD_RE.test(e.name)) continue;
        await walk(p, depth + 1);
        continue;
      }
      if (e.name === COVERAGE_SUMMARY_NAME) out.push(rel);
    }
  }
  await walk(rootDir, 0);
  out.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

// c8/nyc coverage-summary.json → { metric, pct, covered, total } 或 { error }。
// 优先 lines（行覆盖率），缺失时按 statements/branches/functions 顺序回退，并在报告里注明指标。
export function parseCoverageSummaryText(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { error: '不是 JSON' }; }
  const total = j && typeof j === 'object' ? (j.total || j) : null;
  if (!total || typeof total !== 'object') return { error: '缺少 total 节点' };
  for (const metric of ['lines', 'statements', 'branches', 'functions']) {
    const v = total[metric];
    if (!v || typeof v !== 'object') continue;
    const pct = Number(v.pct);
    if (!Number.isFinite(pct)) continue;
    return { metric, pct, covered: Number(v.covered) || 0, total: Number(v.total) || 0 };
  }
  return { error: '缺少 lines/statements/branches/functions 覆盖率字段' };
}

async function coverageEvidenceOf(projectDir) {
  const summaries = await findCoverageSummaries(projectDir);
  if (!summaries.length) return { status: 'missing' };
  let firstError = null;
  let firstFile = summaries[0];
  for (const rel of summaries) {
    let text;
    try { text = readFileSync(path.join(projectDir, rel), 'utf8'); } catch { continue; }
    const parsed = parseCoverageSummaryText(text);
    if (parsed.error) { if (!firstError) { firstError = parsed.error; firstFile = rel; } continue; }
    return { status: 'ok', file: rel, ...parsed, others: summaries.length - 1 };
  }
  return { status: 'invalid', file: firstFile, error: firstError || '产物不可读' };
}

const metricLabel = (metric) => ({ lines: '行覆盖率', statements: '语句覆盖率', branches: '分支覆盖率', functions: '函数覆盖率' }[metric] || metric);

export async function checkQ1(projectDir, { tier, excludes = [], routeResult = null, run = true, includeFixtures = false, testRunner = npmTest } = {}) {
  const findings = [];
  const warnings = [];
  const force = tier === 'L1' ? 'tip' : 'card';
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    if (!pkg.scripts?.test) {
      findings.push({ checkId: 'Q1', severity: 'medium', force, file: 'package.json', line: 0, rule: 'Q1.no-tests', snippet: '无 test 脚本', message: '项目没有测试脚本（npm test 不可用）', source: 'program' });
      return { checkId: 'Q1', findings, coverageGap: null, warnings };
    }
  } catch {
    // 没有 package.json = 本机没东西可跑（能力缺失），不是「用户没点头」
    return { checkId: 'Q1', findings, coverageGap: '无 package.json，Q1 跳过', warnings };
  }
  // §7：外部项目禁跑被审代码的测试 → 记缺口，绝不因为「没跑」而当成通过
  // gapKind=unauthorized：只是等授权，别把整份结论压成「无法验收」/「拦」
  if (!run) return { checkId: 'Q1', findings, coverageGap: 'Q1：未授权执行测试（runTests=false），测试关未跑', gapKind: 'unauthorized', warnings };

  const runRes = await testRunner(projectDir);
  if (runRes.error) {
    warnings.push(`npm test 运行失败：${runRes.error.code || 'error'}（计覆盖不足）`);
    return { checkId: 'Q1', findings, coverageGap: 'npm test 无法运行', warnings };
  }
  if (runRes.status !== 0) {
    const tail = String(runRes.stderr || runRes.stdout || '').trim().split('\n').slice(-5).join(' | ').slice(0, 280);
    findings.push({ checkId: 'Q1', severity: 'medium', force, file: '(npm test)', line: 0, rule: 'Q1.tests-fail', snippet: `npm test 退出码 ${runRes.status}：${tail}`, message: '测试未全绿', source: 'program' });
  }

  // L2 写接口（POST/PUT/PATCH/DELETE）必须在测试文件中有引用
  if (tier !== 'L1' && routeResult?.routes?.length) {
    const { files } = await listTextFiles(projectDir, excludes, { includeFixtures });
    const testFiles = files.filter((f) => /\.(test|spec)\.[cm]?jsx?$/i.test(f) || /[\\/](tests?|__tests__)[\\/]/i.test(f));
    let corpus = '';
    for (const f of testFiles) { try { corpus += readFileSync(f, 'utf8') + '\n'; } catch { /* 忽略不可读 */ } }
    for (const r of routeResult.routes) {
      if (!['post', 'put', 'patch', 'delete'].includes(r.method)) continue;
      const literal = r.path.replace(/:[^/]+/g, '').replace(/\/{2,}/g, '/'); // 双斜杠归一 + 根路径跳过（三轮 P2#11）
      if (literal && literal !== '/' && !corpus.includes(literal)) {
        findings.push({ checkId: 'Q1', severity: 'medium', force, file: r.file, line: r.line, rule: 'Q1.write-route-untested', snippet: `${r.method.toUpperCase()} ${r.path}`, message: '写接口在测试文件中零引用——若无请补测试，若有请反馈误报', source: 'program' });
      }
    }
  }
  if (tier === 'L3') {
    // 覆盖率门槛只认 c8/nyc 真实产物：有产物才可能给 L3 过；没有产物 → 覆盖缺口，不给过。
    const cov = await coverageEvidenceOf(projectDir);
    if (cov.status === 'missing') {
      warnings.push(`Q1：L3 覆盖率门槛未实测（缺 c8/nyc 产物 ${COVERAGE_SUMMARY_NAME}），按覆盖缺口计，不给 L3 通过`);
      return { checkId: 'Q1', findings, coverageGap: '覆盖率未实测（缺 c8/nyc 产物 coverage/coverage-summary.json）', gapKind: 'unavailable', warnings };
    }
    if (cov.status === 'invalid') {
      warnings.push(`Q1：覆盖率产物存在但无法解析（${cov.file}：${cov.error}），按覆盖缺口计`);
      return { checkId: 'Q1', findings, coverageGap: `覆盖率产物无法解析（${cov.file}：${cov.error}）`, gapKind: 'unavailable', warnings };
    }
    if (cov.others > 0) warnings.push(`Q1：发现 ${cov.others + 1} 个覆盖率产物，本轮取 ${cov.file}（根目录优先）`);
    if (cov.pct < MIN_COVERAGE_PCT) {
      findings.push({
        checkId: 'Q1',
        severity: 'medium',
        force,
        file: cov.file,
        line: 0,
        rule: 'Q1.coverage-below-threshold',
        snippet: `${metricLabel(cov.metric)} ${cov.pct}%（门槛 ${MIN_COVERAGE_PCT}%）`,
        message: `L3 覆盖率门槛未达标：${metricLabel(cov.metric)} ${cov.pct}% < ${MIN_COVERAGE_PCT}%（来源 ${cov.file}）`,
        source: 'program',
      });
      warnings.push(`Q1：L3 覆盖率门槛实测未达标（${cov.file} ${metricLabel(cov.metric)} ${cov.pct}% < ${MIN_COVERAGE_PCT}%）`);
    } else {
      warnings.push(`Q1：L3 覆盖率门槛已实测（${cov.file} ${metricLabel(cov.metric)} ${cov.pct}% ≥ ${MIN_COVERAGE_PCT}%）`);
    }
  }
  return { checkId: 'Q1', findings, coverageGap: null, warnings };
}
