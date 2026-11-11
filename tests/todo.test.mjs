// 验收单（todo_write）：主 agent 专用工具 + 状态流转 + 历史还原 + 报告闸。
// 不调真模型：只测 schema 隔离 / 校验 / 台账 / tool part 还原 / lintTodoReport。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

process.env.FINALCHECK_SESSION_STORE = 'sqlite';
const root = await mkdtemp(path.join(os.tmpdir(), 'fc-todo-'));
process.env.FINALCHECK_SESSIONS_DIR = root;
const sessions = await import('../desktop/src/main/sessions.mjs');
const { createAgentTools } = await import('../desktop/src/main/agent-tools.mjs');
const { AGENT_TOOLS_SCHEMA, SUBAGENT_TOOLS_SCHEMA } = await import('../desktop/src/main/agent-service.mjs');
const { createTodoRegistry } = await import('../desktop/src/main/todo-list.mjs');
const {
  validateTodoItems, todoCardFromTrace, latestTodoEntry, todoProgress,
  todoCardSummary, todoCollapseKey, readTodoCollapsed, writeTodoCollapsed, TODO_COLLAPSE_PREFIX,
  displayStatus, todoFromMessage, latestTodoFromMessages, todoPanelAutoCollapsed, TODO_PANEL_MIN_WIDTH
} = await import('../desktop/src/renderer/lib/todo.mjs');
const { lintTodoReport } = await import('../desktop/src/main/swarm.mjs');
const { hasTranslation } = await import('../desktop/src/renderer/i18n/core.mjs');

after(async () => {
  sessions.closeAllSessionDatabases();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

const repoRoot = path.resolve(import.meta.dirname, '..');

async function freshDir(t, prefix = 'fc-todo-one-') {
  const dir = await mkdtemp(path.join(root, prefix));
  process.env.FINALCHECK_SESSIONS_DIR = dir;
  t.after(async () => {
    sessions.closeAllSessionDatabases();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

const items3 = () => [
  { id: 's1', task: '跑体检', acceptance: 'L2 三关都有 exit code', status: 'running' },
  { id: 's2', task: '读报告', acceptance: '列出全部高危项', status: 'pending' },
  { id: 's3', task: '写结论', acceptance: '每句结论带证据', status: 'pending' }
];

const report = (notCovered) => [
  '## Conclusion', '完工', '## Findings', 'None', '## Verified', 'None',
  '## Not covered', notCovered, '## Skipped', 'None'
].join('\n');

/* ---------- ① schema 隔离：主 agent 有、子代理没有 ---------- */
test('todo: todo_write 只在主 agent schema / 工具表，子代理没有', async () => {
  const agentNames = AGENT_TOOLS_SCHEMA.map((x) => x.function.name);
  assert.ok(agentNames.includes('todo_write'), '主 agent schema 必须有 todo_write');
  const subNames = SUBAGENT_TOOLS_SCHEMA.map((x) => x.function.name);
  assert.ok(!subNames.includes('todo_write'), '子代理 schema 不得有 todo_write');
  assert.equal(SUBAGENT_TOOLS_SCHEMA.length, 14, '子代理工具数不变（仍是 14 个）');

  const schema = AGENT_TOOLS_SCHEMA.find((x) => x.function.name === 'todo_write');
  const items = schema.function.parameters.properties.items;
  assert.equal(items.minItems, 3);
  assert.equal(items.maxItems, 8);
  assert.deepEqual(items.items.required, ['id', 'task', 'acceptance'], 'acceptance 在 schema 层就是必填');
  assert.deepEqual(
    schema.function.parameters.properties.items.items.properties.status.enum,
    ['pending', 'running', 'done', 'failed', 'skipped']
  );

  // 没注入 todoWrite（子代理/工作流 gate 的 createAgentTools）→ 工具表里没有
  const noTodo = createAgentTools({ repoRoot, permissions: { sessionAllowed: () => false } });
  assert.equal(typeof noTodo.todo_write, 'undefined');
  const withTodo = createAgentTools({
    repoRoot,
    permissions: { sessionAllowed: () => false },
    sessionId: 's-1',
    todoWrite: async (args, ctx) => ({ echo: args, sessionId: ctx?.sessionId ?? null })
  });
  assert.deepEqual(await withTodo.todo_write({ items: items3() }, {}), { echo: { items: items3() }, sessionId: 's-1' });
});

/* ---------- ② 参数校验：acceptance 必填 / 3-8 条 / id 稳定 ---------- */
test('todo: acceptance 缺失、条数越界、id 重复、status 非法都报错（提示模型补）', () => {
  const missingAcceptance = validateTodoItems(items3().map((it, i) => (i === 1 ? { id: it.id, task: it.task } : it)));
  assert.equal(missingAcceptance.ok, false);
  assert.match(missingAcceptance.error, /acceptance/);
  assert.match(missingAcceptance.error, /验收标准/, '错误文案要提示模型补验收标准');

  assert.match(validateTodoItems(items3().slice(0, 2)).error, /3-8/);
  assert.match(validateTodoItems(Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, task: 'x', acceptance: 'y' }))).error, /3-8/);
  assert.match(validateTodoItems('nope').error, /items 数组/);

  const dup = items3().map((it) => ({ ...it, id: 'same' }));
  assert.match(validateTodoItems(dup).error, /id 重复/);

  const badStatus = items3().map((it, i) => (i === 0 ? { ...it, status: 'finished' } : it));
  const bad = validateTodoItems(badStatus);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /status 非法/);
  assert.match(bad.error, /pending \/ running \/ done \/ failed \/ skipped/);

  // status 缺省 = pending（可选字段）
  const ok = validateTodoItems(items3().map(({ status, ...rest }) => rest));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.items.map((it) => it.status), ['pending', 'pending', 'pending']);
});

