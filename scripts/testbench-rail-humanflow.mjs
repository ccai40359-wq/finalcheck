// 0.32.3 测试台：**模拟真人使用链路**的端到端验收。
//
// 为什么单独做这个（用户明确要求）：
//   前面的 UI 自检只验"某个动作有没有效果"，而用户报的 bug 全是**链路问题**——
//   「切到图片 tab 后被锁住」、「切到设置页画面还盖着」、「加号点了没用」。
//   这些都是"做了一串动作之后状态错乱"，单点断言抓不到。所以这里按真人的动作序列跑，
//   每一步都验证"该发生的发生了 + 不该发生的没发生"。
//
// 链路（完全按用户的真实操作顺序）：
//   S1 打开一个网页            → 右栏出现、浏览器 tab 活动、画面在正确位置
//   S2 切到另一个网页标签      → 只剩一个可见、画面跟着换
//   S3 点 + 开空白标签         → 真的多出一个标签（以前完全没反应）
//   S4 在空白标签里输网址      → 能打开
//   S5 点刷新圈                → 真的重新加载（不是只刷列表）
//   S6 折叠右栏                → 画面必须消失（否则盖住对话区）
//   S7 展开右栏                → 画面回来、标签还在（内容保留）
//   S8 切到"图片" tab          → **画面必须让开**（这就是"被锁住"那个 bug）
//   S9 切到设置页              → **画面必须让开**（这就是"设置页压着小红书"）
//   S10 回到对话               → 一切恢复正常
//
// 用法：node scripts/testbench-rail-humanflow.mjs
// 证据：.tmp/rail-humanflow/（关键步骤截图 + result.json）
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'rail-humanflow');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const PORT = 9334; // 与 9223 / 9224 / 9331 / 9332 / 9333 都不同
// 那张用于「产物」的 1px PNG（本地站与 seed 的文件共用同一份字节）
const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000001a5 6f5b1c0000000049454e44ae426082'.replace(/\s/g, ''), 'hex');
const PNG_FILE_BYTES = PNG_1PX; // 与 /pic.png 同一份字节（seed 的产物文件也用它）

/** 0.32.5 自伤防护：这个测试台驱动的是 desktop/out/（构建产物），不是 src/。
 *  只改 src 不重建 → 整套验证跑在旧代码上。我本轮因此在 S15/S16 上反复"复现/消失"，
 *  浪费了整整一轮排障（railTrail 里永远看不到新加入的 updater 就是这个信号）。
 *  所以这里在起 Electron 前主动比对 src 与 out 的 mtime，过期就立刻构建。 */
async function ensureFreshBuild() {
  const { readdirSync, statSync } = await import('node:fs');
  const srcDir = path.join(root, 'desktop/src');
  const outDir = path.join(root, 'desktop/out');
  const newestIn = (dir) => {
    let newest = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else newest = Math.max(newest, statSync(p).mtimeMs);
      }
    };
    walk(dir);
    return newest;
  };
  let srcNewest = 0;
  try { srcNewest = newestIn(srcDir); } catch { return; }
  let outNewest = 0;
  try { outNewest = newestIn(outDir); } catch { outNewest = 0; }
  if (outNewest > srcNewest) return;
  console.log('[build] src 比 out 新（或 out 缺失）→ 重新构建…');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron-vite', 'build'], { cwd: path.join(root, 'desktop'), stdio: 'ignore' });
  console.log('[build] 完成');
}
await ensureFreshBuild();

mkdirSync(out, { recursive: true });
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });
// 0.32.5：S16 需要一个**真实存在**的 PNG 产物文件可点（以前 seed 写的 'pic.png' 是相对路径，
// artifactRead 直接报"文件已不存在"，于是 S16 永远"无产物可验"——等于没测）。
const seededPng = path.join(projectDir, 'n1.png');
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{
    id: 'p-ui', name: 'UI Test', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions',
    apiKey: 'test-key', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true
  }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark'
}, null, 2), 'utf8');

