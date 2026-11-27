// 0.35 手机访问：电脑和手机连的是同一个引擎，两边各自是一个完整的界面。
// 这里是「另一端做了事，这一端该怎么跟上」的纯判断，App.jsx 只负责照做。

/** 这个界面是不是手机网页（手机网页由 out/mobile 打包，桥会挂 window.__FC_MOBILE__） */
export function selfOrigin(win = globalThis.window) {
  return win && win.__FC_MOBILE__ ? 'phone' : 'desktop';
}

/** 同步事件是不是自己发出的（自己做的事自己已经更新过界面，不用再刷一遍） */
export function isOwnSync(payload, origin) {
  return !!payload && payload.origin === origin;
}

/**
 * 收到一条 agent-event，判断这条回合归谁：
 *   'own'               自己发起的（或已接上的）回合 → 照常走原来的处理
 *   'settle-reattached' 已接上的别人的回合结束了 → 走原来的 settleReattachedRun
 *   'remote-settled'    别人的回合结束了，这边没接上 → 当前正看着就从磁盘重读一次
 *   'attach'            别人刚开的回合、这边正看着这个会话 → 接上（openSession 会查快照）
 *   'mark-running'      别人的回合、这边没在看 → 侧栏转圈即可
 *   'ignore'            其它（比如自己刚结束的回合迟到的结束包）
 */
export function classifyPacket({ sid, runId, kind, run, inflight, active, ownRunIds }) {
  if (!sid) return 'own';
  const own = runId && ownRunIds && ownRunIds.has(runId);
  if (kind === 'run-settled') {
    if (run?.reattached) return 'settle-reattached';
    if (run || inflight || own) return 'ignore';
    return active ? 'remote-settled' : 'mark-idle';
  }
  if (run || inflight) return 'own';
  if (!runId || own) return 'ignore';
  return active ? 'attach' : 'mark-running';
}

/** 两份排队列表内容一样吗（「待发送」标记不算差别） */
export function sameQueue(a, b) {
  const strip = (list) => JSON.stringify((Array.isArray(list) ? list : []).map(({ hold: _h, ...rest }) => rest));
  return strip(a) === strip(b);
}
