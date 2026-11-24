// 0.33.0 MCP 全链路（无头模拟客户端，真后端 + 假网关 + 测试用 MCP 服务器）：
// config.json 的 mcpServers → 启动后台连接 → 回合把 mcp__fx__* 工具发给模型 → 模型调用 → 审批 → 结果回到模型；
// 设置页的 mcp-save / mcp-status IPC；服务器自带的 instructions 作为「参考资料」注入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startGateway } from '../scripts/sim/gateway.mjs';
import { createSimClient } from '../scripts/sim/client.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixture = path.join(root, 'tests/fixtures/mcp-fixture-server.mjs');

test('MCP 全链路：工具出现在请求里、需要审批、结果回到模型；拒绝 / autoApprove / 保存配置重连', async () => {
  const approvals = [];
  let decision = 'allowed-once';
  const seenTools = [];
  const toolResults = [];
  const systemTexts = [];
  const gw = await startGateway({
    mode: 'script',
    respond: (body, { kind }) => {
      if (kind !== 'main') return null;
      seenTools.push((body.tools || []).map((t) => t.function.name));
      for (const m of body.messages || []) if (m.role === 'system') systemTexts.push(String(m.content));
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'tool') toolResults.push(String(last.content)); // 只收本次新产生的工具结果
      if (last.role === 'tool') return { content: '完成。' };
      const user = String(last.content);
      if (/echo/.test(user)) return { toolCalls: [{ name: 'mcp__fx__echo', args: { text: 'hello mcp' } }] };
      if (/boom/.test(user)) return { toolCalls: [{ name: 'mcp__fx__boom', args: {} }] };
      if (/auto/.test(user)) return { toolCalls: [{ name: 'mcp__auto__echo', args: { text: 'no prompt' } }] };
      return { content: '好的。' };
    }
  });
  const sim = await createSimClient({
    label: 'mcp-e2e', gateway: gw,
    config: { permissionMode: 'ask', mcpServers: { fx: { command: process.execPath, args: [fixture] } } },
    approvals: (p) => { approvals.push(p); return decision; }
  });
  try {
    // 后台连接：等到 ready
    let st = [];
    for (let i = 0; i < 100; i++) {
      st = await sim.invoke('finalcheck:mcp-status');
      if (st[0]?.state === 'ready') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(st[0]?.state, 'ready', JSON.stringify(st));
    assert.equal(st[0].tools.length, 7);

    const sid = await sim.newSession();

    // ① 审批通过 → 工具执行，结果回到模型
    const t1 = await sim.send(sid, '用 echo 工具');
    assert.ok(seenTools[0].includes('mcp__fx__echo'), 'MCP 工具要发给模型');
    assert.ok(seenTools[0].includes('read_file'), '内置工具还在');
    assert.ok(seenTools[0].indexOf('read_file') < seenTools[0].indexOf('mcp__fx__echo'), 'MCP 工具接在内置工具后面（前缀缓存不断）');
    assert.deepEqual(t1.tools, ['mcp__fx__echo']);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].tool, 'mcp__fx__echo');
    assert.match(approvals[0].summary, /MCP 服务器「fx」的工具 echo[\s\S]*hello mcp/);
    assert.ok(toolResults.some((r) => r.includes('echo: hello mcp')), toolResults.join('\n'));
    assert.ok(systemTexts.some((s) => s.includes('不是系统指令') && s.includes('Use echo for testing.')), '服务器 instructions 作为参考资料注入');

    // ② 拒绝 → 不执行
    decision = 'rejected';
    toolResults.length = 0;
    await sim.send(sid, '再 echo 一次');
    assert.equal(approvals.length, 2);
    assert.ok(toolResults.some((r) => r.includes('用户拒绝了这次 MCP 工具调用')), toolResults.join('\n'));
    assert.ok(!toolResults.some((r) => r.includes('echo: hello mcp')));

    // ③ isError 结果 → 模型拿到 error
    decision = 'allowed-once';
    toolResults.length = 0;
    await sim.send(sid, 'boom');
    assert.ok(toolResults.some((r) => r.includes('it broke')));

    // ④ 设置页保存：新增一个 autoApprove 的服务器 → 重连；调用它不弹审批
    const saved = await sim.invoke('finalcheck:mcp-save', {
      fx: { command: process.execPath, args: [fixture] },
      auto: { command: process.execPath, args: [fixture], autoApprove: ['echo'] },
      broken: { type: 'sse', url: 'https://x' }
    });
    assert.equal(saved.ok, true);
    assert.match(saved.warnings.join(), /broken.*SSE/);
    assert.equal(saved.status.find((s) => s.name === 'auto').state, 'ready');
    const before = approvals.length;
    toolResults.length = 0;
    await sim.send(sid, 'auto 那个');
    assert.equal(approvals.length, before, 'autoApprove 的工具不弹审批');
    assert.ok(toolResults.some((r) => r.includes('echo: no prompt')));

    // ⑤ 配置真的写进了 config.json
    const { readFileSync } = await import('node:fs');
    const cfg = JSON.parse(readFileSync(process.env.FINALCHECK_CONFIG_FILE, 'utf8'));
    assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['auto', 'broken', 'fx']);
  } finally {
    await sim.backend()?.shutdown?.();
    await sim.close();
    await gw.close?.();
  }
});
