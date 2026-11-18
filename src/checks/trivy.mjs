// Trivy 接入（2026-11-18）：补三块 FC 自研规则与已接工具都覆盖不到的面。
//
//   ① 依赖漏洞：Go / Java / PHP / Rust / Ruby / .NET——以前这些生态一律记「未接入审计」
//      （npm 由 npm audit、Python 由 pip-audit/OSV 审，Trivy 对这两个生态的结果不重复报）→ S4
//   ② 配置问题：Dockerfile / Kubernetes / Terraform / Helm / CloudFormation → O1
//   ③ 密钥：代码与配置文件里的云厂商密钥、私钥等 → S3（与自研规则同行的由 audit 同位去重合并）
//
// Trivy 是可选增强：没装只记 warning（提示安装方式），不把整份结论压成「无法验收」——
// 原有的「X 生态未接入审计」缺口照旧保留，结论口径与没接 Trivy 时一致（fail-closed 不变）。
// 跑了但失败/超时同理：缺口照旧，warning 说明原因。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../run-async.mjs';

// Trivy 结果 Type → FC 生态标识（与 deps.mjs 的 LOCKFILE_TYPES.ecosystem 同口径）
const TYPE_TO_ECOSYSTEM = {
  gomod: 'go', gobinary: 'go',
  pom: 'java', gradle: 'java', jar: 'java', sbt: 'java',
  composer: 'php', 'composer-vendor': 'php',
  cargo: 'rust', rustbinary: 'rust',
  bundler: 'ruby', gemspec: 'ruby',
  nuget: 'dotnet', 'dotnet-core': 'dotnet', 'packages-props': 'dotnet',
};
const SEV = { CRITICAL: 'high', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', UNKNOWN: 'medium' };
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', 'venv', '.finalcheck', '.next', 'vendor/bundle'];

let cached;
/** 找 trivy：FINALCHECK_TRIVY → PATH → winget 便携安装目录 → 仓库 vendor/trivy。找不到返回 null。 */
export async function resolveTrivy() {
  if (cached !== undefined) return cached;
  const candidates = [];
  if (process.env.FINALCHECK_TRIVY) candidates.push(process.env.FINALCHECK_TRIVY);
  candidates.push('trivy');
  // winget 的便携包不一定在当前进程的 PATH 里（装完要重开终端才生效）
  const wingetRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages') : null;
  if (wingetRoot && existsSync(wingetRoot)) {
    for (const d of readdirSync(wingetRoot)) if (/^AquaSecurity\.Trivy_/i.test(d)) candidates.push(path.join(wingetRoot, d, 'trivy.exe'));
  }
  candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'vendor', 'trivy', process.platform === 'win32' ? 'trivy.exe' : 'trivy'));
  for (const cmd of candidates) {
    if (cmd !== 'trivy' && !existsSync(cmd)) continue;
    const r = await runProcess(cmd, ['--version'], { timeoutMs: 20000 }).catch(() => null);
    const v = r && r.status === 0 ? /Version:\s*([\d.]+)/.exec(String(r.stdout)) : null;
    if (v) { cached = { cmd, version: v[1] }; return cached; }
  }
  cached = null;
  return null;
}

// 漏洞库/检查规则包的联网更新：Trivy 默认每轮都检查更新，国内访问 ghcr.io 慢且常失败
// （真实模型 E2E 实测：一次 audit_project 卡 142~300 秒，最后报「漏洞库下载失败」）。
// 本地库在 DB_FRESH_DAYS 天内就离线用（报告写明库日期）；没有库或太旧才让 Trivy 联网更新。
const DB_FRESH_DAYS = 7;
export function trivyCacheFlags({ cacheDir = defaultTrivyCacheDir(), now = Date.now() } = {}) {
  const flags = [];
  const notes = [];
  const meta = (rel) => { try { return JSON.parse(readFileSync(path.join(cacheDir, rel), 'utf8')); } catch { return null; } };
  const ageDays = (m) => { const t = Date.parse(m?.UpdatedAt || m?.DownloadedAt || ''); return Number.isFinite(t) ? (now - t) / 86400000 : Infinity; };
  const db = meta(path.join('db', 'metadata.json'));
  if (ageDays(db) <= DB_FRESH_DAYS) {
    flags.push('--skip-db-update');
    notes.push(`漏洞库 ${String(db.UpdatedAt || db.DownloadedAt).slice(0, 10)}（本地缓存，${DB_FRESH_DAYS} 天内不联网更新）`);
  }
  const javaDb = meta(path.join('java-db', 'metadata.json'));
  if (ageDays(javaDb) <= DB_FRESH_DAYS) flags.push('--skip-java-db-update');
  if (existsSync(path.join(cacheDir, 'policy', 'content'))) flags.push('--skip-check-update');
  return { flags, note: notes.join('；') || null };
}
function defaultTrivyCacheDir() {
  if (process.env.TRIVY_CACHE_DIR) return process.env.TRIVY_CACHE_DIR;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'trivy');
  return path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME || '', '.cache'), 'trivy');
}

