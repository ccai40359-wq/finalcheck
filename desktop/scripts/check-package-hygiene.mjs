#!/usr/bin/env node
// 打包卫生检查：在 electron-builder 产出 win-unpacked 之后跑，挡住「能打包但装不上」的形态。
//
// 为什么需要（2026-11-11 现场事故）：
//   ZCode 的 Mimosa 钩子会在源码目录里写 `.mimosa/hook-state/<session>.<rand>.baseline/<sha>.source`，
//   文件名很长，拼进安装目录后单条路径达到 259 字符。extraResources 按文件系统拷，不认 .gitignore，
//   于是这批 41 个状态文件被打进安装包。别人机器装在
//   C:\Users\<name>\AppData\Local\Programs\FinalCheck 时，路径超过 Windows 的 260 字符上限 →
//   安装器解压/覆盖失败 → 弹「FinalCheck 无法关闭，请手动关闭后重试」，且点重试永远过不去。
//
// 用法：node scripts/check-package-hygiene.mjs <win-unpacked 目录>
// 退出码：0 通过；1 有违规（同时打印违规清单）
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_PATH_BUDGET = 200; // 安装目录本身约 50 字符，留出余量；超过 200 就认为会踩 260 上限
const FORBIDDEN = [
  { re: /(^|\/)\.mimosa(\/|$)/, why: '编辑器/插件状态目录不该进安装包' },
  { re: /(^|\/)desktop\/config\.json$/, why: '本机配置（含 API Key）绝不能被装进包' },
  { re: /(^|\/)\.git(\/|$)/, why: '版本库元数据不该进安装包' },
];

const root = path.resolve(process.argv[2] || '');
if (!root) {
  console.error('用法：node scripts/check-package-hygiene.mjs <win-unpacked 目录>');
  process.exit(2);
}

const files = [];
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full);
    else files.push(full);
  }
}
await walk(root);

const problems = [];
for (const abs of files) {
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (abs.length > MAX_PATH_BUDGET) problems.push({ kind: 'path', rel, len: abs.length });
  for (const f of FORBIDDEN) {
    if (f.re.test(rel)) problems.push({ kind: 'forbidden', rel, why: f.why });
  }
}

const top = files
  .map((abs) => ({ abs, len: abs.length }))
  .sort((a, b) => b.len - a.len)
  .slice(0, 3);

console.log(`检查目录：${root}`);
console.log(`文件总数：${files.length}`);
console.log('最长的三条路径：');
for (const t of top) console.log(`  ${t.len}  ${t.abs.slice(-90)}`);

if (!problems.length) {
  console.log(`OK：没有超过 ${MAX_PATH_BUDGET} 字符的路径，也没有禁用目录`);
  process.exit(0);
}
console.error(`\n发现 ${problems.length} 条违规：`);
for (const p of problems.slice(0, 30)) {
  if (p.kind === 'path') console.error(`  [路径过长 ${p.len}] ${p.rel}`);
  else console.error(`  [禁用] ${p.rel} —— ${p.why}`);
}
process.exit(1);
