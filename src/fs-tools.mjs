// 文件工具（对齐 dsh 的 read / edit / write）：给 Agent 修代码用。
// 安全边界：本模块本身不做目录白名单（桌面端由 permissions 审批；MCP 由 server.mjs 的 --root 路径监狱在调用前校验）。
// 护栏：只改文本、单文件 ≤2MB、edit 的 old_string 必须唯一、原子写、diff 只回传摘要。
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_READ_LIMIT = 40000;
const DIFF_MAX_LINES = 200;

const toLines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

const normLimit = (n, def) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), 1000), MAX_READ_LIMIT) : def;
};

async function readText(abs) {
  const st = await stat(abs);
  if (!st.isFile()) throw new Error('不是文件');
  if (st.size > MAX_BYTES) throw new Error(`文件过大（${st.size} 字节，上限 2MB）`);
  const text = await readFile(abs, 'utf8');
  if (text.includes('\0')) throw new Error('二进制文件不支持');
  return text;
}

async function atomicWrite(abs, text) {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.${path.basename(abs)}.finalcheck-${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, abs);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// 行级 diff：公共前后缀 + 中间替换；只回传改动附近 2 行上下文，最多 200 行
export function computeDiff(before, after) {
  const a = toLines(before);
  const b = toLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  if (!removed.length && !added.length) return { added: 0, removed: 0, lines: [], truncated: false };
  const lines = [
    ...a.slice(Math.max(0, start - 2), start).map((text) => ({ type: 'ctx', text })),
    ...removed.map((text) => ({ type: 'del', text })),
    ...added.map((text) => ({ type: 'add', text })),
    ...a.slice(endA + 1, Math.min(a.length, endA + 3)).map((text) => ({ type: 'ctx', text }))
  ];
  const truncated = lines.length > DIFF_MAX_LINES;
  return {
    added: added.length,
    removed: removed.length,
    lines: truncated ? lines.slice(0, DIFF_MAX_LINES) : lines,
    truncated
  };
}

const countOccurrences = (text, needle) => {
  let count = 0;
  let i = 0;
  for (;;) {
    i = text.indexOf(needle, i);
    if (i === -1) return count;
    count++;
    i += Math.max(1, needle.length);
  }
};

export async function readFileTool({ path: p, offset = 0, limit = 20000 } = {}) {
  if (!p || typeof p !== 'string') return { error: 'path 必填' };
  const abs = path.resolve(p);
  try {
    const text = await readText(abs);
    const total = text.length;
    let off = Number.isFinite(Number(offset)) ? Math.max(0, Math.trunc(Number(offset))) : 0;
    if (off > total) off = total;
    const lim = normLimit(limit, 20000);
    const content = text.slice(off, off + lim);
    const nextOffset = off + content.length < total ? off + content.length : null;
    return {
      file: path.basename(abs),
      path: abs,
      totalChars: total,
      totalLines: toLines(text).length,
      offset: off,
      content,
      nextOffset,
      truncated: nextOffset != null
    };
  } catch (e) {
    return { error: `读取失败：${e.message}`, path: abs };
  }
}

export async function editFileTool({ path: p, old_string, new_string } = {}) {
  if (!p || typeof p !== 'string') return { error: 'path 必填' };
  if (typeof old_string !== 'string' || old_string === '') return { error: 'old_string 必填且不能为空' };
  if (typeof new_string !== 'string') return { error: 'new_string 必填（可以是空字符串）' };
  if (old_string === new_string) return { error: 'old_string 与 new_string 相同，没有改动' };
  const abs = path.resolve(p);
  let before;
  try {
    before = await readText(abs);
  } catch (e) {
    return { error: `读取失败：${e.message}`, path: abs };
  }
  const count = countOccurrences(before, old_string);
  if (count === 0) return { error: '未找到 old_string：必须与文件内容完全一致（含缩进/换行）', path: abs };
  if (count > 1) return { error: `old_string 在文件中出现 ${count} 次，必须唯一；请带上更多上下文再改`, path: abs };
  const idx = before.indexOf(old_string);
  const after = before.slice(0, idx) + new_string + before.slice(idx + old_string.length);
  try {
    await atomicWrite(abs, after);
  } catch (e) {
    return { error: `写入失败：${e.message}`, path: abs };
  }
  const d = computeDiff(before, after);
  return {
    file: path.basename(abs),
    path: abs,
    added: d.added,
    removed: d.removed,
    diff: d.lines,
    diffTruncated: d.truncated,
    totalLines: toLines(after).length
  };
}

export async function writeFileTool({ path: p, content } = {}) {
  if (!p || typeof p !== 'string') return { error: 'path 必填' };
  if (typeof content !== 'string') return { error: 'content 必填（字符串）' };
  const abs = path.resolve(p);
  let before = '';
  let created = true;
  try {
    const st = await stat(abs);
    if (!st.isFile()) return { error: '目标存在但不是文件', path: abs };
    before = await readText(abs);
    created = false;
  } catch (e) {
    if (e.code !== 'ENOENT') return { error: `读取目标失败：${e.message}`, path: abs };
    const parent = path.dirname(abs);
    try {
      const st = await stat(parent);
      if (!st.isDirectory()) return { error: '父目录不是目录', path: abs };
    } catch {
      return { error: `父目录不存在：${parent}（先创建目录再写文件）`, path: abs };
    }
  }
  try {
    await atomicWrite(abs, content);
  } catch (e) {
    return { error: `写入失败：${e.message}`, path: abs };
  }
  const d = computeDiff(before, content);
  return {
    file: path.basename(abs),
    path: abs,
    created,
    added: d.added,
    removed: d.removed,
    diff: d.lines,
    diffTruncated: d.truncated,
    totalLines: toLines(content).length
  };
}
