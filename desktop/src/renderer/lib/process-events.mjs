import { retryLabel } from '../chat/activity.mjs';

const callId = (value) => value?.callId ?? value?.id ?? null;
const argsText = (value) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);

function finalizeThought(events, at = Date.now()) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'thought' || !e.live) continue;
    const ms = e.startedAt ? Math.max(0, at - e.startedAt) : 0;
    if (!String(e.text || '').trim() && ms < 400) events.splice(i, 1);
    else events[i] = { ...e, live: false, ms };
  }
}

/** agent 事件 → 流式 assistant 消息 reducer（App 的 onAgentEvent 回调里调用） */
export function applyAgentEvent(msg, ev) {
  if (!msg || !ev?.kind) return msg;
  const events = [...(msg.events || [])];
  switch (ev.kind) {
    case 'turn-start':
      return { ...msg, startedAt: ev.at || Date.now() };
    case 'phase': {
      if (ev.name === 'thinking' && !events.some((e) => e.type === 'thought' && e.live)) {
        events.push({ type: 'thought', text: '', startedAt: Date.now(), live: true });
      }
      return { ...msg, events };
    }
    case 'reasoning': {
      let idx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'thought' && events[i].live) { idx = i; break; }
      }
      if (idx >= 0) events[idx] = { ...events[idx], text: (events[idx].text || '') + (ev.text || '') };
      else events.push({ type: 'thought', text: ev.text || '', startedAt: Date.now(), live: true });
      return { ...msg, events };
    }
    case 'activity': {
      // 主进程真实活动提示：Writing… / Writing <tool>… / Calling <tool>… / Thinking…
      const label = typeof ev.label === 'string' ? ev.label.trim() : '';
      if (!label) return msg;
      return { ...msg, activityLabel: label, activityTone: 'activity', activity: { label, tone: 'activity', tool: ev.tool || null, chars: ev.chars ?? null, at: Date.now() } };
    }
    case 'tool-start': {
      finalizeThought(events);
      const id = callId(ev);
      const existing = id == null ? -1 : events.findIndex((e) => e.type === 'tool' && callId(e) === id);
      if (existing < 0) events.push({ type: 'tool', ...(id != null ? { id } : {}), name: ev.name || 'tool', args: argsText(ev.args), status: 'running', at: Number(ev.at) || Date.now() });
      else if (!events[existing].args) events[existing] = { ...events[existing], args: argsText(ev.args) };
      // 兜底：即使 activity 事件迟到/缺失，工具开始也会把底部文案切到 Calling <tool>…
      return { ...msg, events, activityLabel: `Calling ${ev.name || 'tool'}…`, activityTone: 'activity' };
    }
    case 'tool-end': {
      const id = callId(ev);
      // 有 id 的结束事件绝不能回退匹配另一个有 id 的同名调用。旧无 id 流按开始顺序配对。
      let idx = id == null ? -1 : events.findIndex((e) => e.type === 'tool' && callId(e) === id);
      if (idx < 0) idx = events.findIndex((e) => e.type === 'tool' && e.name === ev.name && e.status === 'running' && callId(e) == null);
      const status = ev.ok === false || ev.cancelled || ev.result?.error ? 'fail' : 'ok';
      if (idx < 0) {
        events.push({ type: 'tool', ...(id != null ? { id } : {}), name: ev.name || 'tool', args: argsText(ev.args), status, ms: ev.ms, ...(ev.result !== undefined ? { result: ev.result } : {}) });
      } else {
        events[idx] = { ...events[idx], ...(id != null ? { id } : {}), status, ms: ev.ms ?? events[idx].ms, ...(ev.result !== undefined ? { result: ev.result } : {}) };
      }
      return { ...msg, events };
    }
    case 'retry': {
      // 网关抖动自动重试：事件进时间线，同时把 WorkingStatus 切成琥珀色「重试 2/5 · 网关无响应」
      const r = { type: 'retry', attempt: ev.attempt, max: ev.max, reason: ev.reason || '' };
      events.push(r);
      return { ...msg, events, activityLabel: retryLabel(r), activityTone: 'retry', activity: { ...r, kind: 'retry', label: retryLabel(r), tone: 'retry', at: Date.now() } };
    }
    case 'workflow-start':
      // 工作流工具开始执行：先放一个空骨架（App 的实时卡在首个快照到达后被替换）
      return {
        ...msg,
        workflowStarting: true,
        workflow: {
          ...(msg.workflow || {}),
          running: true,
          starting: true,
          startedAt: msg.workflow?.startedAt || ev.at || Date.now(),
          steps: Array.isArray(msg.workflow?.steps) ? msg.workflow.steps : [],
          phases: Array.isArray(msg.workflow?.phases) ? msg.workflow.phases : [],
          concurrency: msg.workflow?.concurrency ?? 14,
          goal: msg.workflow?.goal || ''
        }
      };
    case 'workflow':
      // 工作流实时快照（多 agent 运行状态）：只更新消息上的 workflow 字段，不进普通事件列表
      return { ...msg, workflowStarting: false, workflow: { ...ev, updatedAt: Date.now() } };
    case 'turn-end':
      finalizeThought(events);
      return { ...msg, events, workedMs: ev.ms ?? msg.workedMs, turnError: !!ev.error, activityLabel: null, activityTone: null, workflowStarting: false };
    default:
      return msg;
  }
}

