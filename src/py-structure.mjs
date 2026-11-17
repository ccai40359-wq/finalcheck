// Python 源码的轻量结构解析（2026-11-17，为 Q3/Q4/Q5 与后续 A2-A4 提供共用基础）。
//
// 为什么不引入外部 Python 解析器：
//   · 产品要在客户机器上零依赖运行（装了 Git 就够，不该再要求 python + tree-sitter）
//   · 单测必须能在没有 Python 的环境里通过（CI 与干净机器上都要绿）
// 所以这里用「缩进 + 词法状态机」做结构识别，而不是完整 AST。代价是表达力有限：
//   · 只认缩进块（Python 的语法骨架就是缩进，这对结构类规则足够）
//   · 装饰器、多行调用、字符串里的括号用状态机跳过（与 extract-py-routes 同一套经验）
//   · 明确不做：类型推断、动态 import 展开、装饰器运行期语义
// 拿不准的地方一律**标记为未解析**（返回 unsupported 列表），由检查器写成 coverageGap，
// 绝不猜——猜出来的结论比「未覆盖」危险得多。
//
// 复用约束：本模块必须保持纯净（无副作用、不读文件、不联网），
// 输入是 { rel, text }，输出是可序列化的结构体，便于单测直接构造。

/** 逐行扫，跳过三引号字符串（docstring / 多行字符串）。返回每行内容是否「代码行」。 */
export function maskStrings(lines) {
  const code = [];
  let inDoc = null; // 当前处于哪种三引号
  for (const raw of lines) {
    const line = String(raw ?? '');
    if (inDoc) {
      // 在多行字符串里：只有当本行出现收尾引号才退出
      const idx = line.indexOf(inDoc);
      if (idx >= 0) {
        inDoc = null;
        const rest = line.slice(idx + 3);
        code.push(rest);
      } else {
        code.push('');
      }
      continue;
    }
    // 本行可能开启多行字符串：找第一个 """ 或 '''
    const tripleD = line.indexOf('"""');
    const tripleS = line.indexOf("'''");
    let cut = -1;
    let opener = null;
    if (tripleD >= 0 && (tripleS < 0 || tripleD < tripleS)) { cut = tripleD; opener = '"""'; }
    else if (tripleS >= 0) { cut = tripleS; opener = "'''"; }
    if (cut >= 0) {
      const after = line.slice(cut + 3);
      const closeIdx = after.indexOf(opener);
      if (closeIdx >= 0) {
        // 同一行闭合：保留开闭之间的内容为空，拼接后面的代码
        code.push(line.slice(0, cut) + after.slice(closeIdx + 3));
      } else {
        inDoc = opener;
        code.push(line.slice(0, cut));
      }
    } else {
      code.push(line);
    }
  }
  return code;
}

/** 行首缩进宽度（Tab 按 4 计）。 */
export function indentOf(line) {
  const s = String(line ?? '');
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') n += 1;
    else if (s[i] === '\t') n += 4;
    else break;
  }
  return n;
}

/** 这条（去缩进后的）代码行是不是纯注释或空行。 */
export function isCommentOrBlank(codeLine) {
  const s = String(codeLine ?? '').trim();
  return s === '' || s.startsWith('#');
}

const DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)?\s*\(/;
const CLASS_RE = /^class\s+([A-Za-z_]\w*)?\s*[:(]/;
const IMPORT_RE = /^(?:from\s+(\S+)\s+import|import\s+([^#]+))/;
const BLOCK_RE = /^(?:if|elif|else|for|while|try|except|finally|with|match|case)\b/;

/**
 * 把 Python 源码解析成「结构摘要」。
 * @param {string} text 源码
 * @returns {{
 *   lines: number,
 *   codeLines: number,
 *   commentLines: number,
 *   blankLines: number,
 *   functions: Array<{name:string,start:number,end:number,bodyLines:number,indent:number,maxDepth:number,isAsync:boolean,decorators:string[]}>,
 *   classes: Array<{name:string,start:number,end:number}>,
 *   imports: Array<{module:string,line:number,type:'import'|'from'}>,
 *   unsupported: Array<{line:number,reason:string}>
 * }}
 */
export function parsePyStructure(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const code = maskStrings(raw);

  let commentLines = 0;
  let blankLines = 0;
  let codeLines = 0;
  for (let i = 0; i < code.length; i++) {
    const s = code[i].trim();
    if (s === '') {
      // 原行是空白还是被 docstring 掩盖，都算空/非代码
      if (String(raw[i] ?? '').trim() === '') blankLines++;
      else if (String(raw[i] ?? '').trim().startsWith('#')) commentLines++;
      continue;
    }
    if (s.startsWith('#')) { commentLines++; continue; }
    codeLines++;
  }

  const functions = [];
  const classes = [];
  const imports = [];
  const unsupported = [];
  const decorators = []; // 收集紧贴 def 之前的 @xxx

  // 找每个 def/class 的块结束：向后扫直到缩进 <= 自身缩进（且不是空行/注释）
  const blockEnd = (startIdx, selfIndent) => {
    let i = startIdx + 1;
    for (; i < code.length; i++) {
      const s = code[i].trim();
      if (s === '' || s.startsWith('#')) continue;
      if (indentOf(code[i]) <= selfIndent) return i - 1;
    }
    return code.length - 1;
  };

  // 块内最大嵌套深度（按相对缩进层数粗算）
  const maxNesting = (startIdx, endIdx, baseIndent) => {
    let max = 0;
    const seen = new Set();
    for (let i = startIdx + 1; i <= endIdx; i++) {
      const s = code[i].trim();
      if (!s || s.startsWith('#')) continue;
      const ind = indentOf(code[i]);
      if (ind <= baseIndent) continue;
      // 只把「块起始关键字」算作嵌套，避免把续行的缩进也算进去
      if (BLOCK_RE.test(s)) seen.add(ind);
      const depth = Math.max(0, Math.min(seen.size, Math.round((ind - baseIndent) / 4)));
      max = Math.max(max, depth);
    }
    return max;
  };

  for (let i = 0; i < code.length; i++) {
    const s = code[i].trim();
    if (!s) continue;

    if (s.startsWith('@')) { decorators.push(s.slice(0, 80)); continue; }

    const def = DEF_RE.exec(s);
    if (def && indentOf(code[i]) >= 0) {
      // 上一个装饰器组属于这个函数
      const isAsync = /^async/.test(s);
      const start = i;
      const end = blockEnd(i, indentOf(code[i]));
      let bodyLines = 0;
      for (let k = start + 1; k <= end; k++) {
        const t = code[k].trim();
        if (t && !t.startsWith('#')) bodyLines++;
      }
      functions.push({
        name: def[1] || '(anonymous)',
        start: start + 1,      // 1 基行号，与 finding.line 契约一致
        end: end + 1,
        bodyLines,
        indent: indentOf(code[i]),
        maxDepth: maxNesting(start, end, indentOf(code[i])),
        isAsync,
        decorators: decorators.slice()
      });
      decorators.length = 0;
      continue;
    }

    const cls = CLASS_RE.exec(s);
    if (cls) {
      const start = i;
      const end = blockEnd(i, indentOf(code[i]));
      classes.push({ name: cls[1] || '(anonymous)', start: start + 1, end: end + 1 });
      decorators.length = 0;
      continue;
    }

    const imp = IMPORT_RE.exec(s);
    if (imp) {
      const mod = imp[1] || (imp[2] || '').split(/\s*(?:as|,)/)[0];
      imports.push({
        module: String(mod || '').trim(),
        line: i + 1,
        type: imp[1] ? 'from' : 'import'
      });
      continue;
    }

    // 遇到其它语句就把待挂的装饰器丢掉（说明那个装饰器不是给 def/class 的）
    if (!s.startsWith('@')) decorators.length = 0;
  }

  return {
    lines: raw.length,
    codeLines,
    commentLines,
    blankLines,
    functions,
    classes,
    imports,
    unsupported
  };
}

/**
 * 从 import 列表推出「文件级依赖边」（用于导入环检测）。
 *
 * 只产出**仓库内可能有对应文件**的边：第三方库与标准库（logging / uuid / fastapi / sqlalchemy…）
 * 不在仓库里，把它们当边会让导入环检测报出根本不存在的环。判定方式：
 *   · 相对导入（`from .foo import x`）→ 一定是仓库内，带上跳层算绝对路径
 *   · 绝对导入 → 只有当 `foo.py` / `foo/__init__.py` 真的在仓库里才算边（由调用方传入 knownFiles 判定）
 * 明确不做：`importlib.import_module(name)`、`__import__(...)`、字符串拼出来的模块名——
 * 这些进 unsupported，由调用方写成 coverageGap，不猜。
 */
export function importEdges(structure, relPath, knownFiles = null) {
  const edges = [];
  const unsupported = [];
  const dir = relPath.replace(/\\/g, '/').split('/').slice(0, -1);
  // knownFiles: 仓库内所有 .py 相对路径（'pkg/mod.py'）。不传则只产出相对导入边。
  const known = knownFiles instanceof Set ? knownFiles : null;
  const existsInRepo = (candidate) => {
    if (!known) return false;
    const normalized = String(candidate).replace(/\\/g, '/');
    if (known.has(normalized)) return true;
    const pkgInit = normalized.replace(/\.py$/, '/__init__.py');
    return known.has(pkgInit);
  };

  for (const imp of structure.imports || []) {
    const mod = String(imp.module || '').trim();
    if (!mod) continue;
    if (/importlib|__import__|import_module/i.test(mod)) {
      unsupported.push({ line: imp.line, reason: '动态导入（模块名不是字面量）' });
      continue;
    }
    if (imp.type === 'from' && mod.startsWith('.')) {
      const dots = (mod.match(/^\.+/) || [''])[0].length;
      const rest = mod.slice(dots).split('/').filter(Boolean);
      const base = dir.slice(0, Math.max(0, dir.length - (dots - 1)));
      const target = [...base, ...rest].join('/');
      if (target) edges.push({ target: target + '.py', line: imp.line, kind: 'relative' });
      continue;
    }
    // 绝对导入：只有当仓库里真有这个模块时才算边（否则是 pip 包/标准库）
    // Python 的模块分隔符是**点**（`from services.daily_login_bonus import x` → services/daily_login_bonus.py），
    // 而相对导入里我用 / 归一化过，所以这里两种分隔符都要试。
    const modPath = mod.replace(/\./g, '/');
    const candidates = [
      modPath + '.py',
      modPath + '/__init__.py'
    ];
    const hit = candidates.find((c) => existsInRepo(c));
    if (hit) edges.push({ target: hit, line: imp.line, kind: 'absolute' });
  }
  return { edges, unsupported };
}
