// 0.34.4 手机访问更稳更快：
//   · 隧道只在「服务器明确连不到这台电脑」时重建；超时（网络慢 / 电脑忙）不杀隧道
//   · 自己杀掉的 ssh 不再被当成又一次断开（以前会多排一次重连、等待翻倍）
//   · 手机只读调用碰上网络抖动自动重试；会改东西的不重试
//   · 上下文用量：手机只发会话 id，同时最多一个在路上，电脑按存档算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createTunnel } from '../desktop/src/main/mobile/tunnel.mjs';
import { isReadCall, createLatestOnly } from '../desktop/src/mobile/rpc-policy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(5); } return false; };
const T = { backoffMin: 20, backoffMax: 40, settle: 15, checkEvery: 30 };

function fakeSsh() {
  const spawned = [];
  const spawn = (cmd, args) => {
    const c = new EventEmitter();
    c.stderr = new EventEmitter();
    c.exitCode = null;
    c.kill = () => { if (c.exitCode == null) { c.exitCode = null; c.killed = true; setImmediate(() => c.emit('exit', null)); } };
    spawned.push(c);
    return c;
  };
  return { spawn, spawned };
}
const respond = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const mkTunnel = (fetch, extra = {}) => {
  const { spawn, spawned } = fakeSsh();
  const logs = [];
  const tn = createTunnel({ instanceId: 'me', timing: T, spawn, fetch, sshPath: 'ssh', log: (s) => logs.push(s),
    config: () => ({ target: 'h', remotePort: 7788, localPort: 7788, publicUrl: 'https://x/fc' }), ...extra });
  return { tn, spawned, logs };
};

test('隧道：公网地址超时（网络慢 / 电脑忙）只记状态，不杀 ssh——手机上的请求不会被一起掐断', async () => {
  let mode = 'ok';
  const fetch = async (_u, { signal } = {}) => {
    if (mode === 'ok') return respond(200, { ok: true, fc: 'me' })();
    const e = new Error('aborted'); e.name = 'AbortError'; throw e;        // 模拟 10 秒超时
  };
  const { tn, spawned } = mkTunnel(fetch);
  tn.start();
  assert.ok(await until(() => tn.state().status === 'up'));
  mode = 'slow';
  await sleep(T.checkEvery * 8);                                              // 连着好几次检查都超时
  assert.equal(spawned.length, 1, '一直是同一个 ssh 进程，没有被重建');
  assert.equal(spawned[0].killed, undefined);
  assert.equal(tn.state().status, 'unreachable');
  assert.match(tn.state().error, /隧道没断/);
  mode = 'ok';
  assert.ok(await until(() => tn.state().status === 'up', 3000), '网络恢复后自己回到 up');
  tn.stop();
});

test('隧道：服务器明确连不到这台电脑（502 连着两次）才重建，并写日志；自己杀掉的 ssh 不算又一次断开', async () => {
  let reply = respond(200, { ok: true, fc: 'me' });
  const { tn, spawned, logs } = mkTunnel((...a) => reply(...a));
  tn.start();
  assert.ok(await until(() => tn.state().status === 'up'));
  reply = respond(502, null);
  assert.ok(await until(() => spawned.length === 2, 3000), '502 两次后重建');
  assert.ok(spawned[0].killed);
  assert.ok(logs.some((l) => /重建：.*502/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /断开：ssh 退出了/.test(l)), '自己杀的那次不该再记一次「断开」');
  reply = respond(200, { ok: true, fc: 'me' });
  assert.ok(await until(() => tn.state().status === 'up', 3000));
  await sleep(T.backoffMax * 3);
  assert.equal(spawned.length, 2, '不会因为旧进程的退出再多起一个 ssh');
  tn.stop();
});

test('手机调用重试规则：查询 / 列表 / 打开会话可以重试；发消息、新建、改设置不重试', () => {
  for (const ch of ['finalcheck:projects:sessions', 'finalcheck:sessions:open', 'finalcheck:agent-run-state', 'finalcheck:get-config',
    'finalcheck:bg-tasks-list', 'finalcheck:sessions:queue-get', 'finalcheck:context:stats', 'finalcheck:projects:list', 'finalcheck:projects:current']) {
    assert.equal(isReadCall(ch), true, ch);
  }
  for (const ch of ['finalcheck:agent-chat', 'finalcheck:sessions:new', 'finalcheck:set-config', 'finalcheck:sessions:set-model',
    'finalcheck:projects:select', 'finalcheck:agent-stop', 'finalcheck:approval-response', 'finalcheck:sessions:delete']) {
    assert.equal(isReadCall(ch), false, ch);
  }
});