/** Accept both the old raw IPC cache and already reduced display events. */
export function normalizeProcessEvents(input) {
  let msg = { events: [] };
  for (const event of Array.isArray(input) ? input : []) {
    if (!event || typeof event !== 'object') continue;
    if (event.type) {
      const id = callId(event);
      const idx = event.type === 'tool' && id != null
        ? msg.events.findIndex((e) => e.type === 'tool' && callId(e) === id) : -1;
      if (idx < 0) msg.events.push({ ...event });
      else msg.events[idx] = { ...msg.events[idx], ...event };
    } else msg = applyAgentEvent(msg, event);
  }
  return msg.events;
}

/** Full trace fills missing calls as well as full args/results, without duplicating IPC calls.
 * IDs are authoritative; old traces without IDs match by args, then occurrence order.
 * completed=false keeps genuine in-flight calls running when restoring a live run.
 */
export function mergeTraceIntoEvents(events, trace, workedMs = null, { completed = true, interrupted = false, now = Date.now() } = {}) {
  const out = normalizeProcessEvents(events);
  const traces = [];
  for (const item of Array.isArray(trace) ? trace : []) {
    if (!item || typeof item !== 'object') continue;
    const id = callId(item);
    const idx = id == null ? -1 : traces.findIndex((t) => callId(t) === id);
    if (idx < 0) traces.push(item);
    else traces[idx] = { ...traces[idx], ...item };
  }
  const used = new Set();
  const matched = new Map();
  const compatible = (e, tr) => e.type === 'tool' && e.name === (tr.tool || tr.name || 'tool')
    && !(callId(e) != null && callId(tr) != null && callId(e) !== callId(tr));
  // Reserve exact matches before a partial trace can consume another call's event.
  const passes = [
    (e, tr) => callId(tr) != null && callId(e) === callId(tr),
    (e, tr) => tr.args != null && argsText(e.args) === argsText(tr.args),
    (e, tr) => {
      const preview = argsText(e.args).replace(/[…]+$/, '');
      return preview.length > 0 && argsText(tr.args).startsWith(preview);
    },
    (e, tr) => {
      if (!e.args || tr.args == null) return true;
      // Two different complete argument objects are different historical calls.
      // Name-only matching is reserved for old/truncated previews, never valid mismatches.
      try { JSON.parse(argsText(e.args)); return false; } catch { return true; }
    }
  ];
  for (const matches of passes) {
    traces.forEach((tr, ti) => {
      if (matched.has(ti)) return;
      const ei = out.findIndex((e, i) => !used.has(i) && compatible(e, tr) && matches(e, tr));
      if (ei >= 0) { matched.set(ti, out[ei]); used.add(ei); }
    });
  }
  let previous = null;
  traces.forEach((tr, ti) => {
    let entry = matched.get(ti);
    if (!entry) {
      entry = { type: 'tool', name: tr.tool || tr.name || 'tool', args: '' };
      const next = traces.slice(ti + 1).map((_, offset) => matched.get(ti + 1 + offset)).find(Boolean);
      const firstTool = out.findIndex((e) => e.type === 'tool');
      const position = next ? out.indexOf(next) : previous ? out.indexOf(previous) + 1 : firstTool >= 0 ? firstTool : out.length;
      out.splice(position, 0, entry);
    }
    const id = callId(tr);
    if (id != null) entry.id = id;
    if (tr.args != null) entry.args = argsText(tr.args);
    // A pending disk snapshot may trail IPC; it must not erase a finished result/status.
    if (tr.result != null || entry.result === undefined) entry.result = tr.result;
    if (tr.ms != null) entry.ms = tr.ms;
    if (tr.startedAt != null && !entry.at) entry.at = tr.startedAt;
    if (tr.error && !entry.result?.error) entry.result = { ...(entry.result && typeof entry.result === 'object' ? entry.result : {}), error: tr.error };
    const failed = tr.error || tr.result?.error || ['fail', 'error', 'cancelled', 'interrupted'].includes(tr.status);
    if (failed) entry.status = 'fail';
    else if (['ok', 'success'].includes(tr.status) || tr.result != null) {
      if (entry.status !== 'fail') entry.status = 'ok';
    } else if (!entry.status) entry.status = completed ? (interrupted || tr.status === 'running' ? 'fail' : 'ok') : 'running';
    previous = entry;
  });
  if (completed) {
    for (const entry of out) {
      if (entry.type === 'tool' && entry.status === 'running') entry.status = 'fail';
      if (entry.type === 'thought' && entry.live) {
        const raw = entry.startedAt ? Math.max(0, now - entry.startedAt) : null;
        const cap = Number.isFinite(workedMs) && workedMs > 0 ? workedMs : 120000;
        entry.live = false;
        entry.ms = raw == null ? null : Math.min(raw, cap);
      }
    }
  }
  return out;
}

/** Shared by live/history rendering; dedicated ask/todo cards stay out of this list. */
export function timelineEntries(msg) {
  let entries = mergeTraceIntoEvents(msg?.events, msg?.trace, msg?.workedMs, { completed: !msg?.streaming, interrupted: !!msg?.interrupted });
  entries = entries.filter((e) => ['tool', 'thought', 'retry'].includes(e.type)
    && !(e.type === 'tool' && ['ask_user', 'todo_write'].includes(e.name)));
  if (msg?.reasoning && !entries.some((e) => e.type === 'thought')) {
    entries.unshift({ type: 'thought', text: msg.reasoning, live: false, ms: null });
  }
  return entries;
}
