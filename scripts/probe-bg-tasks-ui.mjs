// 0.33.5 后台任务真界面验收（真 Electron + 本地模拟网关，隔离 profile，窗口在后台不抢前台）：
//   用户发「后台跑脚本 + 后台调研」→ 主回合立刻结束（命令转后台、子代理后台派出）
//   → 右上角出现「后台 N」胶囊，展开能看到两条任务 → 任务结束后界面**自动起一轮**，模型收到【后台任务完成】
//   → 胶囊变成「已结束」。截图：.tmp/bg-tasks-ui/*.png
// 用法：cd desktop && npx electron-vite build；然后 node scripts/probe-bg-tasks-ui.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway } from './sim/gateway.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'bg-tasks-ui');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const PORT = 9365;

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(path.join(projectDir, 'src'), { recursive: true });
await writeFile(path.join(projectDir, 'src', 'foo.js'), 'export const foo = 1;\n', 'utf8');

const mainSeen = [];
const gw = await startGateway({
  mode: 'script',
  respond: async (body, { kind }) => {
    const msgs = body.messages;
    const last = msgs[msgs.length - 1];
    if (kind === 'subagent') {
      if (last.role === 'tool') return { delayMs: 2500, content: '子代理报告：src/foo.js 第 1 行定义了 foo，没有别的调用。' };
      return { toolCalls: [{ name: 'list_dir', args: {} }] };
    }
    if (kind !== 'main') return null;
    const users = msgs.filter((m) => m.role === 'user').map((m) => String(m.content));
    mainSeen.push(users.slice(-3));
    const notice = users.filter((u) => u.startsWith('【后台任务完成】'));
    if (notice.length && last.role === 'user') return { content: `后台结果到了（${notice.length} 条）：脚本输出 BG-UI-OK，子代理确认 foo 只定义在 src/foo.js。` };
    if (last.role === 'tool') { writeFileSync(path.join(out, 'tool-results.json'), JSON.stringify(msgs.filter((m) => m.role === 'tool').map((m) => String(m.content).slice(0, 400)), null, 2)); }
    if (last.role === 'tool') return { content: '脚本和调研都放到后台了，你可以先问别的；有结果我会自动接着说。' };
    if (users.at(-1)?.includes('后台')) {
      return { toolCalls: [
        { name: 'run_command', args: { command: 'node -e "setTimeout(()=>console.log(\'BG-UI-OK\'),6000)"', yield_ms: 800 } },
        { name: 'spawn_agent', args: { description: '查 foo 的调用', prompt: '找出 foo 在哪里定义、哪里调用', background: true } },
        // 0.33.7：常驻服务（background:true）——以前展开是 (no output)，现在要看到真实输出（带颜色码、持续打印）
        { name: 'run_command', args: { command: 'node -e "let i=0;const e=String.fromCharCode(27);console.log(e+\'[32mVITE\'+e+\'[0m ready in 312 ms\');console.log(\'  Local: http://localhost:5173/\');setInterval(()=>console.log(\'hmr update /src/App.jsx #\'+(++i)),700)"', background: true } },
        // 0.33.7：秒退报错的服务——失败 + 退出码 + 报错原文
        { name: 'run_command', args: { command: 'node -e "console.error(\'Error: listen EADDRINUSE: address already in use :::3000\');process.exit(1)"', background: true } }
      ] };
    }
    return { content: '好的。' };
  }
});

writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: gw.url, apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true }],
  activeProviderId: 'p-ui', activeModel: 'ui-model', language: 'zh', theme: 'dark', permissionMode: 'full'
}, null, 2), 'utf8');

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'], {
  env: {
    ...env, FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_WINDOW_BG: '1',
    FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
    FINALCHECK_HOOKS_FILE: path.join(userData, 'hooks.json'),
    FINALCHECK_SESSIONS_DIR: path.join(projectDir, '.finalcheck', 'sessions'),
    FINALCHECK_DEFAULT_PROJECT: projectDir
  },
  stdio: 'ignore', windowsHide: true
});

