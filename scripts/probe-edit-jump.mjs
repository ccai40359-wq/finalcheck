// 0.34.6：点历史消息上的「编辑」→ 视口回到那条消息（滚动到中央 + 金圈高亮），真机 Electron + CDP 自检。
//
// 前置：本脚本自己启动应用（FINALCHECK_UI_SELFCHECK=1 隔离 userData），预置一条多轮长会话。
// 步骤：
//   ① 打开会话 → 滚到底部 → 点【第一条】用户消息的编辑按钮
//      → 断言：气泡挂上 .fc-msg-flash；~1.6s 后该行回到视口内；scrollTop 大幅上移；输入框回填原文
//   ② 再滚到底部 → 点【最后一条】用户消息（本来就在视口内）的编辑按钮
//      → 断言：挂 .fc-msg-flash；scrollTop 基本不动（已可见就不折腾滚动条）
// 用法：node scripts/probe-edit-jump.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'probe-edit-jump');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const PORT = 9341; // 避开 9223/9224/9331-9336

mkdirSync(out, { recursive: true });
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });

await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{
    id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions',
    apiKey: 'test-key', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true
  }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark'
}, null, 2), 'utf8');

// 预置多轮长会话：4 轮 ×（用户短句 + AI 2000 字长答）→ 一定会超出视口高度
const sessionTitle = '编辑跳转自检';
process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
const sessionsLib = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const s1 = await sessionsLib.newSession(sessionTitle);
const LONG = '长回答。'.repeat(500); // 2000 字
for (let i = 1; i <= 4; i++) {
  await sessionsLib.appendUserMessage(s1.id, `问题 ${i}：这是第 ${i} 条用户消息`);
  await sessionsLib.appendAssistantMessage(s1.id, { role: 'assistant', content: `回答 ${i}。${LONG}` });
}
await sessionsLib.appendUserMessage(s1.id, '最后一条短消息');
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
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r?.result?.value;
};

