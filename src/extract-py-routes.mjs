// Python 面路由提取（round3/round4 定案）：FastAPI / Flask 装饰器路由。
// Bandit 不做路由与鉴权判断，这部分必须自研——与 TS 侧 S1 同一逻辑换语言。
// v1 范围：单文件装饰器（@app.get / @router.post / @app.route(methods=[...])）+
// 鉴权装饰器/依赖识别（login_required / jwt_required / get_current_user / Depends(auth...)）。
// 不做：include_router 跨文件展开、Django urls.py、类视图——这些记 unavailable，不冒充已解析。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles } from './walk.mjs';

const DECOR_RE = /^\s*@([\w.]+)\.(get|post|put|delete|patch|route|api_route|websocket)\s*\(/;
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);
// 非产品目录：路由是教程/测试/示例里的演示代码，不构成真实鉴权面（fastapi 实测 S1 洪泛 1776 条的根因之一）。
// 文件级跳过 + 跳过数进 warnings（fail-open 为「路由表更小」，覆盖缺口仍由 httpSignal 兜底，不冒充已解析）。
const NON_PRODUCT_DIRS = new Set(['tests', 'test', 'docs', 'docs_src', 'examples', 'example', 'demos', 'demo', 'tutorials', 'tutorial', 'benchmarks']);
// 鉴权装饰器/依赖：命中即算有守卫（与 TS 侧 GUARD_RE 同思路，词边界防 user_id 误判）
// 守卫识别（round11 实测扩充）：
// 常见 FastAPI 鉴权依赖命名远超「带 auth/user/token」的正则，实际项目里高频出现的是：
//   require_api_key / api_key_required / require_auth / current_superuser / current_verified_user /
//   get_current_active_user / verify_api_key / Security(...) / depends(..., scopes=[...])
// 漏掉这些名字 = 把受保护路由误报成裸奔（Hetzner 业务项目实测 9/12 条 S1 误报）。
const AUTH_PY_RE = /login_required|jwt_required|jwt_protected|get_current_user|current_user|requires_auth|auth_required|AuthenticatedUser|require_api_key|api_key_required|require_auth|require_login|require_user|require_admin|require_superuser|current_superuser|current_verified_user|get_current_active_user|get_current_superuser|verify_api_key|verify_token|check_api_key|Depends\s*\(\s*\w*(?:auth|Auth|user|User|token|Token|key|Key|perm|Perm|role|Role|scope|Scope|guard|Guard|login|Login|session|Session)|Security\s*\(/;
const HTTP_VERBS_RE = /methods\s*=\s*\[([^\]]*)\]/i;

// 从第 i 行的装饰器开始，收集到配对右括号（跨行，粗略跳过字符串字面量），
// 返回 { text, endLine }；解析失败返回 null。
function collectParens(lines, start) {
  let depth = 0;
  let quote = null;
  const parts = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (quote) {
        if (ch === '\\') c++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') {
        depth--;
        if (depth === 0) {
          parts.push(line.slice(0, c + 1));
          return { text: parts.join('\n'), endLine: i };
        }
      }
    }
    parts.push(line);
    // 装饰器跨行上限：防止把整个文件吞进来
    if (i - start > 20) return null;
  }
  return null;
}

function firstStringLiteral(text) {
  const m = /['"]([^'"]+)['"]/.exec(text);
  return m ? m[1] : null;
}

