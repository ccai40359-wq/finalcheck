import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { listTextFiles, readRel, prunedWarning } from './walk.mjs';

// X 下载闸（ACCEPTANCE §4-X）：只跑静态关 + registry 元数据查询，禁止执行被审项目任何代码
// X1 安装脚本 | X2 外呼清单 | X3 依赖投毒 | X4 README 注入

const REQUEST_CAP = 200;          // 单次扫描的总 registry 请求上限
const FETCH_TIMEOUT_MS = 15000;   // 全部 fetch 15s 超时
const MAX_DEPTH = 2;              // 直接依赖=层1，其依赖=层2（"直接依赖+2 层内"，registry 递归限深 2）
const MAX_NESTED_PACKAGE_JSON = 50; // monorepo 嵌套 package.json 枚举上限（根单独处理，不受此限）
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
// 白名单=注册域名级：精确等于或以其为后缀（.子域）才豁免；
// 子串匹配会被 evilnpmjs.example / not-github.com 这类仿冒主机绕过（P1#7）
const COMMON_HOSTS = ['npmjs.org', 'github.com', 'googleapis.com', 'w3.org', 'localhost', '127.0.0.1', 'schemastore.org', 'opensource.org', 'apache.org', 'jsdelivr.net', 'unpkg.com', 'cloudflare.com'];
const X4_PATTERNS = [
  /ignore\s+(all\s+)?previous/i,
  /disregard.*instruction/i,
  /system\s+prompt/i,
  /you\s+are\s+now/i,
];
const NAME_RE = /^(@[\w.-]+\/)?[\w.-]+$/;

// 只缓存成功结果，5 分钟内有效；失败不缓存，下一次调用重试。
// metaCache 按 name@spec 隔离——同包不同版本必须各自解析（v1.0.0 有 postinstall、v2.0.0 没有）。
const CACHE_MS = 5 * 60 * 1000;
const metaCache = new Map(); // `${name}@${range}` → { value, at }
const dlCache = new Map();   // name → { value, at }

const newNet = () => ({
  requests: 0,
  failures: 0,
  skipped: new Set(),          // registry 元数据因请求上限跳过
  unresolved: new Set(),       // 版本/来源未解析（registry 失败或范围无法匹配）
  downloadsUnverified: 0,      // 仅下载量接口失败：警告级，不进 coverageGap
});

