import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@babel/parser';
import { listTextFiles, readRel, prunedWarning } from '../walk.mjs';

// D1 事务 / D2 备份恢复 / D3 隐私（ACCEPTANCE §4-B）。
// 全是静态只读判定：不执行被审代码，不引入新依赖（@babel/parser 是既有依赖）。
// 启发式结论一律 force='check' 并在 message 写明「需人工确认」，绝不自动判死。

const CODE_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx)$/i;
const LOCK_RE = /package-lock|yarn\.lock|pnpm-lock/;
const DOC_RE = /\.(?:md|markdown|txt|rst|adoc)$/i;
const TEST_FILE_RE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:[\\/](?:tests?|__tests__)[\\/])/i;
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);
// 只认“像路由器”的调用对象，压掉 axios.get(url, cb) 一类误报（宁窄勿宽）
const ROUTER_OBJ_RE = /^(?:[A-Za-z_$][\w$]*)?(?:app|router|server|api)$/i;
const TRANSACTION_RE = /transaction|begintransaction|withtransaction/i;
const WRITE_METHOD_RE = /^(?:insert|update|delete)(?:One|Many|All)?$/i;
const SQL_WRITE_RE = /\b(?:insert|update|delete)\b/i;
const REQUEST_PARAM_RE = /^(?:req|request|ctx|context)$/i;

function isExcluded(rel, excludes) {
  const r = String(rel || '').replace(/\\/g, '/');
  return (Array.isArray(excludes) ? excludes : []).some((x) => {
    const n = String(x || '').replace(/\\/g, '/');
    return r === n || r.startsWith(n + '/');
  });
}

function prunedToWarnings(warnings, skipped, pruned, prefix) {
  if (skipped.length) warnings.push(`${prefix}：跳过大文件 ${skipped.length} 个（>512KB 未扫描）：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}`);
  const pw = prunedWarning(pruned);
  if (pw) warnings.push(`${prefix}：${pw}`);
}

/* ---------- AST helpers (D1) ---------- */

function walkAst(node, cb) {
  if (!node || typeof node.type !== 'string') return;
  cb(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' ||
        key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walkAst(c, cb);
    } else if (child && typeof child === 'object') {
      walkAst(child, cb);
    }
  }
}

function isFunctionNode(n) {
  return !!n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');
}

function memberName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  const p = node.property;
  if (p.type === 'Identifier') return p.name;
  if (p.type === 'StringLiteral') return p.value;
  return null;
}

function staticPathValue(n) {
  if (!n) return undefined;
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) {
    return n.quasis[0].value.cooked ?? n.quasis[0].value.raw;
  }
  return undefined;
}

function nodeLine(n) {
  return n && n.loc && n.loc.start ? n.loc.start.line : 0;
}

function sqlText(n) {
  if (!n) return '';
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' ? ');
  return '';
}

function isRouterRouteCall(node) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return false;
  const prop = memberName(node.callee);
  if (!prop || !ROUTE_METHODS.has(prop)) return false;
  const obj = node.callee.object;
  if (obj.type === 'Identifier') return ROUTER_OBJ_RE.test(obj.name);
  // 链式：router.route('/x').post(handler)
  return obj.type === 'CallExpression' && obj.callee.type === 'MemberExpression' && memberName(obj.callee) === 'route';
}

function routeLabel(node) {
  const method = memberName(node.callee).toUpperCase();
  const p = staticPathValue(node.arguments[0]);
  return p !== undefined ? `${method} ${p}` : `${method} (动态路径)`;
}

function hasRequestParams(fn) {
  return (fn.params || []).some((p) => p.type === 'Identifier' && REQUEST_PARAM_RE.test(p.name));
}

function collectWriteCalls(fnNode) {
  const lines = [];
  walkAst(fnNode.body, (n) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression') return;
    const prop = memberName(n.callee);
    if (!prop) return;
    if (WRITE_METHOD_RE.test(prop)) { lines.push(nodeLine(n)); return; }
    if (/^execute$/i.test(prop) && SQL_WRITE_RE.test(sqlText(n.arguments[0]))) lines.push(nodeLine(n));
  });
  return lines;
}

