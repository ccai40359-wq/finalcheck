import { readFile } from 'node:fs/promises';
import path from 'node:path';

// S7 越权/IDOR（ACCEPTANCE §4-A）。输入路由表（extractRoutes 产物，形状
// { method, path, file, line, hasGuard }）。目标路由 = 带 :id 动态段的
// GET/PUT/PATCH/DELETE，或任意 POST。判定只做“路由文件里有无属主过滤模式”
// 的零/非零检查；零命中 → 每条目标路由一条 finding 转人工确认
// （规则不冒充结论，Acceptance §3：人工确认不过才算卡）。

const TARGET_METHODS = new Set(['get', 'put', 'patch', 'delete']);
const RE_DYNAMIC = /:[A-Za-z_][A-Za-z0-9_]*/; // :id / :userId 类动态段
const RE_DAC = /\b(?:where|findOne|filter|update|delete|remove|destroy|find\w+)\b/i; // 数据访问上下文
const RE_OWNER = /\b(?:userId|user_id|ownerId|owner_id)\b|\breq\s*\.\s*user\b/i; // 属主过滤模式
const GUIDANCE = '属主过滤未检出——请人工确认该接口是否校验资源属主；确认有校验可加 finalcheck:allow 或改造写法';

function isExcluded(rel, excludes) {
  return excludes.some((x) => { const n = String(x).replace(/\\/g, '/'); return rel === n || rel.startsWith(n + '/'); });
}

export async function checkAuthz(projectDir, { tier, excludes = [], routeResult = null } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  const force = t === 'L3' ? 'card' : 'check'; // 矩阵：L2 查 / L3 卡（L1 不调用）
  const routes = Array.isArray(routeResult && routeResult.routes) ? routeResult.routes : [];
  if (!routeResult) warnings.push('未提供 routeResult（路由表），S7 未执行');
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
  for (const [file, rs] of byFile) {
    const text = await readFile(path.join(projectDir, file), 'utf8').catch(() => null);
    if (text == null) {
      warnings.push(`无法读取路由文件 ${file}，S7 跳过该文件`);
      continue;
    }
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
  return { checkId: 'S7', findings, coverageGap: null, warnings };
}
