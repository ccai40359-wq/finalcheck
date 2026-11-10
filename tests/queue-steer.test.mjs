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
