// 0.33.1 Hooks 设置页：读 / 存 hooks.json（存完立即重载，下一次工具调用就生效）/ 试跑一条。
// 全程在模拟客户端的隔离目录里（FINALCHECK_HOOKS_FILE 指向临时目录），不碰本机真实 hooks.json。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { startGateway } from '../scripts/sim/gateway.mjs';
import { createSimClient } from '../scripts/sim/client.mjs';

test('Hooks 设置页：保存后立即生效（PreToolUse 拒绝真的拦下工具）、试跑返回判定与输出、坏配置给警告', async () => {
  const scripts = mkdtempSync(path.join(os.tmpdir(), 'fc-hookscripts-'));
  const denyScript = path.join(scripts, 'deny.mjs');
  writeFileSync(denyScript, "process.stdin.resume();let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({decision:'deny',message:'hook 不让写 '+(p.args&&p.args.path)}));});");
  const toolResults = [];
  const gw = await startGateway({
    mode: 'script',
    respond: (body, { kind }) => {
      if (kind !== 'main') return null;
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'tool') { toolResults.push(String(last.content)); return { content: '完成。' }; }
      return { toolCalls: [{ name: 'write_file', args: { path: 'hooked.txt', content: 'x' } }] };
    }
  });
  const sim = await createSimClient({ label: 'hooks-ui', gateway: gw, config: { permissionMode: 'full' } });
  try {
    assert.ok(process.env.FINALCHECK_HOOKS_FILE.startsWith(os.tmpdir()) || !process.env.FINALCHECK_HOOKS_FILE.includes('AppData\\Roaming\\FinalCheck'), '隔离目录');
    const got = await sim.invoke('finalcheck:hooks-get');
    assert.equal(got.enabled, false);
    assert.equal(got.events.length, 7);

    const cmd = `"${process.execPath}" "${denyScript}"`;
    const saved = await sim.invoke('finalcheck:hooks-save', { enabled: true, events: { PreToolUse: [{ matcher: 'write_file', command: cmd }], Bogus: [] } });
    assert.equal(saved.ok, true);
    assert.equal(saved.enabled, true);
    assert.ok(saved.warnings.some((w) => /Bogus/.test(w)), '未知事件给警告');
    const onDisk = JSON.parse(readFileSync(process.env.FINALCHECK_HOOKS_FILE, 'utf8'));
    assert.equal(onDisk.events.PreToolUse[0].matcher, 'write_file');

    const sid = await sim.newSession();
    await sim.send(sid, '写个文件');
    assert.match(toolResults.at(-1), /被 hook 拦截：hook 不让写 hooked\.txt/, '保存后不用重启就生效');

    const tried = await sim.invoke('finalcheck:hooks-test', { event: 'PreToolUse', hook: { command: cmd } });
    assert.equal(tried.decision, 'deny');
    assert.match(tried.outputs[0].stdout, /hook 不让写/);
    assert.equal(tried.outputs[0].code, 0);
    assert.ok((await sim.invoke('finalcheck:hooks-test', { event: 'Nope', hook: { command: 'x' } })).error);
    assert.equal((await sim.invoke('finalcheck:hooks-save', [])).ok, false);
  } finally {
    await sim.backend()?.shutdown?.();
    await sim.close();
    await gw.close?.();
    rmSync(scripts, { recursive: true, force: true });
  }
});
