import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentTools, runCommandWithSignal } from '../desktop/src/main/agent-tools.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('run_command: 中断后 1s 内返回 cancelled 并结束长命令', async () => {
  // 不接真实审批：直接放行，专门验证 signal 从工具 ctx 注入后能杀进程并快速返回
  const tools = createAgentTools({
    repoRoot,
    permissions: { requestApproval: async () => 'allowed-once' }
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 200);
  const t0 = Date.now();
  const r = await tools.run_command({ command: 'node -e "setTimeout(()=>{},60000)"' }, { signal: ctl.signal });
  clearTimeout(timer);
  const elapsed = Date.now() - t0;
  assert.equal(r.cancelled, true, '中断结果必须带 cancelled:true');
  assert.match(String(r.error || ''), /已中断/);
  assert.ok(elapsed < 1000, `中断应在 1s 内生效，实际 ${elapsed}ms`);
});

test('run_command: signal 已 abort 时不再启动命令', async () => {
  const ctl = new AbortController();
  ctl.abort();
  const t0 = Date.now();
  const r = await runCommandWithSignal('node -e "setTimeout(()=>{},60000)"', { signal: ctl.signal });
  assert.equal(r.cancelled, true);
  assert.ok(Date.now() - t0 < 500);
});
