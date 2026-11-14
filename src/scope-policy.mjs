// 非产品路径降级 + 非 JS 语言覆盖缺口。
//
// 实测教训：tests/examples/docs/benchmarks 里的发现被当成产品结论，直接把干净仓库
// 误判成高危（express 333 条 high 全在 test/examples；deepseek-harness 73.5% 在 tests/docs）。
// 这里只做「降为提示、不计入结论」，不删发现、不改严重度；真实密钥仍按 S3 硬规则卡。
//
// 语言缺口：仓库只有 .py/.php/.java/.go/.rb 时，只解析 JS/TS 的检查不能记「已执行」，
// 更不能把空结果当通过；审计层据此给 S1/S2/S7/Q3/Q4/Q5 记 unavailable。

import path from 'node:path';

const NON_PRODUCT_SEGMENTS = new Set([
  'test', 'tests', '__tests__', 'spec', 'specs', 'e2e',
  'examples', 'example', 'docs', 'doc', 'benchmarks', 'bench',
  // 教程/演示页面也是文档面：NodeGoat 的 app/views/tutorial/a1.html 是教学示例，
  // 不能把里面的 eval 示例当产品代码硬卡。
  'tutorial', 'tutorials', 'walkthrough', 'guide', 'guides',
  // 第二轮实测补充：Svelte 的 benchmarking/playgrounds，juice-shop 的 codefixes/i18n。
  'benchmarking', 'playground', 'playgrounds', 'demo', 'demos',
  'codefixes', 'i18n', 'locales', 'locale', 'translations',
  // FastAPI 仓库的 docs_src/ 是文档教程示例应用（round5 实测 451 条 FP 的来源）
  'docs_src',
]);
// docs/doc 只在仓库根、www/*/docs 等文档目录算文档面；src/doc/render.js 这类产品文档引擎仍算产品。
const ROOT_ONLY_SEGMENTS = new Set(['docs', 'doc']);

// 命中非产品路径就降级的产品类 check。S3 先按硬规则白名单过滤，其余 S3 规则同样可降。
// A1-A4 同样可降；A1 的 hard（入库 agent 配置卡）在 applyScopePolicy 里豁免，见下。
const SCOPE_DOWNGRADE_CHECKS = new Set(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'Q3', 'Q4', 'Q5', 'A1', 'A2', 'A3', 'A4']);

// S3 的硬规则：真实密钥即使出现在 tests 里也要按原 force/severity 硬卡（L1 底线）。
// 现在所有 S3（除 S3.weak-default 的测试期望值）都不降级，见 applyScopePolicy。

const JS_TS_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);
const NON_JS_EXTS = new Set(['.py', '.php', '.java', '.go', '.rb', '.rs', '.kt', '.cs']);
// A1 不进语言缺口：agent 配置文件是 JSON/TOML/YAML/MD frontmatter，语言无关。
const LANGUAGE_GAP_CHECKS = ['S1', 'S2', 'S7', 'Q3', 'Q4', 'Q5', 'A2', 'A3', 'A4'];

const TEST_FILE_RE = /\.test\.(?:js|mjs|cjs|ts|jsx|tsx)$/;
const SPEC_FILE_RE = /\.spec\.[^/]+$/;
const E2E_FILE_RE = /\.e2e\.[^/]+$/;
const DASH_TEST_FILE_RE = /-test\.[^/]+$/;

const SCOPE_MESSAGE_SUFFIX = '（非产品路径：不计入结论）';

function normalizePath(rel) {
  return String(rel || '').replace(/\\/g, '/');
}

function baseName(rel) {
  const parts = normalizePath(rel).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
}

