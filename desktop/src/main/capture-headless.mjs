// 无界面截图渲染器（2026-11-20）
// 背景：capture_screenshot 以前只认 Electron 主进程（import('electron') 拿到 BrowserWindow 才算可用）。
// 纯 Node（sim 测试台、CLI、CI）下 import('electron') 只返回 exe 路径，于是模型得到
// 「截图只在 FinalCheck 桌面端可用」——实测导致它在盲写 UI，写出的页面 JS 崩了、无障碍文本没隐藏，
// 而它看不见自己的页面，只能靠事后另起 python+Playwright 才发现。
//
// 做法：拿得到 electron 二进制就 spawn 一个最小主进程（本文件旁边那个 render-main.mjs），
// 让它在隐藏窗口里渲染目标再 capturePage；不连 CDP、不开端口、不碰主应用的单实例锁。
// 拿不到 electron 二进制时回退到系统 Chrome/Edge 的 headless 截图。
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 后端探测：结果带原因，便于给模型一个可执行的下一步 ---------- */
let probed = null;
export async function probeCaptureBackend() {
  if (probed) return probed;
  const reasons = [];
  // ① Electron 二进制（开发态 desktop/node_modules，打包后随 app 走）
  //    排在最前：桌面端进程已经在跑，BrowserWindow 截图比另起浏览器快。
  try {
    const m = await import('electron');
    const p = typeof m === 'string' ? m : (m?.default && typeof m.default === 'string' ? m.default : null);
    if (p && p.length > 4) { probed = { ok: true, kind: 'electron', bin: p }; return probed; }
    reasons.push('electron 模块未给出可用二进制路径');
  } catch (e) { reasons.push(`electron 不可用（${e?.message || e}）`); }
  // ② Playwright（2026-11-20 Linux 移植新增，排在 Electron 之后、系统 Chrome 之前）
  //
  // 为什么需要它：Linux 发行版默认**不带 Chrome/Chromium**（Ubuntu 只有 snap 版、路径不稳定；
  // Debian/Alpine 默认没有）。没有这条时，Linux 上 capture_screenshot 大概率直接不可用，
  // 模型只能盲写 UI。Playwright 自带浏览器二进制，装完即用。
  try {
    const { chromium } = await import('playwright');
    // ⚠️ executablePath() 只是**按版本号拼出的期望路径**，不保证文件真的存在。
    // 2026-11-20 实测：只装了完整浏览器、没装 headless shell 时它照样返回非空，
    // 于是这里判「可用」→ 真截图时才炸。必须真的 stat 一下。
    const full = chromium.executablePath?.();
    const fullOk = !!full && existsSyncSync(full);
    // 完整浏览器不在也没关系：renderWithPlaywright 会扫描缓存目录找任意已装版本
    const anyChromium = findInstalledChromiums()[0] || null;
    const pick = fullOk ? full : (anyChromium || null);
    if (pick) { probed = { ok: true, kind: 'playwright', bin: pick }; return probed; }
    reasons.push('playwright 已安装但没有任何可用的 chromium（node desktop/scripts/install-playwright-linux.mjs）');
  } catch (e) { reasons.push(`playwright 不可用（${e?.message || e}）`); }
  // ③ 系统 Chrome / Edge（无 Electron 的 CI、纯 CLI 环境）
  const guesses = [];
  const env = process.env;
  if (env.CHROME_PATH) guesses.push(env.CHROME_PATH);
  guesses.push(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  );
  for (const g of guesses) {
    try { await (await import('node:fs/promises')).access(g); probed = { ok: true, kind: 'chrome', bin: g }; return probed; } catch { /* 继续找 */ }
  }
  reasons.push('没找到 Electron 二进制 / Playwright 浏览器 / 系统 Chrome');
  probed = { ok: false, reasons };
  return probed;
}
export function resetCaptureBackendProbe() { probed = null; }

/** 截图能力是否可用（兼容旧调用方：只关心 true/false） */
export async function captureAvailable() {
  return (await probeCaptureBackend()).ok;
}

