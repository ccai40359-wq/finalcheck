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
  assert.match(wire[1].content, /中断前已经完成的工作，接着做，不要从头重来/);
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
