import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@babel/parser';
import { listTextFiles, readRel, prunedWarning } from '../walk.mjs';
import { sourceModel, walkSource, memberName as sourceMemberName } from '../source-analysis.mjs';

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

export async function checkData(projectDir, { tier, excludes = [], includeFixtures = false } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  const force = t === 'L1' ? 'tip' : 'check';
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes, { includeFixtures });
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

/* ---------- D2 备份/恢复 ----------
 *
 * 证据分两级，只有 card 级实锤才允许判过：
 *   card 级（可执行证据）：
 *     - 备份命令：pg_dump / mysqldump / sqlite3 .backup / mongodump / rsync（需备份上下文）/ restic / borg
 *       出现在脚本、配置或自动化文件中（文档里的命令示例不算）；
 *     - 调度真配置：cron / systemd timer / Windows 计划任务 / CI schedule，且同一文件引用备份脚本或备份配置；
 *     - 含保留期（retention/prune/keep）的显式备份配置项。
 *   check 级（线索，不给过）：README 仅声明、文件名含 backup/dump、单独存在的 *.sql、只出现 backup 一词。
 * README 声明 ≠ 可执行证据：记 coverageGap/unverified（「未验证（仅文档声明）」）。
 */

const README_NAME_RE = /^readme(?:\.(?:md|markdown|txt))?$/i;
const README_BACKUP_LINE_RE = /^\s*(?:#{1,6}\s*)?(?:backup|restore|备份|恢复)\s*(?:[:\-—]|$)/im;
const BACKUP_NAME_RE = /\b(?:backup|dump)\b|备份|数据库备份/i;
const RESTORE_NAME_RE = /restore|recovery|drill|恢复|演练/i;
// 只认强备份词，不认单独的 restore/恢复、也不认 snapshot/快照：
// session-restore 与「工作流快照」都是会话状态恢复，不是数据库/文件备份证据。
const BACKUP_TERMS_RE = /\b(?:backup|dump|archive)\b|备份|归档/i;
const RETENTION_RE = /\b(?:retention|retain|keep|prune|expire|rotate)\b|max[-_]?(?:age|count|backups)|保留期|保留天数|过期|轮转/i;
// 调度必须像「真调度配置」：cron 五段式 / @daily / systemd OnCalendar / schtasks / K8s CronJob / schedule: 键。
// 不收裸词 cron/systemd/timer —— 否则本检查源码里的说明文字会被自己当成调度证据。
const SCHEDULE_RE = /@(?:daily|weekly|monthly|hourly|yearly|reboot)\b|\bOnCalendar=|\bOnBootSec=|\bschtasks\b|\bTask\s+Scheduler\b|\bkind\s*:\s*CronJob\b|^\s*schedule\s*:|^\s*(?:[\d*/-]+\s+){4}[\d*/-]+\s+\S|\bcrontab\b/i;
const DOC_FILE_RE = /\.(?:md|markdown|txt|rst|adoc)$/i;
// 「显式备份配置项（含保留期）」只认配置文件，不认普通源码里恰好出现 backup/retention 变量。
const BACKUP_CONFIG_FILE_RE = /\.(?:json|ya?ml|toml|ini|conf|cfg|env)$/i;
const D2_SPECIAL_FILE_RE = /^(?:Dockerfile|Makefile|Procfile|Jenkinsfile|crontab|Vagrantfile)$/i;
const BACKUP_COMMANDS = [
  { id: 'pg_dump', re: /\bpg_dump(?:all)?\b/i },
  { id: 'mysqldump', re: /\b(?:mysqldump|mariadb-dump)\b/i },
  { id: 'mongodump', re: /\bmongodump\b/i },
  { id: 'sqlite-backup', re: /\bsqlite3\b[^\n]{0,120}\.backup\b/i },
  { id: 'rsync', re: /\brsync\b/i },
  { id: 'restic', re: /\brestic\b/i },
  { id: 'borg', re: /\bborg(?:matic)?\b/i },
];
const D2_TEXT_EXT_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|markdown|yml|yaml|txt|py|php|sh|bash|zsh|sql|cfg|conf|ini|toml|ps1|bat|cmd|xml|service|timer|rst|adoc)$/i;
const D2_SKIP_DIRS = new Set(['node_modules', '.git', '.finalcheck', 'workflow-runs', 'coverage', '.next', 'vendor']);
const D2_BUILD_DIR_RE = /^(?:[A-Za-z0-9._-]+-unpacked|release-[A-Za-z0-9._-]+|dist-[A-Za-z0-9._-]+)$/i;
const D2_BUILD_DIRS = new Set(['release', 'out', 'dist', 'build']);