/**
 * 返回每个候选处理函数 { fn, line, label }：
 * 1) 路由声明里的处理函数（app/router/server/api 的 get/post/... 末参）；
 * 2) 带 req/request/ctx 参数的独立处理函数（供跨文件路由引用时兜底）。
 * 嵌套在已识别处理函数内部的函数不重复计入，避免同一段代码报两次。
 */
function findHandlerCandidates(ast) {
  // 先收集函数名（路由处理函数可能声明在路由调用之后），再解析路由声明。
  const functionsByName = new Map();
  walkAst(ast.program, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) functionsByName.set(n.id.name, n);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && isFunctionNode(n.init)) {
      functionsByName.set(n.id.name, n.init);
    }
  });
  const routeHandlers = [];
  walkAst(ast.program, (n) => {
    if (!isRouterRouteCall(n)) return;
    const args = n.arguments || [];
    const last = args[args.length - 1];
    let fn = null;
    if (isFunctionNode(last)) fn = last;
    else if (last && last.type === 'Identifier') fn = functionsByName.get(last.name) || null;
    if (fn) routeHandlers.push({ fn, line: nodeLine(n), label: routeLabel(n) });
  });

  const requestFns = [];
  walkAst(ast.program, (n) => {
    if (isFunctionNode(n) && hasRequestParams(n)) {
      const name = n.id && n.id.name ? `function ${n.id.name}` : 'function (匿名)';
      requestFns.push({ fn: n, line: nodeLine(n) || nodeLine(n.body), label: name });
    }
  });

  const kept = [];
  const routeRanges = routeHandlers.map((h) => ({ start: h.fn.start || 0, end: h.fn.end || 0 }));
  for (const h of routeHandlers) kept.push(h);
  for (const h of requestFns) {
    const start = h.fn.start || 0;
    const end = h.fn.end || 0;
    // 嵌套在路由处理函数内部，或反过来包住了路由声明的函数：外层/路由已覆盖，避免重复计数
    if (routeRanges.some((r) => start >= r.start && end <= r.end)) continue;
    if (routeRanges.some((r) => r.start >= start && r.end <= end)) continue;
    if (kept.some((k) => {
      const ks = k.fn.start || 0;
      const ke = k.fn.end || 0;
      return start >= ks && end <= ke;
    })) continue;
    kept.push(h);
  }
  return kept;
}

export async function checkData(projectDir, { tier, excludes = [] } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  const force = t === 'L1' ? 'tip' : 'check';
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes);
  prunedToWarnings(warnings, skipped, pruned, 'D1');
  let parseFailures = 0;

  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    if (!CODE_RE.test(file) || LOCK_RE.test(file)) continue;
    if (TRANSACTION_RE.test(text)) continue; // 文件级已有事务关键词：不报（spec 明确）
    let ast;
    try {
      ast = parse(text, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: ['jsx', 'typescript'],
      });
    } catch {
      parseFailures++;
      continue;
    }
    for (const h of findHandlerCandidates(ast)) {
      const writes = collectWriteCalls(h.fn);
      if (writes.length < 2) continue; // 同一次请求处理 ≥2 个写库调用才报
      const lines = text.split('\n');
      const allowLine = lines[(h.line || 1) - 1] || '';
      if (allowLine.includes('finalcheck:allow')) continue; // 行内豁免（人工已确认）
      if (writes.some((ln) => (lines[ln - 1] || '').includes('finalcheck:allow'))) continue;
      findings.push({
        checkId: 'D1',
        severity: 'medium',
        force,
        file,
        line: h.line || writes[0] || 0,
        rule: 'D1.write-possible-no-transaction',
        snippet: h.label,
        message: `同一次请求处理函数中出现 ${writes.length} 个写库调用（insert/update/delete 或 db.execute 写语句），文件内未见 transaction/beginTransaction/withTransaction——可能缺少事务，需人工确认`,
        source: 'program',
      });
    }
  }
  if (parseFailures) warnings.push(`D1：${parseFailures} 个代码文件解析失败，事务检查跳过这些文件`);
  return { checkId: 'D1', findings, coverageGap: null, warnings };
}

