// 上下文压缩的界面状态机（纯逻辑，无 React 依赖；App.jsx 与单测共用）。
// 语义等同一次任务在跑：idle → running → done / failed，只有 reset 能回到 idle。
//
// 主进程事件（走 finalcheck:agent-event，只被渲染层消费，不落库）：
//   { kind: 'compact-start', scope: 'manual'|'auto', before?, at? }
//   { kind: 'compact-end',   scope: 'manual'|'auto', before?, after?, error?, cancelled? }
// 事件可能重复/迟到（手动路径既有主进程事件、也有 runCompact 的本地兜底），所以 reduce 必须幂等。

export const IDLE = Object.freeze({
  phase: 'idle', scope: null, startedAt: 0, before: null, after: null, error: '', cancelled: false
});

const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const scopeOf = (ev) => (ev.scope === 'manual' || ev.scope === 'auto' ? ev.scope : null);

function normalize(prev) {
  if (!prev || typeof prev !== 'object') return IDLE;
  if (prev.phase !== 'running' && prev.phase !== 'done' && prev.phase !== 'failed') return IDLE;
  return prev;
}

/** 状态迁移：未知事件一律原样返回（不能因为多一种事件就把界面卡在转圈）。 */
export function reduce(prev, event) {
  const state = normalize(prev);
  const ev = event && typeof event === 'object' ? event : null;
  if (!ev) return state;

  if (ev.kind === 'compact-reset') return IDLE;

  if (ev.kind === 'compact-start') {
    const scope = scopeOf(ev);
    // 同一作用域的重复 start 保留首帧（计时起点、before 都不重置）
    if (state.phase === 'running' && state.scope === scope) return state;
    // 另一作用域进来（极少见：自动压缩与手动压缩重叠）→ 以新的为准，但不丢正在跑的观感
    const at = numOrNull(ev.at);
    return {
      phase: 'running',
      scope,
      startedAt: at != null && at > 0 ? at : Date.now(),
      before: numOrNull(ev.before),
      after: null,
      error: '',
      cancelled: false
    };
  }

  if (ev.kind === 'compact-end') {
    if (state.phase !== 'running') return state;            // 重复 end / 迟到 end：幂等忽略
    const scope = scopeOf(ev);
    if (scope && state.scope && scope !== state.scope) return state; // 别的作用域收尾不能收掉本次
    const base = {
      scope: state.scope || scope,
      startedAt: state.startedAt,
      before: state.before != null ? state.before : numOrNull(ev.before),
      after: null,
      error: '',
      cancelled: false
    };
    if (ev.error) return { ...base, phase: 'failed', error: String(ev.error || '') };
    return { ...base, phase: 'done', after: numOrNull(ev.after), cancelled: ev.cancelled === true };
  }

  return state;
}

export const isRunning = (state) => normalize(state).phase === 'running';
export const isFailed = (state) => normalize(state).phase === 'failed';
