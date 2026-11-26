// 0.34.1 缩放真机验收：走 window-ctl 的 zoom-in/out/reset（before-input-event 拦不到 CDP 合成键，
// 这是 Chromium 的已知行为，所以用 IPC 路径验证同一条缩放逻辑）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const PORT = 9393;
const OUT = path.join(root, '.tmp', 'ui-0341b');
await mkdir(OUT, { recursive: true });
const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _s, ...env } = process.env;

const child = spawn(electronExe, [path.join(root, 'desktop'), '--no-first-run', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(OUT, 'profile')}`],
  { env: { ...env, FINALCHECK_UI_SELFCHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
let err = '';
child.stderr.on('data', (d) => { err += String(d).slice(0, 2000); });

let ws = null, seq = 0; const pend = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p }));
  setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('to ' + m)); } }, 30000);
});
const ev = async (x) => {
  const r = await cdp('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 260));
  return r?.result?.value;
};
const ok = [];
const check = (n, v, d = '') => { ok.push(v); console.log(`  ${v ? '✅' : '❌'} ${n}${d ? '  ' + d : ''}`); };

try {
  let page = null;
  for (let i = 0; i < 80; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page'); if (page) break; } catch { /* 等 */ } }
  if (!page) throw new Error('CDP 没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); setTimeout(() => j(new Error('ws to')), 12000); });
  ws.onmessage = (m) => { const g = JSON.parse(m.data); if (!g.id || !pend.has(g.id)) return; const p = pend.get(g.id); pend.delete(g.id); g.error ? p.rej(new Error(JSON.stringify(g.error))) : p.res(g.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3500);

  const hasApi = await ev('typeof window.finalcheck?.windowCtl === "function"');
  check('preload 暴露 windowCtl', hasApi === true);

  const dp = () => ev('window.devicePixelRatio');
  const before = await dp();

  const call = (a) => ev(`window.finalcheck.windowCtl('${a}').then(r => JSON.stringify(r))`);

  // 放大两档
  await call('zoom-in'); await sleep(400);
  const z1 = await dp();
  await call('zoom-in'); await sleep(400);
  const z2 = await dp();
  check('zoom-in 生效（第一档）', z1 > before, `${before} → ${z1}`);
  check('zoom-in 生效（第二档）', z2 > z1, `${z1} → ${z2}`);

  // 缩小两档
  await call('zoom-out'); await sleep(400);
  const z3 = await dp();
  check('zoom-out 生效', z3 < z2, `${z2} → ${z3}`);

  // 复位
  await call('zoom-reset'); await sleep(400);
  const z4 = await dp();
  check('zoom-reset 回到 1', Math.abs(z4 - 1) < 0.35, String(z4));

  // 窗口状态接口仍正常（0.34.0 加的那个返回值）
  const st = await ev("window.finalcheck.windowCtl('noop').then(r => JSON.stringify(r))");
  check('windowCtl 返回真实状态', /visible/.test(String(st)), String(st).slice(0, 80));

  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(OUT, '01-zoom-ok.png'), Buffer.from(shot.data, 'base64'));

  const pass = ok.filter(Boolean).length;
  console.log(`\n=== ${pass}/${ok.length} 通过 ===`);
  console.log('截图：' + OUT);
  process.exitCode = pass === ok.length ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.message || e);
  if (err) console.error('--- stderr ---\n' + err.slice(0, 800));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* 已退 */ }
  await sleep(600);
  process.exit(process.exitCode || 0);
}
