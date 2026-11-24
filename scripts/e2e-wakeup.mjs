// 0.32.7 定时唤醒的真机验收：起真 Electron → 建一条短延时任务 → 到点**真的起一个回合**。
//
// 设计原则（和用户对齐过）：**默认真网关**。
//   定时唤醒 = 到点模拟用户发一条消息，跑到点后就是普通回合 —— 真模型才能看出
//   "这条唤醒消息是否被正常执行"。假网关只能证明管道通（`--fake` 只留给离线回归）。
//
// 刻意不做的：不验"无人值守工具白名单"——那套机制已删除。
//   理由：产品本来就有审批闸（edit_file/write_file/run_command 都要用户点批准，
//   人不在场 120 秒后自动拒绝），再自造一套白名单只是重复实现，
//   而且它正是前几轮 UNATTENDED_ALLOW / UNATTENDED_SCHEMA 两个作用域 bug 的来源。
//
// 用法：node scripts/e2e-wakeup.mjs        真网关（读 %APPDATA%/FinalCheck/config.json）
//       node scripts/e2e-wakeup.mjs --fake  离线回归
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'e2e-wakeup');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const PORT = 9338;
const DELAY = '12s';
const WAIT_MS = 60_000;
const USE_FAKE = process.argv.includes('--fake');

mkdirSync(out, { recursive: true });
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });
await mkdir(projectDir, { recursive: true }).catch(() => {});

let llmCalls = 0;
const fakeGateway = createServer((req, res) => {
  if (!req.url.startsWith('/v1/chat/completions')) { res.writeHead(404); return res.end('nf'); }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    llmCalls += 1;
    const text = `定时唤醒回合已执行（第 ${llmCalls} 次模型调用）。`;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const c of [
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ]) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

let llmConfig = null;
if (USE_FAKE) {
  await new Promise((r) => fakeGateway.listen(0, '127.0.0.1', r));
  llmConfig = { baseUrl: `http://127.0.0.1:${fakeGateway.address().port}/v1`, apiKey: 'test-key', model: 'ui-model', providerId: 'p-ui' };
  console.log('[mode] FAKE gateway（只验管道）');
} else {
  const fs = await import('node:fs/promises');
  for (const file of [process.env.FC_E2E_CONFIG || '', path.join(process.env.APPDATA || '', 'FinalCheck', 'config.json')].filter(Boolean)) {
    let raw;
    try { raw = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
    const providers = (raw?.providers || []).filter((p) => p && p.enabled !== false && p.baseUrl && p.apiKey && (p.models || []).length);
    if (!providers.length) continue;
    const pick = providers.find((p) => p.id === raw.activeProviderId) || providers[0];
    const m = pick.models[0];
    llmConfig = { baseUrl: String(pick.baseUrl), apiKey: String(pick.apiKey), model: typeof m === 'string' ? m : (m?.id || ''), providerId: pick.id };
    console.log('[mode] REAL gateway', llmConfig.baseUrl, 'model=' + llmConfig.model);
    break;
  }
  if (!llmConfig) {
    console.error('找不到真网关配置（查过 %APPDATA%/FinalCheck/config.json）。只想验管道请加 --fake。');
    process.exit(2);
  }
}
console.log('[delay]', DELAY);

await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{
    id: llmConfig.providerId || 'p-ui', name: 'Wakeup Probe', baseUrl: llmConfig.baseUrl,
    apiFormat: 'chat-completions', apiKey: llmConfig.apiKey,
    models: [{ id: llmConfig.model, contextWindow: 200000 }], enabled: true
  }],
  activeProviderId: llmConfig.providerId || 'p-ui', language: 'zh', theme: 'dark', permissionMode: 'ask'
}, null, 2), 'utf8');

process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
const sessionsLib = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const s1 = await sessionsLib.newSession('定时唤醒探针');
await sessionsLib.appendUserMessage(s1.id, '先占个位，让会话有历史');
await sessionsLib.renameSession(s1.id, '定时唤醒探针');
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
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};

