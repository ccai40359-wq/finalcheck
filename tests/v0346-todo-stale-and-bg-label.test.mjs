// 0.34.6 两条 UI 行为的回归钉：
//   ① 验收单被 AI 搁置后浮层自动收起（用户实测：AI 早就转去干别的，清单一直挂在右上角）
//      —— latestTodoFromMessages 的「搁置」判定：清单最后一次更新之后，存在一条用户消息
//        + 一条已结束的助手回复（非流式），且没有更新清单 → 返回 null（退回消息流历史行）。
//      —— AI 写了新清单（下标前移）→ 浮层自动重新点亮；正在流式的回合不收。
//   ② 转后台的命令必须写明目的（用户：「所有的东西都要有目的」）
//      —— run_command 新增 label 参数；登记后台任务时 title 用 label（面板/完成通知都显示），
//        没传 label 退回原始命令（老会话行为不变）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestTodoFromMessages, todoFromMessage } from '../desktop/src/renderer/lib/todo.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(repoRoot, p), 'utf8');
const appService = read('desktop/src/main/agent-service.mjs');
const agentTools = read('desktop/src/main/agent-tools.mjs');

const todoMsg = (text, index = 'it-1', streaming = false) => ({
  role: 'assistant', streaming,
  events: [{ type: 'tool', name: 'todo_write', args: JSON.stringify({ items: [{ id: index, text, status: 'pending' }] }) }]
});

// ---------- ① 验收单搁置自动收起 ----------

test('搁置：清单之后 AI 完整回答了一轮却没更新它 → 浮层收起（返回 null）', () => {
  const messages = [
    { role: 'user', content: '做一个大任务' },
    todoMsg('拆解任务'),
    { role: 'user', content: 'python官方源是不是外网的？' },
    { role: 'assistant', content: '是国内镜像…（已结束，没碰清单）' }
  ];
  assert.equal(latestTodoFromMessages(messages), null, 'AI 已搁置 → 浮层自动收起');
  assert.ok(todoFromMessage(messages[1]), '清单数据还在消息里（历史行照常渲染）');
});

test('没搁置：清单之后 AI 还在流式回答当前回合 → 浮层保留', () => {
  const messages = [
    { role: 'user', content: '做一个大任务' },
    todoMsg('拆解任务'),
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '正在做…', streaming: true }
  ];
  const r = latestTodoFromMessages(messages);
  assert.ok(r, '当前回合还没结束，不收');
  assert.equal(r.index, 1);
});

test('没搁置：清单之后只有用户消息、AI 还没回答 → 浮层保留', () => {
  const messages = [
    { role: 'user', content: '做一个大任务' },
    todoMsg('拆解任务'),
    { role: 'user', content: '继续' }
  ];
  assert.ok(latestTodoFromMessages(messages), '回合还没开始回答，不收');
});

test('重新点亮：AI 之后写了新清单 → 浮层显示新清单（下标前移）', () => {
  const messages = [
    { role: 'user', content: '做一个大任务' },
    todoMsg('旧清单', 'it-old'),
    { role: 'user', content: 'python 官方源是不是外网？' },
    { role: 'assistant', content: '是 CDN…（没碰清单）' },
    { role: 'user', content: '回到大任务' },
    todoMsg('新清单', 'it-new')
  ];
  const r = latestTodoFromMessages(messages);
  assert.ok(r, '有新清单 → 重新点亮');
  assert.equal(r.index, 5);
  assert.equal(r.items[0].id, 'it-new', '显示的是新清单（不是旧的那份）');
});

test('Steer 注入不算新的一轮：清单更新后同回合被 steer + 回复完成 → 浮层保留', () => {
  const messages = [
    { role: 'user', content: '做一个大任务' },
    { role: 'assistant', streaming: true, events: [{ type: 'tool', name: 'todo_write', args: JSON.stringify({ items: [{ id: 'a', text: '步骤', status: 'running' }] }) }] },
    { role: 'user', steer: true, content: '顺便把日志也看看' },
    { role: 'assistant', content: '同回合收尾，没再写清单' }
  ];
  assert.ok(latestTodoFromMessages(messages), '同一回合内的 steer + 收尾不算搁置');
});

test('中断的回复也算「已结束的一轮」：AI 被打断后没更新清单 → 收起', () => {
  const messages = [
    { role: 'user', content: '做一个大任务' },
    todoMsg('拆解任务'),
    { role: 'user', content: '等等，先回答我这个' },
    { role: 'assistant', content: '好的…', interrupted: true }
  ];
  assert.equal(latestTodoFromMessages(messages), null, '回合结束了（哪怕是被打断）且没碰清单');
});

