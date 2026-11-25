import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { humanizeUpdateError } from '../../renderer/lib/updater-state.mjs';
import { parseChangelog } from '../../renderer/lib/changelog.mjs';
import { parseSiteRelease, pickBestSource, compareVersions, isBlockedHostname, SITE_RELEASE_URL, SITE_HOST } from '../../renderer/lib/update-sources.mjs';
import { t } from '../../renderer/i18n/core.mjs';

// 更新详情：打包后读 extraResources 带进来的 CHANGELOG.md / CHANGELOG.en.md；开发态读仓库根。
// 依次尝试多个候选路径，全部失败时返回空文本（界面显示「暂无更新记录」，不报错）。
const CHANGELOG_FILES = { zh: 'CHANGELOG.md', en: 'CHANGELOG.en.md' };

async function readChangelogText(app, lang = 'zh') {
  const fileName = CHANGELOG_FILES[lang === 'en' ? 'en' : 'zh'];
  const candidates = [];
  // 打包后 extraResources 把 CHANGELOG*.md 放到 resources 根；优先读它
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, fileName));
  }
  try {
    // electron-vite 开发态 app.getAppPath() 指向 desktop/，仓库根在上一级
    candidates.push(path.resolve(app.getAppPath(), '..', fileName));
  } catch { /* 取不到 appPath 时继续用 cwd 候选 */ }
  candidates.push(path.resolve(process.cwd(), fileName));
  candidates.push(path.resolve(process.cwd(), '..', fileName));
  for (const file of candidates) {
    try {
      return await readFile(file, 'utf8');
    } catch { /* 试下一个候选路径 */ }
  }
  return '';
}

