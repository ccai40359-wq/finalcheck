// AI 的「眼睛」（2026-11-18）：把网页 / HTML / SVG / PDF·PPT·Word 的某一页 / 视频的某一帧渲染成图片。
// 只在桌面端（Electron 主进程）可用：用隐藏窗口渲染再 capturePage；
// PDF 页与视频帧复用渲染层自己的 pdf.js 与 fc-media 协议（#fc-snapshot 路由），不引入额外依赖。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

let electronMod;
async function electron() {
  if (electronMod !== undefined) return electronMod;
  try {
    const m = await import('electron');
    const api = m.BrowserWindow ? m : (m.default && m.default.BrowserWindow ? m.default : null);
    electronMod = api && api.app?.isReady?.() ? api : null; // 纯 Node（无头测试）里 import('electron') 只是可执行文件路径
  } catch { electronMod = null; }
  return electronMod;
}

let rendererTarget = null; // { url } | { file }：由 index.mjs 注入（开发态 vite URL / 打包后的 index.html）
let preloadPath = null;
export function setSnapshotRenderer({ url = null, file = null, preload = null } = {}) {
  rendererTarget = url ? { url } : file ? { file } : null;
  preloadPath = preload;
}

export async function captureAvailable() {
  return !!(await electron());
}

const MAX_W = 1600;
/** nativeImage → 适合发给模型的图：最宽 1600px；PNG 超过 3MB 改用 JPEG */
async function toModelImage(img) {
  let im = img;
  const { width } = im.getSize();
  if (width > MAX_W) im = im.resize({ width: MAX_W, quality: 'best' });
  let buf = im.toPNG();
  let mime = 'image/png';
  if (buf.length > 3 * 1024 * 1024) { buf = im.toJPEG(82); mime = 'image/jpeg'; }
  const size = im.getSize();
  return { buf, mime, width: size.width, height: size.height };
}

async function saveCapture(buf, mime, outDir) {
  const dir = outDir || path.join(process.env.FINALCHECK_SPILL_DIR || os.tmpdir(), 'captures');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `capture-${Date.now()}.${mime === 'image/png' ? 'png' : 'jpg'}`);
  await writeFile(file, buf);
  return file;
}

function waitTitle(win, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('渲染超时')); }, timeoutMs);
    const check = () => {
      const tt = win.webContents.getTitle();
      if (tt.startsWith('fc-snapshot-ready:')) { cleanup(); resolve(tt.slice('fc-snapshot-ready:'.length)); }
      else if (tt.startsWith('fc-snapshot-error:')) { cleanup(); reject(new Error(tt.slice('fc-snapshot-error:'.length))); }
    };
    const iv = setInterval(check, 150);
    const cleanup = () => { clearTimeout(timer); clearInterval(iv); };
  });
}

/**
 * 网页 / 本地 HTML / SVG 截图。
 * @returns {Promise<{buf:Buffer, mime:string, width:number, height:number, file:string}>}
 */
export async function captureUrl(target, { width = 1280, height = 800, waitMs = 800, fullPage = false, outDir = null } = {}) {
  const E = await electron();
  if (!E) throw new Error('截图只在 FinalCheck 桌面端可用');
  const win = new E.BrowserWindow({
    show: false, width, height, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'fc-capture', backgroundThrottling: false },
  });
  try {
    const isUrl = /^https?:\/\//i.test(target);
    await (isUrl ? win.loadURL(target) : win.loadURL(pathToFileURL(target).href));
    await new Promise((r) => setTimeout(r, waitMs)); // 等字体 / 动画 / 异步渲染落定
    if (fullPage) {
      const h = await win.webContents.executeJavaScript('Math.min(12000, Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))').catch(() => height);
      if (h > height) { win.setContentSize(width, h); await new Promise((r) => setTimeout(r, 300)); }
    }
    const img = await win.webContents.capturePage();
    if (img.isEmpty()) throw new Error('截图为空（页面没有渲染出内容）');
    const out = await toModelImage(img);
    return { ...out, file: await saveCapture(out.buf, out.mime, outDir) };
  } finally {
    win.destroy();
  }
}

/** PDF 某一页 / 视频某一帧：在隐藏窗口里打开渲染层的 #fc-snapshot 路由 */
export async function captureSnapshot(params, { outDir = null, timeoutMs = 60000 } = {}) {
  const E = await electron();
  if (!E) throw new Error('截图只在 FinalCheck 桌面端可用');
  if (!rendererTarget) throw new Error('截图通道未初始化');
  const width = Math.max(200, Math.min(2400, Number(params.width) || 1280));
  const win = new E.BrowserWindow({
    show: false, width: width + 40, height: 1200, paintWhenInitiallyHidden: true,
    webPreferences: { preload: preloadPath || undefined, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  try {
    const hash = 'fc-snapshot?' + new URLSearchParams({ ...params, width: String(width) }).toString();
    if (rendererTarget.url) await win.loadURL(`${rendererTarget.url}#${hash}`);
    else await win.loadFile(rendererTarget.file, { hash });
    const info = await waitTitle(win, timeoutMs);
    const m = /(\d+)x(\d+)$/.exec(info);
    const w = m ? Number(m[1]) : width;
    const h = m ? Number(m[2]) : 800;
    // 画布可能比窗口高（竖版页）：把窗口撑到画布大小再截，否则下半截是空的
    win.setContentSize(Math.max(w, 200), Math.max(h, 100));
    await new Promise((r) => setTimeout(r, 250));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
    if (img.isEmpty()) throw new Error('截图为空');
    const out = await toModelImage(img);
    return { ...out, info, file: await saveCapture(out.buf, out.mime, outDir) };
  } finally {
    win.destroy();
  }
}

/** 读一张已有图片给模型看（png/jpg/gif/webp/bmp；svg 走 captureUrl 栅格化） */
export async function loadImageForModel(abs) {
  const E = await electron();
  const ext = path.extname(abs).toLowerCase();
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
  if (E) {
    const img = E.nativeImage.createFromPath(abs);
    if (!img.isEmpty()) {
      const out = await toModelImage(img);
      return { ...out, original: img.getSize() };
    }
  }
  // 无 Electron（无头测试）或 nativeImage 解不开（gif/webp 动图）：原样发，限 4MB
  const buf = await readFile(abs);
  if (!MIME[ext]) throw new Error(`不支持的图片格式：${ext}`);
  if (buf.length > 4 * 1024 * 1024) throw new Error(`图片过大（${Math.round(buf.length / 1024)}KB）且无法缩放：请先缩小再看`);
  return { buf, mime: MIME[ext], width: null, height: null };
}