test('上下文用量「只要最新的」：在路上时再来的只发最后一次、大家拿同一个结果；两次之间至少隔 gapMs', async () => {
  const sent = [];
  let release;
  const run = (p) => { sent.push({ p, at: Date.now() }); return new Promise((r) => { release = () => r(`r${p}`); }); };
  const call = createLatestOnly(run, { gapMs: 60 });
  const a = call(1);
  await sleep(5);
  assert.equal(sent.length, 1);
  const b = call(2); const c = call(3);                                       // 第一次还没回来
  assert.equal(b, c, '排队的只有一个');
  release();
  assert.equal(await a, 'r1');
  await until(() => sent.length === 2, 1000);
  assert.deepEqual(sent.map((s) => s.p), [1, 3], '中间那次被最新的替换掉了');
  assert.ok(sent[1].at - sent[0].at >= 55, `间隔 ${sent[1].at - sent[0].at}ms`);
  release();
  assert.equal(await b, 'r3');
  assert.equal(await c, 'r3');
});

test('手机桥：上下文用量走「只发会话 id + 只要最新的」，网络抖动时只读调用自动重试', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'desktop/src/mobile/bridge-electron.mjs'), 'utf8');
  assert.match(src, /'finalcheck:context:stats': \(p = \{\}\) => contextStats\(\{ sessionId: p\?\.sessionId \|\| null, useSession: true \}\)/);
  assert.match(src, /const canRetry = isReadCall\(channel\)/);
  assert.match(src, /r\.status === 502 \|\| r\.status === 503 \|\| r\.status === 504/);
});

test('context:stats useSession：不传对话，电脑按存档算，结果和传整段对话一致', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'fc-ctx-usesess-'));
  const prev = process.env.FINALCHECK_SESSIONS_DIR;
  process.env.FINALCHECK_SESSIONS_DIR = tmpDir;
  try {
    const load = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
    const { registerSystemIpc } = await load('desktop/src/main/ipc/ipc-system.mjs');
    const sessions = await load('desktop/src/main/sessions.mjs');
    const handlers = new Map();
    const cfg = { providers: [{ id: 'p1', name: 'P', baseUrl: 'https://x.test', apiKey: 'k', models: [{ id: 'm1', contextWindow: 200000 }], enabled: true }], activeProviderId: 'p1' };
    registerSystemIpc({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, getWin: () => null,
      engineUrl: (rel) => pathToFileURL(path.join(repoRoot, rel)).href,
      store: { loadConfig: async () => cfg, pickActiveProvider: () => cfg.providers[0] },
      getHooksConfig: () => null, sessionProjectPathOf: () => '', sessionUsage: new Map()
    });
    const stats = handlers.get('finalcheck:context:stats');
    const s = await sessions.newSession('usesess');
    const sid = String(s.id);
    await sessions.appendUserMessage(sid, 'a'.repeat(20000));
    await sessions.appendAssistantMessage(sid, { role: 'assistant', content: 'b'.repeat(20000) });
    const wire = [{ role: 'user', content: 'a'.repeat(20000) }, { role: 'assistant', content: 'b'.repeat(20000) }];
    const full = await stats(null, { messages: wire, sessionId: sid });
    const slim = await stats(null, { useSession: true, sessionId: sid });
    assert.ok(full.breakdown.messages > 9000, `对话部分应该很大：${full.breakdown.messages}`);
    assert.equal(slim.breakdown.messages, full.breakdown.messages);
    const none = await stats(null, { useSession: true, sessionId: null });  // 草稿页：没会话就按空算，不报错
    assert.equal(none.breakdown.messages, 0);
  } finally {
    if (prev == null) delete process.env.FINALCHECK_SESSIONS_DIR; else process.env.FINALCHECK_SESSIONS_DIR = prev;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('打开会话：运行状态和存档同时去取；查到有回合在跑时在快照之后重读存档', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'desktop/src/renderer/App.jsx'), 'utf8');
  const i = src.indexOf('const diskFirst = Promise.resolve().then(() => y.sessions.open(id));');
  const j = src.indexOf('queriedRun = reattachedRun(unwrapIpc(await y.agentRunState(id)));');
  assert.ok(i > 0 && j > i, '存档请求在等运行状态之前就发出去了');
  assert.match(src, /let s = unwrapIpc\(await diskFirst\);\s*\n[^\n]*\n\s*if \(queriedRun\) s = unwrapIpc\(await y\.sessions\.open\(id\)\);/);
});
