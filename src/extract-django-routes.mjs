// Django 路由提取（2026-11-17）：urls.py 的 path()/re_path()/url() → 视图函数/类视图 → 守卫判定。
//
// 为什么要自研：Bandit 只查代码模式，不知道哪个视图挂在哪条 URL 上、有没有登录守卫。
// 以前 Django 项目一律记「HTTP 框架尚未支持」，S1/S6/S7 三关全部缺口（PyGoat 实测）。
//
// 范围（行级解析，零依赖，不执行项目代码）：
//   · urlpatterns 里的 path / re_path / url，目标为 views.func、func、Class.as_view()
//   · include("app.urls") / include(app.urls) 递归带前缀
//   · 守卫：@login_required / @permission_required / @staff_member_required / @user_passes_test /
//     @method_decorator(login_required...) / LoginRequiredMixin / PermissionRequiredMixin /
//     UserPassesTestMixin / DRF permission_classes = [IsAuthenticated...]
//   · 视图开头的内联检查：if request.user.is_authenticated: … else: return redirect("login")
//   · DRF router.register 注册的 ViewSet；urls.py 里 from .views import * 的通配导入
// 不做（记 warning，不冒充已解析）：动态拼接的 urlpatterns。
// 路由的 file/line 指向**视图定义**（def/class 行），不是 urls.py——发现要落在用户该改的地方。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hasInlineGuard, classHasInlineGuard } from './py-guards.mjs';

