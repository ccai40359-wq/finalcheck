import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 可审计的误报豁免（.finalcheck/accept.json）。
// 设计约束：
//   1) 以 rule + file + 行内容指纹（sha256）为锚点，声明 line 只是提示位；
//   2) 声明 line 与指纹不符时扫描整个文件：唯一命中则按实际行豁免并警告“行已移动”，
//      多行同指纹视为歧义，fail closed（不豁免，继续报警）；全文件找不到指纹也不豁免；
//   3) 文件里那一行改过（哪怕只改一个字符）指纹就变，且文件里已找不到原指纹，豁免立即失效并重新报警；
//   4) 条目必须写 reason 与 expires，过期自动失效；文件不存在/读不到一律 fail closed；
//   5) 生效/失效都进 warnings（报告里可见），绝不静默吞掉。
export const ACCEPT_FILE = '.finalcheck/accept.json';

const RULE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/;
const HASH_RE = /^[0-9a-f]{32,64}$/;

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

// 行指纹：只对“该行原始文本”做 hash（去掉行尾 \r，保留缩进与空格）。
// 缩进变了也算内容变了：宁可多报一次，也不让豁免覆盖一条新密钥。
export function lineFingerprint(line) {
  return createHash('sha256').update(String(line ?? '').replace(/\r$/, '')).digest('hex');
}

async function readProjectLines(projectDir, rel) {
  const file = path.resolve(projectDir, normalizeRel(rel));
  const root = path.resolve(projectDir);
  // 只允许读项目内文件；绝对路径/.. 逃逸直接不匹配（fail closed）。
  const within = path.relative(root, file);
  if (within.startsWith('..') || path.isAbsolute(within)) return null;
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return null; }
  return text.split('\n');
}

// 指纹优先定位：声明行指纹一致即命中；否则全文件扫描该指纹。
// 返回 { ok: true, line, moved } 或 { ok: false, kind }。
async function resolveEntryLine(projectDir, entry, lineCache) {
  if (!lineCache.has(entry.file)) lineCache.set(entry.file, readProjectLines(projectDir, entry.file));
  const lines = await lineCache.get(entry.file);
  if (!lines) return { ok: false, kind: 'file-missing' };
  const declared = Number(entry.line);
  if (
    Number.isInteger(declared) && declared >= 1 && declared <= lines.length &&
    lineFingerprint(lines[declared - 1]) === entry.hash
  ) {
    return { ok: true, line: declared, moved: false };
  }
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineFingerprint(lines[i]) === entry.hash) matches.push(i + 1);
  }
  if (matches.length === 1) return { ok: true, line: matches[0], moved: true };
  if (matches.length > 1) return { ok: false, kind: 'ambiguous', matches };
  return { ok: false, kind: 'hash-changed' };
}

