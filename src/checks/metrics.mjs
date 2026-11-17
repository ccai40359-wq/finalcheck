import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles, prunedWarning, fixturesWarning } from '../walk.mjs';
import { parsePyStructure, importEdges } from '../py-structure.mjs';
import {
  DEFAULT_NOISE_HINTS, noiseWarning, reportCap, truncateList, truncationRecord, truncationWarning,
} from '../report-caps.mjs';

// Q3 可维护性度量（L2/L3 静态闸）：纯静态、不执行命令、不装第三方依赖。
// 指标：超大文件 / 跨文件重复块 / 相对导入环 / 未使用导出。
// 边界：只扫代码文件（ts/js/mjs/cjs/jsx/tsx + py），≤500 个文件、单文件 ≤1MB，超限写 warning。
// 文件收集统一走 walk.mjs：构建产物（release*/out/dist/build/*-unpacked）、依赖元数据、
// 夹具默认豁免、用户 exclude 全部由同一处规则决定，不在本检查里各写一份。
//
// Python 支持（2026-11-17）：大文件与重复块是**纯文本规则**，对 .py 直接生效；
// 导入环与导出声明需要语言分支——JS 走原来的正则，Python 走 py-structure 的结构解析。
// 「未使用导出」对 Python **不实现**：Python 的"导出"由是否被 import 决定，
// 静态猜不准（动态 import / __init__ 重导出都会误判），宁可标 unsupported 也不冒充。
const MAX_FILES = 500;
const MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_LARGE_FILES = Infinity; // 默认不截断；显式 reportCaps["Q3.largeFile"] 才截断（不改 800/1500 行阈值）
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

