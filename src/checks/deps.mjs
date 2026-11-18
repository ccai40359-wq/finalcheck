import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { findBinary } from '../which.mjs';
import { runProcess } from '../run-async.mjs';
import { requirementsTextFromLock, parsePyprojectDepNames, isExactVersion } from './py-lock-to-requirements.mjs';
import { queryOsvBatch } from './py-osv.mjs';
import { isNonProductPath } from '../scope-policy.mjs';

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
//
// 生态声明（只做发现，不新增扫描器）：
//   - npm 系（package-lock/npm-shrinkwrap/yarn/pnpm）交给现有 npm audit；pnpm/yarn 若 npm audit
//     不认（如 “This command requires an existing lockfile”）仍按失败/gap 处理。
//   - 其余生态只记录 lockfile 存在性，由 coverageGap 按生态逐条声明「未接入审计」。
//     ecosystem 用稳定的小写标识（npm/go/python/php/java），展示文案再映射成正式名称。
export const LOCKFILE_TYPES = Object.freeze({
  'package-lock.json': { ecosystem: 'npm', auditable: true },
  'npm-shrinkwrap.json': { ecosystem: 'npm', auditable: true },
  'yarn.lock': { ecosystem: 'npm', auditable: true },
  'pnpm-lock.yaml': { ecosystem: 'npm', auditable: true },
  'go.sum': { ecosystem: 'go', auditable: false },
  // 2026-11-17：uv/poetry/Pipfile 锁文件里包名+版本都是写死的，转成 `name==version`
  // 后 pip-audit 直接能查（不再需要 osv-scanner）。pyproject.toml 仍是版本**范围**，
  // 审计会给假精确的结论，保持 not auditable（诚实记「未锁定」）。
  'uv.lock': { ecosystem: 'python', auditable: true },
  'poetry.lock': { ecosystem: 'python', auditable: true },
  'Pipfile.lock': { ecosystem: 'python', auditable: true },
  'requirements.txt': { ecosystem: 'python', auditable: true },
  'requirements-dev.txt': { ecosystem: 'python', auditable: true },
  'pyproject.toml': { ecosystem: 'python', auditable: false },
  'composer.lock': { ecosystem: 'php', auditable: false },
  'pom.xml': { ecosystem: 'java', auditable: false },
  'gradle.lockfile': { ecosystem: 'java', auditable: false },
  'Gemfile.lock': { ecosystem: 'ruby', auditable: false },
  'Cargo.lock': { ecosystem: 'rust', auditable: false },
});
const ECOSYSTEM_LABEL = { npm: 'npm', go: 'Go', python: 'Python', php: 'PHP', java: 'Java', ruby: 'Ruby', rust: 'Rust' };
const LOCK_SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.next', 'vendor']);
const LOCK_BUILD_DIR_RE = /^(?:dist|build|out|release|release-[A-Za-z0-9._-]+|dist-[A-Za-z0-9._-]+|[A-Za-z0-9._-]+-unpacked)$/i;

// 发现结果带 ecosystem/auditable；导出给需要调用方判断「能不能交给 npm audit」。
export async function discoverLockfileEntries(projectDir, { maxDepth = 8 } = {}) {
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
      const type = LOCKFILE_TYPES[e.name];
      if (type) out.push({ path: rel, ecosystem: type.ecosystem, auditable: type.auditable });
    }
  }
  await walk(rootDir, 0);
  // 根 lockfile 优先；其余按路径深度、字典序，报告稳定可复现。
  out.sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// 兼容旧调用方：默认仍返回路径字符串（tests/finalcheck-evidence.test.mjs 依赖该形状）。
// 需要 ecosystem/auditable 时传 { withMeta: true } 或直接用 discoverLockfileEntries。
export async function discoverLockfiles(projectDir, { maxDepth = 8, withMeta = false } = {}) {
  const entries = await discoverLockfileEntries(projectDir, { maxDepth });
  return withMeta ? entries : entries.map((e) => e.path);
}

function describeLockfile(rel) {
  const base = path.posix.basename(String(rel).replace(/\\/g, '/'));
  const type = LOCKFILE_TYPES[base];
  if (type) return { path: String(rel).replace(/\\/g, '/'), ecosystem: type.ecosystem, auditable: type.auditable };
  // 兼容注入的自定义 lockfile 名（旧调用方只传 npm 锁文件路径）：按 npm 审计处理。
  return { path: String(rel).replace(/\\/g, '/'), ecosystem: 'npm', auditable: true };
}

