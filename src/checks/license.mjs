import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// C1 许可证合规（L3 静态闸）
//
// 只做本地静态判定：读项目 package.json 的 dependencies/devDependencies 名称，
// 再读 node_modules/<name>/package.json 的 license 字段。不联网、不装包、不执行
// 任何被审项目的命令。没有 node_modules 就明说「依赖未安装」，不冒充已检查。
//
// 判定口径（刻意保守、可解释）：
//   GPL/AGPL/SSPL  → high  C1.copyleft      （闭源交付需替换或法务确认）
//   UNLICENSED/缺失 → medium C1.no-license   （没有可用许可证声明）
//   LGPL/MPL/EPL   → low   C1.weak-copyleft （弱传染，注意分发义务）
//   MIT/Apache/BSD/ISC/0BSD/CC0 → 不报
// 复杂 SPDX 表达式不精算：按最严格项判，并记 warning；`MIT OR Apache-2.0`
// 这类全宽松表达式按 MIT 处理，只提醒法务复核。
const MAX_FINDINGS = 40;

const COPYLEFT_RES = [
  /\bAGPL(?:-|v|\s|$)/i,
  /\bSSPL(?:-|v|\s|$)/i,
  /\bGPL(?:-|v|\s)*[23](?:\.0)?(?:-?only|-?or-later|\+)?\b/i,
  /\bGPL\b/i,
  /\bGNU General Public License/i,
  /\bAffero General Public License/i,
];

const WEAK_COPYLEFT_RES = [
  /\bLGPL(?:-|v|\s|$)/i,
  /\bMPL(?:-|v|\s|$)/i,
  /\bEPL(?:-|v|\s|$)/i,
  /\bMozilla Public License/i,
  /\bEclipse Public License/i,
];

// 明确无需报的宽松许可（只认常见 SPDX id/别名，未列到的一律 warning，不编结论）
const PERMISSIVE_RES = [
  /^MIT(?:-0)?(?:$|\s|\/)/i, // MIT / MIT-0 / MIT/X11
  /\bX11\b/i,
  /\bExpat\b/i,
  /^Apache(?:-|\s)*(?:License(?:-|\s)*)?(?:2\.0)?\b/i, // Apache-2.0 / Apache 2.0
  /^0BSD\b/i,
  /^BSD(?:-[234]-Clause)?\b/i, // BSD / BSD-2-Clause / BSD-3-Clause
  /^\bISC\b/i,
  /^CC0(?:-1\.0)?\b/i,
  /^Unlicense\b/i,
  /^WTFPL\b/i,
  /^Zlib\b/i,
  /^BlueOak-1\.0\.0\b/i,
  /^Python-2\.0\b/i,
  /^Artistic-2\.0\b/i,
];

/** package.json 的 license/licenses 归一成字符串；对象与旧式 licenses 数组都兼容 */
export function extractLicenseValue(pkg) {
  if (!pkg || typeof pkg !== 'object') return '';
  const one = (v) => {
    if (typeof v === 'string') return v.trim();
    if (v && typeof v === 'object') return String(v.type || v.name || '').trim();
    return '';
  };
  const first = one(pkg.license);
  if (first) return first;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map(one).filter(Boolean).join(' AND ');
  }
  return one(pkg.licenses);
}

function seeLicenseFileExists(pkgDir, raw) {
  const m = /^SEE LICENSE IN\s+(.+)$/i.exec(raw);
  if (!m) return null;
  const rel = m[1].trim().replace(/^['"]|['"]$/g, '');
  if (!rel) return { rel, exists: false };
  const abs = path.resolve(pkgDir, rel);
  let exists = false;
  try { exists = existsSync(abs) && statSync(abs).isFile(); } catch { exists = false; }
  return { rel, exists };
}

/** 单个许可标识判定；返回 {kind, reason?}，kind: copyleft|weak|no-license|permissive|declared-file|unknown */
export function classifyLicense(raw, { pkgDir = process.cwd() } = {}) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'no-license', reason: 'license 字段缺失' };
  if (/^UNLICENSED$/i.test(s)) return { kind: 'no-license', reason: '显式标记 UNLICENSED' };

  const see = seeLicenseFileExists(pkgDir, s);
  if (see) {
    return see.exists
      ? { kind: 'declared-file', reason: `许可证文件存在（${see.rel}）` }
      : { kind: 'no-license', reason: `SEE LICENSE IN 指向的文件不存在（${see.rel || '空路径'}）` };
  }

  for (const re of COPYLEFT_RES) if (re.test(s)) return { kind: 'copyleft' };
  for (const re of WEAK_COPYLEFT_RES) if (re.test(s)) return { kind: 'weak' };
  for (const re of PERMISSIVE_RES) if (re.test(s)) return { kind: 'permissive' };
  return { kind: 'unknown' };
}

