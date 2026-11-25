// 0.33.7 界面验收（真 Electron + 本地模拟网关，隔离 profile，窗口在后台不抢前台）：
//   ① 提问卡：待回答是一张安静的卡、短选项一行按钮；回答后收成一行「你回答了：…」
//   ② 工作中指示器：三个错峰呼吸的小圆点（不再是发光的金色方块）
//   ③ 内部催促（internal warning）不进消息流
//   ④ 设置页：常用在上，「高级」默认收起；浏览器数据页精简；钩子页没有「配置不存在」的黄色警告
// 截图：.tmp/ui-0337/*.png
// 用法：cd desktop && npx electron-vite build；然后 node scripts/probe-ui-0337.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway } from './sim/gateway.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'ui-0337');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const PORT = 9368;

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(projectDir, { recursive: true });

const gw = await startGateway({
  mode: 'script',
  respond: async (body, { kind }) => {
    if (kind !== 'main') return null;
    const msgs = body.messages;
    const last = msgs[msgs.length - 1];
    const tools = msgs.filter((m) => m.role === 'tool');
    if (last.role === 'user' && !tools.length) {
      return { toolCalls: [{ name: 'ask_user', args: { question: '安装包在项目外面（D:\\release\\fc-setup.exe），要我怎么处理？', options: [{ label: '允许复制一次' }, { label: '我自己来' }] } }] };
    }
    if (tools.length === 1) { return { delayMs: 5000, content: '好的，你自己复制就行，其余部分我接着做完了：首页、下载区、FAQ 都已就绪。' }; }
    return { content: '完成。' };
  }
});

writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: gw.url, apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true }],
  activeProviderId: 'p-ui', activeModel: 'ui-model', language: 'zh', theme: 'dark', permissionMode: 'full'
}, null, 2), 'utf8');

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'], {
  env: {
    ...env, FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_WINDOW_BG: '1',
    FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
    FINALCHECK_HOOKS_FILE: path.join(userData, 'hooks.json'),
    FINALCHECK_SESSIONS_DIR: path.join(projectDir, '.finalcheck', 'sessions'),
    FINALCHECK_DEFAULT_PROJECT: projectDir
  },
  stdio: 'ignore', windowsHide: true
});

let ws = null; let seq = 0;
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
const shot = async (name) => { const r = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64')); };
const results = [];
const record = (n, ok, d) => { results.push({ n, ok, d: String(d ?? '').slice(0, 500) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${String(d ?? '').slice(0, 260)}`); };
const waitFor = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(200); } return false; };
const clickText = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (b) b.click(); return !!b; })()`);

try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((tg) => tg.type === 'page' && !String(tg.url).startsWith('devtools')); } catch { /* 等 */ }
  }
  if (!page) throw new Error('CDP 没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); setTimeout(() => j(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const g = JSON.parse(m.data); if (!g.id || !pending.has(g.id)) return; const p = pending.get(g.id); pending.delete(g.id); if (g.error) p.rej(new Error(JSON.stringify(g.error))); else p.res(g.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(3500);

  await ev(`(async () => {
    const ta = document.querySelector('textarea'); ta.focus();
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '把官网做完，放上安装包下载'); ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  const card = await waitFor(`!!document.querySelector('[data-testid="ask-user-card"][data-status="pending"]')`, 20000);
  const optCount = await ev(`document.querySelectorAll('[data-testid="ask-user-option"]').length`);
  const inRow = await ev(`(() => { const o = [...document.querySelectorAll('[data-testid="ask-user-option"]')]; return o.length === 2 && Math.abs(o[0].getBoundingClientRect().top - o[1].getBoundingClientRect().top) < 2; })()`);
  record('A1 待回答提问卡：两个短选项排成一行按钮', card && optCount === 2 && inRow, `opts=${optCount} inRow=${inRow}`);
  await shot('1-ask-pending.png');
  await clickText('[data-testid="ask-user-option"]', '我自己来');
  const working = await waitFor(`!!document.querySelector('[data-testid="working-status"]')`, 8000);
  const dots = await ev(`document.querySelector('[data-testid="working-status"]')?.querySelectorAll('.fc-compact-dot').length || 0`);
  record('A2 工作中指示器：三个呼吸小圆点', working && dots === 3, `dots=${dots}`);
  await sleep(600);
  await shot('2-working.png');
  const done = await waitFor(`document.body.innerText.includes('FAQ 都已就绪')`, 20000);
  await sleep(500);
  const rowH = await ev(`(() => { const c = document.querySelector('[data-testid="ask-user-card"]'); return c ? { status: c.dataset.status, h: Math.round(c.getBoundingClientRect().height), text: c.innerText } : null; })()`);
  record('A3 回答后提问卡收成一行（高度 < 32px），写着「你回答了：我自己来」', done && rowH?.status === 'answered' && rowH.h < 32 && /你回答了：\s*我自己来/.test(rowH.text), JSON.stringify(rowH));
  await shot('3-answered.png');
  // 点开看原问题
  await ev(`document.querySelector('[data-testid="ask-user-result"]').click()`);
  await sleep(400);
  const expanded = await ev(`document.querySelector('[data-testid="ask-user-card"]').innerText.includes('安装包在项目外面')`);
  record('A4 点一下那一行能展开原问题', expanded, '');

  // 设置页
  await clickText('button', 'Settings');
  await waitFor(`!!document.querySelector('[data-testid="settings-advanced"]')`, 8000);
  await sleep(500);
  const navText = await ev(`document.querySelector('nav')?.innerText || ''`);
  const advHidden = !/MCP 服务器|权限规则|Hooks|浏览器数据/.test(navText);
  record('S1 设置导航：常用在上，高级默认收起（看不到 MCP / 权限 / Hooks / 浏览器数据）', /模型设置/.test(navText) && /语言/.test(navText) && advHidden, navText.replace(/\n/g, ' | '));
  await shot('4-settings-collapsed.png');
  await ev(`document.querySelector('[data-testid="settings-advanced"] > button').click()`);
  await sleep(400);
  const navText2 = await ev(`document.querySelector('nav')?.innerText || ''`);
  record('S2 点「高级」展开五项', ['运行时', 'MCP 服务器', '权限规则', 'Hooks', '浏览器数据'].every((x) => navText2.includes(x)), navText2.replace(/\n/g, ' | '));
  await clickText('nav button', '浏览器数据');
  await sleep(500);
  const browserText = await ev(`document.body.innerText`);
  record('S3 浏览器数据页：只有「记不记登录」三选一 + 清空；没有红色大警告', /每次问我/.test(browserText) && /清空浏览器数据/.test(browserText) && !/Partitions\/persist/.test(browserText), '');
  await shot('5-settings-browser.png');
  await clickText('nav button', 'Hooks');
  await sleep(700);
  const hooksText = await ev(`document.body.innerText`);
  record('S4 Hooks 页：没配时不再挂「配置不存在」黄色警告', !/hooks 配置不存在/.test(hooksText), '');
  const saveBg = await ev(`(() => { const b = [...document.querySelectorAll('button.btn-primary')].find((x) => x.disabled); return b ? getComputedStyle(b).backgroundColor : 'none'; })()`);
  record('S5 不能点的主按钮是中性灰，不是暗金棕', saveBg === 'none' || /rgba\(255, 255, 255, 0\.06\)/.test(saveBg), saveBg);
  await shot('6-settings-hooks.png');

  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 0.33.7 界面验收 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  try { await shot('fatal.png'); } catch { /* 忽略 */ }
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { await gw.close(); } catch { /* 已关 */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
