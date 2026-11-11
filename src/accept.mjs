import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 可审计的误报豁免（.finalcheck/accept.json）。
// 设计约束：
//   1) 只认 rule + file + line + 行内容指纹（sha256）四项全部一致才生效；
//   2) 文件里那一行改过（哪怕只改一个字符）指纹就变，豁免立即失效并重新报警；
//   3) 条目必须写 reason 与 expires，过期自动失效；
//   4) 生效/失效都进 warnings（报告里可见），绝不静默吞掉。
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

async function lineAt(projectDir, rel, line) {
  const file = path.resolve(projectDir, normalizeRel(rel));
  const root = path.resolve(projectDir);
  // 只允许读项目内文件；绝对路径/.. 逃逸直接不匹配（fail closed）。
  const within = path.relative(root, file);
  if (within.startsWith('..') || path.isAbsolute(within)) return null;
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const n = Number(line);
  if (!Number.isInteger(n) || n < 1 || n > lines.length) return null;
  return lines[n - 1];
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
// 不修改原对象；有效期按 UTC 当日 23:59:59 截止。
export async function applyAcceptances(projectDir, findings, { now = new Date() } = {}) {
  const { entries, warnings } = await loadAcceptConfig(projectDir);
  if (!entries.length) return { findings: findings.slice(), accepted: [], warnings };
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const accepted = [];
  const out = [];
  for (const f of findings) {
    const file = normalizeRel(f.file);
    const line = Number(f.line);
    const entry = entries.find((e) => e.rule === f.rule && e.file === file && e.line === line);
    if (!entry) { out.push(f); continue; }
    if (nowMs > entry.expiresMs) {
      warnings.push(`豁免已过期（${entry.expires}）：${file}:${line} ${entry.rule} 重新计入发现`);
      out.push(f);
      continue;
    }
    const actualLine = await lineAt(projectDir, file, line);
    if (actualLine == null) {
      warnings.push(`豁免未生效（读不到 ${file}:${line}）：${entry.rule} 重新计入发现`);
      out.push(f);
      continue;
    }
    const actualHash = lineFingerprint(actualLine);
    if (actualHash !== entry.hash) {
      warnings.push(`豁免未生效（${file}:${line} 行内容已变）：${entry.rule} 重新计入发现`);
      out.push(f);
      continue;
    }
    accepted.push({
      checkId: f.checkId,
      rule: entry.rule,
      file: entry.file,
      line: entry.line,
      reason: entry.reason,
      expires: entry.expires,
      hash: entry.hash,
      severity: f.severity,
    });
    warnings.push(`已豁免：${file}:${line} ${entry.rule}（理由：${entry.reason}；到期 ${entry.expires}）`);
  }
  return { findings: out, accepted, warnings };
}
