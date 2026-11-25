// 0.33.5 后台任务：命令跑久了转后台（几秒内跑完的照常等）、后台子代理、background_task、完成后自动送达模型。
// 用户原话：「主 agent 跑了一个脚本，可以把进程挂后台，直接停下来再接收用户信息做其他事；
//           但如果这个脚本几秒钟跑完了，那就没必要停」「派出一个子 agent，主 agent 自己干自己的活」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBgTaskManager, BG_MAX_RUNNING } from '../desktop/src/main/bg-tasks.mjs';
import { runCommandWithSignal, createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { AGENT_TOOLS_SCHEMA, SUBAGENT_TOOLS_SCHEMA } from '../desktop/src/main/agent-service.mjs';
import * as permsMod from '../desktop/src/main/permissions.mjs';
import { bgChipSummary } from '../desktop/src/renderer/lib/bg-tasks-view.mjs';
import { startGateway } from '../scripts/sim/gateway.mjs';
import { createSimClient } from '../scripts/sim/client.mjs';

const NODE = 'node'; // 走 PATH：绝对路径（C:/Program Files/...）会被项目外路径闸拒绝
const sleepCmd = (ms, msg) => `${NODE} -e "setTimeout(()=>{console.log('${msg}')},${ms})"`;

test('账本：登记 / 输出 / 完成 / 未送达只取一次 / 等待 / 停止 / 并发上限', async () => {
  const changes = [];
  const finished = [];
  const m = createBgTaskManager({ onChange: (sid, list) => changes.push([sid, list.length]), onFinish: (x) => finished.push(x.id) });
  const a = m.start({ sessionId: 's1', kind: 'command', title: 'npm test' });
  assert.equal(a.id, 'bg-1');
  m.append(a.id, 'line1\n');
  m.append(a.id, 'line2\n');
  assert.match(m.output(a.id), /line1\nline2/);
  assert.equal(m.hasUndelivered('s1'), false);
  const waiting = m.wait(a.id, 5000);
  m.finish(a.id, { status: 'failed', exitCode: 1 });
  const w = await waiting;
  assert.equal(w.done, true);
  assert.equal(w.task.status, 'failed');
  assert.deepEqual(finished, ['bg-1']);
  assert.equal(m.hasUndelivered('s1'), true);
  const got = m.takeUndelivered('s1');
  assert.equal(got.length, 1);
  assert.match(got[0].notice, /【后台任务完成】bg-1 命令失败.*退出码 1/);
  assert.match(got[0].notice, /line2/);
  assert.equal(m.takeUndelivered('s1').length, 0, '只送达一次');
  assert.equal(m.takeUndelivered('other').length, 0, '会话隔离');

  // 子代理：报告进通知
  const b = m.start({ sessionId: 's1', kind: 'agent', title: '调研 X' });
  m.finish(b.id, { status: 'done', result: '结论：X 很好' });
  assert.match(m.takeUndelivered('s1')[0].notice, /子代理「调研 X」已完成[\s\S]*结论：X 很好/);

  // 停止：调 stop 函数；用户停的要通知模型，模型自己停的不用
  let killed = 0;
  const c = m.start({ sessionId: 's1', title: 'server', stop: () => { killed++; } });
  assert.equal(m.stop(c.id).ok, true);
  assert.equal(killed, 1);
  assert.equal(m.get(c.id).status, 'stopped');
  assert.equal(m.takeUndelivered('s1').length, 1, '用户在面板停的要告诉模型');
  const d = m.start({ sessionId: 's1', title: 'x', stop: () => { killed++; } });
  m.stop(d.id, { by: 'model' });
  assert.equal(m.takeUndelivered('s1').length, 0, '模型自己停的不再通知');

  // 等待超时
  const e = m.start({ sessionId: 's2', title: 'slow' });
  const t0 = Date.now();
  const r = await m.wait(e.id, 120);
  assert.equal(r.done, false);
  assert.ok(Date.now() - t0 < 2000);

  // 并发上限
  for (let i = 1; i < BG_MAX_RUNNING; i++) assert.ok(m.start({ sessionId: 's2', title: `t${i}` }).id);
  assert.match(m.start({ sessionId: 's2', title: 'over' }).error, /上限/);
  assert.ok(changes.length > 5, '每次变化都推给界面');
});

test('runCommandWithSignal：几秒内跑完的照常等结果；跑久了转后台、输出继续收集、退出时回调', async () => {
  let detachCalls = 0;
  const onDetach = () => { detachCalls++; return { taskId: 'bg-x', note: 'n', onData() {}, onExit() {} }; };
  const quick = await runCommandWithSignal(`${NODE} -e "console.log('fast-ok')"`, { detachMs: 3000, onDetach });
  assert.equal(quick.code, 0);
  assert.match(quick.stdout, /fast-ok/);
  assert.equal(detachCalls, 0, '快命令不转后台');

  let data = '';
  let exitCode = null;
  const exited = new Promise((resolve) => {
    const t0 = Date.now();
    void runCommandWithSignal(sleepCmd(1500, 'slow-done'), {
      detachMs: 300,
      onDetach: ({ pid, reason }) => {
        assert.equal(reason, 'yield');
        assert.ok(pid > 0);
        return { taskId: 'bg-9', note: '已转后台', onData: (s) => { data += s; }, onExit: (c) => { exitCode = c; resolve(); } };
      }
    }).then((r) => {
      assert.equal(r.detached, true);
      assert.equal(r.taskId, 'bg-9');
      assert.equal(r.code, null);
      assert.ok(Date.now() - t0 < 1400, `应在约 300ms 返回，实际 ${Date.now() - t0}ms`);
    });
  });
  await exited;
  assert.equal(exitCode, 0);
  assert.match(data, /slow-done/, '转后台后的输出继续收集');
});

test('工具层：run_command 转后台登记成任务；background_task wait/output/list；子代理工具表没有 background_task', async () => {
  permsMod.setMode('full'); // 审批自动放行（这里测的是后台机制，不是审批）
  const bg = createBgTaskManager();
  const tools = createAgentTools({ repoRoot: process.cwd(), sessionId: 'sess-a', bgTasks: bg, commandYieldMs: 300, permissions: { noteTarget() {}, commandPrefix: (c) => permsMod.commandPrefix(c), consumeGrant: permsMod.consumeGrant, sessionAllowed: permsMod.sessionAllowed, requestApproval: permsMod.requestApproval } });
  const r = await tools.run_command({ command: sleepCmd(1200, 'bg-finished') }, {});
  assert.equal(r.detached, true, JSON.stringify(r).slice(0, 300));
  assert.match(r.note, /已转为后台任务 bg-1.*不要轮询/);
  const list = await tools.background_task({ action: 'list' });
  assert.equal(list.tasks[0].status, 'running');
  const w = await tools.background_task({ action: 'wait', id: 'bg-1', timeout_ms: 10000 });
  assert.equal(w.status, 'done');
  assert.match(w.result, /bg-finished/);
  assert.equal(bg.hasUndelivered('sess-a'), false, '原地等到的结果不再重复通知');
  const out = await tools.background_task({ action: 'output', id: 'bg-1' });
  assert.match(out.output, /bg-finished/);
  // yield_ms:0 = 一直等
  const r2 = await tools.run_command({ command: sleepCmd(600, 'waited'), yield_ms: 0 }, {});
  assert.equal(r2.code, 0);
  assert.match(r2.stdout, /waited/);
  // 别的会话看不到
  const other = createAgentTools({ repoRoot: process.cwd(), sessionId: 'sess-b', bgTasks: bg, permissions: { noteTarget() {}, commandPrefix: (c) => permsMod.commandPrefix(c), consumeGrant: permsMod.consumeGrant, sessionAllowed: permsMod.sessionAllowed, requestApproval: permsMod.requestApproval } });
  assert.match((await other.background_task({ action: 'output', id: 'bg-1' })).error, /没有这个后台任务/);
  // 没有 bgTasks（子代理 / 工作流）：命令照旧前台等，工具表没有 background_task
  const sub = createAgentTools({ repoRoot: process.cwd() });
  assert.equal(sub.background_task, undefined);
  assert.ok(AGENT_TOOLS_SCHEMA.some((s) => s.function.name === 'background_task'));
  assert.ok(!SUBAGENT_TOOLS_SCHEMA.some((s) => s.function.name === 'background_task'));
  const spawnSchema = AGENT_TOOLS_SCHEMA.find((s) => s.function.name === 'spawn_agent');
  assert.equal(spawnSchema.function.parameters.properties.background.type, 'boolean');
  assert.match(spawnSchema.function.description, /主动用后台子代理/);
});

test('全链路：命令转后台 → 模型结束本轮 → 完成通知界面 → 下一轮把结果注入给模型；后台子代理不阻塞主回合', async () => {
  const seen = []; // 每个主请求的最后几条消息
  let subCalls = 0;
  const gw = await startGateway({
    mode: 'script',
    respond: async (body, { kind }) => {
      const msgs = body.messages;
      const last = msgs[msgs.length - 1];
      if (kind === 'subagent') {
        subCalls++;
        if (last.role === 'tool') return { delayMs: 800, content: '子代理报告：仓库里有 3 处调用。' };
        return { toolCalls: [{ name: 'list_dir', args: {} }] };
      }
      if (kind !== 'main') return null;
      const users = msgs.filter((m) => m.role === 'user').map((m) => String(m.content));
      seen.push(users.slice(-3));
      const q = users.filter((u) => !u.startsWith('【')).at(-1) || '';
      if (q.includes('跑脚本')) {
        if (last.role === 'tool') { return { content: '脚本还在后台跑，跑完我再看。' }; }
        return { toolCalls: [{ name: 'run_command', args: { command: sleepCmd(1500, 'SCRIPT-RESULT-42'), yield_ms: 300 } }] };
      }
      if (q.includes('后台调研')) {
        if (last.role === 'tool') return { content: '已派后台子代理去查，你可以继续问别的。' };
        return { toolCalls: [{ name: 'spawn_agent', args: { description: '查调用', prompt: '找出所有调用 foo 的地方', background: true } }] };
      }
      return { content: '收到。' };
    }
  });
  const sim = await createSimClient({ label: 'bg-tasks', gateway: gw, config: { permissionMode: 'full' } });
  const done = [];
  const off = sim.onWin((ch, p) => { if (ch === 'finalcheck:bg-task-done') done.push(p); });
  try {
    const s = await sim.newSession();
    const t0 = Date.now();
    const r1 = await sim.send(s, '帮我跑脚本');
    assert.match(r1.answer, /后台跑/);
    assert.ok(Date.now() - t0 < 1500 + 3000, '本轮没有干等脚本');
    const listed = await sim.invoke('finalcheck:bg-tasks-list', s);
    assert.equal(listed.tasks[0].kind, 'command');
    // 等脚本结束：会话空闲 → 通知界面
    const deadline = Date.now() + 8000;
    while (!done.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(done[0]?.sessionId, s, '空闲时完成要通知界面自动续跑');
    assert.equal((await sim.invoke('finalcheck:bg-tasks-list', s)).pending, true);
    // 界面自动起的一轮（或用户先发的消息）：结果注入给模型
    await sim.send(s, '（后台任务已结束，请查看结果并继续）');
    const injected = seen.at(-1).find((u) => u.startsWith('【后台任务完成】'));
    assert.ok(injected, JSON.stringify(seen.at(-1)));
    assert.match(injected, /SCRIPT-RESULT-42/);
    assert.match(injected, /退出码 0/);
    assert.equal((await sim.invoke('finalcheck:bg-tasks-list', s)).pending, false);

    // 后台子代理：主回合立刻结束（子代理 800ms 后才交报告）
    const t1 = Date.now();
    const r2 = await sim.send(s, '后台调研一下 foo');
    assert.match(r2.answer, /后台子代理/);
    assert.ok(Date.now() - t1 < 3000);
    const d2 = Date.now() + 10000;
    while ((await sim.invoke('finalcheck:bg-tasks-list', s)).tasks.find((x) => x.kind === 'agent')?.status !== 'done' && Date.now() < d2) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(subCalls >= 2, '子代理确实跑了');
    await sim.send(s, '继续');
    const inj2 = seen.at(-1).find((u) => u.includes('子代理「查调用」'));
    assert.ok(inj2, JSON.stringify(seen.at(-1)));
    assert.match(inj2, /仓库里有 3 处调用/);
  } finally {
    off();
    await sim.backend()?.shutdown?.();
    await sim.close();
    await gw.close?.();
  }
});

test('界面：胶囊统计 + 面板挂在验收单浮层同一列 + 完成后进队列自动续跑', () => {
  assert.deepEqual(bgChipSummary([{ status: 'running' }, { status: 'failed' }, { status: 'done' }]), { total: 3, running: 1, failed: 1, done: 2 });
  const ml = readFileSync(new URL('../desktop/src/renderer/components/MessageList.jsx', import.meta.url), 'utf8');
  assert.match(ml, /top=\{activeId \? <BgTasksPanel/);
  const app = readFileSync(new URL('../desktop/src/renderer/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /onBgTaskDone\(/);
  assert.match(app, /bgAuto: true/);
  assert.match(app, /override\?\.bgAuto/);
});
