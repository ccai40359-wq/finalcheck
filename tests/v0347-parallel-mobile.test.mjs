// 0.34.7：分工提速（本回合调度 / 串行太久提醒 / parallel 命令同时跑 / 一起等多个后台任务）、
// 显卡信息进运行环境、手机切会话提速（瘦身会话 / 只先画最近 30 条 / 一次解析 / 异步压缩 / 进度条）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAgentTurn, turnIntent, dispatchNote, DISPATCH_NOTE, SOLO_NUDGE_CALLS, getSystemPromptParts } from '../desktop/src/main/agent-service.mjs';
import { createBgTaskManager } from '../desktop/src/main/bg-tasks.mjs';
import { parseGpuCsv, gpuLine } from '../desktop/src/main/gpu-info.mjs';
import { runtimeEnvNote } from '../desktop/src/main/ipc/ipc-agent.mjs';
import { slimSessionForPhone, STR_MAX } from '../desktop/src/main/mobile/slim-session.mjs';

const src = (p) => readFileSync(new URL(`../desktop/src/${p}`, import.meta.url), 'utf8');
const cfg = () => ({ baseUrl: 'https://mock.example/v1', apiKey: 'k', model: 'm' });
const sse = (chunks) => new Response(
  chunks.map((c) => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } }
);
const calls = (list) => sse([{ choices: [{ delta: { tool_calls: list.map(([name, args], index) => ({ index, id: `c${index}-${Math.random().toString(36).slice(2, 7)}`, function: { name, arguments: JSON.stringify(args) } })) } }] }]);
const say = (text) => sse([{ choices: [{ delta: { content: text } }] }]);

test('意图：要动手的才分工，提问 / 做计划 / 「先别动」照旧直接答', () => {
  const doIt = ['帮我全面梳理这个项目：每个模块干什么、有没有 bug', 'src/calc.js 有 bug：sum 返回不对。修好它', '统计 sales.csv 里每个月的销售额，写成 summary.md', '新建 hello.py 打印 hi 并运行', '能不能帮我修一下这个报错', '你可以开始了', '把 source.mp4 用显卡转码成 720p'];
  const ask = ['我显卡能做什么', 'qlora是什么，你回答我', '帮我规划一下用显卡练 llm', '今天几号', '这段代码写得对吗？', '给出迁移的分步计划。先不要改任何代码，只给计划。', '为什么手机切会话这么慢'];
  for (const s of doIt) assert.equal(turnIntent(s), 'do', s);
  for (const s of ask) assert.equal(turnIntent(s), 'ask', s);
  assert.equal(dispatchNote('今天几号'), null);
  assert.match(dispatchNote('帮我写三个脚本'), /同一次回复里一起发/);
});

test('本回合调度：dev 轨、要动手的消息 → 用户消息后面带一条分工提醒；提问不带', async () => {
  const bodies = [];
  const fetchImpl = async (_u, init) => { bodies.push(JSON.parse(init.body)); return say('好'); };
  const tools = { spawn_agent: async () => ({ ok: true }) };
  await runAgentTurn({ config: cfg(), roleMode: 'dev', tools, fetchImpl, messages: [{ role: 'user', content: '帮我在 tools/ 下写三个独立的数据脚本并各自跑通' }] });
  const msgs = bodies[0].messages;
  const at = msgs.findIndex((m) => m.content === DISPATCH_NOTE);
  assert.ok(at > 0, '要动手的任务应带本回合调度');
  assert.equal(msgs[at - 1].role, 'user', '调度提醒紧跟在用户消息后面');
  bodies.length = 0;
  await runAgentTurn({ config: cfg(), roleMode: 'dev', tools, fetchImpl, messages: [{ role: 'user', content: 'qlora 是什么？' }] });
  assert.ok(!bodies[0].messages.some((m) => m.content === DISPATCH_NOTE), '提问不带调度');
  bodies.length = 0;
  await runAgentTurn({ config: cfg(), roleMode: 'audit', tools, fetchImpl, messages: [{ role: 'user', content: '帮我写三个脚本' }] });
  assert.ok(!bodies[0].messages.some((m) => m.content === DISPATCH_NOTE), '审计轨不带');
});

test('一个人串行做了 8 次工具还没分工 → 提醒一次；派过子代理就不提', async () => {
  let n = 0;
  const bodies = [];
  const fetchImpl = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    n += 1;
    return n <= SOLO_NUDGE_CALLS + 1 ? calls([['read_file', { path: `f${n}.js` }]]) : say('完成');
  };
  const tools = { spawn_agent: async () => ({ ok: true }), read_file: async () => ({ ok: true, content: 'x' }) };
  await runAgentTurn({ config: cfg(), roleMode: 'dev', tools, fetchImpl, messages: [{ role: 'user', content: '帮我梳理这个项目的每个模块' }] });
  const last = bodies.at(-1).messages;
  const nudges = last.filter((m) => typeof m.content === 'string' && m.content.includes('还没有分工'));
  assert.equal(nudges.length, 1, '一回合只提醒一次');
});

