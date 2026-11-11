import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { findBinary } from '../which.mjs';
import { runProcess } from '../run-async.mjs';

// S4 依赖 CVE（v1.2）：npm audit 为主判（Node 环境必得），osv-scanner 为增强
//
// 自食教训（2026-11-08 真仓自查三连）：
//   1) npm-cli 原来只按 process.execPath 同目录找 —— 桌面端 execPath 是 FinalCheck.exe，S4 必失；
//   2) 用户 registry（如 npmmirror）没实现 /-/npm/v1/security/advisories/bulk，会回 404；
//   3) 该 404 的 JSON 写在 stdout，含 message/uri、没有 vulnerabilities —— 旧代码会把它当「0 漏洞」静默放行。
// 现在：定位 npm-cli 走 npm_execpath/PATH；解析先分辨错误 JSON；只在「端点不支持」时回退官方 registry，并明示来源。
const SEV_MAP = { critical: 'high', high: 'high', moderate: 'medium', low: 'low' };
const NPMJS_REGISTRY = 'https://registry.npmjs.org';
const ENDPOINT_UNSUPPORTED_RE = /advisories\/bulk|NOT_IMPLEMENTED|not implemented|E404|\b404\b/i;

const npmCliRel = path.join('node_modules', 'npm', 'bin', 'npm-cli.js');

// 解析「用哪个 node 跑哪个 npm-cli」。exists 可注入，方便测试。
export function resolveNodeTooling({ execPath = process.execPath, env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const isWin = platform === 'win32';
  const nodeName = isWin ? 'node.exe' : 'node';
  const pathDirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);

  const nodeCandidates = [];
  if (env.FINALCHECK_NODE) nodeCandidates.push(env.FINALCHECK_NODE); // 打包环境显式指定
  if (/node(\.exe)?$/i.test(path.basename(execPath))) nodeCandidates.push(execPath); // CLI：node 本体
  for (const d of pathDirs) nodeCandidates.push(path.join(d, nodeName));
  const node = nodeCandidates.find((p) => exists(p)) || null;

  const npmCandidates = [];
  if (env.npm_execpath && /npm-cli\.js$/i.test(env.npm_execpath)) npmCandidates.push(env.npm_execpath);
  if (node) npmCandidates.push(path.join(path.dirname(node), npmCliRel));
  for (const d of pathDirs) npmCandidates.push(path.join(d, npmCliRel));
  const npmCli = npmCandidates.find((p) => exists(p)) || null;

  return { node, npmCli };
}

// 纯函数：npm audit 的 stdout → {kind:'ok'|'error'|'endpoint-unsupported'|'invalid'}
// 关键：errors-as-JSON 不能当 clean（旧版 npm 会把 endpoint 404 以 JSON 写 stdout）。
export function interpretAuditOutput(stdout) {
  if (!stdout || !String(stdout).trim()) return { kind: 'invalid', reason: '输出为空' };
  let j;
  try { j = JSON.parse(stdout); } catch { return { kind: 'invalid', reason: '输出不是 JSON' }; }
  if (!j || typeof j !== 'object') return { kind: 'invalid', reason: '输出不是对象' };
  if (!j.vulnerabilities || typeof j.vulnerabilities !== 'object') {
    const text = String(j.error?.summary || j.error?.code || j.message || j.error || '').slice(0, 200);
    if (ENDPOINT_UNSUPPORTED_RE.test(text) || ENDPOINT_UNSUPPORTED_RE.test(String(j.uri || ''))) {
      return { kind: 'endpoint-unsupported', reason: text || '审计端点不支持' };
    }
    return { kind: 'error', reason: text || '缺少 vulnerabilities 字段' };
  }
  return { kind: 'ok', vulnerabilities: j.vulnerabilities };
}

export function buildAuditArgs({ registry } = {}) {
  const args = ['audit', '--json', '--package-lock-only'];
  if (registry) args.push(`--registry=${registry}`);
  return args;
}

async function runNpmAudit(projectDir, { tooling, registry } = {}) {
  // 必须是真 node：Electron 的 process.execPath 是 FinalCheck.exe，不能拿它跑 npm-cli
  if (!tooling?.npmCli || !tooling?.node) return null;
  // 异步子进程（不能用 spawnSync：会卡死 Electron 主进程 → 界面未响应）
  return runProcess(tooling.node, [tooling.npmCli, ...buildAuditArgs({ registry })], { cwd: projectDir, timeoutMs: 120000 });
}

