// 权限台账 fail-closed 闭集审批（desktop/src/main/permissions.mjs）
// 语义对齐 deepseek-harness：decision ∈ {allowed-once, always-session, rejected}；
// 无应答/超时/非法值/无 UI 通道 = rejected
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  requestApproval, decide, confirmHost, assertHost, confirmDir, assertDir,
  noteTarget, commandPrefix, sessionAllowed, setApprovalEmitter,
  setApprovalTimeout, resetLedger, getLedger,
  grantOnce, consumeGrant, setPermissionHook
} from '../desktop/src/main/permissions.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('waitFor 超时');
    await sleep(5);
  }
};

beforeEach(() => { resetLedger(); });

test('permissions: session and project scopes isolate persistent and one-use approvals', async () => {
  const a = { sessionId: 'a', projectPath: process.cwd() };
  const b = { sessionId: 'b', projectPath: process.cwd() };
  const c = { sessionId: 'a', projectPath: path.join(process.cwd(), 'another-project') };
  setApprovalEmitter((p) => decide(p.callId, 'always-session'));
  await requestApproval({ tool: 'run_command', summary: 'echo review', ...a });
  assert.equal(sessionAllowed('run_command', 'echo review', a), true);
  assert.equal(sessionAllowed('run_command', 'echo review', b), false);
  assert.equal(sessionAllowed('run_command', 'echo review', c), false);
  assert.equal(sessionAllowed('run_command', 'echo review'), false);
  grantOnce('write_file', 'marker.txt', a);
  assert.equal(consumeGrant('write_file', 'marker.txt', b), false);
  assert.equal(consumeGrant('write_file', 'marker.txt', a), true);
  assert.equal(consumeGrant('write_file', 'marker.txt', a), false);
});

/* ---------- 命令前缀（always-session 的参数模式） ---------- */
test('permissions: commandPrefix 取前两个 token 并小写归一', () => {
  assert.equal(commandPrefix('npm run build --silent'), 'npm run');
  assert.equal(commandPrefix('  DIR   /B  '), 'dir /b');
  assert.equal(commandPrefix('dir'), 'dir');
  assert.equal(commandPrefix(''), '');
});

