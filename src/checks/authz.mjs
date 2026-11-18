import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scanIpc } from './ipc.mjs';
import { sourceModel, routeHandlers, someCall, memberName } from '../source-analysis.mjs';

// S7 越权/IDOR（ACCEPTANCE §4-A）。输入路由表（extractRoutes 产物，形状
// { method, path, file, line, hasGuard }）。目标路由 = 带 :id 动态段的
// GET/PUT/PATCH/DELETE，或任意 POST。判定只做“当前路由处理函数里有无属主过滤调用”
// 的零/非零检查；零命中 → 每条目标路由一条 finding 转人工确认
// （规则不冒充结论，Acceptance §3：人工确认不过才算卡）。
//
// 没有 HTTP 路由的桌面项目不等于「没查」：Electron 的 ipcMain.handle/on 是
// 同样真实的权限面，S7 改跑 IPC 校验扫描；HTTP 与 IPC 都没有才是结构性的
// 「不适用」（gapKind=not-applicable，不封顶结论）。

const NOT_APPLICABLE_REASON = '未发现 HTTP 路由或 IPC 权限面，越权检查不适用（需人工确认本地权限面）';

const TARGET_METHODS = new Set(['get', 'put', 'patch', 'delete']);
const RE_DYNAMIC = /:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\}/; // :id（Express）与 {user_id}（FastAPI/Flask）动态段
const RE_DAC = /\b(?:where|findOne|filter|update|delete|remove|destroy|create|insert|save|upsert|find\w+)\b/i; // 数据访问上下文
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
    // 空路由表但有 HTTP 服务/路由注册信号（自定义 server、框架工厂、非 JS 框架）
    // → 路由提取器未解析出路由表，S7 未覆盖，不能记 not-applicable。
    const httpSignal = Boolean(routeResult?.unsupportedFrameworks?.length) || Boolean(routeResult?.httpSurface?.exists);
    if (httpSignal) {
      const fw = routeResult?.unsupportedFrameworks?.length
        ? `框架：${routeResult.unsupportedFrameworks.join('；')}`
        : '检测到自定义 HTTP server / 路由挂载调用';
      // HTTP 面未解析不等于没有 IPC 面：Electron/桌面项目可能同时有 node:http 服务与 ipcMain。
      // 先跑 IPC 兜底，有 IPC 结果就把 findings 保留、HTTP 缺口附加进去，不能把 IPC 漏洞吞掉。
      const ipc = scanIpcFallback(projectDir, excludes, warnings);
      const httpGap = `检测到 HTTP 服务/路由注册，但路由提取器未解析出路由表，S7 越权检查未覆盖（${fw}）`;
      if (ipc) {
        return {
          ...ipc,
          coverageGap: ipc.coverageGap ? `${ipc.coverageGap}；${httpGap}` : httpGap,
          gapKind: 'unavailable',
          warnings: [...(ipc.warnings || []), ...warnings],
        };
      }
      return {
        checkId: 'S7',
        findings,
        coverageGap: httpGap,
        gapKind: 'unavailable',
        warnings,
      };
    }
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
  let pyRoutesAnalyzed = 0; // Python 路由条数（用于 pythonCoverage 声明，解除语言缺口）
  for (const [file, rs] of byFile) {
    if (typeof file !== 'string' || !file) {
      warnings.push('路由条目缺少 file 字段，S7 跳过该条');
      continue;
    }
    const text = (await readFile(path.join(projectDir, file), 'utf8').catch(() => null))?.replace(/\r\n/g, '\n') ?? null; // CRLF 归一
    if (text == null) {
      warnings.push(`无法读取路由文件 ${file}，S7 跳过该文件`);
      continue;
    }
    // 2026-11-17：Python 路由文件不能喂 Babel（sourceModel 必返 null → 整个文件被跳过，
    // S7 永远「未解析到任何路由定义」，fastapi 实测的缺口就是这个）。
    // 改成按「处理函数体区间」做行级证据扫描，判据与 JS 侧同义：
    //   函数体内有数据访问调用 + 属主标识（user_id/owner_id/current_user），或
    //   签名里有鉴权依赖注入（Depends(get_current_user)）。
    if (isPyFile(file)) {
      const lines = text.split('\n');
      for (const r of rs) {
        const h = pyHandlerSpan(text, r);
        if (!h) { warnings.push(`${file}:${r.line}：无法定位 Python 处理函数，越权检查未覆盖该条`); continue; }
        analyzedRoutes++;
        pyRoutesAnalyzed++;
        // 2026-11-17 基准实测修正（tests/benchmark/python）：
        //   ① 没有任何数据访问的处理函数谈不上越权（导入购物车、算表达式），不报；
        //   ② 无动态段的 POST 只有在按请求里的 id 取资源时才是目标（注册/登录不是）；
        //   ③ 「已登录」不等于「校验了属主」：Depends(get_current_user)/@login_required 是 S1 的证据，
        //      不能让 S7 整条跳过（FastAPI 的 db.query(Note).get(note_id) 就这样漏掉）。
        if (!PY_DAC_RE.test(h.body)) continue;
        if (String(r.method || '').toLowerCase() === 'post' && !RE_DYNAMIC.test(String(r.path || '')) && !PY_ID_INPUT_RE.test(h.body)) continue;
        if (PY_OWNER_RE.test(h.body) || PY_ROLE_RE.test(h.body)) continue;
        // ④ 只查公开内容（published=True / is_public）不是越权；
        // ⑤ webhook/回调是服务器对服务器的调用，没有「当前用户」，该查的是验签（S6），不是属主
        if (PY_PUBLIC_FILTER_RE.test(h.body)) continue;
        if (/webhook|callback|\bhook\b|notify/i.test(String(r.path || '')) || /\bdef\s+\w*(?:webhook|callback)\w*\s*\(/i.test(h.body)) continue;
        const lineText = lines[(Number(r.line) || 1) - 1] || '';
        if (lineText.includes('finalcheck:allow')) continue;
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
      continue;
    }
    const model = sourceModel(text);
    if (!model) { warnings.push(`${file}：无法解析路由处理函数，越权检查未覆盖`); continue; }
    const lines = text.split('\n');
    for (const r of rs) {
      const handlers = routeHandlers(model, r);
      if (handlers.resolved) analyzedRoutes++;
      const hasOwner = someCall(handlers.nodes, (call) => RE_DAC.test(memberName(call.callee) || call.callee?.name || '')
        && call.arguments.some((arg) => RE_OWNER.test(model.text(model.resolve(arg) || arg))));
      if (hasOwner) continue;
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
    // 2026-11-17 修文案：条件其实是「一条路由都没解析出来」，旧文案写成「文件均不可读」，
    // 让人以为是权限/路径问题去查错方向。真实常见原因有两个：
    //   ① 不是 JS/TS 项目（Python 的 @app.get / Go 的 mux.HandleFunc 它不认识）
    //   ② 是 JS/TS 但路由写法不在识别范围（自定义 wrapper、动态注册）
    return {
      checkId: 'S7',
      findings,
      coverageGap: '未解析到任何路由定义（越权检查未运行）。常见原因：项目不是 JS/TS 框架，或路由写法不在识别范围（不是文件不可读）',
      warnings
    };
  }
  const total = [...byFile.values()].reduce((n, rs) => n + rs.length, 0);
  // 2026-11-17：Python 路由真的逐条分析过 → 声明覆盖，审计层据此解除「只解析 JS/TS」的语言缺口
  const pyCoverage = pyRoutesAnalyzed > 0
    ? { files: pyRoutesAnalyzed, supported: ['S7.no-owner-filter'], unsupported: ['Python 侧的属主判定是行级证据扫描（无 AST），复杂调用链可能漏判'], note: '按处理函数体区间扫描数据访问 + 属主标识/鉴权依赖' }
    : null;
  return {
    checkId: 'S7',
    findings,
    coverageGap: analyzedRoutes < total ? `${total - analyzedRoutes} 条路由处理函数未能解析，越权检查未完全覆盖` : null,
    ...(pyCoverage ? { pythonCoverage: pyCoverage } : {}),
    warnings,
  };
}

// ── Python 路线的 S7 证据扫描（2026-11-17）────────────────────────────────
// 为什么不做 AST：产品要在客户机上零依赖运行（不装 tree-sitter）；而 S7 的判据本身是
// 「函数体内是否出现数据访问 + 属主标识」这种**证据出现**判定，行级扫描足够。
// 误差方向安全：宁可多报一条（人工复核），也不漏报一条。

// 数据访问：SQLAlchemy / Flask-SQLAlchemy / Django ORM / 裸 DB-API
const PY_DAC_RE = /\b(?:session|db|conn|cur|cursor)\s*\.\s*(?:execute|executemany|query|scalars|fetchone|fetchall|get|filter|filter_by)\b|\bselect\s*\(|\bupdate\s*\(|\bdelete\s*\(|\.filter\s*\(|\.filter_by\s*\(|\.objects\s*\.\s*(?:get|filter|exclude|update|delete|raw|all)\s*\(|\bqueryset\s*=|\.query\s*\.\s*(?:get|get_or_404|filter|filter_by)\s*\(|\bget_object_or_404\s*\(|\bget_list_or_404\s*\(|\.get_or_404\s*\(/i;
// 属主证据：属主字段、当前用户对象、FastAPI 依赖返回的 user["id"] / user.id
const PY_OWNER_RE = /\b(?:user_id|userId|owner_id|ownerId|author_id|created_by(?:_id)?)\b|\bcurrent_user\b|\breq(?:uest)?\.user\b|\buser\s*(?:\.id\b|\[\s*['"]id['"]\s*\])/i;
// 只取公开可见的数据：published=True / is_public=True / visibility="public"
const PY_PUBLIC_FILTER_RE = /\b(?:published|is_published|is_public|public)\s*=\s*True\b|\bvisibility\s*=\s*['"]public['"]|\bstatus\s*=\s*['"]published['"]/;
// 角色校验：管理员接口按角色放行也是授权证据（is_admin / is_staff / has_perm）
const PY_ROLE_RE = /\b(?:is_admin|is_staff|is_superuser|has_perm|has_role|require_role|check_permission)\b/;
// 无动态段的 POST：只有从请求里取 id 去查资源才算越权目标
const PY_ID_INPUT_RE = /(?:request\.(?:json|form|POST|data|args|GET)|\bevent|\bpayload|\bbody)\s*(?:\.get\s*\(\s*|\[\s*)['"]\w*(?:_id|Id|pk)['"]|\b\w+_id\s*:\s*int\b/;

function isPyFile(file) {
  return /\.py$/i.test(String(file || ''));
}

/**
 * 从路由装饰器行往下找到 `def`/`async def` 的函数体区间（按缩进判定）。
 * 返回 { start, end, body } 或 null（定位不到就记 warning，不猜）。
 */
function pyHandlerSpan(text, route) {
  const lines = String(text || '').split('\n');
  const startLine = Math.max(1, Number(route && route.line) || 1);
  let defIdx = -1;
  for (let i = startLine - 1; i < Math.min(lines.length, startLine + 12); i++) {
    // Django 类视图：路由直接指向 class 行，区间取整个类体
    if (/^(?:\s*@[^\n]*)?\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(|^\s*class\s+[A-Za-z_]\w*\b/.test(lines[i])) { defIdx = i; break; }
  }
  if (defIdx < 0) return null;
  const ind = (l) => { let n = 0; for (const c of String(l)) { if (c === ' ') n++; else if (c === '\t') n += 4; else break; } return n; };
  const selfIndent = ind(lines[defIdx]);
  let end = defIdx;
  for (let k = defIdx + 1; k < lines.length; k++) {
    if (!String(lines[k]).trim()) { end = k; continue; }
    if (ind(lines[k]) <= selfIndent) break;
    end = k;
  }
  // body 含签名行（参数里的 Depends(...) 也是证据）
  return { start: defIdx + 1, end: end + 1, body: lines.slice(defIdx, end + 1).join('\n') };
}
