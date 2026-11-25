// 0.33.9 真界面验收（真 Electron + 本地模拟网关 + 本地动画网页，隔离 profile，窗口在后台不抢前台）：
//   R  用户自己打开右栏：顶栏按钮 → 新标签页 → 文件 → 点文件在右栏预览
//   T  AI 截了浏览器图：工具记录那一行有文件名，点开在右栏；消息底部不再堆「检查截图」
//   F  浏览器标签藏起来没人用 → 冻结（页面定时器停、CPU 降）；AI 再用它 → 立刻解冻、照常工作
//   P  AI 读项目外的私钥 → 弹卡问用户（不再直接拒绝）；点「允许这一次」→ 读到
//   L  输入框里粘贴的图片 / 发出去的图片 → 点开是大图，Esc 关
// 截图：.tmp/ui-0339/*.png
// 用法：cd desktop && npx electron-vite build；然后 node scripts/probe-ui-0339.mjs
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway } from './sim/gateway.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'ui-0339');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const secretDir = path.join(out, 'outside-secrets');
const keyFile = path.join(secretDir, 'id_rsa');
const PORT = 9371;

mkdirSync(out, { recursive: true });
for (const d of [userData, projectDir, secretDir]) { await rm(d, { recursive: true, force: true }).catch(() => {}); await mkdir(d, { recursive: true }); }
await mkdir(path.join(projectDir, 'src'), { recursive: true });
await writeFile(path.join(projectDir, 'src', 'app.js'), 'export const hello = "world";\n', 'utf8');
await writeFile(path.join(projectDir, 'README.md'), '# demo project\n\nhello from the files tab\n', 'utf8');
await writeFile(keyFile, '-----BEGIN OPENSSH PRIVATE KEY-----\nPROBE-KEY-0339\n-----END OPENSSH PRIVATE KEY-----\n', 'utf8');

