import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { humanizeUpdateError } from '../../renderer/lib/updater-state.mjs';
import { parseChangelog } from '../../renderer/lib/changelog.mjs';
import { t } from '../../renderer/i18n/core.mjs';

// 更新详情：打包后读 extraResources 带进来的 CHANGELOG.md；开发态读仓库根。
// 依次尝试多个候选路径，全部失败时返回空文本（界面显示「暂无更新记录」，不报错）。
async function readChangelogText(app) {
  const candidates = [];
  // 打包后 extraResources 把 CHANGELOG.md 放到 resources 根；优先读它
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'CHANGELOG.md'));
  }
  try {
    // electron-vite 开发态 app.getAppPath() 指向 desktop/，仓库根在上一级
    candidates.push(path.resolve(app.getAppPath(), '..', 'CHANGELOG.md'));
  } catch { /* 取不到 appPath 时继续用 cwd 候选 */ }
  candidates.push(path.resolve(process.cwd(), 'CHANGELOG.md'));
  candidates.push(path.resolve(process.cwd(), '..', 'CHANGELOG.md'));
  for (const file of candidates) {
    try {
      return await readFile(file, 'utf8');
    } catch { /* 试下一个候选路径 */ }
  }
  return '';
}

// ---- 自动更新（GitHub Release）：只有安装版（app.isPackaged）才联网检查 ----
export function registerUpdaterIpc({ ipcMain, app, getWin }) {
  const UPDATE_FIRST_CHECK_DELAY = 10 * 1000;       // 启动 10 秒后静默检查一次
  const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 之后每 6 小时一次
  let updaterPromise = null; // Promise<autoUpdater|null>：并发调用共享同一次初始化
  let updateTimer = null;
  let updateSilent = false;  // 定时静默检查期间，错误事件不推给界面（手动检查照常提示）

  const sendUpdateEvent = (ev) => {
    try {
      const w = getWin();
      if (w && !w.isDestroyed()) w.webContents.send('finalcheck:update-event', ev);
    } catch { /* 窗口正在销毁时发送失败不影响主流程 */ }
  };

  const humanizeUpdaterError = (err) => humanizeUpdateError(err?.message || err);

  // electron-updater 运行时动态加载（dev 不 import、不联网；打包后从 node_modules 解析）
  function setupUpdater() {
    if (!app.isPackaged) return Promise.resolve(null);
    return (async () => {
      let mod = null;
      try {
        mod = await import('electron-updater');
      } catch { /* 依赖缺失时按「更新模块不可用」处理，不阻塞启动 */ }
      const au = mod?.autoUpdater || mod?.default?.autoUpdater;
      if (!au) return null;

      au.autoDownload = false;          // 发现更新只提示，用户点「下载更新」才下载
      au.autoInstallOnAppQuit = true;   // 已下载的更新在退出时自动安装

      au.on('checking-for-update', () => {
        if (!updateSilent) sendUpdateEvent({ type: 'checking' });
      });
      au.on('update-available', (info = {}) => sendUpdateEvent({
        type: 'available',
        version: String(info.version || ''),
        notes: String(info.releaseNotes || '')
      }));
      au.on('update-not-available', (info = {}) => sendUpdateEvent({
        type: 'not-available',
        version: String(info.version || app.getVersion())
      }));
      au.on('download-progress', (p = {}) => sendUpdateEvent({
        type: 'progress',
        percent: Number(p.percent)
      }));
      au.on('update-downloaded', (info = {}) => sendUpdateEvent({
        type: 'downloaded',
        version: String(info.version || '')
      }));
      au.on('error', (err) => {
        if (updateSilent) return;
        sendUpdateEvent({ type: 'error', message: humanizeUpdaterError(err) });
      });

      const silentCheck = async () => {
        updateSilent = true;
        try { await au.checkForUpdates(); } catch { /* 错误由 error 事件处理；静默期不弹 */ }
        finally { updateSilent = false; }
      };
      setTimeout(silentCheck, UPDATE_FIRST_CHECK_DELAY);
      updateTimer = setInterval(silentCheck, UPDATE_CHECK_INTERVAL);
      updateTimer.unref?.();
      return au;
    })();
  }

  const ensureUpdater = () => {
    if (!updaterPromise) updaterPromise = setupUpdater();
    return updaterPromise;
  };

  // ---- 自动更新 IPC：任何分支都返回对象，不向渲染层抛异常 ----
  ipcMain.handle('finalcheck:update:version', () => app.getVersion());
  // 更新详情：{ version, entries, raw }；读不到或解析失败也返回空 entries，由界面兜底
  ipcMain.handle('finalcheck:update:changelog', async () => {
    const version = app.getVersion();
    try {
      const raw = await readChangelogText(app);
      return { version, entries: parseChangelog(raw), raw };
    } catch {
      return { version, entries: [], raw: '' };
    }
  });
  ipcMain.handle('finalcheck:update:check', async () => {
    const currentVersion = app.getVersion();
    if (!app.isPackaged) {
      return { ok: false, currentVersion, error: t('开发模式不检查更新；安装版才会连接 GitHub Release。') };
    }
    try {
      const au = await ensureUpdater();
      if (!au) return { ok: false, currentVersion, error: t('更新模块不可用，请重新安装应用。') };
      updateSilent = false; // 手动检查：错误必须可见
      const result = await au.checkForUpdates();
      const latestVersion = result?.updateInfo?.version ? String(result.updateInfo.version) : undefined;
      if (!latestVersion || latestVersion === currentVersion) return { ok: true, currentVersion };
      return { ok: true, currentVersion, latestVersion };
    } catch (e) {
      return { ok: false, currentVersion, error: humanizeUpdaterError(e) };
    }
  });
  ipcMain.handle('finalcheck:update:download', async () => {
    if (!app.isPackaged) return { ok: false, error: t('开发模式不可下载更新。') };
    try {
      const au = await ensureUpdater();
      if (!au) return { ok: false, error: t('更新模块不可用，请重新安装应用。') };
      sendUpdateEvent({ type: 'progress', percent: 0 }); // 立刻进入「下载中」，不等首个进度事件
      await au.downloadUpdate();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: humanizeUpdaterError(e) };
    }
  });
  ipcMain.handle('finalcheck:update:install', async () => {
    if (!app.isPackaged) return { ok: false, error: t('开发模式不可安装更新。') };
    try {
      const au = await ensureUpdater();
      if (!au) return { ok: false, error: t('更新模块不可用，请重新安装应用。') };
      // 先让 IPC 响应回到渲染层，再退出并启动安装器
      setImmediate(() => { try { au.quitAndInstall(false, true); } catch { /* 安装失败由更新模块日志记录 */ } });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: humanizeUpdaterError(e) };
    }
  });

  return { ensureUpdater };
}
