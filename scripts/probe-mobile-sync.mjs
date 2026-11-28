// 0.35 手机访问真机验收：真 Electron（隔离 profile、后台窗口、假网关）+ Edge 无头当手机，两边同时看同一个引擎。
//   P  电脑设置页生成配对码 → 手机打开配对链接自动配上，进到和电脑一样的界面
//   N  手机发新消息（新会话）→ 电脑侧栏马上出现这个会话，点开内容一致
//   L  电脑正看着这个会话，手机发一条慢回复 → 电脑不刷新、实时接上，回复只出现一次
//   R  反过来：电脑发 → 手机实时看到
//   A  手机发需要审批的操作 → 两边都弹卡；手机点「允许一次」→ 电脑的卡自动收起，回合继续
//   D  每条用户消息网关只收到一轮主请求（没有两边各发一遍）
// 截图：.tmp/mobile-sync/*.png
// 用法：cd desktop && npx electron-vite build；然后 node scripts/probe-mobile-sync.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startGateway } from './sim/gateway.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'mobile-sync');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const project2Dir = path.join(out, 'second-proj');
const secretDir = path.join(out, 'outside');
const keyFile = path.join(secretDir, 'id_rsa'); // 敏感路径：完全权限下也要弹卡问
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const CDP_PORT = await freePort();
const MOBILE_PORT = await freePort();

mkdirSync(out, { recursive: true });
for (const d of [userData, projectDir, project2Dir, secretDir]) { await rm(d, { recursive: true, force: true }).catch(() => {}); await mkdir(d, { recursive: true }); }
// 自检模式下主进程把数据目录放在系统临时目录的 fc-ui-selfcheck（和真实数据隔离，但跨次保留）：清掉上次配对的设备
await rm(path.join(os.tmpdir(), 'fc-ui-selfcheck', 'mobile-access.json'), { force: true });
if (existsSync(path.join(userData, 'mobile-access.json'))) throw new Error('上次的探针进程还没退出，user-data 清不掉');
await writeFile(path.join(projectDir, 'README.md'), '# demo\n', 'utf8');
await writeFile(keyFile, 'OUTSIDE-NOTE-035\n', 'utf8');

const mainTurns = new Map(); // 用户消息 → 主请求轮数（第一轮）
const gw = await startGateway({
  mode: 'script',
  respond: async (body, { kind }) => {
    if (kind === 'title') return { content: /第二个项目/.test(JSON.stringify(body.messages)) ? '项目二会话' : '模拟会话' };
    if (kind !== 'main') return null;
    const msgs = body.messages;
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user');
    const userText = String(msgs[lastUserIdx]?.content || '');
    const since = msgs.slice(lastUserIdx + 1).filter((m) => m.role === 'tool');
    if (since.length === 0) { const k = userText.replace(/\s+/g, ' ').slice(-40); mainTurns.set(k, (mainTurns.get(k) || 0) + 1); }
    if (/慢慢说/.test(userText)) {
      if (since.length === 0) return { toolCalls: [{ name: 'read_file', args: { path: path.join(projectDir, 'README.md') } }] };
      return { content: '慢慢说完了 SLOW-END-OK', delayMs: 4000 };
    }
    if (/写一个笔记文件/.test(userText)) {
      if (since.length === 0) return { toolCalls: [{ name: 'write_file', args: { path: path.join(projectDir, 'approved.txt'), content: 'APPROVED-WRITE' } }] };
      const c = String(since[0].content || '');
      return { content: existsSync(path.join(projectDir, 'approved.txt')) ? '读到了 APPROVED-READ-OK' : `没读到：${c.slice(0, 80)}` };
    }
    if (/电脑发的/.test(userText)) return { content: '收到电脑的消息 DESK-REPLY-OK' };
    if (/第二个项目/.test(userText)) return { content: '第二个项目收到 PROJ2-OK' };
    if (/手机发的/.test(userText)) return { content: '收到手机的消息 PHONE-REPLY-OK' };
    return { content: '好的。' };
  }
});

writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ms', name: 'Probe', baseUrl: gw.url, apiFormat: 'chat-completions', apiKey: 'probe-secret-key', models: [{ id: 'ms-model', contextWindow: 200000 }], enabled: true }],
  activeProviderId: 'p-ms', activeModel: 'ms-model', language: 'zh', theme: 'dark', permissionMode: 'ask', browserSessionMode: 'oneshot'
}, null, 2), 'utf8');

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [path.join(root, 'desktop'), `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`, '--no-first-run'], {
  env: {
    ...env, FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_WINDOW_BG: '1', FINALCHECK_MOBILE_PORT: String(MOBILE_PORT),
    FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
    FINALCHECK_HOOKS_FILE: path.join(userData, 'hooks.json'),
    FINALCHECK_SESSIONS_DIR: path.join(projectDir, '.finalcheck', 'sessions'),
    FINALCHECK_DEFAULT_PROJECT: projectDir
  },
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
});
let errLog = '';
child.stderr.on('data', (d) => { errLog += d; });

const results = [];
const record = (n, ok, d) => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${String(d ?? '').slice(0, 300)}`); };
const playwright = createRequire(path.join(root, 'package.json'))('playwright-core');
let browser; let desk; let phone;
const text = (p) => p.evaluate(() => document.body.innerText);
const count = async (p, re) => ((await text(p)).match(new RegExp(re.source, 'g')) || []).length;
const waitText = async (p, re, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(await text(p).catch(() => ''))) return true; await sleep(250); } return false; };
const send = async (p, msg) => { const ta = p.locator('textarea').first(); await ta.click(); await ta.fill(msg); await p.keyboard.press('Enter'); };
// 侧栏里每个项目下挂着哪些会话：[项目名, 会话标题…]
const rowTitles = () => [...document.querySelectorAll('.fc-sidebar div.cursor-pointer.rounded-lg')].map((r) => (r.classList.contains('pl-1') ? '#' : '') + (r.querySelector('span.truncate')?.textContent || '').trim());
const sessionsUnder = (rows, proj) => { const i = rows.indexOf('#' + proj); if (i < 0) return null; const titles = []; for (const r of rows.slice(i + 1)) { if (r.startsWith('#')) break; titles.push(r); } return titles; };
const shot = (p, name) => p.screenshot({ path: path.join(out, name + '.png') });

try {
  // ---- 电脑：接上 Electron 窗口 ----
  let cdpOk = false;
  for (let i = 0; i < 80 && !cdpOk; i++) { await sleep(500); cdpOk = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.ok).catch(() => false); }
  if (!cdpOk) throw new Error('Electron 没起来：\n' + errLog.slice(-2000));
  const eb = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  for (let i = 0; i < 40 && !desk; i++) {
    desk = eb.contexts().flatMap((c) => c.pages()).find((p) => !/devtools|fc-snapshot/.test(p.url()) && /index\.html|localhost/.test(p.url()));
    if (!desk) await sleep(250);
  }
  if (!desk) throw new Error('找不到电脑窗口');
  desk.setDefaultTimeout(15000);
  await desk.setViewportSize({ width: 1360, height: 860 }).catch(() => {});
  await desk.locator('textarea').first().waitFor();

  // P：电脑设置页 → 手机访问 → 生成配对码
  const st = await desk.evaluate(() => window.finalcheck.mobile.state());
  if (!st.running) throw new Error('手机访问服务没起来：' + JSON.stringify(st));
  await desk.locator('.fc-sidebar button', { hasText: /Settings|设置/ }).first().click();
  await desk.locator('nav.glass-side button', { hasText: '手机访问' }).click();
  await desk.getByRole('button', { name: '生成配对码' }).click();
  await desk.locator('[data-testid="mobile-pair"]').waitFor();
  const link = await desk.locator('[data-testid="mobile-pair"] input').nth(1).inputValue();
  await shot(desk, '01-desktop-settings');
  await desk.locator('nav.glass-side button', { hasText: '返回工作区' }).click();

  browser = await playwright.chromium.launch({ channel: process.env.FC_MOBILE_TEST_CHANNEL || 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  phone = await ctx.newPage();
  phone.setDefaultTimeout(15000);
  phone.errors = [];
  phone.on('pageerror', (e) => phone.errors.push(e.message));
  phone.on('request', (r) => { if (/\/api\/pair/.test(r.url())) console.log('[phone] pair', r.postData()); });
  phone.on('framenavigated', (f) => { if (f === phone.mainFrame()) console.log('[phone] nav', f.url()); });
  // FC_PROBE_STATS=1：统计手机发了哪些调用、多大、同时挂着几个（FC_PROBE_LATENCY 模拟隧道往返延迟，毫秒）
  if (process.env.FC_PROBE_STATS) {
    const lat = Number(process.env.FC_PROBE_LATENCY || 0);
    if (lat) { const cdp = await ctx.newCDPSession(phone); await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: lat, downloadThroughput: -1, uploadThroughput: -1 }); }
    const stats = (globalThis.__fcStats = { byCh: new Map(), inflight: 0, peak: 0, t0: Date.now(), total: 0 });
    phone.on('request', (r) => {
      if (!/\/api\//.test(r.url())) return;
      let ch = r.url().replace(/.*\/api\//, '/api/').replace(/\?.*/, '');
      const body = r.postData() || '';
      if (ch === '/api/rpc') { try { ch = JSON.parse(body).channel; } catch { /* 忽略 */ } }
      const e = stats.byCh.get(ch) || { n: 0, bytes: 0, max: 0 }; e.n++; e.bytes += body.length; e.max = Math.max(e.max, body.length); stats.byCh.set(ch, e);
      stats.total++; stats.inflight++; stats.peak = Math.max(stats.peak, stats.inflight);
      r.__t = Date.now();
    });
    const done = (r) => { if (/\/api\//.test(r.url())) stats.inflight--; };
    phone.on('requestfinished', done); phone.on('requestfailed', done);
  }
  await phone.goto(link);
  await phone.locator('textarea').first().waitFor();
  const st2 = await desk.evaluate(() => window.finalcheck.mobile.state());
  record('P 配对链接一打开就配上，进到同一套界面', !!st2.device && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(phone.url()), `device=${st2.device?.deviceName} url=${phone.url()}`);
  const keyLeak = await phone.evaluate(async () => JSON.stringify(await window.finalcheck.getConfig()).includes('probe-secret-key'));
  record('P 手机拿不到 API Key', !keyLeak, '');

  // N：手机发新消息 → 电脑侧栏出现，点开一致
  await send(phone, '手机发的第一条');
  const phoneGot = await waitText(phone, /PHONE-REPLY-OK/);
  const deskRows = desk.locator('.fc-sidebar div.cursor-pointer.rounded-lg.pl-2');
  let rowShown = false;
  for (let i = 0; i < 40 && !rowShown; i++) { rowShown = (await deskRows.count()) > 0; if (!rowShown) await sleep(250); }
  if (rowShown) await deskRows.first().click();
  const deskSaw = await waitText(desk, /PHONE-REPLY-OK/, 10000);
  await shot(desk, '02-desktop-sees-phone-session');
  record('N 手机发的新会话：电脑侧栏马上出现，点开内容一致', phoneGot && rowShown && deskSaw, `phone=${phoneGot} row=${rowShown} desk=${deskSaw}`);

  // L：电脑正看着，手机发慢回复 → 电脑实时接上
  await send(phone, '慢慢说');
  const runningSeen = await waitText(desk, /慢慢说/, 6000);
  const liveBeforeEnd = !(/SLOW-END-OK/.test(await text(desk)));
  const deskSlow = await waitText(desk, /SLOW-END-OK/, 20000);
  const phoneSlow = await waitText(phone, /SLOW-END-OK/, 10000);
  await sleep(1200);
  const dupDesk = await count(desk, /SLOW-END-OK/);
  const dupPhone = await count(phone, /SLOW-END-OK/);
  await shot(desk, '03-desktop-live-attach');
  await shot(phone, '03-phone-live');
  record('L 手机发的回合电脑实时接上（不用刷新），回复只出现一次', runningSeen && liveBeforeEnd && deskSlow && phoneSlow && dupDesk === 1 && dupPhone === 1, `user-msg=${runningSeen} live=${liveBeforeEnd} desk=${deskSlow}/${dupDesk} phone=${phoneSlow}/${dupPhone}`);

  // R：电脑发 → 手机看到
  await send(desk, '电脑发的一条');
  const deskR = await waitText(desk, /DESK-REPLY-OK/);
  const phoneR = await waitText(phone, /DESK-REPLY-OK/, 10000);
  const phoneUser = /电脑发的一条/.test(await text(phone));
  await shot(phone, '04-phone-sees-desktop');
  record('R 电脑发的消息手机实时看到（用户消息 + 回复）', deskR && phoneR && phoneUser, `desk=${deskR} phone=${phoneR} userMsg=${phoneUser}`);

  // M：电脑侧栏的手机按钮（设置按钮旁）→ 面板里看得到连着的手机、在线；能出配对二维码；手机网页上没有这个按钮
  const mBtn = desk.locator('.fc-sidebar [data-ui="mobile-button"]');
  const mBtnGreen = await mBtn.evaluate((el) => el.className.includes('text-emerald-400'));
  await mBtn.click();
  const panel = desk.locator('[data-testid="mobile-panel"]');
  await panel.waitFor();
  const devText = await panel.locator('[data-testid="mobile-device"]').innerText();
  await panel.getByRole('button', { name: /配对新手机/ }).click();
  await panel.locator('[data-testid="mobile-qr"]').waitFor();
  const qrBox = await panel.locator('[data-testid="mobile-qr"]').boundingBox();
  const panelBox = await panel.boundingBox();
  await shot(desk, '04b-desktop-mobile-panel');
  await desk.keyboard.press('Escape');
  await sleep(300);
  const panelGone = (await panel.count()) === 0;
  const phoneHasBtn = await phone.locator('[data-ui="mobile-button"]').count();
  record('M 侧栏手机按钮：绿色=在线，面板显示连着的手机、能出二维码，Esc 关闭；手机网页上没有这个按钮',
    mBtnGreen && /在线/.test(devText) && qrBox?.width > 100 && panelBox.y >= 0 && panelBox.x >= 0 && qrBox.x >= panelBox.x && panelGone && phoneHasBtn === 0,
    `green=${mBtnGreen} dev=${JSON.stringify(devText)} qr=${qrBox?.width} panel=${JSON.stringify(panelBox)} qrX=${qrBox?.x} gone=${panelGone} phoneBtn=${phoneHasBtn}`);

  // A：审批卡两边同步
  await send(phone, '写一个笔记文件');
  const phoneCard = await waitText(phone, /允许一次/, 15000);
  const deskCard = await waitText(desk, /允许一次/, 15000);
  await shot(desk, '05-desktop-approval');
  if (phoneCard) await phone.getByRole('button', { name: /允许一次/ }).first().click();
  const phoneDone = await waitText(phone, /APPROVED-READ-OK/, 15000);
  const deskDone = await waitText(desk, /APPROVED-READ-OK/, 15000);
  await sleep(800);
  const deskCardGone = !(/允许一次/.test(await text(desk)));
  await shot(desk, '06-desktop-approval-closed');
  await shot(phone, '06-phone-after-approve');
  record('A 手机点允许 → 电脑的审批卡自动收起、两边都看到结果', phoneCard && deskCard && phoneDone && deskDone && deskCardGone, `cards=${phoneCard}/${deskCard} done=${phoneDone}/${deskDone} deskGone=${deskCardGone}`);

  // X：手机在另一个项目里开会话，电脑的当前项目 / 侧栏不被带走（之前的 bug：电脑侧栏把别的项目的会话挂到自己项目下）
  const deskProjBefore = await desk.evaluate(() => window.finalcheck.projects.current());
  const deskRowsBefore = await desk.evaluate(rowTitles);
  await desk.evaluate((d) => window.finalcheck.projects.add(d), project2Dir);
  await sleep(1500);
  await phone.click('[data-ui="sidebar-toggle"]'); await sleep(500);
  const proj2Row = phone.locator('.fc-sidebar div.cursor-pointer.rounded-lg.pl-1', { hasText: 'second-proj' });
  await proj2Row.waitFor();
  await proj2Row.locator('button[title="在这个项目里新建对话"]').click();
  await sleep(800);
  await send(phone, '第二个项目里手机发的');
  const proj2Reply = await waitText(phone, /PROJ2-OK/, 15000);
  await sleep(2500);
  const deskProjAfter = await desk.evaluate(() => window.finalcheck.projects.current());
  const deskRowsAfter = await desk.evaluate(rowTitles);
  const deskStillThere = /DESK-REPLY-OK/.test(await text(desk));
  await send(desk, '电脑发的第二条');
  const deskStillWorks = await waitText(desk, /DESK-REPLY-OK[\s\S]*DESK-REPLY-OK/, 15000);
  await shot(desk, '07-desktop-after-phone-other-project');
  await shot(phone, '07-phone-other-project');
  record('X 手机切到别的项目开会话，电脑的当前项目、侧栏、正在看的会话都不变', proj2Reply && deskProjBefore === deskProjAfter && JSON.stringify(sessionsUnder(deskRowsBefore, 'finalcheck')) === JSON.stringify(sessionsUnder(deskRowsAfter, 'finalcheck')) && sessionsUnder(deskRowsAfter, 'finalcheck')?.length > 0 && deskStillThere && deskStillWorks,
    `reply=${proj2Reply} proj ${deskProjBefore}→${deskProjAfter} rows ${JSON.stringify(deskRowsBefore)}→${JSON.stringify(deskRowsAfter)} still=${deskStillThere} works=${deskStillWorks}`);

  // W：手机在两个项目之间来回切会话（电脑这时也在切项目、建会话）：每次都切得过去、内容对、侧栏不串
  await desk.evaluate(async () => { const f = window.finalcheck; const cur = await f.projects.current(); await f.projects.select(cur); });
  const openPhoneRow = async (title) => {
    await phone.click('[data-ui="sidebar-toggle"]'); await sleep(500);
    for (const h of await phone.locator('.fc-sidebar div.cursor-pointer.rounded-lg.pl-1').all()) {
      const open = await h.evaluate((el) => !!el.querySelector('svg:not(.-rotate-90)'));
      if (!open) { await h.click(); await sleep(400); }
    }
    await phone.locator('.fc-sidebar div.cursor-pointer.rounded-lg.pl-2', { hasText: title }).first().click();
    await sleep(1500);
  };
  const phoneRows = () => phone.evaluate(rowTitles);
  await openPhoneRow('模拟会话');
  const w1 = /PHONE-REPLY-OK/.test(await text(phone)) && !(await phone.locator('.fc-sidebar:not(.fc-sidebar-collapsed)').count());
  await openPhoneRow('项目二会话');
  const w2 = /PROJ2-OK/.test(await text(phone)) && !/PHONE-REPLY-OK/.test(await text(phone));
  await openPhoneRow('模拟会话');
  const w3 = /PHONE-REPLY-OK/.test(await text(phone));
  await phone.click('[data-ui="sidebar-toggle"]'); await sleep(500);
  const rowsP = await phoneRows();
  await phone.mouse.click(380, 400); await sleep(400);
  const mixed = (sessionsUnder(rowsP, 'finalcheck') || []).some((r) => /项目二会话/.test(r)) || (sessionsUnder(rowsP, 'second-proj') || []).some((r) => /模拟会话/.test(r));
  await shot(phone, '10-phone-switch-back');
  record('W 手机在两个项目之间来回切会话：切得过去、内容对、侧栏不串', w1 && w2 && w3 && !mixed, `w=${w1}/${w2}/${w3} rows=${JSON.stringify(rowsP)}`);

  // S：手机设置页——导航在最左边的抽屉里，进来就展开；选一项收回；模型列表正常
  await phone.click('[data-ui="sidebar-toggle"]'); await sleep(400);
  await phone.locator('.fc-sidebar button', { hasText: /Settings|设置/ }).first().click();
  await phone.locator('nav.glass-side').waitFor();
  await sleep(500);
  const navBox1 = await phone.locator('nav.glass-side').boundingBox();
  await shot(phone, '08-phone-settings-nav');
  await phone.locator('nav.glass-side button', { hasText: /模型设置|Model settings/ }).click();
  await sleep(600);
  const navBox2 = await phone.locator('nav.glass-side').boundingBox();
  const providerShown = await waitText(phone, /Probe/, 8000);
  const sNoH = await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  await shot(phone, '09-phone-settings-models');
  await phone.click('[data-ui="sidebar-toggle"]'); await sleep(500);
  const navBox3 = await phone.locator('nav.glass-side').boundingBox();
  record('S 设置页导航在左侧抽屉：进来就展开、选一项收回、按钮再打开；模型列表正常',
    navBox1.x >= 0 && navBox2.x < -100 && navBox3.x >= 0 && providerShown && sNoH, `x ${navBox1.x}/${navBox2.x}/${navBox3.x} provider=${providerShown} noH=${sNoH}`);

  // I：点开图片显示原图（不是 480px 缩略图）——电脑和手机都要
  {
    const { deflateSync } = await import('node:zlib');
    const W = 1600, H = 1000, raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = x % 256; raw[o + 1] = y % 256; raw[o + 2] = 128; }
    const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
    const imgPath = path.join(projectDir, 'big-probe.png');
    writeFileSync(imgPath, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
    const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const openBig = async (pg) => {
      await pg.evaluate(({ src, p }) => window.dispatchEvent(new CustomEvent('fc:lightbox', { detail: { items: [{ src, name: 'big-probe.png', path: p }], index: 0 } })), { src: tiny, p: imgPath });
      const img = pg.locator('[data-testid="lightbox-image"][data-full="1"]');
      await img.waitFor({ timeout: 10000 }).catch(() => {});
      const r = await img.evaluate((el) => new Promise((ok) => { const done = () => ok({ nw: el.naturalWidth, w: Math.round(el.getBoundingClientRect().width) }); el.complete ? done() : el.addEventListener('load', done, { once: true }); })).catch(() => ({ nw: 0, w: 0 }));
      await pg.keyboard.press('Escape'); await sleep(300);
      return r;
    };
    const di = await openBig(desk); const pi = await openBig(phone);
    record('I 点开图片显示原图（电脑 / 手机都是 1600px 原图，不是缩略图）', di.nw === 1600 && pi.nw === 1600 && di.w > 480, `desk=${JSON.stringify(di)} phone=${JSON.stringify(pi)}`);
  }

  // Z：Ctrl + = / - / 0 缩放（渲染层兜底 + 主进程，都会改同一个倍率）；设置页显示倍率
  {
    await desk.bringToFront();
    const z = () => desk.evaluate(() => window.finalcheck.windowCtl('state').then((r) => r.zoom));
    const z0 = await z();
    await desk.keyboard.press('Control+Equal'); await sleep(400); const z1 = await z();
    await desk.keyboard.press('Control+Minus'); await desk.keyboard.press('Control+Minus'); await sleep(400); const z2 = await z();
    await desk.keyboard.press('Control+0'); await sleep(400); const z3 = await z();
    record('Z Ctrl + = 放大、Ctrl + - 缩小、Ctrl + 0 复位', z1 > z0 && z2 < z0 && Math.abs(z3 - 1) < 0.001, `${z0}→${z1}→${z2}→${z3}`);
  }

  // D：没有重复发送
  const dups = [...mainTurns.entries()].filter(([, n]) => n > 1);
  record('D 每条消息网关只收到一次（没有两边各发一遍）', dups.length === 0, JSON.stringify([...mainTurns.entries()]));
  record('手机控制台无报错', phone.errors.length === 0, phone.errors.join(' | '));
} catch (error) {
  record('探针异常', false, error.stack || error.message);
  if (phone) { await shot(phone, 'zz-phone-fail').catch(() => {}); console.log('phone url:', phone.url(), '| text:', (await text(phone).catch(() => '')).slice(0, 400), '| errors:', phone.errors.join(' | ')); }
} finally {
  await browser?.close().catch(() => {});
  // Windows 上 kill() 不连带结束 Electron 的子进程（它们会锁住 user-data，下一次跑就清不掉）
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill();
  await gw.close?.().catch?.(() => {});
  await sleep(1500);
  if (globalThis.__fcStats) {
    const st = globalThis.__fcStats; const sec = (Date.now() - st.t0) / 1000;
    console.log(`\n[stats] 手机 ${sec.toFixed(0)} 秒内发了 ${st.total} 个请求（${(st.total / sec).toFixed(1)}/秒），同时挂着最多 ${st.peak} 个`);
    for (const [ch, e] of [...st.byCh].sort((x, y) => y[1].bytes - x[1].bytes || y[1].n - x[1].n).slice(0, 15)) console.log(`[stats] ${String(e.n).padStart(4)} 次  上传共 ${(e.bytes / 1024).toFixed(0).padStart(6)}KB  最大一次 ${(e.max / 1024).toFixed(0).padStart(5)}KB  ${ch}`);
  }
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fail}/${results.length} 通过。截图：${out}`);
  process.exit(fail ? 1 : 0);
}
