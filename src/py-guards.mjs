// Python 项目里「间接写法」的鉴权守卫识别（2026-11-17，盲测基准驱动）。
//
// 固定名单（login_required / get_current_user …）认不出项目自己写的守卫，盲测里三种写法全军覆没：
//   · Flask 自定义装饰器 @token_required（函数体里 jwt.decode + abort(401)）
//   · FastAPI 依赖别名  CurrentUser = Annotated[User, Depends(get_current_user)]，路由里只写 user: CurrentUser
//   · DRF 的 @permission_classes([IsAuthenticated])
// 结果是被保护的路由全部报「无登录守卫」，S6 还把它们当成公开 webhook。
//
// 这里先扫一遍项目，收集「本项目定义的守卫装饰器名」和「鉴权依赖别名」，再给路由提取用。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 已知守卫依赖名（与 extract-py-routes 的 AUTH_PY_RE 同口径的子集，用来判别名指向的依赖）
const AUTH_DEP_NAME_RE = /(?:current_user|current_active_user|current_superuser|get_user|verify_|require_|auth|token|api_key|login|session_user|principal)/i;
// 函数体里出现这些动作，说明它是一个鉴权包装器
const AUTH_ACTION_RE = /\babort\s*\(\s*40[13]\b|\bHTTPException\s*\(\s*(?:status_code\s*=\s*)?(?:40[13]\b|status\.HTTP_40[13])|\braise\s+(?:\w+\.)?(?:Unauthorized|Forbidden|PermissionDenied|NotAuthenticated|AuthenticationFailed|HTTPUnauthorized|HTTPForbidden)\b|\bjwt\.decode\s*\(|\bverify_(?:token|jwt|signature|id_token)\s*\(|\.is_authenticated\b|\bredirect\s*\([^)]*login/;
// 名字本身就是守卫语义；排除 Django 限制 HTTP 方法的 require_POST / require_http_methods / require_safe
const GUARD_NAME_RE = /^(?!require_(?:http_methods|POST|GET|safe)$)(?:\w*_required|\w*_protected|requires?_(?:auth|login|user|admin|role|roles|permission|permissions|scope|scopes|token|api_key)\w*|admin_only|auth_only|authenticated)$/;

/**
 * @param {string} rootDir
 * @param {string[]} relFiles 项目内 .py 文件（相对路径）
 * @returns {Promise<{decorators:Set<string>, aliases:Set<string>}>}
 */
export async function collectPyGuards(rootDir, relFiles) {
  const decorators = new Set();
  const aliases = new Set();
  for (const rel of relFiles) {
    const text = await readFile(path.join(rootDir, rel), 'utf8').catch(() => null);
    if (!text) continue;
    // 依赖别名：X = Annotated[..., Depends(dep)]（也认 Security(dep)）
    for (const m of text.matchAll(/^(\w+)\s*(?::\s*\w+\s*)?=\s*Annotated\s*\[[^\n]*?\b(?:Depends|Security)\s*\(\s*([\w.]+)/gm)) {
      if (AUTH_DEP_NAME_RE.test(m[2])) aliases.add(m[1]);
    }
    // 模块级函数：def name(view|fn|f|func|...)：函数体里有鉴权动作 → 守卫装饰器
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const d = /^(?:async\s+)?def\s+(\w+)\s*\(\s*(\w+)\s*(?:[:,)])/.exec(lines[i]);
      if (!d) continue;
      let end = i + 1;
      while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
      const body = lines.slice(i + 1, end).join('\n');
      const wraps = /\bdef\s+\w+\s*\(\s*\*/.test(body) || /@(?:functools\.)?wraps\b/.test(body);
      if (wraps && AUTH_ACTION_RE.test(body)) decorators.add(d[1]);
    }
  }
  return { decorators, aliases };
}

// 视图开头的内联鉴权（PyGoat 实测 21 处）：
//   if request.user.is_authenticated: ... else: return redirect("login")
//   if not current_user.is_authenticated: abort(401)
// 只看函数体最前面几条语句（跳过 docstring）：检查写在中间的分支不算守卫整个接口。
const INLINE_AUTH_IF_RE = /^\s*if\s+(?:not\s+)?(?:request\.user|current_user|self\.request\.user|g\.user|request\.ctx\.user)(?:\s+is\s+None|\.is_authenticated\b|\.is_anonymous\b|\s*:)|^\s*if\s+not\s+(?:session\.get\s*\(\s*['"]\w*user\w*['"]\s*\)|g\.get\s*\(\s*['"]user['"]\s*\))\s*:|^\s*if\s+(?:not\s+)?['"]?(?:user_id|user)['"]?\s+(?:not\s+)?in\s+session\b/;
// 拒绝动作：跳登录、abort、raise，或返回 401/403 状态码（JsonResponse(..., status=401)）
const DENY_RE = /\b(?:redirect|abort|HttpResponseForbidden|HttpResponseRedirect|PermissionDenied|Unauthorized|HTTPException|redirect_to_login|login_url)\b|\braise\b|\bstatus(?:_code)?\s*=\s*(?:40[13]\b|status\.HTTP_40[13])|\breturn\b[^\n]*,\s*40[13]\b/;

/**
 * @param {string[]} bodyLines def 行之后的函数体（不含 def 行）
 */
export function hasInlineGuard(bodyLines) {
  const stmts = [];
  let inDoc = false;
  for (const raw of bodyLines) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    if (inDoc) { if (/"""|'''/.test(l)) inDoc = false; continue; }
    if (/^[rbuRBU]*("""|''')/.test(l)) { if (!/("""|''').*\1/.test(l.slice(3)) && (l.match(/"""|'''/g) || []).length === 1) inDoc = true; continue; }
    stmts.push(raw);
    if (stmts.length >= 12) break;
  }
  const first = stmts.findIndex((s) => INLINE_AUTH_IF_RE.test(s));
  if (first < 0 || first > 1) return false; // 必须是开头第一、二条语句
  // 「未登录」那一支里要有拒绝动作（redirect/abort/raise/403）
  return DENY_RE.test(stmts.slice(first, first + 12).join('\n'));
}

/**
 * 类视图：每个 HTTP 方法（或 dispatch）开头都有内联检查 → 整个类有守卫。
 * @param {string[]} classLines class 行之后的类体
 */
export function classHasInlineGuard(classLines) {
  const methods = [];
  for (let k = 0; k < classLines.length; k++) {
    const d = /^(\s*)(?:async\s+)?def\s+(get|post|put|patch|delete|dispatch)\s*\(/.exec(classLines[k]);
    if (!d) continue;
    const ind = d[1].length;
    const body = [];
    for (let j = k + 1; j < classLines.length; j++) {
      if (classLines[j].trim() && /^\s*/.exec(classLines[j])[0].length <= ind) break;
      body.push(classLines[j]);
    }
    methods.push({ name: d[2], guarded: hasInlineGuard(body) });
  }
  if (!methods.length) return false;
  const dispatch = methods.find((m) => m.name === 'dispatch');
  return dispatch ? dispatch.guarded : methods.every((m) => m.guarded);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 生成「这段文本里有没有守卫」的判定：装饰器名（项目定义的 + 名字语义）或签名里用了鉴权依赖别名。
 * @param {{decorators:Set<string>, aliases:Set<string>}} guards
 */
export function guardMatcher(guards) {
  const deco = [...(guards?.decorators || [])].map(escape);
  const alias = [...(guards?.aliases || [])].map(escape);
  const decoRe = deco.length ? new RegExp(`@(?:[\\w.]+\\.)?(?:${deco.join('|')})\\b`) : null;
  const aliasRe = alias.length ? new RegExp(`:\\s*(?:${alias.join('|')})\\b`) : null;
  return (text) => {
    const s = String(text || '');
    if (decoRe && decoRe.test(s)) return true;
    if (aliasRe && aliasRe.test(s)) return true;
    for (const m of s.matchAll(/@(?:[\w.]+\.)?(\w+)/g)) if (GUARD_NAME_RE.test(m[1])) return true;
    // DRF：@permission_classes([IsAuthenticated]) / permission_classes = [IsAdminUser]
    if (/permission_classes\s*[=(]\s*[([][^\])]*\b(?:IsAuthenticated|IsAdminUser|DjangoModelPermissions|DjangoObjectPermissions)\b/.test(s)
      && !/permission_classes\s*[=(]\s*[([]\s*(?:permissions\.)?AllowAny\b/.test(s)) return true;
    return false;
  };
}