const results = [];
const record = (step, name, ok, detail) => {
  results.push({ step, name, ok, detail: String(detail ?? '').slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${step}] ${name}  ${String(detail ?? '').slice(0, 200)}`);
};
const OUT = 'D:/rcw-geo/.fc-bench2/ui-check';
mkdirSync(OUT, { recursive: true });
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, name);
  await writeFile(p, Buffer.from(r.data, 'base64'));
  console.log(`[shot] ${p}`);
  return p;
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
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error).slice(0, 300))) : res(msg.result);
  };

  // 等 textarea 就绪 + 点掉首启卡
  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = await ev("!!document.querySelector('textarea')").catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error('textarea 未出现');
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /跳过|Skip|稍后/i.test(x.textContent || '')); if (b) { b.click(); return 1; } return 0; })()`);
  await sleep(500);

  // 打开预置会话（完整指针序列，React 合成事件才认）
  const opened = await ev(`(() => {
    const rows = [...document.querySelectorAll('button, [role="button"], div, a')]
      .filter((x) => (x.textContent || '').trim() === ${JSON.stringify(sessionTitle)});
    const el = rows[rows.length - 1];
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + 5, clientY: r.y + 5 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return 1;
  })()`);
  await sleep(1200);
  const autoRows = await ev("document.querySelectorAll('[data-midx]').length");
  record('boot', '打开预置会话（点了或已自动打开）', opened === 1 || autoRows >= 5, `clicked=${opened} rows=${autoRows}`);

  // 消息行渲染就绪（data-midx 是本次新增的锚点）
  let rows = 0;
  for (let i = 0; i < 20; i++) {
    rows = await ev("document.querySelectorAll('[data-midx]').length");
    if (rows >= 5) break;
    await sleep(500);
  }
  record('boot', '消息行渲染（data-midx ≥ 5）', rows >= 5, `rows=${rows}`);

  // ① 滚到底 → 点第一条用户消息的编辑按钮（带诊断采样）
  const first = await ev(`(() => {
    const el = document.querySelector('[data-testid="message-scroll"]');
    el.scrollTop = el.scrollHeight;
    const row = document.querySelector('[data-midx="0"]');
    if (!row) return JSON.stringify({ ok: false, why: 'no row 0' });
    const btn = [...row.querySelectorAll('button')].find((b) => /编辑|Edit/.test(b.title || ''));
    if (!btn) return JSON.stringify({ ok: false, why: 'no edit btn' });
    const before = el.scrollTop;
    const host = el.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
    const r = btn.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + 5, clientY: r.y + 5 };
    btn.dispatchEvent(new PointerEvent('pointerdown', opts));
    btn.dispatchEvent(new MouseEvent('mousedown', opts));
    btn.dispatchEvent(new PointerEvent('pointerup', opts));
    btn.dispatchEvent(new MouseEvent('mouseup', opts));
    btn.dispatchEvent(new MouseEvent('click', opts));
    return JSON.stringify({
      ok: true, before, flashNow: row.className.includes('fc-msg-flash'),
      scrollH: el.scrollHeight, clientH: el.clientHeight,
      hostTop: Math.round(host.top), hostH: Math.round(host.height),
      rowTop: Math.round(box.top), rowBottom: Math.round(box.bottom),
      inViewCalc: box.top >= host.top && box.bottom <= host.bottom,
      cvOffNow: el.className.includes('cv-off')
    });
  })()`);
  const f1 = JSON.parse(first);
  record('①', '点第一条的编辑：按钮存在且点了', f1.ok === true, f1.why || JSON.stringify({ scrollH: f1.scrollH, clientH: f1.clientH, hostTop: f1.hostTop, hostH: f1.hostH, rowTop: f1.rowTop, rowBottom: f1.rowBottom, inViewCalc: f1.inViewCalc, cvOffNow: f1.cvOffNow }));
  record('①', '点击后立刻挂上 .fc-msg-flash', f1.flashNow === true, `flashNow=${f1.flashNow}`);

  // 截图证据：滚动+高亮动画进行中（~700ms，金圈还在、视口已到目标）
  await sleep(700);
  await shot('edit-jump-01-scrolled-flash.png');

  // 采样滚动位置变化
  let waited = 0;
  for (const ms of [150, 400, 800, 1500, 2100]) {
    await sleep(ms - waited);
    waited = ms;
    const st = await ev("document.querySelector('[data-testid=\"message-scroll\"]').scrollTop + '|' + document.querySelector('[data-testid=\"message-scroll\"]').className.includes('cv-off')");
    console.log(`[sample ${ms}ms] scrollTop/cv-off = ${st}`);
  }
  const errs = await ev('JSON.stringify(window.__errs || [])');
  console.log('[window errors]', errs);
  const after1 = await ev(`(() => {
    const el = document.querySelector('[data-testid="message-scroll"]');
    const row = document.querySelector('[data-midx="0"]');
    const host = el.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return JSON.stringify({
      after: el.scrollTop,
      inView: box.top >= host.top - 40 && box.bottom <= host.bottom + 40,
      flashStill: row.className.includes('fc-msg-flash'),
      input: document.querySelector('textarea').value
    });
  })()`);
  const a1 = JSON.parse(after1);
  record('①', '滚动发生（scrollTop 大幅上移）', a1.after < f1.before - 200, `${f1.before} → ${a1.after}`);
  record('①', '1.9s 后该行在视口内', a1.inView === true, JSON.stringify(a1).slice(0, 120));
  record('①', '输入框回填原文（原行为不回归）', a1.input === '问题 1：这是第 1 条用户消息', `input="${a1.input.slice(0, 40)}"`);
  await shot('edit-jump-02-final-state.png');

  // ② 滚到底 → 点最后一条用户消息（在视口内）→ scrollTop 不动，只高亮
  const second = await ev(`(() => {
    const el = document.querySelector('[data-testid="message-scroll"]');
    el.scrollTop = el.scrollHeight;
    const rows = document.querySelectorAll('[data-midx]');
    const row = rows[rows.length - 1];
    const btn = [...row.querySelectorAll('button')].find((b) => /编辑|Edit/.test(b.title || ''));
    if (!btn) return JSON.stringify({ ok: false, why: 'no edit btn' });
    const before = el.scrollTop;
    const r = btn.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + 5, clientY: r.y + 5 };
    btn.dispatchEvent(new PointerEvent('pointerdown', opts));
    btn.dispatchEvent(new MouseEvent('mousedown', opts));
    btn.dispatchEvent(new PointerEvent('pointerup', opts));
    btn.dispatchEvent(new MouseEvent('mouseup', opts));
    btn.dispatchEvent(new MouseEvent('click', opts));
    return JSON.stringify({ ok: true, before, flashNow: row.className.includes('fc-msg-flash') });
  })()`);
  const f2 = JSON.parse(second);
  record('②', '点最后一条（已在视口内）的编辑', f2.ok === true, f2.why || '');
  await sleep(700);
  const after2 = await ev(`(() => {
    const el = document.querySelector('[data-testid="message-scroll"]');
    const rows = document.querySelectorAll('[data-midx]');
    return JSON.stringify({ after: el.scrollTop, flash: rows[rows.length - 1].className.includes('fc-msg-flash') });
  })()`);
  const a2 = JSON.parse(after2);
  record('②', '已在视口内：scrollTop 基本不动（±60px）', Math.abs(a2.after - f2.before) <= 60, `${f2.before} → ${a2.after}`);
  record('②', '高亮仍然挂上', a2.flash === true, `flash=${a2.flash}`);
  await shot('edit-jump-03-inview-flash.png');
} catch (e) {
  record('FATAL', e.message, false, '');
} finally {
  try { child.kill(); } catch { /* 已退出 */ }
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n==== edit-jump selfcheck: ${pass}/${results.length} PASS, ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
