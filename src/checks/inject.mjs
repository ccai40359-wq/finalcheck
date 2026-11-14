import { listTextFiles, readRel, prunedWarning } from '../walk.mjs';
import { sourceModel, walkSource, memberName, isFunction } from '../source-analysis.mjs';

// S2 注入类（ACCEPTANCE §4-A）：SQLi / eval / 命令注入 / 路径穿越 / SSRF / 反射 XSS。
// 正则只认“调用形态”（自食教训：扫描器源码里的正则字面量若含裸词会被自咬，
// 参照 tiers.mjs 的做法，模式必须带括号调用且各行不同时凑齐触发组合）。
// 单行 >1000 字符按压缩/第三方代码跳过并入 warnings；行内 `finalcheck:allow` 豁免；
// 文档(.md/.txt)命中降为提醒级线索（同 secrets.mjs：文档示例不算实锤）。
// 另有 AST 本地数据流：跨行 `const x = '…' + req.query.y; db.query(x)` 也能报；
// SSRF 额外判断 URL 主机是否真的可被请求输入改写，同源相对路径不再误报。

const RE_CONCAT = /['"`]\s*[+]|[+]\s*['"`]|\$\{/; // 字符串拼接或模板插值
const RE_SQL_KW = /\b(?:select|insert|update|delete)\b/i;
const RE_SQL_CALL = /\b(?:query|exec|execute)\s*\(/i;
// eval/new Function 都是大小写敏感的内建调用；`obj.eval()` 是插件/库方法（Ruby JSAPI、
// REPL 等），不算动态代码执行。`Eval(s)` 这类 UI 文案不算（dsh overview 误报）。
const RE_EVAL_CALL = /(?:^|[^.\w$])eval\s*\(|\bnew\s+Function\s*\(/;
const RE_EXEC_BARE = /(?:^|[(=,\s!{])exec(?:Sync)?\s*\(/;
const RE_FILE_CALL = /\b(?:sendFile|readFile|unlink|createReadStream)\s*\(/;
const RE_REQ_INPUT = /\breq\s*\.\s*(?:query|params|body)\b/;
const RE_SSRF = /\b(?:fetch|axios(?:\s*\.\s*\w+)?|https?\s*\.\s*(?:get|request)|request)\s*\(\s*(?:req(?:uest)?)\s*\.\s*(?:query|params|body)\b/;
const RE_SEND_CALL = /\bres(?:ponse)?\s*\.\s*(?:send|write)\s*\(/i;
const RE_XSS_INTERP = /\$\{[^}]*\breq(?:uest)?\s*\./;
const RE_ESCAPED = /\bencodeURI(?:Component)?\b|\bescapeHtml\b|\bsanitize\w*|\bentities\b/i; // 已转义输出不算反射 XSS
const RE_EXEC_METHOD = /\.\s*exec(?:Sync)?\s*\(/;

// 正则字面量上的 .exec() 不是命令执行。
// 自食教训（2026-11-08）：`/^\s*resolved\s+"?…/.exec(line)` 这种行里，
// `\s+` 的 `+` 紧跟一个 `"`，会命中「加号拼接」启发式 → 把正则当命令注入（真仓自查自咬）。
function isRegexLiteralExec(line) {
  const i = line.search(RE_EXEC_METHOD);
  if (i < 0) return false;
  const before = line.slice(0, i);
  // 不能把 '(' 当切分点：正则字面量内部就有括号（(https?:…），会切到正则中间
  const cut = Math.max(before.lastIndexOf('='), before.lastIndexOf(';'), before.lastIndexOf('{'));
  return before.slice(cut + 1).trim().startsWith('/');
}

// `.exec()` 的接收者分类：数据库/驱动/正则/解析器上的 exec 不是命令执行。
// 宁可漏报第三方插件/驱动，也不再把 `this.db.exec(...)`、`new RegExp(...).exec(...)` 当 child_process。
const EXEC_SKIP_RECEIVER = /^(?:db|database|conn|connection|client|pool|stmt|statement|observer|sqlite|pg|mysql|mssql|mongo|redis|regexp|regex|re|rx|pattern|matcher|rule|parser|compiler|sandbox|vfs|fs)$/;
const EXEC_COMMAND_RECEIVER = /^(?:child_process|cp|sh|shell|spawn)$/;

function baseIdentifier(text) {
  // 忽略字符串字面量里的词，避免 getExec('spawn') 这种调用的字符串实参被当成接收者名。
  const stripped = String(text || '').replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, ' ');
  const ids = [...stripped.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
  return ids.length ? ids[ids.length - 1] : '';
}

// 返回 'command' / 'non-command' / 'regexp' / 'unknown'。
// unknown 的第三方 .exec() 按非命令处理（插件、驱动上的 exec 太常见）。
function classifyReceiverText(text, execAliases = null) {
  const receiver = String(text || '').trim();
  if (!receiver) return 'unknown';
  if (/RegExp/.test(receiver)
    && (receiver.startsWith('RegExp(') || receiver.startsWith('new RegExp(') || receiver.endsWith(')'))) {
    return 'regexp';
  }
  if (/(?:require|import)\s*\(\s*(?:'|")(?:node:)?child_process(?:'|")/.test(receiver)) return 'command';
  const base = baseIdentifier(receiver);
  if (!base) return 'unknown';
  if (EXEC_SKIP_RECEIVER.test(base.toLowerCase())) return 'non-command';
  if (EXEC_COMMAND_RECEIVER.test(base.toLowerCase())) return 'command';
  if (execAliases?.has(base)) return 'command';
  return 'unknown';
}

// 从 `.exec(` 的点号往前取接收者文本（支持 `new RegExp(...)` 这类带括号/空格的表达式）。
function receiverTextBeforeDot(line, dotIndex) {
  let i = dotIndex - 1;
  while (i >= 0 && /\s/.test(line[i])) i--;
  if (i < 0) return '';
  const end = i + 1;
  if (line[i] === ')') {
    let depth = 0;
    for (; i >= 0; i--) {
      if (line[i] === ')') depth++;
      else if (line[i] === '(') {
        depth--;
        if (depth === 0) break;
      }
    }
    let j = i - 1;
    while (j >= 0 && /[\w$.]/.test(line[j])) j--;
    return line.slice(j + 1, end);
  }
  let j = i;
  while (j >= 0 && /[\w$.\]]/.test(line[j])) j--;
  return line.slice(j + 1, end);
}

function execMemberDot(line) {
  const m = RE_EXEC_METHOD.exec(line);
  return m ? m.index + m[0].indexOf('.') : -1;
}

function cmdiHit(line, ctx = {}) {
  if (!RE_CONCAT.test(line)) return false;
  // 裸 exec/execSync 仍按拼接命中（解构自 child_process 的调用没有接收者）。
  if (RE_EXEC_BARE.test(line)) return true;
  if (isRegexLiteralExec(line)) return false;
  // 收尾是 `/` 的接收者也是正则字面量（如 `/(?:[:：=]|\s)/.exec(line)`）：
  // 正则里带 `+` 或括号时 isRegexLiteralExec 的切分可能失效，这里再兜一层，别把 RegExp.exec 当命令执行。
  const dot = execMemberDot(line);
  if (dot < 0) return false;
  const receiver = receiverTextBeforeDot(line, dot);
  if (receiver.trim().endsWith('/')) return false;
  return classifyReceiverText(receiver, ctx.execAliases) === 'command';
}

function xssHit(line) {
  if (!RE_SEND_CALL.test(line) || RE_ESCAPED.test(line)) return false;
  return RE_XSS_INTERP.test(line) || (RE_CONCAT.test(line) && RE_REQ_INPUT.test(line));
}

// SQL 占位符形态：? / $1 / :name（参数化查询的标志）
const RE_SQL_PLACEHOLDER = /\?|\$\d+\b|:[A-Za-z_][A-Za-z0-9_]*/;

// 取 SQL 调用的第一个实参文本（到顶层逗号或右括号为止），用于判断拼接发生在
// SQL 语句本身，还是只发生在后续的参数数组/对象里。
// 反例：db.query('SELECT * FROM t WHERE q LIKE ?', ['%' + req.query.q + '%'])
function firstArgText(line, openParen) {
  let depth = 0;
  let quote = '';
  let i = openParen + 1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) break;
  }
  return line.slice(openParen + 1, i);
}

// 首个实参是否是「带占位符的单个静态字面量」（字符串/无插值模板）。
function isParameterizedSqlText(text) {
  const s = text.trim();
  if (!s) return false;
  const q = s[0];
  if (q !== '\'' && q !== '"' && q !== '`') return false;
  let i = 1;
  for (; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === q) break;
  }
  if (i !== s.length - 1) return false; // 字面量之后还有拼接/多余 token
  return RE_SQL_PLACEHOLDER.test(s.slice(1, -1));
}

// 文本里是否有可确认的外部输入：req.* 或当前文件的函数参数。
// 属性访问（obj.paramName）不算，避免把同名的对象字段当外部输入。
function textHasExternalInput(text, params = null) {
  if (!text) return false;
  if (RE_REQ_INPUT.test(text)) return true;
  if (!params?.size) return false;
  const identifier = /[A-Za-z_$][\w$]*/g;
  let match;
  while ((match = identifier.exec(text))) {
    let j = match.index - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j >= 0 && text[j] === '.') continue; // 属性名 obj.param
    let k = match.index + match[0].length;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (text[k] === '.' || (text[k] === '?' && text[k + 1] === '.')) continue; // 对象本身 obj.id，不是 obj
    if (params.has(match[0])) return true;
  }
  return false;
}

// 去掉 // 行注释与 /* */ 块注释（跨行状态由调用方保存）。
// 字符串/模板内容保留，SQL 关键词识别仍依赖字面量内容。
function stripComments(line, inBlockComment) {
  let out = '';
  let quote = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inBlockComment) {
      if (ch === '*' && line[i + 1] === '/') { inBlockComment = false; i += 2; }
      else i++;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < line.length) { out += line[i + 1]; i += 2; continue; }
        i++;
        continue;
      }
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; out += ch; i++; continue; }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '/' && line[i + 1] === '*') { inBlockComment = true; i += 2; continue; }
    out += ch;
    i++;
  }
  return { code: out, inBlockComment };
}

// 找模板插值 `${...}` 的结束 `}`（考虑嵌套括号与字符串）。
function interpolationEnd(code, from) {
  let depth = 1;
  let quote = '';
  for (let i = from; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// eval/new Function 检测前去掉字符串与模板里的静态文本（只留引号/括号/运算符），
// 避免 `const s = 'eval("x"+y)'`、`\`new Function(...)\`` 这类文本自咬；
// 模板插值 `${...}` 是表达式，保留并递归处理，`eval(\`x=${req.query.v}\`)` 仍算动态。
function stripEvalLiterals(code) {
  let out = '';
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\'' || ch === '"') {
      out += ch;
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === ch) { out += ch; break; }
        i++;
      }
      continue;
    }
    if (ch === '`') {
      out += '`';
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '`') { out += '`'; break; }
        if (code[i] === '$' && code[i + 1] === '{') {
          const end = interpolationEnd(code, i + 2);
          if (end < 0) { i = code.length; break; }
          out += '${' + stripEvalLiterals(code.slice(i + 2, end)) + '}';
          i = end;
          continue;
        }
        i++; // 模板静态文本丢弃
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function sqliHit(line, ctx = {}) {
  if (!RE_SQL_CALL.test(line) || !RE_SQL_KW.test(line) || !RE_CONCAT.test(line)) return false;
  const calls = /\b(?:query|exec|execute)\s*\(/gi;
  let firstConcatSpan = '';
  let match;
  while ((match = calls.exec(line))) {
    // 只认 SQL 首参内的拼接；第二个实参是参数数组，里面的拼接不算注入。
    const span = firstArgText(line, match.index + match[0].lastIndexOf('('));
    if (isParameterizedSqlText(span) || !RE_CONCAT.test(span)) continue;
    firstConcatSpan = span;
    break;
  }
  if (!firstConcatSpan) return false;
  // 有 SQL 拼接但确认不了外部输入时仍保留规则，只降为 check，要求人工复核。
  return textHasExternalInput(firstConcatSpan, ctx.params) ? 'high' : 'check';
}

// 代码执行组件（evaluator/sandbox/repl/inspector/runtime）里的 eval/new Function
// 是产品功能本身（CDP 调试器、插件运行器、REPL），不是注入漏洞；仍保留发现但降为 check。
const EVAL_BY_DESIGN = /(?:^|\/)(?:evaluator|evaluators|sandbox|repl|inspector|runtime|runner|compiler|vm)(?:\/|\.)/i;

function evalHit(line, ctx = {}) {
  if (!RE_EVAL_CALL.test(line)) return false;
  // 拼接构造代码（真实动态执行）优先；直接 eval(req.body.x) 也要保留（NodeGoat 类真阳）。
  if (RE_CONCAT.test(line)) return EVAL_BY_DESIGN.test(String(ctx.file || '')) ? 'check' : 'high';
  if (textHasExternalInput(line, ctx.params)) {
    return EVAL_BY_DESIGN.test(String(ctx.file || '')) ? 'check' : 'high';
  }
  // eval(someVariable) / new Function(someVariable)：即使变量名不在白名单，也不能静默，
  // 至少交人工复核（避免 `function render(source){ eval(source) }` 这类 RCE sink 漏报）。
  if (/\beval\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(line)
    || /\bnew\s+Function\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(line)) return 'check';
  return false;
}

const RULES = [
  { rule: 'S2.sqli-concat', msg: '疑似 SQL 注入：查询调用以字符串拼接（加号或模板插值）构造 SQL——改用参数化查询（占位符 ? 或 $1）', hit: sqliHit },
  { rule: 'S2.eval-dynamic', msg: '疑似动态代码执行：eval / new Function 拼接了变量——改用显式逻辑或 JSON.parse', hit: evalHit, stripped: true },
  { rule: 'S2.cmdi', msg: '疑似命令注入：exec/execSync 拼接了外部输入——改用 execFile/spawn 的参数数组形式', hit: cmdiHit },
  { rule: 'S2.path-traversal', msg: '疑似路径穿越：文件读取/发送以拼接方式使用 req 输入——校验后用 path.basename/path.resolve 收敛到固定目录', hit: (l) => RE_FILE_CALL.test(l) && RE_REQ_INPUT.test(l) && RE_CONCAT.test(l) },
  { rule: 'S2.ssrf', msg: '疑似 SSRF：外呼地址直接取自 req 输入——对目标做域名白名单校验', hit: (l) => RE_SSRF.test(l) },
  { rule: 'S2.reflected-xss', msg: '疑似反射 XSS：响应输出拼接/内插 req 输入——输出前转义或用模板引擎自动转义', hit: xssHit },
];

// 报告永不回显密钥/口令本体（与 secrets.mjs 同一脱敏链）
function sanitize(raw) {
  return raw
    .replace(/(['"])[^'"]{6,}\1/g, '$1***$1')
    .replace(/(=\s*)[^\s'"]{8,}/g, '$1***')
    .replace(/[A-Z0-9]{16,}/g, '***');
}

// ---- 本地数据流（S2）----
// 轻量传播：变量/别名解引用后汇总 input（req 输入）/ sql（SQL 关键词）/ concat（拼接）。
// 调用结果一律视为未知（可能是消毒函数），宁可漏报也不把 sanitizer 当输入。
// 不做跨函数/跨文件推断；命中由调用方统一标注“需复核”。

const FLOW_EMPTY = Object.freeze({ input: false, sql: false, concat: false });

function flowInfo(raw, model, seen = new Set(), params = null) {
  if (!raw || seen.has(raw)) return FLOW_EMPTY;
  seen.add(raw);
  // 函数参数没有本地绑定，但按外部输入处理（跨函数追踪不做，宁可交给人工复核）。
  if (raw.type === 'Identifier' && params?.has(raw.name)) {
    return { input: true, sql: false, concat: false };
  }
  const node = raw.type === 'Identifier' ? model.binding(raw) : raw;
  if (!node) return FLOW_EMPTY;
  if (node !== raw) return flowInfo(node, model, seen, params);
  if (node.type === 'CallExpression') return FLOW_EMPTY;
  const text = model.text(node);
  const combined = {
    input: node.type === 'MemberExpression' && RE_REQ_INPUT.test(text),
    sql: false,
    concat: (node.type === 'TemplateLiteral' && node.expressions.length > 0)
      || (node.type === 'BinaryExpression' && node.operator === '+'),
  };
  if (node.type === 'StringLiteral' || node.type === 'TemplateLiteral') combined.sql = RE_SQL_KW.test(text);
  for (const child of [node.left, node.right, ...(node.expressions || [])]) {
    const sub = flowInfo(child, model, new Set(seen), params);
    combined.input ||= sub.input;
    combined.sql ||= sub.sql;
    combined.concat ||= sub.concat;
  }
  return combined;
}

// 沿变量别名取表达式的静态字面前缀；complete=true 表示整个表达式都是静态字面量。
function leadingStatic(raw, model, seen = new Set()) {
  if (!raw || seen.has(raw)) return { prefix: '', complete: false };
  seen.add(raw);
  if (raw.type === 'Identifier') {
    const bound = model.binding(raw);
    return bound ? leadingStatic(bound, model, seen) : { prefix: '', complete: false };
  }
  if (raw.type === 'StringLiteral') return { prefix: raw.value, complete: true };
  if (raw.type === 'TemplateLiteral') {
    const head = raw.quasis?.[0]?.value;
    return { prefix: (head?.cooked ?? head?.raw) || '', complete: raw.expressions.length === 0 };
  }
  if (raw.type === 'BinaryExpression' && raw.operator === '+') {
    const left = leadingStatic(raw.left, model, seen);
    if (!left.complete) return left;
    const right = leadingStatic(raw.right, model, seen);
    return { prefix: left.prefix + right.prefix, complete: right.complete };
  }
  return { prefix: '', complete: false };
}

// SSRF 的作用域判定：只有主机部分能被请求输入改写才算 dynamic。
// relative    = 同源相对路径（/api、./x、?id、#frag 等），不是 SSRF；
// fixed-host  = 协议 + 完整固定主机（含默认端口），只有路径/查询可被输入影响；
// dynamic     = 主机为空或可能被输入补全/改写（https://、https://api. + 输入 等）。
function urlScope(raw, model) {
  const { prefix, complete } = leadingStatic(raw, model);
  if (!prefix) return 'dynamic';
  if (prefix.startsWith('//')) {
    const rest = prefix.slice(2);
    const cut = rest.search(/[/?#]/);
    if (cut === 0 || (cut < 0 && !complete)) return 'dynamic';
    return 'fixed-host';
  }
  if (prefix.startsWith('/') || prefix.startsWith('./') || prefix.startsWith('../') || prefix.startsWith('?') || prefix.startsWith('#')) return 'relative';
  const absolute = /^(?:https?|wss?|ftp):\/\/([^/?#]*)(.*)$/i.exec(prefix);
  if (absolute) {
    if (!absolute[1]) return 'dynamic'; // 只固定了协议，主机由输入决定
    if (absolute[2]) return 'fixed-host'; // 主机后已有 / ? # 分隔，主机收满
    return complete ? 'fixed-host' : 'dynamic'; // 主机可能被后续输入延长（api.example.com.evil）
  }
  // 只拼了半截协议（'http' / 'http:' / 'http:/'）时，攻击者还能补全成完整 URL。
  if (/^(?:h|ht|htt|http|https|w|ws|wss|f|ft|ftp)(?::?\/?)$/i.test(prefix)) return 'dynamic';
  return 'relative';
}

// 文件路径参数是否含请求输入。path.join/resolve/normalize 不阻止穿越（固定前缀也照报）；
// 其它调用视为未知消毒函数（如 path.basename）不跟着下钻。
function hasRequestInput(raw, model, seen = new Set()) {
  if (!raw || seen.has(raw)) return false;
  seen.add(raw);
  if (raw.type === 'Identifier') {
    const bound = model.binding(raw);
    return bound ? hasRequestInput(bound, model, seen) : false;
  }
  if (raw.type === 'MemberExpression') return RE_REQ_INPUT.test(model.text(raw));
  if (raw.type === 'TemplateLiteral') return raw.expressions.some((e) => hasRequestInput(e, model, new Set(seen)));
  if (raw.type === 'BinaryExpression' || raw.type === 'LogicalExpression') {
    return hasRequestInput(raw.left, model, new Set(seen)) || hasRequestInput(raw.right, model, new Set(seen));
  }
  if (raw.type === 'ConditionalExpression') {
    return hasRequestInput(raw.consequent, model, new Set(seen)) || hasRequestInput(raw.alternate, model, new Set(seen));
  }
  if (raw.type === 'CallExpression') {
    const name = memberName(raw.callee) || raw.callee?.name || '';
    if (!/^(?:join|resolve|normalize)$/.test(name)) return false;
    return raw.arguments.some((a) => a && hasRequestInput(a, model, new Set(seen)));
  }
  return false;
}

// 沿变量别名解析到静态字面量节点（无法解析时返回 null）。
function resolveStaticNode(raw, model, seen = new Set()) {
  if (!raw || seen.has(raw)) return null;
  seen.add(raw);
  if (raw.type === 'Identifier') {
    const bound = model.binding(raw);
    return bound ? resolveStaticNode(bound, model, seen) : null;
  }
  return raw;
}

// SQL 首参（含别名）是否参数化：带占位符的字符串字面量 / 无插值模板。
function isParameterizedSqlArg(raw, model) {
  const node = resolveStaticNode(raw, model);
  if (!node) return false;
  if (node.type === 'StringLiteral') return RE_SQL_PLACEHOLDER.test(node.value);
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    const text = node.quasis.map((q) => (q.value.cooked ?? q.value.raw) || '').join('');
    return RE_SQL_PLACEHOLDER.test(text);
  }
  return false;
}

// 同一行所有 SQL 调用的首参都参数化时，该行可作为“拼接只在后续参数”的行级豁免。
function parameterizedSqlLines(model) {
  const byLine = new Map();
  walkSource(model.ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const name = memberName(node.callee) || node.callee?.name || '';
    if (!/^(?:query|exec|execute)$/i.test(name)) return;
    const line = node.loc?.start.line;
    if (!line) return;
    const all = byLine.has(line) ? byLine.get(line) : true;
    byLine.set(line, all && isParameterizedSqlArg(node.arguments[0], model));
  });
  const safe = new Set();
  for (const [line, all] of byLine) if (all) safe.add(line);
  return safe;
}

function collectPatternNames(node, out) {
  if (!node) return;
  if (node.type === 'Identifier') out.add(node.name);
  else if (node.type === 'AssignmentPattern') collectPatternNames(node.left, out);
  else if (node.type === 'RestElement') collectPatternNames(node.argument, out);
  else if (node.type === 'ObjectPattern') {
    for (const prop of node.properties || []) {
      collectPatternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
    }
  } else if (node.type === 'ArrayPattern') {
    for (const el of node.elements || []) collectPatternNames(el, out);
  } else if (node.type === 'TSParameterProperty') collectPatternNames(node.parameter, out);
}

// 当前文件里「像外部输入」的函数参数名。把所有参数都当外部输入会把数据库迁移的
// tableName/columnName、TypeORM 的 tablePath 也当用户输入，造成 SQLi 误报；
// 只保留请求/命令行/文件路径这类语义的参数名（inject-sqli 的 name/email 仍在）。
const EXTERNAL_PARAM_RE = /^(?:req|request|ctx|context|input|payload|body|query|querystring|params?|parameters|args?|argv|user|username|name|email|url|uri|host|cmd|command|code|script|file|filename|path|id|key|token|search|keyword|q|value|data)$/i;

// 当前文件所有函数参数名。不做跨函数/作用域追踪，按外部输入对待。
function collectParamNames(model) {
  const names = new Set();
  walkSource(model.ast, (node) => {
    if (!isFunction(node)) return;
    for (const param of node.params || []) {
      const tmp = new Set();
      collectPatternNames(param, tmp);
      for (const n of tmp) if (EXTERNAL_PARAM_RE.test(n)) names.add(n);
    }
  });
  return names;
}

// child_process 的本地别名（require/import 形式），供 `.exec` 接收者分类使用。
// Map<本地名, 'command'>：支持 `const { exec: run } = require('child_process')` 这类重命名。
function collectExecAliases(model) {
  const aliases = new Map();
  const mark = (name) => { if (name) aliases.set(name, 'command'); };
  const isChildProcessSource = (node) => node?.type === 'StringLiteral'
    && /^(?:node:)?child_process$/.test(node.value);
  walkSource(model.ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.init?.type === 'CallExpression'
      && node.init.callee?.type === 'Identifier' && node.init.callee.name === 'require'
      && isChildProcessSource(node.init.arguments?.[0])) {
      if (node.id.type === 'Identifier') mark(node.id.name);
      else if (node.id.type === 'ObjectPattern') {
        for (const prop of node.id.properties || []) {
          const keyName = prop.key?.name || prop.key?.value;
          const local = prop.value?.name;
          if (local && /^(?:exec|execSync)$/.test(String(keyName || ''))) mark(local);
        }
      }
    }
    if (node.type === 'ImportDeclaration' && isChildProcessSource(node.source)) {
      for (const spec of node.specifiers || []) {
        const local = spec.local?.name;
        if (!local) continue;
        if (spec.type === 'ImportSpecifier' && /^(?:exec|execSync)$/.test(String(spec.imported?.name || ''))) mark(local);
        else if (spec.type === 'ImportNamespaceSpecifier' || spec.type === 'ImportDefaultSpecifier') mark(local);
      }
    }
  });
  return aliases;
}

function isCommandExecCallee(callee, model, execAliases) {
  if (callee?.type === 'Identifier') {
    return /^(?:exec|execSync)$/.test(callee.name) || execAliases?.get?.(callee.name) === 'command';
  }
  if (callee?.type !== 'MemberExpression' && callee?.type !== 'OptionalMemberExpression') return false;
  if (!/^(?:exec|execSync)$/.test(memberName(callee) || '')) return false;
  return classifyReceiverText(model.text(callee.object), execAliases) === 'command';
}

function localFlowFindings(model, { params = null, execAliases = null } = {}) {
  const hits = [];
  walkSource(model.ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const name = memberName(node.callee) || node.callee?.name || '';
    const first = node.arguments[0];
    const arg = flowInfo(first, model, new Set(), params);
    // SSRF/XSS 保持原有 req.* 判据：函数参数（如 fetch(url) 的 url）不在此扩大范围。
    const reqArg = params?.size ? flowInfo(first, model) : arg;
    const add = (rule) => hits.push({ rule, line: node.loc?.start.line || 1 });
    if (/^(query|exec|execute)$/i.test(name) && arg.input && arg.sql && arg.concat) add('S2.sqli-concat');
    if (/^(fetch|axios|request|get|post|put)$/i.test(name) && reqArg.input
      && (node.callee.type === 'Identifier' || /^(?:axios|https?)$/.test(node.callee.object?.name || ''))
      && urlScope(first, model) === 'dynamic') add('S2.ssrf');
    if (/^(exec|execSync)$/.test(name) && arg.input && arg.concat
      && isCommandExecCallee(node.callee, model, execAliases)) add('S2.cmdi');
    if (/^(sendFile|readFile|unlink|createReadStream)$/.test(name) && hasRequestInput(first, model)) add('S2.path-traversal');
    if (/^(send|write)$/.test(name) && ['res', 'response'].includes(node.callee.object?.name) && reqArg.input && reqArg.concat) add('S2.reflected-xss');
  });
  return hits;
}

export async function checkInject(projectDir, { tier, excludes = [], routeResult = null, includeFixtures = false } = {}) {
  void routeResult; // S2 不消费路由表；参数仅为与接线契约一致
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  const force = t === 'L1' ? 'check' : 'card'; // 矩阵：L1 查 / L2 卡 / L3 卡
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes, { includeFixtures });
  if (skipped.length) warnings.push(`跳过大文件 ${skipped.length} 个（>512KB 未扫描）：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}`);
  const pw = prunedWarning(pruned);
  if (pw) warnings.push(pw);
  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    if (/package-lock|yarn\.lock|pnpm-lock/.test(file)) continue;
    const isDoc = /\.(md|txt)$/i.test(file);
    const lines = text.split('\n');
    const minified = lines.filter((l) => l.length > 1000).length;
    if (minified) warnings.push(`疑似压缩/第三方代码跳过 ${minified} 行：${file}`); // 自食教训#5
    const parseable = !isDoc && /\.[cm]?[jt]sx?$/.test(file);
    const model = parseable ? sourceModel(text) : null;
    const ctx = {
      params: model ? collectParamNames(model) : null,
      execAliases: model ? collectExecAliases(model) : null,
      file,
    };
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 1000) continue;
      if (line.includes('finalcheck:allow')) continue;
      const stripped = stripComments(line, inBlockComment);
      inBlockComment = stripped.inBlockComment;
      const evalCode = stripEvalLiterals(stripped.code);
      for (const r of RULES) {
        const verdict = r.hit(r.stripped ? evalCode : stripped.code, ctx);
        if (!verdict) continue;
        const checkOnly = verdict === 'check';
        // 开发者已用 eslint/oxlint 的 no-implied-eval 注释显式确认了动态执行：
        // 保留发现但降为提示，不再按高危卡（DSH sandbox.ts 的 compile-only gate）。
        const lintAck = r.rule === 'S2.eval-dynamic'
          && (/(?:oxlint|eslint)-disable(?:-next-line|-line)?.*(?:no-implied-eval|no-eval)/.test(line)
            || (i > 0 && /(?:oxlint|eslint)-disable-next-line.*(?:no-implied-eval|no-eval)/.test(lines[i - 1])));
        findings.push({
          checkId: 'S2',
          severity: isDoc ? 'medium' : 'high',
          force: isDoc || lintAck ? 'tip' : checkOnly ? 'check' : force,
          file,
          line: i + 1,
          rule: r.rule,
          snippet: sanitize(line.trim().slice(0, 120)),
          message: isDoc
            ? `${r.msg}（出现在文档中，可能是示例）`
            : `${r.msg}${checkOnly ? '；未确认外部输入，需人工复核' : ''}`,
          source: 'program',
        });
      }
    }
    if (model) {
      // 行级规则只看整行拼接；若该行所有 SQL 调用首参（含别名）都参数化，
      // 拼接只可能落在后续参数里 → 撤掉该行的行级 sqli 误报。
      const safeSqlLines = parameterizedSqlLines(model);
      if (safeSqlLines.size) {
        for (let i = findings.length - 1; i >= 0; i--) {
          const finding = findings[i];
          if (finding.file === file && finding.rule === 'S2.sqli-concat' && safeSqlLines.has(finding.line)) findings.splice(i, 1);
        }
      }
      const seen = new Map();
      for (let i = 0; i < findings.length; i++) {
        const finding = findings[i];
        if (finding.file === file) seen.set(`${finding.line}|${finding.rule}`, i);
      }
      for (const hit of localFlowFindings(model, ctx)) {
        const key = `${hit.line}|${hit.rule}`;
        const existing = seen.get(key);
        if (existing !== undefined) {
          // 行级只看到局部文本时可能降为 check；AST 能确认外部输入则升级回 card。
          const current = findings[existing];
          if (hit.rule === 'S2.sqli-concat' && current.force === 'check') {
            const base = RULES.find((r) => r.rule === hit.rule);
            current.force = force;
            current.message = `${base?.msg || hit.rule}（含本地变量数据流线索，需复核）`;
          }
          continue; // 同一 file+line+rule 只报一次（正则与数据流不重复）
        }
        const line = lines[hit.line - 1] || '';
        if (line.includes('finalcheck:allow')) continue;
        seen.set(key, findings.length);
        const base = RULES.find((r) => r.rule === hit.rule);
        findings.push({
          checkId: 'S2',
          severity: 'high',
          force,
          file,
          line: hit.line,
          rule: hit.rule,
          snippet: sanitize(line.trim().slice(0, 120)),
          message: `${base?.msg || hit.rule}（含本地变量数据流线索，需复核）`,
          source: 'program',
        });
      }
    }
  }
  return { checkId: 'S2', findings, coverageGap: null, warnings };
}
