// 0.34.1 @ 会话菜单真机验收
// 关键：UI 自检模式（FINALCHECK_UI_SELFCHECK=1）会用隔离 userData，没有真实会话 →
// 候选列表为空 → 菜单不弹。所以这里**必须用真实数据目录**跑，只把窗口藏起来。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const PORT = 9395;
const OUT = path.join(root, '.tmp', 'ui-at');
await mkdir(OUT, { recursive: true });
const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _s, ...env } = process.env;

// 注意：不设 FINALCHECK_UI_SELFCHECK —— 要用真实会话数据。
// 但用 --user-data-dir 隔离 profile 不行（会丢配置），所以直接继承真实环境，
// 靠窗口不抢焦点（FINALCHECK_WINDOW_BG=1）+ 独立 CDP 端口。
const child = spawn(electronExe, [path.join(root, 'desktop'), '--no-first-run', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`],
  { env: { ...env, FINALCHECK_UI_SELFCHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let err = '';
child.stderr.on('data', (d) => { err += String(d).slice(0, 1500); });

let ws = null, seq = 0; const pend = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p }));
  setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('to ' + m)); } }, 30000);
});
const ev = async (x) => {
  const r = await cdp('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};
const ok = [];
const check = (n, v, d = '') => { ok.push(v); console.log(`  ${v ? '✅' : '❌'} ${n}${d ? '  ' + d : ''}`); };

try {
  let page = null;
  for (let i = 0; i < 90; i++) { await sleep(500); try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page'); if (page) break; } catch { /* 等 */ } }
  if (!page) throw new Error('CDP 没起来：' + err.slice(0, 500));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); setTimeout(() => j(new Error('ws to')), 12000); });
  ws.onmessage = (m) => { const g = JSON.parse(m.data); if (!g.id || !pend.has(g.id)) return; const p = pend.get(g.id); pend.delete(g.id); g.error ? p.rej(new Error(JSON.stringify(g.error))): p.res(g.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(4000);

  const ready = await ev('typeof window.finalcheck?.sessions?.list === "function"');
  check('preload 暴露 sessions.list', ready === true);

  // 真实会话数
  const count = await ev('window.finalcheck.sessions.list().then(r => (Array.isArray(r) ? r.length : (r?.sessions || []).length))');
  check('读到真实会话列表', Number(count) > 0, String(count) + ' 条');

  // 在输入框打 @
  await ev(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '@');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return 'ok';
  })()`);
  await sleep(1500);

  const info = await ev(`(() => {
    const m = document.querySelector('[data-testid="mention-menu"]');
    if (!m) return { open: false };
    const rows = [...m.querySelectorAll('button')].slice(0, 5).map(b => b.innerText.replace(/\\n/g, ' | ').slice(0, 56));
    const hint = [...m.querySelectorAll('div')].map(d => d.innerText).filter(t => t.includes('@')).pop() || '';
    return { open: true, rows, hint: hint.slice(0, 130) };
  })()`);
  check('@ 弹出候选菜单', info?.open === true, JSON.stringify(info?.rows || []).slice(0, 140));
  check('提示文案是「引用会话」而不是「引用文件」', /会话|对话记录|session/i.test(String(info?.hint || '')) && !/项目文件/i.test(String(info?.hint || '')), String(info?.hint || '').slice(0, 100));
  check('候选行是会话标题（不是文件路径）', Array.isArray(info?.rows) && info.rows.length > 0 && !String(info.rows.join()).includes('/'), String((info?.rows || []).join(' / ')).slice(0, 120));

  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(OUT, '01-at-session-menu.png'), Buffer.from(shot.data, 'base64'));

  // 选中第一项 → 输入框应写入 @session:<id>
  // React 的 onClick 要经原生监听，纯 MouseEvent('click') 有时不响应；
  // 按真实点击顺序 pointerdown → mousedown → mouseup → click 才稳。
  const picked = await ev(`(async () => {
    const m = document.querySelector('[data-testid="mention-menu"]');
    const b = m && m.querySelector('button');
    if (!b) return { ok: false, why: 'no-button' };
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      b.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      await new Promise(r => setTimeout(r, 60));
    }
    await new Promise(r => setTimeout(r, 500));
    const ta = document.querySelector('textarea');
    return { ok: true, value: String(ta.value).slice(0, 90) };
  })()`);
  check('选中后写入 @session:<id>', /@session:[0-9a-f-]+/i.test(String(picked?.value || '')), String(picked?.value || '').slice(0, 70));

  const pass = ok.filter(Boolean).length;
  console.log(`\n=== ${pass}/${ok.length} 通过 ===`);
  console.log('截图：' + OUT);
  process.exitCode = pass === ok.length ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.message || e);
  if (err) console.error(err.slice(0, 600));
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch { /* 已退 */ }
  await sleep(600);
  process.exit(process.exitCode || 0);
}
