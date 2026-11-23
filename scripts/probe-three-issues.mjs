// 0.32.5 → 0.32.6 合并前的独立核验：在 **Codex 的代码**上验我给 FC 报的三个真机问题。
//
// 为什么必须单独写：Codex 的测试台（17 项）覆盖了会话隔离、关标签销毁、缩放、外部打开，
// 但**完全没有覆盖**这三条：
//   ① 页面里 window.open（点课程卡片）能否开出新标签 —— 这是"点课程没反应"的根因
//   ② 停在图片标签时会不会被浏览器通知抢回焦点 —— 这是"点不了图片"的根因
//   ③ 空闲时渲染层是否在自转 —— 这是"巨卡"的根因
// 它自己 17 项全过 ≠ 这三条好了。所以在它的代码上单独跑一遍，用同一套判据。
//
// 用法：node scripts/probe-codex-three-issues.mjs   （在 fc-browser-desktop-codex 目录下）
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'probe-three');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const PORT = 9336; // 避开 9223 / 9224 / 9331-9334

mkdirSync(out, { recursive: true });
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });

const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000a49444154789c6360000002000001a56f5b1c0000000049454e44ae426082', 'hex');

// 本地站：两个页面 + 一张图片 + 一个「页面内调 window.open」的按钮
const server = createServer((req, res) => {
  if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG_1PX); }
  const two = req.url.startsWith('/two');
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><body style="margin:0;background:${two ? '#e8f0ff' : '#fff7e6'};font:600 26px/1.5 sans-serif">
    <div style="padding:26px">
      <h1 style="color:#c0392b">${two ? 'PAGE TWO' : 'PAGE ONE'}</h1>
      <a id="lnk" href="/two" target="_blank" style="font-size:18px">target=_blank 链接</a>
      <br><br>
      <button id="wo" data-open-new-window style="font-size:18px;padding:8px 16px"
        onclick="window.open('/two?from=script','_blank')">脚本调 window.open（模拟课程卡片）</button>
    </div></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log('[server]', origin);

await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{
    id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions',
    apiKey: 'test-key', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true
  }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark'
}, null, 2), 'utf8');

// seed 一条真实会话（纯 Node 写 JSON；产品在 Electron 下会经 migrateLegacy 导入 sqlite）
process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
const sessionsLib = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const s1 = await sessionsLib.newSession('探针会话一');
await sessionsLib.appendUserMessage(s1.id, '第一句');
const seededPng = path.join(projectDir, 'n1.png');
await mkdir(projectDir, { recursive: true }).catch(() => {});
await writeFile(seededPng, PNG_1PX);
await sessionsLib.appendAssistantMessage(s1.id, {
  role: 'assistant', content: '已生成一张图片。',
  trace: [{ tool: 'present_artifact', args: { path: seededPng }, result: { path: seededPng, title: 'n1.png' } }]
});
await sessionsLib.renameSession(s1.id, '探针会话一');
console.log('[seed]', s1.id);

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