/* ---------- ③ 状态流转：多次调用按 id 合并，evidence 不被冲掉 ---------- */
test('todo: 状态流转 pending → running → done，evidence 合并保留；回合/会话隔离', async () => {
  const reg = createTodoRegistry();
  reg.beginTurn('s-1');

  const first = reg.write('s-1', { items: items3().map((it) => ({ ...it, status: 'pending' })) });
  assert.equal(first.ok, true);
  assert.deepEqual(todoProgress(first.items), { total: 3, done: 0, running: 0, pending: 3, failed: 0, skipped: 0 });

  const second = reg.write('s-1', { items: items3() }); // s1 → running
  assert.equal(second.items.find((it) => it.id === 's1').status, 'running');
  assert.equal(second.progress.running, 1);

  const third = reg.write('s-1', {
    items: items3().map((it) => (it.id === 's1' ? { ...it, status: 'done', evidence: 'src/a.mjs:12 实测 exit=0' } : it))
  });
  assert.equal(third.progress.done, 1);

  // 只改状态、不带 evidence：上一版证据要保留（否则模型每次都得重抄证据）
  const fourth = reg.write('s-1', { items: third.items.map((it) => it.id === 's1' ? { id: it.id, task: it.task, acceptance: it.acceptance, status: 'done' } : it) });
  assert.equal(fourth.items.find((it) => it.id === 's1').evidence, 'src/a.mjs:12 实测 exit=0');
  assert.equal(fourth.progress.done, 1);

  // 合并失败的一条
  const fifth = reg.write('s-1', { items: fourth.items.map((it) => it.id === 's2' ? { ...it, status: 'failed' } : it) });
  assert.equal(fifth.items.find((it) => it.id === 's2').status, 'failed');
  assert.equal(fifth.progress.failed, 1);

  // 校验失败不改台账
  assert.match(reg.write('s-1', { items: [{ id: 'x', task: 'y' }] }).error, /3-8|acceptance/);
  assert.equal(reg.list('s-1').length, 3);

  // 会话隔离 + 新回合清空
  assert.deepEqual(reg.list('s-2'), []);
  reg.beginTurn('s-1');
  assert.deepEqual(reg.list('s-1'), []);
});

