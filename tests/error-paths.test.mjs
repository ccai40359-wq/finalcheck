// 异常路径回归：意外不能再「静默死」或「整条 run 停」。
//
// 覆盖四类真实事故：
//  1) IPC handler 抛错 → 渲染层收到 reject（未 catch 就表现为「点了没反应」）；
//  2) 未处理的 Promise / 未捕获异常 → 主进程没输出、窗口像卡住；
//  3) 工作流某个节点/扇出跑不出来 → 整条 run 立刻结束，前面跑完全白跑；
//  4) 声明顺序类错误（TDZ）在 handler 里直接炸，测试全绿但装机必炸。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'fc-error-paths-'));
process.env.FINALCHECK_SESSIONS_DIR = tmpDir;
process.env.FINALCHECK_USAGE_FILE = path.join(tmpDir, 'usage.json');
process.env.FINALCHECK_PROJECTS_FILE = path.join(tmpDir, 'projects.json');

const {
  IPC_ERROR_CODE,
  installProcessGuards,
  installSafeIpc,
  ipcErrorPayload,
  isIpcError,
  sanitizeErrorMessage
} = await import('../desktop/src/main/error-guard.mjs');
const { runWorkflow } = await import('../desktop/src/main/workflow.mjs');
const { registerAgentIpc } = await import('../desktop/src/main/ipc/ipc-agent.mjs');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 最小假 ipcMain：够 installSafeIpc + register* 用
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    invoke(channel, ...args) {
      const fn = handlers.get(channel);
      assert.equal(typeof fn, 'function', `handler ${channel} 必须已注册`);
      return fn({ sender: null }, ...args);
    }
  };
}

const quietConsole = () => {
  const calls = { warn: [], error: [] };
  return {
    calls,
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' '))
  };
};

// ---- 1) IPC 错误边界 ----
test('ipc: handler 抛错返回 { error, code } 而不是 reject（用户看到人话，不是栈）', async () => {
  const ipcMain = fakeIpcMain();
  installSafeIpc(ipcMain, { warn: quietConsole() });
  ipcMain.handle('demo:boom', async () => {
    throw new Error('Cannot access \'model\' before initialization\n    at runAgentChat (D:\\workspace\\finalcheck\\desktop\\src\\main\\ipc\\ipc-agent.mjs:220:5)');
  });
  const r = await ipcMain.invoke('demo:boom'); // 不 reject = 渲染层不会 unhandled rejection
  assert.equal(r.code, IPC_ERROR_CODE);
  assert.equal(r.channel, 'demo:boom');
  assert.equal(typeof r.error, 'string');
  assert.match(r.error, /操作失败/);
  assert.match(r.error, /Cannot access/);
  // 栈帧与本机绝对路径不外泄
  assert.doesNotMatch(r.error, /at runAgentChat/);
  assert.doesNotMatch(r.error, /D:\\workspace/);
  assert.equal(r.error.includes('\n'), false);
});

test('ipc: 成功返回值原样透传，业务自己的 { error } 不被二次包装', async () => {
  const ipcMain = fakeIpcMain();
  installSafeIpc(ipcMain, { warn: quietConsole() });
  ipcMain.handle('demo:list', async () => [{ id: 1 }]);
  ipcMain.handle('demo:business-error', async () => ({ error: '供应商未配置' }));
  assert.deepEqual(await ipcMain.invoke('demo:list'), [{ id: 1 }]);
  const biz = await ipcMain.invoke('demo:business-error');
  assert.deepEqual(biz, { error: '供应商未配置' });
  assert.equal(isIpcError(biz), false, '业务错误对象不能被当成 IPC 失败包');
});

test('ipc: 重复 install 不会二次包装（日志与返回体都只有一份）', async () => {
  const ipcMain = fakeIpcMain();
  const warn = quietConsole();
  installSafeIpc(ipcMain, { warn });
  installSafeIpc(ipcMain, { warn }); // 幂等
  ipcMain.handle('demo:boom', async () => { throw new Error('炸了'); });
  const r = await ipcMain.invoke('demo:boom');
  assert.equal(isIpcError(r), true);
  assert.equal(warn.calls.warn.length, 1, '同一次失败只记一行日志');
  assert.match(warn.calls.warn[0], /demo:boom/);
  assert.match(warn.calls.warn[0], /炸了/);
});

test('ipc: 同步 throw 也转成 error（不要求 handler 是 async）', async () => {
  const ipcMain = fakeIpcMain();
  installSafeIpc(ipcMain, { warn: quietConsole() });
  ipcMain.handle('demo:sync', () => { throw new TypeError('x is not a function'); });
  const r = await ipcMain.invoke('demo:sync');
  assert.equal(isIpcError(r), true);
  assert.match(r.error, /x is not a function/);
});

