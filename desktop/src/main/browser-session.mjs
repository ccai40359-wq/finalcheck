// 浏览器会话三模式的纯逻辑（不 import electron，可在纯 Node 里直测）。
//
// 三种模式共用 2 个宿主 + 2 种存储策略（0.31.0）：
//   ① 离屏无痕（默认）：Electron 离屏 Chromium，partition 无 persist: 前缀 → session 在内存
//   ② 离屏持久：同一窗口实现，partition 加 persist: 前缀 → cookie 写磁盘（userData/Partitions/）
//   ③ CDP 接真 Edge（高级）：跨进程遥控隔离 Edge（见 browser-real.mjs，端口 9224）
//
// 这里只放「选哪个 partition / 清哪些目录」这类可在进程外验证的判定，窗口生命周期留在 browser-use.mjs。

export const PARTITION_ONESHOT = 'fc-browser-use';
export const PARTITION_PERSISTENT = 'persist:fc-browser-use';

/** 'oneshot'（一次性，默认）/ 'persistent'（长期保留）/ ''（用户还没选过） */
export const SESSION_MODES = Object.freeze(['oneshot', 'persistent']);

// partition 纯函数：true → persist:（写盘）；其余（含 undefined）→ 内存 session。
export function resolvePartition(persistent) {
  return persistent === true ? PARTITION_PERSISTENT : PARTITION_ONESHOT;
}

// 0.32.7：一次性（无痕）存储按会话分开。以前所有对话共用 'fc-browser-use'，
// 在对话 A 登录的网站，对话 B 也是登录状态，直到重启 FC——和「无痕」「会话隔离」的说法不符。
// 现在每个会话派生自己的内存 partition；「长期保留」（persist:）按用户的选择仍是全局共享。
// 幂等：已经派生过的名字原样返回。
import { createHash } from 'node:crypto';

export function sessionPartition(partition, sessionId) {
  const base = String(partition || PARTITION_ONESHOT);
  if (base !== PARTITION_ONESHOT || sessionId == null || sessionId === '') return base;
  const tag = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
  return `${PARTITION_ONESHOT}-${tag}`;
}

// 配置归一：只认 oneshot / persistent；未选过（缺省、旧配置、脏值）一律 '' 表示「还没选择」。
export function normalizeSessionMode(value) {
  return value === 'persistent' ? 'persistent' : value === 'oneshot' ? 'oneshot' : '';
}

/**
 * 配置 → 本轮实际策略。默认必须是无痕：chosen=false 时 mode 仍是 oneshot，
 * 调用方可以据此在首次使用时弹一次选择（选过之后不再打扰）。
 * @returns {{ mode: 'oneshot'|'persistent', chosen: boolean, persistent: boolean, partition: string }}
 */
export function sessionPolicyOf(cfg) {
  const raw = normalizeSessionMode(cfg?.browserSessionMode);
  const chosen = raw !== '';
  const mode = raw === 'persistent' ? 'persistent' : 'oneshot';
  return { mode, chosen, persistent: mode === 'persistent', partition: resolvePartition(mode === 'persistent') };
}

// Electron 把 persist: 会话落在 <userData>/Partitions/<去掉 persist: 前缀>（Chromium profile 的惯例布局）。
// 用 path.join 保持平台原生分隔符：清空目录时要交给 fs.rm，混用 '/' 在 Windows 上虽然能跑，
// 但测试/日志里比对路径时会出现 `C:\a/b` 这种半截混排，排查困难。
import path from 'node:path';

export function partitionDataDir(userDataDir, partition = PARTITION_PERSISTENT) {
  const name = String(partition || '').replace(/^persist:/, '');
  if (!userDataDir || !name) return '';
  return path.join(String(userDataDir), 'Partitions', name);
}

// 清空浏览器数据时要动的目录：持久 partition 的落盘位置（无痕 session 在内存，无目录可删）。
export function browserDataPaths(userDataDir) {
  const dir = partitionDataDir(userDataDir, PARTITION_PERSISTENT);
  return dir ? [dir] : [];
}

// —— 清空浏览器数据（设置页按钮） ——
// 只清 persist:fc-browser-use 那一套（绝不碰用户日常 Edge 的 profile、也不碰 datacrawler 的 9223 profile）。
//
// 真机实测（Windows + Electron 33）的两个坑：
//   ① 光关窗口就 rm 目录 → EBUSY：Chromium 的 network service 仍握着
//      SharedStorage-wal / PrivateAggregation 等文件的句柄，进程不退出就删不掉。
//   ② 只删目录（假如删成了）也不够 —— cookie 还在 SQLite 的 Cookies 文件里，
//      下次进程起来照样读回去，用户看到「清空了怎么还登录着」。
// 所以顺序是：关窗口 → session.clearStorageData()（这一步实测重启后 cookie 数为 0）→ 再尽力删目录。
// 删目录失败（EBUSY）不判失败：数据已经被 clearStorageData 清掉，残留的只是缓存文件；
// 结果里如实区分 removed（真的删了）与 cleared（数据清了但目录还占着）。
// browserUse 由调用方注入：本模块不 import electron，纯 Node 单测时传 null 即可。
export async function clearBrowserData({ userDataDir, browserUse = null, rm, session = null }) {
  // 关窗（无痕/持久共用同一个 active 窗口，close() 幂等）
  try {
    browserUse?.close?.();
  } catch {
    /* 已关闭 / 未初始化：照常往下清 */
  }
  // 数据层清空：cookie / localStorage / indexedDB 全清。这一步是「清空登录态」的真正生效点。
  let cleared = false;
  let clearError = '';
  if (session && typeof session.clearStorageData === 'function') {
    try {
      await session.clearStorageData();
      cleared = true;
    } catch (e) {
      clearError = String((e && e.message) || e);
    }
  }
  const paths = browserDataPaths(userDataDir);
  const removed = [];
  const failed = [];
  for (const dir of paths) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed.push(dir);
    } catch (e) {
      // EBUSY：文件句柄还在（Chromium 进程没退干净）。数据已被 clearStorageData 清掉，
      // 这里只损失磁盘空间，不该让用户以为「没清成功」。
      failed.push({ path: dir, error: String((e && e.message) || e) });
    }
  }
  const ok = cleared || failed.length === 0;
  return { ok, cleared, removed, failed, paths, ...(clearError ? { clearError } : {}) };
}