let ws = null; let seq = 0;
const pending = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + m)); } }, 60000);
});
const ev = async (x) => {
  const r = await cdp('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r?.result?.value;
};
const shot = async (name) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64')); };
const results = [];
const record = (n, ok, d) => { results.push({ n, ok, d: String(d ?? '').slice(0, 500) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${String(d ?? '').slice(0, 260)}`); };
const waitFor = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(250); } return false; };

try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((tg) => tg.type === 'page' && !String(tg.url).startsWith('devtools')); } catch { /* 等 */ }
  }
  if (!page) throw new Error('CDP 没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); setTimeout(() => j(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const g = JSON.parse(m.data); if (!g.id || !pending.has(g.id)) return; const p = pending.get(g.id); pending.delete(g.id); if (g.error) p.rej(new Error(JSON.stringify(g.error))); else p.res(g.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);

  // 发消息（和用户在输入框里打字回车一样）
  await ev(`(async () => {
    const ta = document.querySelector('textarea'); ta.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '后台跑一下脚本，顺便后台调研 foo 在哪调用'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  const t0 = Date.now();
  const turn1 = await waitFor(`document.body.innerText.includes('都放到后台了')`, 20000);
  record('U1 主回合不等后台任务，立刻答复', turn1 && Date.now() - t0 < 6000, `${Date.now() - t0}ms`);
  const chip = await waitFor(`!!document.querySelector('[data-testid="bg-tasks-chip"]')`, 5000);
  const chipText = await ev(`document.querySelector('[data-testid="bg-tasks-chip"]')?.textContent || ''`);
  record('U2 右上角出现后台任务胶囊（运行中）', chip && /后台\s*[234]/.test(chipText), chipText);
  await shot('1-chip-running.png');
  await ev(`document.querySelector('[data-testid="bg-tasks-chip"]').click()`);
  await sleep(500);
  const rows = await ev(`[...document.querySelectorAll('[data-testid="bg-task-row"]')].map((r) => r.dataset.kind + ':' + r.dataset.status)`);
  record('U3 展开后：命令 + 子代理都在', Array.isArray(rows) && rows.includes('command:running') && rows.includes('agent:running'), JSON.stringify(rows));
  // 0.33.7：每条命令都点开（第一条默认就开着），看终端小窗口
  await ev(`[...document.querySelectorAll('[data-testid="bg-task-row"]')].filter((r) => r.dataset.kind === 'command').forEach((r) => { const b = r.querySelector('button[aria-expanded]'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); })`);
  // 等常驻服务打出几行
  const served = await waitFor(`[...document.querySelectorAll('[data-testid="bg-task-terminal"]')].some((x) => /hmr update \\/src\\/App\\.jsx #3/.test(x.innerText))`, 15000);
  const termInfo = await ev(`[...document.querySelectorAll('[data-testid="bg-task-terminal"]')].map((x) => x.innerText.slice(0, 400))`);
  record('V1 常驻服务展开是真实终端输出（$ 命令 + VITE ready + 持续 hmr 行，颜色码已去掉），不是 (no output)',
    served && termInfo.some((x) => /\$ node -e/.test(x) && /\nVITE ready in 312 ms\n/.test(x)) && !termInfo.some((x) => /no output/i.test(x)), JSON.stringify(termInfo).slice(0, 400));
  const failRow = await waitFor(`[...document.querySelectorAll('[data-testid="bg-task-row"]')].some((r) => r.dataset.status === 'failed' && /失败 · 退出码 1/.test(r.innerText) && /EADDRINUSE/.test(r.innerText))`, 10000);
  record('V2 秒退的服务：失败 · 退出码 1，终端里看得到报错原文', failRow, '');
  await shot('2-panel-expanded.png');
  // 用户在面板上停掉常驻服务 → 「已中断（你）」，和「已完成」分开
  await ev(`(() => { const r = [...document.querySelectorAll('[data-testid="bg-task-row"]')].find((x) => /VITE/.test(x.innerText) && x.dataset.status === 'running'); r?.querySelector('[data-testid="bg-task-stop"]')?.click(); })()`);
  const stopped = await waitFor(`[...document.querySelectorAll('[data-testid="bg-task-row"]')].some((r) => r.dataset.status === 'stopped' && /已中断（你）/.test(r.innerText) && /── 已中断（你）/.test(r.innerText))`, 10000);
  record('V3 停掉的显示「已中断（你）」，终端末行也写着中断，不再是 stopped', stopped, '');
  await shot('2b-stopped.png');

  // 等两条都结束 → 界面自动起一轮（不需要用户再发消息）
  // 子代理（约 3s）和脚本（约 6s）先后结束：每结束一个，界面空闲时就自动续跑一轮
  const auto = await waitFor(`document.body.innerText.includes('后台结果到了')`, 30000);
  const hasCmd = () => mainSeen.some((u) => u.some((x) => x.startsWith('【后台任务完成】') && /BG-UI-OK/.test(x)));
  for (let i = 0; i < 120 && !hasCmd(); i++) await sleep(250);
  const injected = hasCmd();
  record('U4 任务结束后自动续跑一轮，模型拿到了命令输出', auto && injected, JSON.stringify(mainSeen.at(-1)).slice(0, 300));
  const agentInjected = mainSeen.some((u) => u.some((x) => /子代理「查 foo 的调用」/.test(x)));
  record('U5 子代理报告也送到了模型', agentInjected, '');
  await sleep(800);
  const chipDone = await ev(`document.querySelector('[data-testid="bg-tasks-chip"]')?.textContent || ''`);
  record('U6 胶囊变成「已结束」', /已结束/.test(chipDone), chipDone);
  await shot('3-auto-continued.png');
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ results, mainSeen }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 后台任务真界面验收 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  try { await shot('fatal.png'); } catch { /* 忽略 */ }
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { await gw.close(); } catch { /* 已关 */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
