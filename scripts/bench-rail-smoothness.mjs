// 0.32.4：右栏「丝滑」的可测量基线。
//
// 用户要求：「把这个右边栏也做的丝滑」。
// 「丝滑」不能靠感觉，得先量出三个具体的卡点：
//   ① 拖拽右栏时，画面（WebContentsView）跟随的抖动/延迟
//   ② 折叠/展开有没有过渡（现在是两棵不同的 DOM，瞬间硬切）
//   ③ 拖动时 IPC 洪水（每个 mousemove 一次 railRect 往返）
//
// 这个脚本在真机上量出这些数值，改完之后再跑一次对比。
// 用法：node scripts/bench-rail-smoothness.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'rail-smoothness');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const PORT = 9335;

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p', name: 'T', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'm', contextWindow: 200000 }], enabled: true }],
  activeProviderId: 'p', language: 'zh', theme: 'dark'
}, null, 2), 'utf8');

const { createServer } = await import('node:http');
const server = createServer((_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
  res.end('<!doctype html><body style="margin:0;background:#fff7e6"><h1 style="font:600 24px sans-serif;padding:24px;color:#c0392b">SMOOTHNESS PROBE</h1></body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

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
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};

try {
  let page = null;
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools'));
      if (page) break;
    } catch { /* 还没起来 */ }
  }
  if (!page) throw new Error('CDP 起不来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3200);

  await ev(`window.finalcheck.browserGoto(${JSON.stringify(origin + '/')})`);
  await sleep(1500);

  /* ---- ① IPC 洪水：拖动右栏 60 帧，数 railRect 调用次数 ---- */
  const flood = await ev(`(async () => {
    const rail = document.querySelector('[data-rail="tabs"]');
    const handle = rail?.querySelector('.cursor-col-resize');
    if (!rail || !handle) return { error: 'no rail/handle' };
    // 包装 railRect 计数（不改行为，只统计）
    const orig = window.finalcheck.railRect;
    let calls = 0;
    const wrapped = (r) => { calls++; return orig(r); };
    try { window.finalcheck.railRect = wrapped; } catch { /* 可能不可写 */ }
    // 模拟拖动：从右栏左边缘往左拖 120px，分 60 步
    const rect = rail.getBoundingClientRect();
    const startX = rect.left;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: rect.top + 40 }));
    for (let i = 1; i <= 60; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: startX - i * 2, clientY: rect.top + 40 }));
      await new Promise((r) => requestAnimationFrame(r));
    }
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { dragFrames: 60, railRectCalls: calls, widthAfter: Math.round(rail.getBoundingClientRect().width) };
  })()`);
  console.log('[① 拖动 IPC]', JSON.stringify(flood));

  /* ---- ② 折叠/展开过渡：测宽度在切换后若干帧内是否平滑变化 ---- */
  const foldAnim = await ev(`(async () => {
    const btn = document.querySelector('[data-rail-toggle]');
    if (!btn) return { error: 'no toggle' };
    const railBefore = document.querySelector('[data-rail]');
    const wBefore = Math.round(railBefore.getBoundingClientRect().width);
    const samples = [];
    btn.click();
    // 抓 12 帧的宽度，看是"瞬间跳变"还是"逐帧过渡"
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const el = document.querySelector('[data-rail]');
      samples.push(el ? Math.round(el.getBoundingClientRect().width) : null);
    }
    return { wBefore, samples, distinctWidths: new Set(samples.filter((x) => x != null)).size };
  })()`);
  console.log('[② 折叠过渡]', JSON.stringify(foldAnim));

  // 再展开回去，测同样的事
  const unfoldAnim = await ev(`(async () => {
    const btn = document.querySelector('[data-rail-toggle]');
    if (!btn) return { error: 'no toggle' };
    const samples = [];
    btn.click();
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const el = document.querySelector('[data-rail]');
      samples.push(el ? Math.round(el.getBoundingClientRect().width) : null);
    }
    return { samples, distinctWidths: new Set(samples.filter((x) => x != null)).size };
  })()`);
  console.log('[② 展开过渡]', JSON.stringify(unfoldAnim));

  /* ---- ③ 画面跟随延迟：拖一步之后，view 的 bounds 多久追上占位 div ---- */
  const follow = await ev(`(async () => {
    const rail = document.querySelector('[data-rail="tabs"]');
    const box = document.querySelector('[data-browser-box]');
    if (!rail || !box) return { error: 'no rail/box' };
    const handle = rail.querySelector('.cursor-col-resize');
    const t0 = performance.now();
    const rect = rail.getBoundingClientRect();
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.left, clientY: rect.top + 40 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left - 60, clientY: rect.top + 40 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    // 轮询：占位 div 的新宽度 vs 主进程 view 的宽度，直到一致
    const boxW = () => Math.round(document.querySelector('[data-browser-box]').getBoundingClientRect().width);
    const viewW = async () => {
      const i = await window.finalcheck.browserTabs();
      const v = (i?.views || [])[0];
      return v?.bounds ? Math.round(v.bounds.width) : null;
    };
    const target = boxW();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if ((await viewW()) === target) return { matchedAfterMs: Math.round(performance.now() - t0), target };
    }
    return { matchedAfterMs: null, target, last: await viewW(), timeout: true };
  })()`);
  console.log('[③ 画面跟随]', JSON.stringify(follow));

  const report = { flood, fold: foldAnim, unfold: unfoldAnim, follow };
  writeFileSync(path.join(out, 'baseline.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n基线已写入', path.join(out, 'baseline.json'));
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { server.close(); } catch { /* 已关 */ }
  await sleep(600);
}