const results = [];
const record = (step, name, ok, detail) => {
  results.push({ step, name, ok, detail: String(detail ?? '').slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${step}] ${name}  ${String(detail ?? '').slice(0, 220)}`);
};

// 读目标会话的 assistant 条数（判据用"会话里真的多了一条回复"，不钉文案）
const SESSION_JS = `(async () => {
  const rows = await window.finalcheck.sessions.list();
  const list = Array.isArray(rows) ? rows : (rows?.sessions || []);
  const hit = list.find((x) => String(x?.title || '').includes('定时唤醒探针')) || list[0];
  if (!hit) return { found: false, assistants: 0 };
  const s = await window.finalcheck.sessions.open(hit.id);
  const msgs = s?.messages || [];
  return { found: true, assistants: msgs.filter((m) => m.role === 'assistant').length, total: msgs.length };
})()`;

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
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3400);

  const sched = await ev(`window.finalcheck.wakeups.list().catch(e => ({ error: String(e?.message || e) }))`);
  record('W0', '主进程调度器已启动', sched?.ok === true && sched?.running === true,
    JSON.stringify({ ok: sched?.ok, running: sched?.running, err: sched?.error }));

  const entered = await ev(`(async () => {
    const rows = [...document.querySelectorAll('div[title]')].filter((x) => (x.getAttribute('title') || '').startsWith('定时唤醒探针') && x.offsetParent !== null);
    if (!rows.length) return { missing: true };
    rows[0].click();
    await new Promise((r) => setTimeout(r, 1600));
    return { ok: true };
  })()`);
  record('W1', '进入真实会话', entered?.missing !== true, JSON.stringify(entered));

  const created = await ev(`(async () => {
    const rows = await window.finalcheck.sessions.list();
    const list = Array.isArray(rows) ? rows : (rows?.sessions || []);
    const hit = list.find((x) => String(x?.title || '').includes('定时唤醒探针')) || list[0];
    if (!hit) return { added: false, err: 'no session' };
    const r = await window.finalcheck.wakeups.add({ sessionId: hit.id, prompt: '用一句话报告你看到的当前时间', delay: '${DELAY}' });
    const l = await window.finalcheck.wakeups.list();
    return { added: r?.ok === true, err: r?.error || null, count: (l?.items || []).length };
  })()`);
  record('W2', '定时任务建成功', created?.added === true && (created?.count || 0) >= 1, JSON.stringify(created));

  const sub = await ev(`({ has: typeof window.finalcheck?.onWakeupDue === 'function' })`);
  record('W2b', '渲染层能订阅定时唤醒事件', sub?.has === true, JSON.stringify(sub));
  await ev(`(window.__wakeEvents = [], window.finalcheck.onWakeupDue((p) => { window.__wakeEvents.push(p); }), 'ok')`);

  const before = await ev(SESSION_JS);
  const startedAt = Date.now();
  let woke = { ranNotice: false, failNotice: false, assistants: before?.assistants || 0, events: 0, remaining: 0 };
  while (Date.now() - startedAt < WAIT_MS) {
    await sleep(2000);
    const snap = await ev(`(async () => {
      const body = document.body.innerText || '';
      const s = await ${SESSION_JS};
      return {
        // 判据认两种：实时提示（handler 加的）或落库的唤醒通知（重载会话后从历史读回来）
        ranNotice: body.includes('定时唤醒已执行') || body.includes('定时唤醒触发'),
        failNotice: body.includes('执行失败') || body.includes('没能切到目标会话') || body.includes('发送失败'),
        assistants: s.assistants,
        events: (window.__wakeEvents || []).length,
        remaining: (await window.finalcheck.wakeups.list().catch(() => ({ items: [] })))?.items?.length || 0
      };
    })()`);
    woke = snap || woke;
    if ((woke.assistants || 0) > (before?.assistants || 0) && woke.ranNotice) break;
  }
  record('W3', '到点真的起了新回合（会话里多了一条 assistant 回复）',
    (woke.assistants || 0) > (before?.assistants || 0),
    JSON.stringify({ before: before?.assistants, after: woke.assistants, events: woke.events, mode: USE_FAKE ? 'fake' : 'real' }));
  record('W4', '界面显示「定时唤醒已执行」，且没有失败提示',
    woke.ranNotice === true && woke.failNotice === false,
    JSON.stringify({ ranNotice: woke.ranNotice, failNotice: woke.failNotice }));
  record('W5', '只跑一次的任务执行后被移除（不留残留）',
    (woke.remaining ?? 1) === 0, JSON.stringify({ remaining: woke.remaining }));

  await writeFile(path.join(out, 'result.json'), JSON.stringify({ results, llmCalls, created, woke, mode: USE_FAKE ? 'fake' : 'real' }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 定时唤醒真机验收（${USE_FAKE ? '假网关' : '真网关'}） ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}） ===`);
  console.log('证据:', out);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { fakeGateway.close(); } catch { /* 已关 */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