function extensionOf(file) {
  const name = baseName(file);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/**
 * 路径是否属于「非产品面」：tests/spec/docs/examples/benchmarks 等目录，或测试命名文件。
 * 反例（contest.js / latest.js / testing/a.js / specification.js / doc-utils.js）必须为 false。
 * @param {string} rel
 * @returns {boolean}
 */
export function isNonProductPath(rel) {
  const normalized = normalizePath(rel);
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((seg, i) => {
    const s = seg.toLowerCase();
    if (!NON_PRODUCT_SEGMENTS.has(s)) return false;
    if (!ROOT_ONLY_SEGMENTS.has(s)) return true;
    // docs/doc：根目录、www/v10/docs 算文档；src/doc 是产品文档引擎，不算。
    return i > 0 ? segments[i - 1].toLowerCase() !== 'src' : true;
  })) return true;
  // Maven 集成测试 src/it/java 是测试面；不泛化 it，避免误伤 src/i18n/it 这类 locale 目录。
  if (/(?:^|\/)src\/it\//i.test(normalized)) return true;
  const base = baseName(rel);
  return TEST_FILE_RE.test(base)
    || SPEC_FILE_RE.test(base)
    || E2E_FILE_RE.test(base)
    || DASH_TEST_FILE_RE.test(base);
}

/**
 * 把非产品路径上的产品类发现降为提示（force='tip'），保留 severity 与其它键。
 * S3 的硬规则、H1/C1/O1/D1-D3 不降级（README/docs 就是它们的产品面）。
 * @param {Array<object>} findings
 * @returns {{findings: Array<object>, downgraded: number}}
 */
export function applyScopePolicy(findings) {
  const input = Array.isArray(findings) ? findings : [];
  let downgraded = 0;
  const out = input.map((finding) => {
    if (!finding || !SCOPE_DOWNGRADE_CHECKS.has(finding.checkId)) return finding;
    // S3 只有「非真实密钥」可降：secrets.mjs 用 hard=false 标记测试夹具/占位值；
    // 真实密钥（AWS/PEM/ghp_/sk- 等）即使出现在 tests/examples 也保持硬卡，L1 底线不被绕过。
    // A1 的 hard（入库 agent 配置的 bypass/通配授权）同理不降：配置文件本身就是产品面。
    if (finding.checkId === 'S3' && finding.rule !== 'S3.weak-default' && finding.hard !== false) return finding;
    if (finding.checkId === 'A1' && finding.hard === true) return finding;
    if (!isNonProductPath(finding.file)) return finding;
    const message = String(finding.message || '');
    downgraded++;
    return {
      ...finding,
      force: 'tip',
      message: message.endsWith(SCOPE_MESSAGE_SUFFIX) ? message : message + SCOPE_MESSAGE_SUFFIX,
      scope: 'non-product',
    };
  });
  return { findings: out, downgraded };
}

/**
 * 检测非 JS 语言覆盖面。两种场景都要报缺口：
 * 1) 仓库完全没有 JS/TS 代码，只有 .py/.php/.java/...（纯 Python/PHP/Java 仓）；
 * 2) 混合仓库里非 JS 产品代码 ≥5 个文件（如 autogen 的 Python 后端 + TS 前端）。
 *    少量脚本/工具不封顶结论，避免把「有几个 .py 脚本」的 JS 仓全判成无法验收。
 * 输入可以是 listTextFiles 返回的绝对路径（需给 rootDir），也可以是相对路径数组。
 * @param {Array<string>} files
 * @param {string} [rootDir]
 * @returns {{nonJsCount: number, jsCount: number, exts: string[], checkIds: string[]}|null}
 */
export function detectLanguageGap(files, rootDir = null) {
  const list = Array.isArray(files) ? files : [];
  let jsCount = 0;
  let nonJsCount = 0;
  const nonJs = new Map();
  for (const file of list) {
    const rel = rootDir ? normalizePath(path.relative(rootDir, file)) : normalizePath(file);
    if (!rel || isNonProductPath(rel)) continue;
    const ext = extensionOf(rel);
    if (!ext) continue;
    if (JS_TS_EXTS.has(ext)) {
      jsCount++;
    } else if (NON_JS_EXTS.has(ext)) {
      nonJsCount++;
      nonJs.set(ext, (nonJs.get(ext) || 0) + 1);
    }
  }
  if (nonJsCount === 0) return null;
  if (jsCount > 0 && nonJsCount < 5) return null;
  return {
    nonJsCount,
    jsCount,
    exts: [...nonJs.keys()].sort(),
    checkIds: [...LANGUAGE_GAP_CHECKS],
  };
}
