import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scanIpc } from './ipc.mjs';

// S7 越权/IDOR（ACCEPTANCE §4-A）。输入路由表（extractRoutes 产物，形状
// { method, path, file, line, hasGuard }）。目标路由 = 带 :id 动态段的
// GET/PUT/PATCH/DELETE，或任意 POST。判定只做“路由文件里有无属主过滤模式”
// 的零/非零检查；零命中 → 每条目标路由一条 finding 转人工确认
// （规则不冒充结论，Acceptance §3：人工确认不过才算卡）。
//
// 没有 HTTP 路由的桌面项目不等于「没查」：Electron 的 ipcMain.handle/on 是
// 同样真实的权限面，S7 改跑 IPC 校验扫描；HTTP 与 IPC 都没有才是结构性的
// 「不适用」（gapKind=not-applicable，不封顶结论）。

const NOT_APPLICABLE_REASON = '未发现 HTTP 路由或 IPC 权限面，越权检查不适用（需人工确认本地权限面）';

const TARGET_METHODS = new Set(['get', 'put', 'patch', 'delete']);
const RE_DYNAMIC = /:[A-Za-z_][A-Za-z0-9_]*/; // :id / :userId 类动态段
const RE_DAC = /\b(?:where|findOne|filter|update|delete|remove|destroy|find\w+)\b/i; // 数据访问上下文
const RE_OWNER = /\b(?:userId|user_id|ownerId|owner_id)\b|\breq\s*\.\s*user\b/i; // 属主过滤模式
const GUIDANCE = '属主过滤未检出——请人工确认该接口是否校验资源属主；确认有校验可加 finalcheck:allow 或改造写法';

function isExcluded(rel, excludes) {
  return excludes.some((x) => { const n = String(x).replace(/\\/g, '/'); return rel === n || rel.startsWith(n + '/'); });
}

// 没有 HTTP 目标路由时的第二权限面：Electron IPC。返回 null 表示「没有 IPC handler」，
// 由调用方决定是记 N/A（完全无权限面）还是保留原来的「无目标路由」coverageGap。
function scanIpcFallback(projectDir, excludes, warnings) {
  let ipc;
  try {
    ipc = scanIpc(projectDir, { excludes });
  } catch (e) {
    ipc = { handlers: [], findings: [], warnings: [`IPC 扫描异常：${e && e.message ? e.message : e}`] };
  }
  warnings.push(...(ipc.warnings || []));
  if (!ipc.handlers || !ipc.handlers.length) return null;
  return { checkId: 'S7', findings: ipc.findings || [], coverageGap: null, warnings };
}

export async function checkAuthz(projectDir, { tier, excludes = [], routeResult = null } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  const force = t === 'L3' ? 'card' : 'check'; // 矩阵：L2 查 / L3 卡（L1 不调用）
  // 没有真实路由目标 = 未覆盖，不是通过。只有实际读取并分析了 ≥1 条目标路由，
  // 才允许在零命中时给出「通过」；否则 S7 必须记 coverageGap（kind=unavailable）。
  const routes = Array.isArray(routeResult && routeResult.routes) ? routeResult.routes : [];
  if (!routes.length) {
    // 无 HTTP 路由：桌面项目改查 IPC 权限面。有 handler → 正常结果（coverageGap=null）；
    // 两者都没有 → 结构性不适用，不封顶结论，但报告必须点名「该项未验证」。
    const ipc = scanIpcFallback(projectDir, excludes, warnings);
    if (ipc) return ipc;
    return { checkId: 'S7', findings, coverageGap: NOT_APPLICABLE_REASON, gapKind: 'not-applicable', warnings };
  }
  const byFile = new Map();
  for (const r of routes) {
    const method = String(r.method || '').toLowerCase();
    const p = String(r.path || '');
    const isTarget = (TARGET_METHODS.has(method) && RE_DYNAMIC.test(p)) || method === 'post';
    if (!isTarget) continue;
    if (isExcluded(String(r.file || ''), excludes)) continue;
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }
  if (!byFile.size) {
    // HTTP 路由存在但没有 S7 目标：若项目还有 IPC 权限面，S7 仍可查 IPC；
    // 完全没有可分析权限面时才保留原来的 coverageGap。
    const ipc = scanIpcFallback(projectDir, excludes, warnings);
    if (ipc) return ipc;
    return {
      checkId: 'S7',
      findings,
      coverageGap: '未发现可分析的目标路由（GET/PUT/PATCH/DELETE 含动态段或 POST；可能全部被 exclude 排除），未验证',
      warnings,
    };
  }
  let analyzedRoutes = 0;
  for (const [file, rs] of byFile) {
    if (typeof file !== 'string' || !file) {
      warnings.push('路由条目缺少 file 字段，S7 跳过该条');
      continue;
    }
    const text = await readFile(path.join(projectDir, file), 'utf8').catch(() => null);
    if (text == null) {
      warnings.push(`无法读取路由文件 ${file}，S7 跳过该文件`);
      continue;
    }
    analyzedRoutes += rs.length;
    const lines = text.split('\n');
    const hasOwner = lines.some((l) => RE_DAC.test(l) && RE_OWNER.test(l));
    if (hasOwner) continue; // 文件级：任何一条属主过滤模式即视为该文件有校验
    for (const r of rs) {
      const lineText = lines[(Number(r.line) || 1) - 1] || '';
      if (lineText.includes('finalcheck:allow')) continue; // 行内豁免（人工已确认）
      findings.push({
        checkId: 'S7',
        severity: 'high',
        force,
        file,
        line: Number(r.line) || 0,
        rule: 'S7.no-owner-filter',
        snippet: `${String(r.method || '').toUpperCase()} ${r.path}`,
        message: GUIDANCE,
        source: 'program',
      });
    }
  }
  if (!analyzedRoutes) {
    return { checkId: 'S7', findings, coverageGap: '目标路由文件均不可读，未验证', warnings };
  }
  return { checkId: 'S7', findings, coverageGap: null, warnings };
}
