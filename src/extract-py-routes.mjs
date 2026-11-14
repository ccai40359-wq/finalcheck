// Python 面路由提取（round3/round4 定案）：FastAPI / Flask 装饰器路由。
// Bandit 不做路由与鉴权判断，这部分必须自研——与 TS 侧 S1 同一逻辑换语言。
// v1 范围：单文件装饰器（@app.get / @router.post / @app.route(methods=[...])）+
// 鉴权装饰器/依赖识别（login_required / jwt_required / get_current_user / Depends(auth...)）。
// 不做：include_router 跨文件展开、Django urls.py、类视图——这些记 unavailable，不冒充已解析。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles } from './walk.mjs';
import { isNonProductPath } from './scope-policy.mjs';

const DECOR_RE = /^\s*@([\w.]+)\.(get|post|put|delete|patch|route|api_route|websocket)\s*\(/;
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);
// 鉴权装饰器/依赖：命中即算有守卫（与 TS 侧 GUARD_RE 同思路，词边界防 user_id 误判）
const AUTH_PY_RE = /login_required|jwt_required|jwt_protected|get_current_user|current_user|requires_auth|auth_required|AuthenticatedUser|Depends\s*\(\s*\w*(?:auth|Auth|user|User|token|Token)/;
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

export async function extractPyRoutes(projectDir, { excludes = [], includeFixtures = false } = {}) {
  const routes = [];
  const warnings = [];
  const { files } = await listTextFiles(projectDir, excludes, { includeFixtures });
  const pyFiles = files.filter((f) => /\.py$/i.test(f));
  for (const abs of pyFiles) {
    const text = await readFile(abs, 'utf8').catch(() => null);
    if (text == null) continue;
    const rel = path.relative(projectDir, abs).replace(/\\/g, '/');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
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
          if (/^\s*(?:async\s+)?def\s/.test(t)) break;
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
  return { routes, warnings };
}