/* ---------- ④ 历史还原：tool part → 卡片（含实时事件形状） ---------- */
test('todo: 历史回放从 tool part 还原验收单；实时事件只取最新一张', async (t) => {
  await freshDir(t);
  const s = await sessions.newSession('验收单落库');
  await sessions.appendUserMessage(s.id, '跑一轮验收');

  const firstArgs = JSON.stringify({ items: items3() });
  await sessions.appendToolStart(s.id, { callId: 'tc-todo-1', name: 'todo_write', args: firstArgs });
  await sessions.appendToolEnd(s.id, {
    callId: 'tc-todo-1', name: 'todo_write', status: 'ok',
    result: { ok: true, items: items3(), progress: todoProgress(items3()) }, error: null, ms: 8
  });
  const doneItems = items3().map((it) => it.id === 's1' ? { ...it, status: 'done', evidence: 'src/a.mjs:12' } : it);
  const secondArgs = JSON.stringify({ items: doneItems });
  await sessions.appendToolStart(s.id, { callId: 'tc-todo-2', name: 'todo_write', args: secondArgs });
  await sessions.appendToolEnd(s.id, {
    callId: 'tc-todo-2', name: 'todo_write', status: 'ok',
    result: { ok: true, items: doneItems, progress: todoProgress(doneItems) }, error: null, ms: 6
  });

  // 模拟重开 App
  sessions.closeAllSessionDatabases();
  const loaded = await sessions.loadSession(s.id);
  const assistant = loaded.messages.find((m) => m.role === 'assistant');
  const todoParts = assistant.trace.filter((x) => x.tool === 'todo_write');
  assert.equal(todoParts.length, 2, '两次调用各留一条 tool part（不改会话 schema）');

  const latest = latestTodoEntry(assistant.trace);
  const card = todoCardFromTrace(latest);
  assert.equal(card.error, null);
  assert.deepEqual(card.items.map((it) => it.status), ['done', 'pending', 'pending']);
  assert.equal(card.items[0].evidence, 'src/a.mjs:12');
  assert.equal(card.items[1].acceptance, '列出全部高危项');
  assert.equal(todoProgress(card.items).done, 1);

  // 实时事件形状（tool-start 只带 args，没有 result）
  const live = todoCardFromTrace({ type: 'tool', name: 'todo_write', args: secondArgs, status: 'running' });
  assert.deepEqual(live.items.map((it) => it.task), ['跑体检', '读报告', '写结论']);

  // 参数被截断 / 非法 JSON：卡片带错误提示，不抛错
  const broken = todoCardFromTrace({ name: 'todo_write', args: '{"items":[{"id":"s1"' });
  assert.deepEqual(broken.items, []);
  assert.match(broken.error, /JSON/);
  assert.equal(latestTodoEntry([{ name: 'run_command' }]), null);
});

/* ---------- ⑤ 报告闸：done 无证据 / failed·skipped 未点名 ---------- */
test('todo: 报告闸——done 必须有 evidence，failed/skipped 必须写进 ## Not covered', () => {
  const items = [
    { id: 's1', task: '跑体检', acceptance: '有 exit code', status: 'done', evidence: 'audit L2 exit=0' },
    { id: 's2', task: '动态探测', acceptance: '有 HTTP 复现', status: 'failed' },
    { id: 's3', task: '写结论', acceptance: '带证据', status: 'skipped' },
    { id: 's4', task: '读文档', acceptance: '读完', status: 'pending' }
  ];

  // 没有验收单：不判
  assert.deepEqual(lintTodoReport(report('None'), { items: [] }), []);

  // failed/skipped 已点名 + done 有证据：通过
  assert.deepEqual(lintTodoReport(report('- 动态探测（s2）：目标不可达\n- 写结论（s3）：上游失败，跳过'), { items }), []);

  // done 没证据：不合格
  const noEvidence = items.map((it) => it.id === 's1' ? { ...it, evidence: '' } : it);
  const w1 = lintTodoReport(report('- 动态探测（s2）\n- 写结论（s3）'), { items: noEvidence });
  assert.equal(w1.length, 1);
  assert.match(w1[0], /done/);
  assert.match(w1[0], /跑体检/);

  // failed/skipped 没点名：两条一起判
  const w2 = lintTodoReport(report('None'), { items });
  assert.equal(w2.length, 1);
  assert.match(w2[0], /Not covered/);
  assert.match(w2[0], /动态探测/);
  assert.match(w2[0], /写结论/);

  // 只点名了 id 也算（报告常用 id）
  assert.deepEqual(lintTodoReport(report('s2 失败、s3 跳过'), { items }), []);

  // pending/running 不参与闸（没做也不谎报）
  const onlyPending = items.map((it) => ({ ...it, status: 'pending' }));
  assert.deepEqual(lintTodoReport(report('None'), { items: onlyPending }), []);
});

