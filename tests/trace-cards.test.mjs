import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseResultCards, canonCardArgs, COLLAPSIBLE_TOOLS } from '../desktop/src/renderer/lib/trace-cards.mjs';

// 用户实测会话 9adde9d2 的真实形态：probe_target 被当成心跳探针，同一 URL 在一个回合里
// 被探测 6-9 次，正文区铺出 6-9 张内容完全相同的渗透探测大表。

test('canonCardArgs: 键顺序不同视为同一参数', () => {
  const a = canonCardArgs('{"url":"http://127.0.0.1:8787/healthz","requests":3}');
  const b = canonCardArgs('{"requests":3,"url":"http://127.0.0.1:8787/healthz"}');
  assert.equal(a, b);
});

test('canonCardArgs: 嵌套对象也按键排序', () => {
  const a = canonCardArgs({ headers: { b: 2, a: 1 }, url: 'u' });
  const b = canonCardArgs({ url: 'u', headers: { a: 1, b: 2 } });
  assert.equal(a, b);
});

test('canonCardArgs: 非 JSON 参数退回原文，不崩', () => {
  assert.equal(canonCardArgs('not json at all'), 'not json at all');
  assert.equal(canonCardArgs(null), '');
  assert.equal(canonCardArgs(undefined), '');
});

test('collapseResultCards: 9 次同参数同结果 probe_target 折叠，计数正确', () => {
  // 复现真实会话：m19 三次 + m21 六次，结果完全相同的那些才折叠
  const same = { status: 404, accessible: false };
  const entries = [
    { tool: 'probe_target', args: '{"url": "http://127.0.0.1:8787/", "requests": 3}', result: same },
    { tool: 'probe_target', args: '{"url": "http://127.0.0.1:8787/healthz", "requests": 3}', result: same },
    { tool: 'probe_target', args: '{"url": "http://127.0.0.1:8787/healthz", "requests": 3}', result: same },
    { tool: 'probe_target', args: '{"url": "http://127.0.0.1:8787/healthz", "requests": 3}', result: same },
    { tool: 'probe_target', args: '{"url": "http://127.0.0.1:8787/healthz", "requests": 3}', result: same },
    { tool: 'probe_target', args: '{"url": "http://127.0.0.1:8787/healthz", "requests": 3}', result: same },
    { tool: 'probe_target', args: '{"url": "http://127.0.0.1:8787/healthz", "requests": 3}', result: same },
    { tool: 'probe_target', args: '{"requests": 3, "url": "http://127.0.0.1:8787/healthz"}', result: same },
    { tool: 'probe_target', args: '{"url": "http://127.0.0.1:8787/healthz", "requests": 3}', result: same },
  ];
  const slots = collapseResultCards(entries);
  // /  根（1 次） + /healthz（8 次）→ 两张卡
  assert.equal(slots.length, 2);
  assert.equal(slots[0].count, 1);
  assert.equal(slots[1].count, 8);
});

test('collapseResultCards: latency 抖动不影响折叠（界面不显示它）', () => {
  // 真实数据：同一次 404 探测，latency.p50 在 2.9 / 2.2 / 2.3 之间抖，表格内容一模一样
  const mk = (p50) => ({
    tool: 'probe_target',
    args: { url: 'http://h/healthz', requests: 3 },
    result: {
      target: 'http://h',
      latency: { p50, p95: p50 + 0.5, min: 1.8, max: 3.4, firstByteMs: 1.9 },
      samples: p50,
      results: [
        { kind: 'unauth-access', path: '/api/users', status: 404, reproduced: false, accessible: false, note: '404 非 2xx' },
      ],
    },
  });
  const slots = collapseResultCards([mk(2.9), mk(2.2), mk(2.3)]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].count, 3);
});

test('collapseResultCards: status 变了 → 必须分开（真实状态变化）', () => {
  const mk = (status, note) => ({
    tool: 'probe_target',
    args: { url: 'http://h/healthz', requests: 3 },
    result: { target: 'http://h', results: [{ kind: 'unauth-access', path: '/api/users', status, reproduced: false, accessible: false, note }] },
  });
  const slots = collapseResultCards([mk(404, '404 非 2xx'), mk(null, 'unreachable: fetch failed')]);
  assert.equal(slots.length, 2, '404 与不可达是两次不同的结论，不能合并');
});

test('collapseResultCards: 结果不可解析时保守处理，不误合并', () => {
  const entries = [
    { tool: 'probe_target', args: { url: 'u' }, result: 'not-json-1' },
    { tool: 'probe_target', args: { url: 'u' }, result: 'not-json-2' },
  ];
  const slots = collapseResultCards(entries);
  assert.equal(slots.length, 2);
});

test('collapseResultCards: 不同 URL 不合并', () => {
  const slots = collapseResultCards([
    { tool: 'probe_target', args: { url: 'http://a/healthz' } },
    { tool: 'probe_target', args: { url: 'http://b/healthz' } },
  ]);
  assert.equal(slots.length, 2);
  assert.deepEqual(slots.map((s) => s.count), [1, 1]);
});

test('collapseResultCards: 不同工具同参数不合并', () => {
  const slots = collapseResultCards([
    { tool: 'probe_target', args: { url: 'http://x' } },
    { tool: 'stress_target', args: { url: 'http://x' } },
  ]);
  assert.equal(slots.length, 2);
});

test('collapseResultCards: ask_user 不参与折叠（每次问答都是独立交互）', () => {
  const ask = { tool: 'ask_user', args: { question: '选哪个？' } };
  const slots = collapseResultCards([ask, ask]);
  assert.equal(slots.length, 2);
  assert.deepEqual(slots.map((s) => s.count), [1, 1]);
});

test('collapseResultCards: run_workflow 也不折叠（每次工作流是不同运行）', () => {
  const wf = { tool: 'run_workflow', args: { goal: '审计' } };
  const slots = collapseResultCards([wf, wf]);
  assert.equal(slots.length, 2);
});

test('collapseResultCards: 保留首次出现的位置，重复项不插到后面', () => {
  const slots = collapseResultCards([
    { tool: 'audit_project', args: { dir: 'a' } },
    { tool: 'probe_target', args: { url: 'u' } },
    { tool: 'audit_project', args: { dir: 'a' } },
  ]);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].entry.tool, 'audit_project');
  assert.equal(slots[0].count, 2);
  assert.equal(slots[1].entry.tool, 'probe_target');
});

test('collapseResultCards: 空输入/非数组不崩', () => {
  assert.deepEqual(collapseResultCards([]), []);
  assert.deepEqual(collapseResultCards(null), []);
  assert.deepEqual(collapseResultCards(undefined), []);
});

test('COLLAPSIBLE_TOOLS 覆盖会产生大表的工具', () => {
  for (const tool of ['probe_target', 'stress_target', 'audit_project', 'get_report']) {
    assert.ok(COLLAPSIBLE_TOOLS.has(tool), `${tool} 应参与折叠`);
  }
  assert.ok(!COLLAPSIBLE_TOOLS.has('ask_user'), 'ask_user 不应参与折叠');
  assert.ok(!COLLAPSIBLE_TOOLS.has('run_workflow'), 'run_workflow 不应参与折叠');
});
