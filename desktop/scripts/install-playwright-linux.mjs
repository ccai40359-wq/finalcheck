// Linux / macOS 首启依赖准备：Playwright 浏览器。
//
// 为什么不把浏览器打进包：Chromium 一个就 150MB+，加上 FFmpeg 和系统依赖，
// AppImage 会从 ~250MB 涨到 400MB+。用户大部分时间并不截图，
// 所以改成「需要时按需装」：第一次用到 capture_screenshot 且没有浏览器时提示安装。
//
// 这个脚本是给「装完就想全功能可用」的用户跑的（也可由打包/CI 调用）：
//   node desktop/scripts/install-playwright-linux.mjs
//
// 参数：
//   --with-deps  同时用 apt/dnf/zypper 装系统库（需要 sudo）。CI 与全新机器用这个。
//   --dry-run    只检查，不下载。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const args = process.argv.slice(2);
const withDeps = args.includes('--with-deps');
const dryRun = args.includes('--dry-run');

const log = (...a) => console.log('[playwright-linux]', ...a);

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: desktopRoot, shell: false });
  return r.status ?? 1;
}

/**
 * 浏览器是否已就绪。
 *
 * ⚠️ 2026-11-20 实测坑：`chromium.executablePath()` 只反映**完整浏览器**目录，
 * 而 `chromium.launch()` 默认用 **headless shell**（chrome-headless-shell）。
 * 两者是分开下载的两份产物 —— 只装了前者时 executablePath() 非空，
 * 但真截图会报 `Executable doesn't exist at .../chromium_headless_shell-XXXX`。
 * 所以「就绪」必须两份都在。目录布局：
 *   <browsers>/chromium-1255/chrome-linux64/chrome
 *   <browsers>/chromium_headless_shell-1255/chrome-headless-shell-linux64/...
 */
async function browsersReady() {
  try {
    const { chromium } = await import('playwright');
    const full = chromium.executablePath?.();
    if (!full || !existsSync(full)) return { ready: false };
    // 从完整浏览器的路径反推出同版本的 headless shell 目录
    const parent = path.dirname(path.dirname(full)); // .../ms-playwright/chromium-<ver>
    const version = parent.match(/chromium-(\d+)/)?.[1];
    if (!version) return { ready: true, path: full }; // 反推不出就认为够用（非标准布局）
    const shellRoot = path.join(path.dirname(parent), `chromium_headless_shell-${version}`);
    if (!existsSync(shellRoot)) return { ready: false, missing: 'headless shell', full };
    return { ready: true, path: full };
  } catch (e) {
    return { ready: false, error: e?.message || String(e) };
  }
}

const state = await browsersReady();
if (state.ready) {
  log('浏览器已就绪:', state.path);
  if (!withDeps) process.exit(0);
} else {
  if (state.error) log('playwright 模块有问题:', state.error);
  if (state.missing === 'headless shell') log('完整浏览器在，但缺 headless shell（截图默认走它）——补装中…');
  log('准备下载 Chromium…');
}

if (dryRun) {
  log('（--dry-run：不实际下载）');
  process.exit(0);
}

// 用**本地已安装的** playwright CLI，不要用 npx：
// npx playwright 在没进 PATH / 没全局安装时会直接失败（2026-11-20 在 WSL 实测
// `npx playwright` → "playwright: not found"），而本地依赖必然存在。
const cliEntry = path.join(desktopRoot, 'node_modules', 'playwright', 'cli.js');
if (!existsSync(cliEntry)) {
  log('本地没有 playwright CLI，先跑：cd desktop && npm install');
  process.exit(1);
}
const cliArgv = [cliEntry, 'install'];
if (withDeps) cliArgv.push('--with-deps');
cliArgv.push('chromium');
const code = run(process.execPath, cliArgv);

if (code !== 0) {
  log('下载失败。可以手动执行：');
  log(withDeps ? '  cd desktop && node scripts/install-playwright-linux.mjs --with-deps' : '  cd desktop && node scripts/install-playwright-linux.mjs');
  log('国内网络慢的话可设 PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright');
  process.exit(code);
}

const after = await browsersReady();
if (after.ready) {
  log('完成:', after.path);
  process.exit(0);
}
log('下载命令执行完，但浏览器/headless shell 仍缺失——请检查 PLAYWRIGHT_BROWSERS_PATH');
process.exit(1);
