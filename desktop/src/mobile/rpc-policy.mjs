// 0.34.4 手机调用电脑的两条规则（纯函数，单独放这里方便测试）：
//   · isReadCall：只读的调用（查询、列表、打开会话）碰上网络抖动可以安全重试；会改东西的调用不重试
//   · createLatestOnly：同一种调用同时最多一个在路上，期间再来的只保留最新一次，两次之间至少隔 gapMs

const READ_CALL = /^(get|list|read)(-|$)|(^|-)(get|list|state|stats|current|open|read)$|^sessions$/;

/** 'finalcheck:projects:sessions' / 'finalcheck:agent-run-state' / 'finalcheck:get-config' → true；
 *  'finalcheck:agent-chat' / 'finalcheck:sessions:new' / 'finalcheck:set-config' → false */
export function isReadCall(channel) {
  return READ_CALL.test(String(channel || '').split(':').pop() || '');
}

/**
 * 包一层「只要最新的」：run(payload) 真正发请求。
 * 在路上的那次没回来之前又来了 N 次：只发最后那次，前面这 N 个调用方都拿到这一次的结果。
 * @param {(payload:any) => Promise<any>} run
 * @param {{gapMs?:number, now?:() => number, sleep?:(ms:number) => Promise<void>}} [o]
 */
export function createLatestOnly(run, { gapMs = 3000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let queued = null;
  let running = false;
  let lastAt = -Infinity;
  async function pump() {
    running = true;
    while (queued) {
      const wait = lastAt + gapMs - now();
      if (wait > 0) await sleep(wait);
      const q = queued; queued = null;
      lastAt = now();
      try { q.resolve(await run(q.payload)); } catch (e) { q.reject(e); }
    }
    running = false;
  }
  return function call(payload) {
    if (queued) { queued.payload = payload; return queued.promise; }
    const q = { payload };
    q.promise = new Promise((resolve, reject) => { q.resolve = resolve; q.reject = reject; });
    queued = q;
    if (!running) void pump();
    return q.promise;
  };
}
