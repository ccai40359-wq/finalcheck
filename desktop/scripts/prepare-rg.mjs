// 打包前把**当前目标平台**的 ripgrep 二进制放进 desktop/resources/rg/。
//
// 为什么需要这一步：extraResources 原来硬写 `../vendor/rg/rg.exe`。
// 打 Linux 包时它照样会被塞进去——包里有个 Windows 二进制，
// 能打包成功，但 Linux 上执行不了，grep_code 会静默降级成「没有 rg」。
// 这个失败模式很难查：打包不报错、启动不报错，只有搜索时悄悄变慢/降级。
//
// 做法：按目标平台找源二进制，复制到 desktop/resources/rg/<bin>，
// extraResources 指向这个固定目录（目录内容随构建平台变化）。
import { existsSync, mkdirSync, copyFileSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const repoRoot = path.resolve(desktopRoot, '..');
const destDir = path.join(desktopRoot, 'resources', 'rg');
const platform = process.argv[2] || process.platform;
const binName = platform === 'win32' ? 'rg.exe' : 'rg';
const dest = path.join(destDir, binName);

// 源候选：仓库 vendor/（Windows 现有约定）→ 系统 PATH 上的 rg
const candidates = [
  path.join(repoRoot, 'vendor', 'rg', binName),
  path.join(repoRoot, 'vendor', 'rg', 'rg')  // Linux 产物可能就叫 rg
];

const found = candidates.find((p) => existsSync(p));
if (!found) {
  console.error(`[prepare-rg] 找不到 ${platform} 的 ripgrep 二进制。`);
  console.error(`[prepare-rg] 期望位置：${candidates.join(' 或 ')}`);
  console.error('[prepare-rg] Linux/macOS 先跑：node desktop/scripts/fetch-rg-linux.mjs');
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(found, dest);
if (platform !== 'win32') {
  // 复制会丢执行位，必须补回 +x，否则打出来的包里 rg 不可执行
  chmodSync(dest, 0o755);
}
const size = statSync(dest).size;
console.log(`[prepare-rg] ${platform} → ${path.relative(repoRoot, dest)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
