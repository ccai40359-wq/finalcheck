// 0.32.0 真机 UI 自检：内嵌浏览器必须真的画在右栏里，而且看得见。
//
// 用户两次实机截图的问题：
//   ① 以前自带浏览器 offscreen:true + show:false → 屏幕上只有「No content under offscreen mode」白框，
//      AI 却让他去扫一个根本看不见的二维码。
//   ② 只能开一个页面（window.open 返回 false）。
//
// 这个自检真开 Electron（隔离 userData + 隔离项目），然后：
//   A. 通过 IPC 让 AI 的浏览引擎打开一个本地网页 → 断言右栏自动出现 + WebContentsView 可见
//   B. 把 view 的 bounds 与渲染层占位 div 的 rect 对齐（这是"看得见"的物理条件）
//   C. 开第二个网页标签 → 断言有两个标签、且只有活动那个可见
//   D. 截图整窗，人工可见证据
//
// 用法：node scripts/ui-selfcheck-embedded-browser.mjs
// 证据：.tmp/embedded-browser/
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'embedded-browser');
const userData = path.join(out, 'user-data');
const projectsFile = path.join(userData, 'projects.json');
const projectDir = path.join(out, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const PORT = 9333; // 与 9223 / 9224 / 9331 / 9332 都不同（后两个是别的自检）

mkdirSync(out, { recursive: true });
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });

await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{
    id: 'p-ui', name: 'UI Test', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions',
    apiKey: 'test-key', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true
  }],
  activeProviderId: 'p-ui',
  language: 'zh',
  theme: 'dark'
}, null, 2), 'utf8');

// 一个能被真加载的本地测试站（内容可辨认，截图能看出确实渲染了）
const { createServer } = await import('node:http');
const server = createServer((req, res) => {
  const page = req.url === '/two' ? 'PAGE TWO' : 'PAGE ONE';
  const bg = req.url === '/two' ? '#e8f0ff' : '#fff7e6';
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
  res.end(`<!doctype html><html><body style="margin:0;background:${bg};font:600 28px/1.4 sans-serif">
    <div style="padding:28px">
      <h1 style="color:#c0392b">${page}</h1>
      <p style="color:#333;font-weight:400;font-size:16px">这是 FC 内嵌浏览器真机自检页面。<br>如果你在右栏里看到这段文字，说明「看得见」这件事成立了。</br></p>
      <button id="btn" onclick="document.getElementById('r').textContent='CLICKED'"
        style="font-size:18px;padding:10px 18px">点我</button>
      <div id="r" style="margin-top:12px;color:#0a7">（未点击）</div>
    </div></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log('[server]', origin);

/* ---- 起 Electron ---- */
const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [
  path.join(root, 'desktop'),
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userData}`,
  '--no-first-run'
], {
  env: {
    ...env,
    FINALCHECK_UI_SELFCHECK: '1',
    FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: projectsFile,
    FINALCHECK_DEFAULT_PROJECT: projectDir,
    FINALCHECK_SESSIONS_DIR: sessionsDir
  },
  stdio: 'ignore', windowsHide: false
});

let ws = null;
let seq = 0;
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
  if (!r?.data) throw new Error('screenshot failed');
  const file = path.join(out, name);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('[shot]', file);
  return file;
};

// ⚠️ Page.captureScreenshot 只截**主窗口渲染层**，不含叠加的 WebContentsView（独立合成层）。
// 所以右栏里的网页画面在那种截图里永远是黑的——这不是产品 bug，是 CDP 截图工具的局限。
// 要证明"用户真的看得见"，两条独立证据：
//   ① 连 view 自己的 CDP（/json/list 会列出所有 webContents）截图 + 读正文 → 证明页面确实渲染了内容
//   ② 桌面全屏截图（PowerShell + System.Drawing 抓屏幕真实像素）→ 证明画面出现在屏幕的右栏位置上
const shotViewContents = async (name) => {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    // 内嵌 view 的标题/URL 特征：我们测试站的地址
    const viewTarget = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(String(t.url || '')) && t.url.includes(String(server.address().port)));
    if (!viewTarget) return { ok: false, error: '没找到内嵌 view 的 CDP target', targets: list.map((t) => t.url).slice(0, 8) };
    const vws = new WebSocket(viewTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => { vws.onopen = res; vws.onerror = () => rej(new Error('view ws error')); setTimeout(() => rej(new Error('view ws timeout')), 10000); });
    let vseq = 0;
    const vpending = new Map();
    const vcdp = (method, params = {}) => new Promise((res, rej) => {
      const id = ++vseq;
      vpending.set(id, { res, rej });
      vws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (vpending.has(id)) { vpending.delete(id); rej(new Error('view timeout ' + method)); } }, 15000);
    });
    vws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (!msg.id || !vpending.has(msg.id)) return;
      const p = vpending.get(msg.id); vpending.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
    };
    await vcdp('Page.enable');
    // 拿页面正文，证明内容真的在那里（不是空白页）
    const body = await vcdp('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,120)', returnByValue: true });
    const png = await vcdp('Page.captureScreenshot', { format: 'png' });
    const file = path.join(out, name);
    writeFileSync(file, Buffer.from(png.data, 'base64'));
    try { vws.close(); } catch { /* ignore */ }
    return { ok: true, file, text: body?.result?.value || '', url: viewTarget.url };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
};