/** 给模型看的「不可用」文案：必须给出可执行的下一步，不能只说不行 */
export async function captureUnavailableReason() {
  const r = await probeCaptureBackend();
  if (r.ok) return null;
  // Linux 是这里最常见的情况：发行版默认不带 Chrome，Playwright 浏览器也没下载。
  // 给出精确命令比「自己装 puppeteer」有用得多（后者还要用户选版本、装系统库）。
  const linuxHint = process.platform === 'linux'
    ? 'Linux 上执行：cd desktop && npx playwright install --with-deps chromium（或 npx playwright install chromium 后自己装系统库）'
    : '执行：npx playwright install chromium';
  return `当前环境没有可用的网页渲染器（${r.reasons.join('；')}）。`
    + `可以这样修：① ${linuxHint}；`
    + '② 生成的 HTML 用 read_file 自查结构（看有没有未闭合标签、CSS 选择器是否对得上）；'
    + '③ 直接把文件交给用户，请他打开看。不要假装看过渲染结果。';
}

/* ---------- 用外部渲染器截一张（给纯 Node 用的主路径） ---------- */

/* ---------- 并发闸：每次截图要起一个 100–200MB 的渲染进程 ---------- */
// capture_screenshot 在 agent 里属并行工具（默认并发 8），不拦一下会同时起 8 个 Electron。
// 串行化到 2 路（够快，也不会把内存打满）；排队超时给出明确原因而不是无限等。
const MAX_PARALLEL_RENDER = 2;
const QUEUE_WAIT_MS = 30000;
let activeRenders = 0;
const renderQueue = [];

async function acquireSlot() {
  if (activeRenders < MAX_PARALLEL_RENDER) { activeRenders += 1; return; }
  await new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const i = renderQueue.indexOf(waiter);
      if (i >= 0) renderQueue.splice(i, 1);
      reject(new Error(`截图排队超时（同时有 ${MAX_PARALLEL_RENDER} 张在渲染，排队超过 ${QUEUE_WAIT_MS / 1000}s）。稍后重试或一次只截一张`));
    }, QUEUE_WAIT_MS);
    waiter.timer.unref?.();
    renderQueue.push(waiter);
  });
  activeRenders += 1;
}
function releaseSlot() {
  activeRenders = Math.max(0, activeRenders - 1);
  const next = renderQueue.shift();
  if (next) { clearTimeout(next.timer); next.resolve(); }
}

async function runRenderer(payload, { timeoutMs = 60000 } = {}) {
  const backend = await probeCaptureBackend();
  if (!backend.ok) throw new Error(await captureUnavailableReason());
  await acquireSlot();
  try {
    return await renderOnce(backend, payload, timeoutMs);
  } finally {
    releaseSlot();
  }
}

async function renderOnce(backend, payload, timeoutMs) {
  // Playwright 不是「spawn 一个二进制」，要用它的 API 拿像素；单独一条路径。
  if (backend.kind === 'playwright') return renderWithPlaywright(payload, timeoutMs);

  const tmp = await mkdtempish();
  const outPng = path.join(tmp, 'shot.png');
  const jobFile = path.join(tmp, 'job.json');
  const job = { ...payload, out: outPng };
  await writeFile(jobFile, JSON.stringify(job), 'utf8');

  let child;
  try {
    if (backend.kind === 'electron') {
      // 独立 user-data-dir + 关掉原生窗口遮挡检测（Windows 下后台窗口会被标 hidden，capturePage 等不到帧）
      child = spawn(backend.bin, [
        path.join(HERE, 'render-main.mjs'),
        jobFile,
        `--user-data-dir=${path.join(tmp, 'ud')}`,
        '--disable-gpu',
        '--disable-features=CalculateNativeWinOcclusion',
        '--no-sandbox'
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    } else {
      child = spawn(backend.bin, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars',
        `--user-data-dir=${path.join(tmp, 'ud')}`,
        `--window-size=${job.width},${job.height}`,
        `--screenshot=${outPng}`,
        job.url || pathToFileURLSafe(job.file)
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    }
  } catch (e) {
    await cleanupDir(tmp);
    throw new Error(`启动渲染器失败：${e?.message || e}`);
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      done(() => reject(new Error(`渲染超时（${Math.round(timeoutMs / 1000)}s）`)));
    }, timeoutMs);
    timer.unref?.();

    const chunks = [];
    child.stdout?.on('data', (d) => chunks.push(Buffer.from(d)));
    child.stderr?.on('data', (d) => chunks.push(Buffer.from(d)));
    child.on('error', (e) => done(() => reject(new Error(`渲染器无法启动：${e.message}`))));
    child.on('exit', async (code) => {
      try {
        const raw = await readFile(outPng).catch(() => null);
        if (!raw || !raw.length) {
          const log = Buffer.concat(chunks).toString('utf8').slice(-1200);
          done(() => reject(new Error(`渲染器没有产出图片（exit=${code}）${log ? '：' + log : ''}`)));
          return;
        }
        done(() => resolve(raw));
      } catch (e) {
        done(() => reject(e));
      }
    });
  }).finally(() => { cleanupDir(tmp); });
}

