import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { acceptRunPacket, reattachedRun } from '../desktop/src/renderer/lib/agent-resume.mjs';
import { applyAgentEvent, timelineEntries } from '../desktop/src/renderer/lib/process-events.mjs';
import { mergeRunningRun } from '../desktop/src/renderer/lib/session-restore.mjs';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'fc-agent-resume-'));
process.env.FINALCHECK_SESSIONS_DIR = tmp;
process.env.FINALCHECK_SESSION_STORE = 'json';
process.env.FINALCHECK_USAGE_FILE = path.join(tmp, 'usage.json');
const sessions = await import('../desktop/src/main/sessions.mjs');
const { registerAgentIpc } = await import('../desktop/src/main/ipc/ipc-agent.mjs');
const root = path.resolve(import.meta.dirname, '..');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const engineUrl = 'data:text/javascript;base64,' + Buffer.from('export const runAgentTurn = (args) => globalThis.__fcResumeEngine(args);').toString('base64');

function harness() {
  const handlers = new Map();
  const packets = [];
  const state = Object.fromEntries(['activeChats', 'steerBuffers', 'workflowTranscripts', 'workflowControls', 'sessionUsage', 'hookSessionContext'].map((name) => [name, new Map()]));
  const provider = { id: 'test', name: 'test', baseUrl: 'https://test.invalid', apiKey: 'SECRET-NEVER-IN-SNAPSHOT', models: ['m'], enabled: true, apiFormat: 'chat-completions' };
  registerAgentIpc({ ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    getWin: () => ({ webContents: { send: (channel, payload) => packets.push({ channel, ...structuredClone(payload) }) } }),
    getHooksConfig: () => ({}), getDataRoot: () => tmp, repoRoot: root, imageMime: {}, sessionProjectPathOf: () => null,
    engineUrl: (rel) => rel.endsWith('/agent-service.mjs') ? engineUrl : pathToFileURL(path.join(root, rel)).href,
    store: { loadConfig: async () => ({ providers: [provider], permissionMode: 'ask' }), pickActiveProvider: () => provider,
      modelIdsOf: () => ['m'], sandboxModeOf: () => 'workspace', sandboxAllowPathsOf: () => [],
      generateSessionTitle: async () => null, summarizeWithProvider: async () => '' }, state });
  return { state, packets, call: (channel, ...args) => handlers.get('finalcheck:' + channel)({}, ...args) };
}

after(async () => { delete globalThis.__fcResumeEngine; await rm(tmp, { recursive: true, force: true }); });

test('renderer reload reconnects to real IPC snapshot, rejects replay/old runs, and completes from persisted history', async () => {
  const entered = deferred(); const finish = deferred();
  globalThis.__fcResumeEngine = async (ctx) => {
    ctx.onToken('before reload');
    ctx.onEvent({ kind: 'tool-start', id: 'one', name: 'read_file', args: '{"path":"one"}', at: 10 });
    entered.resolve(ctx);
    return finish.promise;
  };
  const h = harness(); const s = await sessions.newSession('reload');
  const pending = h.call('agent-chat', [{ role: 'user', content: 'read' }], [], s.id);
  const ctx = await entered.promise;
  const snapshot = h.call('agent-run-state', s.id);
  assert.equal(snapshot.events[0].status, 'running');
  assert.equal(snapshot.content, 'before reload');
  assert.equal(JSON.stringify(snapshot).includes('SECRET-NEVER'), false);
  snapshot.events[0].args = 'mutated';
  assert.equal(h.call('agent-run-state', s.id).events[0].args, '{"path":"one"}', 'snapshot reads cannot mutate main state');
  const run = reattachedRun(h.call('agent-run-state', s.id));
  let restored = mergeRunningRun((await sessions.loadSession(s.id)).messages, run).messages.at(-1);
  assert.equal(restored.streaming, true);
  assert.equal(timelineEntries(restored)[0].status, 'running');
  assert.equal(acceptRunPacket(run, h.packets.at(-1)), false, 'snapshot already contains this event');
  ctx.onEvent({ kind: 'tool-end', id: 'one', name: 'read_file', ok: true, result: { content: 'one' }, ms: 12 });
  const packet = h.packets.at(-1);
  assert.equal(acceptRunPacket(run, packet), true);
  Object.assign(run, applyAgentEvent(run, packet.ev));
  assert.equal(acceptRunPacket(run, packet), false);
  assert.equal(acceptRunPacket(run, { runId: 'older-invocation', seq: 999 }), false);
  assert.equal(run.events[0].status, 'ok');
  ctx.onToken(' after reload');
  const token = h.packets.at(-1);
  assert.equal(acceptRunPacket(run, token), true);
  run.content += token.text;
  assert.equal(run.content, 'before reload after reload');
  finish.resolve({ answer: 'complete', trace: [{ tool: 'read_file', args: '{"path":"one"}', result: { content: 'one' } }], workedMs: 30 });
  await pending;
  const settled = h.packets.filter((p) => p.ev?.kind === 'run-settled');
  assert.equal(settled.length, 1);
  assert.equal(settled[0].runId, run.runId);
  assert.equal(settled[0].ev.outcome, 'ok');
  assert.equal(h.call('agent-run-state', s.id), null, 'no stale run after settlement');
  const history = (await sessions.loadSession(s.id)).messages.at(-1);
  assert.equal(history.content, 'complete');
  assert.equal(timelineEntries(history)[0].status, 'ok');
});

test('cancel removes the active controller but retains stopping snapshot until persistence and one settled notification', async () => {
  const entered = deferred(); const finish = deferred();
  globalThis.__fcResumeEngine = async (ctx) => { entered.resolve(ctx); return finish.promise; };
  const h = harness(); const s = await sessions.newSession('cancel reload');
  const pending = h.call('agent-chat', [{ role: 'user', content: 'wait' }], [], s.id);
  await entered.promise;
  const originalRunId = h.call('agent-run-state', s.id).runId;
  assert.deepEqual(h.call('agent-cancel', s.id), { cancelled: 1 });
  assert.equal(h.state.activeChats.has(s.id), false);
  assert.equal(h.call('agent-run-state', s.id).stopping, true);
  finish.resolve({ answer: 'partial', cancelled: true, interrupted: true, trace: [] });
  await pending;
  assert.equal(h.call('agent-run-state', s.id), null);
  assert.equal((await sessions.loadSession(s.id)).messages.at(-1).interrupted, true);
  assert.deepEqual(h.packets.filter((p) => p.ev?.kind === 'run-settled').map((p) => [p.runId, p.ev.outcome]), [[originalRunId, 'stopped']]);
});

test('snapshot without a running main invocation is absent; malformed/older snapshots cannot attach', () => {
  const h = harness();
  assert.equal(h.call('agent-run-state', 'inactive'), null);
  assert.equal(reattachedRun(null), null);
  assert.equal(reattachedRun({ runId: 'missing-seq' }), null);
});