// 一个「很吃渲染」的页面：毛玻璃 + 无限浮动 + rAF 计帧；每 500ms 回报一次帧数（冻结后回报会停）
let ticks = 0; let lastF = 0; const tickLog = []; const T0 = Date.now();
const HEAVY = `<!doctype html><title>Heavy page</title><style>
body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 20%,#f3c67e,transparent 45%),radial-gradient(circle at 90% 40%,#e1d8f5,transparent 45%),#f5eee1;font-family:sans-serif}
@keyframes bob{0%,100%{transform:translateY(0) rotateX(4deg)}50%{transform:translateY(-24px) rotateX(-4deg)}}
.c{display:inline-block;margin:30px;width:260px;height:170px;border-radius:24px;background:rgba(255,255,255,.55);backdrop-filter:blur(18px) saturate(160%);box-shadow:0 20px 50px rgba(0,0,0,.15);animation:bob 3s ease-in-out infinite}
</style><h1 style="margin:24px">Check the code AI wrote</h1>
${Array.from({ length: 8 }, (_, i) => `<div class="c" style="animation-delay:${i * 0.3}s"></div>`).join('')}
<script>['freeze','resume','visibilitychange'].forEach((n)=>document.addEventListener(n,()=>navigator.sendBeacon('/ev?'+n+'-'+document.visibilityState)));window.__f=0;(function l(){window.__f++;requestAnimationFrame(l)})();setInterval(()=>{fetch('/tick?f='+window.__f).catch(()=>{})},500)</script>`;
const site = createServer((req, res) => {
  if (req.url.startsWith('/ev')) { console.log('[page-ev]', Math.round((Date.now() - T0) / 1000) + 's', req.url.slice(4)); res.writeHead(204); return res.end(); }
  if (req.url.startsWith('/tick')) { ticks++; lastF = Number(new URL(req.url, 'http://x').searchParams.get('f')) || 0; tickLog.push([Date.now(), lastF]); res.writeHead(204); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HEAVY);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}/`;

const gw = await startGateway({
  mode: 'script',
  respond: async (body, { kind }) => {
    if (kind !== 'main') return null;
    const msgs = body.messages;
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user');
    const userText = String(msgs[lastUserIdx]?.content || '');
    const since = msgs.slice(lastUserIdx + 1).filter((m) => m.role === 'tool');
    if (/打开那个页面/.test(userText)) {
      if (since.length === 0) return { toolCalls: [{ name: 'browser_navigate', args: { url: SITE, mode: 'oneshot' } }] };
      if (since.length === 1) return { toolCalls: [{ name: 'browser_screenshot', args: {} }] };
      return { content: '页面打开了，截了一张图看过，布局正常。' };
    }
    if (/读一下私钥/.test(userText)) {
      if (since.length === 0) return { toolCalls: [{ name: 'read_file', args: { path: keyFile } }] };
      const c = String(since[0].content || '');
      return { content: /PROBE-KEY-0339/.test(c) ? '读到了，密钥第二行是 PROBE-KEY-0339。' : `没读到：${c.slice(0, 120)}` };
    }
    if (/再看一下页面/.test(userText)) {
      if (since.length === 0) return { toolCalls: [{ name: 'browser_evaluate', args: { expression: 'window.__f' } }] };
      return { content: `页面还活着，帧数 ${String(since[0].content || '').slice(0, 80)}` };
    }
    return { content: '好的。' };
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
    ...env, FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_WINDOW_BG: '1', FINALCHECK_DEBUG_FREEZE: path.join(out, 'freeze.log'),
    FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
    FINALCHECK_HOOKS_FILE: path.join(userData, 'hooks.json'),
    FINALCHECK_SESSIONS_DIR: path.join(projectDir, '.finalcheck', 'sessions'),
    FINALCHECK_DEFAULT_PROJECT: projectDir
  },
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
});
child.stderr.on('data', (d) => { for (const l of String(d).split(/\r?\n/)) if (/\[freeze\]/.test(l)) console.log(Math.round((Date.now() - T0) / 1000) + 's', l.trim()); });

/** 这棵 Electron 进程树的累计 CPU 秒数（只算本次探针起的进程，不碰别的） */
function treeCpuSeconds() {
  const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add(${child.pid}); $grew = $true; while ($grew) { $grew = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $grew = $true } } }; $s = 0; foreach ($id in $ids) { $g = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($g) { $s += $g.TotalProcessorTime.TotalSeconds } }; $s`;
  try { return Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim()); } catch { return NaN; }
}
async function cpuOver(ms) { const a = treeCpuSeconds(); await sleep(ms); const b = treeCpuSeconds(); return ((b - a) / (ms / 1000)) * 100; }

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
const sendMsg = async (text) => {
  await ev(`(() => {
    const ta = document.querySelector('textarea'); ta.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(250);
  await ev(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
};

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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);

  // 先建一个会话（右栏属于会话）
  await sendMsg('你好');
  await waitFor(`document.body.innerText.includes('好的。')`, 15000);

  // ---- R 用户自己打开右栏 ----
  const hasOpen = await waitFor(`!!document.querySelector('[data-testid="rail-open"]')`, 5000);
  await ev(`document.querySelector('[data-testid="rail-open"]')?.click()`);
  const launcher = await waitFor(`!!document.querySelector('[data-testid="rail-launcher"]')`, 5000);
  record('R1 顶栏「打开右栏」→ 新标签页（浏览器 / 文件 / 后台任务）', hasOpen && launcher
    && await ev(`['browser','files','tasks'].every((k) => document.querySelector('[data-testid="rail-launch-' + k + '"]'))`), '');
  await sleep(300);
  await shot('1-launcher.png');
  await ev(`document.querySelector('[data-testid="rail-launch-files"]').click()`);
  const files = await waitFor(`document.querySelectorAll('[data-testid="rail-file"]').length >= 2`, 8000);
  const launcherGone = await ev(`!document.querySelector('[data-rail-kind="launcher"]')`);
  record('R2 选「文件」：新标签页让位，列出项目文件', files && launcherGone, await ev(`[...document.querySelectorAll('[data-testid="rail-file"]')].map((x) => x.innerText.replace(/\\n/g, ' ')).join(' | ')`));
  await ev(`(() => { const s = document.querySelector('[data-testid="rail-files-search"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(s, 'readme'); s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(`document.querySelectorAll('[data-testid="rail-file"]').length === 1`, 5000);
  await shot('2-files.png');
  await ev(`document.querySelector('[data-testid="rail-file"]').click()`);
  const preview = await waitFor(`document.querySelector('[data-rail-body]')?.dataset.railActiveKind === 'artifact' && document.body.innerText.includes('hello from the files tab')`, 8000);
  record('R3 点文件 → 右栏预览（README.md 内容出现）', preview, '');
  await shot('3-file-preview.png');

  // ---- T AI 截图：工具行文件名可点；底部不堆截图 ----
  await sendMsg('打开那个页面看看');
  await waitFor(`document.body.innerText.includes('布局正常')`, 40000);
  await sleep(600);
  // 展开过程（默认可能收起）
  await ev(`[...document.querySelectorAll('button')].find((b) => /^Worked for/.test(b.innerText.trim()) && b.getAttribute('aria-expanded') !== 'true')?.click()`);
  const link = await waitFor(`!!document.querySelector('[data-testid="tool-image-link"]')`, 6000);
  const linkInfo = await ev(`(() => { const l = document.querySelector('[data-testid="tool-image-link"]'); return l ? { text: l.innerText, title: l.title } : null; })()`);
  const noPile = await ev(`!document.body.innerText.includes('检查截图')`);
  record('T1 浏览器截图那一行显示文件名（悬停是完整路径），底部没有「检查截图」堆积', link && /browser-.*\.png/.test(linkInfo?.text || '') && /finalcheck-shots/.test(linkInfo?.title || '') && noPile, JSON.stringify(linkInfo));
  await shot('4-tool-image-link.png');
  await ev(`document.querySelector('[data-testid="tool-image-link"]').click()`);
  const opened = await waitFor(`document.querySelector('[data-rail-body]')?.dataset.railActiveKind === 'artifact' && [...document.querySelectorAll('[data-rail-tab]')].some((x) => /browser-.*\\.png/.test(x.innerText))`, 8000);
  record('T2 点文件名 → 右栏打开那张截图', opened, '');
  await sleep(800);
  await shot('5-shot-in-rail.png');

  // ---- F 浏览器标签藏起来 → 冻结 ----
  // 现在右栏显示的是截图，浏览器标签藏着；等「AI 正在用」的 20s 宽限过去 + 一次巡检
  const t0 = Date.now();
  // 判据：rAF 帧数 10 秒不涨（不再绘制），且页面定时器回报 ≤ 1 次/秒（原本 2 次/秒）
  const frozenInfo = await (async () => {
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      await sleep(1000);
      const now = Date.now();
      const win = tickLog.filter(([ts]) => ts > now - 10000);
      const fs10 = win.map(([, f]) => f);
      const framesStill = fs10.length === 0 || Math.max(...fs10) === Math.min(...fs10);
      if (now - t0 > 12000 && framesStill && win.length <= 10) return { ok: true, rate: win.length / 10, at: Math.round((now - t0) / 1000) };
    }
    return { ok: false };
  })();
  record('F1 浏览器标签藏起来、没人用 → 冻结（不再绘制、定时器降速）', frozenInfo.ok, `${frozenInfo.at ?? '-'}s 时：rAF 10 秒没涨，定时器 ${frozenInfo.rate ?? '-'} 次/秒`);
  const cpuFrozen = await cpuOver(8000);
  // 对照：切回浏览器标签（显示出来，正常渲染）
  await ev(`[...document.querySelectorAll('[data-rail-tab]')].find((x) => x.dataset.railKind === 'browser')?.click()`);
  const ticking = await (async () => { const start = ticks; await sleep(3000); return ticks > start; })();
  const cpuShown = await cpuOver(8000);
  record('F2 切回浏览器标签 → 解冻，页面恢复', ticking, '');
  record('F3 冻结时整棵进程树 CPU 明显低于显示时', Number.isFinite(cpuFrozen) && cpuFrozen < cpuShown * 0.7, `冻结 ${cpuFrozen.toFixed(1)}%核  显示 ${cpuShown.toFixed(1)}%核`);
  // 再藏起来 → 冻结 → AI 用它 → 立刻能用
  await ev(`[...document.querySelectorAll('[data-rail-tab]')].find((x) => x.dataset.railKind === 'artifact')?.click()`);
  await sleep(30000); // 过了「AI 正在用」宽限 + 一次巡检 → 已冻结
  await sendMsg('再看一下页面');
  const alive = await waitFor(`/页面还活着，帧数 .*\\d+/.test(document.body.innerText)`, 30000);
  record('F4 冻结中的标签 AI 一用就解冻（browser_evaluate 正常返回）', alive, await ev(`(document.body.innerText.match(/页面还活着[^\\n]*/) || [''])[0]`));

  // ---- P 读私钥：问用户而不是拒绝 ----
  await sendMsg('读一下私钥');
  const card = await waitFor(`!!document.querySelector('[data-testid="ask-user-card"][data-status="pending"]')`, 20000);
  const cardText = await ev(`document.querySelector('[data-testid="ask-user-card"][data-status="pending"]')?.innerText || ''`);
  record('P1 读项目外私钥 → 弹卡问用户（三个选项），不是直接拒绝', card && /敏感文件/.test(cardText) && /允许这一次/.test(cardText) && /这个会话都允许/.test(cardText) && /不允许/.test(cardText), cardText.replace(/\n/g, ' ').slice(0, 200));
  await shot('6-policy-ask.png');
  await ev(`[...document.querySelectorAll('[data-testid="ask-user-option"]')].find((b) => b.innerText.trim() === '允许这一次')?.click()`);
  const read = await waitFor(`document.body.innerText.includes('密钥第二行是 PROBE-KEY-0339')`, 20000);
  record('P2 点「允许这一次」→ AI 读到了', read, '');
  await shot('7-policy-allowed.png');

  // ---- L 图片大图 ----
  const pasted = await ev(`(async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 400;
    const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 640, 400); gr.addColorStop(0, '#f3c67e'); gr.addColorStop(1, '#6b5cff');
    g.fillStyle = gr; g.fillRect(0, 0, 640, 400); g.fillStyle = '#111'; g.font = 'bold 44px sans-serif'; g.fillText('FinalCheck 0.33.9', 120, 215);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'probe.png', { type: 'image/png' }));
    const ta = document.querySelector('textarea'); ta.focus();
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  const thumb = await waitFor(`!!document.querySelector('[data-testid="composer-image"]')`, 8000);
  const thumbW = await ev(`Math.round(document.querySelector('[data-testid="composer-image"]')?.getBoundingClientRect().width || 0)`);
  await ev(`document.querySelector('[data-testid="composer-image"]')?.click()`);
  const lb1 = await waitFor(`!!document.querySelector('[data-testid="image-lightbox"] img')`, 4000);
  const lbSize = await ev(`(() => { const i = document.querySelector('[data-testid="image-lightbox"] img'); return i ? Math.round(i.getBoundingClientRect().width) : 0; })()`);
  record('L1 输入框里的图片缩略图 → 点开是大图', pasted && thumb && lb1 && lbSize > thumbW * 3, `缩略图 ${thumbW}px → 大图 ${lbSize}px`);
  await sleep(600); await shot('8-lightbox-composer.png');
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  const closed = await waitFor(`!document.querySelector('[data-testid="image-lightbox"]')`, 3000);
  record('L2 Esc 关大图', closed, '');
  await sendMsg('看看这张图');
  const msgImg = await waitFor(`!!document.querySelector('[data-testid="message-image"]')`, 15000);
  await ev(`document.querySelector('[data-testid="message-image"]')?.click()`);
  const lb2 = await waitFor(`!!document.querySelector('[data-testid="image-lightbox"] img')`, 4000);
  record('L3 我发出去的消息里的图片 → 点开是大图', msgImg && lb2, `msgImg=${msgImg} lb=${lb2} n=${await ev("document.querySelectorAll('[data-testid=message-image]').length")}`);
  await sleep(600); await shot('9-lightbox-message.png');
  await ev(`document.querySelector('[data-testid="lightbox-close"]')?.click()`);

  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 0.33.9 真界面验收 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
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
