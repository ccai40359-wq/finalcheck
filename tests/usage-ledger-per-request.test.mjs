// Bug B 端到端回归：真正走 agent-chat IPC handler（不是只测下层函数），确认账本行数 = 模型请求数。
// 假网关：第 1、2 次返回空正文（触发引擎的空回复补交），第 3 次给结论 → 一轮共 3 次请求。
// 旧行为：回合结束只写 1 条（且是最后一次请求的量）→ 这里会失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'fc-usage-per-request-'));
process.env.FINALCHECK_USAGE_FILE = path.join(tmpDir, 'usage.json');
process.env.FINALCHECK_SESSIONS_DIR = tmpDir;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { registerAgentIpc } = await import('../desktop/src/main/ipc/ipc-agent.mjs');
const { readUsage } = await import('../desktop/src/main/usage-ledger.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (chunks) => new Response(
  chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);

function makeHarness() {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const provider = {
    id: 'p-a', name: 'Provider A', baseUrl: 'https://a.example/v1', apiKey: 'key-a',
    models: ['model-a1'], enabled: true, apiFormat: 'chat-completions'
  };
  const cfg = { providers: [provider], activeProviderId: 'p-a', activeModel: 'model-a1', permissionMode: 'ask' };
  const store = {
    loadConfig: async () => cfg,
    pickActiveProvider: (c) => (c.providers || []).find((p) => p.id === c.activeProviderId && p.enabled !== false) || null,
    modelIdsOf: (p) => p.models,
    sandboxModeOf: () => 'workspace',
    sandboxAllowPathsOf: () => [],
    summarizeWithProvider: async () => '',
    generateSessionTitle: async () => null
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
    engineUrl: (rel) => pathToFileURL(path.join(REPO_ROOT, rel)).href,
    repoRoot: REPO_ROOT,
    imageMime: { '.png': 'image/png' },
    sessionProjectPathOf: () => null,
    store,
    state
  });
  const chat = handlers.get('finalcheck:agent-chat');
  assert.equal(typeof chat, 'function', 'agent-chat handler 必须已注册');
  return { chat, state };
}

async function waitForEvents(count, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  let ledger = await readUsage();
  while (ledger.events.length < count && Date.now() < until) {
    await sleep(10);
    ledger = await readUsage();
  }
  return ledger;
}

test('agent-chat 端到端：一轮 3 次请求 → 账本 3 条，总量等于各次之和（不翻倍）', async (t) => {
  await rm(process.env.FINALCHECK_USAGE_FILE, { force: true });
  const prev = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) return sse([{ choices: [{ delta: { content: '' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }]);
    if (n === 2) return sse([{ choices: [{ delta: { content: '' } }], usage: { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } } }]);
    return sse([{ choices: [{ delta: { content: '结论' } }], usage: { prompt_tokens: 30, completion_tokens: 3 } }]);
  };
  t.after(() => { globalThis.fetch = prev; });

  const { chat } = makeHarness();
  const out = await chat({ sender: null }, [{ role: 'user', content: '跑一个长任务' }], [], null);
  assert.equal(out.error, undefined, JSON.stringify(out));
  assert.equal(out.answer, '结论');
  assert.equal(n, 3, '假网关收到 3 次请求');

  const ledger = await waitForEvents(3);
  assert.equal(ledger.events.length, 3, `账本行数 = 请求数（3），实际 ${ledger.events.length}（1=退回旧行为，4=回合结束又补了一条）`);
  const sum = ledger.events.reduce((acc, e) => ({
    prompt: acc.prompt + (e.prompt || 0),
    completion: acc.completion + (e.completion || 0),
    cached: acc.cached + (e.cached || 0)
  }), { prompt: 0, completion: 0, cached: 0 });
  assert.deepEqual(sum, { prompt: 60, completion: 6, cached: 5 }, '账本总量 = 各次请求之和');
  for (const e of ledger.events) {
    assert.equal(e.model, 'model-a1');
    assert.equal(e.providerId, 'p-a');
  }
  assert.equal(out.usage.prompt_tokens, 30, 'Context 指示器仍是最后一次请求的口径');
});

test.after(async () => { await rm(tmpDir, { recursive: true, force: true }); });