/* ---------- ⑤b 展示态：回合结束后 running 不再转圈（变成「已中断」） ---------- */
test('todo: 展示态——回合仍在流式时 running 是「进行中」，停止/收尾后显示「已中断」且不改数据', () => {
  const running = { id: 'b', task: '读报告', acceptance: 'x', status: 'running' };

  const live = displayStatus(running, true);
  assert.equal(live.status, 'running');
  assert.equal(live.pulse, true, '真在跑才允许脉冲');
  assert.equal(live.label, '进行中');

  const dead = displayStatus(running, false);
  assert.equal(dead.status, 'interrupted', '回合已结束：running 展示为已中断，而不是永远转圈');
  assert.equal(dead.raw, 'running', '原始 status 必须保持 running（报告闸/历史语义不变）');
  assert.equal(dead.pulse, false, '已中断不能再脉冲');
  assert.equal(dead.label, '已中断');
  assert.equal(running.status, 'running', 'displayStatus 不能改入参');

  // 其它状态与 live 无关
  for (const s of ['pending', 'done', 'failed', 'skipped']) {
    assert.equal(displayStatus({ status: s }, false).status, s);
    assert.equal(displayStatus({ status: s }, false).pulse, false);
  }
  // 缺省/非法状态按 pending 展示，不抛错
  assert.equal(displayStatus(null, false).status, 'pending');
  assert.equal(displayStatus({}, true).status, 'pending');
});

/* ---------- ⑥ 卡片头部摘要：计数 / 百分比 / 首条任务 / 折叠单行文案 ---------- */
test('todo: 卡片摘要计数、百分比与折叠单行文案', () => {
  const items = [
    { id: 'a', task: '跑体检', acceptance: 'x', status: 'done' },
    { id: 'b', task: '读报告', acceptance: 'x', status: 'running' },
    { id: 'c', task: '写结论', acceptance: 'x', status: 'failed' },
    { id: 'd', task: '补文档', acceptance: 'x', status: 'skipped' }
  ];
  const s = todoCardSummary(items);
  assert.equal(s.total, 4);
  assert.equal(s.done, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.percent, 25);
  assert.equal(s.firstTask, '跑体检');
  assert.equal(s.label, '验收单 · 1/4', '折叠后一行要带计数');

  // 空清单不除零、不抛错
  assert.deepEqual(todoCardSummary([]), { done: 0, total: 0, failed: 0, skipped: 0, percent: 0, firstTask: '', label: '验收单 · 0/0' });
  assert.equal(todoCardSummary(null).total, 0);
  assert.equal(todoCardSummary([{ id: 'a', status: 'done' }]).firstTask, '', '没有 task 时不拿验收标准冒充概览');
  assert.equal(todoCardSummary([{ id: 'a', task: '一', status: 'done' }, { id: 'b', task: '二', status: 'done' }]).percent, 100);
});

