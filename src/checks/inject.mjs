import { listTextFiles, readRel, prunedWarning } from '../walk.mjs';
import { sourceModel, walkSource, memberName } from '../source-analysis.mjs';

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
const RE_EVAL_CALL = /\beval\s*\(|\bnew\s+Function\s*\(/i;
const RE_EXEC_BARE = /(?:^|[(=,\s!{])exec(?:Sync)?\s*\(/;
const RE_EXEC_MEMBER = /\.\s*exec(?:Sync)?\s*\(/;
const RE_RX_EXEC = /\b(?:re|rx|regexp?|pattern|matcher?)\w*\s*\.\s*exec\s*\(/i; // 正则的 exec 不是命令执行
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

function cmdiHit(line) {
  if (!RE_CONCAT.test(line)) return false;
  if (RE_EXEC_BARE.test(line)) return true;
  if (isRegexLiteralExec(line)) return false;
  // 收尾是 `/` 的接收者也是正则字面量（如 `/(?:[:：=]|\s)/.exec(line)`）：
  // 正则里带 `+` 或括号时 isRegexLiteralExec 的切分可能失效，这里再兜一层，别把 RegExp.exec 当命令执行。
  const receiver = /([^\s]+)\s*\.\s*exec(?:Sync)?\s*\(/.exec(line);
  if (receiver && receiver[1].trim().endsWith('/')) return false;
  return RE_EXEC_MEMBER.test(line) && !RE_RX_EXEC.test(line);
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

function sqliHit(line) {
  if (!RE_SQL_CALL.test(line) || !RE_SQL_KW.test(line) || !RE_CONCAT.test(line)) return false;
  const spans = [];
  const calls = /\b(?:query|exec|execute)\s*\(/gi;
  let match;
  while ((match = calls.exec(line))) spans.push(firstArgText(line, match.index + match[0].lastIndexOf('(')));
  if (!spans.length) return true;
  // 只有「每个 SQL 调用的首参都是带占位符的静态字面量，且首参内无拼接」才不报；
  // 拼接在 SQL 首参内、模板插值、或首参形态不明时一律保留原判定。
  return spans.some((span) => RE_CONCAT.test(span) || !isParameterizedSqlText(span));
}

const RULES = [
  { rule: 'S2.sqli-concat', msg: '疑似 SQL 注入：查询调用以字符串拼接（加号或模板插值）构造 SQL——改用参数化查询（占位符 ? 或 $1）', hit: sqliHit },
  { rule: 'S2.eval-dynamic', msg: '疑似动态代码执行：eval / new Function 拼接了变量——改用显式逻辑或 JSON.parse', hit: (l) => RE_EVAL_CALL.test(l) && RE_CONCAT.test(l) },
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

function flowInfo(raw, model, seen = new Set()) {
  if (!raw || seen.has(raw)) return FLOW_EMPTY;
  seen.add(raw);
  const node = raw.type === 'Identifier' ? model.binding(raw) : raw;
  if (!node) return FLOW_EMPTY;
  if (node !== raw) return flowInfo(node, model, seen);
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
    const sub = flowInfo(child, model, new Set(seen));
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

function localFlowFindings(model) {
  const hits = [];
  walkSource(model.ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const name = memberName(node.callee) || node.callee?.name || '';
    const first = node.arguments[0];
    const arg = flowInfo(first, model);
    const add = (rule) => hits.push({ rule, line: node.loc?.start.line || 1 });
    if (/^(query|exec|execute)$/i.test(name) && arg.input && arg.sql && arg.concat) add('S2.sqli-concat');
    if (/^(fetch|axios|request|get|post|put)$/i.test(name) && arg.input
      && (node.callee.type === 'Identifier' || /^(?:axios|https?)$/.test(node.callee.object?.name || ''))
      && urlScope(first, model) === 'dynamic') add('S2.ssrf');
    if (/^(exec|execSync)$/.test(name) && arg.input && arg.concat) add('S2.cmdi');
    if (/^(sendFile|readFile|unlink|createReadStream)$/.test(name) && hasRequestInput(first, model)) add('S2.path-traversal');
    if (/^(send|write)$/.test(name) && ['res', 'response'].includes(node.callee.object?.name) && arg.input && arg.concat) add('S2.reflected-xss');
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
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 1000) continue;
      if (line.includes('finalcheck:allow')) continue;
      for (const r of RULES) {
        if (!r.hit(line)) continue;
        findings.push({
          checkId: 'S2',
          severity: isDoc ? 'medium' : 'high',
          force: isDoc ? 'tip' : force,
          file,
          line: i + 1,
          rule: r.rule,
          snippet: sanitize(line.trim().slice(0, 120)),
          message: isDoc ? `${r.msg}（出现在文档中，可能是示例）` : r.msg,
          source: 'program',
        });
      }
    }
    if (!isDoc && /\.[cm]?[jt]sx?$/.test(file)) {
      const model = sourceModel(text);
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
        const seen = new Set(findings.filter((finding) => finding.file === file).map((finding) => `${finding.line}|${finding.rule}`));
        for (const hit of localFlowFindings(model)) {
          const key = `${hit.line}|${hit.rule}`;
          if (seen.has(key)) continue; // 同一 file+line+rule 只报一次（正则与数据流不重复）
          const line = lines[hit.line - 1] || '';
          if (line.includes('finalcheck:allow')) continue;
          seen.add(key);
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
  }
  return { checkId: 'S2', findings, coverageGap: null, warnings };
}
