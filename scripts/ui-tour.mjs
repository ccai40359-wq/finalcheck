// UI 巡检截图：完全隔离地起一个 Electron（独立 userData / 项目 / 会话 / CDP 端口），
// 依次截「空态 / / 技能菜单 / 对话（深+浅）/ 设置页」，用于视觉改版前后对比。
//
// 用法：先 `npm --prefix desktop run build`，再 `node scripts/ui-tour.mjs [标签]`
// 证据：.tmp/ui-tour/<标签>/*.png
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const label = process.argv[2] || 'now';
const base = path.join(root, '.tmp', 'ui-tour');
const out = path.join(base, label);
const userData = path.join(base, 'user-data');
const projectDir = path.join(base, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const projectsFile = path.join(userData, 'projects.json');
const PORT = 9335;

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'UI Test', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions',
    apiKey: 'test-key', models: [{ id: 'deepseek-v4.1-flash', contextWindow: 200000 }], enabled: true }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark',
  // 权限规则设置页截图用
  permissionRules: { allow: ['run_command(npm test:*)', 'run_command(git status)', 'edit_file(src/**)'], deny: ['run_command(git push*)', 'read_file(**/.env)'] },
  // MCP 设置页截图用：一个能连上的测试服务器 + 一个配置有误的
  mcpServers: {
    fixture: { command: process.execPath, args: [path.join(root, 'tests/fixtures/mcp-fixture-server.mjs')] },
    legacy: { type: 'sse', url: 'https://example.com/sse' }
  }
}, null, 2), 'utf8');

process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
process.env.FINALCHECK_PROJECTS_FILE = projectsFile;
process.env.FINALCHECK_DEFAULT_PROJECT = projectDir;
const sessions = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const projects = await import(pathToFileURL(path.join(root, 'desktop/src/main/projects.mjs')).href);
await projects.ensureDefaultProject();
for (const name of ['rcw-geo', 'fastapi', 'ai-crawler-hk', 'BUtesting']) {
  const dir = path.join(base, 'extra', name);
  await mkdir(path.join(dir, '.finalcheck', 'sessions'), { recursive: true });
  await projects.addProject(dir, { name }).catch(() => {});
}

const MD = [
  '我看了两个文件，结论先说：**v1.0.1 是一个更通用的工具开发规划**，而 **v2.0 更像一套 Agent 工作流**。',
  '', '## 一、整体定位差异', '',
  '| 维度 | v1.0.1 | v2.0 |', '| --- | --- | --- |',
  '| 定位 | 通用工具规划 | Agent 工作流 |', '| 数据来源 | `config.json` | 实时网关 |', '| 风险 | 低 | 中，需要审批 |', '',
  '### 关键差异', '',
  '1. **入口不同**：v1 从命令行进，v2 从对话进。', '2. 工具链：v2 新增了 `run_workflow`。', '3. 详见 [变更说明](https://example.com/changelog)。', '',
  '> 注意：v2 的定时唤醒会在无人值守时执行工具。', '',
  '```js', 'export function pick(a, b) {', '  return a.score >= b.score ? a : b;', '}', '```'
].join('\n');
const titles = ['打开小红书', '对比两个规划文档', '修复登录页闪退', '整理 CHANGELOG', '跑一遍 L2 体检', '分析网课进度'];
let mainSid = '';
for (const [i, title] of titles.entries()) {
  const s = await sessions.newSession(title);
  await sessions.appendUserMessage(s.id, i === 1 ? '帮我对比一下 v1.0.1 和 v2.0 两个规划文档，有什么差异？' : title);
  await sessions.appendAssistantMessage(s.id, {
    role: 'assistant', content: i === 1 ? MD : '好的，已处理。',
    reasoning: i === 1 ? '用户想要对比两个版本的规划文档。我先读两个文件，再按定位、数据来源、风险三个维度整理。' : '',
    trace: i === 1 ? [
      { tool: 'read_file', args: { path: 'docs/plan-v1.0.1.md' }, result: { content: '...' } },
      { tool: 'read_file', args: { path: 'docs/plan-v2.0.md' }, result: { content: '...' } },
      { tool: 'run_command', args: { command: 'npm test' }, result: { stdout: 'ok', exitCode: 0 } }
    ] : []
  });
  await sessions.renameSession(s.id, title);
  if (i === 1) mainSid = s.id;
}
void mainSid;

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [
  path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'
], {
  env: { ...env, FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: projectsFile, FINALCHECK_DEFAULT_PROJECT: projectDir, FINALCHECK_SESSIONS_DIR: sessionsDir },
  stdio: 'ignore', windowsHide: false
});

let ws = null; let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(out, name);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('[shot]', file);
};
const setTheme = (theme) => ev(`(() => { try { localStorage.setItem('fc.theme', '${theme}'); } catch {} document.documentElement.dataset.theme = '${theme}'; document.documentElement.style.colorScheme = '${theme}'; })()`);
const clickTitle = (prefix) => ev(`(async () => {
  const row = [...document.querySelectorAll('[title]')].find((x) => (x.getAttribute('title') || '').startsWith(${JSON.stringify(prefix)}) && x.offsetParent !== null);
  if (!row) return false; row.click(); await new Promise((r) => setTimeout(r, 1500)); return true; })()`);
const clickText = (text) => ev(`(async () => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(text)} && x.offsetParent !== null);
  if (!b) return false; b.click(); await new Promise((r) => setTimeout(r, 1200)); return true; })()`);

try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && !String(t.url).startsWith('devtools')); } catch { /* 未起 */ }
  }
  if (!page) throw new Error('CDP 30s 内没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);
  await setTheme('dark');

  // ① 对话
  if (!(await clickTitle('对比两个规划文档'))) throw new Error('找不到预置会话');
  await sleep(600);
  await shot('1-chat-dark.png');
  await setTheme('light'); await sleep(500);
  await shot('2-chat-light.png');
  await setTheme('dark'); await sleep(400);

  // ② 空态（New Session）
  await clickText('New Session');
  await sleep(900);
  await shot('3-empty-dark.png');

  // ③ / 技能菜单
  await ev(`(async () => {
    const ta = document.querySelector('textarea'); if (!ta) return false; ta.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '/'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 600)); return true; })()`);
  await shot('4-slash-dark.png');
  await ev(`(() => { const ta = document.querySelector('textarea'); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(400);

  // ④ 设置页
  await clickText('Settings');
  await sleep(1200);
  await shot('5-settings-dark.png');
  await setTheme('light'); await sleep(500);
  await shot('6-settings-light.png');

  // ⑤ MCP 服务器设置页（0.33.0）
  await setTheme('dark'); await sleep(300);
  await clickText('MCP 服务器');
  await sleep(2500);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /个工具/.test(x.textContent || '')); b?.click(); })()`);
  await sleep(500);
  await shot('7-mcp-dark.png');
  await setTheme('light'); await sleep(500);
  await shot('8-mcp-light.png');

  // ⑥ 权限规则设置页（0.33.0）：「试一下」填一条复合命令，看判定
  await setTheme('dark'); await sleep(300);
  await clickText('权限规则');
  await sleep(1200);
  await ev(`(() => {
    const inp = [...document.querySelectorAll('input')].find((x) => /git status/.test(x.placeholder || ''));
    if (!inp) return;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(inp, 'git status && git push origin main');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(800);
  await shot('9-rules-dark.png');
  await setTheme('light'); await sleep(500);
  await shot('10-rules-light.png');
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { child.kill(); } catch { /* 忽略 */ }
}
