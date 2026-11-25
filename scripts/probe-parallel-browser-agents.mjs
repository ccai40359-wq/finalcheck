// 0.33.6 多个浏览器子代理并行测试网页（真 Electron + 本地模拟网关，隔离 profile，窗口在后台不抢前台）：
//   用户：「并行测一下这个网站的三个功能」→ 主 agent 同一次回复派 3 个 browser 子代理
//   → 每个子代理在右栏开自己的标签：打开页面 → 按 ref 点按钮 → 看结果 → 交报告
//   验收：3 个标签各自独立（结果不串）、服务端看到 API 调用真的并发、总耗时明显小于串行、报告各写各的功能。
// 用法：cd desktop && npx electron-vite build；然后 node scripts/probe-parallel-browser-agents.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway } from './sim/gateway.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'parallel-browser-agents');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const PORT = 9367;
const API_MS = 1500;

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(projectDir, { recursive: true });

// ---- 被测网站：三个功能页，每个按钮调一次慢 API ----
const FEATURES = {
  login: { button: '登录', result: '欢迎回来，测试用户' },
  cart: { button: '加入购物车', result: '购物车：1 件商品' },
  search: { button: '搜索', result: '找到 3 条结果' }
};
let inflight = 0; let maxInflight = 0;
const apiLog = [];
const site = createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const name = u.pathname.slice(1);
  if (u.pathname.startsWith('/api/')) {
    const f = u.pathname.slice(5);
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    apiLog.push({ f, at: Date.now() });
    await sleep(API_MS);
    inflight--;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ text: FEATURES[f]?.result || '?' }));
  }
  if (FEATURES[name]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><title>${name}</title><h1>${name} 页面</h1>
      <button id="go">${FEATURES[name].button}</button><p id="out" aria-live="polite">（未操作）</p>
      <script>document.getElementById('go').onclick = async () => {
        const r = await fetch('/api/${name}').then((x) => x.json());
        document.getElementById('out').textContent = r.text;
      };</script>`);
  }
  res.writeHead(404); return res.end('nf');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

// ---- 模拟模型 ----
const reports = {};
const snaps = {};
let spawnAt = 0; let mainDoneAt = 0;
const gw = await startGateway({
  mode: 'script',
  respond: async (body, { kind }) => {
    const msgs = body.messages;
    const last = msgs[msgs.length - 1];
    if (kind === 'subagent') {
      const task = String(msgs.find((m) => m.role === 'user')?.content || '');
      const f = Object.keys(FEATURES).find((k) => task.includes(`/${k}`));
      const tools = msgs.filter((m) => m.role === 'tool');
      if (!tools.length) return { toolCalls: [{ name: 'browser_navigate', args: { url: `${SITE}/${f}` } }] };
      if (tools.length === 1) {
        const raw = String(tools[0].content);
        let snap = raw; try { snap = JSON.parse(raw)?.snapshot?.tree || raw; } catch { /* 原文 */ }
        snaps[f] = snap.slice(0, 1500);
        const ref = (snap.match(new RegExp(`button "${FEATURES[f].button}" \\[ref=([^\\]]+)\\]`)) || [])[1];
        if (!ref) return { content: `${f}：没测到（页面上找不到按钮）\n${snap.slice(0, 300)}` };
        return { toolCalls: [{ name: 'browser_click', args: { ref, observe: true } }] };
      }
      // 点完等结果出来（像真模型一样：点击返回时慢接口可能还没回来，再读一次页面）
      if (tools.length === 2) {
        snaps[f + ':click'] = String(tools[1].content).slice(0, 600);
        return { toolCalls: [{ name: 'browser_evaluate', args: { expression: "new Promise((r) => { const t0 = Date.now(); (function w() { const x = document.getElementById('out').textContent; if (x !== '（未操作）' || Date.now() - t0 > 8000) r(x); else setTimeout(w, 100); })(); })" } }] };
      }
      const after = String(tools.at(-1).content);
      snaps[f + ':after'] = after.slice(0, 600);
      const ok = after.includes(FEATURES[f].result);
      const seenOther = Object.entries(FEATURES).some(([k, v]) => k !== f && after.includes(v.result));
      reports[f] = { ok, seenOther };
      return { content: `${f}：${ok ? '通过' : '失败'}（点击「${FEATURES[f].button}」后页面显示：${ok ? FEATURES[f].result : '没出现预期文字'}）` };
    }
    if (kind !== 'main') return null;
    if (last.role === 'tool') { mainDoneAt = Date.now(); return { content: '三个功能并行测完：' + msgs.filter((m) => m.role === 'tool').map((m) => { try { return JSON.parse(m.content).report; } catch { return ''; } }).join('；') }; }
    spawnAt = Date.now();
    return { toolCalls: Object.keys(FEATURES).map((f) => ({
      name: 'spawn_agent',
      args: { type: 'browser', description: `测${f}`, prompt: `打开 ${SITE}/${f}，点击「${FEATURES[f].button}」，确认页面出现「${FEATURES[f].result}」。` }
    })) };
  }
});

writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: gw.url, apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true }],
  activeProviderId: 'p-ui', activeModel: 'ui-model', language: 'zh', theme: 'dark', permissionMode: 'full', browserSessionMode: 'oneshot'
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
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((tg) => tg.type === 'page' && !String(tg.url).startsWith('devtools') && !String(tg.url).startsWith('http://127.0.0.1')); } catch { /* 等 */ }
  }
  if (!page) throw new Error('CDP 没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); setTimeout(() => j(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const g = JSON.parse(m.data); if (!g.id || !pending.has(g.id)) return; const p = pending.get(g.id); pending.delete(g.id); if (g.error) p.rej(new Error(JSON.stringify(g.error))); else p.res(g.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);
  await ev(`(async () => {
    const ta = document.querySelector('textarea'); ta.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '并行测一下这个网站的登录、购物车、搜索三个功能'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  const done = await waitFor(`document.body.innerText.includes('三个功能并行测完')`, 60000);
  await sleep(600);
  await shot('1-done.png');
  record('P1 主 agent 拿到三份报告', done && Object.keys(reports).length === 3, JSON.stringify(reports));
  record('P2 每个功能都通过（各自的标签上点到了、看到了预期结果）', Object.values(reports).every((r) => r.ok), JSON.stringify(reports));
  record('P3 结果不串：每个子代理的页面上没出现别的功能的结果', Object.values(reports).every((r) => !r.seenOther), JSON.stringify(reports));
  record('P4 服务端看到 API 真的并发（同时在飞 ≥ 2）', maxInflight >= 2, `maxInflight=${maxInflight} log=${JSON.stringify(apiLog.map((x) => x.f))}`);
  const span = mainDoneAt - spawnAt;
  record('P5 总耗时明显小于串行（3 × 1.5s API + 操作）', span > 0 && span < 3 * API_MS + 2500, `${span}ms`);
  const tabs = await ev(`(async () => { const r = await window.finalcheck.browserTabs?.(); const list = Array.isArray(r) ? r : (r?.tabs || []); return list.map((t) => t.url); })()`);
  record('P6 三个子代理的标签都在这个会话的右栏里（用户看得见）', Array.isArray(tabs) && Object.keys(FEATURES).every((f) => tabs.some((u) => String(u).endsWith(`/${f}`))), JSON.stringify(tabs));
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ results, reports, snaps, apiLog, maxInflight, span, tabs }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 浏览器子代理并行测试 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  try { await shot('fatal.png'); } catch { /* 忽略 */ }
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { await gw.close(); } catch { /* 已关 */ }
  try { site.close(); } catch { /* 已关 */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
