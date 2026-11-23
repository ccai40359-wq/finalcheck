// 0.32.6 P0 回归探针：用户在**产物标签**上看图片时，另一条 browser-rail-open 通道
// （用户输网址 / AI 换页）不得把他抢回浏览器标签。
//
// 为什么单独有这个探针：Codex 侧把 window.open 接到宿主内部直接 newTab（不推 rail-open），
// 所以「点课程卡片」那条路径天然不抢焦点。但「用户输网址」和「AI 换页」仍然推
// browser-rail-open，而那时若 UI 用的是 openRailTab（无条件设 activeKey），
// 用户就会被从产物标签拽走——这正是用户报的「点不了图片」的另一半。
// 合并时我用 ensureBrowserRailTab 补掉了这个缺口，这个探针就是它的自动化证据。
//
// 用法：node scripts/probe-focus-steal.mjs   判据：产出 PASS 即通过
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'probe-focus');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const PORT = 9337;

mkdirSync(out, { recursive: true });
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });
await mkdir(projectDir, { recursive: true }).catch(() => {});

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c6360000002000001a56f5b1c0000000049454e44ae426082', 'hex');

const server = createServer((req, res) => {
  if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><html><body style="margin:0;padding:20px;background:#fff7e6;font:20px sans-serif">'
    + '<h1>PAGE</h1><p>fixture</p></body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{
    id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions',
    apiKey: 'test-key', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true
  }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark'
}, null, 2), 'utf8');

process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
const sessionsLib = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const s1 = await sessionsLib.newSession('焦点探针');
await sessionsLib.appendUserMessage(s1.id, '第一句');
const seededPng = path.join(projectDir, 'n1.png');
await writeFile(seededPng, PNG);
await sessionsLib.appendAssistantMessage(s1.id, {
  role: 'assistant', content: '已生成一张图片。',
  trace: [{ tool: 'present_artifact', args: { path: seededPng }, result: { path: seededPng, title: 'n1.png' } }]
});
await sessionsLib.renameSession(s1.id, '焦点探针');

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [
  path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'
], {
  env: {
    ...env, FINALCHECK_UI_SELFCHECK: '1',
    FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
    FINALCHECK_DEFAULT_PROJECT: projectDir,
    FINALCHECK_SESSIONS_DIR: sessionsDir
  },
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
  if (!page) throw new Error('CDP 25s 内没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res; ws.onerror = () => rej(new Error('ws error'));
    setTimeout(() => rej(new Error('ws timeout')), 15000);
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3400);

  const entered = await ev(`(async () => {
    const rows = [...document.querySelectorAll('div[title]')].filter((x) => (x.getAttribute('title') || '').startsWith('焦点探针') && x.offsetParent !== null);
    if (!rows.length) return { missing: true };
    rows[0].click();
    await new Promise((r) => setTimeout(r, 1600));
    return { ok: true };
  })()`);
  if (entered?.missing) throw new Error('进不去预置会话');

  // 开网页（右栏出现浏览器 tab）
  await ev(`(async () => {
    await window.finalcheck.browserGoto(${JSON.stringify(origin + '/one')});
    await new Promise((r) => setTimeout(r, 1200));
    return 'opened';
  })()`);

  // 点消息里的 PNG chip → 右栏切到产物
  const step1 = await ev(`(async () => {
    const EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
    const chips = [...document.querySelectorAll('button[title]')].filter((b) => {
      const t = (b.getAttribute('title') || '').toLowerCase();
      return EXTS.some((e) => t.endsWith(e));
    });
    if (!chips.length) return { noChip: true };
    chips[0].click();
    await new Promise((r) => setTimeout(r, 900));
    return { kind: document.querySelector('[data-rail-body]')?.getAttribute('data-rail-active-kind') || '' };
  })()`);
  console.log('[step1 点产物]', JSON.stringify(step1));

  // ★ 关键：用户停在产物上时，走另一条会推 browser-rail-open 的通道（= 用户输网址）
  const step2 = await ev(`(async () => {
    const t0 = Date.now();
    const trans = [];
    const ob = new MutationObserver(() => {
      trans.push({ dt: Date.now() - t0, kind: document.querySelector('[data-rail-body]')?.getAttribute('data-rail-active-kind') || '' });
    });
    ob.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-rail-active-kind'] });
    const r = await window.finalcheck.browserGoto(${JSON.stringify(origin + '/two')});
    for (let i = 0; i < 13; i++) await new Promise((res) => setTimeout(res, 500));
    try { ob.disconnect(); } catch { /* ignore */ }
    return {
      gotoOk: r?.ok === true,
      kind: document.querySelector('[data-rail-body]')?.getAttribute('data-rail-active-kind') || '',
      trans,
      showing: ((await window.finalcheck.browserTabs())?.showing || []).length
    };
  })()`);
  console.log('[step2 停在产物时触发 browser-goto]', JSON.stringify(step2));

  const stolen = step2?.kind === 'browser';
  const covered = (step2?.showing || 0) > 0;
  console.log(`\n=== 焦点抢夺探针 ===`);
  console.log(stolen
    ? 'FAIL  ❌ 用户停在产物标签时被 browser-goto 的 rail-open 抢回了浏览器标签'
    : 'PASS  ✅ 仍停在产物标签（ensureBrowserRailTab 生效）');
  console.log(covered
    ? 'FAIL  ❌ 网页画面还显示着（会盖住产物）'
    : 'PASS  ✅ 网页画面已让开');
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ step1, step2, stolen, covered }, null, 2), 'utf8');
  process.exitCode = stolen || covered ? 1 : 0;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { server.close(); } catch { /* 已关 */ }
  await sleep(800);
}