// D2 需要比通用 walker 更宽的文本类型（.service/.timer/Task Scheduler XML/ps1），
// 但只在本检查内生效，不改变其它检查的扫描面。
async function listBackupCandidates(projectDir, excludes, includeFixtures) {
  const files = [];
  const skipped = [];
  const pruned = [];
  const excluded = (rel) => excludes.some((x) => {
    const n = String(x).replace(/\\/g, '/');
    return rel === n || rel.startsWith(n + '/');
  });
  async function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(projectDir, p).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (excluded(rel)) continue;
        // .github 例外：CI schedule（cron）是备份调度的合法证据位
        if (e.name.startsWith('.') && e.name.toLowerCase() !== '.github') continue;
        if (D2_SKIP_DIRS.has(e.name.toLowerCase())) continue;
        if (!includeFixtures && e.name.toLowerCase() === 'fixtures') continue;
        if (D2_BUILD_DIRS.has(e.name.toLowerCase()) || D2_BUILD_DIR_RE.test(e.name)) { pruned.push(rel); continue; }
        await walk(p, depth + 1);
        continue;
      }
      if (e.name.startsWith('.')) continue;
      if (!D2_SPECIAL_FILE_RE.test(e.name) && !D2_TEXT_EXT_RE.test(e.name)) continue;
      if (excluded(rel)) continue;
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      if (st.size > 512 * 1024) { skipped.push(rel); continue; }
      files.push(p);
    }
  }
  await walk(projectDir, 0);
  return { files, skipped, pruned };
}

function isCommentLine(trimmed) {
  return /^(?:#|\/\/|--|\*|<!--|;)/.test(trimmed);
}

// 正则/模式源码里的命令名不是可执行命令（例：本检查自己的 BACKUP_COMMANDS 常量）。
// 与 S3 的「正则源码不算密钥」同一思路，避免 D2 自食。
function looksLikePatternSource(line) {
  return /\(\?:|\\[bBsSwWdDaAzZ]|\bRegExp\b/.test(line);
}

// 单文件证据判定：返回 { level:'hard'|'clue', kind, file, line, detail } 或 null。
function backupEvidenceOf(file, text) {
  const base = String(file).replace(/\\/g, '/').split('/').pop();
  const isDoc = DOC_FILE_RE.test(file) || README_NAME_RE.test(base);
  const isSql = /\.sql$/i.test(base);
  const nameSaysBackup = BACKUP_NAME_RE.test(base);
  const nameSaysRestore = RESTORE_NAME_RE.test(base);
  const backupContext = BACKUP_TERMS_RE.test(text) || nameSaysBackup;

  // 文档永远不能当实锤：README/文档里的命令示例仍是 check 级线索。
  if (isDoc) {
    // README 里任何备份声明（标题、行首「Backup:」或正文提及）都只是文档线索，永远不能判过。
    if (README_NAME_RE.test(base) && (README_BACKUP_LINE_RE.test(text) || BACKUP_TERMS_RE.test(text))) {
      return { level: 'clue', kind: 'doc-claim', file, line: 1, detail: 'README 备份段落' };
    }
    if (nameSaysBackup || nameSaysRestore) {
      return { level: 'clue', kind: 'doc-claim', file, line: 1, detail: '备份/恢复文档' };
    }
    return null;
  }

  const lines = text.split('\n');
  let command = null;
  let schedule = null;
  let retentionLine = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000) continue;
    const trimmed = line.trim();
    if (isCommentLine(trimmed)) continue; // 注释里的命令不是可执行证据
    if (looksLikePatternSource(line)) continue; // 正则/模式定义不是命令或调度
    if (!schedule && SCHEDULE_RE.test(line)) {
      schedule = { line: i + 1, snippet: trimmed.slice(0, 120) };
    }
    // 保留期可以写在配置的下一行（backup:\n  retention: 30d），所以按文件级上下文配对。
    if (!retentionLine && RETENTION_RE.test(line)) {
      retentionLine = { line: i + 1, snippet: trimmed.slice(0, 120) };
    }
    for (const cmd of BACKUP_COMMANDS) {
      if (!cmd.re.test(line)) continue;
      // rsync 只在与备份上下文/备份文件名同现时才算备份（否则多半是部署同步）
      if (cmd.id === 'rsync' && !(BACKUP_TERMS_RE.test(line) || nameSaysBackup)) continue;
      command = { id: cmd.id, line: i + 1, snippet: trimmed.slice(0, 120) };
      break;
    }
  }

  if (command) {
    return { level: 'hard', kind: 'command', file, line: command.line, scheduled: Boolean(schedule && backupContext), detail: `备份命令 ${command.id}` };
  }
  // 调度真配置 + 备份引用（如 crontab 指向 backup.sh、systemd timer 的 OnCalendar）
  if (schedule && (backupContext || retentionLine)) {
    return { level: 'hard', kind: 'schedule', file, line: schedule.line, detail: `调度配置（${schedule.snippet}）` };
  }
  // 显式备份配置项（含保留期）：如 backup: { retention: 30d }
  if (backupContext && retentionLine && (BACKUP_CONFIG_FILE_RE.test(file) || D2_SPECIAL_FILE_RE.test(base))) {
    return { level: 'hard', kind: 'config-retention', file, line: retentionLine.line, detail: '含保留期的备份配置' };
  }

  // 线索：只说明「看起来像备份」，不能证明可执行、可调度、可恢复。
  if (isSql) return { level: 'clue', kind: 'sql-file', file, line: 1, detail: '仅存在 .sql 文件' };
  if (nameSaysBackup) return { level: 'clue', kind: 'filename', file, line: 1, detail: '文件名含 backup/dump' };
  if (nameSaysRestore && BACKUP_TERMS_RE.test(text)) return { level: 'clue', kind: 'filename', file, line: 1, detail: '文件名含 restore 且正文提到备份' };
  // 只有配置项里的「backup」才算声明线索；普通源码里出现 backup 变量/文案不算备份声明。
  if (BACKUP_CONFIG_FILE_RE.test(file) && BACKUP_TERMS_RE.test(text)) {
    return { level: 'clue', kind: 'mention', file, line: 1, detail: '仅正文提及备份' };
  }
  return null;
}