/** 清临时工作目录（每次截图都会建一个，含 user-data-dir；不清会累积在 %TEMP%） */
async function cleanupDir(dir) {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => { /* Windows 下文件可能还被占用，留给系统清理 */ });
}

function childEnv() {
  const env = { ...process.env };
  // ELECTRON_RUN_AS_NODE 会让 electron 二进制退化成普通 node，跑不了 BrowserWindow
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function pathToFileURLSafe(p) {
  const abs = path.resolve(String(p || ''));
  return 'file:///' + abs.replace(/\\/g, '/').replace(/^\/+/, '');
}

async function mkdtempish() {
  const base = path.join(os.tmpdir(), 'fc-render-');
  const dir = await (await import('node:fs/promises')).mkdtemp(base).catch(async () => {
    const d = path.join(os.tmpdir(), 'fc-render-' + Math.random().toString(36).slice(2));
    await mkdir(d, { recursive: true });
    return d;
  });
  return dir;
}

/**
 * 用 Playwright 截一张图（Linux 移植新增，2026-11-20）。
 *
 * 为什么单独写而不是复用 spawn 路径：Playwright 不是「命令行参数 + 产出文件」的形态，
 * 它要开浏览器、等页面、取 buffer。硬塞进 spawn 分支反而更乱。
 *
 * 关键设置：
 *   · --no-sandbox：bwrap 沙箱里没有 user namespace 权限，Chromium 会以
 *     "No usable sandbox!" 退出。这里是**宿主侧截图**（不是被沙箱化的命令），
 *     且渲染的是用户自己的页面，所以关掉 Chromium 自己的沙箱是可接受的；
 *     真正的隔离由外层 bwrap 负责。
 *   · waitUntil: 'load' + 额外 waitMs：只等 load 会漏掉异步渲染的内容（图表/动画首帧）
 */
/**
 * 扫 ms-playwright 缓存目录，找**任意版本**已安装的完整 chromium 可执行文件。
 *
 * 为什么需要：headless shell 与完整浏览器是分开下载的两份产物，
 * 用户机器上经常只有一部分（或只有别的 Playwright 项目的旧版本）。
 * 只要能找到一个真正的 chromium，截图就该能用 —— 版本差几代不影响截静态页面。
 *
 * 目录布局：<cache>/chromium-<ver>/chrome-linux64/chrome（Linux）
 *           <cache>/chromium-<ver>/chrome-win64/chrome.exe（Windows）
 *           <cache>/chromium-<ver>/chrome-mac/Chromium.app/Contents/MacOS/Chromium（macOS）
 */
function findInstalledChromiums() {
  const out = [];
  try {
    const pathMod = path;
    const osMod = os;
    const roots = [
      process.env.PLAYWRIGHT_BROWSERS_PATH,
      pathMod.join(osMod.homedir(), '.cache', 'ms-playwright'),
      pathMod.join(osMod.homedir(), 'Library', 'Caches', 'ms-playwright'),
      pathMod.join(osMod.homedir(), 'AppData', 'Local', 'ms-playwright')
    ].filter(Boolean);
    const subdirs = ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe',
      'chrome-win/chrome.exe', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'];
    for (const root of roots) {
      let entries;
      try { entries = fs.readdirSync(root); } catch { continue; }
      // 按版本号倒序：新的优先
      const vers = entries.filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => {
        const na = Number(a.split('-')[1]); const nb = Number(b.split('-')[1]);
        return nb - na;
      });
      for (const v of vers) {
        for (const sub of subdirs) {
          const p = pathMod.join(root, v, sub);
          try { if (statSync(p).isFile()) out.push(p); } catch { /* 不存在 */ }
        }
      }
    }
  } catch { /* 扫描失败就当没找到 */ }
  return out;
}

