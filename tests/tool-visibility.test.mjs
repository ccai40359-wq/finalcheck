// 可见性（F5/F6/F7）：跑动中的工具不能像「卡死」。
//  - F5：tool-end 带裁剪后的 result 摘要；CommandDetail 能渲染 note；工具行显示已耗时
//  - F6：网关只发心跳（SSE 注释/空 data）不算「内容进度」，不能永久骗过静默看门狗
//  - F7：idle_ms:0 允许（不砍时间），但超过 60s 起每 30s 推一条「仍在运行 Ns」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const { uiResultSummary, UI_RESULT_MAX_CHARS, consumeStream } = await import('../desktop/src/main/agent-service.mjs');
const { planRunningPings, runCommandWithSignal, RUNNING_PING_START_MS, RUNNING_PING_EVERY_MS } =
  await import('../desktop/src/main/agent-tools.mjs');

/* ---------- F5 ① tool-end 结果摘要 ---------- */
test('tool-end 摘要：小结果原样（note 保留），大结果只留 note 或 ≤400 字 preview', () => {
  const bg = { background: true, pid: 4242, note: '已在后台启动（PID=4242）' };
  assert.deepEqual(uiResultSummary(bg), bg, '小结果必须原样返回，不能丢 note');

  const bigNoNote = { stdout: 'x'.repeat(5000), stderr: '', code: 0 };
  const s1 = uiResultSummary(bigNoNote);
  assert.equal(s1.truncated, true);
  assert.ok(s1.preview.length <= UI_RESULT_MAX_CHARS, 'preview 必须裁剪');
  assert.equal(s1.stdout, undefined, '大对象不能整块过 IPC');
  assert.ok(JSON.stringify(s1).length <= UI_RESULT_MAX_CHARS + 80);

  const bigWithNote = { stdout: 'y'.repeat(9000), note: '命令仍在运行，已 120 秒无输出，已转入后台（PID=7）' };
  const s2 = uiResultSummary(bigWithNote);
  assert.equal(s2.truncated, true);
  assert.match(s2.note, /已转入后台/, 'note 是用户最需要看的那一句，必须在摘要里活下来');
  assert.equal(s2.preview, undefined, '有 note 时不再塞 preview');
  assert.ok(JSON.stringify(s2).length <= UI_RESULT_MAX_CHARS + 80);

  assert.equal(uiResultSummary(null), null);
  assert.equal(uiResultSummary('ok'), 'ok');
});

/* ---------- F6 流解析：心跳 ≠ 进度 ---------- */
function chunkedResponse(pieces) {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (i < pieces.length) controller.enqueue(enc.encode(pieces[i++]));
      else controller.close();
    }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('流解析：只喂心跳注释时 onChunk 的 progress=false（silence.touch 不会被调用）', async () => {
  const seen = [];
  const out = await consumeStream(
    chunkedResponse([': keepalive\n\n', ': keepalive\n\n', 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n']),
    null, null, null, (progress) => seen.push(progress)
  );
  assert.deepEqual(seen, [false, false, false], '心跳/只有 role 的块都不算内容进度');
  assert.equal(out.content, '');
});

test('流解析：真实内容 / 工具参数 / usage 才算进度（会重置静默看门狗）', async () => {
  const seen = [];
  const out = await consumeStream(
    chunkedResponse([
      ': ping\n\n',
      'data: {"choices":[{"delta":{"content":"嗨"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":3}}\n\n'
    ]),
    null, null, null, (progress) => seen.push(progress)
  );
  assert.deepEqual(seen, [false, true, true, true]);
  assert.equal(out.content, '嗨');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.usage.total_tokens, 3);
});

/* ---------- F7 长命令提示 ---------- */
test('长命令提示节奏：60s 起每 30s 一条，只在提示点上返回 due', () => {
  assert.deepEqual(planRunningPings(0), { due: null, nextAt: RUNNING_PING_START_MS });
  assert.deepEqual(planRunningPings(59_999), { due: null, nextAt: 60_000 });
  assert.deepEqual(planRunningPings(60_000), { due: 60_000, nextAt: 90_000 });
  assert.deepEqual(planRunningPings(89_999), { due: 60_000, nextAt: 90_000 });
  assert.deepEqual(planRunningPings(90_000), { due: 90_000, nextAt: 120_000 });
  assert.deepEqual(planRunningPings(155_000), { due: 150_000, nextAt: 180_000 });
  assert.equal(RUNNING_PING_START_MS, 60_000);
  assert.equal(RUNNING_PING_EVERY_MS, 30_000);
  assert.deepEqual(planRunningPings(-5), { due: null, nextAt: 60_000 }, '非法入参不崩');
});

test('长命令提示：idle_ms:0 不砍时间，但按节奏推「仍在运行 Ns」（只带耗时，不带输出）', async () => {
  const pings = [];
  const t0 = Date.now();
  const r = await runCommandWithSignal(
    'node -e "setTimeout(()=>{}, 500)"',
    { idleMs: 0, pingStartMs: 100, pingEveryMs: 150, onActivity: (ev) => pings.push({ ev, at: Date.now() - t0 }) }
  );
  const elapsed = Date.now() - t0;
  assert.equal(r.code, 0, 'idle_ms:0 必须尊重「不要超时」：命令自己跑完，不转后台');
  assert.equal(r.background, undefined, 'idle_ms:0 不该被空闲看门狗转后台');
  assert.ok(elapsed >= 400, '确实跑满了命令时长（没被砍）');

  assert.ok(pings.length >= 2, `应该按节奏提示多次，实际 ${pings.length}`);
  for (const { ev } of pings) {
    assert.equal(ev.kind, 'activity');
    assert.equal(ev.tool, 'run_command');
    assert.match(ev.label, /^仍在运行 \d+s$/, '文案必须能读出「还在动」');
  }
  const first = pings[0];
  assert.ok(first.at >= 90, `第一条提示应在 100ms 左右，实际 ${first.at}ms`);
  assert.ok(pings.every(({ ev }) => !('stdout' in ev) && !('stdout' in (ev.result || {}))), '提示不含输出内容');

  // 第一条出现后，后续间隔≈pingEveryMs（允许定时器抖动）
  for (let i = 1; i < pings.length; i++) {
    assert.ok(pings[i].at - pings[i - 1].at >= 100, '不能刷屏（密度不高于设定节奏）');
  }
});

test('长命令提示：命令正常快速结束时不产生任何提示', async () => {
  const pings = [];
  const r = await runCommandWithSignal('node -e "0"', { idleMs: 0, onActivity: (ev) => pings.push(ev) });
  assert.equal(r.code, 0);
  assert.deepEqual(pings, [], '短命令不该有「仍在运行」噪音');
});

test('长命令提示：background:true 立刻返回，不发提示', async () => {
  const pings = [];
  const r = await runCommandWithSignal('node -e "setTimeout(()=>{}, 3000)"', {
    background: true, pingStartMs: 20, pingEveryMs: 20, onActivity: (ev) => pings.push(ev)
  });
  try {
    assert.equal(r.background, true);
    await new Promise((res) => setTimeout(res, 120));
    assert.deepEqual(pings, [], '后台启动不等待输出，也不需要「仍在运行」提示');
  } finally {
    if (r.pid) {
      spawnSync(process.platform === 'win32' ? 'taskkill' : 'kill',
        process.platform === 'win32' ? ['/PID', String(r.pid), '/T', '/F'] : [String(r.pid)],
        { stdio: 'ignore', windowsHide: true });
    }
  }
});
