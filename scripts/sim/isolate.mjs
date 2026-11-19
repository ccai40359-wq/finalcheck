// 模拟客户端：把所有可能写盘的位置都指到一个临时根目录下，绝不碰用户真实的 FinalCheck 数据。
//
// 必须在 import 任何 desktop/src/main 模块之前调用（有些模块在调用时才读 env，有些在首次使用时缓存）。
// 覆盖面：FINALCHECK_* 全部数据目录 + APPDATA / LOCALAPPDATA / USERPROFILE / HOME
// （projects.json / usage.json / hooks.json / 沙箱临时目录的默认值都从这几个推出来）。
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 真实用户的 FinalCheck 配置路径（隔离前取；只读，用来借供应商配置跑真模型） */
export function realUserConfigFile() {
  if (process.env.FINALCHECK_SIM_REAL_CONFIG) return process.env.FINALCHECK_SIM_REAL_CONFIG;
  const appData = process.env.__FC_SIM_ORIG_APPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'FinalCheck', 'config.json');
}

/** 只读借用真实配置里的供应商（真模型模式用）；读不到返回 null。不会写回任何东西。 */
export function readRealProviders() {
  try {
    const cfg = JSON.parse(readFileSync(realUserConfigFile(), 'utf8'));
    return { providers: Array.isArray(cfg.providers) ? cfg.providers : [], activeProviderId: cfg.activeProviderId || null, activeModel: cfg.activeModel || '', thinkingEffort: cfg.thinkingEffort || 'max' };
  } catch {
    return null;
  }
}

/**
 * @param {{ root?: string, label?: string }} [o]
 * @returns {{ root: string, dataRoot: string, home: string, projectsRoot: string }}
 */
export function isolateEnv({ root = null, label = 'sim' } = {}) {
  if (!process.env.__FC_SIM_ORIG_APPDATA && process.env.APPDATA) process.env.__FC_SIM_ORIG_APPDATA = process.env.APPDATA;
  const base = root || mkdtempSync(path.join(os.tmpdir(), `fc-${label}-`));
  const home = path.join(base, 'home');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const dataRoot = path.join(appData, 'FinalCheck');
  const projectsRoot = path.join(base, 'projects');
  for (const d of [home, appData, localAppData, dataRoot, projectsRoot]) mkdirSync(d, { recursive: true });
  Object.assign(process.env, {
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    USERPROFILE: home,
    HOME: home,
    FINALCHECK_CONFIG_FILE: path.join(dataRoot, 'config.json'),
    FINALCHECK_PROJECTS_FILE: path.join(dataRoot, 'projects.json'),
    FINALCHECK_SESSIONS_DIR: path.join(dataRoot, 'sessions'),
    FINALCHECK_MEMORY_DIR: path.join(dataRoot, 'memory'),
    FINALCHECK_SPILL_DIR: path.join(dataRoot, 'spill'),
    FINALCHECK_SNAPSHOTS_DIR: path.join(dataRoot, 'snapshots'),
    FINALCHECK_USAGE_FILE: path.join(dataRoot, 'usage.json'),
    FINALCHECK_HOOKS_FILE: path.join(dataRoot, 'hooks.json'),
    FINALCHECK_DEFAULT_PROJECT: path.join(projectsRoot, 'default'),
    // 会话库：和桌面端一样用 SQLite（纯 Node 走 prebuilds-node 的 Node ABI 二进制）
    FINALCHECK_SESSION_STORE: process.env.FINALCHECK_SESSION_STORE || 'sqlite',
    // 单测默认不真跑 Trivy / Semgrep（慢且要联网）
    FINALCHECK_TRIVY: process.env.FINALCHECK_TRIVY || 'off',
    FINALCHECK_SEMGREP: process.env.FINALCHECK_SEMGREP || 'off'
  });
  return { root: base, dataRoot, home, projectsRoot };
}
