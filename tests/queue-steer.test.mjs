// 排队 + Steer：队列纯函数单测 + agent-service 工具循环内注入 Steer 的集成单测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// App.jsx 是 JSX，Node 不能直接 import；队列纯函数用标记段隔离，单测按标记提取后求值。
// 改动这段时保持「无副作用、无 React、无 JSX」，否则这里会直接失败提醒。
function loadQueueHelpers() {
  const src = readFileSync(path.join(repoRoot, 'desktop', 'src', 'renderer', 'App.jsx'), 'utf8');
  const m = src.match(/\/\* QUEUE-HELPERS-BEGIN \*\/([\s\S]*?)\/\* QUEUE-HELPERS-END \*\//);
  assert.ok(m, 'App.jsx 必须保留 QUEUE-HELPERS-BEGIN/END 标记段');
  const factory = new Function(`${m[1]}\nreturn { enqueue, takeNext, removeById, moveToInput };`);
  return factory();
}

const Q = loadQueueHelpers();
const msg = (id, text) => ({ id, text, pasted: [], previews: [] });

test('queue: enqueue 追加到队尾（FIFO 不插队、不改原数组）', () => {
  const base = [msg('a', '第一条')];
  const next = Q.enqueue(base, msg('b', '第二条'));
  assert.deepEqual(next.map((x) => x.id), ['a', 'b']);
  assert.deepEqual(base.map((x) => x.id), ['a'], 'enqueue 不能改动入参数组');
});

test('queue: takeNext 取队首并返回剩余（空队列给 null）', () => {
  const list = [msg('a', 'A'), msg('b', 'B')];
  const { item, rest } = Q.takeNext(list);
  assert.equal(item.id, 'a');
  assert.deepEqual(rest.map((x) => x.id), ['b']);
  assert.deepEqual(list.map((x) => x.id), ['a', 'b'], 'takeNext 不能改动原数组');
  const empty = Q.takeNext([]);
  assert.equal(empty.item, null);
  assert.deepEqual(empty.rest, []);
  assert.equal(Q.takeNext(undefined).item, null, '非数组入参也不能崩');
});

test('queue: 忙时连续入队不丢消息——按 FIFO 全部取回', () => {
  // 模拟旧实现「忙时直接 return 丢弃」：新实现必须把每条都留在队列里
  let queue = [];
  for (const t of ['一', '二', '三']) queue = Q.enqueue(queue, msg('q' + t, t));
  const drained = [];
  for (let i = 0; i < 3; i++) {
    const { item, rest } = Q.takeNext(queue);
    queue = rest;
    drained.push(item.text);
  }
  assert.deepEqual(drained, ['一', '二', '三']);
  assert.deepEqual(queue, []);
});

test('queue: removeById 只删对应条，顺序不变；未知 id 原样返回', () => {
  const list = [msg('a', 'A'), msg('b', 'B'), msg('c', 'C')];
  const removed = Q.removeById(list, 'b');
  assert.deepEqual(removed.map((x) => x.id), ['a', 'c']);
  assert.deepEqual(list.map((x) => x.id), ['a', 'b', 'c'], 'removeById 不能改动入参数组');
  assert.equal(Q.removeById(list, 'zzz'), list, '未知 id 必须原样返回（保持引用稳定）');
});

test('queue: moveToInput 取回编辑——文本与附件一并带回并从队列移除', () => {
  const attach = { path: 'D:/x/shot.png', name: 'shot.png', size: 12, preview: 'data:image/png;base64,xx' };
  const item = { id: 'q1', text: '把这段改一下', pasted: ['多行粘贴内容'], previews: [attach] };
  const list = [msg('a', 'A'), item];
  const { item: got, rest } = Q.moveToInput(list, 'q1');
  assert.equal(got.text, '把这段改一下');
  assert.deepEqual(got.pasted, ['多行粘贴内容'], '粘贴块随消息取回输入框');
  assert.deepEqual(got.previews, [attach], '附件随消息取回输入框');
  assert.deepEqual(rest.map((x) => x.id), ['a']);
  const miss = Q.moveToInput(list, 'nope');
  assert.equal(miss.item, null);
  assert.equal(miss.rest, list);
});

/* ---------- Steer：消息立刻上屏 + 中断当前回合 + 用同一条消息重开一回合 ---------- */

// Steer 的状态迁移同样在 App.jsx 里用标记段隔离（无 React/无副作用），提取后单测。
function loadSteerHelpers() {
  const src = readFileSync(path.join(repoRoot, 'desktop', 'src', 'renderer', 'App.jsx'), 'utf8');
  const m = src.match(/\/\* STEER-HELPERS-BEGIN \*\/([\s\S]*?)\/\* STEER-HELPERS-END \*\//);
  assert.ok(m, 'App.jsx 必须保留 STEER-HELPERS-BEGIN/END 标记段');
  const factory = new Function(`${m[1]}\nreturn { steerMessageText, insertUserBubble, planSteer };`);
  return factory();
}

// 队列泵闸门 / 停止看门狗：同样按标记段提取（纯函数）。
function loadPumpHelpers() {
  const src = readFileSync(path.join(repoRoot, 'desktop', 'src', 'renderer', 'App.jsx'), 'utf8');
  const m = src.match(/\/\* PUMP-HELPERS-BEGIN \*\/([\s\S]*?)\/\* PUMP-HELPERS-END \*\//);
  assert.ok(m, 'App.jsx 必须保留 PUMP-HELPERS-BEGIN/END 标记段');
  const factory = new Function(`${m[1]}\nreturn { turnOutcomeOf, canAutoPump, holdsQueue, expiredStopping, STOPPING_WATCHDOG_MS };`);
  return factory();
}
const P = loadPumpHelpers();

const S = loadSteerHelpers();
// 复刻 sendOnce 组装 wire history 的过滤条件：占位气泡必须被过滤掉（否则真实消息 + 占位 = 两条）
const wireOf = (msgs) => msgs
  .filter((m) => !m.error && !m.local && !m.steer && (m.role === 'user' || m.role === 'assistant'))
  .map((m) => ({ role: m.role, content: m.content }));

test('steer: 点 Steer 后消息立刻以用户气泡出现在对话里，同时从排队区出队', () => {
  const item = { id: 'q1', text: 'hi 换成只看 C 盘', pasted: [], previews: [] };
  const queue = [msg('a', '后面那条'), item];
  const messages = [
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '正在输出…', streaming: true }
  ];
  const plan = S.planSteer(queue, messages, 'q1');
  assert.equal(plan.item.id, 'q1');
  assert.deepEqual(plan.queue.map((x) => x.id), ['a'], 'Steer 的这条必须从队列移除，别的条目顺序不变');
  assert.equal(plan.messages.length, 3, '对话里必须多出一条（这就是「消失但什么都没出现」的修复点）');
  const bubble = plan.messages[1];
  assert.equal(bubble.role, 'user');
  assert.equal(bubble.content, 'hi 换成只看 C 盘');
  assert.equal(bubble.local, true, '占位气泡要标 local，sendOnce 才会把它排除在 wire history 之外');
  // 插在流式气泡之前：最后一条仍是 streaming assistant，token/turn-end 归约链不断
  assert.equal(plan.messages[2].role, 'assistant');
  assert.equal(plan.messages[2].streaming, true);
  assert.equal(messages.length, 2, 'planSteer 不能改动入参数组');
});

test('steer: 不会重复两条——占位气泡不进 wire history，真实消息只由 sendOnce 追加一次', () => {
  const item = { id: 'q1', text: '再来一次', pasted: [], previews: [] };
  const plan = S.planSteer([item], [{ role: 'user', content: '旧问题' }], 'q1');
  // sendOnce 的行为：baseList = 过滤后的历史，再追加一次 {role:'user', content:finalText}
  const wire = [...wireOf(plan.messages), { role: 'user', content: plan.text }];
  assert.equal(wire.filter((m) => m.content === '再来一次').length, 1, '同一条 Steer 消息在发给模型的上下文里只能出现一次');
  assert.equal(wire[wire.length - 1].content, '再来一次');
});

test('steer: 幂等——同一条已出队的消息再点一次不会重复上屏', () => {
  const item = { id: 'q1', text: 'hi', pasted: [], previews: [] };
  const first = S.planSteer([item], [], 'q1');
  const second = S.planSteer(first.queue, first.messages, 'q1');
  assert.equal(second.item, null);
  assert.equal(second.text, '');
  assert.equal(second.messages, first.messages, '已出队的 id 再点必须原样返回（不新增气泡）');
  assert.equal(second.messages.length, 1);
  // 未知 id 同理
  const miss = S.planSteer([msg('a', 'A')], [], 'nope');
  assert.equal(miss.item, null);
  assert.equal(miss.messages.length, 0);
});

test('steer: 正文按 正文 → 粘贴块 → 附件 组装；只有附件也不算空', () => {
  const attach = { path: 'C:/x/shot.png', name: 'shot.png', size: 1, preview: null };
  const item = { id: 'q1', text: '  看这张  ', pasted: ['第一段粘贴', ''], previews: [attach] };
  const text = S.steerMessageText(item);
  assert.equal(text, '看这张\n\n第一段粘贴\n\n[附件]\n- C:/x/shot.png');
  assert.ok(text.indexOf('看这张') < text.indexOf('第一段粘贴'), '正文在粘贴块之前');
  assert.ok(text.indexOf('第一段粘贴') < text.indexOf('[附件]'), '附件清单在最后');
  assert.equal(S.steerMessageText({ id: 'q2', text: '', pasted: [], previews: [attach] }).startsWith('[附件]'), true);
  assert.equal(S.steerMessageText({ id: 'q3', text: '  ', pasted: [''] }), '', '全空消息 → 空串，调用方据此拒绝 Steer');
});

test('steer: 尾部不是流式消息时（例如刚停止/已中断）气泡追加在最后，不插到历史中间', () => {
  const messages = [
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '半句', interrupted: true }
  ];
  const next = S.insertUserBubble(messages, '新指令');
  assert.equal(next.length, 3);
  assert.equal(next[2].role, 'user');
  assert.equal(next[2].content, '新指令');
  assert.equal(next[1].interrupted, true, '已中断的助手消息保持原位');
});

/* ---------- agent-service：Steer 注入 ---------- */

function sse(chunks) {
  const body = chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const cfg = () => ({ baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' });

test('steer: 工具循环内 drainSteer → 第二次请求带【Steer】，并推送 steer 事件', async () => {
  const bodies = [];
  const events = [];
  let drains = 0;
  const drainSteer = () => {
    drains += 1;
    return drains === 2 ? ['改成只看 C 盘'] : [];
  };
  const mockFetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'audit_project', arguments: '{"dir":"D:/x","tier":"L1"}' } }] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: '已改成只看 C 盘' } }] }]);
  };
  const out = await runAgentTurn({
    config: cfg(),
    messages: [{ role: 'user', content: '帮我体检 D:/x' }],
    tools: { audit_project: async () => ({ verdict: '过' }) },
    fetchImpl: mockFetch,
    onEvent: (ev) => events.push(ev),
    drainSteer
  });
  assert.equal(out.answer, '已改成只看 C 盘');
  assert.equal(bodies.length, 2, '必须真的是两步循环');
  // 第一次请求前 drain 为空：不能凭空出现 Steer
  assert.ok(!bodies[0].messages.some((m) => String(m.content || '').includes('【Steer】')));
  // 第二次请求：Steer 以 user 消息追加，且已完成的工具结果没有被重置
  const second = bodies[1].messages;
  const steerMsg = second.find((m) => m.role === 'user' && String(m.content || '').includes('【Steer】改成只看 C 盘'));
  assert.ok(steerMsg, '第二次请求的 messages 必须含【Steer】改成只看 C 盘');
  assert.ok(second.some((m) => m.role === 'tool' && String(m.content || '').includes('verdict')), '工具结果必须仍在本轮上下文里');
  // 渲染层事件：steer 事件带原文
  assert.ok(events.some((e) => e.kind === 'steer' && e.text === '改成只看 C 盘'), 'onEvent 必须收到 steer 事件');
  assert.deepEqual(out.trace.map((t) => t.tool), ['audit_project']);
});

