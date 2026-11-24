// 定时唤醒的 IPC 接口（渲染层 <-> 调度器）。
//
// 为什么单独一个文件而不是塞进 ipc-sessions：
//   会话 IPC 管的是「会话本身的读写」，定时唤醒是**另一个子系统**（有自己的存档、自己的
//   调度器、自己的生命周期）。混在一起以后想给定时唤醒改存储/加 cron 表达式时会牵连会话。
//
// ⚠️ 0.32.7 踩过的坑（真机 W0 实测暴露）：调度器必须**用 engineUrl 动态加载**，
// 不能用这里的静态 import。
//   原因：打包/运行时 index.mjs 用 `engineUrl('desktop/src/main/...')` 指向 REPO_ROOT 的文件，
//   而静态 import 走的是 bundle 内的副本 —— **两个不同的模块实例**。
//   于是 startScheduler 启动的是 A 实例，isRunning()/listWakeups() 读的是 B 实例，
//   结果就是「IPC 通了但 running 永远是 false」（真机第一次跑就撞上）。
//   这里改成延迟动态加载（与 index.mjs 同一路径），保证是**同一个实例**。
import * as wakeupsCoreStatic from '../wakeups.mjs';

let schedModule = null;
let coreModule = null;
/**
 * 统一动态加载（与 index.mjs 用同一个 engineUrl）。
 *
 * ⚠️ 为什么不能静态 import：
 *   打包/运行时 `index.mjs` 用 `engineUrl('desktop/src/main/...')` 加载 REPO_ROOT 下的**文件**，
 *   而静态 import 拿到的是 bundle 内的**副本** —— 两者是不同模块实例。
 *   于是 startScheduler 启动 A 实例、isRunning() 读 B 实例 → IPC 通了但 running 永远 false，
 *   定时任务"设了但永远不触发"。真机 W0 第一次跑就撞了这个。
 *   engineUrl 由 backend.mjs 传入（它已经有这个解析器），保证和 index.mjs 同源。
 */
async function mods(engineUrl) {
  if (!schedModule) {
    const load = typeof engineUrl === 'function' ? engineUrl : null;
    schedModule = load
      ? await import(load('desktop/src/main/wakeup-scheduler.mjs'))
      : await import('../wakeup-scheduler.mjs');
    coreModule = load
      ? await import(load('desktop/src/main/wakeups.mjs'))
      : await import('../wakeups.mjs');
  }
  return { scheduler: schedModule, core: coreModule || wakeupsCoreStatic };
}

export function registerWakeupIpc({ ipcMain, engineUrl = null }) {
  // 列表（UI 用）：带上「还有多久」的人类可读文案，省得每个界面各算一遍
  ipcMain.handle('finalcheck:wakeups:list', async () => {
    const { scheduler, core } = await mods(engineUrl);
    const running = scheduler.isRunning();
    const now = Date.now();
    const items = scheduler.listWakeups().map((it) => ({
      ...it,
      inMs: Number(it.nextAt) - now,
      humanIn: core.humanizeIn(Number(it.nextAt) - now)
    }));
    return { ok: true, running, items };
  });

  // 新建：接受「延时字符串」或「毫秒数」，原因见正文档（字符串更不容易猜错）
  ipcMain.handle('finalcheck:wakeups:add', async (_e, input = {}) => {
    try {
      const { scheduler, core } = await mods(engineUrl);
      const { sessionId, prompt, delay, delayMs, repeat, label } = input || {};
      let ms = Number(delayMs);
      if (!Number.isFinite(ms) || ms <= 0) {
        const parsed = core.parseDelay(delay);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        ms = parsed.ms;
      }
      const made = core.createWakeup({ sessionId, prompt, delayMs: ms, repeat, label });
      if (!made.ok) return { ok: false, error: made.error };
      const r = await scheduler.addWakeup(made.item);
      if (!r.ok) return { ok: false, error: r.error };
      // 和 list 保持同一形状：带上「还有多久」，渲染层不用再自己算
      const now = Date.now();
      return { ok: true, item: { ...r.item, inMs: Number(r.item.nextAt) - now, humanIn: core.humanizeIn(Number(r.item.nextAt) - now) } };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  ipcMain.handle('finalcheck:wakeups:remove', async (_e, id = '') => {
    try { const { scheduler } = await mods(engineUrl); return await scheduler.removeWakeup(String(id)); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  ipcMain.handle('finalcheck:wakeups:enable', async (_e, id = '', enabled = true) => {
    try { const { scheduler } = await mods(engineUrl); return await scheduler.setWakeupEnabled(String(id), enabled === true); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

  // 一键全停：这是「额度刹车」，必须存在且好用（用户要能一键停掉所有定时任务）
  ipcMain.handle('finalcheck:wakeups:stop-all', async () => {
    try { const { scheduler } = await mods(engineUrl); return await scheduler.disableAllWakeups(); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  });

}