// docstring 屏蔽：模块/函数文档字符串里常带 @app.get("/items/") 教程示例（fastapi 实测 28 条产品目录误报的根因）。
// 三引号状态机：进入 """ / ''' 块后所有行视为文本；同一行内闭合不算块。返回每行是否处于 docstring 内。
function docstringMask(lines) {
  const inDoc = new Array(lines.length).fill(false);
  let inside = false;
  let delim = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inside) {
      inDoc[i] = true;
      const closeIdx = line.indexOf(delim);
      if (closeIdx >= 0) {
        inside = false;
        delim = null;
        const reopen = /("""|''')/.exec(line.slice(closeIdx + 3));
        if (reopen) { inside = true; delim = reopen[1]; }
      }
      continue;
    }
    const open = /("""|''')/.exec(line);
    if (open) {
      const after = line.slice(open.index + 3);
      if (after.includes(open[1])) continue; // 同一行内闭合（单行 docstring），不开启块
      inside = true;
      delim = open[1];
      inDoc[i] = true;
    }
  }
  return inDoc;
}

export async function extractPyRoutes(projectDir, { excludes = [], includeFixtures = false } = {}) {
  const routes = [];
  const warnings = [];
  const { files } = await listTextFiles(projectDir, excludes, { includeFixtures });
  const pyFiles = files.filter((f) => /\.py$/i.test(f));
  let skippedNonProduct = 0;
  let scannedFiles = 0;
  for (const abs of pyFiles) {
    const rel0 = path.relative(projectDir, abs).replace(/\\/g, '/');
    // 教程/测试/示例目录里的路由是演示代码，不进鉴权面（跳过数记入 warnings 保持透明）
    if (rel0.split('/').some((seg) => NON_PRODUCT_DIRS.has(seg.toLowerCase()))) { skippedNonProduct++; continue; }
    const text = await readFile(abs, 'utf8').catch(() => null);
    if (text == null) continue;
    scannedFiles++;
    const rel = rel0;
    const lines = text.split('\n');
    const inDoc = docstringMask(lines);
    for (let i = 0; i < lines.length; i++) {
      if (inDoc[i]) continue; // docstring 里的示例路由不是产品面
      const head = DECOR_RE.exec(lines[i]);
      if (!head) continue;
      const collected = collectParens(lines, i);
      if (!collected) continue;
      const body = collected.text;
      const owner = head[1];
      const verb = head[2].toLowerCase();
      const pathStr = firstStringLiteral(body);
      // 路径必须是 HTTP 路径形态；websocket 不算 REST 路由（S1 只管 HTTP 鉴权面）
      if (!pathStr || !/^[/~]/.test(pathStr) || verb === 'websocket') continue;
      let method = verb;
      if (verb === 'route' || verb === 'api_route') {
        const methods = HTTP_VERBS_RE.exec(body);
        const list = methods ? methods[1].toUpperCase() : 'GET';
        const pick = /['"](\w+)['"]/.exec(list);
        method = (pick ? pick[1] : 'GET').toLowerCase();
        if (method === 'route' || !ROUTE_METHODS.has(method)) method = 'get';
      }
      // 守卫：路由参数里的 Depends(auth...) + 相邻装饰器（@login_required 在 route 装饰器上/下方都可能）
      let guard = AUTH_PY_RE.test(body);
      if (!guard) {
        for (let k = i + 1; k < lines.length; k++) {
          const t = lines[k];
          if (/^\s*@\w/.test(t)) { if (AUTH_PY_RE.test(t)) guard = true; continue; }
          if (/^\s*(?:async\s+)?def\s/.test(t)) {
            // ⚠️ FastAPI 的鉴权几乎全写在**函数签名的参数**里（通常跨多行）：
            //   async def handler(
            //       payload: X,
            //       user: User = Depends(current_verified_user),   ← 守卫在这
            //   ):
            // 旧逻辑遇到 def 就 break，导致所有用 Depends(...) 鉴权的 FastAPI 路由被判「无守卫」
            // （round11 实测：Hetzner 业务项目 9/12 条 S1 是这类误报）。
            // 现在改为：从 def 行起扫到签名右括号为止，整段签名参与守卫匹配。
            let depth = 0;
            let sigLines = [];
            for (let m = k; m < lines.length && m - k <= 20; m++) {
              const ln = lines[m];
              sigLines.push(ln);
              for (const ch of ln) {
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
              }
              if (depth <= 0 && m > k) break;   // 签名闭合
              if (depth <= 0 && m === k && ln.includes(')')) break; // 单行签名
            }
            if (AUTH_PY_RE.test(sigLines.join('\n'))) guard = true;
            break; // 签名是静态守卫的唯一来源，扫完即止
          }
          if (/^\s*\S/.test(t) && !/^\s*@/.test(t)) break; // 不是装饰器也不是 def：装饰器链断了
        }
      }
      if (!guard) {
        // 向上找：@login_required 常写在 @app.route 之前
        for (let k = i - 1; k >= 0; k--) {
          const t = lines[k];
          if (/^\s*@\w/.test(t)) { if (AUTH_PY_RE.test(t)) guard = true; continue; }
          if (!t.trim()) continue;
          break;
        }
      }
      routes.push({
        method,
        path: pathStr,
        file: rel,
        line: i + 1,
        middlewares: [],
        hasGuard: guard,
        framework: owner.startsWith('app') || owner.startsWith('api') ? 'python' : 'python',
      });
      i = collected.endLine; // 跳过已消费的跨行参数
    }
  }
  if (skippedNonProduct) {
    warnings.push(`路由提取跳过 ${skippedNonProduct} 个非产品目录文件（tests/docs/examples 里的演示路由不计入鉴权面）`);
  }
  // scannedFiles：py 路由提取真实扫过的产品文件数——audit 用它把 S1 从「只解析 JS/TS」的语言缺口里摘出来
  return { routes, warnings, scannedFiles };
}
