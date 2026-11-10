// 项目档案记忆（对齐 deepseek-harness 设计②，deepseek-harness 没有的差异化能力）：
// 每次 agent 体检成功落一条档案到 desktop/memory/projects.json（已 gitignore），
// 后续对话按路径命中注入「已知项目档案」摘要。路径 key 小写规范化（分隔符统一 /，去尾分隔符），
// Windows 大小写/斜杠差异也能命中；子路径（档案项目的下级目录）同样命中。
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'memory');
// 测试可通过环境变量把存储指到临时目录（生产默认 desktop/memory/）
const memDir = () => process.env.FINALCHECK_MEMORY_DIR || DEFAULT_DIR;
const fileOf = () => path.join(memDir(), 'projects.json');

export const normKey = (p) =>
  String(p || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();

// 从自由文本中提取可能的路径（Windows 盘符 + 常见 Unix 绝对路径），容忍中文标点收尾
export function extractPaths(text) {
  const out = [];
  const re = /(?:[A-Za-z]:[\\/][^\s"'`，。；！）)】\]|]+|\/(?:home|Users|root|var|opt|srv|mnt|media|data|workspace)\/[^\s"'`，。；！）)】\]|]+)/g;
  const seen = new Set();
  for (const m of String(text || '').matchAll(re)) {
    const p = m[0].replace(/[.,;:]+$/, '');
    if (p && !seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); out.push(p); }
  }
  return out;
}

// 同路径并发读改写串行化（同 sessions.mjs 的做法）
let queue = Promise.resolve();
const withQueue = (fn) => { const next = queue.catch(() => {}).then(fn); queue = next; return next; };

async function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, file);
}

async function loadAll() {
  try { return JSON.parse(await readFile(fileOf(), 'utf8')); } catch { return {}; } // 无文件/损坏 JSON 都按空档案起步，不崩
}

// dir：项目路径；auditResult：audit() 返回值（兼容 { verdict, findings } 简形）
export async function recordAudit(dir, auditResult) {
  const key = normKey(dir);
  if (!key) return null;
  const r = auditResult && typeof auditResult === 'object' ? auditResult : {};
  const findings = Array.isArray(r.findings) ? r.findings : [];
  const count = (sev) => findings.filter((f) => f?.severity === sev).length;
  const entry = {
    at: Date.now(),
    tier: r.tier?.effective ?? (typeof r.tier === 'string' ? r.tier : null),
    verdict: r.verdict ?? r.conclusion?.verdict ?? null,
    high: count('high'),
    medium: count('medium'),
    low: count('low')
  };
  return withQueue(async () => {
    const all = await loadAll();
    const name = path.basename(String(dir)) || String(dir);
    const rec = all[key] || { path: String(dir), name, audits: [], lastAt: 0 };
    rec.path = rec.path || String(dir);
    rec.name = rec.name || name;
    rec.audits.push(entry);
    if (rec.audits.length > 50) rec.audits = rec.audits.slice(-50); // 防档案无限膨胀
    rec.lastAt = entry.at;
    all[key] = rec;
    await mkdir(memDir(), { recursive: true });
    await atomicWrite(fileOf(), JSON.stringify(all, null, 2));
    return entry;
  });
}

// dir：查询路径（档案项目本身或其子路径）→ 一行式档案摘要；无命中返回 null
export async function projectContext(dir) {
  const key = normKey(dir);
  if (!key) return null;
  const all = await loadAll();
  let best = null;
  let bestLen = -1;
  for (const [k, rec] of Object.entries(all || {})) {
    if (!rec || !Array.isArray(rec.audits) || !rec.audits.length) continue;
    if (key === k || key.startsWith(k + '/')) {
      if (k.length > bestLen) { best = rec; bestLen = k.length; } // 多命中取最具体（最长）路径
    }
  }
  if (!best) return null;
  const last = best.audits[best.audits.length - 1];
  const when = new Date(last.at).toISOString().slice(0, 16).replace('T', ' ');
  return `项目「${best.name}」（${best.path}）已有体检档案：最近一次 ${when}，tier=${last.tier ?? '未知'}，verdict=${last.verdict ?? '未知'}（高危 ${last.high} / 中危 ${last.medium} / 低危 ${last.low}），共 ${best.audits.length} 次记录，可作为本次分析的背景参考。`;
}
