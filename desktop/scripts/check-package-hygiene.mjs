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
// 退出码：0 通过；1 有违规；2 参数错误或目录无法检查。
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// 模拟 Windows 按用户安装到默认目录，示例用户名占 11 个字符。
// MAX_PATH 的 260 个字符包含结尾的 NUL，路径最多使用 259 个字符。
const INSTALL_ROOT = 'C:\\Users\\ExampleUser\\AppData\\Local\\Programs\\FinalCheck';
const MAX_INSTALL_PATH = 259;
const MAX_RELATIVE_PATH = MAX_INSTALL_PATH - INSTALL_ROOT.length - 1;
// desktop/package.json 配置 productName=FinalCheck、asar=false，打包时会带上应用清单。
const EXECUTABLE_PATH = 'FinalCheck.exe';
const MANIFEST_PATH = 'resources/app/package.json';
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const FORBIDDEN = [
  { re: /(^|\/)\.mimosa$/i, why: '编辑器/插件状态目录不该进安装包' },
  { re: /(^|\/)desktop\/config\.json$/i, why: '本机配置（含 API Key）绝不能被装进包' },
  { re: /(^|\/)\.git$/i, why: '版本库元数据不该进安装包' },
  // 2026-11-23 用户拍板：测试台**不进 exe**（安装包保持干净）。
  // 这不是"暂时没打进去"，而是一条要长期守住的约束 —— 所以把它变成自动检查：
  // scripts/ 有 testbench/probe/e2e/bench 等内部探测脚本，tests/ 有 2000+ 项测试；
  // 它们都需要仓库结构（electron + node_modules）才能跑，装到用户机器上既跑不起来也污染包。
  { re: /(^|\/)resources\/scripts(\/|$)/i, why: '开发测试台（testbench/probe/e2e）不该进安装包（用户拍板）' },
  { re: /(^|\/)resources\/tests(\/|$)/i, why: '单元/集成测试不该进安装包' },
  { re: /(^|\/)resources\/.*\/scripts\/testbench-/i, why: '测试台脚本不该进安装包' },
  { re: /(^|\/)resources\/.*\/probe-[a-z-]+\.mjs$/i, why: '探针脚本不该进安装包' },
  { re: /(^|\/)resources\/.*\/e2e-[a-z-]+\.mjs$/i, why: '端到端验收脚本不该进安装包' },
];

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0].trim()) {
  console.error('用法：node scripts/check-package-hygiene.mjs <win-unpacked 目录>');
  process.exit(2);
}

const root = path.resolve(args[0]);
const entries = new Map();
let fileCount = 0;

async function walk(dir, parent = '') {
  const children = await readdir(dir, { withFileTypes: true });
  for (const entry of children) {
    const rel = parent ? `${parent}/${entry.name}` : entry.name;
    entries.set(rel, entry);
    if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
    else fileCount++;
  }
}

try {
  await walk(root);
} catch (error) {
  console.error(`无法检查打包目录：${root}\n${error.message}`);
  process.exit(2);
}

const packageShape = [];
const executable = entries.get(EXECUTABLE_PATH)?.isFile()
  ? await lstat(path.join(root, EXECUTABLE_PATH)).catch(() => null)
  : null;
if (!executable?.isFile() || executable.size === 0) {
  packageShape.push(`[打包结构] ${EXECUTABLE_PATH} —— 缺少非空的应用程序文件`);
}

let manifest;
if (entries.get(MANIFEST_PATH)?.isFile()) {
  try {
    manifest = JSON.parse(await readFile(path.join(root, MANIFEST_PATH), 'utf8'));
  } catch {
    // 统一报告不可读及无效的清单，避免把清单内容混进终端输出。
  }
}
if (manifest?.name !== 'finalcheck-desktop'
  || typeof manifest.version !== 'string'
  || !PACKAGE_VERSION.test(manifest.version)) {
  packageShape.push(`[打包结构] ${MANIFEST_PATH} —— 需要可读取的 finalcheck-desktop 清单和有效的版本号`);
}

const forbidden = [];
const longPaths = [];
for (const rel of entries.keys()) {
  if (rel.length > MAX_RELATIVE_PATH) longPaths.push(`[路径过长 ${rel.length}] ${rel}`);
  for (const { re, why } of FORBIDDEN) {
    if (re.test(rel)) forbidden.push(`[禁用] ${rel} —— ${why}`);
  }
}
const problems = [...packageShape, ...forbidden, ...longPaths];

console.log(`检查目录：${root}`);
console.log(`模拟安装目录：${INSTALL_ROOT}（相对路径上限：${MAX_RELATIVE_PATH} 字符）`);
console.log(`文件总数：${fileCount}`);
console.log('最长的三条打包相对路径：');
const top = [...entries.keys()].sort((a, b) => b.length - a.length).slice(0, 3);
for (const rel of top) console.log(`  ${rel.length}  ${rel}`);

if (!problems.length) {
  console.log('OK：打包结构及路径符合要求，未发现禁用条目');
  process.exit(0);
}

console.error(`\n发现 ${problems.length} 条违规：`);
for (const problem of problems.slice(0, 30)) console.error(`  ${problem}`);
process.exit(1);
