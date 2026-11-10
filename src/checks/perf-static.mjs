import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@babel/parser';
import { t } from '../../desktop/src/renderer/i18n/core.mjs';

// Q5 静态性能反模式（L2 查 / L3 卡）：纯静态、不执行被审代码、不装新依赖。
// 规则：请求路径同步 IO / 循环内 await / 疑似 N+1 / 无上限查询 / SELECT * /
//       JSON 深拷贝 / 阻塞式密钥派生。
// 文案全部走 t()：中文模式原样返回，英文词典由主会话补；代码片段不翻译。
// 启发式结论一律 force='check'（提醒级线索），只有「请求路径里的阻塞调用」在 L3 才升 card。
const CHECK_ID = 'Q5';
const CODE_RE = /\.(?:ts|js|mjs|cjs|jsx|tsx)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'coverage', '.next']);
const MAX_FILES = 500;
const MAX_BYTES = 1024 * 1024;
const DEPTH_LIMIT = 12;
const MAX_FINDINGS_PER_RULE = 20;
const SNIPPET_LIMIT = 120;

const HOT_PATH_RE = /(?:handle|route|controller|api)/i;
const SYNC_IO = new Set(['readFileSync', 'writeFileSync', 'execSync', 'spawnSync']);
const SYNC_CRYPTO = new Set(['pbkdf2Sync', 'scryptSync']);
const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use', 'head', 'options']);
const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
const UNBOUNDED_ORM_METHODS = new Set(['find', 'findMany', 'findAll']);
const BOUNDED_CHAIN = /^(?:take|limit|first|firstOrFail|takeFirst|slice|head|findOrFail|findUnique)$/i;
const BOUNDED_ARGS = /^(?:take|limit|first|takeFirst)$/i;
const SQL_SELECT_RE = /\bselect\b[\s\S]*\bfrom\b/i;
const SQL_LIMIT_RE = /\blimit\b/i;
const SQL_STAR_RE = /\bselect\s+(?:distinct\s+)?\*/i;
const SKIP_AST_KEYS = new Set([
  'loc', 'start', 'end', 'range', 'extra', 'comments', 'tokens', 'errors',
  'leadingComments', 'trailingComments', 'innerComments',
]);

const isFunctionNode = (n) => !!n && (
  n.type === 'FunctionDeclaration'
  || n.type === 'FunctionExpression'
  || n.type === 'ArrowFunctionExpression'
  || n.type === 'ObjectMethod'
  || n.type === 'ClassMethod'
  || n.type === 'ClassPrivateMethod'
);

function memberName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  const p = node.property;
  if (!p) return null;
  if (p.type === 'Identifier') return p.name;
  if (p.type === 'StringLiteral') return p.value;
  return null;
}

function rootIdentifier(node) {
  let n = node;
  while (n && n.type === 'MemberExpression') n = n.object;
  return n && n.type === 'Identifier' ? n.name : null;
}

// `.find()` 在数组上是纯内存操作（Array.prototype.find），在 ORM 上才是查询。
// 只按接收者形状判断：db/prisma/repo 等命名，或首字母大写的模型（User.find）。
const DB_RECEIVER_RE = /^(?:db|database|prisma|knex|sequelize|mongoose|model|models|repo|repository|store|orm|client|tx|trx|conn|connection|pool|sql)$/i;
function isDbLikeReceiver(node) {
  if (!node) return false;
  if (node.type === 'CallExpression') {
    // getRepo().find() / db()...；不接受 [...arr].reverse() 这类数组链
    const name = node.callee?.type === 'Identifier' ? node.callee.name : rootIdentifier(node.callee);
    return !!name && (DB_RECEIVER_RE.test(name) || /^[A-Z]/.test(name));
  }
  if (node.type === 'Identifier') return DB_RECEIVER_RE.test(node.name) || /^[A-Z]/.test(node.name);
  if (node.type === 'MemberExpression') {
    const root = rootIdentifier(node);
    return !!root && (DB_RECEIVER_RE.test(root) || /^[A-Z]/.test(root));
  }
  return false;
}

// 前序遍历，第二个参数是「当前节点的祖先栈」，避免每个节点复制一份路径
function walkAst(node, cb) {
  const stack = [];
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    cb(n, stack);
    stack.push(n);
    for (const key of Object.keys(n)) {
      if (SKIP_AST_KEYS.has(key)) continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c);
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    }
    stack.pop();
  };
  visit(node);
}

