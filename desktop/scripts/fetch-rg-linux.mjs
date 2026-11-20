// 取一个能在 Linux 上跑的 ripgrep 静态二进制，放到 vendor/rg/rg。
//
// 顺序：① 系统已有 rg（apt/dnf/brew 装的）→ 直接用它的绝对路径复制
//      ② 从官方 release 下载 musl 静态构建（14.1.1，全平台单文件、无 glibc 依赖）
//
// 为什么用 musl 静态版：Linux 发行版的 glibc 版本差异极大（Ubuntu 20.04 是 2.31，
// Alpine 根本没有 glibc）。动态链接的 rg 在新机器上会 `GLIBC_2.xx not found`。
// musl 静态版不依赖任何系统库，201MB 的镜像到最小的容器都能跑。
//
// 下载地址固定到某个已发布的 tag，不用 latest——latest 会在无人看顾时悄悄变。
import { existsSync, mkdirSync, copyFileSync, chmodSync, createWriteStream, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const vendorDir = path.join(repoRoot, 'vendor', 'rg');

const RG_VERSION = '14.1.1';
// 只支持 x64 / arm64 —— 和 Electron 官方 Linux 构建的取值范围一致
const ARCH_TARGETS = {
  x64: 'x86_64-unknown-linux-musl',
  arm64: 'aarch64-unknown-linux-musl'
};

const arch = process.argv[2] || process.arch;
const target = ARCH_TARGETS[arch];
if (!target) {
  console.error(`[fetch-rg-linux] 不支持的架构：${arch}（只支持 ${Object.keys(ARCH_TARGETS).join(' / ')}）`);
  process.exit(1);
}

mkdirSync(vendorDir, { recursive: true });
const dest = path.join(vendorDir, 'rg');

// ① 系统已装 rg：优先用它（版本可能更新、也可能更旧，但一定是能跑的）
try {
  const sys = execFileSync('which', ['rg'], { encoding: 'utf8' }).trim();
  if (sys && existsSync(sys)) {
    copyFileSync(sys, dest);
    chmodSync(dest, 0o755);
    const size = statSync(dest).size;
    console.log(`[fetch-rg-linux] 用系统 rg: ${sys} → ${path.relative(repoRoot, dest)} (${(size / 1024).toFixed(0)} KB)`);
    process.exit(0);
  }
} catch { /* 系统没装，走下载 */ }

// ② 官方静态构建
const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-${target}.tar.gz`;
console.log(`[fetch-rg-linux] 下载 ${url}`);

const tmp = path.join(vendorDir, `rg-${RG_VERSION}-${target}.tar.gz`);
try {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(tmp));
  // tar 解开后取内层目录里的 rg
  execFileSync('tar', ['-xzf', tmp, '-C', vendorDir]);
  const inner = path.join(vendorDir, `ripgrep-${RG_VERSION}-${target}`, 'rg');
  if (!existsSync(inner)) throw new Error(`解压后找不到 rg：${inner}`);
  copyFileSync(inner, dest);
  chmodSync(dest, 0o755);
  // 清理中间产物
  unlinkSync(tmp);
  execFileSync('rm', ['-rf', path.join(vendorDir, `ripgrep-${RG_VERSION}-${target}`)]);
  console.log(`[fetch-rg-linux] 就绪: ${path.relative(repoRoot, dest)} (${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
} catch (e) {
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
  console.error(`[fetch-rg-linux] 失败：${e?.message || e}`);
  console.error('[fetch-rg-linux] 备选：apt install ripgrep / brew install ripgrep，然后重跑本脚本（会优先用系统 rg）');
  process.exit(1);
}
