// 打字回显延迟基线/对比探针（真 Electron + CDP）。
// 预置一条 60 条长消息的会话 → 打开 → 聚焦 textarea → 逐字符派发 25 个键（间隔 30ms）
// 指标：① 首键到最后一个字符出现在 textarea 的墙钟时间（地板 = 25×30ms + 最后一帧）
//      ② 打字期间 >50ms 的 longtask 数量与总时长（PerformanceObserver longtask）
// 用法：node scripts/probe-typing-latency.mjs [会话消息条数=60]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'probe-typing');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const PORT = 9351;
const N = Number(process.argv[2] || 60);

mkdirSync(out, { recursive: true });
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });

await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions', apiKey: 'test-key', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark'
}, null, 2), 'utf8');

process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
const sessionsLib = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const s1 = await sessionsLib.newSession('打字延迟');
const LONG = '长回答内容，用于撑起消息树高度与节点数。'.repeat(60); // ~1300 字
for (let i = 1; i <= N; i++) {
  await sessionsLib.appendUserMessage(s1.id, `问题 ${i}：请解释第 ${i} 个概念`);
  await sessionsLib.appendAssistantMessage(s1.id, { role: 'assistant', content: `回答 ${i}。${LONG}` });
}
console.log('[seed]', s1.id, `${N} 轮`);

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [
  path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'
], {
  env: { ...env, FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'), FINALCHECK_DEFAULT_PROJECT: projectDir,
    FINALCHECK_SESSIONS_DIR: sessionsDir },
  stdio: 'ignore', windowsHide: false
});

let ws = null; let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
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
    } catch { /* 还没起 */ }
  }
  if (!page) throw new Error('CDP 没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (!msg.id || !pending.has(msg.id)) return; const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error).slice(0, 200))) : res(msg.result); };

  for (let i = 0; i < 40; i++) { if (await ev("!!document.querySelector('textarea')").catch(() => false)) break; await sleep(500); }
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /跳过|Skip|稍后/i.test(x.textContent || '')); if (b) b.click(); })()`);
  await sleep(800);
  // 会话列表第一条即种子会话（自动起名含「问题 60」相关文本）——按包含匹配点第一条
  await ev(`(() => {
    const rows = [...document.querySelectorAll('button, [role="button"], div, a')]
      .map((x) => ({ el: x, text: (x.textContent || '').trim() }))
      .filter((x) => /回答 60|问题 60|打字延迟/.test(x.text) && x.text.length < 60)
      .sort((a, b) => a.text.length - b.text.length);
    const el = rows[0]?.el;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + 5, clientY: r.y + 5 };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    return 1;
  })()`);
  await sleep(1500);

  const msgCount = await ev("document.querySelectorAll('[data-midx]').length");
  console.log('[render] data-midx rows =', msgCount);

  // 装 longtask 观察器 + 聚焦
  await ev(`(() => {
    window.__lt = [];
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch (e) {}
    const ta = document.querySelector('textarea');
    ta.focus();
    return !!ta;
  })()`);
  await sleep(400);

  const TEXT = 'abc def 打字延迟测试 hello 123';
  const CHARS = [...TEXT];
  // 逐字符：原生 value setter + input 事件（等价真实 onChange 路径），量每次派发的同步主线程耗时
  const mlBefore = await ev('window.__mlRenders || 0');
  const typing = await ev(`(async () => {
    const ta = document.querySelector('textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const per = [];
    for (const ch of ${JSON.stringify(CHARS)}) {
      const t = performance.now();
      setter.call(ta, ta.value + ch);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      per.push(Math.round((performance.now() - t) * 10) / 10);
      await new Promise((r) => setTimeout(r, 30));
    }
    return JSON.stringify({ len: ta.value.length, per, ml: window.__mlRenders || 0 });
  })()`, );
  const { len, per, ml } = JSON.parse(typing);
  const over50 = per.filter((x) => x > 50);
  console.log(`[typing] 字符数=${CHARS.length} 落地=${len} 总同步耗时=${per.reduce((a, b) => a + b, 0).toFixed(1)}ms 单键均值=${(per.reduce((a, b) => a + b, 0) / per.length).toFixed(1)}ms 最慢=${Math.max(...per)}ms`);
  console.log(`[typing] >50ms 的键=${over50.length} 个 ${over50.length ? JSON.stringify(over50) : ''} | MessageList 渲染数=${(ml || 0) - (mlBefore || 0)}`);
  console.log(`RESULT ${JSON.stringify({ chars: CHARS.length, landed: len, totalMs: +per.reduce((a, b) => a + b, 0).toFixed(1), meanMs: +(per.reduce((a, b) => a + b, 0) / per.length).toFixed(1), maxMs: Math.max(...per), over50: over50.length, msgRows: msgCount })}`);
} finally {
  try { child.kill(); } catch { /* 已退出 */ }
}