function someNode(root, predicate) {
  let hit = false;
  const visit = (n) => {
    if (hit || !n || typeof n.type !== 'string') return;
    if (predicate(n)) { hit = true; return; }
    for (const key of Object.keys(n)) {
      if (SKIP_AST_KEYS.has(key)) continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c);
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    }
  };
  visit(root);
  return hit;
}

function parseSource(text) {
  const base = {
    sourceType: 'unambiguous',
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  };
  const attempts = [
    { ...base, plugins: ['jsx', 'typescript'] },
    { ...base, plugins: ['typescript'] },
    { ...base, plugins: ['jsx'] },
    { ...base, plugins: [] },
  ];
  let lastError = null;
  for (const options of attempts) {
    try { return parse(text, options); } catch (e) { lastError = e; }
  }
  throw lastError || new Error('parse failed');
}

async function collectSourceFiles(root, excludes) {
  const files = [];
  const skipped = [];
  let overLimit = false;
  const excluded = (rel) => excludes.some((x) => {
    const n = String(x).replace(/\\/g, '/');
    return rel === n || rel.startsWith(n + '/');
  });

  async function walk(dir, depth) {
    if (overLimit || depth > DEPTH_LIMIT) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (overLimit) return;
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
        if (e.name.startsWith('.')) continue;
        if (excluded(rel)) continue;
        await walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile() || !CODE_RE.test(e.name)) continue;
      if (excluded(rel)) continue;
      // 恰好吃满上限不报警；只有真的要扫第 501 个才记为覆盖不足
      if (files.length >= MAX_FILES) { overLimit = true; return; }
      const st = await stat(abs).catch(() => null);
      if (!st) continue;
      if (st.size > MAX_BYTES) { skipped.push(rel); continue; }
      files.push(abs);
    }
  }
  await walk(root, 0);
  return { files, skipped, overLimit };
}

function functionNameMap(ast) {
  const names = new WeakMap();
  const assignName = (left) => {
    if (!left) return null;
    if (left.type === 'Identifier') return left.name;
    if (left.type === 'MemberExpression') return memberName(left);
    return null;
  };
  walkAst(ast.program, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) {
      names.set(n, n.id.name);
      return;
    }
    if ((n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && n.id) {
      names.set(n, n.id.name);
      return;
    }
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && isFunctionNode(n.init)) {
      names.set(n.init, n.id.name);
      return;
    }
    if ((n.type === 'ObjectMethod' || n.type === 'ClassMethod' || n.type === 'ClassPrivateMethod')) {
      const key = n.key?.name ?? n.key?.value;
      if (key != null) names.set(n, String(key));
      return;
    }
    if (n.type === 'AssignmentExpression' && isFunctionNode(n.right)) {
      const name = assignName(n.left);
      if (name) names.set(n.right, name);
    }
  });
  return names;
}

// 热路径判定：文件/函数名像 handler/route/controller/api，或函数作为 app.get(...) 的处理函数
function isHotPath(node, stack, relFile, fnNames) {
  if (HOT_PATH_RE.test(relFile)) return true;
  for (let i = stack.length - 1; i >= 0; i--) {
    const anc = stack[i];
    if (!isFunctionNode(anc)) continue;
    const name = fnNames.get(anc);
    if (name && HOT_PATH_RE.test(name)) return true;
    const parent = stack[i - 1];
    if (!parent || parent.type !== 'CallExpression') continue;
    if (!(parent.arguments || []).includes(anc)) continue;
    if (parent.callee?.type !== 'MemberExpression') continue;
    const verb = memberName(parent.callee);
    if (verb && HTTP_VERBS.has(verb.toLowerCase())) return true;
  }
  return false;
}

function sqlTextOf(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') {
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' ? ');
  }
  return null;
}

function loopScaleLooksDataDriven(node) {
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
    const right = node.right;
    if (!right) return false;
    return right.type === 'Identifier'
      || right.type === 'MemberExpression'
      || right.type === 'CallExpression'
      || right.type === 'AwaitExpression';
  }
  // 定长 for (let i = 0; i < 10; i++) / while (true) 不报；只认由数据规模决定的循环条件
  return someNode(node.test, (n) => (
    (n.type === 'MemberExpression' && memberName(n) === 'length')
    || (n.type === 'CallExpression'
      && n.callee?.type === 'MemberExpression'
      && ['entries', 'keys', 'values'].includes(memberName(n.callee)))
  ));
}