async function findBackupEvidence(projectDir, excludes, includeFixtures) {
  const { files, skipped, pruned } = await listBackupCandidates(projectDir, excludes, includeFixtures);
  const evidenceList = [];
  let restoreConfirmed = false;
  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    const ev = backupEvidenceOf(file, text);
    if (ev) evidenceList.push(ev);
    if (file === 'finalcheck.evidence.json') {
      try {
        const confirmation = JSON.parse(text).backupRestore;
        const age = Date.now() - Date.parse(confirmation?.checkedAt);
        const report = String(confirmation?.evidence || '').replace(/\\/g, '/');
        restoreConfirmed = confirmation?.status === 'confirmed' && typeof confirmation.reviewer === 'string' && Boolean(confirmation.reviewer.trim())
          && age >= -300000 && age <= 90 * 86400000 && Boolean(report)
          && files.some((candidate) => path.relative(projectDir, candidate).replace(/\\/g, '/') === report);
      } catch { /* 缺少有效人工确认仍为未验证。 */ }
    }
  }
  return { evidence: evidenceList.find((ev) => ev.level === 'hard') || evidenceList[0], evidenceList, restoreConfirmed, skipped, pruned };
}

async function checkBackupImpl(projectDir, { tier, excludes = [], includeFixtures = false } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  const { evidence, evidenceList, restoreConfirmed, skipped, pruned } = await findBackupEvidence(projectDir, excludes, includeFixtures);
  prunedToWarnings(warnings, skipped, pruned, 'D2');
  if (evidence?.level === 'hard') {
    warnings.push(`D2：已发现静态备份配置线索：${evidence.file}${evidence.line ? ':' + evidence.line : ''}（${evidence.detail}）；未执行备份或恢复`);
    if (t === 'L3') {
      const missing = [];
      if (!evidenceList.some((ev) => ev.kind === 'command')) missing.push(['command-missing', '未发现可执行备份命令']);
      if (!evidenceList.some((ev) => ev.kind === 'schedule' || ev.scheduled)) missing.push(['schedule-missing', '未发现与备份关联的真实调度配置']);
      if (!restoreConfirmed) missing.push(['restore-unverified', '恢复演练未获有效人工确认（finalcheck.evidence.json 需记录近 90 天的确认人与仓内演练记录）']);
      for (const [rule, message] of missing) findings.push({ checkId: 'D2', severity: 'medium', force: 'card', file: evidence.file, line: evidence.line || 0,
        rule: `D2.${rule}`, snippet: evidence.detail, message: `${message}（L3 要求），需补齐证据`, source: 'program' });
      if (restoreConfirmed) warnings.push('D2：恢复演练采用人工确认记录；程序未自动验证演练内容或执行恢复');
    }
    return { checkId: 'D2', findings, coverageGap: null, warnings };
  }
  if (evidence?.level === 'clue') {
    const force = t === 'L1' ? 'tip' : 'check';
    findings.push({
      checkId: 'D2',
      severity: 'medium',
      force,
      file: evidence.file,
      line: evidence.line || 0,
      rule: 'D2.backup-unverified',
      snippet: evidence.detail,
      message: `仅发现 check 级备份线索（${evidence.detail}）——未发现可执行备份脚本/调度（cron/systemd timer/计划任务）或含保留期的备份配置，未验证（${evidence.kind === 'doc-claim' ? '仅文档声明' : '仅线索'}），需人工确认`,
      source: 'program',
    });
    return {
      checkId: 'D2',
      findings,
      coverageGap: `未发现可执行备份证据（${evidence.detail}，check 级线索），未验证（${evidence.kind === 'doc-claim' ? '仅文档声明' : '仅线索'}）`,
      warnings,
    };
  }
  const force = t === 'L3' ? 'card' : 'tip'; // L3 才要求；L2/L1 仅提示
  findings.push({
    checkId: 'D2',
    severity: 'medium',
    force,
    file: '(全仓搜索)',
    line: 0,
    rule: 'D2.no-backup',
    snippet: '未发现备份命令、调度配置、含保留期的备份配置或 README 备份段落',
    message: t === 'L3'
      ? '未发现可执行备份证据（备份命令、cron/systemd timer/计划任务调度、或含保留期的备份配置）（L3 要求）——请补备份脚本与调度配置'
      : '未发现可执行备份证据（L2 仅提示；L3 将卡）',
    source: 'program',
  });
  return { checkId: 'D2', findings, coverageGap: null, warnings };
}

