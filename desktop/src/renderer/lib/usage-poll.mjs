// 用量页自动刷新节拍：回合进行中每 5 秒刷新一次账本数字，回合结束/接口不支持时完全不轮询。
// 抽成纯函数便于单测（不依赖 React 定时器）。
export const USAGE_POLL_MS = 5000;

/** 返回轮询间隔（毫秒）：0 = 不轮询。 */
export function usagePollInterval({ running = false, unsupported = false } = {}) {
  if (!running || unsupported) return 0;
  return USAGE_POLL_MS;
}

/**
 * 按 running 状态启动/停止轮询。返回 stop 函数（React effect 里直接 return）。
 * @param {{running?:boolean, unsupported?:boolean, tick?:Function, setIntervalFn?:Function, clearIntervalFn?:Function}} opts
 */
export function startUsagePolling({
  running = false,
  unsupported = false,
  tick = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  const ms = usagePollInterval({ running, unsupported });
  if (!ms || typeof tick !== 'function') return () => {};
  const id = setIntervalFn(tick, ms);
  return () => { if (id != null) clearIntervalFn(id); };
}
