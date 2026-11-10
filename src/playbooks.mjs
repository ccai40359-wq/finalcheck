// 方法论库注册表（对齐 deepseek-harness skill catalog + progressive disclosure）
// - 目录只在系统提示里给「编号 / 中文名 / 英文名 / 触发词」，正文按需 read_playbook 加载
// - 入口 SKILL.md 自带文件路由，附属手册用 file + offset 续读（大文件不整块塞进上下文）
// - 路径监狱：topic 只能命中目录清单，file 只能命中该目录 readdir 出来的文件名
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLAYBOOK_ROOT = path.join(REPO_ROOT, 'playbooks', 'web-vuln');

const catalogCache = new Map();

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { name: '', description: '' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { name: '', description: '' };
  const block = text.slice(3, end);
  const name = (block.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || '';
  const description = (block.match(/^description:\s*(.+)$/m) || [])[1]?.trim() || '';
  return { name, description };
}

// 目录名 → 中文短名：去掉编号与末尾英文段（36-401-403绕过-AccessBypass → 401-403绕过）
function cnOf(dir) {
  const rest = dir.replace(/^\d+[-_]/, '');
  const parts = rest.split('-');
  if (parts.length > 1 && /^[A-Za-z][A-Za-z0-9_.]*$/.test(parts[parts.length - 1])) parts.pop();
  return parts.join('-') || rest;
}

// description 里的「Use when ...」才是模型需要的触发词；没有就退整段
function triggersOf(description) {
  const m = String(description).match(/Use when\s+([\s\S]+)$/i);
  const text = (m ? m[1] : description).replace(/\s+/g, ' ').trim();
  return text;
}

function clip(text, n) {
  const s = String(text || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function buildCatalog(root) {
  const dirs = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{1,2}[-_]/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const out = [];
  for (const dir of dirs) {
    const full = path.join(root, dir);
    const names = await readdir(full);
    const files = [];
    for (const name of names) {
      try {
        const st = await stat(path.join(full, name));
        if (st.isFile()) files.push({ name, size: st.size });
      } catch { /* 单个文件读不到不影响目录 */ }
    }
    files.sort((a, b) => (a.name === 'SKILL.md' ? -1 : b.name === 'SKILL.md' ? 1 : a.name.localeCompare(b.name)));
    const id = (dir.match(/^(\d{1,2})/) || [])[1]?.padStart(2, '0') || dir;
    let front = { name: '', description: '' };
    const skill = files.find((f) => f.name.toLowerCase() === 'skill.md');
    if (skill) {
      try { front = parseFrontmatter(await readFile(path.join(full, skill.name), 'utf8')); } catch { /* frontmatter 坏了保留空 */ }
    }
    const name = front.name || dir.replace(/^\d+[-_]/, '').toLowerCase();
    out.push({
      id,
      dir,
      name,
      cn: cnOf(dir),
      title: dir.replace(/^\d+[-_]/, ''),
      description: front.description,
      triggers: triggersOf(front.description),
      files
    });
  }
  return out;
}

export async function loadCatalog(root = PLAYBOOK_ROOT) {
  const key = path.resolve(root);
  if (!catalogCache.has(key)) {
    catalogCache.set(key, buildCatalog(key).catch((e) => { catalogCache.delete(key); throw e; }));
  }
  return catalogCache.get(key);
}

export function clearCatalogCache() { catalogCache.clear(); }

function scoreEntry(entry, raw) {
  const q = String(raw ?? '').trim();
  if (!q) return 0;
  const ql = q.toLowerCase();
  let score = 0;
  if (entry.id === ql.padStart(2, '0') || entry.id === ql) score = Math.max(score, 100);
  if (entry.name.toLowerCase() === ql) score = Math.max(score, 100);
  if (entry.dir.toLowerCase() === ql) score = Math.max(score, 95);
  if (entry.cn.toLowerCase() === ql) score = Math.max(score, 95);
  if (ql.length >= 3 && entry.name.toLowerCase().includes(ql)) score = Math.max(score, 85);
  if (entry.cn.includes(q) || entry.dir.toLowerCase().includes(ql)) score = Math.max(score, 70);
  if (ql.length >= 3 && entry.description.toLowerCase().includes(ql)) score = Math.max(score, 50);
  return score;
}

export function resolveTopic(catalog, raw) {
  const q = String(raw ?? '').trim();
  if (!q) return { error: 'topic 必填：传类目编号（如 11）或英文名（如 ssrf）' };
  const ranked = catalog
    .map((entry) => ({ entry, score: scoreEntry(entry, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    return {
      error: `未找到类目「${q}」`,
      hint: '先用 list_playbooks 看 40 类目录，再用编号或英文名读取（例：11 / ssrf / sql-injection / vuln-report-generate）',
      candidates: catalog.slice(0, 8).map((e) => ({ id: e.id, cn: e.cn, name: e.name }))
    };
  }
  const top = ranked.filter((x) => x.score === ranked[0].score);
  if (top.length === 1) return { entry: top[0].entry };
  // 同分时优先「编号/英文名完全相等」的那一条
  const exact = top.find((x) => x.entry.id === q || x.entry.name.toLowerCase() === q.toLowerCase());
  if (exact) return { entry: exact.entry };
  return {
    error: `类目「${q}」有多个候选，请用编号或英文名指定`,
    ambiguous: true,
    candidates: top.slice(0, 8).map((x) => ({ id: x.entry.id, cn: x.entry.cn, name: x.entry.name }))
  };
}

function resolveFile(entry, raw) {
  const files = entry.files.map((f) => f.name);
  const wanted = String(raw ?? '').trim();
  if (!wanted) return { error: '' };
  // 文件名只允许目录 readdir 里出现过的名字，先挡住一切路径语法
  if (wanted.includes('/') || wanted.includes('\\') || wanted.includes('..') || wanted.includes('\0')) {
    return { error: 'file 只能是该类目目录下的文件名，不能带路径' };
  }
  const lower = wanted.toLowerCase();
  let hits = files.filter((f) => f.toLowerCase() === lower);
  if (!hits.length) hits = files.filter((f) => f.toLowerCase().includes(lower));
  if (!hits.length) hits = files.filter((f) => f.toLowerCase().replace(/\.md$/, '') === lower.replace(/\.md$/, ''));
  if (!hits.length) return { error: `类目「${entry.dir}」下没有文件「${wanted}」`, files };
  if (hits.length > 1) return { error: `文件名「${wanted}」不唯一，请用完整文件名`, files, candidates: hits };
  return { name: hits[0] };
}

const DEFAULT_INLINE = 14000;
const MAX_INLINE = 30000;

export async function readPlaybook({ topic, file, offset = 0, limit = DEFAULT_INLINE, root = PLAYBOOK_ROOT } = {}) {
  const catalog = await loadCatalog(root);
  const hit = resolveTopic(catalog, topic);
  if (!hit.entry) return hit;
  const entry = hit.entry;

  let chosen;
  if (file) {
    const r = resolveFile(entry, file);
    if (r.error) return { dir: entry.dir, name: entry.name, cn: entry.cn, files: entry.files, ...r };
    chosen = r.name;
  } else {
    chosen = entry.files.find((f) => f.name.toLowerCase() === 'skill.md')?.name
      || entry.files.find((f) => /\.md$/i.test(f.name))?.name;
  }
  if (!chosen) return { dir: entry.dir, name: entry.name, cn: entry.cn, error: '该类目没有可读手册' };

  const fullPath = path.join(root, entry.dir, chosen);
  // 路径监狱第二道：目录里若有符号链接指向库外，realpath 必须仍在库内
  const realRoot = await realpath(root);
  const realFull = await realpath(fullPath);
  if (realFull !== realRoot && !realFull.startsWith(realRoot + path.sep)) {
    return { dir: entry.dir, name: entry.name, cn: entry.cn, error: '路径越界（符号链接指向方法论库之外）' };
  }
  const text = await readFile(fullPath, 'utf8');
  const total = text.length;
  let off = Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0;
  let lim = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : DEFAULT_INLINE;
  lim = Math.min(Math.max(lim, 1000), MAX_INLINE);
  if (off > total) off = total;
  const content = text.slice(off, off + lim);
  const nextOffset = off + content.length < total ? off + content.length : null;

  return {
    topic: entry.id,
    dir: entry.dir,
    name: entry.name,
    cn: entry.cn,
    file: chosen,
    path: fullPath,
    files: entry.files,
    totalChars: total,
    offset: off,
    content,
    nextOffset,
    truncated: nextOffset != null,
    hint: nextOffset != null
      ? `还有 ${total - nextOffset} 字符未读：同参数加 offset=${nextOffset} 续读；或用 run_command 在 ${fullPath} 上检索关键词`
      : undefined
  };
}

// 系统提示里的紧凑目录（40 行，约 3-4KB）
export function renderCatalog(catalog, { triggerChars = 64 } = {}) {
  const lines = [
    `## 方法论库（${catalog.length} 类，按需加载）`,
    '做渗透测试前先查目录再动手：命中类目后调 read_playbook(topic=编号或英文名) 读入口 SKILL.md（含文件路由），附属手册用 file + offset 续读。不要凭记忆编造测试步骤。',
    ...catalog.map((e) => `${e.id} ${e.cn}｜${e.name}｜${clip(e.triggers, triggerChars)}`)
  ];
  return lines.join('\n');
}

export function catalogSummary(catalog) {
  return catalog.map((e) => ({
    id: e.id,
    cn: e.cn,
    name: e.name,
    triggers: clip(e.triggers, 120),
    fileCount: e.files.length,
    entry: e.files.find((f) => f.name.toLowerCase() === 'skill.md')?.name || e.files[0]?.name || null
  }));
}
