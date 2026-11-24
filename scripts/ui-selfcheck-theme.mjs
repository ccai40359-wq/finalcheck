// 0.32.8 主题视觉自检：起一个**完全隔离**的 Electron（独立 userData / 项目 / 会话目录 / CDP 端口），
// 预置一条「富 markdown + 思考 + 工具调用」的会话，分别截深色 / 浅色两张图，并读出关键元素的计算样式。
//
// 为什么要读计算样式：截图只能人眼看，样式数值可以断言——
//   深色下正文 / 加粗 / 标题 / 行内代码 / 表头都不应再是金色（旧版「满屏金字」的根因）。
//
// 用法：先 `npm --prefix desktop run build`，再 `node scripts/ui-selfcheck-theme.mjs`
// 证据：.tmp/theme-selfcheck/{dark,light}.png
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'theme-selfcheck');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const projectsFile = path.join(userData, 'projects.json');
const PORT = 9334; // 不与 9223/9224/9331/9332 冲突
const TITLE = '主题自检会话';

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'UI Test', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions',
    apiKey: 'test-key', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark'
}, null, 2), 'utf8');

process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
process.env.FINALCHECK_PROJECTS_FILE = projectsFile;
process.env.FINALCHECK_DEFAULT_PROJECT = projectDir;
const sessions = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);

const MD = [
  '我看了你要求的两个文件，结论先说：**v1.0.1 是一个更通用的工具开发规划**，而 **v2.0 更像一套 Agent 工作流**。',
  '',
  '## 一、整体定位差异',
  '',
  '| 维度 | v1.0.1 | v2.0 |',
  '| --- | --- | --- |',
  '| 定位 | 通用工具规划 | Agent 工作流 |',
  '| 数据来源 | `config.json` | 实时网关 |',
  '| 风险 | 低 | 中，需要审批 |',
  '',
  '### 关键差异',
  '',
  '1. **入口不同**：v1 从命令行进，v2 从对话进。',
  '2. 工具链：v2 新增了 `run_workflow` 与 `present_artifact`。',
  '3. 详见 [变更说明](https://example.com/changelog)。',
  '',
  '> 注意：v2 的定时唤醒会在无人值守时执行工具。',
  '',
  '```js',
  "export function pick(a, b) {",
  '  return a.score >= b.score ? a : b; // 取高分',
  '}',
  '```',
  '',
  '- 正文中的 *强调* 与普通文字',
  '- 第二条要点，带一个行内 `npm test`'
].join('\n');

const s = await sessions.newSession(TITLE);
const sid = String(s.id);
await sessions.appendUserMessage(sid, '帮我对比一下 v1.0.1 和 v2.0 两个规划文档，有什么差异？');
await sessions.appendAssistantMessage(sid, {
  role: 'assistant', content: MD,
  reasoning: '用户想要对比两个版本的规划文档。我先读两个文件，再按定位、数据来源、风险三个维度整理。',
  trace: [
    { tool: 'read_file', args: { path: 'docs/plan-v1.0.1.md' }, result: { content: '# v1.0.1\n...' } },
    { tool: 'read_file', args: { path: 'docs/plan-v2.0.md' }, result: { content: '# v2.0\n...' } },
    { tool: 'grep_code', args: { pattern: 'run_workflow' }, result: { matches: [] } }
  ]
});
await sessions.renameSession(sid, TITLE);

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
const STYLE_PROBE = `(() => {
  const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el);
    return { color: cs.color, bg: cs.backgroundColor, font: cs.fontFamily.split(',')[0], weight: cs.fontWeight }; };
  return { theme: document.documentElement.dataset.theme, body: pick('body'), md: pick('.md'), p: pick('.md p'), strong: pick('.md strong'),
    h2: pick('.md h2'), h3: pick('.md h3'), code: pick('.md p code, .md li code'), th: pick('.md th'), a: pick('.md a'), bubble: pick('.glass-bubble') };
})()`;
// 「金色」判定：R 明显高于 B（>60）且 G 也高——琥珀/金的共同特征；中性灰的 R≈G≈B
const isGold = (c) => { const m = String(c || '').match(/\d+/g); if (!m) return false; const [r, g, b] = m.map(Number); return r - b > 60 && g - b > 30; };

let failed = 0;
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);
  const entered = await ev(`(async () => {
    const row = [...document.querySelectorAll('[title]')].find((x) => (x.getAttribute('title') || '').startsWith(${JSON.stringify(TITLE)}) && x.offsetParent !== null);
    if (!row) return false; row.click(); await new Promise((r) => setTimeout(r, 2000)); return true; })()`);
  if (!entered) throw new Error('侧栏里找不到预置会话');

  for (const theme of ['dark', 'light']) {
    await ev(`(() => { try { localStorage.setItem('fc.theme', '${theme}'); } catch {} document.documentElement.dataset.theme = '${theme}'; document.documentElement.style.colorScheme = '${theme}'; })()`);
    await sleep(700);
    await shot(`${theme}.png`);
    const st = await ev(STYLE_PROBE);
    console.log(`[style:${theme}]`, JSON.stringify(st));
    if (theme === 'dark') {
      for (const k of ['p', 'strong', 'h2', 'h3', 'code', 'th']) {
        const bad = st[k] && isGold(st[k].color);
        console.log(`${bad ? 'FAIL' : 'PASS'} dark ${k} 非金色 (${st[k]?.color})`);
        if (bad || !st[k]) failed++;
      }
      const linkGold = st.a && isGold(st.a.color);
      console.log(`${linkGold ? 'PASS' : 'FAIL'} dark 链接保留琥珀强调 (${st.a?.color})`); if (!linkGold) failed++;
      const sans = !/serif|song|kai/i.test(st.md?.font || '') ;
      console.log(`${sans ? 'PASS' : 'FAIL'} dark 正文无衬线 (${st.md?.font})`); if (!sans) failed++;
    } else {
      const h2Gold = st.h2 && isGold(st.h2.color);
      console.log(`${h2Gold ? 'PASS' : 'FAIL'} light 标题仍是金色楷书 (${st.h2?.color} ${st.h2?.font})`); if (!h2Gold) failed++;
    }
  }
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { child.kill(); } catch { /* 忽略 */ }
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
