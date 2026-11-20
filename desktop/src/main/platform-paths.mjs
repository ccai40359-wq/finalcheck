// 平台路径集中解析（Linux 移植）。
//
// 为什么单独抽一个模块：`homedir()/FinalCheck` 这条回落路径在 hooks.mjs、
// diagnostics.mjs、usage-ledger.mjs 三处各写了一遍，Linux 版要改成 XDG 规范
// （~/.config/FinalCheck），改三处容易漏一处。集中在这里，各调用方都从这里取。
//
// 目录约定（与 Electron 自身的 app.getPath('userData') 保持一致）：
//   Windows : %APPDATA%\FinalCheck              （Roaming，随用户漫游）
//   Linux   : ~/.config/FinalCheck              （XDG Base Directory 规范）
//   macOS   : ~/Library/Application Support/FinalCheck
//
// 只做「算出路径」，不保证目录存在——调用方自己负责 mkdir。
//
// ⚠️ 必须按平台选 path API（单测抓到过的真 bug）：
// `path.join` 是**当前运行平台**的实现。Windows 上跑 `appDataDir({platform:'linux'})`
// 会得到 `\home\u\.config\FinalCheck`（反斜杠），Linux 上跑 win32 分支又会得到
// `/C:/...`。所以这里用 `path.win32` / `path.posix` 显式指定，
// 与 policy.mjs 里 `pathApiFor` 同一口径。
import os from 'node:os';
import path from 'node:path';

const pathApiFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/** 应用数据/配置根目录（不含文件名）。 */
export function appDataDir({ platform = process.platform, env = process.env, home = null } = {}) {
  const api = pathApiFor(platform);
  const h = home || os.homedir();
  if (platform === 'win32') {
    const appData = env.APPDATA || api.join(h, 'AppData', 'Roaming');
    return api.join(appData, 'FinalCheck');
  }
  if (platform === 'darwin') {
    return api.join(h, 'Library', 'Application Support', 'FinalCheck');
  }
  // Linux / 其他 POSIX：遵循 XDG。显式给了 XDG_CONFIG_HOME 就尊重它。
  const xdg = String(env.XDG_CONFIG_HOME || '').trim();
  const base = xdg || api.join(h, '.config');
  return api.join(base, 'FinalCheck');
}

/** 缓存/临时文件根目录（Linux 走 XDG_CACHE_HOME）。 */
export function appCacheDir({ platform = process.platform, env = process.env, home = null } = {}) {
  const api = pathApiFor(platform);
  const h = home || os.homedir();
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || api.join(h, 'AppData', 'Local');
    return api.join(local, 'FinalCheck');
  }
  if (platform === 'darwin') {
    return api.join(h, 'Library', 'Caches', 'FinalCheck');
  }
  const xdg = String(env.XDG_CACHE_HOME || '').trim();
  const base = xdg || api.join(h, '.cache');
  return api.join(base, 'FinalCheck');
}

/** 是否 Windows 平台（集中一处判断，避免各处硬写 'win32'）。 */
export function isWindowsPlatform(platform = process.platform) {
  return platform === 'win32';
}