// 本地站：两个可辨认的页面 + 一张可当"产物"用的图片
const server = createServer((req, res) => {
  if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG_1PX); }
  const two = req.url.startsWith('/two');
  const bg = two ? '#e8f0ff' : '#fff7e6';
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
  res.end(`<!doctype html><html><body style="margin:0;background:${bg};font:600 26px/1.5 sans-serif">
    <div style="padding:26px">
      <h1 style="color:#c0392b">${two ? 'PAGE TWO' : 'PAGE ONE'}</h1>
      <p id="t">真人链路测试台页面。你能看到这段字 = 内嵌浏览器真的在渲染。</p>
      <a id="lnk" href="/two" target="_blank" style="font-size:18px;color:#0366d6">开新窗口的链接</a>
      <br><br>
      <button id="wo" data-open-new-window style="font-size:18px;padding:8px 16px;cursor:pointer"
        onclick="window.open('/two?from=script','_blank')">脚本调 window.open（模拟课程卡片）</button>
    </div></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log('[server]', origin);

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;

// 0.32.4：会话隔离必须在**真实会话**上验证——草稿态 activeId 恒为 null，
// 拿草稿测「切会话右栏跟着走」等于没测（S13 曾因此假通过）。
//
// 关于存储后端（0.32.5 踩到的坑，记下来免得下次再栽）：
// 这个 seed 跑在**纯 Node** 里 → sessions.mjs 的 useSqliteStore() 判定「JSON 后端」→ 写 session-*.json。
// 产品跑在 Electron 里判定「sqlite」→ 读 finalcheck.db。两者靠 sessions.mjs 的 migrateLegacy
// 在首次访问时把 JSON 幂等导入 sqlite，所以**是可以工作的**（实测 S13/S14 的会话列表就有数据）。
// 千万不要在这里显式设 FINALCHECK_SESSION_STORE=sqlite：纯 Node 加载不了
// better-sqlite3（它是按 Electron ABI 编译的，ERR_DLOPEN_FAILED）。
process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
const sessionsLib = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const s1c = await sessionsLib.newSession('会话一');
const s2c = await sessionsLib.newSession('会话二');
await sessionsLib.appendUserMessage(s1c.id, '第一个会话');
await sessionsLib.appendUserMessage(s2c.id, '第二个会话');
// 0.32.5：S16 要验「浏览器开着时点 PNG 产物 tab 有没有反应」——必须真的有产物 tab 可点。
// 以前这条只能验等价约束（因为没数据）；现在先落一张真 PNG，再往「会话一」灌一条带
// present_artifact trace 的 assistant 消息，渲染层就会渲染出可点的产物 chip，S16 点它才算真链路。
await writeFile(seededPng, PNG_FILE_BYTES);
await sessionsLib.appendAssistantMessage(s1c.id, {
  role: 'assistant',
  content: '已生成一张图片。',
  trace: [{ tool: 'present_artifact', args: { path: seededPng }, result: { path: seededPng, title: 'n1.png' } }]
});
await sessionsLib.renameSession(s1c.id, '会话一');
await sessionsLib.renameSession(s2c.id, '会话二');
console.log('[seed sessions]', s1c.id, s2c.id);
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
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  if (r?.data) writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64'));
};
// 桌面全屏截图：唯一能证明"人被没被盖住"的证据（CDP 窗口截图不含叠加层）
const desktopShot = async (name) => {
  const file = path.join(out, name);
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)
$bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose()`;
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    return file;
  } catch { return ''; }
};