/** 复杂表达式：按 AND/OR 拆项后 fail-closed（任一强传染即强传染） */
function classifyExpression(raw, { pkgDir } = {}) {
  const s = String(raw || '').trim();
  const stripped = s.replace(/\s+WITH\s+[^()]+/i, '').trim();
  const complex = /\s(?:AND|OR)\s/i.test(s) || /[()]/.test(s) || /\sWITH\s/i.test(s);
  if (!complex) return { ...classifyLicense(stripped, { pkgDir }), complex: false, expression: s };

  const terms = stripped.replace(/[()]/g, ' ').split(/\s+(?:AND|OR)\s+/i).map((t) => t.trim()).filter(Boolean);
  const kinds = terms.map((t) => ({ term: t, ...classifyLicense(t, { pkgDir }) }));
  const kindOf = (k) => kinds.find((x) => x.kind === k);
  let kind = 'unknown';
  let reason = '';
  if (kindOf('copyleft')) kind = 'copyleft';
  else if (kindOf('no-license')) { kind = 'no-license'; reason = kindOf('no-license').reason; }
  else if (kindOf('weak')) kind = 'weak';
  else if (kinds.every((x) => x.kind === 'permissive' || x.kind === 'declared-file')) kind = 'permissive';
  return { kind, reason, complex: true, expression: s, terms: kinds.map((x) => `${x.term}:${x.kind}`) };
}

function isExcludedName(name, excludes) {
  const n = String(name || '');
  return (Array.isArray(excludes) ? excludes : []).some((x) => {
    const e = String(x || '').replace(/\\/g, '/');
    return e === n || e === `node_modules/${n}` || e.endsWith(`/${n}`);
  });
}

// 依赖名只允许 npm 合法形态，避免被恶意 package.json 用 ../ 拉出 node_modules 读别的文件
const SAFE_DEP_NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/;

async function readInstalledLicense(projectDir, name) {
  const manifest = path.join(projectDir, 'node_modules', name, 'package.json');
  try {
    const st = await stat(manifest);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null; // 恶意/异常大清单不解析
    const pkg = JSON.parse(await readFile(manifest, 'utf8'));
    return { pkg, manifest, pkgDir: path.dirname(manifest) };
  } catch { return null; }
}

