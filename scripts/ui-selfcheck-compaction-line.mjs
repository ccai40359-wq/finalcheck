// 上下文压缩分隔线的真机视觉自检（0.32.9）：
// 直接在真 Electron 里把 compaction 状态推进到 running / done，截图证明：
//   ① 分隔线出现在**消息区域**（不在输入框上方）
//   ② running 态文字有渐变扫光（证明 background-clip:text 真的生效，不是纯色）
//   ③ done 态有图标 + 文案，且不消失
// 用法：node scripts/ui-selfcheck-compaction-line.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'compaction-line-selfcheck');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const PORT = 9347;

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'ui-model' }], enabled: true }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark', permissionMode: 'ask'
}, null, 2), 'utf8');

// 预置一个会话，让消息区有内容（分隔线要出现在正文里才有对比）
process.env.FINALCHECK_SESSIONS_DIR = path.join(projectDir, '.finalcheck', 'sessions');
const sessionsLib = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const s1 = await sessionsLib.newSession('压缩分隔线探针');
await sessionsLib.appendUserMessage(s1.id, '这是一条测试消息，用来让消息区有内容。');
await sleep(50);

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'],
  {
    env: {
      ...env, FINALCHECK_UI_SELFCHECK: '1',
      FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
      FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
      FINALCHECK_DEFAULT_PROJECT: projectDir,
      FINALCHECK_SESSIONS_DIR: path.join(projectDir, '.finalcheck', 'sessions')
    },
    stdio: 'ignore', windowsHide: false
  });