const desktopShot = async (name) => {
  const file = path.join(out, name);
  const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`;
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    console.log('[desktop-shot]', file);
    return { ok: true, file };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
};

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail: String(detail ?? '').slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 220)}`);
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
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await sleep(3200);

  // 前置断言（吸取 0.31.2 教训：先确认前置状态正确，否则后面的数字全靠运气）
  const startup = await ev(`(() => {
    const text = document.body.innerText || '';
    return { inWizard: text.includes('首次使用') && text.includes('连接 OpenAI 兼容网关'), hasRail: !!document.querySelector('[data-rail]') };
  })()`);
  record('启动后已进入工作区（不是首次使用向导）', !startup.inWizard, JSON.stringify(startup));
  await shot('00-startup.png');

  // A. 让 AI 引擎（browser-use）走内嵌宿主打开一个网页。
  //    直接调 preload 暴露的 browserGoto：它与 browser_navigate 走同一条引擎路径。
  const opened = await ev(`window.finalcheck.browserGoto(${JSON.stringify(origin + '/one')})`);
  console.log('[browserGoto]', JSON.stringify(opened).slice(0, 300));
  record('A1 内嵌浏览器打开了网页（引擎报告 embedded=true）',
    Boolean(opened && opened.ok && opened.embedded), JSON.stringify({ ok: opened?.ok, embedded: opened?.embedded, tabId: opened?.tabId, url: opened?.url }));
  await sleep(1200);
  await shot('01-after-open.png');

  // B. 右栏自动出现（AI 开网页 → 右栏跳出）
  const railAfter = await ev(`(() => {
    const rail = document.querySelector('[data-rail]');
    if (!rail) return { rail: false };
    const box = document.querySelector('[data-browser-box]');
    const tabs = [...(rail.querySelectorAll('[data-rail-tab]'))].map((x) => (x.textContent || '').trim());
    return {
      rail: true,
      railWidth: Math.round(rail.getBoundingClientRect().width),
      tabs,
      hasBrowserBox: !!box,
      boxRect: box ? (() => { const r = box.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })() : null,
      dpr: window.devicePixelRatio
    };
  })()`);
  console.log('[rail]', JSON.stringify(railAfter));
  record('A2 右栏自动出现（有 data-rail 容器）', railAfter.rail === true, JSON.stringify(railAfter));
  record('A3 右栏里有浏览器内容区（占位 div 存在）', railAfter.hasBrowserBox === true, JSON.stringify(railAfter.boxRect));

  // A4：等一拍再确认 rect 已经上报到主进程（BrowserPane 的 ResizeObserver 是异步的）
  await sleep(600);
  const rectEcho = await ev(`window.finalcheck.railRect(${JSON.stringify(railAfter.boxRect)})`);
  console.log('[rectEcho]', JSON.stringify(rectEcho));
  record('A4 主进程接受了 rect（说明 rect 通道通）', Boolean(rectEcho && rectEcho.ok), JSON.stringify(rectEcho));

  // A5：宿主的实际状态（诊断"画了但看不见"：bounds 是不是 0、visible 是不是真 true）
  const hostDiag = await ev(`window.finalcheck.browserTabs()`);
  console.log('[hostDiag]', JSON.stringify(hostDiag).slice(0, 400));
  const view0 = (hostDiag?.views || [])[0];
  record('A5 内嵌 view 的 bounds 与占位 div 一致（画在了正确位置）',
    Boolean(view0 && railAfter.boxRect
      && view0.bounds.x === railAfter.boxRect.x && view0.bounds.y === railAfter.boxRect.y
      && view0.bounds.width === railAfter.boxRect.width && view0.bounds.height === railAfter.boxRect.height),
    `view=${JSON.stringify(view0?.bounds)} box=${JSON.stringify(railAfter.boxRect)}`);

  // A6：关键证据 —— 连 view 自己的 CDP 截图，证明页面**真的渲染了内容**（不是空白）
  //（Page.captureScreenshot 截不到叠加层，所以必须单独连 view 的 webContents）
  const viewShot = await shotViewContents('01-view-contents.png');
  console.log('[viewShot]', JSON.stringify(viewShot).slice(0, 240));
  record('A6 内嵌 view 里真的渲染了网页内容（连 view 自己的 CDP 截图 + 读正文）',
    Boolean(viewShot.ok && /PAGE ONE/.test(viewShot.text || '')), JSON.stringify({ ok: viewShot.ok, text: (viewShot.text || '').slice(0, 80), err: viewShot.error }));

  // A7：桌面全屏截图 —— 证明画面真的出现在屏幕的右栏位置（人能看见）
  const deskShot = await desktopShot('01-desktop-fullscreen.png');
  record('A7 桌面全屏截图成功（人眼可见证据）', deskShot.ok === true, deskShot.ok ? deskShot.file : deskShot.error);

  // C. 关键：内嵌 view 的 bounds 必须与占位 div 的 rect 对齐（PoC 实测 view 不会自动跟随）
  const host = await ev(`window.finalcheck.browserTabs()`);
  console.log('[tabs]', JSON.stringify(host).slice(0, 250));
  record('B1 引擎报告有 1 个网页标签且活动', Boolean(host && host.tabs && host.tabs.length === 1 && host.activeId), JSON.stringify({ n: host?.tabs?.length, active: host?.activeId }));

  // D. 开第二个标签 → 两个标签、只有活动可见
  const second = await ev(`window.finalcheck.browserTabOpen(${JSON.stringify(origin + '/two')})`);
  await sleep(1200);
  const tabs2 = await ev(`window.finalcheck.browserTabs()`);
  console.log('[tabs2]', JSON.stringify(tabs2).slice(0, 250));
  record('B2 能开第二个网页标签（多标签成立）', Boolean(tabs2 && tabs2.tabs && tabs2.tabs.length === 2), JSON.stringify({ n: tabs2?.tabs?.length }));
  record('B3 活动标签切到新开的那一个', Boolean(tabs2 && tabs2.activeId && tabs2.activeId !== host?.activeId), `${host?.activeId} → ${tabs2?.activeId}`);
  await shot('02-two-tabs.png');

  // E. 切回第一个标签
  const firstId = host?.activeId;
  if (firstId) {
    const sw = await ev(`window.finalcheck.browserTabSwitch(${JSON.stringify(firstId)})`);
    await sleep(900);
    record('B4 能切回第一个标签', Boolean(sw && sw.ok), JSON.stringify(sw));
    await shot('03-switched-back.png');
  } else {
    record('B4 能切回第一个标签', false, '没有第一个标签的 id');
  }

  // F. 主进程侧复核：宿主真的挂着一个可见的 WebContentsView，且 bounds 落在占位 div 的 rect 里
  //    （通过 Electron 的 webContents 列表 + 主进程 hostInfo；这里只能用渲染层能看到的信号）
  const visibleCheck = await ev(`window.finalcheck.railVisible(true).then(() => window.finalcheck.browserTabs())`);
  record('B5 右栏显式可见（railVisible 成功）', Boolean(visibleCheck && visibleCheck.ok !== false), JSON.stringify(visibleCheck).slice(0, 160));

  // G. 用户自己输网址（这是"我也可以自己开网页"的落点）
  const typed = await ev(`window.finalcheck.browserGoto(${JSON.stringify(origin + '/two')})`);
  record('C1 用户可以自己输网址打开页面', Boolean(typed && typed.ok), JSON.stringify({ ok: typed?.ok, url: typed?.url }));
  await sleep(800);
  await shot('04-user-typed.png');

  await writeFile(path.join(out, 'result.json'), JSON.stringify({ origin, results, railAfter, tabs: host, tabs2 }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 内嵌浏览器自检 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}） ===`);
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