export async function checkBackup(projectDir, opts = {}) {
  return checkBackupImpl(projectDir, opts);
}

/* ---------- D3 隐私 ---------- */

const LOG_CALL_RE = /\b(?:console\s*\.\s*(?:log|info|warn|error|debug|trace)|logger\s*\.\s*\w+|log\s*\.\s*(?:info|warn|error|debug|trace))\s*\(/i;
const SENSITIVE_FIELD_RE = /\b(?:email|e-mail|phone|mobile|password|passwd|pwd|token|idcard|id_card|idnumber)\b/i;
const USER_DATA_RE = /\b(?:user|users|customer|account|profile|email|phone|mobile|password|idcard|id_card)\b/i;
const PERSIST_CALL_RE = /\b(?:save|create|insert|upsert|setItem|writeFile|writeFileSync|store|persist)\s*\(|\.\s*(?:save|create|insert|upsert|setItem|writeFile|writeFileSync|store|persist)\s*\(/i;
// SQL 落盘：ORM 之外的 schema/migration/原生 SQL 也要算「用户数据落盘」
const SQL_PERSIST_RE = /\b(?:insert\s+into|update\s+[A-Za-z_][\w.]*\s+set|create\s+table)\b/i;
const D3_RETENTION_RE = /retention|retain|erase|purge|anonymi[sz]e|cleanup|clean[_-]?up|delete|数据保留|保留期|删除|清理|匿名化/i;

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

async function scanPrivacy(projectDir, excludes, includeFixtures) {
  const logFindings = [];
  const warnings = [];
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes, { includeFixtures });
  prunedToWarnings(warnings, skipped, pruned, 'D3');
  let persisted = null; // { file, line, snippet }
  let retentionSeen = false;
  const observed = new Map();
  const declarations = [];

  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    const isDoc = DOC_RE.test(file);
    const isLock = LOCK_RE.test(file);
    if (retentionSeen === false && !isLock && D3_RETENTION_RE.test(text)) retentionSeen = true;

    if (isDoc && /privacy|隐私/i.test(file)) declarations.push({ file, text });
    if (isDoc || isLock) continue; // 日志与落盘判定只看代码/配置文本
    const lines = text.split('\n');
    if (CODE_RE.test(file) && !TEST_FILE_RE.test(file)) {
      const model = sourceModel(text);
      if (model) walkSource(model.ast, (node) => {
        if (node.type !== 'CallExpression' || !/^(?:save|create|insert|insertOne|insertMany|upsert|update|updateOne|setItem|writeFile|writeFileSync|store|persist)$/.test(sourceMemberName(node.callee) || node.callee?.name || '')) return;
        if ((lines[(node.loc?.start.line || 1) - 1] || '').includes('finalcheck:allow')) return;
        const collect = (raw, seen = new Set()) => {
          const value = model.resolve(raw);
          if (!value || seen.has(value)) return;
          seen.add(value);
          if (value.type === 'ArrayExpression') { for (const item of value.elements) collect(item, seen); return; }
          if (value.type !== 'ObjectExpression') return;
          for (const prop of value.properties) {
            const field = prop.type === 'ObjectProperty' && !prop.computed ? String(prop.key.name ?? prop.key.value).toLowerCase() : '';
            if (/^(?:email|phone|mobile|password|idcard|id_card|address|full_name|fullname)$/.test(field)) {
              observed.set(field, { file, line: prop.loc?.start.line || 0 });
              persisted ||= { file, line: prop.loc?.start.line || 0, snippet: field };
            }
            if (prop.value) collect(prop.value, seen);
          }
        };
        for (const arg of node.arguments) collect(arg);
      });
    }
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
  return { logFindings, warnings, persisted, retentionSeen, observed, declarations };
}

export async function checkPrivacy(projectDir, { tier, excludes = [], includeFixtures = false } = {}) {
  const t = String(tier || 'L2').toUpperCase();
  const { logFindings, warnings, persisted, retentionSeen, observed, declarations } = await scanPrivacy(projectDir, excludes, includeFixtures);
  const findings = logFindings.map((f) => ({ ...f, force: t === 'L1' ? 'tip' : 'check' }));
  let coverageGap = null;
  if (persisted || observed.size) {
    let declared = null;
    try {
      if (excludes.some((x) => String(x).replace(/\\/g, '/') === 'finalcheck.privacy.json')) throw new Error('excluded');
      const config = JSON.parse((await readRel(projectDir, path.join(projectDir, 'finalcheck.privacy.json'))).text);
      if (!Array.isArray(config.collectedFields) || !config.collectedFields.every((field) => typeof field === 'string' && /^[a-z][a-z0-9_]*$/i.test(field))) throw new Error('invalid fields');
      declared = new Set(config.collectedFields.map((field) => field.toLowerCase()));
    } catch { coverageGap = '检测到用户数据持久化，但没有有效 finalcheck.privacy.json 的 collectedFields 声明，字段对账未验证（自然语言声明不自动算通过）'; }
    const add = (rule, field, location, message) => findings.push({ checkId: 'D3', severity: 'medium', force: t === 'L1' ? 'tip' : 'check', file: location.file, line: location.line || 0,
      rule: `D3.${rule}`, snippet: field, message, source: 'program' });
    if (declared) {
      for (const [field, location] of observed) if (!declared.has(field)) add('undeclared-field', field, location, `持久化字段 ${field} 未列入 collectedFields 隐私声明，需人工确认并对齐声明与实现`);
      for (const field of declared) if (!observed.has(field)) add('declared-field-unverified', field, { file: 'finalcheck.privacy.json' }, `声明字段 ${field} 未在已覆盖的持久化对象中找到，可能使用了不支持的写法，需人工核实`);
      if (!observed.size) coverageGap = '用户数据持久化已发现，但未能提取受支持的静态字段，字段对账未完全覆盖';
    }
    for (const [field, location] of observed) for (const declaration of declarations) {
      if (new RegExp(`(?:do not collect|never collect|collect no|不收集)[^\\n.]{0,120}\\b${field}\\b`, 'i').test(declaration.text)) {
        add('declaration-conflict', field, location, `持久化字段 ${field} 与 ${declaration.file} 的不收集声明冲突，需人工核实`);
      }
    }
  }
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
  return { checkId: 'D3', findings, coverageGap, warnings };
}