export async function checkMetrics(projectDir, { tier, excludes = [], includeFixtures = false, reportCaps } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  // 与 quality/authz 同一矩阵口径：L2 查（check），L3 卡（card）。
  // 低优先建议（如未使用导出）在 L3 也只报不卡：否则 200+ 条 low 会全部挤进「会卡交付的」，
  // 报告分层与结论引擎都会把风格建议当成交付阻断项。
  const forceFor = (severity) => (t === 'L3' && severity !== 'low' ? 'card' : 'check');
  const largeCap = reportCap(reportCaps, 'Q3.largeFile', DEFAULT_MAX_LARGE_FILES);
  const unusedCap = reportCap(reportCaps, 'Q3.unusedExport', Infinity);
  const duplicateBlockCap = reportCap(reportCaps, 'Q3.duplicateBlock', Infinity);
  const push = (rule, severity, file, line, snippet, message) => findings.push({
    checkId: 'Q3', severity, force: forceFor(severity), file, line, rule,
    snippet: String(snippet).slice(0, 120), message, source: 'program',
  });

  const { maxFileLines, warning } = await loadMetricConfig(projectDir);
  if (warning) warnings.push(warning);

  const {
    files, skipped, pruned, fixtures, overLimit,
  } = await listTextFiles(projectDir, excludes, {
    codeOnly: true, languages: 'all', maxBytes: MAX_BYTES, maxFiles: MAX_FILES, maxDepth: 12, includeFixtures,
  });
  if (overLimit) warnings.push('Q3：文件数超限，只扫前 500 个');
  const pword = prunedWarning(pruned);
  if (pword) warnings.push(`Q3：${pword}`);
  const fword = fixturesWarning(fixtures);
  if (fword) warnings.push(`Q3：${fword}`);
  if (skipped.length) warnings.push(`Q3：跳过超过 1MB 的文件 ${skipped.length} 个：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}`);
  if (!files.length) {
    // 区分两种「没文件可扫」，它们的含义完全不同（QA 清单 P0：不许假通过）：
    //   a) 真的一个代码文件都没有 → 缺口：未执行
    //   b) 有文件但全被单文件体积上限挡掉 → 仍算「扫过了」，只是没内容可查；
    //      旧测试明确要求这种情况 coverageGap 为 null（什么也没读到，不构成「未覆盖」）。
    if (skipped.length) {
      warnings.push('Q3：所有代码文件都超过 1MB 被跳过，未产生结论（想看结果请提高单文件上限或排除大文件）');
      return { checkId: 'Q3', findings, coverageGap: null, warnings };
    }
    warnings.push('Q3：未找到可扫描的代码文件（ts/js/mjs/cjs/jsx/tsx/py）');
    return { checkId: 'Q3', findings, coverageGap: '未找到可扫描的代码文件，可维护性度量未执行', warnings };
  }

  const relOf = (abs) => path.relative(projectDir, abs).replace(/\\/g, '/');
  const fileSet = new Set(files.map(relOf));
  const graph = new Map();
  const fingerprints = new Map(); // fp -> [{file, line}]
  const exportDecls = [];
  const filesWithIdent = new Map(); // ident -> Set(files)
  const largeFiles = []; // 先全部收集，再按显式配置截断；默认不截断
  const pyUnsupported = []; // Python 侧明确没解析的东西（写成 warning，不冒充已查）
  let pyFileCount = 0;

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

    // 1) 超大文件（阈值 > maxFileLines；默认全部报告，显式 reportCaps 才截断）
    if (lines.length > maxFileLines) {
      largeFiles.push({ file, lines: lines.length });
    }

    const stripped = stripCommentLines(text);

    // 2) 导入图（JS 走正则；Python 走结构解析，只把仓库内文件算边）
    const isPython = file.toLowerCase().endsWith('.py');
    if (isPython) {
      const st = parsePyStructure(text);
      const pyKnown = new Set([...fileSet].filter((f) => f.toLowerCase().endsWith('.py')));
      const { edges: pyEdges, unsupported } = importEdges(st, file, pyKnown);
      const edgeSet = new Set();
      for (const e of pyEdges) if (fileSet.has(e.target)) edgeSet.add(e.target);
      graph.set(file, edgeSet);
      for (const u of unsupported) pyUnsupported.push({ file, line: u.line, reason: u.reason });
      pyFileCount++;
    } else {
      const edges = new Set();
      for (const line of stripped) {
        for (const m of line.matchAll(IMPORT_RE)) {
          const target = resolveImport(file, m[1], fileSet);
          if (target) edges.add(target);
        }
      }
      graph.set(file, edges);
    }

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
    //    Python 不做导出扫描：它的"导出"由是否被 import 决定，静态猜不准（见文件头说明）。
    if (!isPython) {
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
  }

  const reportTruncations = [];
  const { kept: largeKept, truncation } = truncateList(largeFiles, largeCap);
  for (const lf of largeKept) {
    const severity = lf.lines > HIGH_LINES ? 'high' : 'medium';
    push('Q3.large-file', severity, lf.file, 0, `${lf.lines} 行 > 阈值 ${maxFileLines}`,
      `超大文件：${lf.file}（${lf.lines} 行，阈值 ${maxFileLines}${lf.lines > HIGH_LINES ? '，超过 1500 行为高危' : ''}）`);
  }
  if (truncation) {
    const tr = truncationRecord({
      checkId: 'Q3',
      rule: 'Q3.large-file',
      configKey: 'Q3.largeFile',
      total: truncation.total,
      reported: truncation.reported,
      cap: truncation.cap,
    });
    reportTruncations.push(tr);
    warnings.push(truncationWarning(tr));
  } else if (largeFiles.length > DEFAULT_NOISE_HINTS['Q3.largeFile']) {
    // 未截断但数量偏多：保留噪声提示，条目全部保留
    warnings.push(noiseWarning({
      checkId: 'Q3',
      rule: 'Q3.large-file',
      total: largeFiles.length,
      configKey: 'Q3.largeFile',
    }));
  }

  // 2) 重复块判定：同一指纹 ≥3 次且跨文件；默认全部报告，显式 reportCaps["Q3.duplicateBlock"] 才截断。
  //    重叠窗口先去重，再按「实际可报告块数」计数，截断时总量不把被重叠过滤的窗口算进去。
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
  const duplicateBlocks = [];
  for (const [, occ] of candidates) {
    if (occ.every(nearReported)) continue; // 与已报块重叠（同一块的不同滑窗）
    duplicateBlocks.push(occ);
    for (const o of occ) {
      if (!reportedLines.has(o.file)) reportedLines.set(o.file, new Set());
      reportedLines.get(o.file).add(o.line);
    }
  }
  const { kept: duplicateKept, truncation: duplicateTruncation } = truncateList(duplicateBlocks, duplicateBlockCap);
  for (const occ of duplicateKept) {
    const first = occ[0];
    const distinctFiles = new Set(occ.map((o) => o.file));
    const fileList = [...distinctFiles].slice(0, 5).join('、');
    push('Q3.duplicate-block', 'medium', first.file, first.line, `${first.file}:${first.line} × ${occ.length}`,
      `重复代码块：共 ${occ.length} 处，涉及 ${distinctFiles.size} 个文件（${fileList}${distinctFiles.size > 5 ? '…' : ''}）`);
  }
  if (duplicateTruncation) {
    const tr = truncationRecord({
      checkId: 'Q3',
      rule: 'Q3.duplicate-block',
      configKey: 'Q3.duplicateBlock',
      total: duplicateTruncation.total,
      reported: duplicateTruncation.reported,
      cap: duplicateTruncation.cap,
    });
    reportTruncations.push(tr);
    warnings.push(truncationWarning(tr));
  } else if (duplicateBlocks.length > DEFAULT_NOISE_HINTS['Q3.duplicateBlock']) {
    warnings.push(noiseWarning({
      checkId: 'Q3',
      rule: 'Q3.duplicate-block',
      total: duplicateBlocks.length,
      configKey: 'Q3.duplicateBlock',
    }));
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

  // 4) 未使用导出：其它文件零引用；同文件内部引用不算；默认全部报告，显式 reportCaps["Q3.unusedExport"] 才截断
  const unused = exportDecls.filter((d) => {
    const hit = filesWithIdent.get(d.name);
    return !hit || ![...hit].some((f) => f !== d.file);
  }).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const { kept: unusedKept, truncation: unusedTruncation } = truncateList(unused, unusedCap);
  for (const d of unusedKept) {
    push('Q3.unused-export', 'low', d.file, d.line, `export ${d.kind} ${d.name}`,
      `导出 ${d.name}（${d.kind}）在其它文件中零引用——可能已废弃，或仅供外部包使用`);
  }
  if (unusedTruncation) {
    const tr = truncationRecord({
      checkId: 'Q3',
      rule: 'Q3.unused-export',
      configKey: 'Q3.unusedExport',
      total: unusedTruncation.total,
      reported: unusedTruncation.reported,
      cap: unusedTruncation.cap,
    });
    reportTruncations.push(tr);
    warnings.push(truncationWarning(tr));
  } else if (unused.length > DEFAULT_NOISE_HINTS['Q3.unusedExport']) {
    warnings.push(noiseWarning({
      checkId: 'Q3',
      rule: 'Q3.unused-export',
      total: unused.length,
      configKey: 'Q3.unusedExport',
    }));
  }

  // Python 侧未解析的东西单独报（fail-closed：宁可说「这块没查」，也不冒充已查）
  if (pyUnsupported.length) {
    const first = pyUnsupported.slice(0, 3).map((u) => `${u.file}:${u.line}`).join('、');
    warnings.push(`Q3：Python 部分导入未能静态解析 ${pyUnsupported.length} 处（${first}${pyUnsupported.length > 3 ? '…' : ''}），这些文件的依赖关系未纳入环检测`);
  }

  const out = { checkId: 'Q3', findings, coverageGap: null, warnings };
  // Python 侧「未使用导出」明确不实现 → 用 partial 说明，不许当作已查（QA 清单阶段 3）
  if (pyFileCount > 0) {
    out.pythonCoverage = {
      files: pyFileCount,
      rules: ['Q3.large-file', 'Q3.duplicate-block', 'Q3.import-cycle'],
      unsupported: ['Q3.unused-export'],
      note: 'Python 侧未使用导出不做静态判定（导出语义由 import 决定，猜不准会误报）'
    };
  }
  // 只有真的发生截断才加字段：未配置时返回形状与旧版一致
  if (reportTruncations.length) out.reportTruncations = reportTruncations;
  return out;
}

// 命名别名：调用方按矩阵编号找入口时可直接用 checkQ3
export const checkQ3 = checkMetrics;