function normalizeLockfileEntries(lockfiles) {
  const out = [];
  const seen = new Set();
  for (const item of lockfiles || []) {
    const entry = typeof item === 'string'
      ? describeLockfile(item)
      : describeLockfile(item?.path ?? item?.rel ?? '');
    if (item && typeof item === 'object') {
      if (typeof item.ecosystem === 'string' && item.ecosystem) entry.ecosystem = item.ecosystem;
      if (typeof item.auditable === 'boolean') entry.auditable = item.auditable;
    }
    if (!entry.path || seen.has(entry.path)) continue;
    seen.add(entry.path);
    out.push(entry);
  }
  return out;
}

// 按生态汇总非 npm lockfile，逐条给出「某生态未接入审计（发现 ...）」，不合并成一句“无 lockfile”。
//
// 2026-11-17：Python 生态已接了 requirements/npm-style 审计 + uv/poetry/Pipfile 锁文件 OSV 查询。
// 剩下的 pyproject.toml 只有版本**范围**（>=0.3.81），审计会给假精确结论——它不是「能力缺失」，
// 而是「这类文件本身不可审」。所以：
//   · 同生态**已有可审计的锁文件**被审过 → pyproject 不再封顶结论，改成 note（结论可信度不受影响）
//   · 同生态一个可审计文件都没有 → 仍按 unavailable 封顶（老实说「这个生态没查」）
function nonNpmGaps(entries, auditedEcosystems = new Set()) {
  const byEco = new Map();
  for (const e of entries) {
    if (e.auditable) continue;
    if (!byEco.has(e.ecosystem)) byEco.set(e.ecosystem, []);
    const files = byEco.get(e.ecosystem);
    if (!files.includes(e.path)) files.push(e.path);
  }
  return [...byEco.entries()].map(([eco, files]) => {
    const label = ECOSYSTEM_LABEL[eco] || eco;
    if (auditedEcosystems.has(eco)) {
      // 版本范围文件：说明为什么不审，但不把整份结论压成「无法验收」
      return `__note__${label}：${files.join('、')} 只声明版本范围（非锁定版本），不做漏洞审计；该生态的锁定依赖已另行审计`;
    }
    return `${label} 生态未接入审计（发现 ${files.join('、')}）`;
  });
}

// pip-audit 可用性（缓存）：优先 PATH 上的 pip-audit，退回 python -m pip_audit。
let cachedPipAudit = null;
export async function resolvePipAudit() {
  if (cachedPipAudit !== null) return cachedPipAudit;
  const direct = await runProcess('pip-audit', ['--version'], { timeoutMs: 30000 });
  if (direct.status === 0) {
    cachedPipAudit = { cmd: 'pip-audit', prefix: [] };
    return cachedPipAudit;
  }
  for (const py of ['python', 'python3', 'py']) {
    const r = await runProcess(py, ['-m', 'pip_audit', '--version'], { timeoutMs: 30000 });
    if (r.status === 0) {
      cachedPipAudit = { cmd: py, prefix: ['-m', 'pip_audit'] };
      return cachedPipAudit;
    }
  }
  cachedPipAudit = null;
  return null;
}

// pip-audit JSON → {items:[{name, version, id, description}], names:[已审计包名]}。
// requireSchema=true 时要求 dependencies 必须是数组：2xx/exit-0 但结构不对的错误载荷
// （代理拦截页、未来 schema 变化）绝不能当成「0 漏洞」，由调用方记缺口。
export function interpretPipAuditJson(json, { requireSchema = false } = {}) {
  const parsed = typeof json === 'string' ? JSON.parse(json) : json;
  if (requireSchema && (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.dependencies))) {
    throw new Error('dependencies 不是数组（pip-audit 输出结构不可信）');
  }
  const deps = Array.isArray(parsed?.dependencies) ? parsed.dependencies : [];
  const out = [];
  const names = [];
  // pip-audit 用 skip_reason 标「这个包没审」（无法解析/本地包/私有源），不能算进已审计
  const skipped = [];
  for (const dep of deps) {
    const name = String(dep?.name || '?');
    if (dep?.skip_reason != null) { skipped.push(`${name}（${String(dep.skip_reason).slice(0, 100)}）`); continue; }
    if (dep?.name) names.push(name.toLowerCase());
    for (const v of dep?.vulns || []) {
      out.push({
        name,
        version: String(dep?.version || '?'),
        id: String(v?.id || v?.aliases?.[0] || 'UNKNOWN'),
        description: String(v?.description || ''),
      });
    }
  }
  return { items: out, names, skipped };
}

