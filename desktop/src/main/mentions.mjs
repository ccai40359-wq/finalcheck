// @ 文件引用（0.33.1，对齐 Claude Code 的 @file）
//   · 输入框里打 @ → 按项目文件模糊匹配给候选（fileSuggestions）
//   · 发送时把消息里的 @路径 展开：文件内容（带行号）附在这条用户消息后面，目录给一层清单（expandMentions）
// 只展开项目目录里的东西（用户自己打的路径也不越界）；文件 / 总量都有上限，二进制文件跳过。
import { readFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { globFiles } from './fs-find.mjs';

export const MENTION_RE = /(^|\s)@(?:"([^"\n]+)"|([^\s"@]+))/g;
const MAX_FILES = 8;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 600 * 1024;

/** 从文本里找出 @引用（去重，保持顺序） */
export function findMentions(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(MENTION_RE)) {
    const p = (m[2] || m[3] || '').replace(/[),.;:!?，。；：！？）]+$/, '');
    if (!p || seen.has(p)) continue;
    // 0.34.1：@session:<id> 是会话引用，不是文件路径，交给 expandMentions 的会话分支处理
    if (/^session:/i.test(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

const isInside = (root, abs) => {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * @returns {Promise<{ blocks: string[], attached: string[], skipped: Array<{path, reason}> }>}
 */
export async function expandMentions(text, { root, loadSession = null, listSessions = null } = {}) {
  const blocks = [];
  const attached = [];
  const skipped = [];
  // 0.34.1：@ 也能引用**会话**（用户：@ 直接艾特这个项目的会话，让 AI 去翻看会话记录更好）。
  // 语法：@session:<会话 id>（输入框会给这个形状写进文本）。会话记录不在项目目录里，
  // 所以必须先处理，且不受 root 限制。
  const sessionRefs = [...String(text || '').matchAll(/(?:^|\s)@session:([0-9A-Za-z_-]+)/g)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i);
  const sessParts = [];
  if (sessionRefs.length && typeof loadSession === 'function') {
    const MAX_SESSION_BYTES = 200 * 1024;
    for (const sid of sessionRefs.slice(0, 4)) {
      try {
        const s = await loadSession(sid);
        if (!s || !Array.isArray(s.messages)) { skipped.push({ path: '@session:' + sid, reason: '读不到这条会话' }); continue; }
        const title = s.title || '(无标题)';
        const lines = [];
        for (const m of s.messages) {
          const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? 'AI' : String(m.role || ''));
          const body = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content) ? m.content.filter((p) => p?.type === 'text').map((p) => p.text).join(' ') : '';
          if (!body.trim()) continue;
          lines.push(`【${role}】${body.trim()}`);
        }
        let joined = lines.join('\n\n');
        if (joined.length > MAX_SESSION_BYTES) joined = joined.slice(-MAX_SESSION_BYTES) + '\n…（更早的内容已省略）';
        sessParts.push(`<session id="${sid}" title="${title}" turns="${s.messages.length}">\n${joined}\n</session>`);
        attached.push('@session:' + title);
      } catch (e) {
        skipped.push({ path: '@session:' + sid, reason: String(e?.message || e) });
      }
    }
  }
  if (sessParts.length) {
    blocks.push(`【用户用 @ 引用的历史会话（下面是完整对话记录，直接看，不用再去找）】\n${sessParts.join('\n\n')}`);
  }
  if (!root) return { blocks, attached, skipped };
  const base = path.resolve(root);
  let total = 0;
  for (const raw of findMentions(text)) {
    if (attached.length >= MAX_FILES) { skipped.push({ path: raw, reason: `一次最多附 ${MAX_FILES} 个` }); continue; }
    const abs = path.resolve(base, raw);
    if (!isInside(base, abs)) { skipped.push({ path: raw, reason: '不在项目目录里' }); continue; }
    let st;
    try { st = await stat(abs); } catch { continue; } // 不是路径（比如 @someone）：原样留在文字里，不报错
    const rel = path.relative(base, abs).replace(/\\/g, '/') || '.';
    if (st.isDirectory()) {
      let names = [];
      try { names = (await readdir(abs, { withFileTypes: true })).map((e) => e.name + (e.isDirectory() ? '/' : '')).sort(); } catch { /* 忽略 */ }
      blocks.push(`<directory path="${rel}">\n${names.slice(0, 200).join('\n')}${names.length > 200 ? `\n…（共 ${names.length} 项）` : ''}\n</directory>`);
      attached.push(rel + '/');
      continue;
    }
    if (st.size > MAX_FILE_BYTES) { skipped.push({ path: rel, reason: `文件太大（${Math.round(st.size / 1024)}KB），让 AI 用 read_file 分段读` }); continue; }
    if (total + st.size > MAX_TOTAL_BYTES) { skipped.push({ path: rel, reason: '附加内容总量超限' }); continue; }
    let buf;
    try { buf = await readFile(abs); } catch (e) { skipped.push({ path: rel, reason: String(e?.code || e?.message || e) }); continue; }
    if (looksBinary(buf)) { skipped.push({ path: rel, reason: '二进制文件（图片请直接拖进输入框）' }); continue; }
    total += buf.length;
    const lines = buf.toString('utf8').split(/\r?\n/);
    const width = String(lines.length).length;
    blocks.push(`<file path="${rel}">\n${lines.map((l, i) => `${String(i + 1).padStart(width)}\t${l}`).join('\n')}\n</file>`);
    attached.push(rel);
  }
  return { blocks, attached, skipped };
}

/** 把展开结果拼到用户消息上（字符串或多段 content 都支持） */
export function appendMentionBlocks(content, { blocks, skipped }) {
  if (!blocks.length && !skipped.length) return content;
  const note = [
    blocks.length ? '\n\n【用户用 @ 引用的文件（已附上当前内容，不用再 read_file）】\n' + blocks.join('\n\n') : '',
    skipped.length ? '\n\n【这些 @ 引用没有附上】' + skipped.map((s) => `\n- ${s.path}：${s.reason}`).join('') : ''
  ].join('');
  if (typeof content === 'string') return content + note;
  if (Array.isArray(content)) return [...content, { type: 'text', text: note }];
  return content;
}

// ---------------- 候选 ----------------
const cache = new Map(); // root → { at, files: string[] (相对路径) }
const CACHE_MS = 20000;

async function projectFileList(root) {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const r = await globFiles({ root, pattern: '**/*', max: 20000 });
  const files = (r.files || []).map((f) => path.relative(root, f).replace(/\\/g, '/'));
  cache.set(root, { at: Date.now(), files });
  return files;
}

/** 模糊打分：文件名命中 > 路径子串 > 按顺序的子序列；越短越靠前 */
export function scorePath(rel, q) {
  if (!q) return 1;
  const p = rel.toLowerCase();
  const query = q.toLowerCase().replace(/\\/g, '/');
  const name = p.slice(p.lastIndexOf('/') + 1);
  if (name === query) return 1000;
  if (name.startsWith(query)) return 800 - name.length;
  if (name.includes(query)) return 600 - name.length;
  if (p.includes(query)) return 400 - p.length / 10;
  let i = 0;
  for (const ch of p) if (ch === query[i]) i++;
  return i === query.length ? 100 - p.length / 10 : -1;
}

export async function fileSuggestions(root, query, limit = 30, { rgPath = null } = {}) {
  if (!root) return [];
  const base = path.resolve(root);
  let files;
  if (rgPath) {
    const r = await globFiles({ root: base, pattern: '**/*', max: 20000, rgPath });
    files = (r.files || []).map((f) => path.relative(base, f).replace(/\\/g, '/'));
    cache.set(base, { at: Date.now(), files });
  } else files = await projectFileList(base);
  const q = String(query || '').trim();
  // 目录也能引用：从文件路径里取出各级目录
  const dirs = new Set();
  for (const f of files) {
    let i = f.indexOf('/');
    while (i > 0) { dirs.add(f.slice(0, i) + '/'); i = f.indexOf('/', i + 1); }
  }
  const all = [...files, ...dirs];
  if (!q) return files.slice(0, limit);
  return all.map((p) => [p, scorePath(p.replace(/\/$/, ''), q)])
    .filter((x) => x[1] >= 0)
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map((x) => x[0]);
}
