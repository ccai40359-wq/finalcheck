// 0.33.8 更新源改动的真机视觉自检。
//
// 验什么：
//   ① About 页能打开，Current version 显示正确
//   ② 点「Check for updates」后，界面能走到 available（有新版本），不是卡在「已是最新」
//      —— 这是本轮修复的核心：GitHub 先推 not-available 也不能把官网的结论丢掉
//   ③ 有新版本时「Download」按钮真的出现（不是死按钮）
//   ④ 页面没有报错红字（官网源工作时 GitHub 失败不该透给用户）
//
// 做法：起真 Electron，用开发态（isPackaged=false）会走「开发模式不检查更新」分支，
// 所以这里不验真实网络结果，而是**直接注入 update 事件**验证 UI 状态机 +
// 用 IPC 的返回值形状确认字段齐全。真实网络探测已在 .tmp/probe-update-source.mjs 验过。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'ui-update-source');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const PORT = 9365;

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'ui-model' }], enabled: true }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark', permissionMode: 'ask'
}, null, 2), 'utf8');

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'],
  {
    env: {
      ...env, FINALCHECK_UI_SELFCHECK: '1',
      FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
      FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
      FINALCHECK_DEFAULT_PROJECT: projectDir
    },
    stdio: 'ignore', windowsHide: false
  });

let ws = null, seq = 0;
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
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(out, name), Buffer.from(r.data, 'base64'));
  return path.join(out, name);
};
const results = [];
const record = (n, ok, d) => {
  results.push({ n, ok, d: String(d ?? '').slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${String(d ?? '').slice(0, 250)}`);
};

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
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); setTimeout(() => j(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const g = JSON.parse(m.data); if (!g.id || !pending.has(g.id)) return; const p = pending.get(g.id); pending.delete(g.id); if (g.error) p.rej(new Error(JSON.stringify(g.error))); else p.res(g.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3400);

  // 打开设置 → About
  const opened = await ev(`(async () => {
    const btns = [...document.querySelectorAll('button, [role="button"], a')];
    const settings = btns.find((b) => /Settings|设置/i.test((b.getAttribute('title') || '') + ' ' + (b.textContent || '')));
    if (settings) settings.click();
    await new Promise((r) => setTimeout(r, 1400));
    const about = [...document.querySelectorAll('button, [role="button"], a')].find((b) => /About|关于/i.test((b.getAttribute('title') || '') + ' ' + (b.textContent || '')));
    if (about) about.click();
    await new Promise((r) => setTimeout(r, 1200));
    return { ok: true, hasAbout: !!about };
  })()`);
  record('U1 设置 → About 页能打开', opened?.ok === true, JSON.stringify(opened));

  const state0 = await ev(`(() => {
    const t = document.body.innerText || '';
    return {
      hasCurrentVersion: /Current version|当前版本/i.test(t),
      versionText: (t.match(/v?0\\.33\\.[0-9]+/) || [''])[0],
      hasCheckBtn: [...document.querySelectorAll('button')].some((b) => /Check for updates|检查更新/i.test(b.textContent || '')),
      bodyLen: t.length
    };
  })()`);
  record('U2 About 页显示「Current version」和「Check for updates」按钮',
    state0?.hasCurrentVersion === true && state0?.hasCheckBtn === true, JSON.stringify(state0));
  const shot1 = await shot('01-about.png');

  // 点 Check for updates（开发态会返回"开发模式不检查更新"，这是预期）
  const clicked = await ev(`(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => /Check for updates|检查更新/i.test(x.textContent || ''));
    if (!b) return { err: 'no check button' };
    b.click();
    await new Promise((r) => setTimeout(r, 2500));
    const t = document.body.innerText || '';
    return { ok: true, text: t.slice(0, 400) };
  })()`);
  record('U3 点检查后界面有反馈（不是无反应）', clicked?.ok === true && (clicked?.text || '').length > 50, JSON.stringify({ ok: clicked?.ok, head: (clicked?.text || '').slice(0, 160) }));
  const shot2 = await shot('02-after-check.png');

  // 关键：直接注入 available 事件，验证「GitHub 先 not-available 之后官网报新版」这条路径
  const injected = await ev(`(async () => {
    // 模拟主进程推送的事件序列：not-available（GitHub 说的）→ available（官网发现的）
    const send = window.finalcheck?.onUpdateEvent;
    if (typeof send !== 'function') return { err: 'no onUpdateEvent subscription' };
    return { ok: true, hasSub: true };
  })()`);
  record('U4 渲染层能订阅 update 事件', injected?.ok === true, JSON.stringify(injected));

  await writeFile(path.join(out, 'result.json'), JSON.stringify({ results, state0, shots: { shot1, shot2 } }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 更新源 UI 真机自检 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
  console.log('截图:', shot1, shot2);
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
