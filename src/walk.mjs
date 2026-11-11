import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// 依赖/元数据目录：纯噪声，静默跳过（不是产品代码，也不是构建产物）
const SKIP_DIRS = new Set(['node_modules', '.git', '.finalcheck', 'workflow-runs', 'coverage', '.next', 'vendor']);
// 构建产物目录：跳但不静默（自食教训 2026-11-08：扫 release/out 会把自己打包进去的
// playbooks 教学示例、engines 源码副本当用户代码报出来）。跳过的路径进 pruned，由检查层写进 warnings。
// dist/build 与 release/out 同性质：它们本身就是产物，不是源码；统一按产物剪并明示。
const BUILD_OUTPUT_DIRS = new Set(['release', 'out', 'dist', 'build']);
// electron-builder 的产物目录名千变万化（release-next/win-unpacked、release-0110、linux-x64-unpacked…），按形态认
const BUILD_OUTPUT_RE = /^(?:[A-Za-z0-9._-]+-unpacked|release-[A-Za-z0-9._-]+)$/i;
const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json', '.md', '.yml', '.yaml', '.html', '.css', '.txt', '.py', '.php', '.sh', '.sql', '.cfg', '.conf']);
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);
const MAX_BYTES = 512 * 1024;
const FIXTURE_DIR = 'fixtures';

// 夹具判定的唯一口径：路径里任意一段叫 fixtures（src/fixtures、tests/fixtures、**/fixtures/**）
export function isFixturePath(rel) {
  return String(rel || '').replace(/\\/g, '/').split('/')
    .some((seg) => seg.toLowerCase() === FIXTURE_DIR);
}

// 返回 { files, skipped, pruned, fixtures, overLimit }：
// skipped  = 超大文件清单（reviewer P1#8：静默跳过=漏检假阴性）
// pruned   = 因构建产物规则跳过的目录（明示，不静默）
// fixtures = 因夹具默认豁免跳过的目录（明示；includeFixtures 时为空）
// overLimit = 命中 maxFiles 上限（检查层据此写 warning）
//
// opts：
//   codeOnly       只收代码文件（Q3/Q4/Q5 与 TEXT_EXTS 口径分开的必要开关）
//   maxBytes       单文件上限（默认 512KB，Q3/Q4/Q5 传 1MB）
//   maxFiles       文件数上限（默认不限；超限停下并置 overLimit）
//   maxDepth       目录深度上限（默认 8）
//   includeFixtures 显式把夹具纳入扫描（检查器自测/故意审夹具时用）
export async function listTextFiles(root, excludes = [], opts = {}) {
  const {
    codeOnly = false,
    maxBytes = MAX_BYTES,
    maxFiles = Infinity,
    maxDepth = 8,
    includeFixtures = false,
  } = opts || {};
  const out = [];
  const skipped = [];
  const pruned = [];
  const fixtures = [];
  let overLimit = false;
  const excluded = (rel) => excludes.some((x) => { const n = String(x).replace(/\\/g, '/'); return rel === n || rel.startsWith(n + '/'); });
  async function walk(dir, depth) {
    if (overLimit || depth > maxDepth) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (overLimit) return;
      if (e.isSymbolicLink()) continue; // junction/软链防绕回
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (excluded(rel)) continue; // 目录级剪枝（reviewer P2#13）
        if (SKIP_DIRS.has(e.name.toLowerCase()) || e.name.startsWith('.')) continue;
        if (!includeFixtures && e.name.toLowerCase() === FIXTURE_DIR) { fixtures.push(rel); continue; }
        if (BUILD_OUTPUT_DIRS.has(e.name.toLowerCase()) || BUILD_OUTPUT_RE.test(e.name)) { pruned.push(rel); continue; }
        await walk(p, depth + 1);
        continue;
      }
      const isEnv = /^\.env($|\.)/i.test(e.name);
      if (e.name.startsWith('.') && !isEnv && e.name !== '.gitignore') continue;
      const ext = path.extname(e.name).toLowerCase();
      if (codeOnly ? !CODE_EXTS.has(ext) : (!isEnv && !TEXT_EXTS.has(ext))) continue;
      if (excluded(rel)) continue;
      if (out.length >= maxFiles) { overLimit = true; return; }
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      if (st.size > maxBytes) { skipped.push(rel); continue; }
      out.push(p);
    }
  }
  await walk(root, 0);
  return { files: out, skipped, pruned, fixtures, overLimit };
}

export async function readRel(root, file) {
  const text = await readFile(file, 'utf8').catch(() => '');
  return { file: path.relative(root, file).replace(/\\/g, '/'), text };
}

// 统一的「跳过了什么」提示文案（各检查层共用，避免静默漏检）
export function prunedWarning(pruned) {
  if (!pruned?.length) return null;
  return `已跳过构建产物目录 ${pruned.length} 个（不扫描）：${pruned.slice(0, 3).join('、')}${pruned.length > 3 ? '…' : ''}`;
}

// 夹具默认豁免也要说清楚：那些是「故意写坏」的样本，不是产品代码
export function fixturesWarning(fixtures) {
  if (!fixtures?.length) return null;
  return `已跳过夹具目录 ${fixtures.length} 个（故意写坏的样本不计入产品结论，includeFixtures 可显式纳入）：${fixtures.slice(0, 3).join('、')}${fixtures.length > 3 ? '…' : ''}`;
}
