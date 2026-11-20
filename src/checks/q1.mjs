import { existsSync, readFileSync, statSync } from 'node:fs';
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

/**
 * 找到 npm 的 CLI 入口（npm-cli.js）。
 *
 * 2026-11-20 Linux 移植修的真 bug：原来只有一条路径 ——
 *   path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
 * 这条在 Windows 官方 Node 安装器下成立（npm 和 node.exe 一起装在 C:\Program Files\nodejs）。
 * **但在 Linux 上不成立**：npm 是随发行版单独安装的，
 *   实际位置是 /usr/lib/node_modules/npm/bin/npm-cli.js，
 *   而 node 的 execPath 是 /usr/bin/node → 找 /usr/bin/node_modules/... → 永远不存在。
 * 后果：Linux 上 Q1 永远报「npm-cli.js 未找到」→ 每条审计都记「覆盖不足」→
 * **所有项目都被判「无法验收」**（这是最严重的一类跨平台假红）。
 *
 * 现在按顺序找：① node 同目录 ② PATH 上的 npm ③ Linux/macOS 常见安装位置。
 */
function resolveNpmCli() {
  const candidates = [];
  // ① node 同目录（Windows 官方安装器、nvm、部分 macOS 打包）
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  // ② PATH 上的 npm（Linux 发行版通常是指向 npm-cli.js 的符号链接）
  for (const bin of ['npm', 'npm.cmd']) {
    const hit = findBinarySafe(bin);
    if (hit) candidates.push(hit);
  }
  // ③ Linux / macOS 常见位置（PATH 不可靠时兜底）
  candidates.push(
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js'
  );
  for (const c of candidates) {
    try { if (c && existsSync(c)) return c; } catch { /* 继续找 */ }
  }
  return null;
}

async function npmTest(projectDir) {
  const npmCli = resolveNpmCli();
  if (!npmCli) {
    return { error: new Error('未找到 npm-cli.js（已尝试：node 同目录 / PATH 上的 npm / /usr/lib/node_modules）') };
  }
  // npm-cli.js 是纯 JS，用 process.execPath 跑即可（PATH 上的 npm 最终也是它）
  return runProcess(process.execPath, [npmCli, 'test'], { cwd: projectDir, timeoutMs: 180000 });
}

// Python 测试入口（2026-11-17，解除纯 Python 仓的 Q1 语言缺口）。
//
// 判定顺序与 npm 侧同构：有测试目录才跑，跑了看退出码，不跑就记缺口（绝不默认通过）。
//   · pytest 优先（现代 Python 项目事实标准；`python -m pytest` 不依赖 PATH 上的 pytest 脚本）
//   · 退回落 `python -m unittest discover`（标准库自带，零安装）
// 明确不做：tox/nox 的组合矩阵（那是有意为之的多环境，跑哪一套要用户点名）。
const PY_TEST_DIR_RE = /^(?:tests?|__tests__)$/i;
const PY_TEST_FILE_RE = /^(?:test_.*\.py|.*_test\.py|conftest\.py)$/i;

function pyInterpreter() {
  for (const bin of ['python', 'python3', 'py']) {
    if (findBinarySafe(bin)) return bin;
  }
  return null;
}
function findBinarySafe(name) {
  // 只判「PATH 上能不能找到」：真跑失败会在退出码里体现，不在这里冒充可用
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of [''].concat(exts.map((e) => e.toLowerCase())) ) {
      if (existsSync(path.join(dir, name + ext))) return path.join(dir, name + ext);
    }
  }
  return null;
}

/** 仓库里有没有 Python 测试（只看测试目录/测试文件名，不猜） */
async function hasPythonTests(projectDir, excludes) {
  const { files } = await listTextFiles(projectDir, excludes, { includeFixtures: false });
  return files.some((f) => {
    const rel = String(f).replace(/\\/g, '/');
    const segs = rel.split('/');
    if (segs.some((s) => PY_TEST_DIR_RE.test(s))) return rel.endsWith('.py');
    return PY_TEST_FILE_RE.test(segs[segs.length - 1] || '');
  });
}

async function runPythonTests(projectDir) {
  const bin = pyInterpreter();
  if (!bin) return { error: new Error('未找到 python 解释器') };
  const r = await runProcess(bin, ['-m', 'pytest', '-q'], { cwd: projectDir, timeoutMs: 300000 });
  // pytest 不存在（exit 4 + "No module named pytest"）→ 退回标准库 unittest
  const stderr = String(r.stderr || '');
  if (r.status === 4 && /No module named pytest|No module named 'pytest'/i.test(stderr)) {
    const r2 = await runProcess(bin, ['-m', 'unittest', 'discover', '-q'], { cwd: projectDir, timeoutMs: 300000 });
    return { ...r2, runner: 'unittest（pytest 未安装，已退回标准库）' };
  }
  return { ...r, runner: 'pytest' };
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
    const covered = Number(v.covered), count = Number(v.total);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { error: '覆盖率必须在 0–100 之间' };
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(covered) || covered < 0 || covered > count) return { error: '覆盖率缺少有效样本总数/覆盖数' };
    if (Math.abs(covered / count * 100 - pct) > 0.11) return { error: '覆盖率与覆盖数/总数不一致' };
    return { metric, pct, covered, total: count };
  }
  return { error: '缺少 lines/statements/branches/functions 覆盖率字段' };
}

function coverageStamp(file) {
  try {
    const s = statSync(file, { bigint: true });
    return `${s.mtimeNs}:${s.ctimeNs}:${s.size}`;
  } catch { return null; }
}

