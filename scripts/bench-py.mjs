// Python 准确率基准：对 tests/benchmark/python/* 下的标注项目跑 L2 体检，按源码里的标记打分。
//
// 标记写法（写在漏洞所在行或安全写法所在行的行尾注释里）：
//   # EXPECT: S2 sqli   该行有真实漏洞，期望报出 S2（行号 ±3 内命中即算检出）
//   # SAFE: S2          该行是看起来像漏洞的安全写法，报出 S2 即算误报
// 没有标记的行上报出的 S* 发现进「未标注」清单，供人工复核（不计入误报，也不计入检出）。
//
// 用法：node scripts/bench-py.mjs [项目名...] [--json out.json] [--extra <任意目录>]
//   --extra：额外跑一个没有标注的真实项目（如 PyGoat / Requests），只输出按检查项的分布，用来看噪声。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../src/audit.mjs';
import { listTextFiles } from '../src/walk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchRoot = path.join(root, 'tests', 'benchmark', 'python');
const MARK_RE = /#\s*(EXPECT|SAFE):\s*(S\d+)(?:\s+([\w-]+))?/;
// 训练集：规则是对着它们修的；盲测集：规则改完后另写、刻意换写法，用来看泛化（不要对着它们调规则）
const TRAIN = ['flask-shop', 'django-blog', 'fastapi-notes'];
const HOLDOUT = ['holdout-flask-bp', 'holdout-drf', 'holdout-fastapi-annotated'];
const LABELLED = [...TRAIN, ...HOLDOUT];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const jsonOut = opt('--json');
const fromFile = opt('--from'); // 复用上次保存的扫描结果，只重新打分（改标注/打分规则时用）
const extras = [];
for (let e = opt('--extra'); e; e = opt('--extra')) extras.push(path.resolve(e));
const picked = args.includes('--holdout') ? HOLDOUT : args.includes('--train') ? TRAIN : (args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : LABELLED);

