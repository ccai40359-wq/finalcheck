// 0.33.5 后台任务（对齐 Claude Code 的 run_in_background / 后台子代理）。
//
// 用户原话：「派出一个子 agent，然后主 agent 自己干自己的活，甚至干完了纯等子 agent 回复或者用户的消息」
//           「主 agent 跑了一个脚本……可以把进程挂后台，直接停下来，再接收用户信息做其他事情；
//            但如果这个脚本几秒钟跑完了，那就没必要停」。
//
// 这里只管「账本」：登记、输出尾巴、完成/失败/停止、等待、以及「还没告诉模型的完成通知」。
// 不 import electron、不碰模型，可直接单测。真正的进程 / 子代理由调用方（agent-tools / ipc-agent）跑，
// 把 stop 函数和输出交进来。
//
// 通知怎么送到模型（ipc-agent 接线）：
//   · 会话正在跑回合 → 下一次模型请求前随 Steer 一起注入（takeUndelivered）
//   · 会话空闲       → 发 finalcheck:bg-task-done 给界面，界面在该会话空闲时自动起一轮（不抢用户当前视图）
//   · 用户自己先发了消息 → 回合开头同样会把未送达的通知注入

// 头尾保留拼接（与 agent-tools.mjs 同语义；这里内联，免得反向依赖那个大模块）
function appendKeepEnds(cur, chunk, cap, dropped = 0) {
  const next = cur + chunk;
  if (next.length <= cap) return { text: next, dropped };
  const half = Math.floor(cap / 2);
  return { text: next.slice(0, half) + next.slice(next.length - (cap - half)), dropped: dropped + (next.length - cap) };
}
function markOmitted(text, dropped, cap) {
  if (!dropped) return text;
  const half = Math.floor(cap / 2);
  return `${text.slice(0, half)}\n…[输出过长，中间省略 ${dropped} 字符]…\n${text.slice(half)}`;
}

export const BG_OUTPUT_CAP = 200000;          // 后台命令输出收集上限（头尾保留）
export const BG_NOTICE_TAIL = 4000;           // 通知里带的输出尾巴
export const BG_REPORT_MAX = 12000;           // 子代理报告进上下文的上限（和前台 spawn_agent 一致）
export const BG_WAIT_MAX_MS = 10 * 60 * 1000; // background_task wait 最长等 10 分钟
export const BG_MAX_RUNNING = 6;              // 每个会话同时在跑的后台任务上限
export const BG_KEEP_FINISHED = 30;           // 每个会话保留的已结束任务条数（面板 / 查询用）

const TERMINAL = new Set(['done', 'failed', 'stopped']);