const ROUTE_CALL_RE = /\b(path|re_path|url)\s*\(/g;
const GUARD_DECOR_RE = /^\s*@(?:[\w.]+\.)?(?:login_required|permission_required|staff_member_required|superuser_required|user_passes_test|method_decorator\s*\(\s*(?:login_required|permission_required|staff_member_required|user_passes_test))\b/;
const GUARD_MIXIN_RE = /\b(?:LoginRequiredMixin|PermissionRequiredMixin|UserPassesTestMixin|AccessMixin|StaffRequiredMixin|SuperuserRequiredMixin)\b/;
const DRF_GUARD_RE = /permission_classes\s*=\s*[([][^)\]]*\b(?:IsAuthenticated|IsAdminUser|IsAuthenticatedOrReadOnly|DjangoModelPermissions|DjangoObjectPermissions)\b/;
const DRF_ANY_RE = /permission_classes\s*=\s*[([]\s*AllowAny\b/;
// 类视图的「写」语义：这些基类处理 POST（S7 目标）
const WRITE_VIEW_RE = /\b(?:UpdateView|DeleteView|CreateView|FormView|UpdateAPIView|DestroyAPIView|RetrieveUpdateDestroyAPIView|ModelViewSet)\b/;

// 取一个调用的完整参数文本（跨行、跳过字符串里的括号）
function callArgs(text, openIdx) {
  let depth = 0; let quote = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === '\'') { quote = ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') { depth--; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return null;
}

// 按顶层逗号切参数
function splitTop(args) {
  const out = []; let depth = 0; let quote = null; let cur = '';
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) { cur += ch; if (ch === '\\') { cur += args[++i] || ''; } else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === '\'') { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// `from . import views` 的模块是 "."：拼成 ".views" 而不是 "..views"
const joinMod = (module, member) => (member ? (/^\.+$/.test(module) ? module + member : `${module}.${member}`) : module);
const stripComments = (text) => text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '$1')).join('\n');
const literal = (s) => { const m = /^[rbuRBU]*(['"])(.*)\1$/s.exec(String(s || '').trim()); return m ? m[2] : null; };

// Django 路径 → 统一形态：<int:pk> → {pk}；re_path 的 (?P<pk>..) → {pk}
function normalizeDjangoPath(prefix, p, isRegex) {
  let s = String(p || '');
  if (isRegex) s = s.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\?P<(\w+)>[^)]*\)/g, '{$1}');
  s = s.replace(/<(?:\w+:)?(\w+)>/g, '{$1}');
  const joined = `${prefix || ''}/${s}`.replace(/\/{2,}/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

// urls.py 的 import → 本地名到模块的映射
function importMap(text) {
  const map = new Map(); // localName -> { module, member|null }
  for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+\(?([^)\n]+)\)?/gm)) {
    for (const part of m[2].split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (!name) continue;
      // 通配导入按模块分别记（多行 import * 不互相覆盖）
      map.set(name.trim() === '*' ? `*:${m[1]}` : (alias || name).trim(), { module: m[1], member: name.trim() });
    }
  }
  for (const m of text.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) {
    map.set(m[2] || m[1].split('.')[0], { module: m[1], member: null });
  }
  return map;
}

// 模块名 → 文件（相对 urls.py 所在目录解析相对导入；绝对导入在项目里找）
function resolveModule(rootDir0, fromFile, mod, fileSet) {
  // 统一成绝对路径再算：调用方可能传相对的 rootDir（测试/脚本里常见）
  const rootDir = path.resolve(rootDir0);
  const fromFileAbs = path.resolve(fromFile);
  const tryPaths = [];
  if (mod.startsWith('.')) {
    const dots = /^\.+/.exec(mod)[0].length;
    let base = path.dirname(fromFileAbs);
    for (let i = 1; i < dots; i++) base = path.dirname(base);
    const rest = mod.slice(dots).split('.').filter(Boolean);
    tryPaths.push(path.join(base, ...rest));
  } else {
    const parts = mod.split('.');
    tryPaths.push(path.join(rootDir, ...parts));
    // 项目常把源码放在子目录（src/、<project>/）：在已知文件里按后缀匹配
    const suffix = parts.join('/');
    for (const f of fileSet) {
      const rel = f.replace(/\\/g, '/');
      if (rel.endsWith(`/${suffix}.py`) || rel.endsWith(`/${suffix}/__init__.py`)) tryPaths.push(rel.replace(/(?:\/__init__)?\.py$/, ''));
    }
  }
  for (const p of tryPaths) {
    const n = (path.isAbsolute(p) ? path.relative(rootDir, p) : p).replace(/\\/g, '/');
    if (fileSet.has(`${n}.py`)) return `${n}.py`;
    if (fileSet.has(`${n}/__init__.py`)) return `${n}/__init__.py`;
  }
  return null;
}

// 在视图模块里定位 def/class，判守卫与 HTTP 方法
function locateViewIn(text, name, isGuard) {
  const lines = text.split('\n');
  const re = new RegExp(`^(\\s*)(?:async\\s+)?(def|class)\\s+${name}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const kind = m[2];
    const indent = m[1].length;
    // 装饰器链（向上）
    let guard = false;
    for (let k = i - 1; k >= 0; k--) {
      const t = lines[k];
      if (!t.trim()) continue;
      if (/^\s*@/.test(t)) { if (GUARD_DECOR_RE.test(t) || isGuard(t)) guard = true; continue; }
      break;
    }
    // 定义体（按缩进）
    let end = i;
    for (let k = i + 1; k < lines.length; k++) {
      if (!lines[k].trim()) continue;
      const ind = /^\s*/.exec(lines[k])[0].length;
      if (ind <= indent) break;
      end = k;
    }
    const header = lines[i];
    const body = lines.slice(i, end + 1).join('\n');
    if (kind === 'class') {
      if (GUARD_MIXIN_RE.test(header) || (DRF_GUARD_RE.test(body) && !DRF_ANY_RE.test(body)) || (isGuard(body) && !DRF_ANY_RE.test(body))) guard = true;
      if (/@method_decorator\s*\(\s*(?:login_required|permission_required|staff_member_required|user_passes_test)/.test(body)) guard = true;
      if (classHasInlineGuard(lines.slice(i + 1, end + 1))) guard = true;
    } else if (hasInlineGuard(lines.slice(i + 1, end + 1))) {
      guard = true;
    }
    const writes = kind === 'class'
      ? WRITE_VIEW_RE.test(header) || /\bdef\s+(?:post|put|patch|delete)\s*\(/.test(body)
      : /request\.(?:POST|FILES|body)\b|request\.method\s*==\s*['"](?:POST|PUT|PATCH|DELETE)['"]|@require_(?:POST|http_methods)/.test(body)
        || /@require_POST|@require_http_methods/.test(lines.slice(Math.max(0, i - 4), i).join('\n'));
    return { line: i + 1, guard, method: writes ? 'post' : 'get', kind, header };
  }
  return null;
}

// DRF：router.register("entries", EntryViewSet) → 列表 + 详情（+ 可写 ViewSet 的写操作）
const ROUTER_REGISTER_RE = /\b\w+\s*\.\s*register\s*\(\s*[rbu]*(['"])([^'"]*)\1\s*,\s*([\w.]+)/g;
const READONLY_VIEWSET_RE = /\bReadOnlyModelViewSet\b/;

/**
 * @param {string} rootDir
 * @param {string[]} pyFilesRel 项目内 .py 文件（相对路径，/ 分隔，已排除非产品目录）
 * @returns {Promise<{routes:Array, warnings:string[], detected:boolean}>}
 */
export async function extractDjangoRoutes(rootDir, pyFilesRel, { isGuard = () => false } = {}) {
  const locateView = (text, name) => locateViewIn(text, name, isGuard);
  const routes = []; const warnings = [];
  const fileSet = new Set(pyFilesRel);
  const textCache = new Map();
  const read = async (rel) => {
    if (!textCache.has(rel)) textCache.set(rel, await readFile(path.join(rootDir, rel), 'utf8').catch(() => null));
    return textCache.get(rel);
  };
  const urlFiles = [];
  for (const rel of pyFilesRel) {
    const t = await read(rel);
    if (t && /\burlpatterns\s*[+]?=/.test(t) && /\b(?:path|re_path|url)\s*\(/.test(t)) urlFiles.push(rel);
  }
  if (!urlFiles.length) return { routes, warnings, detected: false };

  // 先收集 include 关系，算出每个 urls 模块的前缀（根 urls 前缀为空）
  const prefixOf = new Map();
  const parsed = new Map();
  for (const rel of urlFiles) {
    const text = stripComments(await read(rel));
    const imports = importMap(text);
    const entries = [];
    for (const m of text.matchAll(ROUTE_CALL_RE)) {
      const args = callArgs(text, m.index + m[0].length - 1);
      if (args == null) continue;
      const parts = splitTop(args);
      if (parts.length < 2) continue;
      const p = literal(parts[0]);
      if (p == null) continue;
      entries.push({ fn: m[1], path: p, target: parts[1], line: text.slice(0, m.index).split('\n').length });
    }
    const registers = [];
    for (const m of text.matchAll(ROUTER_REGISTER_RE)) {
      registers.push({ path: m[2], target: m[3], line: text.slice(0, m.index).split('\n').length });
    }
    parsed.set(rel, { imports, entries, registers, text });
  }
  for (const [rel, { imports, entries }] of parsed) {
    for (const e of entries) {
      const inc = /^include\s*\(\s*(?:\(\s*)?(['"]?)([\w.]+)\1/.exec(e.target);
      if (!inc) continue;
      // include("blog.urls") 是模块路径字符串；include(blog.urls) 是表达式，首段按 import 还原成模块名
      let mod = inc[2];
      if (!inc[1]) {
        const [first, ...rest] = mod.split('.');
        const imp = imports.get(first);
        if (imp) mod = [joinMod(imp.module, imp.member), ...rest].join('.');
      }
      const target = resolveModule(rootDir, path.join(rootDir, rel), mod, fileSet);
      if (target && !prefixOf.has(target)) prefixOf.set(target, normalizeDjangoPath(prefixOf.get(rel) || '', e.path, e.fn !== 'path'));
    }
  }

  // 视图目标（views.func / func / views.Cls / Cls）→ { viewFile, viewName, v }；失败记 warning 返回 null
  const resolveView = async (rel, imports, dottedName, line) => {
    const dotted = dottedName.split('.');
    let viewFile = null; let viewName = dotted[dotted.length - 1];
    const head = imports.get(dotted[0]);
    if (dotted.length === 1) {
      if (head) viewFile = resolveModule(rootDir, path.join(rootDir, rel), head.module, fileSet);
      else viewFile = rel; // 同文件定义的视图
      if (head?.member) viewName = head.member;
    } else if (head) {
      // `from . import views` → 模块 "." + 成员 "views" → ".views"；`from app import views` → "app.views"
      const base = joinMod(head.module, head.member);
      viewFile = resolveModule(rootDir, path.join(rootDir, rel), [base, ...dotted.slice(1, -1)].join('.'), fileSet);
      if (!viewFile && head.member) viewFile = resolveModule(rootDir, path.join(rootDir, rel), head.module, fileSet);
    }
    if (!viewFile) { warnings.push(`${rel}:${line}：找不到视图 ${dottedName} 所在模块，该路由未解析`); return null; }
    const viewText = await read(viewFile);
    let v = viewText ? locateView(viewText, viewName) : null;
    // `from .views import *`：裸名字在本文件找不到时，到各个通配导入的模块里找（PyGoat challenge/urls.py）
    if (!v && dotted.length === 1 && !head) {
      for (const [, imp] of imports) {
        if (imp.member !== '*') continue;
        const starFile = resolveModule(rootDir, path.join(rootDir, rel), imp.module, fileSet);
        const starText = starFile ? await read(starFile) : null;
        const sv = starText ? locateView(starText, viewName) : null;
        if (sv) { viewFile = starFile; v = sv; break; }
      }
    }
    if (!v) { warnings.push(`${rel}:${line}：在 ${viewFile} 里找不到 ${viewName} 的定义，该路由未解析`); return null; }
    return { viewFile, v };
  };
  const push = (method, p, viewFile, v, rel, line) => routes.push({
    method, path: p, file: viewFile, line: v.line, middlewares: [], hasGuard: v.guard,
    framework: 'django', viewKind: v.kind, urlsFile: rel, urlsLine: line,
  });

  for (const [rel, { imports, entries, registers }] of parsed) {
    const prefix = prefixOf.get(rel) || '';
    for (const e of entries) {
      const target = e.target.replace(/\s+/g, '');
      if (/^include\(/.test(target) || /admin\.site\.urls/.test(target)) continue;
      // views.func / func / views.Cls.as_view(...) / Cls.as_view(...)
      const m = /^([\w.]+?)(?:\.as_view\(.*\))?$/.exec(target);
      if (!m) { warnings.push(`${rel}:${e.line}：无法识别的视图目标 ${target.slice(0, 60)}，该路由未解析`); continue; }
      const r = await resolveView(rel, imports, m[1], e.line);
      if (r) push(r.v.method, normalizeDjangoPath(prefix, e.path, e.fn !== 'path'), r.viewFile, r.v, rel, e.line);
    }
    // DRF router.register：ViewSet 一个类同时提供列表与详情；详情（带 pk）是 S7 的目标
    for (const g of registers) {
      const r = await resolveView(rel, imports, g.target, g.line);
      if (!r) continue;
      const base = normalizeDjangoPath(prefix, `${g.path}/`, false);
      push('get', base, r.viewFile, r.v, rel, g.line);
      push('get', `${base}{pk}/`, r.viewFile, r.v, rel, g.line);
      if (!READONLY_VIEWSET_RE.test(r.v.header || '')) push('post', `${base}{pk}/`, r.viewFile, r.v, rel, g.line);
    }
  }
  return { routes, warnings, detected: true };
}
