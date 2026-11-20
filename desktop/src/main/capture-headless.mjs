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
  try {
    const m = await import('electron');
    const p = typeof m === 'string' ? m : (m?.default && typeof m.default === 'string' ? m.default : null);
    if (p && p.length > 4) { probed = { ok: true, kind: 'electron', bin: p }; return probed; }
    reasons.push('electron 模块未给出可用二进制路径');
  } catch (e) { reasons.push(`electron 不可用（${e?.message || e}）`); }
  // ② 系统 Chrome / Edge（无 Electron 的 CI、纯 CLI 环境）
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
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  );
  for (const g of guesses) {
    try { await (await import('node:fs/promises')).access(g); probed = { ok: true, kind: 'chrome', bin: g }; return probed; } catch { /* 继续找 */ }
  }
  reasons.push('没找到 Electron 二进制，也没找到系统 Chrome/Edge');
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
  return `当前环境没有可用的网页渲染器（${r.reasons.join('；')}）。`
    + '可以这样绕：① 生成的 HTML 用 read_file 自查结构（看有没有未闭合标签、CSS 选择器是否对得上）；'
    + '② 用 node 起一个静态服务器 + 自行装 puppeteer/playwright 截图（但要你自己装，不保证有网）；'
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
