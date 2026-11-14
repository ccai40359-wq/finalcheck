import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles, readRel, prunedWarning } from '../walk.mjs';
import { extractRoutes } from '../extract-routes.mjs';
import { sourceModel, routeHandlers, someCall, memberName } from '../source-analysis.mjs';
import { isGuardName } from './routes.mjs';

// S6 外部入口（ACCEPTANCE §4-A）。只报两类确定性证据，宁窄勿宽：
//   (a) 公开的 webhook/callback 路由所在文件里看不到验签关键词（hmac/signature/verify）；
//   (b) CORS 允许任意 Origin（`*` / origin:true）且同时开启 credentials。
// 没有路由上下文（非 Express / 路由表解析为空）时不报 webhook 项，只写 warning 说明跳过原因。
// 路由表复用 extract-routes 的判定（不在这里手写递归遍历）；文件清单仍走 walk.mjs。

const WEBHOOK_PATH_RE = /(?:webhook|callback|hook)/i;
const VERIFY_RE = /hmac|signature|verify/i;
const CORS_WILDCARD_RES = [
  /origin\s*:\s*(?:['"]\*['"]|true)/i,
  /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]?\*/i,
];
const CORS_CRED_RE = /credentials\s*:\s*true|Access-Control-Allow-Credentials['"]?\s*[,:]\s*['"]?true/i;
// 文档里的 CORS 教学示例不算实锤（同 secrets.mjs 的既有约定）
const DOC_RE = /\.(?:md|markdown|txt|rst|adoc)$/i;
const CORS_WILD_GLOBAL = CORS_WILDCARD_RES.map((re) => new RegExp(re.source, `${re.flags}g`));
const CORS_CRED_GLOBAL = new RegExp(CORS_CRED_RE.source, `${CORS_CRED_RE.flags}g`);

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineNumberAt(lineStarts, index) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// For each match offset, record the innermost open `{` (block id) containing it.
// Strings/comments are skipped so brace characters inside them do not create
// fake blocks. A match outside any block gets -1.
function braceBlocksAt(text, positions) {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const blocks = new Map();
  if (!sorted.length) return blocks;
  const stack = [];
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let k = 0;
  for (let i = 0; i < text.length; i++) {
    while (k < sorted.length && sorted[k] === i) {
      blocks.set(i, stack.length ? stack[stack.length - 1] : -1);
      k++;
    }
    if (k >= sorted.length) break;
    const ch = text[i];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && text[i + 1] === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && text[i + 1] === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && text[i + 1] === '*') { blockComment = true; i++; continue; }
    if (ch === '{') stack.push(i);
    else if (ch === '}' && stack.length) stack.pop();
  }
  for (const p of sorted) if (!blocks.has(p)) blocks.set(p, -1);
  return blocks;
}

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

export async function checkExternal(projectDir, { tier, excludes = [], includeFixtures = false } = {}) {
  const findings = [];
  const warnings = [];
  let coverageGap = null;
  let gapKind;
  let noRouteContext = false;
  const t = String(tier || 'L2').toUpperCase();
  const force = t === 'L1' ? 'tip' : 'card';

  // ---- (a) webhook/callback 验签 ----
  const routeResult = await extractRoutes(projectDir);
  const allRoutes = Array.isArray(routeResult && routeResult.routes) ? routeResult.routes : [];
  const routes = allRoutes.filter((r) => !isExcluded(String(r.file || ''), excludes));
  if (!allRoutes.length) {
    const fwList = routeResult?.unsupportedFrameworks || [];
    if (fwList.length || routeResult?.httpSurface?.exists) {
      const fw = fwList.length ? `（框架：${fwList.join('；')}）` : '（检测到自定义 HTTP server / 路由挂载调用）';
      coverageGap = `S6：检测到 HTTP 服务/路由注册${fw}，但路由提取器未解析出路由表，webhook 验签未覆盖`;
      gapKind = 'unavailable';
    } else {
      // 没有 HTTP 信号：webhook 段不适用；但 CORS 段仍会扫文件，等扫完再决定缺口。
      noRouteContext = true;
    }
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
      // 公开 = 无守卫，或显式登记进 finalcheck.config.json 的 publicRoutes。
      // 有 middlewares 时复用 S1 的 isGuardName 重新判定（routes.isLoggedIn 不是
      // 「公开」，authRoutes 也不是守卫）；老调用方只给 hasGuard 布尔值时沿用。
      const hasGuard = r.hasInternalGuard || (Array.isArray(r.middlewares)
        ? r.middlewares.some((m) => isGuardName(m))
        : Boolean(r.hasGuard));
      const isPublic = !hasGuard || isPublicPath(routePath, publicRoutes);
      if (!isPublic) continue;
      const rel = String(r.file || '');
      const text = await readText(rel);
      if (text == null) continue;
      const model = sourceModel(text);
      const handlers = routeHandlers(model, r);
      if (someCall(handlers.nodes, (call) => VERIFY_RE.test(memberName(call.callee) || call.callee?.name || ''))) continue;
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
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes, { includeFixtures });
  if (skipped.length) warnings.push(`S6：跳过大文件 ${skipped.length} 个（>512KB 未扫描）：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}`);
  const pw = prunedWarning(pruned);
  if (pw) warnings.push(`S6：${pw}`);

  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    if (DOC_RE.test(file)) continue;
    if (/package-lock|yarn\.lock|pnpm-lock/.test(file)) continue;
    const creds = [...text.matchAll(CORS_CRED_GLOBAL)];
    if (!creds.length) continue; // 无 credentials 不报（S5 已单管 CORS *）
    const wildcards = [];
    for (const re of CORS_WILD_GLOBAL) for (const m of text.matchAll(re)) wildcards.push(m);
    if (!wildcards.length) continue; // Origin 受限，不是任意来源

    const lines = text.split('\n');
    const lineStarts = lineStartsOf(text);
    const blocks = braceBlocksAt(text, [...wildcards.map((m) => m.index), ...creds.map((m) => m.index)]);
    // 只在同一对象字面量/同一代码块内组合 wildcard + credentials。
    // 跨块拼凑（origin:'*' 一块、credentials:true 另一块）不报。
    let hit = null;
    for (const w of wildcards) {
      const wLine = lineNumberAt(lineStarts, w.index);
      if ((lines[wLine - 1] || '').length > 1000) continue; // 压缩/第三方代码
      for (const c of creds) {
        const cLine = lineNumberAt(lineStarts, c.index);
        if (Math.abs(cLine - wLine) > 10) continue; // 同文件 ±10 行窗口
        if (cLine === wLine) { hit = { match: w, line: wLine }; break; }
        const wBlock = blocks.get(w.index);
        const cBlock = blocks.get(c.index);
        if (wBlock >= 0 && wBlock === cBlock) { hit = { match: w, line: wLine }; break; }
      }
      if (hit) break;
    }
    if (!hit) continue;
    if (lines[hit.line - 1].includes('finalcheck:allow')) continue;
    findings.push({
      checkId: 'S6',
      severity: 'high',
      force,
      file,
      line: hit.line,
      rule: 'S6.cors-wildcard-credentials',
      snippet: lines[hit.line - 1].trim().slice(0, 120),
      message: 'CORS 允许任意 Origin（* / origin:true）且同时开启 credentials——浏览器会允许任意站点携带凭据访问，请改为固定白名单；若已有网关层限制，请加 finalcheck:allow 说明',
      source: 'program',
    });
  }

  // 没有任何路由，也没有 CORS 命中 = 没有可查的外部入口，记 N/A；有 CORS 命中说明 S6 实际执行过。
  if (noRouteContext && !findings.length) {
    coverageGap = 'S6：未发现可解析的 HTTP 路由上下文（仅支持 Express 路由表），webhook/CORS 外部入口不适用';
    gapKind = 'not-applicable';
  }

  return { checkId: 'S6', findings, coverageGap, ...(gapKind ? { gapKind } : {}), warnings };
}
