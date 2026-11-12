import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { findBinary } from '../which.mjs';
import { runProcess } from '../run-async.mjs';

// S3 的 gitleaks 适配层：定位二进制 / 跑 detect / 解析报告。
// 三条安全约束：
//   1) 报告只写 os.tmpdir() 下的唯一临时目录，绝不落到被审项目里，跑完即删；
//   2) Match / Secret / 行原文一律不进入 finding、warnings 或日志，只保留规则 ID、文件、行号；
//   3) 二进制缺失只是 warning（自研规则仍覆盖），配置了但跑不起来（失败/超时/坏报告）才算 coverageGap。
export const GITLEAKS_MISSING_WARNING = 'gitleaks 未安装：自研规则覆盖（广度有限）';
const DEFAULT_TIMEOUT_MS = 120000;
const RULE_ID_MAX = 80;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

// gitleaks 会把 .tmp / node_modules / 构建产物也扫进来（--no-git 不读 .gitignore）。
// 这些不是被审项目的交付源码，命中只会制造噪声；与 walk.mjs 的目录剪枝保持同一口径。
// 注意：只跳过「目录段」，不跳过以 . 开头的普通文件（如 .npmrc 仍要扫）。
const IGNORED_DIR_NAMES = new Set(['.git', '.tmp', 'node_modules', 'coverage', '.finalcheck', 'workflow-runs', 'out', 'dist', 'build', 'release']);
const IGNORED_DIR_RE = /^(?:release-[A-Za-z0-9._-]+|[A-Za-z0-9._-]+-unpacked)$/i;
const ENV_FILE_RE = /(?:^|\.)env(?:$|\.)/i;

function isIgnoredLocalPath(rel) {
  const segs = String(rel || '').split('/').filter(Boolean);
  const dirs = segs.slice(0, -1);
  if (dirs.some((s) => s.startsWith('.') || IGNORED_DIR_NAMES.has(s.toLowerCase()) || IGNORED_DIR_RE.test(s))) return true;
  return ENV_FILE_RE.test(segs[segs.length - 1] || '');
}

// config 既接受整份 finalcheck.config.json，也接受其中的 gitleaks 段，方便调用方按需传。
function gitleaksSection(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const section = config.gitleaks;
  if (section && typeof section === 'object' && !Array.isArray(section)) return section;
  return config;
}

// 定位顺序：config.gitleaks.path > env.GITLEAKS_PATH > PATH（复用 which.mjs 的 findBinary）。
// find 可注入，测试里不依赖真二进制。
export function resolveGitleaks({ config = {}, env = process.env, find = findBinary } = {}) {
  const section = gitleaksSection(config);
  if (typeof section.path === 'string' && section.path.trim()) return section.path.trim();
  if (env && typeof env.GITLEAKS_PATH === 'string' && env.GITLEAKS_PATH.trim()) return env.GITLEAKS_PATH.trim();
  try { return find('gitleaks') || null; } catch { return null; }
}

// .js/.mjs 假二进制（测试/自定义脚本）用当前 node 启动，Windows 上同样可用。
function isNodeScriptPath(binaryPath) {
  return /\.(?:js|mjs|cjs)$/i.test(String(binaryPath || ''));
}

// 报告里的 File 归一化成项目内相对路径（正斜杠）；越界路径直接丢弃，避免把项目外路径带进报告。
function normalizeRelFile(file, projectDir) {
  let rel = String(file || '').replace(/\\/g, '/').trim();
  if (!rel) return null;
  if (path.isAbsolute(rel)) {
    rel = path.relative(projectDir, rel).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return null;
  }
  rel = rel.replace(/^\.\/+/, '');
  if (!rel || rel === '..' || rel.startsWith('../')) return null;
  return rel;
}

function sanitizeRuleId(value) {
  const s = String(value == null ? '' : value).replace(CONTROL_RE, '').trim().slice(0, RULE_ID_MAX);
  return s || 'unknown-rule';
}

function toFinding({ file, line, ruleId }) {
  // 文档里的示例密钥降为 medium/tip，与自研 S3 规则口径一致；
  // 源码里的命中才是 high/card（会真正卡交付）。
  const isDoc = /\.(md|txt)$/i.test(String(file || ''));
  return {
    checkId: 'S3',
    rule: `S3.gitleaks:${ruleId}`,
    file,
    line,
    severity: isDoc ? 'medium' : 'high',
    force: isDoc ? 'tip' : 'card',
    snippet: '[redacted]',
    message: isDoc
      ? `gitleaks 检出疑似密钥（规则 ${ruleId}）（出现在文档中，可能是示例）；值已隐去`
      : `gitleaks 检出疑似密钥（规则 ${ruleId}）；值已隐去`,
    source: 'program',
  };
}

