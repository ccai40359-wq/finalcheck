// agent-cancel 的作用域：显式指定会话时绝不能波及其它会话。
// 事故：点停止一个「其实已经结束」的会话（activeChats 里已没有它）时，旧实现落到全局分支，
// askUsers.cancelAll() + 遍历全部 activeChats.abort() → 把正在跑的其他会话一起杀掉。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'fc-cancel-scope-'));
process.env.FINALCHECK_SESSIONS_DIR = tmpDir;
process.env.FINALCHECK_USAGE_FILE = path.join(tmpDir, 'usage.json');
process.env.FINALCHECK_PROJECTS_FILE = path.join(tmpDir, 'projects.json');

const { registerAgentIpc } = await import('../desktop/src/main/ipc/ipc-agent.mjs');

after(async () => { await rm(tmpDir, { recursive: true, force: true }).catch(() => {}); });

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function harness() {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); }
  };
  const state = {
    activeChats: new Map(),
    steerBuffers: new Map(),
    workflowTranscripts: new Map(),
    workflowControls: new Map(),
    sessionUsage: new Map(),
    hookSessionContext: new Map()
  };
  registerAgentIpc({
    ipcMain,
    getWin: () => null,
    getHooksConfig: () => ({}),
    getDataRoot: () => tmpDir,
    engineUrl: (rel) => `file:///${path.join(REPO_ROOT, rel).replace(/\\/g, '/')}`,
    repoRoot: REPO_ROOT,
    imageMime: { '.png': 'image/png' },
    sessionProjectPathOf: () => null,
    store: {
      loadConfig: async () => ({ providers: [], activeProviderId: null, activeModel: '', permissionMode: 'ask' }),
      pickActiveProvider: () => null,
      modelIdsOf: () => [],
      sandboxModeOf: () => 'workspace',
      sandboxAllowPathsOf: () => [],
      summarizeWithProvider: async () => '',
      generateSessionTitle: async () => null
    },
    state
  });
  const cancel = (sessionId) => handlers.get('finalcheck:agent-cancel')({ sender: null }, sessionId);
  return { state, cancel };
}

const fakeChat = (aborted) => ({ abort: () => aborted.push(true) });

test('停止一个已结束的会话：不碰另一个正在跑的会话的回合', () => {
  const { state, cancel } = harness();
  const abortedLive = [];
  state.activeChats.set('live-1', fakeChat(abortedLive));
  state.steerBuffers.set('live-1', ['别丢的注入']);

  const r = cancel('already-done');

  assert.deepEqual(r, { cancelled: 0 }, '已结束的会话只需要明确「什么都没取消」');
  assert.equal(abortedLive.length, 0, '另一个会话的回合绝不能被 abort');
  assert.ok(state.activeChats.has('live-1'), '运行中的会话必须还登记着');
  assert.deepEqual(state.steerBuffers.get('live-1'), ['别丢的注入'], '别的会话的 Steer 注入不能被清');
});

test('停止正在跑的会话：只 abort 它自己，其它会话照跑', () => {
  const { state, cancel } = harness();
  const abortedA = [];
  const abortedB = [];
  state.activeChats.set('a', fakeChat(abortedA));
  state.activeChats.set('b', fakeChat(abortedB));

  assert.deepEqual(cancel('a'), { cancelled: 1 });
  assert.equal(abortedA.length, 1);
  assert.equal(abortedB.length, 0);
  assert.ok(state.activeChats.has('b'));
  assert.equal(state.activeChats.has('a'), false);
});

test('真正的全局停止（sessionId 为空）仍然收掉所有会话', () => {
  const { state, cancel } = harness();
  const abortedA = [];
  const abortedB = [];
  state.activeChats.set('a', fakeChat(abortedA));
  state.activeChats.set('b', fakeChat(abortedB));
  state.steerBuffers.set('a', ['x']);

  assert.deepEqual(cancel(null), { cancelled: 2 });
  assert.equal(abortedA.length, 1);
  assert.equal(abortedB.length, 1);
  assert.equal(state.activeChats.size, 0);
  assert.equal(state.steerBuffers.size, 0);
});
