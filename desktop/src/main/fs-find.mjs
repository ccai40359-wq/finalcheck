// 文件查找（0.33.1，对齐 Claude Code 的 Glob / LS）：
//   glob_files —— 按文件名模式找文件（**/*.ts、src/**/test_*.py），按修改时间新→旧排，最近改过的最可能相关
//   list_dir   —— 列一个目录（目录在前、带大小），用来摸清项目结构
// 都是只读工具：不弹审批，路径闸与 read_file 同一道（在 agent-tools 里套）。
// ripgrep 在就用 `rg --files`（尊重 .gitignore，跳过 node_modules / 构建产物，快）；不在就自己走目录树。
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const GLOB_DEFAULT_MAX = 200;
export const LIST_DEFAULT_MAX = 300;
// 自己走目录树时跳过的目录（rg 会按 .gitignore 跳过，这里是兜底的常见大目录）
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.tox', 'target', '.gradle', '.idea', '.vs', 'coverage', '.cache']);
const WALK_LIMIT = 50000; // 兜底遍历最多看这么多个条目，防止误扫整盘

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** glob → 正则：** 跨目录，* 和 ? 不跨目录，{a,b} 多选；Windows 不区分大小写 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) { re += '\\{'; continue; }
      re += '(?:' + glob.slice(i + 1, end).split(',').map((p) => globToRegExp(p).source.slice(1, -1)).join('|') + ')';
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

/** 没有 / 的模式（*.ts）按「任意深度的文件名」匹配，和 rg / .gitignore 语义一致 */
function matcherFor(pattern) {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const re = globToRegExp(p.includes('/') ? p : '**/' + p);
  return (rel) => re.test(rel);
}

function rgFiles(rg, root, pattern) {
  return new Promise((resolve) => {
    const argv = ['--files', '--hidden', '-g', '!.git', '-g', pattern, '.'];
    let out = '';
    let p;
    try { p = spawn(rg, argv, { cwd: root, windowsHide: true, shell: false }); } catch { return resolve(null); }
    p.stdout.on('data', (d) => { if (out.length < 8_000_000) out += d.toString(); });
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 || code === 1 ? out.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/^\.[\\/]/, '').replace(/\\/g, '/')) : null));
  });
}

async function walkFiles(root, match) {
  const hits = [];
  let seen = 0;
  const stack = [''];
  while (stack.length && seen < WALK_LIMIT) {
    const rel = stack.pop();
    let entries;
    try { entries = await readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(r); }
      else if (match(r)) hits.push(r);
    }
  }
  return { hits, capped: seen >= WALK_LIMIT };
}

/**
 * @returns {Promise<{root, pattern, files:string[], total, truncated, engine, note?}>}
 */
export async function globFiles({ root, pattern, max = GLOB_DEFAULT_MAX, rgPath = null }) {
  const pat = String(pattern || '').trim();
  if (!pat) return { error: 'pattern 必填，例如 **/*.ts、src/**/*.test.js、*.md' };
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(max) || GLOB_DEFAULT_MAX)));
  let files = null;
  let engine = 'walk';
  let capped = false;
  if (rgPath) {
    const got = await rgFiles(rgPath, root, pat.replace(/\\/g, '/'));
    if (got) {
      // rg 的 -g 对带 / 的模式按「相对根」匹配；再用同一套匹配器过一遍，两条路结果一致
      const match = matcherFor(pat);
      files = got.filter(match);
      engine = 'ripgrep';
    }
  }
  if (!files) ({ hits: files, capped } = await walkFiles(root, matcherFor(pat)));
  // 按修改时间新→旧（最多 stat 2000 个；更多时按路径排）
  let sorted = files;
  if (files.length <= 2000) {
    const withTime = await Promise.all(files.map(async (f) => {
      try { return [f, (await stat(path.join(root, f))).mtimeMs]; } catch { return [f, 0]; }
    }));
    sorted = withTime.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map((x) => x[0]);
  } else sorted = [...files].sort();
  const out = sorted.slice(0, limit).map((f) => path.join(root, f));
  const notes = [];
  if (sorted.length > limit) notes.push(`共 ${sorted.length} 个，只列最近修改的 ${limit} 个；模式写具体些或缩小 path`);
  if (capped) notes.push('目录太大，只扫了前 5 万个条目');
  if (engine === 'ripgrep') notes.push('已按 .gitignore 跳过忽略的文件');
  return { root, pattern: pat, files: out, total: sorted.length, truncated: sorted.length > limit, engine, ...(notes.length ? { note: notes.join('；') } : {}) };
}

const fmtSize = (n) => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(1)}M`);

/** 列目录：目录在前（带 /），文件带大小；常见大目录标出来但不展开 */
export async function listDir({ dir, max = LIST_DEFAULT_MAX, showHidden = false }) {
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(max) || LIST_DEFAULT_MAX)));
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) {
    return { error: e?.code === 'ENOENT' ? `目录不存在：${dir}` : e?.code === 'ENOTDIR' ? `不是目录：${dir}（读文件用 read_file）` : `读不了目录：${e?.message || e}` };
  }
  const visible = entries.filter((e) => showHidden || !e.name.startsWith('.') || e.name === '.github' || e.name === '.env.example');
  const dirs = visible.filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  const files = visible.filter((e) => !e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b));
  const lines = [];
  for (const d of dirs) lines.push(`${d}/${SKIP_DIRS.has(d) ? '  (通常不用看)' : ''}`);
  const fileLines = await Promise.all(files.map(async (f) => {
    try { return `${f}  ${fmtSize((await stat(path.join(dir, f))).size)}`; } catch { return f; }
  }));
  lines.push(...fileLines);
  const hidden = entries.length - visible.length;
  return {
    path: dir,
    entries: lines.slice(0, limit),
    dirs: dirs.length,
    files: files.length,
    ...(lines.length > limit ? { truncated: true, note: `共 ${lines.length} 项，只列前 ${limit} 项` } : {}),
    ...(hidden ? { hidden: `${hidden} 个隐藏项未列出（show_hidden:true 可看）` } : {})
  };
}
