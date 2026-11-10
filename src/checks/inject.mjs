import { listTextFiles, readRel, prunedWarning } from '../walk.mjs';

// S2 注入类（ACCEPTANCE §4-A）：SQLi / eval / 命令注入 / 路径穿越 / SSRF / 反射 XSS。
// 正则只认“调用形态”（自食教训：扫描器源码里的正则字面量若含裸词会被自咬，
// 参照 tiers.mjs 的做法，模式必须带括号调用且各行不同时凑齐触发组合）。
// 单行 >1000 字符按压缩/第三方代码跳过并入 warnings；行内 `finalcheck:allow` 豁免；
// 文档(.md/.txt)命中降为提醒级线索（同 secrets.mjs：文档示例不算实锤）。

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

const RULES = [
  { rule: 'S2.sqli-concat', msg: '疑似 SQL 注入：查询调用以字符串拼接（加号或模板插值）构造 SQL——改用参数化查询（占位符 ? 或 $1）', hit: (l) => RE_SQL_CALL.test(l) && RE_SQL_KW.test(l) && RE_CONCAT.test(l) },
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

export async function checkInject(projectDir, { tier, excludes = [], routeResult = null } = {}) {
  void routeResult; // S2 不消费路由表；参数仅为与接线契约一致
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  const force = t === 'L1' ? 'check' : 'card'; // 矩阵：L1 查 / L2 卡 / L3 卡
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes);
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
  }
  return { checkId: 'S2', findings, coverageGap: null, warnings };
}