test('steer: 一次 drain 多条按顺序注入；drainSteer 抛错不阻断回合', async () => {
  const events = [];
  let drains = 0;
  const drainSteer = () => {
    drains += 1;
    if (drains === 2) {
      throw new Error('模拟渲染层队列读取失败');
    }
    if (drains === 1) return [];
    return [];
  };
  // 先验证正常的多条注入
  const multi = [];
  let n = 0;
  const drainMulti = () => {
    n += 1;
    return n === 2 ? ['第一条注入', '第二条注入'] : [];
  };
  const mockFetch = async (_url, opts) => {
    multi.push(JSON.parse(opts.body));
    if (multi.length === 1) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'audit_project', arguments: '{"dir":"D:/x"}' } }] } }] }]);
    }
    return sse([{ choices: [{ delta: { content: 'ok' } }] }]);
  };
  await runAgentTurn({
    config: cfg(),
    messages: [{ role: 'user', content: '体检' }],
    tools: { audit_project: async () => ({ verdict: '过' }) },
    fetchImpl: mockFetch,
    onEvent: (ev) => events.push(ev),
    drainSteer: drainMulti
  });
  const second = multi[1].messages;
  const idx1 = second.findIndex((m) => String(m.content || '').includes('【Steer】第一条注入'));
  const idx2 = second.findIndex((m) => String(m.content || '').includes('【Steer】第二条注入'));
  assert.ok(idx1 >= 0 && idx2 > idx1, '多条 Steer 必须按 drain 顺序注入');
  assert.equal(events.filter((e) => e.kind === 'steer').length, 2);

  // drainSteer 抛错：被吞掉，回合照常完成
  const out = await runAgentTurn({
    config: cfg(),
    messages: [{ role: 'user', content: '体检' }],
    tools: {},
    fetchImpl: async () => sse([{ choices: [{ delta: { content: '答' } }] }]),
    onEvent: (ev) => events.push(ev),
    drainSteer
  });
  assert.equal(out.answer, '答');
});

