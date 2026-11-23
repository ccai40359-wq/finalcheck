// 0.31.0 浏览器会话设置页自检：启动 FC（隔离 userData + CDP），点进「设置 → 浏览器会话」，
// 截图并断言：模式卡片、持久标识、清空按钮、无横向溢出。
//
// 用法：node scripts/ui-selfcheck-browser-session.mjs
// 证据：.tmp/browser-session-ui/

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'browser-session-ui');
const userData = path.join(out, 'user-data');
const PORT = 9331; // 自检用的 CDP 端口（与 9223 / 9224 都不同）
mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });

// 预置配置：有可用供应商（跳过首次向导）+ 浏览器会话「未选择」（应显示为一次性）
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{
    id: 'p-ui', name: 'UI Test', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions',
    apiKey: 'test-key', models: ['ui-model'], enabled: true
  }],
  activeProviderId: 'p-ui',
  language: 'zh',
  theme: 'dark'
}, null, 2), 'utf8');

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;

// 启动：隔离 userData + 自检模式 + CDP 端口
const child = spawn(electronExe, [
  path.join(root, 'desktop'),
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userData}`,
  '--no-first-run'
], {
  env: { ...env, FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json') },
  stdio: 'ignore', windowsHide: false
});

let ws = null;
let seq = 0;
const pending = new Map(); // id → { res, rej }

// CDP 请求：统一发完就等 id 对应的结果；handler 在 connect 后立刻挂好（不能等第一次发送后才挂）
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => {
    if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); }
  }, 30000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
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

try {
  // 等 CDP 起来
  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools'));
      if (page) break;
    } catch { /* 还没起来 */ }
  }
  if (!page) throw new Error('CDP 40s 内没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  // handler 必须在第一条消息发出前挂好：先 open，再挂 onmessage，最后才开始发请求
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
    else p.res(msg.result);
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await sleep(2500); // 等渲染层首屏

  // ① 进设置页（左下角 Settings 按钮，文案固定英文）
  const entered = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('Settings'));
    if (!b) return 'not-found';
    b.click(); return 'ok';
  })()`);
  console.log('[enter settings]', entered);
  await sleep(1200);
  const onSettings = await ev(`(document.body.innerText || '').includes('Back to workspace') || (document.body.innerText || '').includes('返回工作区')`);
  if (!onSettings) throw new Error('没进设置页');
  await shot('01-settings.png');

  // ② 点左侧导航「浏览器会话」
  const clicked = await ev(`(() => {
    const items = [...document.querySelectorAll('button,a,[role=button]')].filter((x) => {
      const tx = (x.textContent || '').trim();
      return tx === '浏览器会话' || tx === 'Browser session' || tx.startsWith('浏览器会话');
    });
    if (!items.length) return 'not-found';
    items[0].click(); return 'ok:' + items.length;
  })()`);
  console.log('[click 浏览器会话]', clicked);
  await sleep(1200);
  await shot('02-browser-session.png');

  // ③ 断言
  const checks = await ev(`(() => {
    const text = document.body.innerText || '';
    const has = (s) => text.includes(s);
    return {
      onBrowserPage: has('浏览器会话') && (has('会话模式') || has('Session mode')),
      oneShotCard: has('一次性（无痕）'),
      persistentCard: has('长期保留'),
      clearButton: has('清空浏览器数据'),
      privacyNote: has('不碰你日常用的 Edge') || has('共享电脑') || has('不写磁盘'),
      modeBanner: has('当前为一次性') || has('当前正在记住登录'),
      noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
      saveButton: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '保存' || (b.textContent || '').trim() === 'Save')
    };
  })()`);
  console.log('[checks]', JSON.stringify(checks, null, 1));

  // ④ 切到持久模式 → 保存 → 断言持久标识变红
  const toPersistent = await ev(`(() => {
    const cards = [...document.querySelectorAll('button')].filter((b) => (b.textContent || '').includes('长期保留'));
    if (!cards.length) return 'not-found';
    cards[0].click(); return 'ok';
  })()`);
  console.log('[click 长期保留]', toPersistent);
  await sleep(500);
  const saved = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '保存' || (x.textContent || '').trim() === 'Save');
    if (!b) return 'no-save';
    b.click(); return 'ok';
  })()`);
  console.log('[click 保存]', saved);
  await sleep(2000);
  await shot('03-persistent-mode.png');
  const persistentMark = await ev(`(() => {
    const text = document.body.innerText || '';
    return { remembers: text.includes('当前正在记住登录') || text.includes('Currently remembering'), len: text.length };
  })()`);
  console.log('[persistent mark]', JSON.stringify(persistentMark));

  const bad = [];
  for (const k of ['onBrowserPage', 'oneShotCard', 'persistentCard', 'clearButton', 'privacyNote', 'modeBanner', 'noHorizontalOverflow', 'saveButton']) {
    if (checks[k] !== true) bad.push(k);
  }
  if (!persistentMark.remembers) bad.push('persistentMarkAfterSave');
  if (bad.length) {
    console.error('FAIL:', bad.join(', '));
    process.exitCode = 1;
  } else {
    console.log('PASS 浏览器会话设置页：模式卡片/清空按钮/持久标识/无溢出 全部就位');
    console.log('截图:', path.join(out, '01-settings.png'), path.join(out, '02-browser-session.png'), path.join(out, '03-persistent-mode.png'));
  }
} finally {
  try { ws?.close(); } catch { /* 已关 */ }
  try { child.kill('SIGTERM'); } catch { /* 已退 */ }
  await sleep(800);
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-Process | Where-Object { $_.MainWindowTitle -like '*FinalCheck*' } | Stop-Process -Force -ErrorCount 0`],
    { windowsHide: true, timeout: 15000 });
}