/* ---------- ⑦ 折叠持久化：key 稳定（不含 status），存储不可用不抛错 ---------- */
test('todo: 整卡折叠状态按 session + 任务 id 存/读', () => {
  const before = [
    { id: 'a', task: '跑体检', acceptance: 'x', status: 'pending' },
    { id: 'b', task: '读报告', acceptance: 'x', status: 'pending' }
  ];
  const finished = before.map((it) => ({ ...it, status: 'done', evidence: 'e' }));

  const k1 = todoCollapseKey('sess-1', before);
  assert.ok(k1.startsWith(TODO_COLLAPSE_PREFIX));
  assert.equal(k1, todoCollapseKey('sess-1', finished), '状态变化不能换 key（否则折叠状态会丢）');
  assert.notEqual(k1, todoCollapseKey('sess-2', before), '不同会话要隔离');
  assert.notEqual(k1, todoCollapseKey('sess-1', [before[0]]), '不同任务签名要隔离');
  assert.match(todoCollapseKey(null, before), /a,b$/, '没有 sessionId 时退化为任务 id 签名');
  assert.equal(todoCollapseKey(null, []), `${TODO_COLLAPSE_PREFIX}default`);

  // 假的 localStorage：只实现 getItem/setItem
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.equal(readTodoCollapsed(k1, storage), false, '默认展开');
  assert.equal(writeTodoCollapsed(k1, true, storage), true);
  assert.equal(readTodoCollapsed(k1, storage), true);
  const again = todoCollapseKey('sess-1', finished);
  assert.equal(readTodoCollapsed(again, storage), true, '刷新后（同一签名）仍保持折叠');
  assert.equal(writeTodoCollapsed(k1, false, storage), true);
  assert.equal(readTodoCollapsed(k1, storage), false);

  // 隔离：别的 key 不受影响
  assert.equal(readTodoCollapsed(todoCollapseKey('sess-2', before), storage), false);

  // 存储缺失 / 抛错 / 空 key：一律当作未折叠，不阻塞渲染
  assert.equal(readTodoCollapsed(k1, null), false);
  assert.equal(writeTodoCollapsed(k1, true, null), false);
  assert.equal(readTodoCollapsed('', storage), false);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readTodoCollapsed(k1, broken), false);
  assert.equal(writeTodoCollapsed(k1, true, broken), false);
});

/* ---------- ⑦b 会话级取数：面板只显示最新一份 ---------- */
test('todo: 会话级只取最新一份验收单（流式读 events / 收尾读 trace / 跨回合常驻）', () => {
  const oldItems = items3();
  const oldMsg = {
    role: 'assistant', streaming: false,
    trace: [{ tool: 'todo_write', args: JSON.stringify({ items: oldItems }) }]
  };
  const liveItems = items3().map((it) => (
    it.id === 's1' ? { ...it, status: 'done', evidence: 'src/a.mjs:12' } : it
  ));
  const liveMsg = {
    role: 'assistant', streaming: true,
    events: [{ type: 'tool', name: 'todo_write', args: JSON.stringify({ items: liveItems }) }]
  };

  assert.equal(latestTodoFromMessages([]), null);
  assert.equal(latestTodoFromMessages(null), null);
  assert.equal(todoFromMessage({ role: 'user', content: 'hi' }), null, '用户消息里没有验收单');
  assert.equal(todoFromMessage(null), null);

  // 同一会话里后一段助手消息还没写清单：继续显示上一份（清单常驻，不闪没）
  const messages = [
    { role: 'user', content: '开始' },
    oldMsg,
    { role: 'assistant', content: '中间回复' },
    liveMsg,
    { role: 'assistant', streaming: true, content: '新回合还没写清单' }
  ];
  const latest = latestTodoFromMessages(messages);
  assert.equal(latest.index, 3, '指向真正带验收单的那条消息（消息流里靠这个下标去重）');
  assert.equal(latest.live, true);
  assert.deepEqual(latest.items.map((it) => it.status), ['done', 'pending', 'pending']);
  assert.equal(latest.items[0].evidence, 'src/a.mjs:12');

  // 收尾后走 trace：running 展示为已中断（live=false），数据不变
  const done = latestTodoFromMessages([oldMsg]);
  assert.equal(done.index, 0);
  assert.equal(done.live, false);
  assert.equal(done.error, null);
  assert.equal(done.items[0].status, 'running');

  // 参数坏了也要返回（面板显示错误，而不是整块消失）
  const broken = latestTodoFromMessages([{ role: 'assistant', trace: [{ tool: 'todo_write', args: '{bad' }] }]);
  assert.match(broken.error, /JSON/);
  assert.deepEqual(broken.items, []);

  // 消息里只有别的工具：没有验收单
  assert.equal(latestTodoFromMessages([{ role: 'assistant', trace: [{ tool: 'run_command', args: '{}' }] }]), null);
});

