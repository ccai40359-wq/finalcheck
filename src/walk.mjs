import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor']);
// 构建产物目录：跳但不静默（自食教训 2026-11-08：扫 release/out 会把自己打包进去的
// playbooks 教学示例、engines 源码副本当用户代码报出来）。跳过的路径进 pruned，由检查层写进 warnings。
const BUILD_OUTPUT_DIRS = new Set(['release', 'out']);
// electron-builder 的产物目录名千变万化（release-next/win-unpacked、linux-x64-unpacked…），按形态认
const BUILD_OUTPUT_RE = /^[A-Za-z0-9._-]+-unpacked$/;
const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json', '.md', '.yml', '.yaml', '.html', '.css', '.txt', '.py', '.php', '.sh', '.sql', '.cfg', '.conf']);
const MAX_BYTES = 512 * 1024;

// 返回 { files, skipped, pruned }：
// skipped = 超大文件清单（reviewer P1#8：静默跳过=漏检假阴性）
// pruned  = 因构建产物规则跳过的目录（明示，不静默）
export async function listTextFiles(root, excludes = []) {
  const out = [];
  const skipped = [];
  const pruned = [];
  const excluded = (rel) => excludes.some((x) => { const n = String(x).replace(/\\/g, '/'); return rel === n || rel.startsWith(n + '/'); });
  async function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // junction/软链防绕回
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (excluded(rel)) continue; // 目录级剪枝（reviewer P2#13）
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        if (BUILD_OUTPUT_DIRS.has(e.name) || BUILD_OUTPUT_RE.test(e.name)) { pruned.push(rel); continue; }
        await walk(p, depth + 1);
        continue;
      }
      const isEnv = /^\.env($|\.)/i.test(e.name);
      if (e.name.startsWith('.') && !isEnv && e.name !== '.gitignore') continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!isEnv && !TEXT_EXTS.has(ext)) continue;
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      if (st.size > MAX_BYTES) { skipped.push(rel); continue; }
      if (excluded(rel)) continue;
      out.push(p);
    }
  }
  await walk(root, 0);
  return { files: out, skipped, pruned };
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