// ---- 2) 错误文案清洗 ----
test('ipc: 文案清洗只留一行、遮住本机路径、超长截断', () => {
  const oneLine = sanitizeErrorMessage('第一行\n第二行\n    at foo (C:\\Users\\me\\app.js:1:1)');
  assert.equal(oneLine, '第一行');
  const masked = sanitizeErrorMessage('读取 C:\\Users\\me\\secret\\config.json 失败');
  assert.match(masked, /<path>/);
  assert.doesNotMatch(masked, /secret/);
  const long = sanitizeErrorMessage('x'.repeat(1000));
  assert.equal(long.length, 301); // 300 + 省略号
  assert.equal(sanitizeErrorMessage(''), '未知错误');
  assert.equal(ipcErrorPayload('boom', { channel: 'c' }).code, IPC_ERROR_CODE);
});

// ---- 3) 进程级兜底：不静默死 ----
function guardHarness() {
  const proc = new EventEmitter();
  const sent = [];
  const log = [];
  const warn = quietConsole();
  let clock = 10_000;
  const guards = installProcessGuards({
    proc,
    getWin: () => ({ isDestroyed: () => false, webContents: { send: (ch, payload) => sent.push({ ch, payload }) } }),
    warn,
    log: (line) => log.push(line),
    now: () => clock
  });
  return {
    proc, sent, log, warn, guards,
    advance: (ms) => { clock += ms; }
  };
}

test('guards: unhandledRejection 记日志 + 给渲染层发 notice（sessionId=null）', () => {
  const h = guardHarness();
  h.proc.emit('unhandledRejection', new Error('后台任务炸了'));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].ch, 'finalcheck:agent-event');
  assert.equal(h.sent[0].payload.sessionId, null, '全局提示：sessionId 为 null，渲染层按 notice 显示');
  assert.equal(h.sent[0].payload.ev.kind, 'notice');
  assert.equal(h.sent[0].payload.ev.level, 'error');
  assert.match(h.sent[0].payload.ev.message, /未处理的 Promise/);
  assert.match(h.log.join('\n'), /后台任务炸了/);
  h.guards.dispose();
});

test('guards: uncaughtException 同样有 notice，且 1 秒内连环异常不刷屏', () => {
  const h = guardHarness();
  h.proc.emit('uncaughtException', new Error('第一处'));
  h.proc.emit('uncaughtException', new Error('第二处')); // 同一秒：只弹一条
  assert.equal(h.sent.length, 1);
  h.advance(1500);
  h.proc.emit('uncaughtException', new Error('第三处'));
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1].payload.ev.message, /未捕获异常/);
  h.guards.dispose();
});

test('guards: 窗口已销毁/没有窗口时兜底本身不抛', () => {
  const proc = new EventEmitter();
  const guards = installProcessGuards({ proc, getWin: () => null, warn: quietConsole() });
  assert.doesNotThrow(() => proc.emit('unhandledRejection', new Error('没人接'))); // 不能让兜底变成新的崩溃源
  guards.dispose();
});

// ---- 4) 工作流：节点失败不终止整条 run ----
const reportText = [
  '## Conclusion',
  '已汇总：有一个扇出节点未展开，其余结论有上游证据。',
  '## Findings',
  '- 未覆盖项见 Not covered。',
  '## Verified',
  'None',
  '## Not covered',
  '- [fa] 扇出未展开：上游没有给出列表',
  '## Skipped',
  'None',
  ''
].join('\n');

test('workflow/降级: callStep 抛错只让该节点失败，同层节点与 report 照常跑完', async () => {
  const ran = [];
  const out = await runWorkflow({
    goal: '节点失败不终止',
    script: [
      { op: 'step', id: 'a', prompt: '这一步会抛错' },
      { op: 'step', id: 'b', prompt: '这一步正常' },
      { op: 'report', id: 'r', from: ['a', 'b'], ask: '汇总' }
    ],
    callStep: async ({ id }) => {
      ran.push(id);
      if (id === 'a') throw new Error('子代理进程崩了');
      return { content: `${id} 的结果`, toolCount: 2 };
    }
  });
  assert.equal(out.error, undefined, '单个节点失败不能让整条 run 返回 error');
  const rowA = out.results.find((r) => r.id === 'a');
  const rowB = out.results.find((r) => r.id === 'b');
  assert.equal(rowA.ok, false);
  assert.equal(rowA.hole, true);
  assert.match(rowA.error, /子代理进程崩了/);
  assert.equal(rowB.ok, true);
  assert.ok(ran.includes('r'), 'report 仍然执行');
  assert.ok(out.results.some((r) => r.id === 'r'));
});

