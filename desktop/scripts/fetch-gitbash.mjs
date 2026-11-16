// 为「内置完整 Git for Windows」准备 resources/gitbash-full。
//
// 为什么需要这个脚本：完整 Git 是 392MB / 9296 个文件，不可能进版本库（GitHub 单文件
// 100MB 上限 + 仓库历史永久膨胀）。所以采用「本机准备 + 打包时带上」的常规做法，
// 与 electron-builder 处理 node_modules 的思路一致。
//
// 优先级：
//   ① 本机已装的 Git for Windows（C:\Program Files\Git）→ 直接镜像复制
//   ② 环境变量 FC_GIT_SOURCE 指定的目录
//   ③ 都没有 → 明确报错，提示装 Git for Windows（不静默跳过，避免打出一个没有 bash 的包）
//
// 用法：
//   node scripts/fetch-gitbash.mjs            # 准备（已存在且完整则跳过）
//   node scripts/fetch-gitbash.mjs --force    # 强制重拷
//   node scripts/fetch-gitbash.mjs --check    # 只检查，不复制（CI / 打包前自检用）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// import.meta.url 指向 desktop/scripts/ 下，'../..' 才是仓库根
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z])/, '$1')), '..', '..');
const dest = path.join(repoRoot, 'desktop', 'resources', 'gitbash-full');
const KEEP = ['bin', 'usr', 'mingw64', 'cmd', 'etc', 'dev', 'lib', 'libexec', 'share'];

const args = process.argv.slice(2);
const force = args.includes('--force');
const checkOnly = args.includes('--check');

/** 判断目标目录是否已经是一个可用的 Git 安装。 */
function isReady(dir) {
  const must = [
    path.join(dir, 'bin', 'bash.exe'),
    path.join(dir, 'usr', 'bin', 'bash.exe'),
    path.join(dir, 'cmd', 'git.exe'),
    path.join(dir, 'mingw64', 'bin', 'git.exe')
  ];
  return must.every((p) => fs.existsSync(p));
}

function probeVersion(dir) {
  try {
    const out = execFileSync(path.join(dir, 'cmd', 'git.exe'), ['--version'], { encoding: 'utf8' }).trim();
    return out;
  } catch { return null; }
}

if (checkOnly) {
  if (!isReady(dest)) {
    console.error('✗ 内置 Git 不完整：' + dest);
    console.error('  先运行: node scripts/fetch-gitbash.mjs');
    process.exit(1);
  }
  const v = probeVersion(dest);
  console.log(`✓ 内置 Git 就绪：${v || '(版本未知)'}`);
  const size = execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-ChildItem '${dest}' -Recurse -File | Measure-Object Length -Sum).Sum`], { encoding: 'utf8' }).trim();
  console.log(`  体积: ${(Number(size) / 1048576).toFixed(0)} MB`);
  process.exit(0);
}

if (isReady(dest) && !force) {
  console.log('已存在且完整，跳过复制（要强制重拷加 --force）');
  console.log('  版本: ' + (probeVersion(dest) || '(未知)'));
  console.log('  路径: ' + dest);
  process.exit(0);
}

// 找源
const candidates = [
  process.env.FC_GIT_SOURCE,
  'C:\\Program Files\\Git',
  'C:\\Program Files (x86)\\Git'
].filter(Boolean);

let src = null;
for (const c of candidates) {
  if (fs.existsSync(path.join(c, 'cmd', 'git.exe')) && fs.existsSync(path.join(c, 'bin', 'bash.exe'))) {
    src = c;
    break;
  }
}

if (!src) {
  console.error('✗ 找不到 Git for Windows。');
  console.error('  请先安装 https://git-scm.com/download/win');
  console.error('  或用 FC_GIT_SOURCE 指定一个已安装的 Git 目录。');
  process.exit(2);
}

console.log('源目录: ' + src);
console.log('目标:   ' + dest);
console.log('开始复制（约 390MB / 9000+ 文件，需要一两分钟）…');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

// 只拷运行时需要的顶层目录；跳过 unins*（卸载程序）与文档
const skipped = [];
for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    // 顶层文件：只留 git-bash.exe / git-cmd.exe / LICENSE.txt
    if (['git-bash.exe', 'git-cmd.exe', 'LICENSE.txt'].includes(entry.name)) {
      fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
    } else {
      skipped.push(entry.name);
    }
    continue;
  }
  if (!KEEP.includes(entry.name)) { skipped.push(entry.name + '/'); continue; }
  fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
}

if (skipped.length) console.log('跳过: ' + skipped.join(', '));

if (!isReady(dest)) {
  console.error('✗ 复制后校验失败：关键文件缺失');
  process.exit(3);
}

const v = probeVersion(dest);
console.log('✓ 完成：' + v);
console.log('  路径: ' + dest);