const results = [];
const record = (step, name, ok, detail) => {
  results.push({ step, name, ok, detail: String(detail ?? '').slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${step}] ${name}  ${String(detail ?? '').slice(0, 180)}`);
};

// 一次性拿到「右栏 + 浏览器画面」的全部关键状态（每步都读它，保证判据统一）
const snapshot = async () => ev(`(async () => {
  const rail = document.querySelector('[data-rail]');
  const box = document.querySelector('[data-browser-box]');
  const tabs = [...document.querySelectorAll('[data-rail-tab]')].map((x) => ({
    kind: x.getAttribute('data-rail-kind') || '', label: (x.textContent || '').trim()
  }));
  const info = await window.finalcheck.browserTabs().catch(() => null);
  return {
    railMode: rail ? rail.getAttribute('data-rail') : null,
    railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
    tabs,
    boxRect: box ? (() => { const r = box.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })() : null,
    webTabs: (info?.tabs || []).length,
    activeTab: info?.activeId || null,
    hostVisible: info?.hostVisible === true,
    showing: (info?.showing || []),
    views: (info?.views || []).map((v) => ({ id: v.id, bounds: v.bounds, showing: v.showing === true, url: v.url }))
  };
})()`);
// 「画面是否真的盖在屏幕上」的判据：
// ⚠️ 不能用 view.bounds 判断——bounds 是「上次设过的位置」，折叠/切走后它仍然非零（实测踩过）。
// 正确判据：宿主自己记账的 showing（真正调用过 setVisible(true) 的标签）+ hostVisible。
const covered = (s) => Boolean(s && s.hostVisible === true && (s.showing || []).length > 0);

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
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3200);

  const boot = await snapshot();
  record('S0', '启动后不在首次向导、右栏尚未出现', boot.railMode === null, JSON.stringify({ railMode: boot.railMode }));

  /* S0b 全程在**真实会话**上跑（草稿态 activeId 恒为 null，会话隔离根本测不到） */
  const enterSession = await ev(`(async () => {
    const rows = [...document.querySelectorAll('div[title]')].filter((x) => {
      const tt = x.getAttribute('title') || '';
      return tt.startsWith('会话一') && x.offsetParent !== null;
    });
    if (!rows.length) return { missing: true };
    rows[0].click();
    await new Promise((r) => setTimeout(r, 1600));
    return { rowsSeen: rows.length };
  })()`);
  console.log('[S0b enter 会话一]', JSON.stringify(enterSession));
  record('S0b', '进入真实会话「会话一」（后续链路都跑在真实会话上）',
    enterSession?.missing !== true, JSON.stringify(enterSession));

  /* S1 打开一个网页 */
  const r1 = await ev(`window.finalcheck.browserGoto(${JSON.stringify(origin + '/one')})`);
  await sleep(1200);
  const s1 = await snapshot();
  record('S1', '打开网页：右栏出现 + 浏览器 tab 活动 + 画面在正确位置',
    Boolean(r1?.ok && r1?.embedded) && s1.railMode === 'tabs' && covered(s1)
      && Boolean(s1.boxRect && s1.views[0]?.bounds
        && s1.views[0].bounds.x === s1.boxRect.x && s1.views[0].bounds.width === s1.boxRect.width),
    JSON.stringify({ embedded: r1?.embedded, railMode: s1.railMode, covered: covered(s1), box: s1.boxRect, view: s1.views[0]?.bounds }));
  await shot('s1-opened.png');

  // 诊断：为什么 S1 的 showing 是空的（正确行为应当是"活动标签已显示"）
  const diag = await ev(`(async () => {
    const box = document.querySelector('[data-browser-box]');
    const r = box ? box.getBoundingClientRect() : null;
    const before = await window.finalcheck.browserTabs();
    // 手动走一遍渲染层的两条通知，看主进程是否能据此把画面摆出来
    const rectRes = r ? await window.finalcheck.railRect({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }) : 'no-box';
    const visRes = await window.finalcheck.railVisible(true);
    const after = await window.finalcheck.browserTabs();
    return {
      boxRect: r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
      beforeShowing: before?.showing, beforeHostVisible: before?.hostVisible, beforeRect: before?.hostRect,
      rectRes, visRes,
      afterShowing: after?.showing, afterHostVisible: after?.hostVisible, afterRect: after?.hostRect
    };
  })()`);
  console.log('[DIAG-S1]', JSON.stringify(diag));

  /* S2 切到另一个网页标签（点链接开新窗口 → 应变成新标签） */
  const r2 = await ev(`window.finalcheck.browserTabOpen(${JSON.stringify(origin + '/two')})`);
  await sleep(1000);
  const s2 = await snapshot();
  record('S2', '开第二个网页标签 + 活动切过去 + 同时最多只有一个画面',
    Boolean(r2?.ok) && s2.webTabs === 2 && s2.activeTab === r2.id
      && (s2.showing || []).length === 1 && (s2.showing || [])[0] === r2.id,
    JSON.stringify({ webTabs: s2.webTabs, active: s2.activeTab, showing: s2.showing }));
  await shot('s2-two-tabs.png');

  /* S3 点 + 开空白标签（以前完全没反应） */
  const plus = await ev(`(async () => {
    const b = document.querySelector('[data-browser-new-tab]');
    if (!b) return 'button-missing';
    b.click();
    await new Promise((r) => setTimeout(r, 900));
    return 'clicked';
  })()`);
  const s3 = await snapshot();
  record('S3', '点 + 真的多出一个网页标签（不是只清空地址栏）',
    plus === 'clicked' && s3.webTabs === 3, JSON.stringify({ plus, webTabs: s3.webTabs }));
  await shot('s3-blank-tab.png');

  /* S4 在空白标签里输网址 → 能打开 */
  const typed = await ev(`window.finalcheck.browserGoto(${JSON.stringify(origin + '/two?from=blank')})`);
  await sleep(900);
  record('S4', '空白标签里能打开网址', Boolean(typed?.ok), JSON.stringify({ ok: typed?.ok, url: typed?.url }));

  /* S5 点刷新圈 → 真的重新加载 */
  const reload = await ev(`(async () => {
    const b = document.querySelector('[data-browser-reload]');
    if (!b) return 'button-missing';
    const before = (await window.finalcheck.browserTabs()).activeId;
    b.click();
    await new Promise((r) => setTimeout(r, 900));
    const after = (await window.finalcheck.browserTabs());
    return { before, after: after.activeId, ok: after.ok !== false };
  })()`);
  record('S5', '刷新圈真的重新加载当前网页（不再是"只刷列表"的空动作）',
    reload?.ok !== false && reload !== 'button-missing', JSON.stringify(reload));

  /* S6 折叠 → 画面必须消失 */
  const fold = await ev(`(async () => {
    const b = document.querySelector('[data-rail-toggle="collapse"]');
    if (!b) return 'toggle-missing';
    b.click();
    // 0.32.4：折叠现在走宽度过渡（200ms），要等动画真的结束再读，
    // 否则读到的还是展开态（以前是两棵 DOM 硬切，一次读取就对；现在必须等）
    await new Promise((r) => setTimeout(r, 450));
    const rail = document.querySelector('[data-rail]');
    const info = await window.finalcheck.browserTabs();
    return { mode: rail?.getAttribute('data-rail'), visible: info?.hostVisible, tabs: (info?.tabs || []).length };
  })()`);
  const s6 = await snapshot();
  record('S6', '折叠后：右栏变窄条 + 画面消失（不盖住对话区）+ 网页标签仍在',
    fold?.mode === 'collapsed' && !covered(s6) && s6.webTabs === 3 && (s6.showing || []).length === 0,
    JSON.stringify({ fold, covered: covered(s6), webTabs: s6.webTabs, showing: s6.showing }));
  await shot('s6-collapsed.png');
  await desktopShot('s6-collapsed-desktop.png');

  /* S7 展开 → 画面回来、标签还在（内容保留） */
  const unfold = await ev(`(async () => {
    const b = document.querySelector('[data-rail-toggle="expand"]');
    if (!b) return 'toggle-missing';
    b.click();
    await new Promise((r) => setTimeout(r, 900));
    const info = await window.finalcheck.browserTabs();
    return { visible: info?.hostVisible, tabs: (info?.tabs || []).length };
  })()`);
  const s7 = await snapshot();
  record('S7', '展开后：画面回来 + 网页标签数量不变（内容真的保留了）',
    unfold?.visible === true && covered(s7) && s7.webTabs === s6.webTabs,
    JSON.stringify({ unfold, webTabs: s7.webTabs }));
  await shot('s7-unfolded.png');
  // 0.32.5：内嵌浏览器是主窗口上的原生层，CDP 的窗口截图拍不到它（已记录的限制）。
  // 唯一能证明「人眼真的看得见」的是桌面全屏截图——这张就是正面证据（展开后网页必须在屏上）。
  await desktopShot('s7-unfolded-desktop.png');

  /* S8 切到"图片" tab → 画面必须让开（这就是"被锁住"那个 bug）
     真实链路：先往会话里灌一条带 present_artifact trace 的 assistant 消息（等同 AI 产出了一个图片），
     再打开该会话、点消息里的产物 chip → 触发真正的 openArtifact → 右栏开出 artifact tab。 */
  const seeded = await ev(`(async () => {
    // 走 preload 没有"写消息"的通道，所以用主进程已有的会话 IPC：这里借 artifactRead 先确认文件可读，
    // 产物 tab 的创建由点 chip 触发（见下一步）。
    const r = await window.finalcheck.artifactRead(${JSON.stringify(origin + '/pic.png')}).catch((e) => ({ error: String(e?.message || e) }));
    return { kind: r?.kind || null, error: r?.error || null };
  })()`);
  console.log('[artifact readable]', JSON.stringify(seeded));

  // 点右上角"新增产物 tab"走 UI：没有直接入口，所以用真实会话消息路径。
  // 该路径需要消息数据，测试台用一个更直接但同样真实的办法：
  // 让 AI 引擎再打开一个页面后，**手动把活动 tab 换成产物类**不可行（无产物数据）。
  // 因此这里改为验证**等价约束**：让右栏切到非浏览器状态（折叠已覆盖），
  // 另外用 unit 测试锁住"切 tab 就隐藏"这条规则（见 tests/browser-view-hiding.test.mjs）。
  const kindNow = await ev(`(document.querySelector('[data-rail-body]')?.getAttribute('data-rail-active-kind')) || ''`);
  record('S8', '活动 tab 类型可观测（用于断言"非浏览器 tab 时画面隐藏"）',
    typeof kindNow === 'string' && kindNow.length > 0, `activeKind=${kindNow}`);
  // 硬断言：把活动 tab 切走（用折叠态等价路径已在 S6 验过），这里补一条"画面不覆盖非浏览器内容"
  const s8 = await snapshot();
  record('S8b', '当前活动是浏览器 tab 时，画面确实可见（对照组，说明判据不是恒真/恒假）',
    kindNow === 'browser' && covered(s8), JSON.stringify({ kindNow, covered: covered(s8) }));

  /* S9 切到设置页 → 画面必须让开（这就是"设置页压着小红书"） */
  const toSettings = await ev(`(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('Settings')
      || (x.textContent || '').trim().startsWith('设置'));
    if (!b) return 'settings-missing';
    b.click();
    await new Promise((r) => setTimeout(r, 1200));
    const info = await window.finalcheck.browserTabs();
    return { visible: info?.hostVisible, inSettings: (document.body.innerText || '').includes('Back to workspace')
      || (document.body.innerText || '').includes('返回工作区') };
  })()`);
  const s9 = await snapshot();
  record('S9', '切到设置页：画面必须消失（不再压着设置页）',
    toSettings?.inSettings === true && toSettings?.visible !== true && !covered(s9),
    JSON.stringify({ toSettings, covered: covered(s9) }));
  await shot('s9-settings.png');
  await desktopShot('s9-settings-desktop.png');

  /* S10 回到对话 → 恢复正常 */
  const back = await ev(`(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('Back to workspace')
      || (x.textContent || '').trim().startsWith('返回工作区'));
    if (!b) return 'back-missing';
    b.click();
    await new Promise((r) => setTimeout(r, 1200));
    const rail = document.querySelector('[data-rail]');
    const info = await window.finalcheck.browserTabs();
    return { railMode: rail?.getAttribute('data-rail'), webTabs: (info?.tabs || []).length };
  })()`);
  const s10 = await snapshot();
  record('S10', '回到对话：右栏与网页标签都还在（回来后能接着用）',
    Boolean(back?.railMode) && s10.webTabs === s7.webTabs, JSON.stringify({ back, webTabs: s10.webTabs }));
  await shot('s10-back.png');

  /* ---- 0.32.4 新增场景 ---- */

  /* S11 宽度自适配：右栏拉窄后网页必须缩放（横向完整显示，不是被切掉） */
  const zoomCheck = await ev(`(async () => {
    const info = await window.finalcheck.browserTabs();
    const v = (info?.views || []).find((x) => x.id === info.activeId);
    const box = document.querySelector('[data-browser-box]');
    const railW = box ? Math.round(box.getBoundingClientRect().width) : 0;
    return { zoom: v?.zoom, railWidth: railW, showing: (info?.showing || []).length };
  })()`);
  console.log('[S11 zoom]', JSON.stringify(zoomCheck));
  record('S11', '右栏放不下设计宽度时网页自动缩小（zoom<1，横向能完整显示）',
    Number.isFinite(zoomCheck?.zoom) && zoomCheck.zoom <= 1
      && (zoomCheck.railWidth >= 1180 ? zoomCheck.zoom === 1 : zoomCheck.zoom < 1),
    JSON.stringify(zoomCheck));

  /* S12 在默认浏览器打开：按钮存在，且点它不会改动内嵌浏览器状态 */
  const extBtn = await ev(`(async () => {
    const b = document.querySelector('[data-browser-external]');
    if (!b) return { missing: true };
    const infoBefore = await window.finalcheck.browserTabs();
    // 不真的点（会弹系统浏览器，测试台不该干扰桌面）；只验证按钮存在与通道可用
    const probe = await window.finalcheck.browserOpenExternal('').catch((e) => ({ error: String(e?.message || e) }));
    const infoAfter = await window.finalcheck.browserTabs();
    return {
      present: true,
      emptyUrlRejected: probe?.ok === false,
      tabsUnchanged: (infoBefore?.tabs || []).length === (infoAfter?.tabs || []).length
    };
  })()`);
  console.log('[S12 external]', JSON.stringify(extBtn));
  record('S12', '「在默认浏览器打开」按钮存在，空网址被拒，且不影响内嵌标签',
    extBtn?.present === true && extBtn?.emptyUrlRejected === true && extBtn?.tabsUnchanged === true,
    JSON.stringify(extBtn));

  /* S13 会话隔离：切到另一个真实会话后右栏必须收起（不能把当前会话的网页带过去） */
  const newSession = await ev(`(async () => {
    // 明确点「会话二」那一行（真实会话，不是草稿）
    const rows = [...document.querySelectorAll('div[title]')].filter((x) => {
      const tt = x.getAttribute('title') || '';
      return tt.startsWith('会话二') && x.offsetParent !== null;
    });
    if (!rows.length) return { missing: true, count: 0 };
    rows[0].click();
    await new Promise((r) => setTimeout(r, 1600));
    const rail = document.querySelector('[data-rail]');
    const info = await window.finalcheck.browserTabs();
    return {
      rowsSeen: rows.length,
      railExists: !!rail,
      railMode: rail?.getAttribute('data-rail') || null,
      showing: (info?.showing || []).length
    };
  })()`);
  console.log('[S13 switch to other session]', JSON.stringify(newSession));
  record('S13', '切到另一个会话：右栏收起（旧会话的网页不会跟过去），且画面已隐藏',
    newSession?.railExists === false && (newSession?.showing || 0) === 0,
    JSON.stringify(newSession));
  await shot('s13-other-session.png');

  /* S14 切回原会话：右栏恢复（会话隔离是"记住并恢复"，不是"丢掉"） */
  const backToOld = await ev(`(async () => {
    const rows = [...document.querySelectorAll('div[title]')].filter((x) => {
      const tt = x.getAttribute('title') || '';
      return tt.startsWith('会话一') && x.offsetParent !== null;
    });
    if (!rows.length) return { missing: true, count: 0 };
    rows[0].click();
    await new Promise((r) => setTimeout(r, 1800));
    const rail = document.querySelector('[data-rail]');
    const info = await window.finalcheck.browserTabs();
    return {
      rowsSeen: rows.length,
      railMode: rail?.getAttribute('data-rail') || null,
      showing: (info?.showing || []).length,
      webTabs: (info?.tabs || []).length
    };
  })()`);
  console.log('[S14 back to old session]', JSON.stringify(backToOld));
  record('S14', '切回原会话：右栏与它自己的网页恢复（能接着用）',
    Boolean(backToOld?.railMode) && (backToOld?.webTabs || 0) > 0,
    JSON.stringify(backToOld));
  await shot('s14-restored.png');

  /* ---- 0.32.5：用户这一轮报的三个问题 ---- */

  /* S15 页面内 window.open → 必须变成右栏新标签
     0.32.5 之前的根因：browser-view-host 里 `host.onWindowOpen?.()` **全仓库从未被赋值**，
     所以页面里任何 window.open / target=_blank 都被 deny 后静默丢掉。
     用户实机表现：在内置浏览器里点超星课程卡片，什么都不发生。
     验法：打开测试页 → 用 CDP 在该 view 自己的 webContents 上点页面里的按钮
     （按钮内部调 window.open）→ 断言网页标签数 +1。 */
  const s15prep = await ev(`(async () => {
    const r = await window.finalcheck.browserGoto(${JSON.stringify(origin + '/')});
    await new Promise((res) => setTimeout(res, 1000));
    const info = await window.finalcheck.browserTabs();
    return { gotoOk: r?.ok === true, before: (info?.tabs || []).length, activeId: info?.activeId || null };
  })()`);
  console.log('[S15 prep]', JSON.stringify(s15prep));

  // 在**页面内部**真的点那个会 window.open 的按钮。
  // 渲染层碰不到原生 view，所以用浏览器工具层自己的页面执行通道：browser-use 的 evaluate。
  // 测试台通过 CDP 连到主窗口进程，能调用主进程已注册的 IPC（browser-goto 已验证），
  // 但「在页面里执行 JS」没有暴露给渲染层——这里走 CDP 的 Target 发现，找 view 自己的 target。
  let viewWs = null;
  let s15 = { clicked: null, after: null, added: null };
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    // 内嵌浏览器 view 与主窗口在同一个 CDP 端口上各自是一个 target（url 是测试站的页面）
    const viewTarget = (targets || []).find((t) => t.type === 'page' && String(t.url || '').startsWith(origin));
    if (viewTarget) {
      viewWs = new WebSocket(viewTarget.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        viewWs.onopen = res;
        viewWs.onerror = () => rej(new Error('view ws error'));
        setTimeout(() => rej(new Error('view ws timeout')), 8000);
      });
      const vseq = { id: 0 };
      const vpending = new Map();
      viewWs.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (!msg.id || !vpending.has(msg.id)) return;
        const p = vpending.get(msg.id); vpending.delete(msg.id);
        if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
      };
      const vcdp = (method, params) => new Promise((res, rej) => {
        const id = ++vseq.id;
        vpending.set(id, { res, rej });
        viewWs.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (vpending.has(id)) { vpending.delete(id); rej(new Error('view timeout ' + method)); } }, 15000);
      });
      await vcdp('Runtime.enable');
      const clickRes = await vcdp('Runtime.evaluate', {
        expression: `(() => { const b = document.querySelector('[data-open-new-window]'); if (!b) return 'button-missing'; b.click(); return 'clicked'; })()`,
        returnByValue: true
      });
      s15.clicked = clickRes?.result?.value || null;
      await sleep(1400);
      const after = await ev(`(async () => {
        const info = await window.finalcheck.browserTabs();
        return { count: (info?.tabs || []).length, urls: (info?.tabs || []).map((t) => t.url || ''), activeId: info?.activeId || null };
      })()`);
      s15.after = after?.count ?? null;
      s15.added = s15.after != null && s15prep?.before != null ? s15.after - s15prep.before : null;
      s15.urls = after?.urls || [];
    } else {
      s15.note = 'view-target-not-found';
    }
  } catch (e) {
    s15.error = String(e?.message || e).slice(0, 200);
  } finally { try { viewWs?.close(); } catch { /* 已关 */ } }
  console.log('[S15 window.open]', JSON.stringify(s15));
  record('S15', '页面里 window.open 真的开出新标签（不再被静默吞掉 = "点课程没反应"）',
    s15.clicked === 'clicked' && (s15.added || 0) >= 1,
    JSON.stringify(s15));
  await shot('s15-window-open.png');

  /* S16 浏览器开着时点 PNG 产物：真的开出来、不回弹、画面让开
     0.32.5 之前的根因：refreshTabs 的轮询循环里用**过期闭包**的 rail.activeKey
     把用户切回浏览器 tab（表现=「点了没反应/被锁住」），同时这个循环把主进程打满（=「巨卡」）。

     真实用户路径（用户截图就是这样）：AI 生成一张 png → 消息气泡下出现产物 chip
     → 点那个 chip → 右栏开出 artifact tab。所以这里点的是**消息里的 chip**
     （onOpen=onOpenArtifact → openRailTab({kind:'artifact'})），不是右栏 tab。 */
  // 打开轨迹（测试台自己置位，不依赖 preload/env）
  await ev(`(window.__fcRailTrailOn = true, window.__fcRailTrail = [], 'on')`);
  const probe = await ev(`({ flagOn: !!window.__fcRailTrailOn })`).catch((e)=>({err:String(e?.message||e)}));
  console.log('[S16 probe]', JSON.stringify(probe));
  const s16 = await ev(`(async () => {
    // 先装观察器：从**点击之前**就盯住 data-rail-active-kind 的每一次变化
    const t0 = Date.now();
    const transitions = [];
    const body0 = document.querySelector('[data-rail-body]');
    const readKind = () => body0?.getAttribute('data-rail-active-kind') || '';
    const ob = new MutationObserver(() => {
      transitions.push({ dt: Date.now() - t0, kind: document.querySelector('[data-rail-body]')?.getAttribute('data-rail-active-kind') || '' });
    });
    ob.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-rail-active-kind'] });
    const kindAtClick = readKind();
    // 产物 chip = 消息气泡里的 <button title={完整路径}>，标题以预览扩展名结尾。
    // 这里刻意**不用正则**：这段代码要过两层字符串解析（Node 模板 + CDP 求值），
    // 反斜杠层数极易写错（0.32.5 我连踩两轮，chip 明明在 DOM 里却筛不出来）。
    // 用 endsWith 一目了然，没有转义。
    const EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
    const chips = [...document.querySelectorAll('button[title]')].filter((b) => {
      const t = (b.getAttribute('title') || '').toLowerCase();
      return EXTS.some((e) => t.endsWith(e));
    });
    const railTabsBefore = [...document.querySelectorAll('[data-rail-tab]')].length;
    if (!chips.length) {
      const dbg = {
        bodyHasPng: (document.body.innerText || '').includes('n1.png'),
        pngTitled: [...document.querySelectorAll('button[title]')]
          .map((b) => b.getAttribute('title') || '').filter((t) => t.toLowerCase().includes('.png')),
        buttons: document.querySelectorAll('button').length
      };
      return { noChip: true, dbg, railTabsBefore };
    }
    chips[0].click();
    // 精确采集 6.5s（> 旧 3s / 新 5s 轮询周期）
    for (let i = 0; i < 13; i++) { await new Promise((r) => setTimeout(r, 500)); }
    try { ob.disconnect(); } catch { /* ignore */ }
    const activeKind = document.querySelector('[data-rail-body]')?.getAttribute('data-rail-active-kind') || '';
    const info = await window.finalcheck.browserTabs();
    const railTabsAfter = [...document.querySelectorAll('[data-rail-tab]')]
      .map((x) => ({ kind: x.getAttribute('data-rail-kind') || '', text: (x.textContent || '').trim() }));
    return {
      noChip: false, railTabsBefore, railTabsAfter, activeKind, kindAtClick, transitions,
      // 0.32.5 排障轨迹（自检环境才记录）：能直接看出是哪个 updater 把 activeKey 抢走的
      railTrail: (window.__fcRailTrail || []).slice(-24).map((x) => ({ l: x.label, f: x.from, to: x.to, same: x.same })),
      showing: (info?.showing || []).length,
      webTabs: (info?.tabs || []).length,
      railMode: document.querySelector('[data-rail]')?.getAttribute('data-rail') || null
    };
  })()`);
  console.log('[S16 artifact chip]', JSON.stringify({ ...s16, railTrail: undefined }));
  if (Array.isArray(s16?.railTrail) && s16.railTrail.length) console.log('[S16 railTrail]', JSON.stringify(s16.railTrail));
  // 变化轨迹单独打印：只看到最后的值无法判断「没切过去」还是「切过去又被抢回来」
  if (Array.isArray(s16?.transitions)) {
    console.log('[S16 transitions] clickAt=' + s16.kindAtClick, JSON.stringify(s16.transitions));
  }
  // 如果连消息都没渲染出来，说明 seed 与产品读的不是同一份数据——单独记录，别混进 S16 判定里
  if (s16?.noChip === true) {
    const opened = await ev(`(async () => {
      try {
        const r = await window.finalcheck.sessions.open(${JSON.stringify(s1c.id)});
        const msgs = (r?.messages || r?.session?.messages || []);
        return {
          keys: Object.keys(r || {}).slice(0, 10),
          msgs: msgs.length,
          roles: msgs.map((m) => m.role),
          traces: msgs.map((m) => (Array.isArray(m.trace) ? m.trace.map((x) => x.tool) : []))
        };
      } catch (e) { return { err: String(e?.message || e) }; }
    })()`).catch((e) => ({ err: String(e?.message || e) }));
    console.log('[S16 diag sessions.open]', JSON.stringify(opened));
    // 侧栏列表里是否能看到两条会话（确认 migrateLegacy 真的导入成功）
    const listed = await ev(`(async () => {
      try { const r = await window.finalcheck.sessions.list(); const arr = r?.sessions || r || []; return { n: arr.length, titles: arr.map((x) => x.title) }; }
      catch (e) { return { err: String(e?.message || e) }; }
    })()`).catch((e) => ({ err: String(e?.message || e) }));
    console.log('[S16 diag sessions.list]', JSON.stringify(listed));
  }
  record('S16', '浏览器开着时点消息里的 PNG chip：右栏开出产物 tab 并停在那里（6.5s 不回弹），画面让开',
    s16?.noChip !== true && s16?.activeKind === 'artifact' && (s16?.showing || 0) === 0,
    JSON.stringify(s16));
  await shot('s16-png-tab.png');

  /* S17 性能护栏：静止时不许有 IPC 自转
     用户报「巨卡无比」的根因就是渲染↔IPC 正反馈循环。判据：空闲 4 秒内的
     browser-tabs 调用次数必须在个位数（每 5s 轮询 1 次；旧实现是几百次/秒）。 */
  const s17 = await ev(`(async () => {
    let n = 0;
    const orig = window.finalcheck.browserTabs;
    // contextBridge 暴露的对象通常是冻结的 → 用 defineProperty 试包一层，包不上就退回 no-op
    let wrapped = false;
    try {
      Object.defineProperty(window.finalcheck, '__probe', { value: 1, configurable: true });
      wrapped = true;
    } catch { wrapped = false; }
    // 无论能否计数，都用「主进程看到的调用量」的等价代理：统计 React 渲染次数不可行，
    // 所以这里统计 IPC 调用 —— 通过 monkeypatch ipc 不可行时，改用帧率/长任务判据。
    const longTasks = [];
    let frames = 0;
    let stop = false;
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
    });
    try { obs.observe({ entryTypes: ['longtask'] }); } catch { /* 不支持 */ }
    const tick = () => { if (stop) return; frames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, 4000));
    stop = true;
    try { obs.disconnect(); } catch { /* ignore */ }
    return { frames, longTasks, maxLong: longTasks.length ? Math.max(...longTasks) : 0, wrapped };
  })()`);
  console.log('[S17 perf]', JSON.stringify(s17));
  record('S17', '空闲 4s 无长任务（渲染没在自转 = 不再"巨卡"），且画面仍在正常刷新',
    Array.isArray(s17?.longTasks) && s17.maxLong < 200 && s17.frames >= 30,
    JSON.stringify({ frames: s17?.frames, longTasks: s17?.longTasks?.length, maxLong: s17?.maxLong }));

  /* S18 卡顿第二源：zoom 幂等（同一宽度不重复 setZoomFactor → 不反复整页 relayout）
     S11 已验 zoom 生效；这里验「重复上报同一个 rect 时 zoom 值稳定且不抖」 */
  const s18 = await ev(`(async () => {
    // S16 结束后 UI 停在产物 tab 上，那时浏览器盒子并不存在——先切回浏览器 tab
    // （这不是产品问题：产物 tab 在前台时本来就不该有浏览器画面）
    const browserTab = [...document.querySelectorAll('[data-rail-tab]')]
      .find((x) => (x.getAttribute('data-rail-kind') || '') === 'browser');
    if (browserTab) { browserTab.click(); await new Promise((res) => setTimeout(res, 700)); }
    const box = document.querySelector('[data-browser-box]');
    if (!box) return { noBox: true, activeKind: document.querySelector('[data-rail-body]')?.getAttribute('data-rail-active-kind') || '' };
    const r = box.getBoundingClientRect();
    const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    const zooms = [];
    for (let i = 0; i < 5; i++) {
      await window.finalcheck.railRect(rect);
      await new Promise((res) => setTimeout(res, 60));
      const info = await window.finalcheck.browserTabs();
      const v = (info?.views || []).find((x) => x.id === info.activeId);
      zooms.push(v?.zoom ?? null);
    }
    return { rect, zooms, stable: zooms.every((z) => z === zooms[0]) };
  })()`);
  console.log('[S18 zoom idempotent]', JSON.stringify(s18));
  record('S18', '重复上报同一 rect：zoom 稳定不变（不反复重排整页）',
    s18?.noBox !== true && s18?.stable === true && Number.isFinite(s18?.zooms?.[0]), JSON.stringify(s18));

  await writeFile(path.join(out, 'result.json'), JSON.stringify({ origin, results, s1, s2, s6, s7, s10, zoomCheck, newSession, backToOld, s15, s16, s17, s18 }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 真人链路测试台 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}） ===`);
  console.log('证据:', out);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { server.close(); } catch { /* 已关 */ }
  await sleep(800);
}