test('workflow/降级: fanout 的 over 解析不出列表 → 记成洞，run 继续（不再整条中止）', async () => {
  const out = await runWorkflow({
    goal: '扇出降级',
    script: [
      { op: 'step', id: 'recon', prompt: '给出待审列表' },
      { op: 'fanout', id: 'fa', over: 'recon', as: 'item', step: { prompt: '审查 ${item}' } },
      { op: 'report', id: 'r', from: ['fa'], ask: '汇总' }
    ],
    callStep: async ({ id }) => {
      if (id === 'recon') return { content: '{"ok":true}', toolCount: 1 }; // 不是列表
      if (id === 'r') return { content: reportText, toolCount: 1 };
      return { content: '子项结果', toolCount: 1 };
    }
  });
  assert.equal(out.error, undefined, 'over 解析失败必须降级，不能终止整条 run');
  const hole = out.results.find((r) => r.id === 'fa');
  assert.ok(hole, '扇出容器必须出现在结果里（界面才看得到失败）');
  assert.equal(hole.ok, false);
  assert.equal(hole.hole, true);
  assert.equal(hole.degraded, true);
  assert.match(hole.error, /over/i);
  assert.match(hole.error, /JSON|列表|每行一项/); // 文案要能照着改脚本
  assert.ok(out.warnings.some((w) => w === hole.error), 'out.warnings 必须能让人看到这条洞');
  assert.ok(out.results.some((r) => r.id === 'r'), 'report 仍然执行');
});

test('workflow/降级: fanout over 解析出 60 项（超过 50 上限）同样降级为洞，不中止', async () => {
  const many = JSON.stringify(Array.from({ length: 60 }, (_, i) => `item-${i}`));
  const out = await runWorkflow({
    goal: '扇出超上限',
    script: [
      { op: 'step', id: 'recon', prompt: '给出待审列表' },
      { op: 'fanout', id: 'fa', over: 'recon', as: 'item', step: { prompt: '审查 ${item}' } },
      { op: 'report', id: 'r', from: ['fa'], ask: '汇总' }
    ],
    callStep: async ({ id }) => {
      if (id === 'recon') return { content: many, toolCount: 1 };
      if (id === 'r') return { content: reportText, toolCount: 1 };
      return { content: '子项结果', toolCount: 1 };
    }
  });
  assert.equal(out.error, undefined);
  const hole = out.results.find((r) => r.id === 'fa');
  assert.equal(hole?.ok, false);
  assert.equal(hole?.degraded, true);
  assert.match(hole.error, /最多 50 项/);
  assert.ok(out.results.some((r) => r.id === 'r'), 'report 仍然执行');
});

// ---- 5) IPC 边界 + agent-chat：TDZ 类回归 ----
function chatHarness({ providers = [], activeProviderId = null, activeModel = '' } = {}) {
  const ipcMain = fakeIpcMain();
  installSafeIpc(ipcMain, { warn: quietConsole() });
  const cfg = { providers, activeProviderId, activeModel, permissionMode: 'ask' };
  const store = {
    loadConfig: async () => cfg,
    pickActiveProvider: (c) => c.providers.find((p) => p.id === c.activeProviderId && p.enabled !== false) || null,
    modelIdsOf: (p) => p.models || [],
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
  return { ipcMain, state };
}

test('agent-chat: 没有可用供应商 → 返回 { error }，不抛（普通发送路径的 TDZ 类回归）', async () => {
  const { ipcMain } = chatHarness();
  const r = await ipcMain.invoke('finalcheck:agent-chat', [{ role: 'user', content: '你好' }], [], null);
  assert.equal(isIpcError(r), false, '这是业务错误，不是 IPC 失败');
  assert.equal(typeof r.error, 'string');
  assert.match(r.error, /模型供应商/);
  assert.deepEqual(r.trace, []);
});

test('agent-chat: 畸形的 messages（null）→ IPC 边界转成 { error }，回合运行态不残留', async () => {
  const { ipcMain, state } = chatHarness();
  const r = await ipcMain.invoke('finalcheck:agent-chat', null, [], 'sess-x');
  assert.equal(isIpcError(r), true, '未预期异常必须被 IPC 安全层接住');
  assert.equal(r.channel, 'finalcheck:agent-chat');
  assert.equal(state.activeChats.has('sess-x'), false, '异常退出后不能留下假的「运行中」标记');
  assert.equal(state.steerBuffers.has('sess-x'), false);
});

// 清理：临时目录（会话/用量/项目文件都指向这里）
test('cleanup: 临时目录删除', async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