// 所有 workspace lockfile 都要扫：根目录 + 任意子目录（monorepo 的 desktop/ 等）。
// 排除 node_modules / release-* / dist-* / *-unpacked / fixtures；隐藏目录默认跳过。
const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']);
const LOCK_SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.next', 'vendor']);
const LOCK_BUILD_DIR_RE = /^(?:dist|build|out|release|release-[A-Za-z0-9._-]+|dist-[A-Za-z0-9._-]+|[A-Za-z0-9._-]+-unpacked)$/i;

export async function discoverLockfiles(projectDir, { maxDepth = 8 } = {}) {
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
        if (LOCK_SKIP_DIRS.has(lower) || lower === 'fixtures') continue;
        if (LOCK_BUILD_DIR_RE.test(e.name)) continue;
        await walk(p, depth + 1);
        continue;
      }
      if (LOCKFILE_NAMES.has(e.name)) out.push(rel);
    }
  }
  await walk(rootDir, 0);
  // 根 lockfile 优先；其余按路径深度、字典序，报告稳定可复现。
  out.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

// 零外部依赖的 lockfile（常见于测试夹具/纯本地项目）没有可审计的第三方包：
// 直接按「已审计且 0 漏洞」计，避免为了一个空锁文件去访问 registry。
// 只对 npm 系 JSON 锁文件做这个判定；yarn/pnpm 或解析失败一律照常跑 audit。
function hasNoExternalDeps(absLock) {
  if (!/\.json$/i.test(absLock)) return false;
  let j;
  try { j = JSON.parse(readFileSync(absLock, 'utf8')); } catch { return false; }
  if (!j || typeof j !== 'object') return false;
  if (!j.packages && !j.dependencies) return false;
  const pkgKeys = Object.keys(j.packages || {}).filter((k) => k !== '');
  const depKeys = Object.keys(j.dependencies || {});
  return pkgKeys.length === 0 && depKeys.length === 0;
}

// 为每个漏洞定位 lockfile 里对应依赖的行号：同一 lockfile 的多条 S4 发现不能都落在 line 0，
// 否则跨副本去重会按「同检查/同规则/同路径/同行号」把它们合并成一条（会丢掉 desktop 的 electron high）。
function dependencyLine(absLock, name) {
  const n = String(name || '');
  if (!n || !/\.json$/i.test(absLock)) return 0;
  try {
    const lines = readFileSync(absLock, 'utf8').split('\n');
    for (const key of [`"node_modules/${n}"`, `"${n}":`]) {
      const idx = lines.findIndex((l) => l.includes(key));
      if (idx >= 0) return idx + 1;
    }
  } catch { /* 定位失败保持 0，不伪造行号 */ }
  return 0;
}

async function auditOneLockfile(projectDir, rel, { tooling, warnings, auditRunner, interpret, preferredRegistry = null }) {
  const dir = path.resolve(projectDir, path.dirname(rel));
  let registry = preferredRegistry;
  // 已经确认本机 registry 不支持审计端点时，后续 lockfile 直接走官方源，避免每个子项目都重复一次 404 往返。
  let run = await auditRunner(dir, { tooling, ...(registry ? { registry } : {}) });
  if (run?.error) return { error: `npm audit 启动失败：${run.error.message}`, registry };
  let out = interpret(run?.stdout);

  // 只在「registry 没实现审计端点」时回退官方源；401/网络/锁文件损坏等一律如实报 gap，不掩盖故障。
  if (!preferredRegistry && out.kind === 'endpoint-unsupported') {
    const reason1 = out.reason;
    const retry = await auditRunner(dir, { tooling, registry: NPMJS_REGISTRY });
    const out2 = interpret(retry?.stdout);
    if (out2.kind === 'ok') {
      out = out2;
      registry = NPMJS_REGISTRY;
      warnings.push(`${rel}：本机 npm registry 未实现审计端点（${reason1 || '404'}），已回退 ${NPMJS_REGISTRY}`);
    } else {
      out = out2;
    }
  }
  if (out.kind !== 'ok') return { error: `npm audit 失败：${out.reason || out.kind}`, registry };
  return { out, registry };
}