/* ---------- 队列泵闸门 / 停止看门狗（F4） ---------- */
test('队列泵：回合以 stopped / error 收尾后不再自动消费队列；正常结束继续自动发', () => {
  const base = { sid: 's1', busy: false, stopping: false, pumping: false, inflight: false, steering: false };
  assert.equal(P.canAutoPump({ ...base, outcome: 'stopped' }), false, '用户点了停止：绝不能自己又发下一条');
  assert.equal(P.canAutoPump({ ...base, outcome: 'error' }), false, '回合报错收尾：也不自动发（避免错误连环）');
  assert.equal(P.canAutoPump({ ...base, outcome: 'ok' }), true, '正常结束：队列照旧自动发送');
  assert.equal(P.canAutoPump({ ...base, outcome: undefined }), true, '还没跑过回合：保持原行为');
  assert.equal(P.holdsQueue('stopped'), true);
  assert.equal(P.holdsQueue('error'), true);
  assert.equal(P.holdsQueue('ok'), false);
});

test('队列泵：忙 / 停止中 / 正在泵 / send 未收尾 / Steer 中都不消费（闸门优先级不被 outcome 覆盖）', () => {
  const ok = { sid: 's1', outcome: 'ok' };
  for (const key of ['busy', 'stopping', 'pumping', 'inflight', 'steering']) {
    assert.equal(P.canAutoPump({ ...ok, [key]: true }), false, `${key} 时必须拦下自动发送`);
  }
  assert.equal(P.canAutoPump({ ...ok, sid: null }), false, '没有会话时不消费');
  assert.equal(P.canAutoPump({}), false, '空参数不崩、不消费');
});

