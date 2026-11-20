// 最小渲染主进程（2026-11-20）：由 capture-headless.mjs spawn，用隐藏窗口渲染一张图后退出。
// 参数：argv[2] = job.json 路径，其余是 Chromium 开关（--user-data-dir / --disable-gpu 等由 spawn 传入）。
// job.json: { url?, file?, width, height, waitMs, out }
// 用法上它不会被主应用加载，也不会抢单实例锁——它是独立进程。
import { readFile } from 'node:fs/promises';
import { app, BrowserWindow } from 'electron';

const jobPath = process.argv[2];
if (!jobPath) { console.error('render-main: 缺少 job.json'); app.exit(2); }

const readJob = async () => JSON.parse(await readFile(jobPath, 'utf8'));

// 关掉 GPU/图形加速带来的不确定性；paintWhenInitiallyHidden 保证隐藏窗口也会出帧
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(async () => {
  let win = null;
  try {
    const job = await readJob();
    const width = Math.max(200, Math.min(2400, Number(job.width) || 1280));
    const height = Math.max(200, Math.min(4000, Number(job.height) || 800));
    const waitMs = Math.max(0, Math.min(30000, Number(job.waitMs) || 800));

    win = new BrowserWindow({
      show: false,
      width,
      height,
      useContentSize: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: true
      }
    });

    if (job.url) await win.loadURL(job.url);
    else await win.loadURL(pathToFileUrl(job.file));

    // 等字体 / 动画 / 异步渲染落定；再等一次 rAF，确保首帧真的画上去了
    await new Promise((r) => setTimeout(r, waitMs));
    await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => setTimeout(r, 60)))').catch(() => {});
    // 让 CDP 的 visibilityState 不是 hidden（否则某些帧会一直是空的）
    try { win.webContents.setBackgroundThrottling?.(false); } catch { /* 旧版本无此 API */ }

    const img = await win.webContents.capturePage();
    if (img.isEmpty()) throw new Error('截图为空（页面没有渲染出内容）');
    await writePng(img.toPNG(), job.out);
    app.exit(0);
  } catch (e) {
    console.error('render-main:', e?.stack || e?.message || String(e));
    try { if (win) win.destroy(); } catch { /* 已销毁 */ }
    app.exit(1);
  }
});

function pathToFileUrl(p) {
  const abs = String(p || '').replace(/\\/g, '/');
  const withSlash = abs.startsWith('/') ? abs : '/' + abs;
  return 'file://' + encodeURI(withSlash).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

async function writePng(buf, out) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, buf);
}
