// Settings 页自检 v3：
//   ① 点左下角 Settings（这是固定英文文案的按钮，与页面导航区分）
//   ② 在设置页左侧导航里点 Runtime
//   ③ 截图 + 断言沙箱说明文案
// 上一版 v2 直接在全页搜 "Runtime"，结果在工作区页面上命中别的东西、把页面切走了。
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = process.argv[2] || '9224';
const OUT = 'D:/rcw-geo/.fc-bench2/ui-check';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws timeout')), 10000); });

let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, 'base64'));
  console.log('[shot]', `${OUT}/${name}`);
  return `${OUT}/${name}`;
};

await send('Runtime.enable');
await sleep(400);

// ① 左下角 Settings 按钮（文案固定是 Settings，带齿轮图标）
const entered = await ev(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const b = btns.find((x) => (x.textContent || '').trim().startsWith('Settings'));
  if (!b) return 'not-found';
  b.click();
  return 'ok';
})()`);
console.log('[enter settings]', entered);
await sleep(1500);

// ② 确认真的进了设置页（有 "Back to workspace" 才对）
const onSettings = await ev(`(document.body.innerText || '').includes('Back to workspace')`);
console.log('[on settings page]', onSettings);
if (!onSettings) throw new Error('没进设置页');

// ③ 设置页左侧导航里的 Runtime（是 <nav> 内那一项，且排除标题区）
const clickedRuntime = await ev(`(() => {
  const nav = [...document.querySelectorAll('button,a,[role=button]')].filter((x) => {
    const tx = (x.textContent || '').trim();
    return tx === 'Runtime';
  });
  if (!nav.length) return 'not-found';
  nav[0].click();
  return 'ok:' + nav.length;
})()`);
console.log('[click Runtime]', clickedRuntime);
await sleep(1500);

// ④ 断言文案
const checks = await ev(`(() => {
  const text = document.body.innerText || '';
  const has = (s) => text.includes(s);
  return {
    onRuntimePage: text.includes('Agent / Runtime'),
    banner: has('not a real sandbox') || has('不是真沙箱'),
    workspaceDesc: has('cross-directory work needs you') || has('跨目录需你在消息里点名'),
    offModeNote: has('ignore the mode') || has('不看 mode'),
    gitBash: has('Git Bash'),
    containerHint: has('container') || has('WSL') || has('容器'),
    noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2,
    cardCount: [...document.querySelectorAll('button')].filter((b) => /\\b(workspace|readonly|off)\\b/.test(b.textContent || '') && (b.textContent || '').length < 600).length
  };
})()`);
console.log('[checks]', JSON.stringify(checks, null, 1));

const p1 = await shot('settings-runtime.png');

const bad = [];
for (const k of ['onRuntimePage', 'banner', 'workspaceDesc', 'offModeNote', 'gitBash', 'containerHint', 'noHorizontalOverflow']) {
  if (checks[k] !== true) bad.push(k);
}
if (bad.length) {
  console.error('FAIL:', bad.join(', '));
  console.error('截图:', p1);
  ws.close();
  process.exit(1);
}
console.log('PASS 沙箱说明文案全部就位');
console.log('截图:', p1);
ws.close();
process.exit(0);
