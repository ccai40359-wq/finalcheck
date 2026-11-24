// 补充自检：把 slash 菜单滚到「自带技能」分组，截图证明 cn 短名（网页操作/桌面操控）已生效。
// 用真 DOM 滚动 + 真点击选中验证，而不是只看第一屏。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'slash-menu-selfcheck');
const userData = path.join(out, 'user-data-scroll');
const projectDir = path.join(out, 'project-scroll');
const PORT = 9343;

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'ui-model' }], enabled: true }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark', permissionMode: 'ask'
}, null, 2), 'utf8');

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'],
  { env: { ...env, FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'), FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'), FINALCHECK_DEFAULT_PROJECT: projectDir }, stdio: 'ignore', windowsHide: false });

let ws = null; let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r?.result?.value;
};
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 240)}`); };

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
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (!msg.id || !pending.has(msg.id)) return; const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3200);

  await ev(`(async () => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '/');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  })()`);

  // 滚到「自带技能」分组标题
  const scrolled = await ev(`(() => {
    const pop = document.querySelector('.glass-pop');
    const scroller = pop.querySelector('.overflow-y-auto');
    const head = [...pop.querySelectorAll('div')].find((d) => /uppercase/.test(d.className || '') && d.textContent.trim() === '自带技能');
    if (!head || !scroller) return { err: 'head/scroller missing' };
    scroller.scrollTop = head.offsetTop - 8;
    return { ok: true, top: scroller.scrollTop };
  })()`);
  record('S1 滚到「自带技能」分组', scrolled?.ok === true, JSON.stringify(scrolled));

  const rows = await ev(`(() => {
    const pop = document.querySelector('.glass-pop');
    const scroller = pop.querySelector('.overflow-y-auto');
    const visible = [...pop.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      const sr = scroller.getBoundingClientRect();
      const spans = [...b.querySelectorAll('span')].map((s) => s.textContent.trim());
      return { name: (spans[0] || '').replace(/^\\//, ''), desc: spans[1] || '', inView: r.top >= sr.top - 2 && r.bottom <= sr.bottom + 2 };
    }).filter((x) => x.inView);
    return visible;
  })()`);
  record('S2 分组内有自带技能的短名', Array.isArray(rows) && rows.some((r) => r.name.includes('browser-use')), JSON.stringify(rows?.slice(0, 4)));

  const shot1 = path.join(out, 'slash-zh-own-group.png');
  const r1 = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(shot1, Buffer.from(r1.data, 'base64'));
  console.log('截图:', shot1);

  // 真点击选中 /browser-use，确认输入框写成 `/browser-use `
  const typed = await ev(`(async () => {
    const pop = document.querySelector('.glass-pop');
    const btn = [...pop.querySelectorAll('button')].find((b) => (b.querySelector('span')?.textContent || '').trim() === '/browser-use');
    if (!btn) return { err: 'no browser-use row' };
    btn.click();
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, value: document.querySelector('textarea')?.value };
  })()`);
  record('S3 点击 /browser-use 正确插入', typed?.ok === true && /^\/browser-use\s?$/.test(String(typed.value || '').trim()), JSON.stringify(typed));

  await writeFile(path.join(out, 'result-scroll.json'), JSON.stringify({ results }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 分组滚动自检 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
