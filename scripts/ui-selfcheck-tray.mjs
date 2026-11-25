// 0.34.0 托盘真机验收：启动真 Electron → 关窗口 → 断言窗口还在但不可见 → 从托盘唤回。
//
// 为什么不能只用静态断言：preventDefault 有没有真的挡住销毁、win.hide() 之后 show() 还能不能回来，
// 只有真 Electron 能回答。这个脚本就是那道证据。
//
// 用法：node scripts/ui-selfcheck-tray.mjs
// 产物：.tmp/tray-selfcheck/*.png + 控制台 JSON 结论
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const PORT = 9388;
const OUT = path.join(root, '.tmp', 'tray-selfcheck');
await mkdir(OUT, { recursive: true });

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _skip, ...env } = process.env;

// 用独立 userData，避免动用户真实会话；注意**不能**设 FINALCHECK_UI_SELFCHECK=1——
// 那个模式下 index.mjs 故意不建托盘（见 source 里的 trayWanted）。
const child = spawn(electronExe, [
  path.join(root, 'desktop'),
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--disable-gpu',
  '--no-sandbox',
  `--user-data-dir=${path.join(OUT, 'profile')}`
], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });

let childErr = '';
child.stderr.on('data', (d) => { childErr += String(d).slice(0, 4000); });

let ws = null;
let seq = 0;
const pending = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + m)); } }, 60000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r?.result?.value;
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
};

try {
  // 1. 等 CDP 起来
  let page = null;
  for (let i = 0; i < 80; i += 1) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* 还没起来 */ }
  }
  if (!page) throw new Error('CDP 没起来。stderr:\n' + childErr.slice(0, 1500));

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(new Error('ws 连不上'));
    setTimeout(() => j(new Error('ws 超时')), 15000);
  });
  ws.onmessage = (m) => {
    const g = JSON.parse(m.data);
    if (!g.id || !pending.has(g.id)) return;
    const p = pending.get(g.id);
    pending.delete(g.id);
    if (g.error) p.rej(new Error(JSON.stringify(g.error)));
    else p.res(g.result);
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await sleep(3000);

  const healthy = await ev('document.body.innerText.trim().length > 0');
  check('界面正常渲染（托盘会影响 close 行为，不能把窗口搞白屏）', healthy === true);

  // 截图 1：正常状态
  const shot1 = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(OUT, '01-before-close.png'), Buffer.from(shot1.data, 'base64'));

  // 2. 通过自绘标题栏的关闭通道触发（渲染层拿不到 BrowserWindow，只有这条 IPC）
  const beforeClose = await ev('({ visibility: document.visibilityState, closed: window.closed })');
  check('关窗之前 document 可达', beforeClose && beforeClose.closed === false);

  // 3. 触发关闭：必须走**自绘标题栏那条真实路径** window.finalcheck.windowCtl('close')。
  //    `window.close()` 在 Electron 里对「不是脚本打开的」页面是空操作，
  //    用它来验等于什么都没测（第一版就踩了这个坑：断言「已隐藏」拿到了 visible）。
  const closedByCtl = await ev("window.finalcheck.windowCtl('close').then((r) => JSON.stringify(r || null)).catch((e) => 'err:' + e.message)");
  check('关闭请求已发出（windowCtl close）', typeof closedByCtl === 'string' && closedByCtl.startsWith('{'), String(closedByCtl));
  await sleep(2500);

  // 3.5 从主进程拿真实窗口可见性。
  // 不能用 document.visibilityState：index.mjs 故意关掉 CalculateNativeWinOcclusion /
  // WidgetInitVisibilityDispatch（后台不节流），页面永远报 visible —— 第一版就因此假红一次。
  const afterHide = await ev("window.finalcheck.windowCtl('noop').then((r) => JSON.stringify(r || null))");
  let winVisible = null;
  try { winVisible = JSON.parse(afterHide)?.visible; } catch { /* 解不出就留 null */ }
  check('窗口真的被隐藏了（主进程 isVisible()===false）', winVisible === false, `isVisible=${winVisible}`);

  // 4. 关键断言：CDP target 还活着 = webContents 没被销毁 = preventDefault 生效
  let pageAlive = false;
  let stillSameTarget = false;
  try {
    const list2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p2 = list2.find((t) => t.type === 'page');
    pageAlive = !!p2;
    stillSameTarget = !!(p2 && page && p2.id === page.id);
  } catch { /* 拿不到就是死了 */ }
  check('关窗口后 webContents 没被销毁（preventDefault 生效）', pageAlive);
  check('还是同一个 target（不是重开了一个新窗口）', stillSameTarget);

  if (pageAlive) {
    // 5. 页面状态还在（DOM 还有内容 = 会话没丢）
    const afterClose = await ev('({ textLen: document.body.innerText.trim().length })');
    check('关窗之后页面 DOM 还在（会话没丢）', (afterClose?.textLen || 0) > 0, `textLen=${afterClose?.textLen}`);

    // 6. 进程还活着
    check('Electron 进程仍在运行（不是退出了）', child.exitCode === null, `exitCode=${child.exitCode}`);

    // 7. 模拟「点托盘图标」：托盘 click 回调做的就是 show + focus。
    //    这里没有真鼠标，改为直接调同一个 IPC（'maximize' 会 show 不了，所以用一个显式的
    //    'show' 动作——见 index.mjs 的 window-ctl，0.34.0 为托盘补的）。
    const shown = await ev("window.finalcheck.windowCtl('show').then((r) => JSON.stringify(r || null))");
    let visibleAfter = null;
    try { visibleAfter = JSON.parse(shown)?.visible; } catch { /* 留 null */ }
    check('从托盘唤回：窗口重新可见', visibleAfter === true, `isVisible=${visibleAfter}`);

    // 8. 唤回之后页面仍可交互（不是靠重开一个新窗口糊过去的）
    const interactive = await ev('(() => { document.title = "tray-check"; return document.title; })()');
    check('唤回之后页面仍可交互（同一个 webContents）', interactive === 'tray-check');
  }

  const shot2 = pageAlive ? await cdp('Page.captureScreenshot', { format: 'png' }) : null;
  if (shot2) await writeFile(path.join(OUT, '02-after-close.png'), Buffer.from(shot2.data, 'base64'));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} 通过 ===`);
  console.log('截图：' + OUT);
  if (childErr.trim()) console.log('\n--- Electron stderr（前 800 字）---\n' + childErr.slice(0, 800));
  process.exitCode = pass === results.length ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.message || e);
  if (childErr.trim()) console.error('--- stderr ---\n' + childErr.slice(0, 2000));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* 已退 */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