test('agent-chat 返回体 → 收尾类型：cancelled/已取消 是 stopped，其它 error 是 error', () => {
  assert.equal(P.turnOutcomeOf({ cancelled: true }), 'stopped');
  assert.equal(P.turnOutcomeOf({ error: '已取消' }), 'stopped');
  assert.equal(P.turnOutcomeOf({ error: '模型未配置' }), 'error');
  assert.equal(P.turnOutcomeOf({ answer: '完成' }), 'ok');
  assert.equal(P.turnOutcomeOf(null), 'ok');
});

test('stopping 看门狗：15s 超时后强制解除停止态（否则每次发送只入队）', () => {
  const now = 1_000_000;
  assert.deepEqual(P.expiredStopping({ a: now - 1_000 }, now), [], '刚点停止：还在正常等待');
  assert.deepEqual(P.expiredStopping({ a: now - P.STOPPING_WATCHDOG_MS }, now), ['a'], '到点必须恢复');
  assert.deepEqual(P.expiredStopping({ a: now - 20_000, b: now - 100 }, now), ['a'], '只恢复超时的那一个');
  assert.deepEqual(P.expiredStopping({}, now), [], '没有停止中的会话时什么都不做');
  assert.deepEqual(P.expiredStopping(null, now), [], '非对象入参不崩');
  assert.equal(P.STOPPING_WATCHDOG_MS, 15000);
});

test('队列泵：重启后恢复的「待发送」条目（hold）不会被自动消费，点发送才发', () => {
  const base = { sid: 's1', busy: false, stopping: false, pumping: false, inflight: false, steering: false, outcome: 'ok' };
  assert.equal(P.canAutoPump({ ...base, headHeld: true }), false, '恢复出来的队列必须等用户点发送');
  assert.equal(P.canAutoPump({ ...base, headHeld: false }), true, '普通排队消息照旧自动发送');
  assert.equal(P.canAutoPump(base), true);
});