function parseExpiry(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T23:59:59.999Z`);
  return Number.isFinite(t) ? t : null;
}

async function loadAcceptConfig(projectDir) {
  const warnings = [];
  let raw;
  try {
    raw = await readFile(path.join(projectDir, ACCEPT_FILE), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { entries: [], warnings };
    warnings.push(`豁免文件 ${ACCEPT_FILE} 读取失败（未生效）：${e.message}`);
    return { entries: [], warnings };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    warnings.push(`豁免文件 ${ACCEPT_FILE} 不是合法 JSON（全部未生效）：${e.message}`);
    return { entries: [], warnings };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
    warnings.push(`豁免文件 ${ACCEPT_FILE} 缺少 entries 数组（全部未生效）`);
    return { entries: [], warnings };
  }
  const entries = [];
  for (let i = 0; i < parsed.entries.length; i++) {
    const e = parsed.entries[i];
    const at = `${ACCEPT_FILE} entries[${i}]`;
    if (!e || typeof e !== 'object') { warnings.push(`${at} 不是对象，已忽略`); continue; }
    const rule = String(e.rule || '').trim();
    const file = normalizeRel(e.file);
    const line = Number(e.line);
    const hash = String(e.hash || e.fingerprint || '').trim().toLowerCase();
    const reason = String(e.reason || '').trim();
    const expires = String(e.expires || '').trim();
    if (!RULE_RE.test(rule)) { warnings.push(`${at} rule 非法，已忽略`); continue; }
    if (!file || file.startsWith('/') || file.includes('..') || path.isAbsolute(file)) { warnings.push(`${at} file 非法，已忽略`); continue; }
    if (!Number.isInteger(line) || line < 1) { warnings.push(`${at} line 必须是正整数，已忽略`); continue; }
    if (!HASH_RE.test(hash)) { warnings.push(`${at} 缺少有效行指纹 hash，已忽略（fail closed）`); continue; }
    if (!reason) { warnings.push(`${at} 缺少 reason，已忽略`); continue; }
    const expiresMs = parseExpiry(expires);
    if (!expiresMs) { warnings.push(`${at} expires 必须是 YYYY-MM-DD，已忽略`); continue; }
    entries.push({ rule, file, line, hash, reason, expires, expiresMs });
  }
  return { entries, warnings };
}

// findings 进来，被豁免的移出 findings，并返回可审计清单。
// 匹配顺序：rule+file 候选 → 按指纹定位实际行 → 与实际行号比对；
// 声明行漂移但指纹唯一时仍豁免，accepted 用实际行号并保留 declaredLine。
// 不修改原对象；有效期按 UTC 当日 23:59:59 截止。
export async function applyAcceptances(projectDir, findings, { now = new Date() } = {}) {
  const { entries, warnings } = await loadAcceptConfig(projectDir);
  if (!entries.length) return { findings: findings.slice(), accepted: [], warnings };
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const lineCache = new Map();
  const resolved = new Map();
  const warned = new Set();
  const accepted = [];
  const out = [];

  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push(message);
  };
  const resolve = (entry) => {
    if (!resolved.has(entry)) resolved.set(entry, resolveEntryLine(projectDir, entry, lineCache));
    return resolved.get(entry);
  };

  for (const f of findings) {
    const file = normalizeRel(f.file);
    const line = Number(f.line);
    const candidates = entries.filter((e) => e.rule === f.rule && e.file === file);
    let exempted = false;
    for (const entry of candidates) {
      const key = `${entry.rule}|${entry.file}|${entry.line}|${entry.hash}`;
      if (nowMs > entry.expiresMs) {
        warnOnce(`${key}|expired`, `豁免已过期（${entry.expires}）：${file}:${entry.line} ${entry.rule} 重新计入发现`);
        continue;
      }
      const location = await resolve(entry);
      if (!location.ok) {
        if (location.kind === 'file-missing') {
          warnOnce(`${key}|missing`, `豁免未生效（读不到 ${entry.file}:${entry.line}）：${entry.rule} 重新计入发现`);
        } else if (location.kind === 'ambiguous') {
          warnOnce(`${key}|ambiguous`, `豁免未生效（${entry.file} 中有 ${location.matches.length} 行同指纹（第 ${location.matches.join('、')} 行），无法唯一定位）：${entry.rule} 重新计入发现（fail closed）`);
        } else {
          warnOnce(`${key}|changed`, `豁免未生效（${entry.file}:${entry.line} 行内容已变）：${entry.rule} 重新计入发现`);
        }
        continue;
      }
      // 历史提交的 finding 行号是旧提交的行；指纹定位到当前行即可豁免。
      if (location.line !== line && !String(f.rule).startsWith('S3.history-')) continue;
      exempted = true;
      if (location.moved) {
        warnOnce(`${key}|moved`, `豁免行已移动：${entry.file}:${entry.line} → ${location.line}（${entry.rule}）`);
      }
      accepted.push({
        checkId: f.checkId,
        rule: entry.rule,
        file: entry.file,
        line: location.line,
        declaredLine: entry.line,
        reason: entry.reason,
        expires: entry.expires,
        hash: entry.hash,
        severity: f.severity,
      });
      warnings.push(`已豁免：${file}:${location.line} ${entry.rule}（理由：${entry.reason}；到期 ${entry.expires}${location.moved ? `；声明行 ${entry.line}` : ''}）`);
      break;
    }
    if (!exempted) out.push(f);
  }
  return { findings: out, accepted, warnings };
}
