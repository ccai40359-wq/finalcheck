// 0.33.1 计划模式全链路（无头模拟客户端，真后端 + 假网关）：
// 计划回合第一请求只有只读工具 + exit_plan_mode → 模型交计划 → 审批卡（kind=plan）→
// 用户「继续完善」带意见回来 → 再交 → 批准 → 同一回合里工具表原地换成完整版 → 写文件成功。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGateway } from '../scripts/sim/gateway.mjs';
import { createSimClient } from '../scripts/sim/client.mjs';

test('计划模式全链路：只读 → 交计划 → 退回改 → 批准 → 同一回合解锁写工具', async () => {
  const toolLists = [];
  const toolResults = [];
  const asks = [];
  let step = 0;
  const gw = await startGateway({
    mode: 'script',
    respond: (body, { kind }) => {
      if (kind !== 'main') return null;
      toolLists.push((body.tools || []).map((t) => t.function.name));
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'tool') toolResults.push(String(last.content));
      step += 1;
      if (step === 1) return { toolCalls: [{ name: 'write_file', args: { path: 'plan-e2e.txt', content: 'too early' } }] };
      if (step === 2) return { toolCalls: [{ name: 'exit_plan_mode', args: { plan: '## 计划\n1. 新建 plan-e2e.txt\n2. 写入 hello' } }] };
      if (step === 3) return { toolCalls: [{ name: 'exit_plan_mode', args: { plan: '## 计划 v2\n1. 新建 plan-e2e.txt\n2. 写入 hello\n3. read_file 验证' } }] };
      if (step === 4) return { toolCalls: [{ name: 'write_file', args: { path: 'plan-e2e.txt', content: 'hello' } }] };
      return { content: '完成。' };
    }
  });
  const sim = await createSimClient({
    label: 'plan-e2e', gateway: gw,
    config: { permissionMode: 'full' },
    answerAsk: (p) => {
      asks.push(p);
      return asks.length === 1 ? { selected: ['继续完善计划'], text: '加一步验证' } : '批准，开始执行';
    }
  });
  try {
    const sid = await sim.newSession();
    const r1 = await sim.send(sid, '帮我加个文件', { chatOpts: { planMode: true } });
    const trace = r1.result.trace;
    assert.deepEqual(trace.map((x) => x.tool), ['write_file', 'exit_plan_mode', 'exit_plan_mode', 'write_file']);

    assert.ok(!toolLists[0].includes('write_file') && !toolLists[0].includes('run_command'), '计划阶段 schema 里没有写工具');
    assert.ok(toolLists[0].includes('exit_plan_mode') && toolLists[0].includes('glob_files'));
    assert.match(toolResults[0], /计划模式下不能用 write_file/, '模型硬调写工具被工具层拦下');
    assert.equal(asks.length, 2);
    assert.equal(asks[0].kind, 'plan');
    assert.match(asks[0].question, /## 计划/);
    assert.match(toolResults[1], /加一步验证/, '用户意见带回给模型');
    assert.ok(!toolLists[2].includes('write_file'), '没批准仍是只读');
    assert.match(toolResults[2], /"approved":true/);
    assert.ok(toolLists[3].includes('write_file') && toolLists[3].includes('run_command'), '批准后同一回合工具表解锁');
    assert.ok(!toolLists[3].includes('exit_plan_mode'));
    assert.ok(!trace[3].result?.error, JSON.stringify(trace[3].result));
    assert.equal(trace[0].result.deniedBy, 'plan-mode');

    // 下一回合没开计划模式：完整工具表
    await sim.send(sid, '再说一句');
    assert.ok(toolLists.at(-1).includes('write_file') && !toolLists.at(-1).includes('exit_plan_mode'));
  } finally {
    await sim.backend()?.shutdown?.();
    await sim.close();
    await gw.close?.();
  }
});