export function parsePackageSpec(spec) {
  const match = /^(@[\w.-]+\/[\w.-]+|[\w.-]+)(?:@(.+))?$/.exec(String(spec || '').replace(/^['"]|['"]$/g, ''));
  return match && NAME_RE.test(match[1]) ? { name: match[1], range: match[2] || 'latest' } : null;
}

async function fetchJson(url, net, { downloads = false } = {}) {
  if (net.requests >= REQUEST_CAP) return undefined; // undefined = 超上限，本次没发请求
  net.requests += 1;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      // registry 元数据故障 = 覆盖缺口；下载量接口故障只降级为“下载量未验证”，不计入缺口。
      if (!downloads && res.status >= 500) net.failures += 1; // 404=包不存在不算 registry 故障
      return null;
    }
    return await res.json();
  } catch {
    if (!downloads) net.failures += 1;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 注意：不用 /latest —— 它不带 time 字段，X3 的"发布时间"必须读完整 packument。
// 按请求版本/范围解析：dist-tag 优先，其次精确版本，最后 semver 范围取最高匹配版本。
function parseRegistryDoc(doc, range = 'latest') {
  if (!doc || typeof doc !== 'object' || typeof doc.versions !== 'object') return null;
  const version = doc['dist-tags']?.[range] || (semver.valid(range) ? range
    : semver.validRange(range) ? semver.maxSatisfying(Object.keys(doc.versions), range) : null);
  const v = version ? doc.versions[version] : null;
  if (!v) return null;
  return {
    name: doc.name,
    version: v.version || version,
    scripts: v?.scripts && typeof v.scripts === 'object' ? v.scripts : {},
    dependencies: v?.dependencies && typeof v.dependencies === 'object' ? v.dependencies : {},
    time: doc.time && typeof doc.time === 'object' ? doc.time : null,
  };
}

// 返回 undefined=超上限未请求 | null=请求失败/不存在 | meta
async function getRegistryMeta(name, net, range = 'latest') {
  const key = `${name}@${range}`;
  const cached = metaCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (net.requests >= REQUEST_CAP) { net.skipped.add(key); return undefined; }
  const doc = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`, net);
  const meta = doc?.name === name ? parseRegistryDoc(doc, range) : null;
  if (meta) metaCache.set(key, { value: meta, at: Date.now() });
  else net.unresolved.add(key); // 失败不写缓存，避免把一次网络故障固化成“安全”
  return meta;
}

// 返回 undefined=超上限 | null=失败/非数字 | number
async function getDownloads(name, net) {
  const cached = dlCache.get(name);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (net.requests >= REQUEST_CAP) { net.downloadsUnverified += 1; return undefined; }
  const doc = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`, net, { downloads: true });
  const n = doc && typeof doc.downloads === 'number' && Number.isFinite(doc.downloads) ? doc.downloads : null;
  if (n === null) {
    // 下载量接口不可用/返回非数字：X3 降级为“下载量未验证”，不阻断安装。
    net.downloadsUnverified += 1;
    return null;
  }
  dlCache.set(name, { value: n, at: Date.now() });
  return n;
}

// 纯函数：registry meta → { scripts, ageDays, weeklyDownloads, verdict }
// verdict: 'risk'=黄牌（很新 或 下载量低）| 'ok' | 'unknown'=信息不足（如缺 time）
export function judgePackageMeta(meta) {
  const scripts = meta?.scripts && typeof meta.scripts === 'object' ? meta.scripts : {};
  const time = meta?.time && typeof meta.time === 'object' ? meta.time : null;
  const version = meta?.version || '';
  const created = time ? time.created || null : null; // 首次发布时间（冒烟教训：用最新版本时间会把知名包的新版本当新包）
  const ts = created ? Date.parse(created) : NaN;
  const ageDays = Number.isFinite(ts) ? Math.max(0, Math.floor((Date.now() - ts) / 86400000)) : null;
  const weeklyDownloads = typeof meta?.weeklyDownloads === 'number' && Number.isFinite(meta.weeklyDownloads) ? meta.weeklyDownloads : null;
  const fresh = ageDays !== null && ageDays < 30;
  const lowDl = weeklyDownloads !== null && weeklyDownloads < 100;
  const noTrackRecord = weeklyDownloads === null || weeklyDownloads < 10000; // 知名包发新版本不黄牌
  const verdict = lowDl || (fresh && noTrackRecord) ? 'risk' : ageDays === null ? 'unknown' : 'ok';
  return { scripts, ageDays, weeklyDownloads, verdict, version };
}

function lifecycleFindings(scripts, ctx) {
  const out = [];
  for (const key of INSTALL_SCRIPTS) {
    const val = scripts?.[key];
    if (typeof val !== 'string' || !val.trim()) continue;
    out.push({
      checkId: 'X1', severity: 'high', force: 'card', file: ctx.file, line: 0,
      rule: 'X1.lifecycle-script',
      snippet: `${ctx.name}@${ctx.version || '?'} ${key}: ${val.slice(0, 100)}`,
      message: `声明了 ${key} 安装脚本，npm install 时会自动执行任意代码`,
      source: 'program',
    });
  }
  return out;
}

function x3Finding(meta, judge) {
  const parts = [];
  if (judge.ageDays !== null && judge.ageDays < 30) parts.push(`首次发布仅 ${judge.ageDays} 天`);
  else if (judge.weeklyDownloads !== null && judge.weeklyDownloads < 100) parts.push(`周下载仅 ${judge.weeklyDownloads}`);
  if (judge.weeklyDownloads !== null) parts.push(`周下载 ${judge.weeklyDownloads}`);
  return {
    checkId: 'X3', severity: 'high', force: 'card', file: 'package.json', line: 0,
    rule: 'X3.fresh-or-lowdown',
    snippet: `${meta.name}@${meta.version || '?'}${parts.length ? '：' + parts.join('、') : ''}`,
    message: `这个包${parts.length ? ' ' + parts.join('、') : ' 无法确认新旧'}，typosquat/slopsquat 风险，装前建议人工确认（核对拼写、找官方源）`,
    source: 'program',
  };
}

// BFS 解析包图：depth0=目标包（localMeta 给出则不走网络），依赖层 1..MAX_DEPTH
// 返回 Map<name@version, { meta, depth }>；lockfile 中的锁定版本优先于 package.json 范围。
async function resolveGraph(rootName, localMeta, net, { range = 'latest', locks = new Map() } = {}) {
  const nodes = new Map();
  const queued = new Set([rootName, `${rootName}@${range}`]);
  let frontier = [{ name: rootName, range, lockPath: '', depth: 0, local: localMeta || null }];
  while (frontier.length) {
    const next = [];
    await Promise.all(frontier.map(async (job) => {
      let meta = job.local;
      if (!meta) {
        const m = await getRegistryMeta(job.name, net, job.range);
        if (!m) return; // undefined=超上限（已计 skipped），null=失败（已计 unresolved/failures）
        meta = m;
        const dl = await getDownloads(job.name, net);
        meta = { ...meta, weeklyDownloads: typeof dl === 'number' ? dl : null };
      }
      const key = job.local ? job.name : `${job.name}@${meta.version}`;
      if (!nodes.has(key)) nodes.set(key, { meta, depth: job.depth });
      if (job.depth >= MAX_DEPTH) return;
      for (const [dep, requested] of Object.entries(meta.dependencies || {})) {
        if (!NAME_RE.test(dep)) continue;
        let cursor = job.lockPath;
        let locked = null;
        for (;;) {
          const candidate = (cursor ? cursor + '/' : '') + 'node_modules/' + dep;
          if (locks.has(candidate)) { locked = { ...locks.get(candidate), lockPath: candidate }; break; }
          if (!cursor) break;
          const cut = cursor.lastIndexOf('/node_modules/');
          cursor = cut < 0 ? '' : cursor.slice(0, cut);
        }
        const depRange = locked?.version || String(requested || 'latest');
        if (locked?.resolved && !/^https:\/\/(?:registry\.npmjs\.org|registry\.npmmirror\.com|registry\.yarnpkg\.com)\//.test(locked.resolved)) {
          net.unresolved.add(`${dep}@${depRange}（非 registry 锁定来源）`); continue;
        }
        const queueKey = `${dep}@${depRange}`;
        if (queued.has(queueKey)) continue;
        queued.add(queueKey);
        next.push({ name: dep, range: depRange, lockPath: locked?.lockPath || '', depth: job.depth + 1, local: null });
      }
    }));
    frontier = next;
  }
  return nodes;
}

function collectGraphFindings(nodes, rootName) {
  const findings = [];
  for (const [, node] of nodes) {
    const name = node.meta.name;
    const isRoot = name === rootName && node.depth === 0;
    findings.push(...lifecycleFindings(node.meta.scripts, { name, version: node.meta.version, file: 'package.json' }));
    if (isRoot && !node.meta.weeklyDownloads && node.meta.weeklyDownloads !== 0) continue; // 本地根不算 X3
    const judge = judgePackageMeta(node.meta);
    if (judge.verdict === 'risk') findings.push(x3Finding(node.meta, judge));
  }
  return findings;
}

function finalizeNet(net, findings, warnings) {
  if (net.unresolved.size) warnings.push(`依赖版本/来源未解析：${[...net.unresolved].slice(0, 10).join('、')}`);
  if (net.skipped.size > 0) {
    findings.push({
      checkId: 'X1', severity: 'low', force: 'tip', file: 'package.json', line: 0,
      rule: 'X1.unresolved', snippet: '',
      message: `registry 请求超上限（${REQUEST_CAP}），${net.skipped.size} 个依赖未解析（安装脚本/投毒信号未覆盖，未解析部分明示）`,
      source: 'program',
    });
  }
  if (net.failures > 0) warnings.push(`registry 不可达或请求失败（${net.failures} 次），X1/X3 网络部分覆盖不全`);
  if (net.downloadsUnverified > 0) warnings.push(`下载量未验证（api.npmjs.org/downloads 失败或返回非数字，${net.downloadsUnverified} 个包），X3 的周下载量信号缺失`);
}

// 只把 registry 元数据/版本解析缺口算作 coverageGap；下载量未验证是警告，不阻断安装。
const netGap = (net) => net.failures || net.skipped.size || net.unresolved.size
  ? `X1/X3 覆盖不足：registry 失败 ${net.failures}，请求上限跳过 ${net.skipped.size}，版本/来源未解析 ${net.unresolved.size}` : null;

async function readNpmLocks(projectDir) {
  for (const file of ['npm-shrinkwrap.json', 'package-lock.json']) {
    try {
      const lock = JSON.parse(await readFile(path.join(projectDir, file), 'utf8'));
      const entries = new Map(Object.entries(lock.packages || {}).filter(([key]) => key));
      const visit = (deps, parent = '') => {
        for (const [name, entry] of Object.entries(deps || {})) {
          const key = (parent ? parent + '/' : '') + 'node_modules/' + name;
          if (!entries.has(key)) entries.set(key, entry);
          visit(entry.dependencies, key);
        }
      };
      visit(lock.dependencies);
      return entries;
    } catch { /* Try the other npm lockfile; unresolved package metadata remains explicit. */ }
  }
  return new Map();
}

// X2 外呼清单：项目文件静态提取 http(s) 主机名去重，非常见域名黄牌
// 自食教训（2026-11-08 真仓自查）：lockfile 里 90% 的 URL 是 funding/homepage 元数据，
// 全量正则扫描会把 opencollective/tidelift/patreon 报成外呼（124 条里 103 条噪音）。
// 现在：lockfile 只取 resolved（安装时真正下载的地址，恶意 lockfile 改的就是它）；
// package.json 只扫 scripts/dependencies；文档里的 URL 降为提醒级（可能是示例）。
const URL_SRC = 'https?://[^\\s"\'`<>()\\[\\]{}\\\\，。；：！？、（）【】《》「」“”‘’]+';
const LOCKFILE_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/i;
const DOC_RE = /\.(md|txt)$/i;
const REGISTRY_HOSTS = ['registry.npmjs.org', 'registry.npmmirror.com', 'registry.yarnpkg.com', 'registry.npm.taobao.org'];

function hostOf(url) {
  try { return new URL(String(url).replace(/[.,;:!?'"]+$/, '')).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
}

const isAllowedHost = (host) => COMMON_HOSTS.some((w) => host === w || host.endsWith('.' + w))
  || REGISTRY_HOSTS.some((w) => host === w || host.endsWith('.' + w));

// lockfile 的 resolved 地址（npm v1/v2/v3、yarn v1、pnpm 的 tarball）
export function lockfileResolvedUrls(file, text) {
  const urls = [];
  if (/yarn\.lock$/i.test(file)) {
    for (const line of text.split('\n')) {
      const m = /^\s*resolved\s+"?(https?:\/\/[^"\s]+)"?/.exec(line);
      if (m) urls.push(m[1]);
    }
    return urls;
  }
  if (/pnpm-lock\.yaml$/i.test(file)) {
    for (const line of text.split('\n')) {
      const m = /^\s*(?:tarball|resolved):\s*['"]?(https?:\/\/[^"'\s]+)/.exec(line);
      if (m) urls.push(m[1]);
    }
    return urls;
  }
  let j;
  try { j = JSON.parse(text); } catch { return urls; }
  const visit = (deps) => {
    for (const v of Object.values(deps || {})) {
      if (!v || typeof v !== 'object') continue;
      if (typeof v.resolved === 'string') urls.push(v.resolved);
      if (v.dependencies) visit(v.dependencies);
    }
  };
  for (const v of Object.values(j.packages || {})) if (v && typeof v.resolved === 'string') urls.push(v.resolved);
  if (j.dependencies) visit(j.dependencies);
  return urls;
}

// package.json 只看会触发网络行为的字段（scripts + 依赖声明），跳过 funding/homepage/bugs 元数据
export function packageJsonStrings(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  const out = [];
  const push = (o) => { for (const v of Object.values(o || {})) if (typeof v === 'string') out.push(v); };
  push(j.scripts);
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) push(j[k]);
  return out;
}

async function scanExternalHosts(projectDir, excludes) {
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes);
  const seen = new Map(); // host → { rank, finding }：同一 host 只留级别最高的一条（doc < script < lock）
  const emit = (host, file, line, snippet, { lock = false, doc = false } = {}) => {
    const rank = lock ? 2 : (doc ? 0 : 1);
    const existing = seen.get(host);
    // 文档里的示例（low/tip）先命中时，不能把后面 package.json / lockfile 的 medium/card 吞掉
    if (existing && existing.rank >= rank) return;
    seen.set(host, {
      rank,
      finding: {
        checkId: 'X2',
        severity: doc ? 'low' : 'medium',
        force: doc ? 'tip' : 'card',
        file, line,
        rule: lock ? 'X2.lockfile-resolved' : 'X2.external-host',
        snippet: String(snippet).slice(0, 140),
        message: lock
          ? `lockfile 里安装源指向非 registry 主机 ${host}，装前确认（恶意 lockfile 会把下载地址改到第三方）`
          : doc
            ? `文档里出现外呼域名 ${host}（可能是示例），人工确认`
            : `外呼域名 ${host} 不在常见域名白名单内，列入外呼清单，装/跑前确认可信`,
        source: 'program'
      }
    });
  };
  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    const isLock = LOCKFILE_RE.test(file);
    const isDoc = DOC_RE.test(file);
    if (isLock) {
      for (const u of lockfileResolvedUrls(file, text)) {
        const host = hostOf(u);
        if (host && !isAllowedHost(host)) emit(host, file, 0, u, { lock: true });
      }
      continue;
    }
    if (/(^|\/)package\.json$/i.test(file)) {
      const vals = packageJsonStrings(text);
      const scan = vals ? vals.join('\n') : text; // 解析失败退回全文（宁可报）
      const re = new RegExp(URL_SRC, 'g');
      let m;
      while ((m = re.exec(scan))) {
        const host = hostOf(m[0]);
        if (host && !isAllowedHost(host)) emit(host, file, 0, m[0]);
      }
      continue;
    }
    const re = new RegExp(URL_SRC, 'g');
    let m;
    while ((m = re.exec(text))) {
      const host = hostOf(m[0]);
      if (!host || isAllowedHost(host)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      emit(host, file, line, m[0], { doc: isDoc });
    }
  }
  return { findings: [...seen.values()].map((v) => v.finding), skipped, pruned };
}

// X4 README 注入：对 AI/agent 的指令性语句
async function scanReadmeInjection(projectDir, excludes) {
  const { files } = await listTextFiles(projectDir, excludes);
  const out = [];
  for (const f of files) {
    const base = path.basename(f);
    if (!/^readme/i.test(base) || !/\.md(o?wn|arkdown)?$/i.test(base)) continue;
    const { file, text } = await readRel(projectDir, f);
    const lines = text.split('\n');
    const emitted = new Set(); // 同一行命中多条 pattern 只报一次
    for (const re of X4_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        const key = `${file}:${i + 1}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        out.push({
          checkId: 'X4', severity: 'medium', force: 'card', file, line: i + 1,
          rule: 'X4.prompt-injection', snippet: lines[i].trim().slice(0, 140),
          message: 'README 含对 AI/agent 的指令性语句（疑似提示注入），人工确认',
          source: 'program',
        });
      }
    }
  }
  return out;
}

// 桌面/MCP 调用方常常传 excludes: []；项目自己的 finalcheck.config.json 必须生效（否则会把 playbooks 教学示例当外呼）
async function effectiveExcludes(projectDir, excludes) {
  let fromCfg = [];
  try {
    const cfg = JSON.parse(await readFile(path.join(projectDir, 'finalcheck.config.json'), 'utf8'));
    if (Array.isArray(cfg.exclude)) fromCfg = cfg.exclude.map(String);
  } catch { /* 无配置或解析失败：只用调用方传入的 */ }
  return [...new Set([...fromCfg, ...(Array.isArray(excludes) ? excludes.map(String) : [])])];
}

// monorepo 覆盖：枚举根以外的所有 package.json。
// 复用 listTextFiles 的排除口径：node_modules/.git/隐藏目录(.tmp)、build/release/out/dist 等产物、
// fixtures 默认豁免，以及 effectiveExcludes（含 finalcheck.config.json 的 exclude）。
async function listNestedPackageJsons(projectDir, excludes) {
  const { files } = await listTextFiles(projectDir, excludes);
  return files
    .map((f) => path.relative(projectDir, f).replace(/\\/g, '/'))
    .filter((rel) => path.posix.basename(rel).toLowerCase() === 'package.json' && rel.toLowerCase() !== 'package.json');
}

// 嵌套包只做本地安装脚本检查（X1）：不复制根的网络图，避免 REQUEST_CAP 被 workspace 数量放大；
// X3 的网络覆盖范围在 warnings 里明示。解析失败不静默跳过。
async function scanNestedPackageLifecycle(projectDir, excludes, warnings) {
  const all = await listNestedPackageJsons(projectDir, excludes);
  const checked = all.slice(0, MAX_NESTED_PACKAGE_JSON);
  const findings = [];
  const failed = [];
  for (const rel of checked) {
    let pkg;
    try { pkg = JSON.parse(await readFile(path.join(projectDir, rel), 'utf8')); } catch { failed.push(rel); continue; }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) { failed.push(rel); continue; }
    const dirName = path.posix.dirname(rel);
    const name = typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : (dirName === '.' ? rel : dirName);
    findings.push(...lifecycleFindings(pkg.scripts, {
      name,
      version: typeof pkg.version === 'string' ? pkg.version : '',
      file: rel,
    }));
  }
  if (checked.length) {
    warnings.push(`枚举到 ${checked.length} 个嵌套 package.json，安装脚本（X1）已检查 ${checked.length - failed.length} 个；嵌套包的 dependencies/devDependencies 未做 registry 网络图验证（X3 仅覆盖根 package.json 依赖树）`);
  }
  if (all.length > checked.length) {
    warnings.push(`嵌套 package.json 超过上限 ${MAX_NESTED_PACKAGE_JSON}，另有 ${all.length - checked.length} 个未检查（X1 覆盖不全）`);
  }
  if (failed.length) {
    warnings.push(`嵌套 package.json 解析失败 ${failed.length} 个，X1 未检查：${failed.slice(0, 3).join('、')}${failed.length > 3 ? '…' : ''}`);
  }
  return findings;
}

// 同一 file+rule+package 只报一次；根包图与嵌套枚举可能重复命中，X2/X4 自带去重口径，不改动。
function dedupeGateFindings(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    if (f.checkId !== 'X1' && f.checkId !== 'X3') return true;
    const m = /^(@[\w.-]+\/[\w.-]+|[\w.-]+)@([^\s：]+)/.exec(f.snippet || '');
    const key = `${f.file}|${f.rule}|${m ? `${m[1]}@${m[2]}` : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// 全项目扫描：X1+X3（本地根 + registry 依赖树）+ X2 + X4
// 返回 { findings, warnings, coverageGap }，finding 形状同其他 checks
export async function scanDownload(projectDir, { excludes = [] } = {}) {
  const ex = await effectiveExcludes(projectDir, excludes);
  const findings = [];
  const warnings = [];
  const net = newNet();

  const pkgPath = path.join(projectDir, 'package.json');
  let rootPkg = null;
  if (existsSync(pkgPath)) {
    try { rootPkg = JSON.parse(await readFile(pkgPath, 'utf8')); } catch {
      rootPkg = null;
      warnings.push('package.json 解析失败，X1 根脚本未检查');
    }
  }

  if (rootPkg && typeof rootPkg === 'object') {
    // X1+X3 依赖树：根=本地 package.json（不走网络，安装脚本经包图统一产出），
    // 直接依赖（含 devDependencies，它们同样会被装）+2 层全部走 registry；
    // 有 lockfile 时按锁定版本解析，避免把 package.json 的范围解析成另一个版本。
    const name = rootPkg.name || path.basename(projectDir);
    const deps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
    const localMeta = {
      name, version: rootPkg.version || '',
      scripts: rootPkg.scripts && typeof rootPkg.scripts === 'object' ? rootPkg.scripts : {},
      dependencies: deps,
      time: null,
    };
    const nodes = await resolveGraph(name, localMeta, net, { locks: await readNpmLocks(projectDir) });
    findings.push(...collectGraphFindings(nodes, name));
  }

  // monorepo：根以外的 workspace/desktop 包至少做本地安装脚本检查（X1），网络图仍只对根跑
  findings.push(...await scanNestedPackageLifecycle(projectDir, ex, warnings));

  finalizeNet(net, findings, warnings);
  const x2 = await scanExternalHosts(projectDir, ex);
  findings.push(...x2.findings);
  const pw = prunedWarning(x2.pruned);
  if (pw) warnings.push(pw);
  if (x2.skipped?.length) warnings.push(`X2 跳过大文件 ${x2.skipped.length} 个（>512KB 未扫描，外呼清单可能不全）`);
  findings.push(...await scanReadmeInjection(projectDir, ex));
  return {
    findings: dedupeGateFindings(findings),
    warnings,
    coverageGap: netGap(net) || (!rootPkg ? '没有有效 package.json，项目依赖未验证' : null),
  };
}

// 单包扫描（hook 用）：目标包本身 + 其依赖 2 层的 X1+X3，按请求版本/范围解析
export async function scanSinglePackage(name) {
  const findings = [];
  const warnings = [];
  const spec = parsePackageSpec(name);
  if (!spec) {
    warnings.push(`无效包名 ${name}，跳过`);
    return { findings, warnings, coverageGap: '不支持或无效的包来源，未验证' };
  }
  const net = newNet();
  const nodes = await resolveGraph(spec.name, null, net, { range: spec.range });
  const root = [...nodes.values()].find((node) => node.depth === 0);
  if (!root) {
    if (net.failures > 0) warnings.push(`registry 不可达，${name} 的 X1/X3 未跑`);
    else warnings.push(`registry 上查不到 ${name}`);
    return { findings, warnings, coverageGap: `目标 ${name} 未解析，X1/X3 未验证` };
  }
  findings.push(...collectGraphFindings(nodes, spec.name));
  finalizeNet(net, findings, warnings);
  return { findings, warnings, coverageGap: netGap(net) };
}

/* ---------- hook 命令解析：包装前缀归一化 ---------- */

// 纯函数（供 hook 与测试）：从 install/npx 命令解析包名（含 @版本/范围，解析阶段保留）。
const VALUE_FLAGS = new Set(['--registry', '--tag', '--audit-level', '--before', '--scope', '--workspace', '--cpu', '--os', '--libc', '--cache', '--prefix', '--userconfig', '--fetch-retries', '-p', '--package']);
const NPM_CMDS = new Set(['npm', 'npm.cmd', 'npm.exe']);
const NPX_CMDS = new Set(['npx', 'npx.cmd', 'npx.exe']);
const INSTALL_SUBS = new Set(['i', 'install', 'ci', 'add']);
const SIMPLE_WRAPPERS = new Set(['sudo', 'env', 'time', 'nice', 'command', 'nohup', 'exec', 'builtin', 'timeout', 'xargs', 'stdbuf', 'setsid']);
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const SUDO_VALUE_FLAGS = new Set(['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-r', '--role', '-t', '--type', '-U', '--other-user']);
const ENV_VALUE_FLAGS = new Set(['-u', '--unset', '-C', '--chdir']);
const NICE_VALUE_FLAGS = new Set(['-n', '--adjustment']);
const TIMEOUT_VALUE_FLAGS = new Set(['-k', '--kill-after', '-s', '--signal']);
const XARGS_VALUE_FLAGS = new Set(['-n', '-L', '-P', '-s', '-d', '-E', '-I', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--delimiter', '--eof', '--replace']);
const STDBUF_VALUE_FLAGS = new Set(['-i', '-o', '-e', '--input', '--output', '--error']);
const EXEC_VALUE_FLAGS = new Set(['-a']);
const CUSTOM_INSTALL_FLAG_RE = /^--(?:prefix|workspace|registry|userconfig)(?:=|$)/;
// 非 registry 来源：URL/git/file/tarball/本地路径/GitHub 简写
const UNSUPPORTED_SOURCE_RE = /(?:https?:|git[+:]|file:|\.tgz$|^[./]|^[\w.-]+\/[\w.-]+$)/;

function stripSpec(t) {
  if (t.includes('://') || t.startsWith('.') || t.startsWith('/') || t.endsWith('.tgz')) return null; // git/tarball/本地路径跳过
  return parsePackageSpec(t) ? String(t).replace(/^['"]|['"]$/g, '') : null;
}

// npx/npm exec 目标收集：第一个位置参数（bin 名）+ 全流任意位置的 -p/--package 值（值形式与 = 形式）。
// 指定 --package 时位置参数是该包提供的 bin，不一定与 registry 包同名，因此只扫显式包。
// -- 之后全是传给命令的参数，不再解析。
function collectNpxTargets(tokens, start, out) {
  let took = false;
  let positional = null;
  const explicit = [];
  for (let j = start; j < tokens.length; j++) {
    const a = tokens[j];
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (a === '-p' || a === '--package') {
        const v = tokens[j + 1];
        if (v) { const n = stripSpec(v); if (n) explicit.push(n); }
        j++;
      } else if (a.startsWith('--package=') || a.startsWith('-p=')) {
        const n = stripSpec(a.slice(a.indexOf('=') + 1));
        if (n) explicit.push(n);
      } else if (VALUE_FLAGS.has(a)) {
        j++;
      }
      continue;
    }
    if (!took) { positional = stripSpec(a); took = true; }
  }
  out.push(...(explicit.length ? explicit : positional ? [positional] : []));
}

// npm install 分支：从 subcommand 后一位收集位置参数
function collectInstallTargets(tokens, from, out) {
  for (let j = from; j < tokens.length; j++) {
    const a = tokens[j];
    if (a === '--') break; // 之后的参数传给脚本，不是包
    if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) j++; continue; }
    const n = stripSpec(a);
    if (n) out.push(n);
  }
}

export function parseInstallCommand(cmd) {
  const out = [];
  for (const seg of String(cmd).split(/&&|\|\||;|\|/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    const head = tokens[0];
    const isNpm = NPM_CMDS.has(head);
    const isNpx = NPX_CMDS.has(head);
    if (!isNpm && !isNpx) continue;
    const sub = (tokens[1] || '').toLowerCase();
    if (isNpx || (isNpm && (sub === 'exec' || sub === 'x'))) {
      // P1#6：npm exec / npm x 与 npx 同语义
      collectNpxTargets(tokens, isNpx ? 1 : 2, out);
    } else if (isNpm) {
      // P1#5：旗标前置（npm --prefix ./x install pkg）——在整条 token 流里找 install 子命令
      const idx = tokens.findIndex((t, i) => i >= 1 && INSTALL_SUBS.has(t.toLowerCase()));
      if (idx !== -1) collectInstallTargets(tokens, idx + 1, out);
    }
  }
  return [...new Set(out)].slice(0, 20); // hook 防御：一次最多查 20 个包
}

/* ---------- hook 命令解析：shell 包装前缀与检测 ---------- */

const isShellQuoted = (t) => (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"));
const unquote = (t) => (isShellQuoted(t) ? t.slice(1, -1) : t);
const isAssignmentToken = (t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
const commandName = (t) => unquote(t).toLowerCase();

// 保留引号内空格（shell 包装的 -c 参数是一个整体），引号外的管道/连接符拆段。
function shellTokens(input) {
  const tokens = [];
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"']+/g;
  let m;
  while ((m = re.exec(String(input || '')))) tokens.push(m[0]);
  return tokens;
}

function shellSegments(input) {
  const segments = [];
  let current = [];
  const flush = () => { if (current.length) { segments.push(current); current = []; } };
  for (const token of shellTokens(input)) {
    if (isShellQuoted(token)) { current.push(token); continue; }
    for (const part of token.split(/(\|\||&&|;|\|)/).filter(Boolean)) {
      if (part === '&&' || part === '||' || part === ';' || part === '|') flush();
      else current.push(part);
    }
  }
  flush();
  return segments;
}

function skipFlags(tokens, i, valueFlags) {
  let j = i;
  while (j < tokens.length) {
    const a = unquote(tokens[j]);
    if (a === '--') return j + 1;
    if (!a.startsWith('-')) return j;
    if (!isShellQuoted(tokens[j]) && valueFlags.has(a)) j += 2;
    else j += 1;
  }
  return j;
}

// 在 shell 包装里找 -c / -Command / /c 后面的命令串
function findShellCommand(tokens, head, index) {
  const isCmd = head === 'cmd' || head === 'cmd.exe';
  const isPwsh = head.startsWith('powershell') || head.startsWith('pwsh');
  for (let j = index + 1; j < tokens.length; j++) {
    const a = unquote(tokens[j]);
    if (a === '--') break;
    if (isCmd) {
      if (/^\/[ck]$/i.test(a)) return { inner: tokens.slice(j + 1).map(unquote).join(' '), label: `${head} ${a}` };
      continue;
    }
    if (isPwsh) {
      if (/^(?:-command|-c|\/c|--command)$/i.test(a)) return { inner: tokens.slice(j + 1).map(unquote).join(' '), label: `${head} ${a}` };
      continue;
    }
    if (/^-[^-]*c/.test(a)) return { inner: unquote(tokens[j + 1] || ''), label: `${head} ${a}` };
  }
  return null;
}

function npmSubcommandIndex(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const a = unquote(tokens[i]);
    if (a === '--') return -1;
    if (!a.startsWith('-')) return i;
    if (VALUE_FLAGS.has(a)) i += 1;
  }
  return -1;
}

function collectUnsupported(tokens, from) {
  const out = [];
  for (let i = from; i < tokens.length; i++) {
    const a = unquote(tokens[i]);
    if (a === '--') break;
    if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) i += 1; continue; }
    if (UNSUPPORTED_SOURCE_RE.test(a)) out.push(a);
  }
  return out;
}

function classifyPackageManager(tokens) {
  const head = commandName(tokens[0]);
  if (NPX_CMDS.has(head)) {
    if (tokens.some((t) => CUSTOM_INSTALL_FLAG_RE.test(unquote(t)))) {
      return { specs: [], projectScan: false, gaps: ['命令含自定义安装配置（--registry/--prefix/--workspace/--userconfig），未验证'] };
    }
    const unsupported = collectUnsupported(tokens, 1);
    if (unsupported.length) return { specs: [], projectScan: false, gaps: [`安装来源未支持：${unsupported.join('、')}`] };
    const specs = parseInstallCommand(tokens.join(' '));
    if (specs.length >= 20) return { specs: [], projectScan: false, gaps: ['一次安装目标达到上限，请分批检查'] };
    if (!specs.length) return { specs: [], projectScan: false, gaps: ['npx 未解析到目标包，未验证'] };
    return { specs, projectScan: false, gaps: [] };
  }
  if (NPM_CMDS.has(head)) {
    const idx = npmSubcommandIndex(tokens);
    if (idx === -1) return null;
    const verb = commandName(tokens[idx]);
    if (!INSTALL_SUBS.has(verb) && verb !== 'exec' && verb !== 'x') return null;
    if (tokens.some((t) => CUSTOM_INSTALL_FLAG_RE.test(unquote(t)))) {
      return { specs: [], projectScan: false, gaps: ['命令含自定义安装配置（--registry/--prefix/--workspace/--userconfig），未验证'] };
    }
    const unsupported = collectUnsupported(tokens, idx + 1);
    if (unsupported.length) return { specs: [], projectScan: false, gaps: [`安装来源未支持：${unsupported.join('、')}`] };
    const specs = parseInstallCommand(tokens.join(' '));
    if (specs.length >= 20) return { specs: [], projectScan: false, gaps: ['一次安装目标达到上限，请分批检查'] };
    if (!specs.length) {
      if (verb === 'exec' || verb === 'x') return { specs: [], projectScan: false, gaps: ['npm exec 未解析到目标包，未验证'] };
      return { specs: [], projectScan: true, gaps: [] };
    }
    return { specs, projectScan: false, gaps: [] };
  }
  if (head === 'pnpm' || head === 'yarn') {
    const idx = npmSubcommandIndex(tokens);
    const verb = idx === -1 ? '' : commandName(tokens[idx]);
    if (!['add', 'install', 'i', 'dlx', 'exec'].includes(verb)) return null;
    return { specs: [], projectScan: false, gaps: [`${head} 安装命令未验证（仅支持 npm/npx）`] };
  }
  return null;
}

function analyzeSegment(tokens, depth = 0) {
  let i = 0;
  const prefixes = [];
  while (i < tokens.length) {
    const head = commandName(tokens[i]);
    if (isAssignmentToken(tokens[i])) { prefixes.push(tokens[i].split('=')[0] + '=…'); i += 1; continue; }
    if (SIMPLE_WRAPPERS.has(head)) {
      prefixes.push(head);
      i += 1;
      if (head === 'env') {
        while (i < tokens.length && isAssignmentToken(tokens[i])) { prefixes.push(tokens[i].split('=')[0] + '=…'); i += 1; }
        if (unquote(tokens[i] || '') === '-S' || unquote(tokens[i] || '') === '--split-string') {
          const child = analyzeCommandString(unquote(tokens[i + 1] || ''), depth + 1);
          for (const task of child) task.gaps.push('命令经 env -S 包装执行，包装上下文未经核实');
          return child;
        }
        i = skipFlags(tokens, i, ENV_VALUE_FLAGS);
      } else if (head === 'sudo') {
        i = skipFlags(tokens, i, SUDO_VALUE_FLAGS);
      } else if (head === 'nice') {
        i = skipFlags(tokens, i, NICE_VALUE_FLAGS);
      } else if (head === 'timeout') {
        i = skipFlags(tokens, i, TIMEOUT_VALUE_FLAGS);
        if (i < tokens.length) i += 1; // timeout 的第一个位置参数是 DURATION，之后才是被包装命令
      } else if (head === 'xargs') {
        i = skipFlags(tokens, i, XARGS_VALUE_FLAGS);
      } else if (head === 'stdbuf') {
        i = skipFlags(tokens, i, STDBUF_VALUE_FLAGS);
      } else if (head === 'exec') {
        i = skipFlags(tokens, i, EXEC_VALUE_FLAGS);
      } else {
        i = skipFlags(tokens, i, new Set());
      }
      continue;
    }
    if (SHELL_WRAPPERS.has(head)) {
      const found = findShellCommand(tokens, head, i);
      if (!found || !found.inner) return [];
      const child = analyzeCommandString(found.inner, depth + 1);
      if (child.length) {
        const labels = [...prefixes, found.label].filter(Boolean).join('、');
        for (const task of child) task.gaps.push(`命令经 ${labels} 包装执行，包装上下文（环境/工作目录）未经核实`);
      }
      return child;
    }
    break;
  }
  if (i >= tokens.length) return [];
  const task = classifyPackageManager(tokens.slice(i));
  if (!task) return [];
  if (prefixes.length) task.gaps.push(`命令带前缀（${prefixes.join('、')}），提权/包装上下文未经核实`);
  return [task];
}

function analyzeCommandString(input, depth = 0) {
  if (depth > 4) return [];
  const tasks = [];
  for (const segment of shellSegments(input)) tasks.push(...analyzeSegment(segment, depth));
  return tasks;
}

// Hook 的有限命令契约：包装前缀/复杂 shell/自定义来源明确标为未验证，不默默放行。
export async function inspectInstallCommand(command, { cwd = process.cwd(), scanPackage = scanSinglePackage, scanProject = scanDownload } = {}) {
  const cmd = String(command);
  const tasks = [];
  let dirChange = false;
  for (const segment of shellSegments(cmd)) {
    const first = segment.map(unquote).find((t) => !isAssignmentToken(t) && !t.startsWith('-'));
    if (first && /^(?:cd|pushd)$/i.test(first)) dirChange = true;
    tasks.push(...analyzeSegment(segment, 0));
  }
  if (!tasks.length) return { applicable: false, findings: [], warnings: [], coverageGap: null };

  const gaps = [];
  if (dirChange) gaps.push('命令包含 cd/pushd 目录切换，安装实际工作目录未验证');
  if (/[$`]/.test(cmd)) gaps.push('命令含 shell 变量/命令替换，安装目标可能不是静态可解析的，未验证');

  const findings = [];
  const warnings = [];
  for (const task of tasks) {
    gaps.push(...task.gaps);
    if (task.projectScan) {
      if (dirChange) continue; // cd 之后的项目目录无法可信解析
      const r = await scanProject(cwd);
      findings.push(...r.findings);
      warnings.push(...r.warnings);
      if (r.coverageGap) gaps.push(r.coverageGap);
      continue;
    }
    if (!task.specs.length) continue;
    const results = await Promise.all(task.specs.map((spec) => scanPackage(spec)));
    for (const r of results) {
      findings.push(...r.findings);
      warnings.push(...r.warnings);
      if (r.coverageGap) gaps.push(r.coverageGap);
    }
  }
  return { applicable: true, findings, warnings, coverageGap: gaps.length ? [...new Set(gaps)].join('；') : null };
}