// 循环体里的 await：嵌套函数内部的 await 属于那个函数，不算循环串行
function hasTopLevelAwaitInLoopBody(body) {
  let found = false;
  const visit = (n) => {
    if (found || !n || typeof n.type !== 'string') return;
    if (isFunctionNode(n)) return;
    if (n.type === 'AwaitExpression') { found = true; return; }
    for (const key of Object.keys(n)) {
      if (SKIP_AST_KEYS.has(key)) continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c);
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    }
  };
  visit(body);
  return found;
}

// 在循环体里找一次 IO 调用；内层循环的调用归内层循环报，避免同一处重复
function findLoopIoCall(body) {
  let hit = null;
  const visit = (n) => {
    if (hit || !n || typeof n.type !== 'string') return;
    if (n !== body && LOOP_TYPES.has(n.type)) return;
    if (n.type === 'CallExpression') {
      const label = ioCallName(n);
      if (label) { hit = { node: n, label }; return; }
    }
    for (const key of Object.keys(n)) {
      if (SKIP_AST_KEYS.has(key)) continue;
      const child = n[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c);
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    }
  };
  visit(body);
  return hit;
}

function ioCallName(node) {
  if (node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (callee.type === 'MemberExpression') {
    const prop = memberName(callee);
    if (!prop) return null;
    if (/^(query|findOne|findAll|findMany|fetch)$/i.test(prop)) return prop;
    // Array.prototype.find 不算 IO；只认 db/model 形态的接收者
    if (/^find$/i.test(prop)) return isDbLikeReceiver(callee.object) ? prop : null;
    if (/^(all|get|run)$/i.test(prop)
      && callee.object?.type === 'CallExpression'
      && memberName(callee.object.callee) === 'prepare') return `prepare().${prop}`;
    const objName = rootIdentifier(callee.object);
    if (objName
      && /^(?:axios|http|https|got|superagent|request|ky)$/i.test(objName)
      && /^(get|post|put|patch|delete|request)$/i.test(prop)) return `${objName}.${prop}`;
    return null;
  }
  if (callee.type === 'Identifier' && /^(query|fetch)$/i.test(callee.name)) return callee.name;
  return null;
}

function ormLacksLimit(node, stack) {
  if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return null;
  const prop = memberName(node.callee);
  if (!prop || !UNBOUNDED_ORM_METHODS.has(prop)) return null;
  const arg = node.arguments?.[0];
  // `find` 只在 ORM 语义下算查询：接收者像 db/model，或参数是查询对象。
  // arr.find(fn) / list.find(x => ...) 是数组操作，不报。
  if (prop === 'find') {
    if (isFunctionNode(arg)) return null;
    if (!(arg && arg.type === 'ObjectExpression') && !isDbLikeReceiver(node.callee.object)) return null;
  }
  // 链式 .take(10) / .limit(10) / .first() 视为已限流
  const parent = stack[stack.length - 1];
  if (parent && parent.type === 'MemberExpression' && parent.object === node) {
    const modifier = memberName(parent);
    if (modifier && BOUNDED_CHAIN.test(modifier)) return null;
  }
  if (arg && arg.type === 'ObjectExpression') {
    const bounded = arg.properties.some((p) => {
      const key = p?.key?.name ?? p?.key?.value;
      return typeof key === 'string' && BOUNDED_ARGS.test(key);
    });
    if (bounded) return null;
  }
  return prop;
}

function syncCryptoLabel(node) {
  if (node.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression') return null;
  const prop = memberName(node.callee);
  if (!prop) return null;
  if (SYNC_CRYPTO.has(prop)) return prop;
  if (prop === 'hashSync' && /bcrypt/i.test(rootIdentifier(node.callee.object) || '')) return 'bcrypt.hashSync';
  return null;
}

function isJsonDeepClone(node) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee?.type !== 'MemberExpression' || memberName(callee) !== 'parse') return false;
  if (rootIdentifier(callee.object) !== 'JSON') return false;
  const inner = node.arguments?.[0];
  return !!inner
    && inner.type === 'CallExpression'
    && inner.callee?.type === 'MemberExpression'
    && memberName(inner.callee) === 'stringify'
    && rootIdentifier(inner.callee.object) === 'JSON';
}