test('run_command 标了 parallel:true 的同一次回复里同时跑；没标的照旧按顺序', async () => {
  const spans = [];
  const run = async (args) => { const t0 = Date.now(); await new Promise((r) => setTimeout(r, 150)); spans.push({ c: args.command, t0, t1: Date.now() }); return { ok: true, exitCode: 0, stdout: 'ok' }; };
  const once = async (list) => {
    spans.length = 0;
    let n = 0;
    const fetchImpl = async () => (++n === 1 ? calls(list) : say('好'));
    await runAgentTurn({ config: cfg(), roleMode: 'dev', tools: { run_command: run }, fetchImpl, messages: [{ role: 'user', content: '运行两个脚本' }] });
    return spans[0].t0 < spans[1].t1 && spans[1].t0 < spans[0].t1;
  };
  assert.equal(await once([['run_command', { command: 'python a.py', parallel: true }], ['run_command', { command: 'python b.py', parallel: true }]]), true, '标了 parallel 应同时跑');
  assert.equal(await once([['run_command', { command: 'mkdir x' }], ['run_command', { command: 'cd x && ls' }]]), false, '没标的按顺序');
});

test('background_task 一起等多个；等其中一个不会吞掉别的任务的完成通知', () => {
  const m = createBgTaskManager();
  const a = m.start({ sessionId: 's', kind: 'command', title: 'a' }).id;
  const b = m.start({ sessionId: 's', kind: 'command', title: 'b' }).id;
  m.finish(a, { status: 'done', exitCode: 0 });
  m.finish(b, { status: 'done', exitCode: 0 });
  const got = m.takeUndelivered('s', [a]);
  assert.deepEqual(got.map((x) => x.id), [a]);
  assert.equal(m.hasUndelivered('s'), true, 'b 的通知还在');
  assert.deepEqual(m.takeUndelivered('s').map((x) => x.id), [b]);
  const tools = src('main/agent-tools.mjs');
  assert.match(tools, /action === 'wait' && Array\.isArray\(a\.ids\)/);
  assert.match(tools, /takeUndelivered\(sessionId, \[id\]\)/);
});

test('显卡：解析 nvidia-smi、写进运行环境；没 N 卡说明用 CPU', () => {
  const info = parseGpuCsv('NVIDIA GeForce RTX 3080, 20480, 617.14\n');
  assert.deepEqual(info.gpus, [{ name: 'NVIDIA GeForce RTX 3080', memMiB: 20480 }]);
  assert.match(gpuLine(info), /RTX 3080（20GB 显存），CUDA 可用.*GPU 版本/);
  assert.match(gpuLine(null), /没检测到 NVIDIA 显卡/);
  assert.equal(parseGpuCsv(''), null);
  const note = runtimeEnvNote(new Date(2026, 10, 28), 'win32', info);
  assert.match(note, /星期六[\s\S]*显卡：NVIDIA GeForce RTX 3080/);
  assert.ok(!runtimeEnvNote(new Date(2026, 10, 28), 'win32').includes('显卡'), '没传就不写（兼容旧调用）');
  assert.match(src('main/ipc/ipc-agent.mjs'), /runtimeEnvNote\(new Date\(\), process\.platform, gpu\)/);
});

test('dev 提示词：分工法写成可照做的条目、显卡看运行环境', async () => {
  const dev = (await getSystemPromptParts('dev')).base;
  assert.match(dev, /分工提速/);
  assert.match(dev, /第一次回复就在同一次回复里调用多个 spawn_agent/);
  assert.match(dev, /只能一个人做，自己按顺序做，不要硬拆/);
  assert.match(dev, /看「运行环境」里的显卡信息/);
  assert.ok(dev.indexOf('先判断这条消息要的是什么') < dev.indexOf('分工提速'), '问还是做的判断仍然在最前');
});

test('手机打开会话：正文一字不动，工具输出 / 思考截短，界面要用的工具和最近几条原样', () => {
  const big = 'x'.repeat(5000);
  const sess = {
    id: 's', title: 't',
    messages: [
      { role: 'user', content: '问题' + big },
      { role: 'assistant', content: '回答', reasoning: big, trace: [
        { tool: 'run_command', args: { command: 'ls' }, result: { stdout: big } },
        { tool: 'todo_write', args: { items: [{ id: 1, text: big }] } }
      ] },
      ...Array.from({ length: 4 }, () => ({ role: 'assistant', content: 'c', reasoning: big, trace: [{ tool: 'read_file', result: big }] }))
    ]
  };
  const out = slimSessionForPhone(sess);
  assert.equal(out.messages[0].content, sess.messages[0].content, '正文不动');
  assert.ok(out.messages[1].trace[0].result.stdout.length < STR_MAX + 120);
  assert.match(out.messages[1].trace[0].result.stdout, /手机上省略/);
  assert.equal(out.messages[1].trace[1].args.items[0].text, big, '验收单原样');
  assert.ok(out.messages[1].reasoning.length < 1600);
  assert.equal(out.messages.at(-1).trace[0].result, big, '最近几条原样');
  assert.equal(sess.messages[1].trace[0].result.stdout, big, '不改原对象');
  const ma = src('main/mobile/mobile-access.mjs');
  assert.match(ma, /channel === 'finalcheck:sessions:open' \? async \(\) => slimSessionForPhone/);
  assert.match(ma, /zlib\.gzip\(buf, \{ level: 6 \}, \(err, gz\)/);
});

test('手机端：一次解析、打开会话有进度条、长会话只先画最近 30 条', () => {
  const br = src('mobile/bridge-electron.mjs');
  assert.match(br, /function parseWire\(text\)/);
  assert.ok(!/function decode\(/.test(br), '不再整树复制');
  assert.match(br, /SLOW_UI_CALLS = new Set\(\['finalcheck:sessions:open'/);
  assert.match(src('mobile/mobile.css'), /\.fc-mobile-busy/);
  const ml = src('renderer/components/MessageList.jsx');
  assert.match(ml, /PHONE_WINDOW = 30/);
  assert.match(ml, /if \(i < renderFrom\) return null;/);
});