// ---- 自动更新（官网优先 + GitHub 兜底）：只有安装版（app.isPackaged）才联网检查 ----
export function registerUpdaterIpc({ ipcMain, app, getWin }) {
  const UPDATE_FIRST_CHECK_DELAY = 10 * 1000;       // 启动 10 秒后静默检查一次
  const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 之后每 6 小时一次
  const SITE_PROBE_TIMEOUT_MS = 8 * 1000;           // 官网探测上限：超过就当官网不可用，不拖住用户
  let updaterPromise = null; // Promise<autoUpdater|null>：并发调用共享同一次初始化
  let updateTimer = null;
  let updateSilent = false;  // 定时静默检查期间，错误事件不推给界面（手动检查照常提示）
  // 手动检查时 GitHub 的 error 先攒着：官网能答就不推（避免明明有更新却先闪一句「检查失败」），
  // 两个源都失败才补发，保证红字最终一定出现。
  let deferGithubError = false;
  let pendingGithubError = '';

  const sendUpdateEvent = (ev) => {
    try {
      const w = getWin();
      if (w && !w.isDestroyed()) w.webContents.send('finalcheck:update-event', ev);
    } catch { /* 窗口正在销毁时发送失败不影响主流程 */ }
  };

  const humanizeUpdaterError = (err) => humanizeUpdateError(err?.message || err);

  // 官网镜像探测：读 JSON 接口，不碰 /latest.yml（那个地址返回的是 SPA 的 HTML，electron-updater 用不了）。
  // 任何失败（超时 / 断网 / 非 200 / 非 JSON / 字段坏了）都返回 null 让调用方降级到 GitHub：
  // 国内官网偶尔抖动很常见，不能因为官网挂了就告诉用户「检查更新失败」。
  async function probeSiteRelease() {
    try {
      // 硬约束：只允许 http(s)、主机必须是写死的官网域名、且不在本机/内网网段
      const url = new URL(SITE_RELEASE_URL);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      if (url.hostname.toLowerCase() !== SITE_HOST || isBlockedHostname(url.hostname)) return null;
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(SITE_PROBE_TIMEOUT_MS)
      });
      if (!res || !res.ok) return null;
      const text = await res.text();
      // 多一层拦截：官网错误地把 SPA 页面（200 + HTML）返回时，别把 HTML 丢进 JSON.parse
      if (!text || text.length > 200 * 1024 || text.trimStart().startsWith('<')) return null;
      return parseSiteRelease(JSON.parse(text));
    } catch {
      return null;
    }
  }

  // GitHub 探测仍走 electron-updater 原来的 checkForUpdates（它会顺带推送 checking / available 等事件）。
  // 单独包一层是为了把异常变成「这个源没结果」，而不是让整次检查失败。
  async function probeGithub(au) {
    try {
      const result = await au.checkForUpdates();
      const version = result?.updateInfo?.version ? String(result.updateInfo.version) : '';
      return { ok: true, version };
    } catch (error) {
      return { ok: false, version: '', error };
    }
  }

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
        // 手动检查期间 electron-updater 会先发 error 事件再 reject。若官网这一路能给出结果，
        // 这条红字就是噪音（用户明明能更新，却先看到「检查更新失败」），所以先压住、由 check 收口。
        if (deferGithubError) { pendingGithubError = humanizeUpdaterError(err); return; }
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
  // 更新详情：{ version, entries, entriesEn, raw, rawEn }；读不到或解析失败也返回空数组，由界面兜底
  // entries / raw 仍是中文（保持老调用方不变）；entriesEn / rawEn 是英文，英文文件缺失时为空，界面回退中文。
  ipcMain.handle('finalcheck:update:changelog', async () => {
    const version = app.getVersion();
    try {
      const [raw, rawEn] = await Promise.all([
        readChangelogText(app, 'zh'),
        readChangelogText(app, 'en')
      ]);
      return { version, entries: parseChangelog(raw), entriesEn: parseChangelog(rawEn), raw, rawEn };
    } catch {
      return { version, entries: [], entriesEn: [], raw: '', rawEn: '' };
    }
  });
  ipcMain.handle('finalcheck:update:check', async () => {
    const currentVersion = app.getVersion();
    if (!app.isPackaged) {
      return { ok: false, currentVersion, error: t('开发模式不检查更新；安装版才会连接 GitHub Release。') };
    }
    updateSilent = false; // 手动检查：错误必须可见
    // 两个源都探一遍：官网（国内可达优先）与 GitHub（electron-updater 既有链路）。
    // 并发发出去，慢的那个不会把快的拖成两倍耗时；单源失败只让自己变 null，不影响另一个。
    deferGithubError = true;
    pendingGithubError = '';
    let au = null;
    let updaterError = null;
    const githubTask = (async () => {
      try {
        au = await ensureUpdater();
      } catch (e) {
        updaterError = e;
        return { ok: false, version: '', error: e };
      }
      if (!au) return { ok: false, version: '', error: null, unavailable: true };
      return probeGithub(au);
    })();
    const [siteRaw, githubResult] = await (async () => {
      try {
        return await Promise.all([probeSiteRelease(), githubTask]);
      } finally {
        deferGithubError = false; // 无论如何都要恢复，否则后续下载/静默检查的错误会被永久吞掉
      }
    })();
    const site = siteRaw ? siteRaw : null;
    const githubVersion = githubResult?.ok ? githubResult.version : '';

    let best;
    try {
      best = pickBestSource({ site, github: githubVersion, currentVersion });
    } catch {
      // 纯函数按理不会抛；真抛了也退化成「没有可用的新版本」，不把内部错误甩给界面
      best = { source: null };
    }

    if (best && best.version) {
      const payload = {
        ok: true,
        currentVersion,
        latestVersion: best.version,
        source: best.source
      };
      if (best.source === 'site') {
        if (best.downloadUrl) payload.downloadUrl = best.downloadUrl;
        if (best.sha256) payload.sha256 = best.sha256;
        if (best.size) payload.size = best.size;
        // 只有 GitHub 那边也认这个版本时才补发 available。原因：界面上的「下载更新」按钮走的仍是
        // electron-updater，它必须先由 checkForUpdates 拿到 updateInfo 才能下载。官网单独发现、
        // GitHub 完全没探到时补发事件，会造出一个点了就报错的死按钮——那种情况只把 downloadUrl
        // 交给调用方，不驱动界面。
        if (githubResult?.ok && compareVersions(best.version, githubVersion) === 0) {
          sendUpdateEvent({ type: 'available', version: best.version });
        }
      }
      return payload;
    }

    // 这里只处理「有没有新版本」：没有新版本就不算失败。真正的失败是「两个源都探测不到」。
    const siteFailed = !site;
    const githubFailed = !githubResult?.ok;
    if (siteFailed && githubFailed) {
      // 官网挂 + GitHub 挂。GitHub 那边区分两种原因：
      //  · 更新模块本身加载不出来（依赖缺失 / 不是打包环境）→ 老文案，别误导成网络问题；
      //  · checkForUpdates 真的失败 → 人话化后给用户，和改成官网优先之前的表现一致。
      if (githubResult?.unavailable) return { ok: false, currentVersion, error: t('更新模块不可用，请重新安装应用。') };
      const message = pendingGithubError || humanizeUpdaterError(updaterError || githubResult?.error);
      // 这条红字被 deferGithubError 压住过，check 自己收口时补发，保证界面最终看得到失败
      sendUpdateEvent({ type: 'error', message });
      return { ok: false, currentVersion, error: message };
    }
    pendingGithubError = ''; // 官网能答：GitHub 的失败不再需要告知用户
    // 至少一个源成功应答、且都没发现更高版本 = 已是最新。
    // source 标明这次是谁答的（官网优先），界面可据此提示；没有新版本时不再带下载地址。
    const answeredBy = site ? 'site' : 'github';
    return { ok: true, currentVersion, source: answeredBy };
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
