// Python 专用规则（2026-11-17，tests/benchmark/python 基准驱动）。
//
// 为什么单独一个模块：inject.mjs / config.mjs 的规则是按 JS 写的（req.query、sendFile、fetch、
// origin: '*'），Python 的 request.args、send_file、requests.get、CORS(app, origins="*") 全都认不出；
// Bandit 也不管 SSRF、SSTI、Django 的 CORS/ALLOWED_HOSTS/cookie 配置、JWT 不验签。
//
// 做法：行级规则 + 函数内的轻量污点跟踪（不跨函数、不跨文件，零依赖）：
//   · 污点来源：request.args/form/json/values/data/files/GET/POST/body/query_params/path_params，
//     以及 FastAPI/Flask 路由函数的普通参数（排除 Depends(...)、Session、Request 等注入对象）
//   · 消毒：secure_filename / os.path.basename / int() / uuid.UUID() 赋值后不再算外部输入
// 误差方向：只在「确有外部输入流入」时报 high；确认不了来源的拼接不报（交给 Bandit 的通用规则）。
import { listTextFiles, readRel } from '../walk.mjs';

const INPUT_RE = /\brequest\s*\.\s*(?:args|form|json|values|data|files|GET|POST|body|query_params|path_params|get_json\s*\(|get_data\s*\()/;
const SANITIZE_RE = /\b(?:secure_filename|os\.path\.basename|basename|int|uuid\.UUID|UUID|validate_url|is_safe_url|url_has_allowed_host_and_scheme)\s*\(/;
const ROUTE_DECOR_RE = /^\s*@[\w.]+\.(?:get|post|put|delete|patch|route|api_route)\s*\(/;
// 路由函数里这些参数是框架注入的对象，不是用户输入
// 数值/布尔/UUID 类型的参数不可能构成 SSRF/路径穿越/SSTI 载荷，也不算外部输入
const INJECTED_PARAM_RE = /Depends\s*\(|Security\s*\(|:\s*(?:Session|AsyncSession|Request|Response|BackgroundTasks|HTTPConnection|WebSocket|int|float|bool|UUID|uuid\.UUID)\b|^\s*(?:self|cls|request|db|session|user|current_user)\s*(?:[:=,)]|$)/;

const FILE_SINK_RE = /\b(?:send_file|FileResponse|open|io\.open|codecs\.open)\s*\(/;
const SSTI_SINK_RE = /\b(?:render_template_string|Template|from_string|Environment\s*\([^)]*\)\s*\.from_string)\s*\(/;
// 只认 HTTP 客户端：`session`/`client` 太宽（db.session.delete 不是外呼）
const SSRF_SINK_RE = /\b(?:requests|httpx)\s*\.\s*(?:get|post|put|patch|delete|head|request|stream)\s*\(|\burlopen\s*\(|\burllib\.request\.urlopen\s*\(|\bhttp_client\s*\.\s*(?:get|post)\s*\(/;
const REDIRECT_SINK_RE = /\b(?:redirect|HttpResponseRedirect|RedirectResponse)\s*\(/;
const SAFE_REDIRECT_RE = /\b(?:url_has_allowed_host_and_scheme|is_safe_url|url_for|reverse)\s*\(/;
// 直接返回 HTML 字符串的响应：Flask 视图 return "..."、HttpResponse(...)、make_response(...)、HTMLResponse(...)
const HTML_RESPONSE_RE = /^\s*return\s+(?:f?['"]|\(|[\w.]*\s*\+)|\b(?:HttpResponse|make_response|HTMLResponse|Response)\s*\(/;
const CONCAT_RE =/['"]\s*\+|\+\s*['"]|\bf['"][^'"]*\{|\.format\s*\(|%\s*\(?\s*\w/;

function stripComment(line) {
  // 去掉行尾注释（粗略：不在字符串里的 #）
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === '\'') quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

const indentOf = (l) => /^\s*/.exec(l)[0].length;

// 逐函数收集污点变量名：返回每行可见的污点集合（按函数作用域重置）
function taintByLine(lines) {
  const out = new Array(lines.length);
  let scope = null; // { indent, names:Set }
  let pendingRoute = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = stripComment(raw);
    if (ROUTE_DECOR_RE.test(code)) pendingRoute = true;
    const def = /^(\s*)(?:async\s+)?def\s+\w+\s*\(/.exec(code);
    if (def) {
      scope = { indent: def[1].length, names: new Set() };
      if (pendingRoute) {
        // 收集签名（可能跨行）里的参数名
        let sig = ''; let depth = 0;
        for (let k = i; k < lines.length && k - i < 20; k++) {
          const t = stripComment(lines[k]);
          sig += `${t}\n`;
          for (const ch of t) { if (ch === '(') depth++; else if (ch === ')') depth--; }
          if (depth <= 0) break;
        }
        const inner = sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'));
        for (const p of splitParams(inner)) {
          const name = /^\s*\*{0,2}(\w+)/.exec(p)?.[1];
          if (name && !INJECTED_PARAM_RE.test(p)) scope.names.add(name);
        }
      }
      pendingRoute = false;
      out[i] = new Set(scope.names);
      continue;
    }
    if (code.trim() && !/^\s*@/.test(code) && scope && indentOf(code) <= scope.indent) scope = null;
    if (scope) {
      const asg = /^\s*(\w+)\s*(?::\s*[\w[\], ]+)?=(?!=)\s*(.+)$/.exec(code);
      if (asg) {
        const [, name, rhs] = asg;
        const tainted = INPUT_RE.test(rhs) || [...scope.names].some((n) => new RegExp(`\\b${n}\\b`).test(rhs));
        if (tainted && !SANITIZE_RE.test(rhs)) scope.names.add(name);
        else scope.names.delete(name);
      }
    }
    out[i] = scope ? new Set(scope.names) : new Set();
  }
  return out;
}

function splitParams(s) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// sink 调用的参数里是否带外部输入（直接 request.* 或污点变量）
function argsTainted(code, sinkRe, names) {
  const m = sinkRe.exec(code);
  if (!m) return false;
  const args = code.slice(m.index + m[0].length);
  if (SANITIZE_RE.test(args) && !INPUT_RE.test(args.replace(SANITIZE_RE, ''))) {
    // 参数整体被消毒函数包住：send_file(secure_filename(x))
    const first = args.trim();
    if (SANITIZE_RE.test(first.slice(0, 40))) return false;
  }
  if (INPUT_RE.test(args)) return true;
  return [...names].some((n) => new RegExp(`\\b${n}\\b`).test(args));
}

function rulesForLine(code, names) {
  const hits = [];
  // ── S2 ──
  if (FILE_SINK_RE.test(code) && argsTainted(code, FILE_SINK_RE, names) && !/send_from_directory\s*\(/.test(code)) {
    hits.push({ checkId: 'S2', severity: 'high', rule: 'S2.py-path-traversal', message: '疑似路径穿越：文件读取/下载的路径来自请求参数——用 secure_filename / send_from_directory 收敛到固定目录' });
  }
  if (SSTI_SINK_RE.test(code) && (argsTainted(code, SSTI_SINK_RE, names) || CONCAT_RE.test(code.slice(code.search(SSTI_SINK_RE))))) {
    hits.push({ checkId: 'S2', severity: 'high', rule: 'S2.py-ssti', message: '疑似服务端模板注入（SSTI）：模板字符串由拼接/外部输入构造——把用户数据作为渲染参数传入，不要拼进模板源码' });
  }
  if (SSRF_SINK_RE.test(code) && argsTainted(code, SSRF_SINK_RE, names)) {
    hits.push({ checkId: 'S2', severity: 'high', rule: 'S2.py-ssrf', message: '疑似 SSRF：外呼地址来自请求参数——对目标做域名白名单校验并禁止内网地址' });
  }
  // 开放重定向：跳转地址直接取自请求（登录后 ?next=）且没过站内校验
  if (REDIRECT_SINK_RE.test(code) && argsTainted(code, REDIRECT_SINK_RE, names) && !SAFE_REDIRECT_RE.test(code)) {
    hits.push({ checkId: 'S2', severity: 'medium', rule: 'S2.py-open-redirect', message: '疑似开放重定向：跳转地址来自请求参数——用 url_has_allowed_host_and_scheme 校验或只接受站内相对路径' });
  }
  // 反射 XSS：直接把拼接/插值了请求输入的 HTML 字符串作为响应返回（绕过了模板自动转义）
  if (HTML_RESPONSE_RE.test(code) && /<\w/.test(code) && (CONCAT_RE.test(code) || /\bf['"]/.test(code))
    && (INPUT_RE.test(code) || [...names].some((n) => new RegExp(`\\{\\s*${n}\\b|\\+\\s*${n}\\b|\\b${n}\\s*\\+`).test(code)))
    && !/\b(?:escape|html\.escape|markupsafe\.escape|bleach\.clean|conditional_escape)\s*\(/.test(code)) {
    hits.push({ checkId: 'S2', severity: 'high', rule: 'S2.py-reflected-xss', message: '疑似反射 XSS：响应 HTML 里直接拼接了请求输入——改用模板渲染（自动转义）或先 escape()' });
  }
  // ── S5 ──
  if (/\bCORS\s*\(\s*\w+\s*(?:\)|,[^)]*\borigins\s*=\s*(?:['"]\*['"]|\[\s*['"]\*['"]\s*\]))/.test(code)
    || /\bresources\s*=\s*\{[^}]*['"]origins['"]\s*:\s*['"]\*['"]/.test(code)) {
    hits.push({ checkId: 'S5', severity: 'medium', rule: 'S5.cors-wildcard', message: 'CORS 允许任意来源（Flask-CORS 未限定 origins 时默认就是 *）' });
  }
  if (/\ballow_origins\s*=\s*\[\s*['"]\*['"]\s*\]/.test(code) || /^\s*CORS_(?:ALLOW_ALL_ORIGINS|ORIGIN_ALLOW_ALL)\s*=\s*True\b/.test(code)) {
    hits.push({ checkId: 'S5', severity: 'medium', rule: 'S5.cors-wildcard', message: 'CORS 允许任意来源 (*)' });
  }
  if (/^\s*ALLOWED_HOSTS\s*=\s*[[(]\s*['"]\*['"]/.test(code)) {
    hits.push({ checkId: 'S5', severity: 'medium', rule: 'S5.allowed-hosts-wildcard', message: 'Django ALLOWED_HOSTS 允许任意主机——Host 头投毒（密码重置链接劫持等）' });
  }
  // ── S8 ──
  if (/^\s*(?:SESSION_COOKIE_SECURE|CSRF_COOKIE_SECURE|SESSION_COOKIE_HTTPONLY)\s*=\s*False\b/.test(code)
    || /\[\s*['"](?:SESSION_COOKIE_SECURE|SESSION_COOKIE_HTTPONLY|REMEMBER_COOKIE_SECURE)['"]\s*\]\s*=\s*False\b/.test(code)
    || /\.set_cookie\s*\([^)]*\b(?:secure|httponly)\s*=\s*False\b/.test(code)) {
    hits.push({ checkId: 'S8', severity: 'medium', rule: 'S8.py-insecure-cookie', message: '会话 cookie 关闭了 Secure/HttpOnly——生产环境必须开启' });
  }
  if (/\bjwt\s*\.\s*decode\s*\(/.test(code) && (/['"]verify_signature['"]\s*:\s*False/.test(code) || /\bverify\s*=\s*False\b/.test(code) || /algorithms\s*=\s*[[(][^\])]*['"]none['"]/i.test(code))) {
    hits.push({ checkId: 'S8', severity: 'high', rule: 'S8.jwt-no-verify', message: 'JWT 解码关闭了签名校验——任何人都能伪造令牌' });
  }
  return hits;
}

export async function checkPyRules(projectDir, { excludes = [], includeFixtures = false } = {}) {
  const findings = [];
  const { files } = await listTextFiles(projectDir, excludes, { includeFixtures });
  const pyFiles = files.filter((f) => /\.py$/i.test(f));
  for (const f of pyFiles) {
    const { file, text } = await readRel(projectDir, f);
    const lines = text.split('\n');
    const taint = taintByLine(lines);
    for (let i = 0; i < lines.length; i++) {
      if (/finalcheck:allow/.test(lines[i])) continue;
      const code = stripComment(lines[i]);
      if (!code.trim()) continue;
      for (const h of rulesForLine(code, taint[i] || new Set())) {
        findings.push({ ...h, force: 'card', file, line: i + 1, snippet: code.trim().slice(0, 120), source: 'program' });
      }
    }
  }
  return { findings, scannedFiles: pyFiles.length };
}