/**
 * requirements.txt 的 OSV 兜底解析：pip-audit 超时/崩溃时用。
 * 只接受**精确锁定**条目（`name==1.2.3`）；无版本/范围/extras/`.`-e 一律进 unlocked 清单，
 * 由调用方点名说明「这些条目没查」，绝不静默当成已审计。
 * @returns {{deps:Array<{name,version}>, unlocked:string[]} | null}
 */
function osvFallbackForRequirements(absReq, relReq) {
  let text;
  try { text = readFileSync(absReq, 'utf8'); } catch { return null; }
  const deps = [];
  const unlocked = [];
  for (const raw of text.split('\n')) {
    const line = String(raw || '').replace(/(^|\s)#.*$/, '').replace(/\\\s*$/, '').trim();
    if (!line) continue;
    // 纯选项行（--hash 续行、--index-url 等）不是依赖条目，跳过不影响覆盖率；
    // 但 -r/-c（引入别的文件）、-e/路径/URL（本地或 VCS 依赖）都是**真依赖**，
    // 兜底查不了就必须点名，不能静默跳过（2026-11-17 修复：旧实现把所有 `-` 开头的行
    // 都跳过，结果提示「全部条目已覆盖」，实际 -r 引入的整个文件都没查）。
    if (/^--(?:hash|index-url|extra-index-url|trusted-host|find-links|pre|prefer-binary|no-binary|only-binary|require-hashes)\b/.test(line)) continue;
    if (/^(?:-r|-c|--requirement|--constraint|-e|--editable)\b/.test(line) || /^[.\/~]/.test(line) || /:\/\//.test(line)) {
      unlocked.push(line.slice(0, 60));
      continue;
    }
    const m = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*)\s*\[[^\]]*\]\s*==\s*([^\s;]+)/.exec(line)
      || /^(?:[A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s;]+)/.exec(line);
    if (!m) { unlocked.push(line.slice(0, 60)); continue; }
    const nameM = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (!nameM) { unlocked.push(line.slice(0, 60)); continue; }
    if (!isExactVersion(m[1])) { unlocked.push(line.slice(0, 60)); continue; }
    deps.push({ name: nameM[1], version: m[1] });
  }
  return { deps, unlocked };
}

