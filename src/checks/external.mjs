import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles, readRel, prunedWarning } from '../walk.mjs';
import { extractRoutes } from '../extract-routes.mjs';

// S6 外部入口（ACCEPTANCE §4-A）。只报两类确定性证据，宁窄勿宽：
//   (a) 公开的 webhook/callback 路由所在文件里看不到验签关键词（hmac/signature/verify）；
//   (b) CORS 允许任意 Origin（`*` / origin:true）且同时开启 credentials。
// 没有路由上下文（非 Express / 路由表解析为空）时不报 webhook 项，只写 warning 说明跳过原因。
// 路由表复用 extract-routes 的判定（不在这里手写递归遍历）；文件清单仍走 walk.mjs。

const WEBHOOK_PATH_RE = /(?:webhook|callback|hook)/i;
const VERIFY_RE = /hmac|signature|verify/i; // 同文件内任一关键词即视为有验签线索（宁漏勿误）
const CORS_WILDCARD_RES = [
  /origin\s*:\s*(?:['"]\*['"]|true)/i,
  /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]?\*/i,
];
const CORS_CRED_RE = /credentials\s*:\s*true|Access-Control-Allow-Credentials['"]?\s*[,:]\s*['"]?true/i;
// 文档里的 CORS 教学示例不算实锤（同 secrets.mjs 的既有约定）
const DOC_RE = /\.(?:md|markdown|txt|rst|adoc)$/i;

function isExcluded(rel, excludes) {
  const r = String(rel || '').replace(/\\/g, '/');
  return (Array.isArray(excludes) ? excludes : []).some((x) => {
    const n = String(x || '').replace(/\\/g, '/');
    return r === n || r.startsWith(n + '/');
  });
}

// 与 extract-routes 的 publicRoutes 语义保持一致（含 * / /** / 前缀匹配）
function isPublicPath(routePath, publicRoutes) {
  return publicRoutes.some((entry) => {
    if (entry === '*' || entry === '/*') return true;
    if (entry === routePath) return true;
    if (entry.endsWith('/*')) {
      const base = entry.slice(0, -2);
      return routePath === base || routePath.startsWith(base + '/');
    }
    if (entry.endsWith('*')) return routePath.startsWith(entry.slice(0, -1));
    return routePath.startsWith(entry + '/');
  });
}

export async function checkExternal(projectDir, { tier, excludes = [] } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  const force = t === 'L1' ? 'tip' : 'card';

  // ---- (a) webhook/callback 验签 ----
  const routeResult = await extractRoutes(projectDir);
  const allRoutes = Array.isArray(routeResult && routeResult.routes) ? routeResult.routes : [];
  const routes = allRoutes.filter((r) => !isExcluded(String(r.file || ''), excludes));
  if (!allRoutes.length) {
    warnings.push('S6：未发现可解析的路由上下文（仅支持 Express 路由表），webhook 验签检查跳过');
  } else if (!routes.length) {
    warnings.push('S6：路由文件均被 excludes 排除，webhook 验签检查跳过');
  } else {
    if (routeResult.warnings?.length) {
      warnings.push(`S6：路由提取警告 ${routeResult.warnings.length} 条（部分路由可能未纳入判定）`);
    }
    const publicRoutes = Array.isArray(routeResult.publicRoutes) ? routeResult.publicRoutes : [];
    const textCache = new Map();
    const readText = async (rel) => {
      if (textCache.has(rel)) return textCache.get(rel);
      let text = null;
      try { text = await readFile(path.join(projectDir, rel), 'utf8'); }
      catch { warnings.push(`S6：无法读取路由文件 ${rel}，验签检查跳过该文件`); }
      textCache.set(rel, text);
      return text;
    };
    const seen = new Set();
    for (const r of routes) {
      const routePath = String(r.path || '');
      if (!WEBHOOK_PATH_RE.test(routePath)) continue;
      // 公开 = 无守卫，或显式登记进 finalcheck.config.json 的 publicRoutes
      const isPublic = !r.hasGuard || isPublicPath(routePath, publicRoutes);
      if (!isPublic) continue;
      const rel = String(r.file || '');
      const text = await readText(rel);
      if (text == null) continue;
      if (VERIFY_RE.test(text)) continue; // 同文件有验签关键词 → 不报
      const routeLine = Number(r.line) || 1;
      const lineText = text.split('\n')[routeLine - 1] || '';
      if (lineText.includes('finalcheck:allow')) continue;
      const key = `${rel}|${routeLine}|${r.method}|${routePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        checkId: 'S6',
        severity: 'high',
        force,
        file: rel,
        line: routeLine,
        rule: 'S6.webhook-no-verify',
        snippet: `${String(r.method || '').toUpperCase()} ${routePath}`,
        message: '公开 webhook/callback 路由所在文件未见签名校验调用（hmac/signature/verify）——请补验签；若验签在别处实现，请加 finalcheck:allow 说明',
        source: 'program',
      });
    }
  }

  // ---- (b) CORS 任意 Origin + credentials ----
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes);
  if (skipped.length) warnings.push(`S6：跳过大文件 ${skipped.length} 个（>512KB 未扫描）：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}`);
  const pw = prunedWarning(pruned);
  if (pw) warnings.push(`S6：${pw}`);

  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    if (DOC_RE.test(file)) continue;
    if (/package-lock|yarn\.lock|pnpm-lock/.test(file)) continue;
    if (!CORS_CRED_RE.test(text)) continue; // 无 credentials 不报（S5 已单管 CORS *）
    const lines = text.split('\n');
    let wildcardLine = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 1000) continue; // 压缩/第三方代码
      if (CORS_WILDCARD_RES.some((re) => re.test(line))) { wildcardLine = i; break; }
    }
    if (wildcardLine < 0) continue; // Origin 受限，不是任意来源
    if (lines[wildcardLine].includes('finalcheck:allow')) continue;
    findings.push({
      checkId: 'S6',
      severity: 'high',
      force,
      file,
      line: wildcardLine + 1,
      rule: 'S6.cors-wildcard-credentials',
      snippet: lines[wildcardLine].trim().slice(0, 120),
      message: 'CORS 允许任意 Origin（* / origin:true）且同时开启 credentials——浏览器会允许任意站点携带凭据访问，请改为固定白名单；若已有网关层限制，请加 finalcheck:allow 说明',
      source: 'program',
    });
  }

  return { checkId: 'S6', findings, coverageGap: null, warnings };
}
