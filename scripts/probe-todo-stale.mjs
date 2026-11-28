// 0.34.6 验收单「搁置自动收起」真机自检（真 Electron + CDP）。
// 预置两条会话：
//   A（保留）：user → assistant(带 todo_write trace)              → 浮层应该在
//   B（收起）：user → assistant(带 todo_write trace) → user → assistant(已结束，无 todo)
//             → 浮层应该消失，且那条消息出现历史行（TodoHistoryRow）
// 步骤：开 A 断言浮层在 → 开 B 断言浮层不在 + data-testid="todo-history-row" 在。
// 另：预置一条带 label 的后台任务记录不是本探针范围（bgTasks 账本在主进程内存里，无法外部预置），
//     label 链路由 tests/v0346 源码钉 + 引擎单测覆盖。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'probe-todo-stale');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const PORT = 9347;

mkdirSync(out, { recursive: true });
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });

await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions', apiKey: 'test-key', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark'
}, null, 2), 'utf8');

const TODO_ARGS = JSON.stringify({ items: [
  { id: 't1', text: '后台子代理流 wx_知道.txt 为 SFT 语料', status: 'pending' },
  { id: 't2', text: '三路子代理调研 VLM', status: 'running' }
] });
const traceTodo = [{ tool: 'todo_write', args: TODO_ARGS, result: { ok: true } }];

process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
const sessionsLib = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const sKeep = await sessionsLib.newSession('验收单-保留');
await sessionsLib.appendUserMessage(sKeep.id, '大任务甲：整理数据目录');
await sessionsLib.appendAssistantMessage(sKeep.id, { role: 'assistant', content: '开始做。', trace: traceTodo });

const sStale = await sessionsLib.newSession('验收单-搁置');
await sessionsLib.appendUserMessage(sStale.id, '大任务乙：分析日志文件');
await sessionsLib.appendAssistantMessage(sStale.id, { role: 'assistant', content: '开始做。', trace: traceTodo });
await sessionsLib.appendUserMessage(sStale.id, 'python官方源是不是外网？');
await sessionsLib.appendAssistantMessage(sStale.id, { role: 'assistant', content: 'files.pythonhosted.org 是 PyPI 官方仓 CDN，在国外，国内直连会超时。（没碰清单）' });
console.log('[seed]', sKeep.id, sStale.id);

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [
  path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'
], {
  env: { ...env, FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'), FINALCHECK_DEFAULT_PROJECT: projectDir,
    FINALCHECK_SESSIONS_DIR: sessionsDir },
  stdio: 'ignore', windowsHide: false
});

let ws = null; let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};
const results = [];
const record = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 160)}`); };
const OUT = 'D:/rcw-geo/.fc-bench2/ui-check';
mkdirSync(OUT, { recursive: true });
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, name);
  await writeFile(p, Buffer.from(r.data, 'base64'));
  console.log(`[shot] ${p}`);
};
const clickSession = async (title) => ev(`(() => {
  // sidebar 行的 textContent 带尾巴（未读数/时间），不能精确等值匹配：
  // 取「包含标记且文本最短」的元素（最深的那层），再派发完整指针序列
  const rows = [...document.querySelectorAll('button, [role="button"], div, a')]
    .map((x) => ({ el: x, text: (x.textContent || '').trim() }))
    .filter((x) => x.text.includes(${JSON.stringify(title)}) && x.text.length < 60)
    .sort((a, b) => a.text.length - b.text.length);
  const el = rows[0]?.el;
  if (!el) return 0;
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + 5, clientY: r.y + 5 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.dispatchEvent(new MouseEvent('click', o));
  return 1;
})()`);

try {
  let page = null;
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools'));
      if (page) break;
    } catch { /* 还没起 */ }
  }
  if (!page) throw new Error('CDP 25s 内没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (!msg.id || !pending.has(msg.id)) return; const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error).slice(0, 200))) : res(msg.result); };

  for (let i = 0; i < 40; i++) { if (await ev("!!document.querySelector('textarea')").catch(() => false)) break; await sleep(500); }
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /跳过|Skip|稍后/i.test(x.textContent || '')); if (b) b.click(); })()`);
  await sleep(600);

  // A：浮层应该在（清单后没有用户消息 → 没被搁置）
  await clickSession('大任务甲');
  await sleep(1200);
  const keepState = await ev(`JSON.stringify({
    rows: document.querySelectorAll('[data-midx]').length,
    panel: !!document.querySelector('[data-testid="todo-panel-overlay"] [data-testid="todo-chip"], [data-testid="todo-panel-overlay"] [data-testid="todo-card"]'),
    history: document.querySelectorAll('[data-testid="todo-history"]').length
  })`);
  const k = JSON.parse(keepState);
  record('A 保留：验收单浮层在', k.panel === true, keepState);
  await shot('todo-stale-01-keep-panel.png');

  // B：浮层应该收起 + 该清单退回消息流历史行
  await clickSession('大任务乙');
  await sleep(1200);
  const staleState = await ev(`JSON.stringify({
    panel: !!document.querySelector('[data-testid="todo-panel-overlay"] [data-testid="todo-chip"], [data-testid="todo-panel-overlay"] [data-testid="todo-card"]'),
    history: document.querySelectorAll('[data-testid="todo-history"]').length
  })`);
  const s = JSON.parse(staleState);
  record('B 搁置：验收单浮层收起（芯片和整卡都不在）', s.panel === false, staleState);
  record('B 搁置：清单退回消息流历史行（≥1 条）', s.history >= 1, `history=${s.history}`);
  await shot('todo-stale-02-dismissed-history.png');
} catch (e) {
  record('FATAL ' + e.message, false, '');
} finally {
  try { child.kill(); } catch { /* 已退出 */ }
}
const pass = results.filter(Boolean).length;
console.log(`\n==== todo-stale selfcheck: ${pass}/${results.length} PASS ====`);
process.exit(pass === results.length ? 0 : 1);