// 在依赖清单文件里找包名所在行（给发现一个能点进去的位置；找不到就记 0，不编造）
function lineOf(projectDir, rel, pkg) {
  try {
    const name = String(pkg || '').split(':').pop();
    const lines = readFileSync(path.join(projectDir, rel), 'utf8').split(/\r?\n/);
    const i = lines.findIndex((l) => name && l.includes(name));
    return i >= 0 ? i + 1 : 0;
  } catch { return 0; }
}

const mask = (s) => String(s || '').replace(/(['"]?)([A-Za-z0-9/+_=-]{8})[A-Za-z0-9/+_=-]{6,}/g, '$1$2***').slice(0, 120);

/**
 * 把 Trivy JSON 映射成 FC 结果。纯函数（测试直接喂 JSON）。
 * @returns {{ s4: Array, o1: Array, s3: Array, ecosystems: Set<string> }}
 */
export function mapTrivyResults(json, projectDir = '.') {
  const out = { s4: [], o1: [], s3: [], ecosystems: new Set() };
  const results = Array.isArray(json?.Results) ? json.Results : [];
  for (const r of results) {
    const target = String(r.Target || '').replace(/\\/g, '/');
    const eco = TYPE_TO_ECOSYSTEM[String(r.Type || '').toLowerCase()];
    if (r.Class === 'lang-pkgs' && eco) {
      out.ecosystems.add(eco);
      // 同一个包的多条 CVE 合成一条（与 pip-audit 口径一致），严重度取最高
      const byPkg = new Map();
      for (const v of r.Vulnerabilities || []) {
        const key = `${v.PkgName}@${v.InstalledVersion}`;
        if (!byPkg.has(key)) byPkg.set(key, []);
        byPkg.get(key).push(v);
      }
      for (const vs of byPkg.values()) {
        const first = vs[0];
        const top = vs.map((v) => String(v.Severity || 'UNKNOWN').toUpperCase()).sort((a, b) => ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].indexOf(a) - ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].indexOf(b))[0];
        const ids = vs.map((v) => v.VulnerabilityID).filter(Boolean);
        const idLabel = ids.length > 3 ? `${ids.slice(0, 3).join('、')} 等 ${ids.length} 条` : ids.join('、');
        const fixed = vs.map((v) => v.FixedVersion).filter(Boolean)[0];
        out.s4.push({
          checkId: 'S4', severity: SEV[top] || 'medium', force: SEV[top] === 'high' ? 'card' : 'check',
          file: target, line: lineOf(projectDir, target, first.PkgName), rule: 'S4.trivy',
          snippet: `${first.PkgName}@${first.InstalledVersion}（${idLabel}）`,
          message: `依赖存在已知漏洞（Trivy ${idLabel}）${fixed ? `：升级到 ${fixed} 及以上` : ''}`,
          source: 'program',
        });
      }
    }
    // 开发容器/CI 配置不是交付产物（petclinic 实测 .devcontainer/Dockerfile 被当生产镜像报）
    const devOnly = /(^|\/)(\.devcontainer|\.github|\.gitlab|\.circleci)\//.test(target);
    for (const m of devOnly ? [] : r.Misconfigurations || []) {
      if (m.Status && m.Status !== 'FAIL') continue;
      const sev = SEV[String(m.Severity || '').toUpperCase()] || 'medium';
      out.o1.push({
        // 只有 HIGH/CRITICAL（root 运行、特权容器、可写根文件系统等）要处理；MEDIUM/LOW 的加固建议作提示
        // （go-admin/petclinic 实测：一个 k8s yaml 十几条 MEDIUM 加固项会把结论压成「修完再过」）
        checkId: 'O1', severity: sev, force: sev === 'high' ? 'check' : 'tip',
        file: target, line: Number(m.CauseMetadata?.StartLine) || 0, rule: `O1.trivy-${m.ID || m.AVDID || 'misconfig'}`,
        snippet: String(m.Title || '').slice(0, 120),
        message: `${m.Title || '配置问题'}（Trivy ${m.ID || ''}）${m.Resolution ? `——${m.Resolution}` : ''}`.slice(0, 300),
        source: 'program',
      });
    }
    for (const s of r.Secrets || []) {
      out.s3.push({
        checkId: 'S3', severity: 'high', force: 'card',
        file: target, line: Number(s.StartLine) || 0, rule: `S3.trivy-${s.RuleID || 'secret'}`,
        snippet: mask(s.Match), message: `疑似密钥：${s.Title || s.RuleID}（Trivy）——改用环境变量/密钥管理，已泄露的立即轮换`,
        source: 'program',
      });
    }
  }
  return out;
}

/**
 * 跑 Trivy 文件系统扫描。
 * @returns {Promise<{ran:boolean, s4:Array, o1:Array, s3:Array, ecosystems:Set<string>, warnings:string[], version?:string}>}
 */
export async function runTrivy(projectDir, { excludes = [], tooling = null, runner = null, timeoutMs = 600000 } = {}) {
  const empty = { ran: false, s4: [], o1: [], s3: [], ecosystems: new Set(), warnings: [] };
  // 显式关闭（测试套件默认关：上百个 audit 用例不该各自真跑一次 Trivy）；注入 runner 的用例不受影响
  if (!runner && String(process.env.FINALCHECK_TRIVY || '').toLowerCase() === 'off') {
    empty.warnings.push('Trivy 已关闭（FINALCHECK_TRIVY=off）：其他生态依赖、容器与 IaC 配置本轮未扫描');
    return empty;
  }
  const tool = runner ?{ cmd: 'trivy', version: 'injected' } : (tooling || await resolveTrivy());
  if (!tool) {
    empty.warnings.push('Trivy 未安装：Go/Java/PHP/Rust/Ruby/.NET 依赖漏洞、Dockerfile/K8s/Terraform 配置未扫描（安装：winget install AquaSecurity.Trivy）');
    return empty;
  }
  const skip = [...SKIP_DIRS, ...excludes.map((x) => String(x).replace(/\\/g, '/'))];
  const cache = runner ? { flags: [], note: null } : trivyCacheFlags();
  // --offline-scan：pom.xml 默认要联网去 Maven Central 拉父 POM，国内 40 秒后整轮失败（java-sec-code 实测），
  // 离线解析只用仓库里写明的版本——传递依赖/BOM 管理的版本可能展开不全，下面在 warning 里写明
  const args = ['fs', '--quiet', '--format', 'json', '--scanners', 'vuln,misconfig,secret', '--offline-scan', ...cache.flags, ...skip.flatMap((d) => ['--skip-dirs', d]), projectDir];
  let run;
  try {
    run = runner ? await runner(projectDir, args) : await runProcess(tool.cmd, args, { timeoutMs, maxOut: 64 * 1024 * 1024 });
  } catch (e) { run = { status: null, error: e }; }
  if (!run || run.status !== 0 || !String(run.stdout || '').trim().startsWith('{')) {
    const why = run?.status === 124 || run?.timedOut ? '超时' : String(run?.error?.message || run?.stderr || '无输出').trim().split('\n').pop().slice(0, 160);
    empty.warnings.push(`Trivy 运行失败（${why}）：其他生态依赖、容器与 IaC 配置本轮未扫描`);
    return empty;
  }
  let json;
  try { json = JSON.parse(run.stdout); } catch (e) {
    empty.warnings.push(`Trivy 输出无法解析（${e.message}）：本轮结果不采用`);
    return empty;
  }
  const mapped = mapTrivyResults(json, projectDir);
  const warnings = [`Trivy ${tool.version}：依赖 ${mapped.s4.length} 条、配置 ${mapped.o1.length} 条、密钥 ${mapped.s3.length} 条${mapped.ecosystems.size ? `（审计生态：${[...mapped.ecosystems].join('、')}）` : ''}${cache.note ? `；${cache.note}` : ''}`];
  if (mapped.ecosystems.has('java')) warnings.push('Trivy：Java 依赖按仓库内声明离线解析，父 POM/BOM 管理的版本与传递依赖可能未展开（需要完整结果请先 mvn dependency:resolve 再验收）');
  return { ran: true, ...mapped, warnings, version: tool.version };
}