/* ---------- D2 备份/恢复 ---------- */

const BACKUP_NAME_RE = /backup|restore|dump/i;
const BACKUP_CONFIG_RE = /pg_dump|mysqldump|sqlite3[\s\S]{0,60}\.backup|\b(?:backup|restore)\b|备份|恢复/i;
const README_NAME_RE = /^readme(?:\.(?:md|markdown|txt))?$/i;
const README_BACKUP_LINE_RE = /^\s*(?:#{1,6}\s*)?(?:backup|restore|备份|恢复)\s*(?:[:\-—]|$)/im;
const CONFIG_LIKE_RE = /\.(?:yml|yaml|toml|ini|conf|cfg|sh|bash|ps1|bat|cmd|env)$/i;

async function hasBackupEvidence(projectDir, excludes) {
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes);
  const basenameOf = (rel) => String(rel).replace(/\\/g, '/').split('/').pop();
  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    const base = basenameOf(file);
    // 文件名即证据：backup.sh / restore-drill.md / dump.sql / backup.sqlite
    if (BACKUP_NAME_RE.test(base)) return { found: true, files, skipped, pruned };
    if (/\.sql$/i.test(base)) return { found: true, files, skipped, pruned };
    // README 的备份段落（标题或行首「Backup:」）
    if (README_NAME_RE.test(base) && README_BACKUP_LINE_RE.test(text)) return { found: true, files, skipped, pruned };
    // 配置里的备份机制（pg_dump / mysqldump / backup 关键词）
    if (CONFIG_LIKE_RE.test(file) && BACKUP_CONFIG_RE.test(text)) return { found: true, files, skipped, pruned };
  }
  return { found: false, files, skipped, pruned };
}

export async function checkBackup(projectDir, { tier, excludes = [] } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  const { found, skipped, pruned } = await hasBackupEvidence(projectDir, excludes);
  prunedToWarnings(warnings, skipped, pruned, 'D2');
  if (!found) {
    const force = t === 'L3' ? 'card' : 'tip'; // L3 才要求；L2/L1 仅提示
    findings.push({
      checkId: 'D2',
      severity: 'medium',
      force,
      file: '(全仓搜索)',
      line: 0,
      rule: 'D2.no-backup',
      snippet: '未发现 backup/restore/dump 文件、*.sql、备份配置或 README 备份段落',
      message: t === 'L3'
        ? '未发现备份/恢复脚本、备份配置或 README 备份段落（L3 要求）——请补备份脚本与调度配置'
        : '未发现备份/恢复脚本、备份配置或 README 备份段落（L2 仅提示；L3 将卡）',
      source: 'program',
    });
  }
  return { checkId: 'D2', findings, coverageGap: null, warnings };
}

/* ---------- D3 隐私 ---------- */