/* ---------- ⑦c 面板窄屏自动折叠：右侧子代理/产物面板打开时只留一行 ---------- */
test('todo: 面板自动折叠阈值——会话列变窄就折叠，首帧未测量按展开', () => {
  assert.equal(TODO_PANEL_MIN_WIDTH, 840);
  assert.equal(todoPanelAutoCollapsed(0), false, '首帧 clientWidth=0 不能先折叠再展开（闪一下）');
  assert.equal(todoPanelAutoCollapsed(NaN), false);
  assert.equal(todoPanelAutoCollapsed(-1), false);
  assert.equal(todoPanelAutoCollapsed(undefined), false);

  assert.equal(todoPanelAutoCollapsed(TODO_PANEL_MIN_WIDTH - 1), true);
  assert.equal(todoPanelAutoCollapsed(TODO_PANEL_MIN_WIDTH), false);
  assert.equal(todoPanelAutoCollapsed('1200'), false);

  // 实际窗口：1440 宽 - 侧栏 260 = 1180（展开）；右侧子代理 620 打开 → 560（折叠）
  assert.equal(todoPanelAutoCollapsed(1180), false);
  assert.equal(todoPanelAutoCollapsed(560), true);
});

/* ---------- ⑦d 渲染形态：消息流不再内联最新卡，面板在滚动容器外 ---------- */
test('todo: 消息流不再内联渲染最新卡，面板钉在滚动容器外，历史只留一行摘要', () => {
  const dir = path.join(repoRoot, 'desktop', 'src', 'renderer', 'components');
  const messageList = readFileSync(path.join(dir, 'MessageList.jsx'), 'utf8');
  const todoCard = readFileSync(path.join(dir, 'TodoCard.jsx'), 'utf8');

  assert.equal(/<TodoBlock\b/.test(messageList), false, '旧的内联整卡不能再出现在消息流里');
  assert.match(messageList, /latestTodo\?\.index === i \? null : <TodoHistoryRow/, '最新一份由面板渲染，消息流里跳过');
  assert.match(messageList, /data-testid="todo-panel-dock"/);
  assert.match(messageList, /data-testid="message-scroll"/);

  // 面板必须是滚动容器的兄弟：scroll 容器闭合后才轮到 aside（不随滚动走）
  const scrollAt = messageList.indexOf('data-testid="message-scroll"');
  const dockAt = messageList.indexOf('data-testid="todo-panel-dock"');
  assert.ok(dockAt > scrollAt, '面板要排在滚动容器之后（兄弟节点）');

  assert.match(todoCard, /export function TodoPanel/);
  assert.match(todoCard, /export function TodoHistoryRow/);
  assert.equal(/export function TodoBlock/.test(todoCard), false, '旧 TodoBlock 导出应删除');
  assert.match(todoCard, /motion-reduce:animate-none/, 'prefers-reduced-motion 下不启用动画');
});

/* ---------- ⑧ i18n：新增文案都有英文 key ---------- */
test('todo: 新增文案有英文译文', () => {
  const keys = [
    '验收单', '{done}/{total} 完成', '验收：{acceptance}', '证据：{evidence}',
    '进度', '展开验收单', '收起验收单', '已中断',
    '报告不合格（验收单闸）',
    '任务 {id} 缺少 acceptance（验收标准）：先想清楚「怎么算完成」再调用 todo_write，把验收标准补上',
    '验收单里有 {n} 条标为 done 但没有证据：{labels}（先补 evidence 再交报告）',
    '验收单里失败/跳过的任务未在 ## Not covered 点名：{labels}（缺一个即判不合格）',
    '验收单面板', '本轮验收单 {done}/{total}', '窗口较窄，验收单自动折叠为一行'
  ];
  for (const k of keys) assert.equal(hasTranslation(k), true, `缺少英文译文：${k}`);
});