/* ---------- 审批闭集：allowed-once ---------- */
test('permissions: allowed-once 放行——emit 载荷含 callId/tool/summary，decide 回填原样 resolve', async () => {
  const seen = [];
  setApprovalEmitter((p) => seen.push(p));
  const pr = requestApproval({ tool: 'run_command', summary: 'dir /b D:\\x' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, 'run_command');
  assert.equal(seen[0].summary, 'dir /b D:\\x');
  assert.ok(seen[0].callId);
  assert.equal(decide(seen[0].callId, 'allowed-once'), true);
  assert.equal(await pr, 'allowed-once');
});

test('permissions: callId 缺省时自动生成', async () => {
  let payload = null;
  setApprovalEmitter((p) => { payload = p; });
  const pr = requestApproval({ tool: 'run_command', summary: 'echo hi' });
  decide(payload.callId, 'allowed-once');
  await pr;
  assert.match(payload.callId, /^ap-/);
});

/* ---------- 审批闭集：rejected / 非法值 / 未知 callId ---------- */
test('permissions: rejected 拒绝且不写 always-session 台账', async () => {
  let payload = null;
  setApprovalEmitter((p) => { payload = p; });
  const pr = requestApproval({ tool: 'run_command', summary: 'curl http://x' });
  decide(payload.callId, 'rejected');
  assert.equal(await pr, 'rejected');
  assert.equal(sessionAllowed('run_command', 'curl http://x'), false);
});

test('permissions: 非法 decision 值按 rejected 处理（闭集外一律 denied）', async () => {
  let payload = null;
  setApprovalEmitter((p) => { payload = p; });
  const pr = requestApproval({ tool: 'run_command', summary: 'echo hi' });
  decide(payload.callId, 'sure-why-not'); // 闭集外
  assert.equal(await pr, 'rejected');
});

test('permissions: decide 未知 callId 返回 false（不误伤在途审批）', async () => {
  let payload = null;
  setApprovalEmitter((p) => { payload = p; });
  const pr = requestApproval({ tool: 'run_command', summary: 'echo hi' });
  assert.equal(decide('no-such-id', 'allowed-once'), false);
  assert.equal(decide('', 'allowed-once'), false);
  assert.equal(decide(null, 'allowed-once'), false);
  // 在途审批不受误投影响，仍可正常决定
  assert.equal(decide(payload.callId, 'allowed-once'), true);
  assert.equal(await pr, 'allowed-once');
});

test('permissions: 同一 callId 不能重复 decide（二次投递 false）', async () => {
  let payload = null;
  setApprovalEmitter((p) => { payload = p; });
  const pr = requestApproval({ tool: 'run_command', summary: 'echo hi' });
  assert.equal(decide(payload.callId, 'allowed-once'), true);
  assert.equal(decide(payload.callId, 'always-session'), false);
  assert.equal(await pr, 'allowed-once');
});

/* ---------- 超时 / 无通道 fail-closed ---------- */
test('permissions: 超时无应答 → rejected（120s 默认，可调短验证）', async () => {
  setApprovalTimeout(30);
  setApprovalEmitter(() => {});
  const t0 = Date.now();
  const d = await requestApproval({ tool: 'run_command', summary: 'echo slow' });
  assert.equal(d, 'rejected');
  assert.ok(Date.now() - t0 >= 25, '应等待超时窗口后才拒绝');
});

test('permissions: 无 UI 通道（emitter 未注入）→ 立即 rejected', async () => {
  const d = await requestApproval({ tool: 'run_command', summary: 'echo hi' });
  assert.equal(d, 'rejected');
});

test('permissions: emitter 抛错 → rejected（通道故障不算放行）', async () => {
  setApprovalEmitter(() => { throw new Error('webContents destroyed'); });
  const d = await requestApproval({ tool: 'run_command', summary: 'echo hi' });
  assert.equal(d, 'rejected');
});

/* ---------- always-session：同一命令前缀二次免批 ---------- */
test('permissions: always-session 记录命令前缀，同前缀免批、异前缀不免', async () => {
  let payload = null;
  setApprovalEmitter((p) => { payload = p; });
  const pr = requestApproval({ tool: 'run_command', summary: 'npm run build' });
  decide(payload.callId, 'always-session');
  assert.equal(await pr, 'always-session');
  assert.equal(sessionAllowed('run_command', 'npm run'), true);                        // 同前缀
  assert.equal(sessionAllowed('run_command', commandPrefix('NPM RUN BUILD')), true);   // 归一后同前缀
  assert.equal(sessionAllowed('run_command', 'NPM RUN'), false);                       // 台账比对区分大小写（查表走 commandPrefix 归一）
  assert.equal(sessionAllowed('run_command', 'npm test'), false);                      // 异前缀不免批
  assert.equal(sessionAllowed('probe_target', 'npm run'), false);                      // 工具维度隔离
});

test('permissions: 主进程包装层按台账免批——同前缀第二次不再发审批事件', async () => {
  let emitted = 0;
  const payloads = [];
  setApprovalEmitter((p) => { emitted++; payloads.push(p); });
  // 模拟 index.mjs 的 run_command 包装逻辑
  const gated = async (cmd) => {
    if (!sessionAllowed('run_command', commandPrefix(cmd))) {
      const d = await requestApproval({ tool: 'run_command', summary: cmd });
      if (d !== 'allowed-once' && d !== 'always-session') return { error: '用户拒绝了本次命令执行' };
    }
    return { ok: true, cmd };
  };
  // 注意：emit 在 requestApproval 内同步发生，先拿 payload 决定再 await，避免测试内死锁
  const p1 = gated('git status --short');
  decide(payloads[0].callId, 'always-session');
  const r1 = await p1;
  assert.equal(r1.ok, true);
  const r2 = await gated('git status'); // 同前缀 'git status' → 免批
  assert.equal(r2.ok, true);
  assert.equal(emitted, 1, '第二次同前缀不应再触发审批事件');
  const p3 = gated('git push origin main'); // 异前缀 → 再次审批
  assert.equal(emitted, 2);
  decide(payloads[1].callId, 'allowed-once');
  const r3 = await p3;
  assert.equal(r3.ok, true);
  // denied 路径：拒绝后包装层给人话错误
  const p4 = gated('git push --force');
  decide(payloads[2].callId, 'rejected');
  const r4 = await p4;
  assert.deepEqual(r4, { error: '用户拒绝了本次命令执行' });
});

/* ---------- 主机台账 ---------- */
test('permissions: 本机目标默认放行，外部 host 未确认前 assertHost 抛错', () => {
  assert.equal(assertHost('localhost'), 'localhost');
  assert.equal(assertHost('127.0.0.1'), '127.0.0.1');
  assert.throws(() => assertHost('evil.example.com'), /不在已确认名单/);
});

test('permissions: confirmHost 写台账后放行；大小写/端口/URL 形式归一到 hostname', () => {
  assert.equal(confirmHost('EXAMPLE.COM:8443'), true);
  assert.equal(assertHost('example.com'), 'example.com');
  assert.equal(assertHost('https://example.com:8443/path'), 'example.com');
  assert.deepEqual(getLedger().confirmedHosts, ['example.com']);
});

test('permissions: confirmHost 非法输入返回 false 且不写台账（fail-closed）', () => {
  assert.equal(confirmHost(''), false);
  assert.equal(confirmHost('not a host!!'), false);
  assert.equal(confirmHost('ftp://x.com'), false);
  assert.deepEqual(getLedger().confirmedHosts, []);
  assert.throws(() => assertHost('x.com'), /不在已确认名单/);
});

test('permissions: IPv6 本机 [::1] 归一放行', () => {
  assert.equal(assertHost('[::1]'), '[::1]');
  assert.equal(confirmHost('::1'), true);
  assert.deepEqual(getLedger().confirmedHosts, ['[::1]']);
});

/* ---------- 动态目标总闸（替代旧 assertAllowedTarget） ---------- */
test('permissions: noteTarget 口头确认语义——只记账不拦（协议白名单保留）', () => {
  assert.throws(() => noteTarget('不是URL'), /无效 URL/);
  assert.throws(() => noteTarget('ftp://example.com'), /仅允许 http\/https/);
  confirmHost('evil.example.com');
  const u = noteTarget('http://evil.example.com:8080/api'); // 口头确认后：外部目标也放行
  assert.equal(u.hostname, 'evil.example.com');
  assert.equal(u.port, '8080');
});

/* ---------- 目录台账 ---------- */
test('permissions: 目录未确认 assertDir 抛错；confirmDir（含相对路径归一）后放行', () => {
  assert.throws(() => assertDir('D:\\tmp\\x'), /不在已确认名单/);
  assert.equal(confirmDir(''), false);
  assert.equal(confirmDir('D:\\tmp\\x'), true);
  assert.equal(assertDir('D:\\tmp\\x'), 'D:\\tmp\\x'); // Windows 绝对路径原样归一
  assert.deepEqual(getLedger().confirmedDirs.length, 1);
});

/* ---------- PermissionRequest hook（审批条之前的策略层） ---------- */
test('permissions: PermissionRequest hook deny → 直接 rejected，不弹审批条', async () => {
  const emitted = [];
  const hookCalls = [];
  setApprovalEmitter((p) => emitted.push(p));
  setPermissionHook(async (p) => { hookCalls.push(p); return { decision: 'deny', messages: ['策略拒绝'] }; });
  const d = await requestApproval({ tool: 'run_command', summary: 'curl http://x', sessionId: 's-hook' });
  assert.equal(d, 'rejected');
  assert.equal(emitted.length, 0, 'deny 时不应弹审批条');
  assert.deepEqual(hookCalls, [{ tool: 'run_command', summary: 'curl http://x', sessionId: 's-hook' }]);
});

test('permissions: PermissionRequest hook allow → 直接 allowed-once，不弹审批条', async () => {
  const emitted = [];
  setApprovalEmitter((p) => emitted.push(p));
  setPermissionHook(async () => ({ decision: 'allow' }));
  const d = await requestApproval({ tool: 'edit_file', summary: 'D:\\x\\a.js' });
  assert.equal(d, 'allowed-once');
  assert.equal(emitted.length, 0, 'allow 时不应弹审批条');
});

test('permissions: 没有 PermissionRequest hook 时走原审批流程', async () => {
  const emitted = [];
  setApprovalEmitter((p) => emitted.push(p));
  const pr = requestApproval({ tool: 'run_command', summary: 'echo hi' });
  assert.equal(emitted.length, 1, '无 hook 时应弹审批条');
  assert.equal(decide(emitted[0].callId, 'allowed-once'), true);
  assert.equal(await pr, 'allowed-once');
});

test('permissions: hook 抛错或返回非 allow|deny 时按无意见处理，仍走原审批', async () => {
  const emitted = [];
  setApprovalEmitter((p) => emitted.push(p));
  setPermissionHook(async () => ({ decision: 'ask' }));
  const pr = requestApproval({ tool: 'run_command', summary: 'echo ask' });
  await waitFor(() => emitted.length === 1);
  assert.equal(decide(emitted[0].callId, 'rejected'), true);
  assert.equal(await pr, 'rejected');

  setPermissionHook(async () => { throw new Error('hook 崩了'); });
  const pr2 = requestApproval({ tool: 'run_command', summary: 'echo boom' });
  await waitFor(() => emitted.length === 2);
  assert.equal(decide(emitted[1].callId, 'allowed-once'), true);
  assert.equal(await pr2, 'allowed-once', 'hook 异常不得阻断原审批');
});

/* ---------- 一次性免审券（hook ask 双确认） ---------- */
test('permissions: grantOnce 一次性免审——sessionAllowed 先查 grant，consumeGrant 消费即删', () => {
  grantOnce('edit_file', 'D:\\a.js');
  assert.equal(sessionAllowed('edit_file', 'D:\\a.js'), true, 'sessionAllowed 先查一次性免审券');
  assert.equal(consumeGrant('edit_file', 'D:\\a.js'), true);
  assert.equal(sessionAllowed('edit_file', 'D:\\a.js'), false, '免审券只能用一次');
  assert.equal(consumeGrant('edit_file', 'D:\\a.js'), false);
  grantOnce('write_file', 'D:\\b.js');
  assert.equal(sessionAllowed('edit_file', 'D:\\b.js'), false, '不同工具不共享免审券');
  assert.equal(consumeGrant('write_file', 'D:\\b.js'), true);
});

test('permissions: requestApproval 命中一次性免审券时不弹条（hook ask 批准后的第二次检查）', async () => {
  const emitted = [];
  setApprovalEmitter((p) => emitted.push(p));
  grantOnce('edit_file', 'D:\\a.js');
  const d = await requestApproval({ tool: 'edit_file', summary: 'D:\\a.js' });
  assert.equal(d, 'allowed-once');
  assert.equal(emitted.length, 0);
  // 券已消费：同参数再审批会重新弹条
  const pr = requestApproval({ tool: 'edit_file', summary: 'D:\\a.js' });
  await waitFor(() => emitted.length === 1);
  assert.equal(decide(emitted[0].callId, 'rejected'), true);
  assert.equal(await pr, 'rejected');
});

/* ---------- 台账快照 / 重置 ---------- */
test('permissions: resetLedger 清空三本台账、未决审批按拒绝收尾并恢复默认超时', async () => {
  confirmHost('a.com');
  confirmDir('D:\\x');
  setApprovalTimeout(25);
  setApprovalEmitter(() => {});
  const pr = requestApproval({ tool: 'run_command', summary: 'echo x' });
  resetLedger();
  assert.deepEqual(getLedger(), { confirmedHosts: [], confirmedDirs: [], sessionAllows: {} });
  assert.equal(await pr, 'rejected', '重置应把未决审批按拒绝收尾');
  // 恢复默认 120s：等一小段后应仍在等待而非被短超时拒绝。
  // 用 settled 标志而不是比较 Date.now()，避免 CI 计时器/时钟粒度导致的假失败。
  setApprovalEmitter(() => {});
  const p2 = requestApproval({ tool: 'run_command', summary: 'echo y' });
  let settled = false;
  p2.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false, '100ms 后应仍在等待（默认 120s 未到）');
  resetLedger(); // 清理：结束该未决请求
  assert.equal(await p2, 'rejected');
});