const LOG_CALL_RE = /\b(?:console\s*\.\s*(?:log|info|warn|error|debug|trace)|logger\s*\.\s*\w+|log\s*\.\s*(?:info|warn|error|debug|trace))\s*\(/i;
const SENSITIVE_FIELD_RE = /\b(?:email|e-mail|phone|mobile|password|passwd|pwd|token|idcard|id_card|idnumber)\b/i;
const USER_DATA_RE = /\b(?:user|users|customer|account|profile|email|phone|mobile|password|idcard|id_card)\b/i;
const PERSIST_CALL_RE = /\b(?:save|create|insert|upsert|setItem|writeFile|writeFileSync|store|persist)\s*\(|\.\s*(?:save|create|insert|upsert|setItem|writeFile|writeFileSync|store|persist)\s*\(/i;
// SQL 落盘：ORM 之外的 schema/migration/原生 SQL 也要算「用户数据落盘」
const SQL_PERSIST_RE = /\b(?:insert\s+into|update\s+[A-Za-z_][\w.]*\s+set|create\s+table)\b/i;
const RETENTION_RE = /retention|retain|erase|purge|anonymi[sz]e|cleanup|clean[_-]?up|delete|数据保留|保留期|删除|清理|匿名化/i;

// 去掉字符串字面量，只留下“可能是变量”的代码部分；模板串保留 ${...} 里的表达式
function stripStringLiterals(s) {
  const templates = [];
  let out = s.replace(/`(?:\\.|[^`\\])*`/g, (m) => {
    const exprs = [...m.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]);
    templates.push(...exprs);
    return ' __TPL__ ';
  });
  out = out.replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  return `${out} ${templates.join(' ')}`;
}

function sanitizeSnippet(raw) {
  return String(raw).trim().slice(0, 120);
}

async function scanPrivacy(projectDir, excludes) {
  const logFindings = [];
  const warnings = [];
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes);
  prunedToWarnings(warnings, skipped, pruned, 'D3');
  let persisted = null; // { file, line, snippet }
  let retentionSeen = false;

  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    const isDoc = DOC_RE.test(file);
    const isLock = LOCK_RE.test(file);
    if (retentionSeen === false && !isLock && RETENTION_RE.test(text)) retentionSeen = true;

    if (isDoc || isLock) continue; // 日志与落盘判定只看代码/配置文本
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 1000) continue; // 压缩代码
      if (line.includes('finalcheck:allow')) continue;

      // 日志直接打印敏感字段（敏感词必须落在非字符串参数里）
      const log = LOG_CALL_RE.exec(line);
      if (log) {
        const args = stripStringLiterals(line.slice(log.index + log[0].length));
        if (SENSITIVE_FIELD_RE.test(args)) {
          logFindings.push({
            checkId: 'D3',
            severity: 'medium',
            force: 'check',
            file,
            line: i + 1,
            rule: 'D3.log-sensitive-field',
            snippet: sanitizeSnippet(line),
            message: '日志直接打印 email/phone/password/token/idCard 等敏感字段——请脱敏或删除该日志；若已脱敏请加 finalcheck:allow，需人工确认',
            source: 'program',
          });
          continue;
        }
      }

      // 用户数据落盘证据（同一行既有用户数据特征又有持久化调用/SQL 写语句）
      if (!persisted && !TEST_FILE_RE.test(file) && USER_DATA_RE.test(line) &&
          (PERSIST_CALL_RE.test(line) || SQL_PERSIST_RE.test(line))) {
        persisted = { file, line: i + 1, snippet: sanitizeSnippet(line) };
      }
    }
  }
  return { logFindings, warnings, persisted, retentionSeen };
}

export async function checkPrivacy(projectDir, { tier, excludes = [] } = {}) {
  const t = String(tier || 'L2').toUpperCase();
  const { logFindings, warnings, persisted, retentionSeen } = await scanPrivacy(projectDir, excludes);
  const findings = logFindings.map((f) => ({ ...f, force: t === 'L1' ? 'tip' : 'check' }));
  if (persisted && !retentionSeen) {
    findings.push({
      checkId: 'D3',
      severity: 'low',
      force: t === 'L1' ? 'tip' : 'check',
      file: persisted.file,
      line: persisted.line,
      rule: 'D3.no-retention-policy',
      snippet: persisted.snippet,
      message: '检测到用户数据落盘（用户/邮箱/手机号等持久化调用），但全仓未见 retention/delete 等数据保留或删除策略——未见数据保留策略，需人工确认',
      source: 'program',
    });
  }
  return { checkId: 'D3', findings, coverageGap: null, warnings };
}
