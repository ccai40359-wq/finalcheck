import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 审计基线（对标 Semgrep/SARIF 的 baseline）：
//   1) 指纹只认 rule + 归一化路径 + 归一化文本，刻意不含行号 —— 行号漂移不能制造「新增」；
//   2) 匹配优先 hash 精确配对，其次 (checkId, rule, file) 兜底（message 微调但位置未变）；
//   3) 基线读取失败/版本不符/entries 损坏一律 warning 返回，调用方必须按「全部新增」处理（fail closed）。
// 本模块只做纯数据变换与文件读写，不依赖 audit / report，便于独立复用与测试。
export const BASELINE_VERSION = 1;

// 反斜杠统一成 /，去掉前导 ./（只去路径前缀，不做大小写折叠：Windows 下大小写敏感场景宁可多报）
export function normalizePath(p) {
  let s = String(p ?? '').replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

// 空白归一：连续空白（含换行/制表）压成一个空格，并去掉首尾空白。
// 只用于指纹，不改变报告里的原文。
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

// 发现指纹：rule \0 路径 \0 归一化文本（message 优先，缺省回落 snippet）。
// 不含 checkId/severity/line：同一条问题在不同副本、不同行都应视为同一条。
export function fingerprint(finding) {
  const f = finding && typeof finding === 'object' ? finding : {};
  const rule = String(f.rule ?? '');
  const file = normalizePath(f.file);
  const text = normalizeText(f.message || f.snippet || '');
  return createHash('sha256').update(`${rule}\0${file}\0${text}`).digest('hex');
}

function entryLine(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function compareEntries(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
  if (a.checkId !== b.checkId) return a.checkId < b.checkId ? -1 : 1;
  if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;
  return 0;
}

// 当前发现 → 基线快照。entries 按 file/line/rule 稳定排序，同一输入永远得到同一字节序。
export function buildBaseline(findings = [], { tier = null, now = new Date() } = {}) {
  const rows = Array.isArray(findings) ? findings : [];
  const entries = rows.map((f) => ({
    checkId: String(f?.checkId ?? ''),
    rule: String(f?.rule ?? ''),
    file: normalizePath(f?.file),
    line: entryLine(f?.line),
    hash: fingerprint(f),
  })).sort(compareEntries);
  const stamp = now instanceof Date ? now : new Date(now);
  const createdAt = Number.isNaN(stamp.getTime()) ? new Date().toISOString() : stamp.toISOString();
  return { version: BASELINE_VERSION, createdAt, tier: tier ?? null, entries };
}

function keyOf(checkId, rule, file) {
  return `${String(checkId ?? '')}\0${String(rule ?? '')}\0${normalizePath(file)}`;
}

// 当前发现 vs 基线。
//   第一优先：hash 精确配对（同 hash 多条按出现顺序，基线条目也按自身顺序消费）；
//   第二优先：未命中的按 (checkId, rule, file) 配对（同键多条按顺序）；
//   仍未配对的 current = new，仍未配对的 baseline = fixed。
// 返回的 new/fixed/existing 都是原始对象（current 保持传入顺序，fixed 保持基线条目顺序）；
// matchedByHash/matchedByKey 是配对数（不是比例）。
export function matchFindings(current = [], baseline = null) {
  const cur = Array.isArray(current) ? current : [];
  const entries = Array.isArray(baseline?.entries) ? baseline.entries : [];
  const curHashes = cur.map((f) => fingerprint(f));

  const byHash = new Map();
  for (let i = 0; i < entries.length; i++) {
    const h = String(entries[i]?.hash ?? '');
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(i);
  }

  const matchedCur = new Set();
  const matchedBase = new Set();
  let matchedByHash = 0;
  for (let i = 0; i < cur.length; i++) {
    const queue = byHash.get(curHashes[i]);
    if (!queue || !queue.length) continue;
    const bIdx = queue.shift();
    matchedCur.add(i);
    matchedBase.add(bIdx);
    matchedByHash++;
  }

  const byKey = new Map();
  for (let i = 0; i < entries.length; i++) {
    if (matchedBase.has(i)) continue;
    const e = entries[i] || {};
    const k = keyOf(e.checkId, e.rule, e.file);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  }
  let matchedByKey = 0;
  for (let i = 0; i < cur.length; i++) {
    if (matchedCur.has(i)) continue;
    const f = cur[i] || {};
    const queue = byKey.get(keyOf(f.checkId, f.rule, f.file));
    if (!queue || !queue.length) continue;
    const bIdx = queue.shift();
    matchedCur.add(i);
    matchedBase.add(bIdx);
    matchedByKey++;
  }

  return {
    new: cur.filter((_, i) => !matchedCur.has(i)),
    fixed: entries.filter((_, i) => !matchedBase.has(i)),
    existing: cur.filter((_, i) => matchedCur.has(i)),
    matchedByHash,
    matchedByKey,
  };
}

// 读取基线：不存在 → 无基线（null/null）；损坏/版本不符/entries 非数组 → data=null + warning。
// 调用方拿到 warning 时必须把当前全部发现算作 new，绝不能静默当「无基线通过」。
export async function loadBaseline(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { data: null, warning: null };
    return { data: null, warning: `读取失败（${e.message}），本次全部按新增处理` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { data: null, warning: `不是合法 JSON（${e.message}），本次全部按新增处理` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { data: null, warning: '顶层必须是对象，本次全部按新增处理' };
  }
  if (parsed.version !== BASELINE_VERSION) {
    return { data: null, warning: `version 不是 ${BASELINE_VERSION}（实际 ${JSON.stringify(parsed.version)}），本次全部按新增处理` };
  }
  if (!Array.isArray(parsed.entries)) {
    return { data: null, warning: 'entries 必须是数组，本次全部按新增处理' };
  }
  return { data: parsed, warning: null };
}

// 原子写：同目录 tmp 文件写完再 rename，避免进程中断留下半截 JSON。
export async function saveBaseline(file, data) {
  const target = path.resolve(String(file));
  await mkdir(path.dirname(target), { recursive: true });
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