/**
 * 静态性能反模式检查。
 * @param {string} dir 项目根目录
 * @param {{tier?:string, excludes?:string[]}} [opts]
 * @returns {Promise<{checkId:string, findings:Array, coverageGap:string|null, warnings:string[]}>}
 */
export async function checkPerfStatic(dir, opts = {}) {
  const { tier, excludes = [] } = opts || {};
  const findings = [];
  const warnings = [];
  const force = String(tier || 'L2').toUpperCase() === 'L3' ? 'card' : 'check';

  const push = (rule, severity, file, line, snippet, message, forceCheck = false) => {
    findings.push({
      checkId: CHECK_ID,
      severity,
      force: forceCheck ? 'check' : force,
      file,
      line,
      rule,
      snippet: String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LIMIT),
      message,
      source: 'program',
    });
  };

  const { files, skipped, overLimit } = await collectSourceFiles(dir, excludes);
  if (overLimit) warnings.push(t('Q5：文件数超限，只扫描前 {n} 个代码文件', { n: MAX_FILES }));
  if (skipped.length) {
    warnings.push(t('Q5：跳过大文件 {n} 个（>{kb}KB）：{list}', {
      n: skipped.length,
      kb: Math.round(MAX_BYTES / 1024),
      list: skipped.slice(0, 3).join('、') + (skipped.length > 3 ? '…' : ''),
    }));
  }
  if (!files.length) {
    warnings.push(t('Q5：未找到可扫描的代码文件（ts/js/mjs/cjs/jsx/tsx）'));
    return { checkId: CHECK_ID, findings, coverageGap: null, warnings };
  }

  let parsedFiles = 0;
  for (const abs of files) {
    const rel = path.relative(dir, abs).replace(/\\/g, '/');
    let text;
    try { text = await readFile(abs, 'utf8'); } catch {
      warnings.push(t('Q5：无法读取 {file}，已跳过', { file: rel }));
      continue;
    }
    text = text.replace(/\r\n?/g, '\n');

    let ast;
    try {
      ast = parseSource(text);
    } catch {
      // 解析失败不中断整轮检查：记 warning，其余文件照扫
      warnings.push(t('Q5：{file} 解析失败，已跳过该文件的性能规则', { file: rel }));
      continue;
    }
    parsedFiles++;
    const fnNames = functionNameMap(ast);
    const lineOf = (node) => (node?.loc?.start?.line ?? 0);
    const snippetOf = (node) => {
      if (!node || typeof node.start !== 'number' || typeof node.end !== 'number') return '';
      return text.slice(node.start, node.end);
    };

    walkAst(ast.program, (node, stack) => {
      // 1) 请求/热路径里的同步 IO（成员调用 fs.readFileSync 或命名导入后直接 readFileSync）
      if (node.type === 'CallExpression') {
        const name = node.callee?.type === 'MemberExpression'
          ? memberName(node.callee)
          : (node.callee?.type === 'Identifier' ? node.callee.name : null);
        if (name && SYNC_IO.has(name)) {
          const hot = isHotPath(node, stack, rel, fnNames);
          if (hot) {
            push('Q5.sync-io-hotpath', 'medium', rel, lineOf(node), snippetOf(node),
              t('请求/热路径里调用同步 IO（{name}）：会阻塞事件循环，并发一上来整站排队；改用 fs/promises 的异步 API。', { name }));
          }
        }
      }

      // 2) 循环内 await
      if (LOOP_TYPES.has(node.type) && loopScaleLooksDataDriven(node) && hasTopLevelAwaitInLoopBody(node.body)) {
        push('Q5.await-in-loop', 'low', rel, lineOf(node), snippetOf(node),
          t('循环体内逐次 await 会串行执行：若迭代间无依赖，可改 Promise.all 并发（注意并发上限与连接池）。'), true);
      }

      // 3) 疑似 N+1：循环体内出现查询/请求调用
      if (LOOP_TYPES.has(node.type)) {
        const io = findLoopIoCall(node.body);
        if (io) {
          push('Q5.n-plus-one', 'low', rel, lineOf(io.node), snippetOf(io.node),
            t('疑似 N+1：循环内逐条调用 {name}；先确认能否一次批量取回（IN / 批量接口），再在内存中配对。', { name: io.label }), true);
        }
      }

      // 4/5) SQL 文本：无 LIMIT 的 SELECT、SELECT *
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        for (const arg of node.arguments || []) {
          const sql = sqlTextOf(arg);
          if (!sql || !SQL_SELECT_RE.test(sql)) continue;
          if (!SQL_LIMIT_RE.test(sql)) {
            push('Q5.unbounded-query', 'low', rel, lineOf(arg), sql,
              t('SELECT 未设 LIMIT：数据量增长时会全量拉取；补 LIMIT / 分页参数（导出类查询另走流式）。'), true);
          }
          if (SQL_STAR_RE.test(sql)) {
            push('Q5.select-star', 'low', rel, lineOf(arg), sql,
              t('SELECT * 会取回全部列：带宽/内存随表宽增长，也失去覆盖索引机会；显式列出需要的列。'), true);
          }
        }
      }
      if (node.type === 'TaggedTemplateExpression') {
        const sql = sqlTextOf(node.quasi);
        if (sql && SQL_SELECT_RE.test(sql)) {
          if (!SQL_LIMIT_RE.test(sql)) {
            push('Q5.unbounded-query', 'low', rel, lineOf(node), sql,
              t('SELECT 未设 LIMIT：数据量增长时会全量拉取；补 LIMIT / 分页参数（导出类查询另走流式）。'), true);
          }
          if (SQL_STAR_RE.test(sql)) {
            push('Q5.select-star', 'low', rel, lineOf(node), sql,
              t('SELECT * 会取回全部列：带宽/内存随表宽增长，也失去覆盖索引机会；显式列出需要的列。'), true);
          }
        }
      }

      // 4b) ORM 查询无 take/limit/first
      if (node.type === 'CallExpression') {
        const method = ormLacksLimit(node, stack);
        if (method) {
          push('Q5.unbounded-query', 'low', rel, lineOf(node), snippetOf(node),
            t('{method}() 未设上限：结果集随数据量增长；补 take / limit / first（并保留分页游标）。', { method }), true);
        }
      }

      // 6) 大对象深拷贝
      if (isJsonDeepClone(node)) {
        push('Q5.json-deep-clone', 'low', rel, lineOf(node), snippetOf(node),
          t('JSON.parse(JSON.stringify(...)) 深拷贝大对象很慢，且会丢 Date/undefined/Map/Set；改用 structuredClone() 或按需拷贝字段。'), true);
      }

      // 7) 阻塞式密钥派生/哈希
      const cryptoName = syncCryptoLabel(node);
      if (cryptoName) {
        const hot = isHotPath(node, stack, rel, fnNames);
        push('Q5.sync-crypto', hot ? 'medium' : 'low', rel, lineOf(node), snippetOf(node),
          hot
            ? t('请求路径里执行同步密钥派生/哈希（{name}）：单次计算占满事件循环，登录接口易被打爆；改用异步版本或放入工作线程。', { name: cryptoName })
            : t('同步阻塞的密钥派生/哈希（{name}）：批量或高成本参数会卡住事件循环；改用异步版本。', { name: cryptoName }));
      }
    });
  }

  if (parsedFiles === 0) {
    return {
      checkId: CHECK_ID,
      findings,
      coverageGap: t('可扫描文件全部解析失败，静态性能规则未生效'),
      warnings,
    };
  }

  // 同规则限额 + 去重（同一行同一规则只报一次），保证报告可读且可复现
  const seen = new Set();
  const perRule = new Map();
  const kept = [];
  const ordered = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => a.f.file.localeCompare(b.f.file) || a.f.line - b.f.line || a.i - b.i);
  for (const { f } of ordered) {
    const key = `${f.rule}|${f.file}|${f.line}|${f.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = perRule.get(f.rule) || 0;
    if (count >= MAX_FINDINGS_PER_RULE) continue;
    perRule.set(f.rule, count + 1);
    kept.push(f);
  }
  for (const [rule, count] of perRule) {
    if (count < MAX_FINDINGS_PER_RULE) continue;
    warnings.push(t('Q5：{rule} 命中过多，仅报告前 {n} 条', { rule, n: MAX_FINDINGS_PER_RULE }));
  }

  return { checkId: CHECK_ID, findings: kept, coverageGap: null, warnings };
}

// 别名：与其它检查项的 checkXxx 命名保持一致，接线时可用 checkQ5
export const checkQ5 = checkPerfStatic;
