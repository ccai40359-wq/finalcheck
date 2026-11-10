// run_command 的空闲输出看门狗 / background 启动：
// 实证事故——子代理跑 `node -e "https.get(...timeout)"` 或 `Start-Process node server.mjs` 后
// 父命令永不退出，整轮卡在「运行中」。这里用真实短命令覆盖三种收尾方式（不碰网络）：
//   1. 长时间无输出 → 转后台返回 pid，不杀进程；
//   2. 持续有输出 → 正常跑到结束（不设工作时长上限）；
//   3. background:true → 立即返回 pid；
//   4. 显式 timeout_ms → 仍然到点终止（旧回归）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createAgentTools, runCommandWithSignal } from '../desktop/src/main/agent-tools.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SILENT_60S = 'node -e "setTimeout(()=>{}, 60000)"';

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* 已退出 */ }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('run_command: 连续 idleMs 无输出 → 转后台返回 pid，且不杀进程', async (t) => {
  const t0 = Date.now();
  const r = await runCommandWithSignal(SILENT_60S, { idleMs: 500 });
  const elapsed = Date.now() - t0;
  t.after(() => killTree(r.pid));

  assert.equal(r.background, true, '静默命令应转入后台');
  assert.ok(Number(r.pid) > 0, '必须带 pid');
  assert.ok(elapsed >= 400 && elapsed < 3000, `应在 1–2s 内返回（宽松上界 3s），实际 ${elapsed}ms`);
  assert.match(String(r.note || ''), /已 .*无输出，已转入后台/);
  assert.match(String(r.note || ''), new RegExp(`PID=${r.pid}`));
  assert.equal(alive(r.pid), true, '转后台不应杀进程（用户没让停）');
});

test('run_command: 持续有输出的长命令正常完成，不误判为卡住', async () => {
  const cmd = 'node -e "let i=0;const t=setInterval(()=>{console.log(i++); if(i>=5){clearInterval(t)}},300)"';
  const t0 = Date.now();
  const r = await runCommandWithSignal(cmd, { idleMs: 800 });
  const elapsed = Date.now() - t0;

  assert.equal(r.background, undefined, '有输出就不该转后台');
  assert.equal(r.code, 0, '命令应正常结束');
  assert.ok(elapsed >= 1200, `应真的跑了约 1.5s，实际 ${elapsed}ms`);
  for (const n of ['0', '1', '2', '3', '4']) assert.match(String(r.stdout), new RegExp(`${n}\\n`));
});

test('run_command: background:true 立即返回 pid，不等待输出', async (t) => {
  const t0 = Date.now();
  const r = await runCommandWithSignal(SILENT_60S, { background: true });
  const elapsed = Date.now() - t0;
  t.after(() => killTree(r.pid));

  assert.equal(r.background, true);
  assert.ok(Number(r.pid) > 0, '必须带 pid');
  assert.ok(elapsed < 2000, `应立即返回（宽松上界 2s），实际 ${elapsed}ms`);
  assert.match(String(r.note || ''), /已在后台启动/);
  assert.equal(alive(r.pid), true, '后台进程应真的活着');
});

test('run_command: 工具层透传 background / commandIdleMs（config 默认值）', async (t) => {
  const tools = createAgentTools({
    repoRoot,
    permissions: { requestApproval: async () => 'allowed-once' },
    commandIdleMs: 500
  });
  const t0 = Date.now();
  const r = await tools.run_command({ command: SILENT_60S });
  t.after(() => killTree(r.pid));

  assert.equal(r.background, true, 'createAgentTools 的 commandIdleMs 应生效');
  assert.ok(Number(r.pid) > 0);
  assert.ok(Date.now() - t0 < 3000);

  const bg = await tools.run_command({ command: SILENT_60S, background: true });
  t.after(() => killTree(bg.pid));
  assert.equal(bg.background, true);
  assert.ok(Number(bg.pid) > 0);
  assert.match(String(bg.note || ''), /已在后台启动/);
});

test('run_command: 显式 timeout_ms 仍按旧语义到点终止（回归）', async () => {
  const t0 = Date.now();
  // idleMs 故意设得比 timeout 小：显式超时必须优先，仍然 code=124 并杀进程树
  const r = await runCommandWithSignal(SILENT_60S, { timeoutMs: 500, idleMs: 200 });
  const elapsed = Date.now() - t0;

  assert.equal(r.background, undefined, '显式超时不应转后台');
  assert.equal(r.code, 124);
  assert.match(String(r.stderr), /超时已终止/);
  assert.ok(elapsed < 5000, `应在超时后很快返回，实际 ${elapsed}ms`);
});
