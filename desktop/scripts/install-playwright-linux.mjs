// Linux 首启依赖准备：Playwright 浏览器。
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const args = process.argv.slice(2);
const withDeps = args.includes('--with-deps');
const dryRun = args.includes('--dry-run');

const log = (...a) => console.log('[playwright-linux]', ...a);

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: desktopRoot, shell: false, ...opts });
  return r.status ?? 1;
}

// 先看浏览器是否已就绪：已就绪就跳过下载（重复跑很快）
async function browsersReady() {
  try {
    const { chromium } = await import('playwright');
    const p = chromium.executablePath?.();
    if (p) return { ready: true, path: p };
    return { ready: false };
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
  log('准备下载 Chromium…');
}

if (dryRun) {
  log(dryRun ? '（--dry-run：不实际下载）' : '');
  process.exit(0);
}

// package.json 里 playwright 是本地依赖，用 npx 会拿它自己的 CLI
const argv = ['playwright', 'install', 'chromium'];
if (withDeps) argv.unshift('--with-deps'); // playwright install --with-deps chromium
// 注意 --with-deps 会调系统包管理器，需要 sudo；在容器里通常已是 root
const code = run(process.platform === 'win32' ? 'npx.cmd' : 'npx', withDeps
  ? ['--yes', 'playwright@' + (process.env.PLAYWRIGHT_VERSION || '1.65.1'), 'install', '--with-deps', 'chromium']
  : ['--yes', 'playwright@' + (process.env.PLAYWRIGHT_VERSION || '1.65.1'), 'install', 'chromium']);

if (code !== 0) {
  log('下载失败。可以手动执行：');
  log('  cd desktop && npx playwright install --with-deps chromium');
  log('国内网络慢的话可设 PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright');
  process.exit(code);
}

const after = await browsersReady();
if (after.ready) {
  log('完成:', after.path);
  process.exit(0);
}
log('下载命令执行完，但 executablePath() 仍为空——请检查 PLAYWRIGHT_BROWSERS_PATH');
process.exit(1);
