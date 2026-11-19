// 中断后「继续」像 Claude Code 一样原样回放上一轮工具过程（2026-11-19 用户定案）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplayMessages, replayInterruptedTurn } from '../desktop/src/main/interrupted-replay.mjs';
import { assembleContext } from '../desktop/src/main/context.mjs';

const stopped = {
  role: 'assistant', content: '', interrupted: true,
  trace: [
    { tool: 'read_file', args: '{"path":"src/Gap.tsx"}', result: { totalLines: 80, content: 'export const Gap' }, callId: 'c1', thought: '先看 Gap 场景', say: '我先读 Gap.tsx。' },
    { tool: 'view_image', args: { paths: ['out/s1180.png'] }, result: { ok: true, imagesAttached: 1 }, callId: 'c1' },
    { tool: 'run_command', args: '{"command":"npx remotion still"}', result: null, status: 'running' },
  ],
};

test('还原成配对的 assistant(tool_calls) + tool 消息；当时说的话、未跑完的工具、收尾说明都在', () => {
  const r = buildReplayMessages(stopped);
  const m = r.messages;
  assert.equal(r.replayed, 3);
  assert.equal(m.length, 7); // 3 对 + 收尾说明
  assert.equal(m[0].content, '我先读 Gap.tsx。');
  assert.equal(m[0].tool_calls[0].function.name, 'read_file');
  assert.equal(m[1].role, 'tool');
  assert.equal(m[1].tool_call_id, m[0].tool_calls[0].id);
  assert.notEqual(m[2].tool_calls[0].id, m[0].tool_calls[0].id, '重复的 callId 要去重');
  assert.equal(JSON.parse(m[2].tool_calls[0].function.arguments).paths[0], 'out/s1180.png');
  assert.match(m[5].content, /没跑完/);
  assert.match(m[6].content, /从这里接着做：已经读过、跑过、确认过的不要重做/);
});

test('超预算：最近的步骤原样，更早的压成摘要', () => {
  const trace = Array.from({ length: 50 }, (_, i) => ({ tool: 'read_file', args: { path: `f${i}.ts` }, result: { content: 'x'.repeat(3000) } }));
  const r = buildReplayMessages({ interrupted: true, trace }, { budgetChars: 32000 });
  assert.ok(r.replayed > 0 && r.replayed < 50);
  assert.equal(r.summarized + r.replayed, 50);
  assert.match(r.messages[0].content, /较早的 \d+ 步/);
  const calls = r.messages.filter((x) => x.tool_calls).map((x) => JSON.parse(x.tool_calls[0].function.arguments).path);
  assert.equal(calls.at(-1), 'f49.ts', '最近一步一定原样保留');
});

test('只在上一轮是中断的时候回放；替换渲染层送来的摘要；上一轮正常结束就不动', () => {
  const ctx = [{ role: 'user', content: '做宣传片' }, { role: 'assistant', content: '[上一轮在执行中被用户手动停止…]' }, { role: 'user', content: '继续' }];
  const db = [{ role: 'user', content: '做宣传片' }, stopped, { role: 'user', content: '继续' }];
  const r = replayInterruptedTurn(ctx, db);
  assert.ok(r.replay);
  assert.equal(r.messages[0].content, '做宣传片');
  assert.ok(!r.messages.some((x) => String(x.content).startsWith('[上一轮在执行中被用户')), '渲染层摘要被完整回放替换');
  assert.equal(r.messages.at(-1).content, '继续');
  const ok = replayInterruptedTurn(ctx, [{ role: 'user', content: 'a' }, { role: 'assistant', content: '完成', trace: stopped.trace }]);
  assert.equal(ok.replay, null);
  // 老渲染层把出错回合整条丢掉：上下文里紧挨着的是 user，回放插在本轮用户消息之前
  const noAsst = replayInterruptedTurn([{ role: 'user', content: '做' }, { role: 'user', content: '继续' }], [{ role: 'user', content: '做' }, { ...stopped, error: 'fetch failed' }]);
  assert.equal(noAsst.messages[0].content, '做');
  assert.equal(noAsst.messages.at(-1).content, '继续');
  assert.ok(noAsst.messages.some((x) => x.role === 'tool'));
});

test('跨轮压缩的保留区不以 tool 结果开头（不留悬空的工具结果）', async () => {
  const replay = buildReplayMessages({ interrupted: true, trace: Array.from({ length: 30 }, (_, i) => ({ tool: 'read_file', args: { path: `f${i}` }, result: { content: 'y'.repeat(2000) } })) }).messages;
  const list = [{ role: 'user', content: 'old '.repeat(5000) }, ...replay, { role: 'user', content: '继续' }];
  const out = await assembleContext(list, { budgetChars: 20000 });
  const firstKept = out.messages.findIndex((m) => m.role !== 'system');
  const tools = out.messages.filter((m) => m.role === 'tool');
  for (const t of tools) {
    assert.ok(out.messages.some((m) => m.role === 'assistant' && (m.tool_calls || []).some((c) => c.id === t.tool_call_id)), '每个工具结果都有对应的调用');
  }
  assert.notEqual(out.messages[firstKept]?.role, 'tool');
});