async function coverageEvidenceOf(projectDir, previous) {
  const all = await findCoverageSummaries(projectDir);
  const summaries = all.filter((rel) => !previous.has(rel) || previous.get(rel) !== coverageStamp(path.join(projectDir, rel)));
  if (all.length && !summaries.length) return { status: 'stale' };
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
  let usePyRunner = false; // Python 仓走 pytest 分支（下面统一切换 runner 与文案）
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    if (!pkg.scripts?.test) {
      findings.push({ checkId: 'Q1', severity: 'medium', force, file: 'package.json', line: 0, rule: 'Q1.no-tests', snippet: '无 test 脚本', message: '项目没有测试脚本（npm test 不可用）', source: 'program' });
      return { checkId: 'Q1', findings, coverageGap: null, warnings };
    }
  } catch {
    // 2026-11-17：没有 package.json 时先看是不是 Python 仓——旧实现直接记「无 package.json，Q1 跳过」，
    // 纯 Python 仓（fastapi/tradingagents）因此被判覆盖不足，整份结论压成「无法验收」。
    const pyTests = await hasPythonTests(projectDir, excludes).catch(() => false);
    if (!pyTests) {
      // 真的没有可跑的东西（能力缺失），不是「用户没点头」
      return { checkId: 'Q1', findings, coverageGap: '无 package.json，且未发现 Python 测试（tests/ 或 test_*.py），Q1 跳过', warnings };
    }
    usePyRunner = true;
    warnings.push('Q1：未找到 package.json，按 Python 项目走 pytest / unittest discover');
  }
  // §7：外部项目禁跑被审代码的测试 → 记缺口，绝不因为「没跑」而当成通过
  // gapKind=unauthorized：只是等授权，别把整份结论压成「无法验收」/「拦」
  if (!run) return { checkId: 'Q1', findings, coverageGap: 'Q1：未授权执行测试（runTests=false），测试关未跑', gapKind: 'unauthorized', warnings };

  const previousCoverage = new Map();
  if (tier === 'L3') for (const rel of await findCoverageSummaries(projectDir)) previousCoverage.set(rel, coverageStamp(path.join(projectDir, rel)));
  const runnerName = usePyRunner ? 'Python 测试' : 'npm test';
  const runRes = usePyRunner ? await runPythonTests(projectDir) : await testRunner(projectDir);
  if (usePyRunner && runRes.runner) warnings.push(`Q1：Python 测试入口 = ${runRes.runner}`);
  if (runRes.error) {
    warnings.push(`${runnerName} 运行失败：${runRes.error.code || 'error'}（计覆盖不足）`);
    return { checkId: 'Q1', findings, coverageGap: `${runnerName} 无法运行`, warnings };
  }
  if (runRes.status !== 0) {
    const tail = String(runRes.stderr || runRes.stdout || '').trim().split('\n').slice(-5).join(' | ').slice(0, 280);
    findings.push({ checkId: 'Q1', severity: 'medium', force, file: `(${runnerName})`, line: 0, rule: 'Q1.tests-fail', snippet: `${runnerName} 退出码 ${runRes.status}：${tail}`, message: '测试未全绿', source: 'program' });
  }

  // L2 写接口（POST/PUT/PATCH/DELETE）必须在测试文件中有引用
  if (tier !== 'L1' && routeResult?.routes?.length) {
    const { files } = await listTextFiles(projectDir, excludes, { includeFixtures });
    // 2026-11-17：Python 测试文件名是 test_*.py / *_test.py，旧正则只认 *.test.js / tests/ 目录；
    // 后者靠目录名能命中一部分，但 test_auth.py 这种纯文件名形式会漏。
    const testFiles = files.filter((f) => /\.(test|spec)\.[cm]?jsx?$/i.test(f)
      || /[\\/](tests?|__tests__)[\\/]/i.test(f)
      || /[\\/](?:test_[^\\/]*\.py|[^\\/]*_test\.py|conftest\.py)$/i.test(f));
    let corpus = '';
    for (const f of testFiles) { try { corpus += readFileSync(f, 'utf8') + '\n'; } catch { /* 忽略不可读 */ } }
    for (const r of routeResult.routes) {
      if (!['post', 'put', 'patch', 'delete'].includes(r.method)) continue;
      // Python 路由的路径参数是 {user_id}，要一起剥掉，否则永远匹配不上测试里写的真实路径
      const literal = String(r.path || '')
        .replace(/:[^/]+/g, '')
        .replace(/\{[^/}]+\}/g, '')
        .replace(/\/{2,}/g, '/'); // 双斜杠归一 + 根路径跳过（三轮 P2#11）
      if (literal && literal !== '/' && !corpus.includes(literal)) {
        findings.push({ checkId: 'Q1', severity: 'medium', force, file: r.file, line: r.line, rule: 'Q1.write-route-untested', snippet: `${r.method.toUpperCase()} ${r.path}`, message: '写接口在测试文件中零引用——若无请补测试，若有请反馈误报', source: 'program' });
      }
    }
  }
  if (tier === 'L3') {
    // 覆盖率门槛只认 c8/nyc 真实产物：有产物才可能给 L3 过；没有产物 → 覆盖缺口，不给过。
    const cov = await coverageEvidenceOf(projectDir, previousCoverage);
    if (cov.status === 'stale') {
      return { checkId: 'Q1', findings, coverageGap: '本轮未生成或更新覆盖率产物（已有产物陈旧）', gapKind: 'unavailable', warnings };
    }
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