// ---------- ② 后台命令必须写明目的 ----------

test('run_command schema 有 label 参数，描述写明「转后台必须传」', () => {
  const at = appService.indexOf("name: 'run_command'");
  assert.ok(at >= 0, 'run_command schema 被改名或删掉了');
  const schema = appService.slice(at, at + 6000);
  assert.match(schema, /label: \{ type: 'string', maxLength: 80/, 'label 参数必须存在');
  assert.match(schema, /必须传 label/, '描述里必须写明转后台必须传 label');
  assert.match(schema, /后台任务面板和完成通知都靠它/, '说明 label 的用途（面板+完成通知）');
});

test('登记后台任务时 title 用 label，没传退回原始命令', () => {
  assert.match(agentTools, /const bgLabel = String\(args\?\.label \|\| ''\)\.trim\(\)/, 'label 从 args 读取并归一化');
  assert.match(agentTools, /title: bgLabel \|\| cmd\.replace\(\/\\s\+\/g, ' '\)\.slice\(0, 160\)/, 'title 优先 label，缺省退回原始命令（老行为不变）');
  assert.ok(agentTools.indexOf('const bgLabel') < agentTools.indexOf('bgTasks.start'),
    'bgLabel 必须在 bgTasks.start 之前算好');
});

test('压缩双摘要修复：回合开头已压缩过，atTurnStart 分支不再重复压', () => {
  const appSvc = read('desktop/src/main/agent-service.mjs');
  assert.match(appSvc, /let turnStartCompacted = false;/, '旗标必须存在');
  assert.match(appSvc, /turnStartCompacted = true; \/\/ 边界已落库/, 'site1 落库边界后置位');
  assert.match(appSvc, /if \(atTurnStart && turnStartCompacted\) return \{ ok: false \};/,
    'atTurnStart 分支必须被旗标挡住（否则边界带的重读现场会被二次摘要——0.34.5 起必现的双摘要）');
  // 顺序：置位（site1）必须先于检查（compactInTurn）
  assert.ok(appSvc.indexOf('turnStartCompacted = true;') < appSvc.indexOf('if (atTurnStart && turnStartCompacted)'),
    'site1 置位在 compactInTurn 检查之前');
});

test('打字回显提速：MessageList memo + App 侧 latest-ref 回调 + 派生数组 memo', () => {
  const app = read('desktop/src/renderer/App.jsx');
  const ml = read('desktop/src/renderer/components/MessageList.jsx');
  assert.match(ml, /export default React\.memo\(MessageList\);/, 'MessageList 必须 memo（键击不再重调和整棵消息树）');
  assert.match(app, /const msgApiRef = useRef\(null\);/, 'latest-ref 必须存在');
  assert.match(app, /onSendRecover=\{msgApi\.onSendRecover\}/, 'MessageList 必须用稳定的 msgApi 回调');
  assert.match(app, /const activeAskCards = useMemo\(/, 'askCards 过滤必须 memo（每键 O(N) 的源头之一）');
  assert.match(app, /const chatMessages = useMemo\(/, 'chatMessages 必须 memo');
  assert.match(app, /const providers = useMemo\(/, 'providers 必须 memo（内联 filter 的新引用会打穿 memo）');
});

test('效率策略：dev 轨提示词强制「并行 + 后台」子代理用法', () => {
  const appSvc = read('desktop/src/main/agent-service.mjs');
  assert.match(appSvc, /子代理能并行就并行、能后台就后台/, 'dev 轨必须有激进的并行后台策略行');
  assert.match(appSvc, /background:true 派到后台/, '长活直接派后台');
  assert.match(appSvc, /每会话最多 10 个/, '并发上限写进提示词');
  // 钉住策略行在 SYSTEM_DEV_BASE 里（audit 轨保持自己的纪律不动）
  const dev = appService.slice(appService.indexOf('const SYSTEM_DEV_BASE = ['), appService.indexOf('const SYSTEM_DEV_BASE = [') + 6000);
  assert.match(dev, /子代理能并行就并行、能后台就后台/, '策略行必须在 dev 轨提示词里');
});

test('后台并发上限提到 10（多子代理同时跑）', () => {
  const bg = read('desktop/src/main/bg-tasks.mjs');
  assert.match(bg, /export const BG_MAX_RUNNING = 10;/, '并发上限 10');
});