const results = [];
const record = (step, name, ok, detail) => {
  results.push({ step, name, ok, detail: String(detail ?? '').slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${step}] ${name}  ${String(detail ?? '').slice(0, 200)}`);
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
  await sleep(3200);

  /* 进入真实会话 */
  const entered = await ev(`(async () => {
    const rows = [...document.querySelectorAll('div[title]')].filter((x) => {
      const tt = x.getAttribute('title') || '';
      return tt.startsWith('探针会话一') && x.offsetParent !== null;
    });
    if (!rows.length) return { missing: true };
    rows[0].click();
    await new Promise((r) => setTimeout(r, 1600));
    return { ok: true };
  })()`);
  record('P0', '进入真实会话', entered?.missing !== true, JSON.stringify(entered));

  /* 打开网页 */
  const opened = await ev(`(async () => {
    const r = await window.finalcheck.browserGoto(${JSON.stringify(origin + '/one')});
    await new Promise((res) => setTimeout(res, 1200));
    const info = await window.finalcheck.browserTabs();
    return { ok: r?.ok === true, tabs: (info?.tabs || []).length, showing: (info?.showing || []).length };
  })()`);
  record('P1', '打开网页（右栏出现浏览器画面）', opened?.ok === true && (opened?.tabs || 0) >= 1, JSON.stringify(opened));

  /* ① 页面内 window.open：在页面自己的 webContents 上点按钮 */
  const before = (await ev(`(async () => ((await window.finalcheck.browserTabs())?.tabs || []).length)()`)) || 0;
  let viewClick = { clicked: null, error: null };
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const vt = (targets || []).find((t) => t.type === 'page' && String(t.url || '').startsWith(origin));
    if (!vt) throw new Error('view target not found');
    const vws = new WebSocket(vt.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      vws.onopen = res; vws.onerror = () => rej(new Error('view ws error'));
      setTimeout(() => rej(new Error('view ws timeout')), 8000);
    });
    let vseq = 0; const vp = new Map();
    vws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (!msg.id || !vp.has(msg.id)) return;
      const p = vp.get(msg.id); vp.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
    };
    const vcdp = (method, params) => new Promise((res, rej) => {
      const id = ++vseq; vp.set(id, { res, rej });
      vws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (vp.has(id)) { vp.delete(id); rej(new Error('view timeout ' + method)); } }, 15000);
    });
    await vcdp('Runtime.enable');
    const r = await vcdp('Runtime.evaluate', {
      expression: `(() => { const b = document.querySelector('[data-open-new-window]'); if (!b) return 'button-missing'; b.click(); return 'clicked'; })()`,
      returnByValue: true
    });
    viewClick.clicked = r?.result?.value || null;
    await sleep(1500);
    try { vws.close(); } catch { /* 已关 */ }
  } catch (e) { viewClick.error = String(e?.message || e).slice(0, 160); }

  const after = (await ev(`(async () => {
    const info = await window.finalcheck.browserTabs();
    return { count: (info?.tabs || []).length, urls: (info?.tabs || []).map((t) => t.url || '') };
  })()`)) || {};
  const added = (after.count || 0) - before;
  record('P2', '① 页面里 window.open 真的开出新标签（"点课程没反应"）',
    viewClick.clicked === 'clicked' && added >= 1,
    JSON.stringify({ before, after: after.count, added, urls: after.urls, click: viewClick }));

  /* ② 停在图片标签：点消息里的 PNG chip，等 6.5 秒看是否回弹 */
  const hit = await ev(`(async () => {
    const EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
    const chips = [...document.querySelectorAll('button[title]')].filter((b) => {
      const t = (b.getAttribute('title') || '').toLowerCase();
      return EXTS.some((e) => t.endsWith(e));
    });
    if (!chips.length) return { noChip: true, titles: [...document.querySelectorAll('button[title]')].map((b) => b.getAttribute('title')).slice(0, 20) };
    const t0 = Date.now();
    const trans = [];
    const ob = new MutationObserver(() => {
      trans.push({ dt: Date.now() - t0, kind: document.querySelector('[data-rail-body]')?.getAttribute('data-rail-active-kind') || '' });
    });
    ob.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-rail-active-kind'] });
    chips[0].click();
    for (let i = 0; i < 13; i++) await new Promise((r) => setTimeout(r, 500));
    try { ob.disconnect(); } catch { /* ignore */ }
    const info = await window.finalcheck.browserTabs();
    return {
      noChip: false, trans,
      activeKind: document.querySelector('[data-rail-body]')?.getAttribute('data-rail-active-kind') || '',
      showing: (info?.showing || []).length,
      kinds: [...document.querySelectorAll('[data-rail-tab]')].map((x) => x.getAttribute('data-rail-kind'))
    };
  })()`);
  const settled = hit?.noChip !== true && hit?.activeKind === 'artifact' && (hit?.showing || 0) === 0;
  record('P3', '② 点 PNG chip 后 6.5s 不回弹且网页画面让开（"点不了图片"）', settled, JSON.stringify(hit));

  /* ③ 空闲 4 秒内的长任务（"巨卡"） */
  const perf = await ev(`(async () => {
    const long = [];
    let frames = 0, stop = false;
    const ob = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); });
    try { ob.observe({ entryTypes: ['longtask'] }); } catch { /* 不支持 */ }
    const tick = () => { if (stop) return; frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, 4000));
    stop = true;
    try { ob.disconnect(); } catch { /* ignore */ }
    return { frames, longCount: long.length, maxLong: long.length ? Math.max(...long) : 0 };
  })()`);
  record('P4', '③ 空闲 4s 零长任务（不再"巨卡"）且画面在刷新',
    (perf?.longCount || 0) === 0 && (perf?.frames || 0) >= 30, JSON.stringify(perf));

  await writeFile(path.join(out, 'result.json'), JSON.stringify({ origin, results }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Codex 代码三问题探针 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}） ===`);
  console.log('证据:', out);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { server.close(); } catch { /* 已关 */ }
  await sleep(800);
}
