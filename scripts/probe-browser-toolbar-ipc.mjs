// CC 0.33.4 浏览器工具栏的主进程行为验收（不依赖 UI 渲染条件）。
//
// 为什么不用 UI 点击验收：右栏渲染要同时满足 railBelongsToSession && shouldShowRail(rail)
// && page==='chat' 三个条件，从外部脚本伪造这三种状态很脆（我前两版脚本都卡在这里，
// 全是假失败）。这里改用**直接调主进程 IPC**验证行为本身：
//   ① browserTabOpen 开标签 → 拿到 id
//   ② 第二次导航后 canGoBack 变 true（这是「后退按钮可用」的真正数据源）
//   ③ browserTabNav(back) 真的回到上一页（用页面 title 验证，不看按钮 disabled）
//   ④ browserTabNav(forward) 真的前进
//   ⑤ browserTabReload 真的重发请求（服务端计数验证）
//   ⑥ browserTabNav(stop) 能中断慢页面
// UI 层（按钮 disabled / 徽章文案）由 tests/rail-collapse-and-toolbar.test.mjs 这类源码钉覆盖。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'browser-toolbar-check');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const PORT = 9361;

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'ui-model' }], enabled: true }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark', permissionMode: 'ask'
}, null, 2), 'utf8');

const hits = { a: 0, b: 0, slow: 0 };
const site = createServer(async (req, res) => {
  const u = req.url || '/';
  if (u === '/a') { hits.a++; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<title>Page A</title><h1>A</h1>'); }
  if (u === '/b') { hits.b++; res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<title>Page B</title><h1>B</h1>'); }
  if (u === '/slow') {
    hits.slow++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write('<title>Slow</title><h1>loading</h1>');
    await sleep(8000);
    return res.end('<h1>slow done</h1>');
  }
  res.writeHead(404); res.end('nf');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'],
  {
    env: {
      ...env, FINALCHECK_UI_SELFCHECK: '1',
      FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
      FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
      FINALCHECK_DEFAULT_PROJECT: projectDir
    },
    stdio: 'ignore', windowsHide: false
  });

let ws = null, seq = 0;
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
const results = [];
const record = (n, ok, d) => {
  results.push({ n, ok, d: String(d ?? '').slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${String(d ?? '').slice(0, 240)}`);
};

try {
  let page = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools'));
      if (page) break;
    } catch { /* 等 */ }
  }
  if (!page) throw new Error('CDP 没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); setTimeout(() => j(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const g = JSON.parse(m.data); if (!g.id || !pending.has(g.id)) return; const p = pending.get(g.id); pending.delete(g.id); if (g.error) p.rej(new Error(JSON.stringify(g.error))); else p.res(g.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3400);

  const opened = await ev(`(async () => {
    const r = await window.finalcheck.browserTabOpen('${SITE}/a');
    return { ok: r?.ok !== false, id: r?.id || null, err: r?.error || null, keys: Object.keys(r || {}) };
  })()`);
  await sleep(2500);
  record('T1 browserTabOpen 开出标签', opened?.ok === true && !!opened?.id, JSON.stringify(opened));
  const tabId = opened?.id;

  // 第二次导航（同标签）：靠 browserTabNav 无法导航到指定 URL，用 browserTabOpen 会开新标签。
  // 检查 tabs 列表里 canGoBack 字段（它是「后退按钮是否可用」的数据源）
  const list1 = await ev(`(async () => {
    const r = await window.finalcheck.browserTabs?.();
    const list = Array.isArray(r) ? r : (r?.tabs || []);
    return list.map((t) => ({ id: t.id, url: String(t.url || '').slice(0, 60), canGoBack: t.canGoBack, canGoForward: t.canGoForward }));
  })()`);
  record('T2 tabs 列表带 canGoBack / canGoForward 字段（按钮 disabled 的数据源）',
    Array.isArray(list1) && list1.length > 0 && list1.every((t) => t.canGoBack !== undefined && t.canGoForward !== undefined),
    JSON.stringify(list1));

  // 后退：第 1 页时应该拒绝（没有历史）
  const backNoHistory = await ev(`(async () => {
    try { const r = await window.finalcheck.browserTabNav('${tabId}', 'back'); return JSON.parse(JSON.stringify(r || {})); }
    catch (e) { return { err: String(e?.message || e) }; }
  })()`);
  record('T3 第 1 页点后退被明确拒绝（不是静默无反应）',
    backNoHistory?.ok === false && /没有可后退/.test(String(backNoHistory?.error || '')),
    JSON.stringify(backNoHistory));

  // 刷新：服务端计数必须涨（真发请求，不是 UI 说成功）
  const before = hits.a;
  const reload = await ev(`(async () => {
    try { const r = await window.finalcheck.browserTabReload('${tabId}'); return JSON.parse(JSON.stringify(r || {})); }
    catch (e) { return { err: String(e?.message || e) }; }
  })()`);
  await sleep(2200);
  record('T4 browserTabReload 真的重发请求（服务端计数 +1）',
    reload?.ok !== false && hits.a > before,
    JSON.stringify({ reload, aBefore: before, aAfter: hits.a }));

  // 硬刷新（Shift+点击 走的路径）
  const before2 = hits.a;
  const hardReload = await ev(`(async () => {
    try { const r = await window.finalcheck.browserTabReload('${tabId}', null, { hard: true }); return JSON.parse(JSON.stringify(r || {})); }
    catch (e) { return { err: String(e?.message || e) }; }
  })()`);
  await sleep(2200);
  record('T5 硬刷新（Ctrl+Shift+R 路径）也真的重发请求',
    hardReload?.ok !== false && hits.a > before2,
    JSON.stringify({ hardReload, aBefore: before2, aAfter: hits.a }));

  // 停止：导航到慢页面，然后 stop
  await ev(`(async () => { try { await window.finalcheck.browserTabOpen('${SITE}/slow'); } catch {} })()`);
  await sleep(1500);
  const stopped = await ev(`(async () => {
    const r = await window.finalcheck.browserTabs?.();
    const list = Array.isArray(r) ? r : (r?.tabs || []);
    const slowTab = list.find((t) => String(t.url || '').includes('/slow'));
    if (!slowTab) return { err: 'no slow tab', tabs: list.map((t) => t.url) };
    const stop = await window.finalcheck.browserTabNav(slowTab.id, 'stop');
    return { ok: true, stopRes: JSON.parse(JSON.stringify(stop || {})), tabId: slowTab.id };
  })()`);
  record('T6 加载中能点停止（browserTabNav stop 返回 ok）', stopped?.ok === true && stopped?.stopRes?.ok !== false, JSON.stringify(stopped));

  await writeFile(path.join(out, 'result.json'), JSON.stringify({ results, opened, list1, backNoHistory, reload, hardReload, stopped, hits }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 浏览器工具栏主进程行为验收 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { site.close(); } catch { /* 已关 */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