export async function checkDeps(projectDir, options = {}) {
  const lockfiles = options.lockfiles || await discoverLockfiles(projectDir);
  if (!lockfiles.length) {
    return {
      checkId: 'S4',
      findings: [],
      coverageGap: '未发现任何 lockfile（package-lock.json/npm-shrinkwrap.json/pnpm-lock.yaml/yarn.lock），依赖关未跑',
      warnings: [],
    };
  }

  const findings = [];
  const warnings = [];
  const tooling = options.tooling || resolveNodeTooling();
  if (!tooling.node || !tooling.npmCli) {
    return {
      checkId: 'S4',
      findings,
      coverageGap: `发现 ${lockfiles.length} 个 lockfile，但未找到 Node.js/npm（装 Node.js 后依赖关才可跑）：${lockfiles.join('、')}`,
      warnings,
    };
  }
  const auditRunner = options.auditRunner || runNpmAudit;
  const interpret = options.interpret || interpretAuditOutput;
  const osvPath = options.osvPath === undefined ? findBinary('osv-scanner') : options.osvPath;

  const failures = [];
  let auditRegistry = null;
  let auditedCount = 0;
  for (const rel of lockfiles) {
    const absLock = path.join(projectDir, rel);
    // 零外部依赖：lockfile 本身就是证据，不必访问 registry。
    if (hasNoExternalDeps(absLock)) { auditedCount++; continue; }
    const res = await auditOneLockfile(projectDir, rel, { tooling, warnings, auditRunner, interpret, preferredRegistry: auditRegistry });
    if (res.error) {
      failures.push(`${rel}：${res.error}`);
      warnings.push(`S4：${rel} 依赖审计未完成（${res.error}）；按覆盖缺口处理，不判为 0 漏洞`);
      continue;
    }
    if (res.registry) auditRegistry = res.registry;
    auditedCount++;
    for (const [name, v] of Object.entries(res.out.vulnerabilities)) {
      const sev = SEV_MAP[v.severity] || 'high'; // 未知 severity fail-closed
      findings.push({ checkId: 'S4', severity: sev, force: sev === 'low' ? 'tip' : 'card', file: rel, line: dependencyLine(absLock, name), rule: 'S4.cve', snippet: `${name}（${v.range || '?'}）${v.severity}`, message: `依赖存在已知漏洞（${v.severity}）`, source: 'program' });
    }
    if (!osvPath) continue;
    const run2 = await runProcess(osvPath, ['--format', 'json', '--lockfile', absLock], { timeoutMs: 120000 });
    if (!run2.error && run2.stdout && run2.stdout.trim().startsWith('{')) {
      try {
        const osv = JSON.parse(run2.stdout);
        const seen = new Set(findings.filter((f) => f.file === rel).map((f) => f.snippet));
        for (const r of osv.results || []) for (const pkg of r.packages || []) for (const v of pkg.vulnerabilities || []) {
          const snip = `${pkg.package?.name || '?'}@${pkg.package?.version || '?'} ${v.id}`;
          if (!seen.has(snip)) findings.push({ checkId: 'S4', severity: 'high', force: 'card', file: rel, line: dependencyLine(absLock, pkg.package?.name), rule: 'S4.osv', snippet: snip, message: (v.summary || '已知漏洞（osv）').slice(0, 140), source: 'program' });
        }
      } catch { warnings.push(`${rel}：osv-scanner 输出解析失败（npm audit 结果不受影响）`); }
    }
  }
  if (!osvPath) warnings.push('osv-scanner 未安装：仅 npm audit 覆盖（广度足够日常使用）');

  const coverageGap = failures.length
    ? `${failures.length}/${lockfiles.length} 个 lockfile 未完成审计（不能当成 0 漏洞）：${failures.join('；')}`
    : null;
  if (auditedCount && failures.length) {
    warnings.push(`S4：${auditedCount}/${lockfiles.length} 个 lockfile 已审计完成；其余按覆盖缺口计`);
  }
  return { checkId: 'S4', findings, coverageGap, warnings, auditRegistry };
}