const norm = (f) => String(f || '').replace(/\\/g, '/').replace(/^\.\//, '');

const raw = {};
const cached = fromFile ? (JSON.parse(await readFile(fromFile, 'utf8')).raw || {}) : {};

async function readMarks(dir) {
  const files = (await listTextFiles(dir, []).catch(() => ({ files: [] }))).files || [];
  const resolved = files.map((f) => path.resolve(f));
  const marks = [];
  for (const abs of resolved) {
    const rel = norm(path.relative(dir, abs));
    if (!/(?:\.(py|txt|toml|cfg)|(?:^|\/)\.env)$/.test(rel)) continue;
    const lines = (await readFile(abs, 'utf8')).split(/\r?\n/);
    lines.forEach((text, i) => {
      // 一行可以有多个标记：`# EXPECT: S1 x  # EXPECT: S7 y`（类视图的 S1/S7 都落在 class 行）
      for (const m of text.matchAll(new RegExp(MARK_RE.source, 'g'))) marks.push({ type: m[1], checkId: m[2], kind: m[3] || '', file: rel, line: i + 1 });
    });
  }
  return marks;
}

// EXPECT：同检查项、同文件、行号 ±3。SAFE：同检查项、同文件、同一行；S1 允许落在上方 3 行内的装饰器上。
const hitsExpect = (f, m) => f.checkId === m.checkId && norm(f.file) === m.file && Math.abs(Number(f.line) - m.line) <= 3;
const hitsSafe = (f, m) => f.checkId === m.checkId && norm(f.file) === m.file
  && (Number(f.line) === m.line || (m.checkId === 'S1' && m.line - Number(f.line) >= 0 && m.line - Number(f.line) <= 3));

async function scoreProject(dir) {
  const marks = await readMarks(dir);
  const started = Date.now();
  const rep = cached[path.basename(dir)] || await audit(dir, { tier: 'L2', interactive: false, runTests: false });
  raw[path.basename(dir)] = { findings: rep.findings, conclusion: rep.conclusion, gates: rep.gates };
  // tip 只是列出来的提醒，不计入结论——不算误报/未标注，单独计数
  const sec = rep.findings.filter((f) => /^S\d/.test(f.checkId) && f.force !== 'tip');
  const tips = rep.findings.filter((f) => /^S\d/.test(f.checkId) && f.force === 'tip').length;
  const used = new Set();
  const tp = []; const fn = []; const fp = [];
  for (const m of marks.filter((x) => x.type === 'EXPECT').sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    // 每条发现只能算一次检出，取行号最近的那条（避免一条 DEBUG 发现同时「命中」相邻的 ALLOWED_HOSTS）
    const f = sec.filter((x) => !used.has(x) && hitsExpect(x, m))
      .sort((a, b) => Math.abs(a.line - m.line) - Math.abs(b.line - m.line))[0];
    if (f) { tp.push(m); used.add(f); } else fn.push(m);
  }
  for (const m of marks.filter((x) => x.type === 'SAFE')) {
    const f = sec.find((x) => hitsSafe(x, m));
    if (f) { fp.push({ ...m, rule: f.rule, message: String(f.message || '').slice(0, 120) }); used.add(f); }
  }
  const unlabelled = sec.filter((f) => !used.has(f)).map((f) => ({ checkId: f.checkId, rule: f.rule, file: norm(f.file), line: f.line, message: String(f.message || '').slice(0, 120) }));
  return {
    project: path.basename(dir), ms: Date.now() - started, verdict: rep.conclusion.verdict,
    gaps: rep.gates?.gaps || [], expected: tp.length + fn.length, tp, fn, fp, unlabelled, tips,
    safeTotal: marks.filter((x) => x.type === 'SAFE').length,
  };
}

async function profileExtra(dir) {
  const started = Date.now();
  const rep = await audit(dir, { tier: 'L2', interactive: false, runTests: false });
  const by = {};
  for (const f of rep.findings) { const k = `${f.checkId}/${f.rule}`; by[k] = (by[k] || 0) + 1; }
  return { project: path.basename(dir), ms: Date.now() - started, verdict: rep.conclusion.verdict, total: rep.findings.length, gaps: rep.gates?.gaps || [], byRule: by };
}

const results = [];
for (const name of picked) results.push(await scoreProject(path.join(benchRoot, name)));
const extraResults = [];
for (const dir of extras) extraResults.push(await profileExtra(dir));

let T = 0; let E = 0; let FP = 0; let S = 0; let U = 0;
for (const r of results) {
  T += r.tp.length; E += r.expected; FP += r.fp.length; S += r.safeTotal; U += r.unlabelled.length;
  console.log(`\n=== ${r.project}  检出 ${r.tp.length}/${r.expected}  误报 ${r.fp.length}/${r.safeTotal}  未标注 ${r.unlabelled.length}  提示 ${r.tips}  (${Math.round(r.ms / 1000)}s, ${r.verdict})`);
  for (const m of r.fn) console.log(`  漏报 ${m.checkId} ${m.kind.padEnd(22)} ${m.file}:${m.line}`);
  for (const m of r.fp) console.log(`  误报 ${m.checkId} ${String(m.rule).padEnd(22)} ${m.file}:${m.line}  ${m.message}`);
  for (const u of r.unlabelled) console.log(`  未标注 ${u.checkId} ${String(u.rule).padEnd(20)} ${u.file}:${u.line}  ${u.message}`);
  for (const g of r.gaps) console.log(`  缺口 ${String(g).slice(0, 160)}`);
}
console.log(`\n总计：检出率 ${T}/${E} = ${E ? (100 * T / E).toFixed(1) : '-'}%  ｜ 安全写法误报 ${FP}/${S}  ｜ 未标注发现 ${U}`);
for (const x of extraResults) {
  console.log(`\n=== [无标注] ${x.project}  共 ${x.total} 条 (${Math.round(x.ms / 1000)}s, ${x.verdict})`);
  for (const [k, v] of Object.entries(x.byRule).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ at: new Date().toISOString(), results, extraResults, raw }, null, 2));
