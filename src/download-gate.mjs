import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles, readRel, prunedWarning } from './walk.mjs';

// X 下载闸（ACCEPTANCE §4-X）：只跑静态关 + registry 元数据查询，禁止执行被审项目任何代码
// X1 安装脚本 | X2 外呼清单 | X3 依赖投毒 | X4 README 注入

const REQUEST_CAP = 200;          // 单次扫描的总 registry 请求上限
const FETCH_TIMEOUT_MS = 15000;   // 全部 fetch 15s 超时
const MAX_DEPTH = 2;              // 直接依赖=层1，其依赖=层2（"直接依赖+2 层内"，registry 递归限深 2）
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

// registry 元数据：进程级内存缓存（同包只请求一次）
const metaCache = new Map(); // name → 解析后的 meta | null（请求失败也缓存，避免离线时反复打）
const dlCache = new Map();   // name → 周下载量 number | null

const newNet = () => ({ requests: 0, failures: 0, skipped: new Set() });

async function fetchJson(url, net) {
  if (net.requests >= REQUEST_CAP) return undefined; // undefined = 超上限，本次没发请求
  net.requests += 1;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      if (res.status >= 500) net.failures += 1; // 404=包不存在不算 registry 故障
      return null;
    }
    return await res.json();
  } catch {
    net.failures += 1;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 注意：不用 /latest —— 它不带 time 字段，X3 的"发布时间"必须读完整 packument
function parseRegistryDoc(doc) {
  if (!doc || typeof doc !== 'object' || typeof doc.versions !== 'object') return null;
  const latest = doc['dist-tags']?.latest;
  const v = latest ? doc.versions[latest] : null;
  return {
    name: doc.name,
    version: v?.version || latest || '',
    scripts: v?.scripts && typeof v.scripts === 'object' ? v.scripts : {},
    dependencies: v?.dependencies && typeof v.dependencies === 'object' ? v.dependencies : {},
    time: doc.time && typeof doc.time === 'object' ? doc.time : null,
  };
}

// 返回 undefined=超上限未请求 | null=请求失败/不存在 | meta
async function getRegistryMeta(name, net) {
  if (metaCache.has(name)) return metaCache.get(name);
  if (net.requests >= REQUEST_CAP) { net.skipped.add(name); return undefined; }
  const doc = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`, net);
  const meta = parseRegistryDoc(doc);
  metaCache.set(name, meta);
  return meta;
}

// 返回 undefined=超上限 | null=失败 | number
async function getDownloads(name, net) {
  if (dlCache.has(name)) return dlCache.get(name);
  if (net.requests >= REQUEST_CAP) { net.skipped.add(name); return undefined; }
  const doc = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`, net);
  const n = doc && typeof doc.downloads === 'number' ? doc.downloads : null;
  dlCache.set(name, n);
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
// 返回 Map<name, { meta, depth }>
async function resolveGraph(rootName, localMeta, net) {
  const nodes = new Map();
  const queued = new Set([rootName]);
  let frontier = [{ name: rootName, depth: 0, local: localMeta || null }];
  while (frontier.length) {
    const next = [];
    await Promise.all(frontier.map(async (job) => {
      let meta = job.local;
      if (!meta) {
        const m = await getRegistryMeta(job.name, net);
        if (!m) return; // undefined=超上限（已计 skipped），null=失败（已计 failures）
        meta = m;
        const dl = await getDownloads(job.name, net);
        meta = { ...meta, weeklyDownloads: typeof dl === 'number' ? dl : null };
      }
      if (!nodes.has(job.name)) nodes.set(job.name, { meta, depth: job.depth });
      if (job.depth >= MAX_DEPTH) return;
      for (const dep of Object.keys(meta.dependencies || {})) {
        if (!NAME_RE.test(dep) || queued.has(dep)) continue;
        queued.add(dep);
        next.push({ name: dep, depth: job.depth + 1, local: null });
      }
    }));
    frontier = next;
  }
  return nodes;
}

function collectGraphFindings(nodes, rootName) {
  const findings = [];
  for (const [name, node] of nodes) {
    const isRoot = name === rootName && node.depth === 0;
    findings.push(...lifecycleFindings(node.meta.scripts, { name, version: node.meta.version, file: 'package.json' }));
    if (isRoot && !node.meta.weeklyDownloads && node.meta.weeklyDownloads !== 0) continue; // 本地根不算 X3
    const judge = judgePackageMeta(node.meta);
    if (judge.verdict === 'risk') findings.push(x3Finding(node.meta, judge));
  }
  return findings;
}

function finalizeNet(net, findings, warnings) {
  if (net.skipped.size > 0) {
    findings.push({
      checkId: 'X1', severity: 'low', force: 'tip', file: 'package.json', line: 0,
      rule: 'X1.unresolved', snippet: '',
      message: `registry 请求超上限（${REQUEST_CAP}），${net.skipped.size} 个依赖未解析（安装脚本/投毒信号未覆盖，未解析部分明示）`,
      source: 'program',
    });
  }
  if (net.failures > 0) warnings.push(`registry 不可达或请求失败（${net.failures} 次），X1/X3 网络部分覆盖不全`);
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
  const seen = new Map(); // host → finding（去重）
  const emit = (host, file, line, snippet, { lock = false, doc = false } = {}) => {
    if (seen.has(host)) return;
    seen.set(host, {
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
      source: 'program',
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
  return { findings: [...seen.values()], skipped, pruned };
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

// 全项目扫描：X1+X3（本地根 + registry 依赖树）+ X2 + X4
// 返回 { findings, warnings }，finding 形状同其他 checks
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
    // 直接依赖（含 devDependencies，它们同样会被装）+2 层全部走 registry
    const name = rootPkg.name || path.basename(projectDir);
    const deps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
    const localMeta = {
      name, version: rootPkg.version || '',
      scripts: rootPkg.scripts && typeof rootPkg.scripts === 'object' ? rootPkg.scripts : {},
      dependencies: deps,
      time: null,
    };
    const nodes = await resolveGraph(name, localMeta, net);
    findings.push(...collectGraphFindings(nodes, name));
  }

  finalizeNet(net, findings, warnings);
  const x2 = await scanExternalHosts(projectDir, ex);
  findings.push(...x2.findings);
  const pw = prunedWarning(x2.pruned);
  if (pw) warnings.push(pw);
  if (x2.skipped?.length) warnings.push(`X2 跳过大文件 ${x2.skipped.length} 个（>512KB 未扫描，外呼清单可能不全）`);
  findings.push(...await scanReadmeInjection(projectDir, ex));
  return { findings, warnings };
}

// 单包扫描（hook 用）：目标包本身 + 其依赖 2 层的 X1+X3
export async function scanSinglePackage(name) {
  const findings = [];
  const warnings = [];
  if (!NAME_RE.test(String(name))) {
    warnings.push(`无效包名 ${name}，跳过`);
    return { findings, warnings };
  }
  const net = newNet();
  const nodes = await resolveGraph(name, null, net);
  const root = nodes.get(name);
  if (!root) {
    if (net.failures > 0) warnings.push(`registry 不可达，${name} 的 X1/X3 未跑`);
    else warnings.push(`registry 上查不到 ${name}`);
    return { findings, warnings };
  }
  findings.push(...collectGraphFindings(nodes, name));
  finalizeNet(net, findings, warnings);
  return { findings, warnings };
}

// 纯函数（供 hook 与测试）：从 install/npx 命令解析包名列表
const VALUE_FLAGS = new Set(['--registry', '--tag', '--audit-level', '--before', '--scope', '--workspace', '--cpu', '--os', '--libc', '--cache', '--prefix', '--userconfig', '--fetch-retries', '-p', '--package']);
const NPM_CMDS = new Set(['npm', 'npm.cmd', 'npm.exe']);
const NPX_CMDS = new Set(['npx', 'npx.cmd', 'npx.exe']);
const INSTALL_SUBS = new Set(['i', 'install', 'ci', 'add']);

function stripSpec(t) {
  if (t.includes('://') || t.startsWith('.') || t.startsWith('/') || t.endsWith('.tgz')) return null; // git/tarball/本地路径跳过
  let name = t;
  const i = name.startsWith('@') ? name.indexOf('@', 1) : name.indexOf('@');
  if (i > 0) name = name.slice(0, i);
  return NAME_RE.test(name) ? name : null;
}

// npx/npm exec 目标收集：第一个位置参数（bin 名）+ 全流任意位置的 -p/--package 值（值形式与 = 形式）。
// -- 之后全是传给命令的参数，不再解析。
function collectNpxTargets(tokens, start, out) {
  let took = false;
  for (let j = start; j < tokens.length; j++) {
    const a = tokens[j];
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (a === '-p' || a === '--package') {
        const v = tokens[j + 1];
        if (v) { const n = stripSpec(v); if (n) out.push(n); }
        j++;
      } else if (a.startsWith('--package=') || a.startsWith('-p=')) {
        const n = stripSpec(a.slice(a.indexOf('=') + 1));
        if (n) out.push(n);
      } else if (VALUE_FLAGS.has(a)) {
        j++;
      }
      continue;
    }
    if (!took) { const n = stripSpec(a); if (n) out.push(n); took = true; } // 只取第一个位置参数
  }
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
