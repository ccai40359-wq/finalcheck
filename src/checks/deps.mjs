import { existsSync } from 'node:fs';
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

export async function checkDeps(projectDir) {
  const lock = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].find((f) => existsSync(path.join(projectDir, f)));
  if (!lock) return { checkId: 'S4', findings: [], coverageGap: '无 lockfile，依赖关未跑' };

  const findings = [];
  const warnings = [];
  const tooling = resolveNodeTooling();
  if (!tooling.node || !tooling.npmCli) {
    return { checkId: 'S4', findings, coverageGap: '未找到 Node.js/npm（装 Node.js 后依赖关才可跑）', warnings };
  }

  let registry = null;
  let run = await runNpmAudit(projectDir, { tooling });
  if (run?.error) return { checkId: 'S4', findings, coverageGap: `npm audit 启动失败：${run.error.message}`, warnings };
  let out = interpretAuditOutput(run?.stdout);

  // 只在「registry 没实现审计端点」时回退官方源；401/网络/锁文件损坏等一律如实报 gap，不掩盖故障。
  if (out.kind === 'endpoint-unsupported') {
    const reason1 = out.reason;
    const retry = await runNpmAudit(projectDir, { tooling, registry: NPMJS_REGISTRY });
    const out2 = interpretAuditOutput(retry?.stdout);
    if (out2.kind === 'ok') {
      run = retry;
      out = out2;
      registry = NPMJS_REGISTRY;
      warnings.push(`本机 npm registry 未实现审计端点（${reason1 || '404'}），已回退 ${NPMJS_REGISTRY} 完成 S4`);
    } else {
      out = out2;
    }
  }
  if (out.kind !== 'ok') {
    return { checkId: 'S4', findings, coverageGap: `npm audit 失败：${out.reason || out.kind}`, warnings, auditRegistry: registry };
  }

  for (const [name, v] of Object.entries(out.vulnerabilities)) {
    const sev = SEV_MAP[v.severity] || 'high'; // 未知 severity fail-closed
    findings.push({ checkId: 'S4', severity: sev, force: sev === 'low' ? 'tip' : 'card', file: lock, line: 0, rule: 'S4.cve', snippet: `${name}（${v.range || '?'}）${v.severity}`, message: `依赖存在已知漏洞（${v.severity}）`, source: 'program' });
  }
  const bin = findBinary('osv-scanner'); // 增强：有则并用，交叉印证
  if (bin) {
    const run2 = await runProcess(bin, ['--format', 'json', '--lockfile', path.join(projectDir, lock)], { timeoutMs: 120000 });
    if (!run2.error && run2.stdout && run2.stdout.trim().startsWith('{')) {
      try {
        const osv = JSON.parse(run2.stdout);
        const seen = new Set(findings.map((f) => f.snippet));
        for (const r of osv.results || []) for (const pkg of r.packages || []) for (const v of pkg.vulnerabilities || []) {
          const snip = `${pkg.package?.name || '?'}@${pkg.package?.version || '?'} ${v.id}`;
          if (!seen.has(snip)) findings.push({ checkId: 'S4', severity: 'high', force: 'card', file: lock, line: 0, rule: 'S4.osv', snippet: snip, message: (v.summary || '已知漏洞（osv）').slice(0, 140), source: 'program' });
        }
      } catch { warnings.push('osv-scanner 输出解析失败（npm audit 结果不受影响）'); }
    }
  } else {
    warnings.push('osv-scanner 未安装：仅 npm audit 覆盖（广度足够日常使用）');
  }
  return { checkId: 'S4', findings, coverageGap: null, warnings, auditRegistry: registry };
}