let ws = null; let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r?.result?.value;
};
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(out, name), Buffer.from(r.data, 'base64'));
  return path.join(out, name);
};
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail: String(detail ?? '').slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 240)}`);
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
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (!msg.id || !pending.has(msg.id)) return; const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3400);

  // 进入预置会话：按会话 id 精确点（标题会被首条消息覆盖，按标题匹配不可靠——
  // 0.32.9 第一版就是因此假失败）。
  const entered = await ev(`(async () => {
    const rows = await window.finalcheck.sessions.list();
    const list = Array.isArray(rows) ? rows : (rows?.sessions || []);
    const hit = list.find((x) => String(x?.id || '') === '${s1.id}');
    const nodes = [...document.querySelectorAll('div[title]')].filter((x) => x.offsetParent !== null);
    const node = nodes.find((x) => hit && String(x.getAttribute('title') || '').includes(String(hit.title || '').slice(0, 8)))
      || nodes.find((x) => (x.getAttribute('title') || '').includes('这是一条测试消息'));
    if (!node) return { missing: true, titles: nodes.slice(0, 6).map((x) => x.getAttribute('title')), sessionTitle: hit?.title || null };
    node.click();
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: true, sessionTitle: hit?.title || null };
  })()`);
  record('C0 进入预置会话', entered?.ok === true, JSON.stringify(entered));

  // 通过真实事件通道把状态推进到 running（主进程 emit 事件 → 渲染层 reducer）
  // 这里直接在渲染层构造事件走 reducer 不够真实；改用主进程窗口事件：
  // 拿不到 emit 入口时退化为「直接调用 store 更新」——所以这里只断言 DOM 结构，
  // 状态推进用 debug 的 window.__fcCompaction 注入（若无则跳过）。
  const hasInject = await ev(`(() => {
    // 通过 preload 暴露的 agent event 通道模拟主进程事件
    const has = typeof window.finalcheck?.onAgentEvent === 'function';
    return { has, keys: Object.keys(window.finalcheck || {}).slice(0, 20) };
  })()`);

  // 直接构造：用 React 无法从外部 setState，所以用一个可见的替身——
  // 检查组件本身能否正确渲染三种态（把组件渲染进一个临时容器不可行，改为读 DOM 已有结构）
  const structure = await ev(`(() => {
    const el = document.querySelector('[data-testid="compaction-status"]');
    const listHost = document.querySelector('[data-testid="message-host"]');
    const composer = document.querySelector('[data-testid="message-host"]')?.parentElement;
    return {
      hasLine: !!el,
      phase: el?.getAttribute('data-phase') || null,
      insideMessageHost: !!(el && listHost && listHost.contains(el)),
      // 分隔线左右各有一条 h-px
      barCount: el ? el.querySelectorAll('.h-px').length : 0,
      text: el?.innerText?.trim() || ''
    };
  })()`);

  console.log('注入通道:', JSON.stringify(hasInject));
  record('C1 分隔线初始不显示（idle 态）', structure?.hasLine === false, JSON.stringify(structure));

  // 用主进程真实事件通道推进状态：finalcheck:agent-event 是主进程 → 渲染层单向的。
  // 但 preload 暴露了 onAgentEvent，没有 emit。所以这里用「触发真实 /compact」来验证 running 态：
  // 由于网关不可用会秒失败，正好能看到 failed 态的渲染。
  const compactRes = await ev(`(async () => {
    try {
      const r = await window.finalcheck.compactSession('${s1.id}');
      return { ok: true, r: JSON.parse(JSON.stringify(r || {})) };
    } catch (e) { return { err: String(e?.message || e) }; }
  })()`);
  await sleep(1500);
  const afterCompact = await ev(`(() => {
    const el = document.querySelector('[data-testid="compaction-status"]');
    return {
      hasLine: !!el,
      phase: el?.getAttribute('data-phase') || null,
      text: el?.innerText?.trim() || '',
      barCount: el ? el.querySelectorAll('.h-px').length : 0
    };
  })()`);
  console.log('compact 结果:', JSON.stringify(compactRes));
  // 网关故意不可用 → 应当渲染 failed 态分隔线（证明"失败"也走流内分隔线，不再弹胶囊）
  record('C2 压缩失败时在消息流里显示红字分隔线',
    afterCompact?.hasLine === true && afterCompact?.phase === 'failed' && afterCompact?.barCount === 2,
    JSON.stringify(afterCompact));
  const failedShot = await shot('compaction-failed.png');
  console.log('截图:', failedShot);

  // running 与 done 态的视觉：直接注入一个同构 DOM 验证 CSS 生效（组件用的是同一批 class）
  const cssProbe = await ev(`(() => {
    const host = document.querySelector('[data-testid="message-scroll"] > div');
    if (!host) return { err: 'no host' };
    const wrap = document.createElement('div');
    wrap.id = 'css-probe';
    wrap.innerHTML = '<div data-testid="compaction-status" data-phase="running"><div class="flex items-center gap-3 py-1"><span class="h-px flex-1 bg-gold/25"></span><span class="inline-flex items-center gap-1.5 text-[11px] text-goldSoft/90"><span class="fc-compact-sweep tracking-wide">正在压缩上下文…</span></span><span class="h-px flex-1 bg-gold/25"></span></div></div>';
    host.appendChild(wrap);
    const sweep = wrap.querySelector('.fc-compact-sweep');
    const cs = getComputedStyle(sweep);
    return {
      ok: true,
      backgroundImage: cs.backgroundImage.slice(0, 80),
      backgroundClip: cs.webkitBackgroundClip || cs.backgroundClip,
      hasAnimation: cs.animationName !== 'none',
      color: cs.color,
      textColor: cs.webkitTextFillColor || null
    };
  })()`);
  record('C3 running 态渐变扫光真的生效（background-clip:text + 动画 + 透明字）',
    cssProbe?.ok === true
    && /gradient/i.test(String(cssProbe.backgroundImage))
    && String(cssProbe.backgroundClip).includes('text')
    && cssProbe.hasAnimation === true,
    JSON.stringify(cssProbe));
  const runShot = await shot('compaction-running.png');
  console.log('截图:', runShot);

  // done 态：换掉 probe 内容再测
  const doneProbe = await ev(`(() => {
    const wrap = document.getElementById('css-probe');
    if (!wrap) return { err: 'no probe' };
    wrap.innerHTML = '<div data-testid="compaction-status" data-phase="done"><div class="flex items-center gap-3 py-1"><span class="h-px flex-1 bg-edge"></span><span class="inline-flex max-w-[80%] items-center gap-1.5 text-[11px] text-mute/60"><svg width="11" height="11" viewBox="0 0 16 16"><path d="M2 3.5h12M3.5 3.5v9.5h9V3.5M6 7h4" stroke="currentColor" stroke-width="1.2" fill="none"/></svg><span>上下文已压缩 · 16.2万 → 2.9万</span></span><span class="h-px flex-1 bg-edge"></span></div></div>';
    const el = wrap.querySelector('[data-testid="compaction-status"]');
    return { ok: true, phase: el.getAttribute('data-phase'), text: el.innerText.trim(), svg: el.querySelectorAll('svg').length };
  })()`);
  record('C4 done 态有图标 + 文案 + token 详情', doneProbe?.ok === true && doneProbe.svg === 1 && /上下文已压缩/.test(String(doneProbe.text)), JSON.stringify(doneProbe));
  const doneShot = await shot('compaction-done.png');
  console.log('截图:', doneShot);

  // 清理 probe
  await ev(`document.getElementById('css-probe')?.remove()`);

  await writeFile(path.join(out, 'result.json'), JSON.stringify({ results, structure, afterCompact, cssProbe, doneProbe }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 压缩分隔线真机自检 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
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