/** 统一的目录键（相对父目录；根目录用空串），供 pyproject 覆盖判定用。 */
function normDir(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** PEP 503 归一：大小写不敏感，-_. 等价。 */
function normPkgName(n) {
  return String(n || '').toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * pyproject 里声明的名字是否就是项目自身（自引用 extras 如 `mypkg[dev]` 很常见）。
 * 判定依据：与 pyproject 自己的 `[project].name` / `[tool.poetry].name` 一致，
 * 或与所在目录名一致（根目录取项目目录名）。
 * 自身包不是第三方依赖，没被锁定文件覆盖不算缺口。
 * 2026-11-17 修复：旧实现只比目录名，根目录的相对路径是空串 → 永远判不出自身。
 */
function isSelfPackageName(name, dir, projectDir, projectName = '') {
  const n = normPkgName(name);
  if (projectName && n === normPkgName(projectName)) return true;
  const rel = String(dir || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  const base = rel || String(projectDir || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  if (!base) return false;
  return n === normPkgName(base);
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
// requirements.txt 同理：pip-audit 的每条发现都要落在对应包那一行，pygoat 实测 15 包/299 advisory 曾塌成 1 条。
function dependencyLine(absLock, name) {
  const n = String(name || '');
  if (!n) return 0;
  try {
    const lines = readFileSync(absLock, 'utf8').split('\n');
    if (/\.json$/i.test(absLock)) {
      // Pipfile.lock：`"name": {` 这样的键行；package-lock 先找 node_modules 路径再退回包名
      for (const key of [`"node_modules/${n}"`, `"${n}":`]) {
        const idx = lines.findIndex((l) => l.includes(key));
        if (idx >= 0) return idx + 1;
      }
      return 0;
    }
    // uv.lock / poetry.lock：定位到该包 `[[package]]` 段里的 `name = "x"` 行。
    // 不定位的话所有锁文件漏洞都落在 line 0，去重会按「同文件同行」把它们合并成一条
    // （tradingagents 实测 36 个漏洞包只剩 1 条，advisory 全丢）。
    if (/^(?:uv|poetry)\.lock$/i.test(absLock.replace(/\\/g, '/').split('/').pop())) {
      const target = n.toLowerCase();
      const idx = lines.findIndex((l) => {
        const m = /^name\s*=\s*"([^"]+)"/.exec(l.trim());
        return !!m && m[1].toLowerCase() === target;
      });
      if (idx >= 0) return idx + 1;
      return 0;
    }
    // requirements.txt：包名按 PEP 503 归一（大小写不敏感、-_. 等价），匹配行首的 requirement 行；
    // 跳过空行/注释/`-r`、`--hash` 等指令行。定位不到保持 0，不伪造行号。
    if (/requirements[^\\/]*\.txt$/i.test(absLock)) {
      const norm = (s) => String(s || '').toLowerCase().replace(/[-_.]+/g, '-');
      const target = norm(n);
      const idx = lines.findIndex((l) => {
        const t = l.trim();
        if (!t || t.startsWith('#') || t.startsWith('-')) return false;
        const m = t.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
        return !!m && norm(m[1]) === target;
      });
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
  const allEntries = options.lockfileEntries
    ? normalizeLockfileEntries(options.lockfileEntries)
    : options.lockfiles
      ? normalizeLockfileEntries(options.lockfiles)
      : await discoverLockfileEntries(projectDir);
  // 示例/测试/文档目录里的 lockfile 不是产品依赖面：examples/java/pom.xml、fixtures/yarn.lock
  // 不能把整个仓库封顶成「无法验收」；产品 lockfile 仍在下面的审计/缺口中处理。
  const entries = allEntries.filter((e) => !isNonProductPath(e.path));

  if (!entries.length && allEntries.length) {
    return {
      checkId: 'S4',
      findings: [],
      coverageGap: `仅发现非产品路径 lockfile（${allEntries.map((e) => e.path).slice(0, 3).join('、')}${allEntries.length > 3 ? '…' : ''}），依赖关未跑`,
      warnings: [],
      auditedCount: 0,
      lockfileEntries: allEntries,
    };
  }
  if (!entries.length) {
    return {
      checkId: 'S4',
      findings: [],
      coverageGap: '未发现任何可识别 lockfile（npm：package-lock.json/npm-shrinkwrap.json/pnpm-lock.yaml/yarn.lock；Go：go.sum；Python：uv.lock/poetry.lock/Pipfile.lock/requirements.txt/pyproject.toml；PHP：composer.lock；Java：pom.xml/gradle.lockfile；Ruby：Gemfile.lock；Rust：Cargo.lock），依赖关未跑',
      warnings: [],
      auditedCount: 0,
      lockfileEntries: [],
    };
  }

  // npm 生态走 npm audit；Python requirements 走 pip-audit（round4）；其余生态只声明发现。
  const npmEntries = entries.filter((e) => e.auditable && e.ecosystem === 'npm');
  const pyEntries = entries.filter((e) => e.auditable && e.ecosystem === 'python');
  // pyproject.toml 单独处理（它声明依赖名但没有锁定版本，判定要跟同目录已审计包名比对），
  // 不能走 nonNpmGaps 的「整个生态未接入」通用文案 —— 那样会把「声明的 django 没覆盖」
  // 这种精确缺口降级成一句笼统的生态声明。
  const pyprojectEntries = entries.filter((e) => e.ecosystem === 'python' && !e.auditable && /^pyproject\.toml$/i.test(path.basename(e.path)));
  const nonNpmEntries = entries.filter((e) => !e.auditable && !pyprojectEntries.includes(e));
  // 已审计生态：这些生态的锁定依赖本条会真查（npm audit / pip-audit / OSV 批量），
  // 所以同生态里「只有版本范围」的文件不该再封顶结论。
  const auditedEcosystems = new Set([
    ...npmEntries.map((e) => e.ecosystem),
    ...pyEntries.map((e) => e.ecosystem),
  ]);
  const gaps = nonNpmGaps(nonNpmEntries, auditedEcosystems);
  const findings = [];
  const warnings = [];
  let auditedCount = 0;
  let pyAuditedCount = 0;

  // 只有 pyproject（没有可审计的锁定文件）也要走下面的 pyproject 判定，
  // 否则「声明了 django 但没有任何锁定文件」会被一句通用缺口掩盖
  if (!npmEntries.length && !pyEntries.length && !pyprojectEntries.length) {
    return {
      checkId: 'S4',
      findings: [],
      coverageGap: gaps.join('；'),
      warnings: [],
      auditedCount: 0,
      pyAuditedCount: 0,
      lockfileEntries: entries,
    };
  }

  const failures = [];
  let auditRegistry = null;
  // npm 工具缺失只影响 npm 这一条路线，不能拿它去挡 Python（以前这里直接 return，
  // 结果「有 npm lockfile 但没装 node」的项目连 Python 依赖都不审了）。
  let npmToolingGap = null;
  if (npmEntries.length) {
    const tooling = options.tooling || resolveNodeTooling();
    if (!tooling.node || !tooling.npmCli) {
      npmToolingGap = `发现 ${npmEntries.length} 个 npm lockfile，但未找到 Node.js/npm（装 Node.js 后依赖关才可跑）：${npmEntries.map((e) => e.path).join('、')}`;
    }
  }
  if (npmEntries.length && !npmToolingGap) {
    const tooling = options.tooling || resolveNodeTooling();
    const auditRunner = options.auditRunner || runNpmAudit;
    const interpret = options.interpret || interpretAuditOutput;
    const osvPath = options.osvPath === undefined ? findBinary('osv-scanner') : options.osvPath;
    for (const entry of npmEntries) {
      const rel = entry.path;
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
  }

  // ── Python：两条独立路线 ──
  //   ① uv.lock / poetry.lock / Pipfile.lock → 直接查漏洞库（OSV 批量，一次请求几百包）
  //   ② requirements*.txt → pip-audit（它要处理 `.` / -e 这类非常规条目）
  // 两条路线**互不依赖**：以前整段被 pip-audit 是否安装挡住，害得纯 uv 项目在没装
  // pip-audit 的机器上仍然「无法验收」——而锁文件路线本来不需要 pip。
  const pyLockEntries = pyEntries.filter((e) => /^(?:uv\.lock|poetry\.lock|pipfile\.lock)$/i.test(path.basename(e.path)));
  const pyReqEntries = pyEntries.filter((e) => !pyLockEntries.includes(e));
  // pyproject 的覆盖判定需要「同目录审计到了哪些包」
  const auditedNamesByDir = new Map();
  const dirsWithAuditedDepFile = new Set();
  const noteAudited = (rel, names) => {
    const dir = normDir(rel);
    const set = auditedNamesByDir.get(dir) || new Set();
    for (const n of names) set.add(normPkgName(n));
    auditedNamesByDir.set(dir, set);
    dirsWithAuditedDepFile.add(dir);
  };

  if (pyEntries.length) {
    const pyFailures = [];
    let osvTool = null; // 锁文件路线用 OSV 批量（一次请求查几百包），延迟解析注入点
    for (const entry of pyLockEntries) {
      const abs = path.join(projectDir, entry.path);
      // ── 锁文件路线：包名+版本都已锁定 → OSV 批量查询 ──
      // 为什么不用 pip-audit：它逐包查询 + 建临时 venv 解析依赖树，实测 5 包 56 秒、
      // 199 包 >10 分钟（必然超时）。锁文件已经是完整解析结果，只需查漏洞库本身。
      const conv = requirementsTextFromLock(abs, entry.path);
      if (conv.error) {
        pyFailures.push(`${entry.path}：锁文件无法解析（${conv.error}）`);
        warnings.push(`S4：${entry.path} 未完成审计（${conv.error}）；按覆盖缺口处理，不判为 0 漏洞`);
        continue;
      }
      // 跳过项一律说出来：静默跳过会让「没查过」被读成「查过且没漏洞」
      const skippedReal = (conv.skipped || []).filter((s) => s.reason !== 'self');
      if (skippedReal.length) {
        const detail = skippedReal.slice(0, 5).map((s) => `${s.name}${s.version ? `@${s.version}` : ''}（${s.reason}）`).join('、');
        warnings.push(`S4：${entry.path} 有 ${skippedReal.length} 个条目未送漏洞库：${detail}${skippedReal.length > 5 ? ' 等' : ''}`);
      }
      if (!conv.deps.length) {
        // 合法锁文件但没有可查的第三方包（Pipfile 的空 default、只有元数据的 uv.lock）：
        // 这是「0 个包 = 0 条漏洞」，不是缺口。
        pyAuditedCount++;
        warnings.push(`S4：${entry.path} 没有需要查漏洞库的 PyPI 包（锁定条目 ${skippedReal.length} 个已列出原因）；按已审计计`);
        noteAudited(entry.path, []);
        continue;
      }
      if (!osvTool) osvTool = options.osvBatchRunner || queryOsvBatch;
      const q = await osvTool(conv.deps);
      if (!q.ok) {
        pyFailures.push(`${entry.path}：OSV 查询失败（${q.error}）`);
        warnings.push(`S4：${entry.path} 依赖审计未完成（OSV ${q.error}）；按覆盖缺口处理，不判为 0 漏洞`);
        continue;
      }
      pyAuditedCount++;
      noteAudited(entry.path, conv.deps.map((d) => d.name));
      warnings.push(`S4：${entry.path} 用 OSV 批量查询审计了 ${q.queried} 个锁定包（${q.affected.length} 个有已知漏洞）`);
      for (const a of q.affected) {
        const idLabel = a.ids.length > 3
          ? `${a.ids.slice(0, 3).join('、')} 等 ${a.ids.length} 条 advisory`
          : a.ids.join('、');
        findings.push({
          checkId: 'S4', severity: 'high', force: 'card',
          file: entry.path, line: dependencyLine(abs, a.name),
          rule: 'S4.osv',
          snippet: `${a.name}@${a.version}（${idLabel}）`,
          message: `依赖存在已知漏洞（OSV ${idLabel}）`,
          source: 'program',
        });
      }
    }


    // requirements 的 OSV 兜底（pip-audit 未安装 / 超时 / 崩溃时共用）。
    // 只查**精确锁定**的直接依赖；未锁定条目、-r/-e/路径/URL 条目点名记缺口。
    // 注意覆盖面比 pip-audit 小：pip-audit 会解析传递依赖，OSV 兜底只看文件里写明的条目——
    // 提示里必须说清，否则「兜底通过」会被读成「完整审计通过」。
    const tryRequirementsOsv = async (entry, abs, fb, why) => {
      if (!fb || !fb.deps.length) return false;
      if (!osvTool) osvTool = options.osvBatchRunner || queryOsvBatch;
      const q = await osvTool(fb.deps);
      if (!q.ok) return false;
      // 有条目兜底查不了（未锁定/-e/-r）→ 这个文件只算部分审计，不进「已审计 N/M」分子（缺口在下面单独记）
      if (!fb.unlocked.length) pyAuditedCount++;
      noteAudited(entry.path, fb.deps.map((d) => d.name));
      warnings.push(`S4：${entry.path} 的 ${why}，改用 OSV 批量审计了 ${q.queried} 个精确锁定的直接依赖（${q.affected.length} 个有已知漏洞）；传递依赖未解析、未审计${fb.unlocked.length ? `；另有 ${fb.unlocked.length} 个条目无法兜底：${fb.unlocked.slice(0, 6).join('、')}` : ''}`);
      for (const a of q.affected) {
        const idLabel = a.ids.length > 3
          ? `${a.ids.slice(0, 3).join('、')} 等 ${a.ids.length} 条 advisory`
          : a.ids.join('、');
        findings.push({
          checkId: 'S4', severity: 'high', force: 'card',
          file: entry.path, line: dependencyLine(abs, a.name),
          rule: 'S4.osv',
          snippet: `${a.name}@${a.version}（${idLabel}）`,
          message: `依赖存在已知漏洞（OSV ${idLabel}）`,
          source: 'program',
        });
      }
      if (fb.unlocked.length) gaps.push(`Python：${entry.path} 有 ${fb.unlocked.length} 个条目未锁定版本或引用了其他文件/本地路径（${why}，OSV 兜底查不了这些）：${fb.unlocked.slice(0, 8).join('、')}`);
      return true;
    };

    // requirements.txt 路线：pip-audit 按需探测（只在这一条路线需要）
    if (pyReqEntries.length) {
      const tool = options.pyAuditRunner ? null : await (options.resolvePipAudit || resolvePipAudit)();
      if (!tool && !options.pyAuditRunner) {
        // 没装 pip-audit 不等于查不了：精确锁定的条目直接走 OSV（与锁文件路线同一个接口）
        const notDone = [];
        for (const entry of pyReqEntries) {
          const abs = path.join(projectDir, entry.path);
          const fb = osvFallbackForRequirements(abs, entry.path);
          if (!(await tryRequirementsOsv(entry, abs, fb, 'pip-audit 未安装'))) notDone.push(entry.path);
        }
        if (notDone.length) pyFailures.push(`pip-audit 未安装（pip install pip-audit），以下 requirements 未审计（无精确锁定版本或 OSV 不可达）：${notDone.join('、')}`);
      } else {
        for (const entry of pyReqEntries) {
          const abs = path.join(projectDir, entry.path);
          const lockDir = path.dirname(abs);
          // ── requirements.txt 路线：pip-audit（cwd 固定到 requirements 所在目录，
          //    否则文件里的 `.` / -e 相对路径会解析失败）──
          let run;
          try {
            run = options.pyAuditRunner
              ? await options.pyAuditRunner(abs)
              : await runProcess(tool.cmd, [...tool.prefix, '-r', abs, '-f', 'json'], { cwd: lockDir, timeoutMs: 180000, maxOut: 64 * 1024 * 1024 });
          } catch (e) {
            pyFailures.push(`${entry.path}：pip-audit 启动失败（${e?.message || e}）`);
            continue;
          }
          const hasJson = run.stdout && run.stdout.trim().startsWith('{');
          if (!hasJson) {
            const reason = run.status === 124 ? '超时' : (String(run.stderr || '').trim().slice(0, 160) || '输出为空');
            // 兜底：pip-audit 超时/崩溃时，requirements 里**精确锁定**的条目仍能直接查 OSV
            // （实测 fastapi requirements 11 个包 pip-audit >180s，但 OSV 批量 1 秒级）。
            // 不精确的（无版本、范围、extras 未锁定）如实点名，不冒充查过。
            const fb = osvFallbackForRequirements(abs, entry.path);
            if (await tryRequirementsOsv(entry, abs, fb, `pip-audit ${reason}`)) continue;
            pyFailures.push(`${entry.path}：pip-audit 失败（${reason}）`);
            warnings.push(`S4：${entry.path} 依赖审计未完成（pip-audit ${reason}）${
              fb && !fb.deps.length ? '；requirements 里没有精确锁定版本（`name==x.y.z`），OSV 兜底也用不上——先锁版本再做依赖审计' : ''
            }；按覆盖缺口处理，不判为 0 漏洞`);
            continue;
          }
          let parsed;
          try {
            parsed = interpretPipAuditJson(run.stdout, { requireSchema: true });
          } catch (e) {
            pyFailures.push(`${entry.path}：pip-audit 输出解析失败（${e.message}）`);
            warnings.push(`S4：${entry.path} 依赖审计未完成（pip-audit JSON 不可信）；按覆盖缺口处理，不判为 0 漏洞`);
            continue;
          }
          // exit 0 = 无漏洞，exit 1 = 有漏洞（JSON 有效）；其它退出码/超时即使吐了 JSON 也只是部分结果。
          // 部分结果里的漏洞照常报，但这个文件按缺口算，不进「已审计」分子。
          const incomplete = [];
          if (![0, 1].includes(run.status) || run.timedOut || run.timed_out) incomplete.push(`pip-audit 异常退出（exit ${run.status ?? 'null'}）`);
          if (parsed.skipped.length) incomplete.push(`${parsed.skipped.length} 个依赖被 pip-audit 跳过：${parsed.skipped.slice(0, 5).join('、')}${parsed.skipped.length > 5 ? ' 等' : ''}`);
          if (incomplete.length) {
            pyFailures.push(`${entry.path}：${incomplete.join('；')}`);
            warnings.push(`S4：${entry.path} 依赖审计未完成（${incomplete.join('；')}）；按覆盖缺口处理，不判为 0 漏洞`);
          } else {
            pyAuditedCount++;
          }
          noteAudited(entry.path, parsed.names);
          // 同一包的多条 advisory 合成一条发现：行号按包定位（同包同行），不合并的话跨副本去重
          // 会按「同文件同行」塌缩；合并后 snippet/message 带上全部 advisory id，信息不丢。
          const byName = new Map();
          for (const v of parsed.items) {
            const key = String(v.name || '').toLowerCase();
            if (!byName.has(key)) byName.set(key, []);
            byName.get(key).push(v);
          }
          for (const group of byName.values()) {
            const first = group[0];
            const ids = group.map((v) => v.id).filter(Boolean);
            const idLabel = ids.length > 3
              ? `${ids.slice(0, 3).join('、')} 等 ${ids.length} 条 advisory`
              : (ids.join('、') || '未知 advisory');
            findings.push({ checkId: 'S4', severity: 'high', force: 'card', file: entry.path, line: dependencyLine(abs, first.name), rule: 'S4.pip-audit', snippet: `${first.name}@${first.version}（${idLabel}）`, message: `依赖存在已知漏洞（pip-audit ${idLabel}）：${String(first.description || '').slice(0, 120)}`, source: 'program' });
          }
        }
      }
    }

    if (pyFailures.length) {
      gaps.push(`Python：${pyFailures.length}/${pyEntries.length} 个依赖文件未完成审计（不能当成 0 漏洞）：${pyFailures.join('；')}`);
    }
    if (pyAuditedCount) warnings.push(`S4：Python 依赖已审计 ${pyAuditedCount}/${pyEntries.length} 个文件（requirements 走 pip-audit，uv/poetry/Pipfile 锁定文件走 OSV 批量）`);
  }

  // pyproject.toml：只有版本**范围**，不送漏洞库；但它声明了哪些运行时依赖是明确的，
  // 用「同目录已审计的包名集合」做覆盖判定（2026-11-17 review：以前只要同生态任意文件
  // 审计过就放行，导致 requirements-dev.txt 只含 pytest 也能把运行时依赖放成「已审」）：
  //   · 同目录没有任何依赖文件审计成功 → 真缺口（这个项目没查）
  //   · 声明了但同目录锁定的包名里没有 → 真缺口，点名缺哪些包
  //   · 声明的全部被覆盖 → 只写 note（依赖面已被覆盖，不封顶结论）
  const pyprojects = pyprojectEntries;
  for (const entry of pyprojects) {
    const abs = path.join(projectDir, entry.path);
    const dir = normDir(entry.path);
    let decl;
    try {
      decl = parsePyprojectDepNames(readFileSync(abs, 'utf8'));
    } catch (e) {
      gaps.push(`${entry.path}：无法读取（${e?.message || e}），声明的依赖未审计`);
      continue;
    }
    if (!decl.ok) { gaps.push(`${entry.path}：无法解析，声明的依赖未审计`); continue; }
    if (decl.unparsed && decl.unparsed.length) {
      gaps.push(`Python：${entry.path} 有 ${decl.unparsed.length} 条依赖声明解析不出包名，无法核对是否已审计：${decl.unparsed.slice(0, 5).join('、')}`);
    }
    if (decl.dynamic) {
      warnings.push(`S4：${entry.path} 的依赖是动态生成的（dynamic = ["dependencies"]），无法静态核对是否已被同目录锁定审计覆盖`);
      continue;
    }
    if (!decl.names.length) {
      warnings.push(`S4：${entry.path} 未声明运行时依赖（无 dependencies 列表），无需审计`);
      continue;
    }
    if (!dirsWithAuditedDepFile.has(dir)) {
      gaps.push(`Python 生态未接入审计：${entry.path} 声明了 ${decl.names.length} 个依赖（${decl.names.slice(0, 8).join('、')}${decl.names.length > 8 ? ' 等' : ''}），但同目录没有可审计的锁定文件/requirements`);
      continue;
    }
    const auditedNames = auditedNamesByDir.get(dir) || new Set();
    const missing = decl.names.filter((n) => !auditedNames.has(n) && !isSelfPackageName(n, dir, projectDir, decl.projectName));
    if (!missing.length) {
      warnings.push(`S4：${entry.path} 只声明版本范围（非锁定版本），不做漏洞审计；其声明的依赖已被同目录锁定文件审计覆盖`);
      continue;
    }
    gaps.push(`Python：${entry.path} 声明的 ${missing.slice(0, 8).join('、')}${missing.length > 8 ? ` 等 ${missing.length} 个` : ''} 未出现在同目录已审计的锁定依赖里（版本范围不可审，且这些包没被任何锁定文件覆盖）`);
  }

  // 分子/分母都只数 npm lockfile；非 npm 生态的缺口单独逐条列出，不并入“已审计”。
  // __note__ 前缀的条目是「说明」不是「缺口」：写进 warnings，不封顶结论
  for (const g of gaps) {
    if (g.startsWith('__note__')) warnings.push(`S4：${g.slice('__note__'.length)}`);
  }
  const parts = [];
  if (npmToolingGap) parts.push(npmToolingGap);
  if (failures.length && npmEntries.length) {
    parts.push(`${failures.length}/${npmEntries.length} 个 npm lockfile 未完成审计（不能当成 0 漏洞）：${failures.join('；')}`);
  }
  parts.push(...gaps.filter((g) => !g.startsWith('__note__')));
  const coverageGap = parts.length ? parts.join('；') : null;
  if (auditedCount && failures.length && npmEntries.length) {
    warnings.push(`S4：${auditedCount}/${npmEntries.length} 个 npm lockfile 已审计完成；其余按覆盖缺口计`);
  }
  return {
    checkId: 'S4',
    findings,
    coverageGap,
    warnings,
    auditRegistry,
    auditedCount,
    pyAuditedCount,
    lockfileEntries: entries,
  };
}
