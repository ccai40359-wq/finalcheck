// 定时唤醒的调度器：常驻一个很轻的定时器，到点**通知渲染层**「该唤醒某个会话了」。
//
// 架构决策（为什么不让主进程自己去起回合）：
//   回合启动逻辑（`runAgentChat`）是 ipc-agent.mjs 里一个约 600 行的闭包，
//   依赖 state.activeChats / liveRuns / steerBuffers / 压缩边界落库 / CU 收尾…… 一整套运行态。
//   把它抽成可复用函数风险很大（会动到发版刚验证过的路径）。
//   而「发一条消息并起回合」这件事**渲染层已经有完整实现**（`send()` → `agentChat` IPC），
//   那条路径已经处理好落盘、UI 呈现、错误提示、队列泵、停止语义。
//   所以：主进程只负责**计时与到点通知**（本文件），渲染层负责用现成路径起回合。
//   这样定时唤醒走的就是**和用户手打一条消息完全相同的代码路径** —— 不需要新造一套执行体系。
//
// 代价（必须诚实告知）：强依赖窗口存在。`index.mjs` 的 `window-all-closed` 直接 `app.quit()`，
// 所以窗口关掉 = 进程退出 = 调度停止。这是刻意接受的（后台常驻 Windows 服务是另一个量级的工作）。
import { loadWakeups, saveWakeups } from './wakeup-store.mjs';
import { dueItems, advanceDue, sanitizeItems, REPEAT_ONCE } from './wakeups.mjs';

const TICK_MS = 15_000;   // 15 秒扫一次：足够准（误差 ≤15s），又不至于吵
const CATCHUP_LIMIT = 1;  // 一次 tick 最多触发 1 条（错过补偿只补一次，见 wakeups.mjs 说明）

let timer = null;
let items = [];
let running = false;
let getDataRootFn = null;
let notifyFn = null;
let inflight = new Set();  // 正在触发中的任务 id（防止同一 tick 重复触发）

/** 当前所有任务（给 UI / IPC 读）。返回深拷贝，调用方改不到内部状态。 */
export function listWakeups() {
  return items.map((it) => ({ ...it }));
}

/** 调度器是否在跑（给 UI 显示"能/不能定时"）。 */
export function isRunning() { return running; }

/**
 * 启动调度器。幂等：重复调用只保留一个定时器。
 * @param {{getDataRoot?:()=>string, onDue?:(item:object)=>void, skipLoad?:boolean}} opts
 *   onDue：到点时回调（主进程里就是往渲染层发 IPC）
 *   skipLoad：**只给测试用**——不从磁盘读档，直接用之前 __setItemsForTest 注入的任务。
 *             生产路径永远不要传它（传了就等于不读用户存档）。
 */
export async function startScheduler({ getDataRoot = null, onDue = null, skipLoad = false } = {}) {
  getDataRootFn = getDataRoot || getDataRootFn;
  notifyFn = typeof onDue === 'function' ? onDue : notifyFn;
  if (running) return { ok: true, already: true, count: items.length };
  if (skipLoad !== true) {
    const loaded = await loadWakeups(getDataRootFn);
    items = loaded.items;
    // 启动时把「已经过期」的任务交给第一次 tick 处理（按 CATCHUP_LIMIT，不狂跑）
    running = true;
    timer = setInterval(() => { void tick(); }, TICK_MS);
    void tick();
    return { ok: true, count: items.length, file: loaded.file, loadError: loaded.error || null };
  }
  running = true;
  timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { ok: true, count: items.length, skipLoad: true };
}

/** 停止调度器（退出时调用）。不改变已存的任务，下次启动重新读档。 */
export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
  running = false;
  inflight.clear();
  return { ok: true };
}

async function persist() {
  const r = await saveWakeups(items, getDataRootFn);
  if (!r.ok) {
    // 落盘失败不能静默：任务还在内存里能跑，但重启会丢。至少要留下痕迹。
    try { console.warn('[wakeups] 落盘失败：' + (r.error || '')); } catch { /* 忽略 */ }
  }
  return r;
}

/**
 * 扫一次到期任务。
 * 对外也可调用（测试台可以手动 tick，不必等 15 秒）。
 */
export async function tick(at = Date.now()) {
  if (!running) return { fired: 0 };
  const due = dueItems(items, at).filter((it) => !inflight.has(it.id));
  if (!due.length) return { fired: 0 };

  let fired = 0;
  for (const item of due.slice(0, CATCHUP_LIMIT)) {
    inflight.add(item.id);
    fired += 1;
    try {
      // 先推进时间**再**通知：即使通知抛错/渲染层崩了，也不会在下一 tick 重复触发同一条
      // （宁可漏一次也不能变成死循环狂刷——那会静默烧额度）
      const advanced = advanceDue(item, { at, outcome: 'ok' });
      if (advanced) {
        items = items.map((x) => (x.id === item.id ? advanced : x));
      } else {
        items = items.filter((x) => x.id !== item.id);
      }
      await persist();
      try { notifyFn?.({ ...item }); } catch (e) {
        // 通知失败只记录：任务已经推进过，不会重复触发
        try { console.warn('[wakeups] 通知渲染层失败：' + (e?.message || e)); } catch { /* 忽略 */ }
      }
    } finally {
      inflight.delete(item.id);
    }
  }
  return { fired };
}

/* ---------------- 增删改（IPC 直接用这些） ---------------- */

/** 加一条任务。 */
export async function addWakeup(item) {
  if (!item) return { ok: false, error: '缺少任务' };
  if (items.length >= 50) return { ok: false, error: '定时任务已达上限（50 条），先删几条' };
  items = [...items, { ...sanitizeItems([item])[0] }];
  await persist();
  return { ok: true, item: items[items.length - 1] };
}

/** 删除一条。 */
export async function removeWakeup(id) {
  const want = String(id ?? '');
  const before = items.length;
  items = items.filter((x) => x.id !== want);
  await persist();
  return { ok: items.length !== before, count: items.length };
}

/** 启用/停用一条（停用不删，下次可以再开）。 */
export async function setWakeupEnabled(id, enabled) {
  const want = String(id ?? '');
  const on = enabled === true;
  let hit = null;
  items = items.map((x) => {
    if (x.id !== want) return x;
    hit = { ...x, enabled: on };
    return hit;
  });
  await persist();
  return hit ? { ok: true, item: { ...hit } } : { ok: false, error: '任务不存在' };
}

/** 一键全停：把所有任务停用（不删，用户还能自己再开）。 */
export async function disableAllWakeups() {
  const n = items.filter((x) => x.enabled !== false).length;
  items = items.map((x) => ({ ...x, enabled: false }));
  await persist();
  return { ok: true, disabled: n, count: items.length };
}

/** 测试辅助：直接替换内部任务表（只在测试里用，不经过落盘）。 */
export function __setItemsForTest(next) {
  items = sanitizeItems(next);
  return items.length;
}

export { REPEAT_ONCE };