export async function checkLicense(projectDir, { tier, excludes = [] } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L3').toUpperCase();
  const forceFor = (severity) => (t === 'L3' ? 'card' : severity === 'low' ? 'tip' : 'check');

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  } catch {
    return { checkId: 'C1', findings, coverageGap: '无 package.json，许可证关未跑', warnings };
  }

  const depSpecs = new Map();
  for (const field of ['dependencies', 'devDependencies']) {
    const obj = pkg[field];
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const name of Object.keys(obj)) {
      if (!depSpecs.has(name)) depSpecs.set(name, String(obj[name] ?? ''));
    }
  }

  const allFindings = [];
  const projectLicense = extractLicenseValue(pkg);
  if (!projectLicense) {
    allFindings.push({
      checkId: 'C1', severity: 'medium', force: forceFor('medium'), file: 'package.json', line: 0,
      rule: 'C1.project-no-license', snippet: '无 license 字段',
      message: '项目自身 package.json 缺少 license 字段：交付方无法判定授权范围', source: 'program'
    });
  } else if (/^UNLICENSED$/i.test(projectLicense)) {
    warnings.push('项目自身 license 为 UNLICENSED：交付前需确认授权与分发范围');
  }

  let coverageGap = null;
  let nmExists = false;
  try { nmExists = (await stat(path.join(projectDir, 'node_modules'))).isDirectory(); } catch { nmExists = false; }

  const names = [...depSpecs.keys()].sort();
  if (names.length && !nmExists) {
    coverageGap = 'C1：依赖未安装，许可证关未跑（npm ci 后可跑）';
  }

  let resolved = 0;
  let considered = 0;
  const missing = [];
  if (nmExists) {
    for (const name of names) {
      if (isExcludedName(name, excludes)) continue;
      if (!SAFE_DEP_NAME.test(name)) {
        warnings.push(`依赖名不合法，已跳过：${name}`);
        continue;
      }
      considered++;
      const installed = await readInstalledLicense(projectDir, name);
      if (!installed) { missing.push(name); continue; }
      resolved++;
      const raw = extractLicenseValue(installed.pkg);
      const verdict = classifyExpression(raw, { pkgDir: installed.pkgDir });
      const version = installed.pkg.version || depSpecs.get(name) || '?';
      const licenseText = raw || '无 license 字段';

      if (verdict.complex) {
        warnings.push(`依赖 ${name} 的许可证表达式较复杂（${raw}），按最严格项判定，建议法务复核`);
      }
      if (verdict.kind === 'unknown') {
        warnings.push(`依赖 ${name} 的许可证未识别：${raw}（未按通过处理，建议人工确认）`);
        continue;
      }
      if (verdict.kind === 'declared-file') continue;

      if (verdict.kind === 'copyleft') {
        allFindings.push({
          checkId: 'C1', severity: 'high', force: forceFor('high'), file: 'package.json', line: 0,
          rule: 'C1.copyleft', snippet: `${name}@${version} · ${licenseText}`,
          message: `依赖 ${name} 使用传染性许可证（${licenseText}）：闭源交付需替换或法务确认`, source: 'program'
        });
        continue;
      }
      if (verdict.kind === 'weak') {
        allFindings.push({
          checkId: 'C1', severity: 'low', force: forceFor('low'), file: 'package.json', line: 0,
          rule: 'C1.weak-copyleft', snippet: `${name}@${version} · ${licenseText}`,
          message: `依赖 ${name} 使用弱传染许可证（${licenseText}）：分发/链接需履行对应许可证义务`, source: 'program'
        });
        continue;
      }
      if (verdict.kind === 'no-license') {
        allFindings.push({
          checkId: 'C1', severity: 'medium', force: forceFor('medium'), file: 'package.json', line: 0,
          rule: 'C1.no-license', snippet: `${name}@${version} · 无可用许可证`,
          message: `依赖 ${name} ${verdict.reason || '没有许可证声明'}，交付前无法确认授权`, source: 'program'
        });
      }
    }
  }

  if (missing.length) {
    warnings.push(`${missing.length} 个依赖在 node_modules 中缺失，许可证未查：${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}`);
  }
  if (considered > 0 && resolved === 0) {
    coverageGap = 'C1：依赖未安装，许可证关未跑（npm ci 后可跑）';
  }

  if (allFindings.length > MAX_FINDINGS) {
    // 上限含汇总条：前 39 条逐条列出 + 1 条 C1.more，总数不超过 40
    const tail = allFindings.slice(MAX_FINDINGS - 1);
    findings.push(...allFindings.slice(0, MAX_FINDINGS - 1));
    findings.push({
      checkId: 'C1', severity: 'medium', force: forceFor('medium'), file: 'package.json', line: 0,
      rule: 'C1.more', snippet: `另有 ${tail.length} 个`,
      message: `许可证问题共 ${allFindings.length} 项，已列出前 ${MAX_FINDINGS - 1} 项，其余 ${tail.length} 项汇总`,
      source: 'program'
    });
  } else {
    findings.push(...allFindings);
  }

  return { checkId: 'C1', findings, coverageGap, warnings };
}
