// Q5 的 Python 分支（2026-11-17，解除纯 Python 仓的 Q5 语言缺口）。
//
// 与 JS 侧同一套 rule id，让报告口径只有一套解释：
//   Q5.sync-io-hotpath   async 函数里调用了同步阻塞 IO（requests/time.sleep/open 读、subprocess 等）
//   Q5.await-in-loop     for/while 循环体内出现 await（串行执行，少了并发收益）
//   Q5.n-plus-one        循环体内执行数据库查询（session.execute / .query / .filter）
//   Q5.unbounded-query   SELECT 无 WHERE/LIMIT（全表扫）
//   Q5.select-star       SELECT *
//
// 纯行扫描（缩进判块），零依赖。明确不做：JSON 深拷贝（Python 里 copy.deepcopy 需 AST 判定
// 语义）、同步加密（Python 的 hashlib 本来就是同步 API，报它等于全仓都报）。

const ASYNC_DEF_RE = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;

/** 是否 Python 源码（Q5 分支选择用） */
export function isPySource(ext) {
  return String(ext || '').toLowerCase() === '.py';
}
// 循环头（含 else 分支前的 for/while）
const LOOP_RE = /^\s*(?:for|while)\b/;

// 同步阻塞 IO：在 async 函数里出现就是热点阻塞（JS 侧的 sync-io-hotpath 同义）
const SYNC_IO_RE = /\b(?:requests\.(?:get|post|put|delete|patch|head)\(|time\.sleep\(|(?:urllib\.request\.)?urlopen\(|subprocess\.(?:run|call|check_output|check_call|Popen)\(|os\.system\(|shutil\.copy|shutil\.move|open\([^)]*\)\s*as\s+)/;
// 数据库查询调用。
// 注意**不含** `.get(`：dict.get / cache.get / request.headers.get 全是同一形状，
// 不加区分会把普通字典取值当成 N+1（fastapi 实跑 main.py:62 就是这么误报的）。
const DB_QUERY_RE = /\.(?:execute|executemany|query|filter|filter_by|find|find_one|find_many|aggregate|scalars|fetchall|fetchone)\s*\(/;
// 跳过的查询形态（已经是单条/有限制，不构成 N+1 的「必然」证据；只在 SQL 文本里判）
const SQL_SELECT_RE = /\bselect\b[\s\S]{0,400}?\bfrom\b/i;

function stripComment(line) {
  const code = String(line || '');
  const q1 = code.indexOf("'");
  const q2 = code.indexOf('"');
  const hash = code.indexOf('#');
  if (hash < 0) return code;
  const firstQuote = [q1, q2].filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), Infinity);
  if (firstQuote < hash) return code;
  return code.slice(0, hash);
}

const indentOf = (line) => {
  const s = String(line ?? '');
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') n += 1;
    else if (s[i] === '\t') n += 4;
    else break;
  }
  return n;
};

/**
 * 分析一个 Python 文件（Q5 规则）。
 * @param {object} opts
 * @param {string} opts.file 相对路径
 * @param {string} opts.text 源码
 * @param {function} opts.push (rule, severity, file, line, snippet, message) => void
 */
export function analyzePyPerf({ file, text, push }) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const rel = String(file || '').replace(/\\/g, '/');
  const snip = (i) => String(lines[i - 1] || '').trim().slice(0, 200);

  // 函数区间（async 与否决定 sync-io-hotpath 是否成立）
  const fns = [];
  for (let i = 1; i <= lines.length; i++) {
    const raw = lines[i - 1] || '';
    const m = ASYNC_DEF_RE.exec(raw);
    if (!m) continue;
    const isAsync = /^\s*async\s+/.test(raw);
    const selfIndent = indentOf(raw);
    let end = lines.length;
    for (let k = i + 1; k <= lines.length; k++) {
      const s = stripComment(lines[k - 1]).trim();
      if (!s || s.startsWith('#')) continue;
      if (indentOf(lines[k - 1]) <= selfIndent) { end = k - 1; break; }
    }
    fns.push({ name: m[1], start: i, end, isAsync });
  }

  // 循环区间：从 for/while 头开始，吞掉所有更深缩进的行（含它自己的 else 块）
  const loops = [];
  for (let i = 1; i <= lines.length; i++) {
    const raw = lines[i - 1] || '';
    if (!LOOP_RE.test(raw)) continue;
    // 排除推导式/单行 for（`for x in y:` 才算块头）
    if (!/:\s*(?:#.*)?$/.test(raw.replace(/\\\s*$/, '')) && !raw.trim().endsWith(':')) continue;
    const selfIndent = indentOf(raw);
    let end = i;
    for (let k = i + 1; k <= lines.length; k++) {
      const s = stripComment(lines[k - 1]).trim();
      if (!s) { end = k; continue; } // 空行不断块
      if (indentOf(lines[k - 1]) <= selfIndent) {
        // else/elif 挂在循环上：`for ... else:` 也属于这个块
        if (/^\s*(?:else|elif)\b/.test(lines[k - 1]) && indentOf(lines[k - 1]) === selfIndent) { end = k; continue; }
        end = k - 1;
        break;
      }
      end = k;
    }
    loops.push({ start: i, end, indent: selfIndent });
  }

  const inAsyncFn = (line) => fns.some((f) => f.isAsync && line >= f.start && line <= f.end);
  const inLoop = (line) => loops.some((l) => line > l.start && line <= l.end);
  const loopOf = (line) => loops.find((l) => line > l.start && line <= l.end);

  // ── 规则 1：async 函数里出现同步阻塞 IO
  for (let i = 1; i <= lines.length; i++) {
    if (!inAsyncFn(i)) continue;
    const code = stripComment(lines[i - 1] || '');
    if (!SYNC_IO_RE.test(code)) continue;
    // async def 那一行本身不算（签名里可能有 default 值）
    const isDefLine = ASYNC_DEF_RE.test(lines[i - 1] || '');
    if (isDefLine) continue;
    push('Q5.sync-io-hotpath', 'medium', rel, i, snip(i),
      `async 函数里调用同步阻塞 IO（${(code.match(SYNC_IO_RE) || [''])[0]}），会堵塞事件循环，建议改用 async 客户端或 run_in_executor`);
  }

  // ── 规则 2：循环体内 await（串行等待）
  // 排除「靠 sleep 控速的轮询循环」：`while True: ... await f(); await asyncio.sleep(2)` 是刻意串行，
  // 改成并发反而会打爆下游（fastapi 的 _poll_alpaca_forever 就是这种，报它是纯误报）。
  const isPollLoop = (loop) => {
    for (let k = loop.start; k <= loop.end; k++) {
      if (/asyncio\.(?:sleep|wait_for)\s*\(|time\.sleep\s*\(/.test(stripComment(lines[k - 1] || ''))) {
        if (/^\s*while\s+True\s*:/.test(lines[loop.start - 1] || '')) return true;
        return true;
      }
    }
    return false;
  };
  for (let i = 1; i <= lines.length; i++) {
    if (!inLoop(i)) continue;
    const code = stripComment(lines[i - 1] || '');
    if (!/\bawait\s+/.test(code)) continue;
    if (LOOP_RE.test(lines[i - 1] || '')) continue; // 循环头里的 await（如 `for x in await gen():`）不算体内
    const loop = loopOf(i);
    if (loop && isPollLoop(loop)) continue; // 控速轮询循环刻意串行，不报
    push('Q5.await-in-loop', 'low', rel, i, snip(i),
      '循环体内 await 每次迭代串行等待，量大时应改成 gather/TaskGroup 并发');
  }

  // ── 规则 3：循环体内数据库查询（N+1 形态）
  for (let i = 1; i <= lines.length; i++) {
    if (!inLoop(i)) continue;
    const code = stripComment(lines[i - 1] || '');
    if (!DB_QUERY_RE.test(code)) continue;
    if (/^\s*(?:for|while)\b/.test(lines[i - 1] || '')) continue; // 循环头里的调用（`for r in session.query(...)`）是单次查询
    const loop = loopOf(i);
    push('Q5.n-plus-one', 'low', rel, i, snip(i),
      `循环体内逐次查询数据库（第 ${loop ? loop.start : '?'} 行的循环内），应改为一次性批量查询后在内存过滤`);
  }

  // ── 规则 4/5：SQL 文本里的全表扫与 SELECT *
  // 只认「看起来是 SQL 的字符串字面量」，避免把普通英文句子当 SQL
  for (let i = 1; i <= lines.length; i++) {
    const code = stripComment(lines[i - 1] || '');
    const m = SQL_SELECT_RE.exec(code);
    if (!m) continue;
    // 必须同时有 SQL 关键字上下文（execute / query / text( / cursor / session.）
    if (!/\b(?:execute|executemany|query|text|sql|prepare|from_statement|cursor)\b/i.test(code)) continue;
    const sql = code.slice(m.index, m.index + 400);
    if (!/\b(?:where|limit)\b/i.test(sql)) {
      push('Q5.unbounded-query', 'low', rel, i, snip(i),
        'SELECT 没有 WHERE / LIMIT，可能扫全表，建议加分页或过滤条件');
    }
    if (/\bselect\s+\*/i.test(sql)) {
      push('Q5.select-star', 'low', rel, i, snip(i),
        'SELECT * 会把整行进内存，建议只选需要的列（大表/宽表上差别明显）');
    }
  }

  return { functions: fns.length, loops: loops.length };
}
