// 网关断开的回合：说「继续」时不能从界面消失，模型要知道中断前做到哪（2026-11-18 用户实测）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSendHistory, interruptedTurnDigest } from '../desktop/src/renderer/lib/interrupted-digest.mjs';

const failed = {
  role: 'assistant', content: '', error: '网关连接失败：fetch failed（已重试 5 次）', workedMs: 604000,
  trace: [
    { tool: 'audit_project', args: '{"dir":"D:/site","tier":"L2"}', result: { verdict: '修完再过', reason: '2 张卡' } },
    { tool: 'read_file', args: { path: 'D:/site/js/app.js' }, result: { totalLines: 3737, content: 'const x=1' } },
    { tool: 'run_command', args: '{"command":"curl -s https://x/.cloud/llm/usage"}', result: { code: 0, stdout: '{"quota":12}' } },
    { tool: 'probe_target', args: { url: 'https://x' }, result: { error: 'timeout' } },
  ],
};

test('出错回合：界面保留；发给模型换成「中断前做了什么」的摘要', () => {
  const msgs = [
    { role: 'user', content: '我获得了授权，可以开始' },
    failed,
    { role: 'notice', content: '提示' },
    { role: 'assistant', content: '', error: 'HTTP 401', trace: [] }, // 没有任何进展的失败：不带给模型
  ];
  const { display, wire } = buildSendHistory(msgs);
  assert.equal(display.length, 3, '出错回合仍在界面上（notice 照旧不进历史）');
  assert.ok(display.includes(failed) || display.some((m) => m.error === failed.error));
  assert.equal(wire.length, 2);
  assert.equal(wire[1].role, 'assistant');
  assert.match(wire[1].content, /停下前已经完成的工作.*从这里接着做，不要从头重来/);
  assert.match(wire[1].content, /约 10 分钟/);
  assert.match(wire[1].content, /audit_project\(D:\/site\) → verdict=修完再过/);
  assert.match(wire[1].content, /run_command\(curl -s https:\/\/x\/\.cloud\/llm\/usage\) → \{"quota":12\}/);
  assert.match(wire[1].content, /probe_target\(https:\/\/x\) → 失败：timeout/);
});

test('摘要有上限：只带最近 24 次调用并注明略去的数量', () => {
  const trace = Array.from({ length: 60 }, (_, i) => ({ tool: 'read_file', args: { path: `f${i}.js` }, result: { totalLines: i } }));
  const d = interruptedTurnDigest({ error: 'x', trace });
  assert.match(d, /更早的 36 次调用略/);
  assert.match(d, /60\. read_file\(f59\.js\)/);
  assert.ok(d.length <= 6001);
  assert.equal(interruptedTurnDigest({ error: 'x', trace: [] }), null);
});

test('手动停止且干过活的回合也换成进展摘要（含当时的思路）；已完成消息的 events 不被剥掉', async () => {
  const stopped = {
    role: 'assistant', content: '我先看', interrupted: true, workedMs: 300000,
    events: [{ type: 'thought', text: '先读 Gap.tsx' }, { type: 'tool', name: 'read_file', args: '{}' }],
    trace: [{ tool: 'view_image', args: { paths: ['s1.png'] }, result: { ok: true }, say: '看起来 s1180 的证据页文字重叠', thought: '需要检查 Text.tsx' }],
  };
  const { display, wire } = buildSendHistory([{ role: 'user', content: '做宣传片' }, stopped, { role: 'assistant', content: '流式中', streaming: true, events: [{ type: 'tool' }] }]);
  assert.equal(display[1].events.length, 2, '完成态 events（含思考）保留');
  assert.equal(display[2].events, undefined, '仍在流式的消息剥掉瞬态 events');
  assert.match(wire[1].content, /被用户手动停止/);
  assert.match(wire[1].content, /当时的思路：看起来 s1180 的证据页文字重叠/);
});

test('从库里恢复时用 trace 上的每轮思考重建 Thought 条目（实时 events 已有思考时不重复）', async () => {
  const { mergeTraceIntoEvents } = await import('../desktop/src/renderer/lib/process-events.mjs');
  const trace = [
    { tool: 'read_file', args: '{"path":"a"}', result: { ok: 1 }, thought: '先看 a', say: '我先读 a' },
    { tool: 'read_file', args: '{"path":"b"}', result: { ok: 1 } },
  ];
  const rebuilt = mergeTraceIntoEvents([], trace, 1000);
  assert.deepEqual(rebuilt.map((e) => e.type), ['thought', 'tool', 'tool']);
  assert.equal(rebuilt[0].text, '先看 a\n\n我先读 a');
  const live = mergeTraceIntoEvents([{ type: 'thought', text: 'live' }], trace, 1000);
  assert.equal(live.filter((e) => e.type === 'thought').length, 1);
});