export function createBgTaskManager({ now = () => Date.now(), onChange = () => {}, onFinish = () => {}, maxRunning = BG_MAX_RUNNING } = {}) {
  const tasks = new Map(); // id → task（内部对象，含 stop 函数 / waiters）
  let seq = 0;

  const emit = (task) => { try { onChange(task.sessionId, list(task.sessionId)); } catch { /* 界面已关 */ } };

  function summary(task) {
    return {
      id: task.id,
      sessionId: task.sessionId,
      kind: task.kind,
      title: task.title,
      detail: task.detail,
      status: task.status,
      startedAt: task.startedAt,
      endedAt: task.endedAt || null,
      ms: (task.endedAt || now()) - task.startedAt,
      ...(task.pid ? { pid: task.pid } : {}),
      ...(task.exitCode !== undefined && task.exitCode !== null ? { exitCode: task.exitCode } : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(task.agentId ? { agentId: task.agentId } : {}),
      delivered: !!task.delivered,
      outputChars: task.out.length
    };
  }

  function list(sessionId) {
    const sid = String(sessionId ?? '');
    return [...tasks.values()].filter((x) => x.sessionId === sid).map(summary)
      .sort((a, b) => (a.status === 'running') === (b.status === 'running') ? b.startedAt - a.startedAt : a.status === 'running' ? -1 : 1);
  }

  function running(sessionId) {
    const sid = String(sessionId ?? '');
    return [...tasks.values()].filter((x) => x.sessionId === sid && x.status === 'running').length;
  }

  function prune(sessionId) {
    const done = [...tasks.values()].filter((x) => x.sessionId === sessionId && TERMINAL.has(x.status) && x.delivered)
      .sort((a, b) => a.endedAt - b.endedAt);
    while (done.length > BG_KEEP_FINISHED) tasks.delete(done.shift().id);
  }

  /** 登记一个后台任务。超过并发上限返回 { error }（调用方据此退回前台执行或告诉模型）。 */
  function start({ sessionId, kind = 'command', title = '', detail = '', pid = null, stop: stopFn = null, agentId = null } = {}) {
    const sid = String(sessionId ?? '');
    if (running(sid) >= maxRunning) {
      return { error: `后台任务已达上限（同时最多 ${maxRunning} 个）。先用 background_task 等其中一个结束，或 stop 掉不需要的。` };
    }
    seq += 1;
    const task = {
      id: `bg-${seq}`,
      sessionId: sid,
      kind: kind === 'agent' ? 'agent' : 'command',
      title: String(title || '').slice(0, 200),
      detail: String(detail || '').slice(0, 2000),
      status: 'running',
      startedAt: now(),
      endedAt: 0,
      pid: pid || null,
      agentId: agentId || null,
      stopFn: typeof stopFn === 'function' ? stopFn : null,
      out: '',
      dropped: 0,
      result: '',
      exitCode: null,
      error: '',
      delivered: false,
      waiters: []
    };
    tasks.set(task.id, task);
    emit(task);
    return { task: summary(task), id: task.id };
  }

  function append(id, chunk) {
    const task = tasks.get(String(id));
    if (!task || !chunk) return;
    ({ text: task.out, dropped: task.dropped } = appendKeepEnds(task.out, String(chunk), BG_OUTPUT_CAP, task.dropped));
  }

  function setOutput(id, text) {
    const task = tasks.get(String(id));
    if (!task) return;
    task.out = '';
    task.dropped = 0;
    append(id, text);
  }

  function patch(id, fields = {}) {
    const task = tasks.get(String(id));
    if (!task) return;
    if (fields.pid) task.pid = fields.pid;
    if (fields.agentId) task.agentId = fields.agentId;
    if (typeof fields.stop === 'function') task.stopFn = fields.stop;
    emit(task);
  }

  /** 结束：status = done | failed | stopped。重复结束无效（先到先得）。 */
  function finish(id, { status = 'done', exitCode = null, result = '', error = '' } = {}) {
    const task = tasks.get(String(id));
    if (!task || TERMINAL.has(task.status)) return false;
    task.status = TERMINAL.has(status) ? status : 'done';
    task.endedAt = now();
    task.exitCode = exitCode;
    task.result = String(result || '');
    task.error = String(error || '');
    task.stopFn = null;
    const waiters = task.waiters.splice(0);
    for (const w of waiters) { try { w(); } catch { /* 忽略 */ } }
    emit(task);
    try { onFinish(summary(task)); } catch { /* 通知失败不影响账本 */ }
    prune(task.sessionId);
    return true;
  }

  /** 用户 / 模型叫停：调 stop 函数（杀进程树 / abort 子代理），账本记 stopped。 */
  function stop(id, { by = 'user' } = {}) {
    const task = tasks.get(String(id));
    if (!task) return { ok: false, error: `没有这个后台任务：${id}` };
    if (TERMINAL.has(task.status)) return { ok: true, already: true, status: task.status };
    try { task.stopFn?.(); } catch { /* 进程可能已退出 */ }
    // 模型自己停的不用再通知它（它知道）；用户在面板上停的要告诉模型
    if (by === 'model') task.delivered = true;
    finish(id, { status: 'stopped', error: by === 'model' ? '已按你的要求停止' : '用户在任务面板里停止了它' });
    return { ok: true, status: 'stopped' };
  }

  function stopSession(sessionId) {
    let n = 0;
    for (const task of tasks.values()) {
      if (task.sessionId === String(sessionId ?? '') && task.status === 'running') { stop(task.id); n++; }
    }
    return n;
  }

  /** 等一个任务结束，最多 ms 毫秒；signal 中断时提前返回。返回 { done, task } */
  function wait(id, ms = 60000, signal = null) {
    const task = tasks.get(String(id));
    if (!task) return Promise.resolve({ done: false, error: `没有这个后台任务：${id}` });
    if (TERMINAL.has(task.status)) return Promise.resolve({ done: true, task: summary(task) });
    const limit = Math.max(0, Math.min(BG_WAIT_MAX_MS, Number(ms) || 0));
    return new Promise((resolve) => {
      let timer = null;
      const settle = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener?.('abort', settle);
        const idx = task.waiters.indexOf(settle);
        if (idx >= 0) task.waiters.splice(idx, 1);
        resolve({ done: TERMINAL.has(task.status), task: summary(task) });
      };
      task.waiters.push(settle);
      timer = setTimeout(settle, limit);
      timer.unref?.();
      if (signal) {
        if (signal.aborted) settle();
        else signal.addEventListener('abort', settle, { once: true });
      }
    });
  }

  function output(id, { tail = BG_NOTICE_TAIL } = {}) {
    const task = tasks.get(String(id));
    if (!task) return null;
    const text = markOmitted(task.out, task.dropped, BG_OUTPUT_CAP);
    const n = Math.max(200, Number(tail) || BG_NOTICE_TAIL);
    return text.length > n ? `…[前面省略 ${text.length - n} 字符]\n${text.slice(-n)}` : text;
  }

  function get(id) {
    const task = tasks.get(String(id));
    return task ? { ...summary(task), result: task.result } : null;
  }

  /** 结束了但还没告诉模型的任务（取走即标记送达）。 */
  function takeUndelivered(sessionId) {
    const sid = String(sessionId ?? '');
    const out = [];
    for (const task of tasks.values()) {
      if (task.sessionId !== sid || !TERMINAL.has(task.status) || task.delivered) continue;
      task.delivered = true;
      out.push({ ...summary(task), notice: noticeText(task) });
    }
    if (out.length) emit({ sessionId: sid });
    return out.sort((a, b) => a.endedAt - b.endedAt);
  }

  function hasUndelivered(sessionId) {
    const sid = String(sessionId ?? '');
    for (const task of tasks.values()) if (task.sessionId === sid && TERMINAL.has(task.status) && !task.delivered) return true;
    return false;
  }

  /** 给模型看的完成通知（注入为一条 user 消息）。 */
  function noticeText(task) {
    const secs = Math.max(1, Math.round(((task.endedAt || now()) - task.startedAt) / 1000));
    const head = task.kind === 'agent'
      ? `【后台任务完成】${task.id} 子代理「${task.title}」${statusZh(task.status)}（用时 ${secs}s）。`
      : `【后台任务完成】${task.id} 命令${statusZh(task.status)}（用时 ${secs}s${task.exitCode !== null && task.exitCode !== undefined ? `，退出码 ${task.exitCode}` : ''}）：${task.title}`;
    const parts = [head];
    if (task.error) parts.push(`原因：${task.error}`);
    if (task.kind === 'agent') {
      const r = task.result.length > BG_REPORT_MAX ? `${task.result.slice(0, BG_REPORT_MAX)}\n…[报告过长，已截到前 ${BG_REPORT_MAX} 字符]` : task.result;
      parts.push(r ? `子代理报告：\n${r}` : '子代理没有交回报告。');
    } else {
      const tail = output(task.id);
      parts.push(tail ? `输出（末尾）：\n${tail}` : '（没有输出）');
    }
    parts.push('这是系统自动送达的后台任务结果，不是用户的新消息：结合它继续手头的工作；如果用户在等这个结果，就向用户汇报结论。');
    return parts.join('\n');
  }

  return { start, append, setOutput, patch, finish, stop, stopSession, wait, output, get, list, running, takeUndelivered, hasUndelivered, noticeText: (id) => { const tk = tasks.get(String(id)); return tk ? noticeText(tk) : ''; } };
}

function statusZh(status) {
  return status === 'done' ? '已完成' : status === 'failed' ? '失败' : status === 'stopped' ? '已停止' : '运行中';
}
