import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// Q3 可维护性度量（L2/L3 静态闸）：纯静态、不执行命令、不装第三方依赖。
// 指标：超大文件 / 跨文件重复块 / 相对导入环 / 未使用导出。
// 边界：只扫代码文件（ts/js/mjs/cjs/jsx/tsx），≤500 个文件、单文件 ≤1MB，超限写 warning。
const CODE_RE = /\.(?:ts|js|mjs|cjs|jsx|tsx)$/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', '.next', '.git', 'release', 'out']);
const MAX_FILES = 500;
const MAX_BYTES = 1024 * 1024;
const DEPTH_LIMIT = 12;
const WINDOW = 6;
const DEFAULT_MAX_LINES = 800;
const HIGH_LINES = 1500;
const CONFIG_FILE = 'finalcheck.config.json';

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const EXPORT_PATTERNS = [
  { kind: 'function', re: /^\s*export\s+(?:declare\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'class', re: /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'const', re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: 'interface', re: /^\s*export\s+interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
];
const RESERVED_EXPORT_NAMES = new Set(['enum', 'type', 'namespace', 'abstract', 'declare']);
const TRIVIAL_LINE_RE = /^(?:else|try|finally|do|break|continue|default)?[{}()[\];,.:]*$/;

async function loadMetricConfig(projectDir) {
  try {
    const raw = JSON.parse(await readFile(path.join(projectDir, CONFIG_FILE), 'utf8'));
    const n = raw?.metrics?.maxFileLines;
    if (n == null) return { maxFileLines: DEFAULT_MAX_LINES, warning: null };
    const num = Number(n);
    if (Number.isFinite(num) && num > 0) return { maxFileLines: Math.floor(num), warning: null };
    return { maxFileLines: DEFAULT_MAX_LINES, warning: `Q3：${CONFIG_FILE} 的 metrics.maxFileLines 不是正整数，使用默认 ${DEFAULT_MAX_LINES}` };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { maxFileLines: DEFAULT_MAX_LINES, warning: null };
    return { maxFileLines: DEFAULT_MAX_LINES, warning: `Q3：${CONFIG_FILE} 解析失败，使用默认阈值 ${DEFAULT_MAX_LINES}` };
  }
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
      // 只有真的遇到第 501 个代码文件才报超限；恰好 500 个不该误报
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

// 去注释但保留行号（块注释跨行时用空行占位）；只用于声明/引用/导入识别
function stripCommentLines(text) {
  const out = [];
  let inBlock = false;
  for (const raw of String(text || '').split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    let guard = 0;
    while (guard++ < 50) {
      const start = line.indexOf('/*');
      if (start === -1) break;
      const end = line.indexOf('*/', start + 2);
      if (end === -1) { line = line.slice(0, start); inBlock = true; break; }
      line = line.slice(0, start) + ' ' + line.slice(end + 2);
    }
    const slash = line.indexOf('//');
    if (slash !== -1) line = line.slice(0, slash);
    out.push(line);
  }
  return out;
}

function resolveImport(fromFile, spec, fileSet) {
  const clean = String(spec || '').split(/[?#]/)[0];
  if (!clean.startsWith('.')) return null; // 只解析相对导入
  const fromDir = path.posix.dirname(fromFile);
  let target = path.posix.normalize(path.posix.join(fromDir, clean));
  if (target.startsWith('../')) return null; // 跑出项目根，不纳入图
  if (target.endsWith('/')) target = target.slice(0, -1);
  const ext = path.posix.extname(target).toLowerCase();
  const candidates = [];
  if (ext) {
    candidates.push(target);
    // TS 的 ESM 写法 import './x.js' 实际指向 x.ts
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      const stem = target.slice(0, -ext.length);
      candidates.push(stem + '.ts', stem + '.tsx');
    }
  } else {
    for (const e of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) candidates.push(target + e);
    for (const e of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) candidates.push(target + '/index' + e);
  }
  return candidates.find((c) => fileSet.has(c)) || null;
}

// 6 行归一化窗口是否值得当“重复块”：至少 2 行实质内容，避免 `}`×6 这类结构噪声
function isInterestingFingerprint(fp) {
  const norm = fp.split('\n');
  if (norm.filter((l) => !TRIVIAL_LINE_RE.test(l)).length < 2) return false;
  const cleaned = fp.replace(/[^A-Za-z0-9_\u3400-\u9fff]/g, '');
  return cleaned.length >= 12;
}

// Tarjan 强连通分量：每个 size>1 的 SCC（或自环）就是一个环簇，避免同一环重复上报
function findSccs(graph) {
  let nextIndex = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  const visit = (v) => {
    index.set(v, nextIndex);
    low.set(v, nextIndex);
    nextIndex++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) || []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const scc = new Set();
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      scc.add(w);
    } while (w !== v);
    sccs.push(scc);
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return sccs;
}

// 在 SCC 内找一条实际可走的环路径（含首尾重复），用于报告列出环上文件
function cyclePath(graph, scc) {
  const start = [...scc].sort()[0];
  const stack = [];
  const onPath = new Map();
  const done = new Set();
  const walk = (node) => {
    onPath.set(node, stack.length);
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (!scc.has(next)) continue;
      if (onPath.has(next)) return stack.slice(onPath.get(next)).concat(next);
      if (done.has(next)) continue;
      const found = walk(next);
      if (found) return found;
    }
    const popped = stack.pop();
    onPath.delete(popped);
    done.add(popped);
    return null;
  };
  return walk(start) || [...scc].sort().concat(start);
}

export async function checkMetrics(projectDir, { tier, excludes = [] } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  // 与 quality/authz 同一矩阵口径：L2 查（check），L3 卡（card）
  const force = t === 'L3' ? 'card' : 'check';
  const push = (rule, severity, file, line, snippet, message) => findings.push({
    checkId: 'Q3', severity, force, file, line, rule,
    snippet: String(snippet).slice(0, 120), message, source: 'program',
  });

  const { maxFileLines, warning } = await loadMetricConfig(projectDir);
  if (warning) warnings.push(warning);

  const { files, skipped, overLimit } = await collectSourceFiles(projectDir, excludes);
  if (overLimit) warnings.push('Q3：文件数超限，只扫前 500 个');
  if (skipped.length) warnings.push(`Q3：跳过超过 1MB 的文件 ${skipped.length} 个：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}`);
  if (!files.length) {
    warnings.push('Q3：未找到可扫描的代码文件（ts/js/mjs/cjs/jsx/tsx）');
    return { checkId: 'Q3', findings, coverageGap: null, warnings };
  }

  const relOf = (abs) => path.relative(projectDir, abs).replace(/\\/g, '/');
  const fileSet = new Set(files.map(relOf));
  const graph = new Map();
  const fingerprints = new Map(); // fp -> [{file, line}]
  const exportDecls = [];
  const filesWithIdent = new Map(); // ident -> Set(files)

  for (const abs of files) {
    const file = relOf(abs);
    let text;
    try { text = await readFile(abs, 'utf8'); } catch {
      warnings.push(`Q3：无法读取 ${file}，跳过`);
      continue;
    }
    text = text.replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    // 1) 超大文件
    if (lines.length > maxFileLines) {
      const severity = lines.length > HIGH_LINES ? 'high' : 'medium';
      push('Q3.large-file', severity, file, 0, `${lines.length} 行 > 阈值 ${maxFileLines}`,
        `超大文件：${file}（${lines.length} 行，阈值 ${maxFileLines}${lines.length > HIGH_LINES ? '，超过 1500 行为高危' : ''}）`);
    }

    const stripped = stripCommentLines(text);

    // 2) 导入图（相对路径）
    const edges = new Set();
    for (const line of stripped) {
      for (const m of line.matchAll(IMPORT_RE)) {
        const target = resolveImport(file, m[1], fileSet);
        if (target) edges.add(target);
      }
    }
    graph.set(file, edges);

    // 3) 重复块：去空白、去空行后 6 行滑窗指纹
    const norm = [];
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].replace(/\s+/g, '');
      if (s) norm.push({ text: s, line: i + 1 });
    }
    for (let i = 0; i + WINDOW <= norm.length; i++) {
      const fp = norm.slice(i, i + WINDOW).map((x) => x.text).join('\n');
      if (!isInterestingFingerprint(fp)) continue;
      const occ = fingerprints.get(fp);
      if (occ) occ.push({ file, line: norm[i].line });
      else fingerprints.set(fp, [{ file, line: norm[i].line }]);
    }

    // 4) 导出声明 + 标识符索引（其它文件的“引用”判定用）
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i];
      for (const p of EXPORT_PATTERNS) {
        const m = p.re.exec(line);
        if (!m) continue;
        const name = m[1];
        if (RESERVED_EXPORT_NAMES.has(name)) continue;
        exportDecls.push({ file, line: i + 1, kind: p.kind, name });
      }
    }
    const idents = new Set(stripped.join('\n').match(IDENT_RE) || []);
    for (const id of idents) {
      if (!filesWithIdent.has(id)) filesWithIdent.set(id, new Set());
      filesWithIdent.get(id).add(file);
    }
  }

  // 2) 重复块判定：同一指纹 ≥3 次且跨文件；最多 5 条，重叠窗口去重
  const candidates = [...fingerprints.entries()]
    .filter(([, occ]) => occ.length >= 3 && new Set(occ.map((o) => o.file)).size >= 2)
    .sort((a, b) => b[1].length - a[1].length || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1));
  const reportedLines = new Map(); // file -> Set(lines)
  const nearReported = (o) => {
    const set = reportedLines.get(o.file);
    if (!set) return false;
    for (const l of set) if (Math.abs(l - o.line) < WINDOW) return true;
    return false;
  };
  let dupCount = 0;
  for (const [, occ] of candidates) {
    if (dupCount >= 5) break;
    if (occ.every(nearReported)) continue; // 与已报块重叠（同一块的不同滑窗）
    const first = occ[0];
    const distinctFiles = new Set(occ.map((o) => o.file));
    const fileList = [...distinctFiles].slice(0, 5).join('、');
    push('Q3.duplicate-block', 'medium', first.file, first.line, `${first.file}:${first.line} × ${occ.length}`,
      `重复代码块：共 ${occ.length} 处，涉及 ${distinctFiles.size} 个文件（${fileList}${distinctFiles.size > 5 ? '…' : ''}）`);
    for (const o of occ) {
      if (!reportedLines.has(o.file)) reportedLines.set(o.file, new Set());
      reportedLines.get(o.file).add(o.line);
    }
    dupCount++;
  }

  // 3) 循环依赖：每个 SCC / 自环 → high
  const cycles = findSccs(graph)
    .filter((scc) => scc.size > 1 || (scc.size === 1 && graph.get([...scc][0])?.has([...scc][0])))
    .map((scc) => cyclePath(graph, scc))
    .sort((a, b) => a.join('|').localeCompare(b.join('|')));
  for (const cyc of cycles) {
    const p = cyc.join(' → ');
    push('Q3.import-cycle', 'high', cyc[0], 0, p, `循环依赖：${p.slice(0, 300)}`);
  }

  // 4) 未使用导出：其它文件零引用；同文件内部引用不算；最多 10 条
  const unused = exportDecls.filter((d) => {
    const hit = filesWithIdent.get(d.name);
    return !hit || ![...hit].some((f) => f !== d.file);
  }).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  if (unused.length > 10) warnings.push(`Q3：未使用导出共 ${unused.length} 个，仅报告前 10 条`);
  for (const d of unused.slice(0, 10)) {
    push('Q3.unused-export', 'low', d.file, d.line, `export ${d.kind} ${d.name}`,
      `导出 ${d.name}（${d.kind}）在其它文件中零引用——可能已废弃，或仅供外部包使用`);
  }

  return { checkId: 'Q3', findings, coverageGap: null, warnings };
}

// 命名别名：调用方按矩阵编号找入口时可直接用 checkQ3
export const checkQ3 = checkMetrics;