function existsSyncSync(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

async function renderWithPlaywright(payload, timeoutMs) {
  const { chromium } = await import('playwright');
  let browser = null;
  try {
    // 优先用 headless shell（更快、更省内存）；缺它时退回**完整浏览器**的 headless 模式。
    //
    // 2026-11-20 实测：这两份是分开下载的产物，经常只装了一份。
    // 只装完整浏览器时 `chromium.launch()` 会直接报
    // "Executable doesn't exist at .../chromium_headless_shell-XXXX" ——
    // 截图功能整个不可用，但实际上完整浏览器完全能跑 headless。
    const launchArgs = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
    const tryLaunch = async () => { browser = await chromium.launch({ args: launchArgs }); };
    try {
      await tryLaunch();
    } catch (e) {
      const msg = String(e?.message || e);
      if (!/headless shell|Executable doesn't exist/i.test(msg)) throw e;
      // ① 先用 Playwright 认为的本版本完整浏览器
      // ② 再看 ms-playwright 目录下**任意版本**的已装 chromium
      //    （用户可能装过别的 Playwright 项目，浏览器缓存是共享的）
      const candidates = [];
      const full = chromium.executablePath?.();
      if (full) candidates.push(full);
      for (const c of findInstalledChromiums()) candidates.push(c);
      let lastErr = e;
      for (const bin of candidates) {
        try {
          if (!existsSyncSync(bin)) continue;
          browser = await chromium.launch({ args: launchArgs, executablePath: bin, headless: true });
          break;
        } catch (e2) { lastErr = e2; browser = null; }
      }
      if (!browser) throw lastErr;
    }
    const page = await browser.newPage({
      viewport: { width: payload.width, height: payload.height },
      deviceScaleFactor: 1
    });
    const url = payload.url || pathToFileURLSafe(payload.file);
    await page.goto(url, { waitUntil: 'load', timeout: Math.min(timeoutMs, 45000) });
    // 给异步渲染留时间（图表、字体、首帧动画）
    const waitMs = Math.max(0, Math.min(5000, Number(payload.waitMs) || 800));
    if (waitMs) await page.waitForTimeout(waitMs);
    const buf = await page.screenshot({
      fullPage: payload.fullPage === true,
      type: 'png'
    });
    return Buffer.from(buf);
  } catch (e) {
    throw new Error(`Playwright 截图失败：${e?.message || e}`);
  } finally {
    if (browser) await browser.close().catch(() => { /* 已崩 */ });
  }
}

/** PNG 尺寸（不依赖图像库，直接读 IHDR） */
export function pngSize(buf) {
  try {
    if (buf.length < 24) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch { return null; }
}

/**
 * 无界面模式的主截图入口：网页 / 本地 HTML / SVG。
 * @returns {Promise<{buf:Buffer, mime:string, width:number|null, height:number|null, file:string}>}
 */
export async function captureBySubprocess(target, { width = 1280, height = 800, waitMs = 800, outDir = null } = {}) {
  const isUrl = /^https?:\/\//i.test(String(target || ''));
  const payload = isUrl ? { url: String(target) } : { file: path.resolve(String(target)) };
  const buf = await runRenderer({ ...payload, width, height, waitMs });
  const size = pngSize(buf);
  const file = await saveCapture(buf, 'image/png', outDir);
  return {
    buf,
    mime: 'image/png',
    width: size?.width ?? null,
    height: size?.height ?? null,
    file
  };
}

async function saveCapture(buf, mime, outDir) {
  const dir = outDir || path.join(process.env.FINALCHECK_SPILL_DIR || os.tmpdir(), 'captures');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `capture-${Date.now()}.${mime === 'image/png' ? 'png' : 'jpg'}`);
  await writeFile(file, buf);
  return file;
}
