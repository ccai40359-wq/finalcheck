// 0.33.0 持久权限规则全链路（无头模拟客户端，真后端 + 假网关）：
// config.json 的 permissionRules → 回合读取 → allow 的写文件不弹审批、deny 的命令不审批直接拒；
// 设置页 IPC：非法规则不保存、「试一下」用草稿规则判定、保存后下一回合生效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startGateway } from '../scripts/sim/gateway.mjs';
import { createSimClient } from '../scripts/sim/client.mjs';

test('权限规则全链路：allow 免审、deny 直接拒、设置页保存 / 校验 / 试一下', async () => {
  const approvals = [];
  const toolResults = [];
  const gw = await startGateway({
    mode: 'script',
    respond: (body, { kind }) => {
      if (kind !== 'main') return null;
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'tool') { toolResults.push(String(last.content)); return { content: '完成。' }; }
      const user = String(last.content);
      if (/写笔记/.test(user)) return { toolCalls: [{ name: 'write_file', args: { path: 'rules-note.md', content: '# hi\n' } }] };
      if (/写代码/.test(user)) return { toolCalls: [{ name: 'write_file', args: { path: 'rules-code.js', content: '1\n' } }] };
      if (/推送/.test(user)) return { toolCalls: [{ name: 'run_command', args: { command: 'git push origin main' } }] };
      return { content: '好的。' };
    }
  });
  const sim = await createSimClient({
    label: 'rules-e2e', gateway: gw,
    config: {
      permissionMode: 'ask',
      permissionRules: { allow: ['write_file(*.md)'], deny: ['run_command(git push*)'] }
    },
    approvals: (p) => { approvals.push(p); return 'rejected'; }
  });
  try {
    const sid = await sim.newSession();

    // ① allow 命中：不弹审批，文件写成
    await sim.send(sid, '写笔记');
    assert.equal(approvals.length, 0, '命中 allow 不弹审批');
    assert.ok(!toolResults.at(-1).includes('"error"'), toolResults.at(-1));

    // ② 没命中：照常审批（这里拒绝）
    await sim.send(sid, '写代码');
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'write_file');

    // ③ deny：不审批，直接拒，并告诉模型别绕
    await sim.send(sid, '推送');
    assert.equal(approvals.length, 1, 'deny 不走审批');
    assert.match(toolResults.at(-1), /被权限规则拒绝（run_command\(git push\*\)）/);

    // ④ 设置页：读取 / 非法规则不保存 / 试一下 / 保存
    const got = await sim.invoke('finalcheck:permission-rules-get');
    assert.deepEqual(got, { allow: ['write_file(*.md)'], deny: ['run_command(git push*)'] });
    const bad = await sim.invoke('finalcheck:permission-rules-save', { allow: ['oops rule('], deny: [] });
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 1);
    const tried = await sim.invoke('finalcheck:permission-rules-test', { rules: { allow: ['write_file(*.js)'], deny: [] }, tool: 'write_file', input: 'rules-code.js' });
    assert.equal(tried.decision, 'allow');
    const saved = await sim.invoke('finalcheck:permission-rules-save', { allow: ['write_file(*.md)', 'write_file(*.js)'], deny: ['run_command(git push*)'] });
    assert.equal(saved.ok, true);
    const cfg = JSON.parse(readFileSync(process.env.FINALCHECK_CONFIG_FILE, 'utf8'));
    assert.deepEqual(cfg.permissionRules.allow, ['write_file(*.md)', 'write_file(*.js)']);

    // ⑤ 保存后下一回合生效
    await sim.send(sid, '写代码');
    assert.equal(approvals.length, 1, '新规则生效：不再弹审批');
    assert.ok(!toolResults.at(-1).includes('"error"'), toolResults.at(-1));
  } finally {
    await sim.backend()?.shutdown?.();
    await sim.close();
    await gw.close?.();
  }
});