// 容错解析：json 可以是报告文本或已解析数组。只读取 RuleID/File/StartLine，
// 从不读取 Match/Secret（即使存在也不会进结果）。
// 同 file+line 多条命中只保留规则字典序第一条，其余进 warnings（只含规则 ID）。
export function parseGitleaksReport(json, projectDir) {
  let leaks;
  try {
    leaks = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return { valid: false, findings: [], warnings: ['gitleaks 报告不是合法 JSON，本次不计为已执行'] };
  }
  if (!Array.isArray(leaks)) {
    return { valid: false, findings: [], warnings: ['gitleaks 报告结构异常（应为数组），本次不计为已执行'] };
  }
  const warnings = [];
  const hits = [];
  let skipped = 0;
  let ignored = 0;
  for (const leak of leaks) {
    if (!leak || typeof leak !== 'object') { skipped += 1; continue; }
    const file = normalizeRelFile(leak.File, projectDir);
    if (!file) { skipped += 1; continue; }
    if (isIgnoredLocalPath(file)) { ignored += 1; continue; }
    const ruleId = sanitizeRuleId(leak.RuleID);
    const lineNum = Number(leak.StartLine);
    hits.push({ file, line: Number.isFinite(lineNum) && lineNum > 0 ? Math.trunc(lineNum) : 0, ruleId });
  }
  if (skipped) warnings.push(`gitleaks 报告有 ${skipped} 条记录缺少文件/规则或越界，已跳过`);
  if (ignored) warnings.push(`gitleaks 报告有 ${ignored} 条位于临时/构建/依赖目录，已忽略`);
  const findings = [];
  const byLocation = new Map();
  const withoutLine = [];
  for (const hit of hits) {
    if (hit.line > 0) {
      const key = `${hit.file}\u0000${hit.line}`;
      const group = byLocation.get(key);
      if (group) group.push(hit); else byLocation.set(key, [hit]);
    } else {
      withoutLine.push(hit);
    }
  }
  for (const group of byLocation.values()) {
    const sorted = group.slice().sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
    const kept = sorted[0];
    findings.push(toFinding(kept));
    if (sorted.length > 1) {
      const others = [...new Set(sorted.slice(1).map((h) => h.ruleId))];
      warnings.push(`gitleaks 同位置命中多条规则（${kept.file}:${kept.line}）：保留 ${kept.ruleId}，忽略 ${others.join('、')}`);
    }
  }
  for (const hit of withoutLine) findings.push(toFinding(hit));
  return { valid: true, findings, warnings };
}

function filterExcluded(findings, excludes) {
  const list = (Array.isArray(excludes) ? excludes : [])
    .map((x) => String(x).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, ''))
    .filter(Boolean);
  if (!list.length) return findings;
  return findings.filter((f) => !list.some((x) => f.file === x || f.file.startsWith(`${x}/`)));
}

function unavailable(gapReason, warning) {
  return { available: true, ok: false, gapKind: 'unavailable', gapReason, warnings: [warning], findings: [] };
}

// 跑 detect：数组参数、不开 shell；报告写 os.tmpdir() 唯一目录并在 finally 删除。
// scanHistory=true 时不加 --no-git（gitleaks 默认扫 git 历史）；默认只扫工作树。
export async function runGitleaks(projectDir, {
  binaryPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  scanHistory = false,
  excludes = [],
} = {}) {
  if (!binaryPath) {
    return {
      available: false,
      ok: false,
      status: null,
      timedOut: false,
      gapKind: null,
      gapReason: null,
      warnings: [GITLEAKS_MISSING_WARNING],
      findings: [],
    };
  }
  const parsedTimeout = Number(timeoutMs);
  const timeout = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  let tmpDir = null;
  try {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'finalcheck-gitleaks-'));
    const reportPath = path.join(tmpDir, 'report.json');
    const args = [
      'detect',
      '--source', String(projectDir),
      '--report-format', 'json',
      '--report-path', reportPath,
      ...(scanHistory ? [] : ['--no-git']),
      '--exit-code', '0',
      '--no-banner',
      '--redact',
    ];
    const viaNode = isNodeScriptPath(binaryPath);
    const run = await runProcess(
      viaNode ? process.execPath : binaryPath,
      viaNode ? [binaryPath, ...args] : args,
      { timeoutMs: timeout },
    );
    const status = run.status;
    if (status === 124) {
      return {
        available: true, ok: false, status: 124, timedOut: true,
        gapKind: 'unavailable', gapReason: 'gitleaks 运行超时',
        warnings: [`gitleaks 运行超时（${timeout}ms），本次不计为已执行`], findings: [],
      };
    }
    if (run.error || status === null) {
      return {
        ...unavailable('gitleaks 运行失败', `gitleaks 运行失败：${(run.error && run.error.code) || '无法启动'}`),
        status,
        timedOut: false,
      };
    }
    let reportText = null;
    try { reportText = await readFile(reportPath, 'utf8'); } catch { /* 报告缺失按不可用处理 */ }
    if (reportText == null) {
      return {
        ...unavailable('gitleaks 报告缺失或异常', 'gitleaks 报告缺失，本次不计为已执行'),
        status,
        timedOut: false,
      };
    }
    const parsed = parseGitleaksReport(reportText, projectDir);
    if (!parsed.valid) {
      return {
        ...unavailable('gitleaks 报告缺失或异常', parsed.warnings[0] || 'gitleaks 报告异常，本次不计为已执行'),
        status,
        timedOut: false,
      };
    }
    const warnings = parsed.warnings.slice();
    if (status !== 0) warnings.push(`gitleaks 退出码 ${status}（报告已解析）`);
    const filtered = filterExcluded(parsed.findings, excludes);
    if (filtered.length < parsed.findings.length) {
      warnings.push(`gitleaks 命中已按 exclude 过滤 ${parsed.findings.length - filtered.length} 条`);
    }
    return {
      available: true, ok: true, status, timedOut: false,
      gapKind: null, gapReason: null, warnings, findings: filtered,
    };
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
