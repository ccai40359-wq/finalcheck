// CDP 接真 Edge（0.31.0 模式③）：跨进程遥控**用户真实 Edge**（隔离 profile + 随机本地端口）。
//
// 纪律（来自任务书 + datacrawler 的实施经验）：
//   · 0.33.0 起端口随机：--remote-debugging-port=0，Edge 自己挑空闲端口并写进 profile/DevToolsActivePort；
//     连接前用文件里的 GUID 校验「端口上的浏览器就是这个 profile 起的那一个」（CDP 本身无鉴权）。
//     以前固定 9224：任何本机程序都能先占住它冒充，或者直接连上去读用户的登录态。
//   · 9223 是 datacrawler 的端口，显式传入一律拒绝
//   · 独立 profile（默认放在 userData/edge-profile，绝不碰用户日常 Edge 与 datacrawler 的 profile）
//   · 连接断开时**不杀** Edge：人工/半自动启动的浏览器应继续存活，登录态留给下一次
//   · 只引 playwright-core，不引 playwright 完整包（体积：14MB vs 数百 MB + 浏览器下载）
//   · ConnectOverCDP 的 header 用 finalcheck 自己的标识（不冒充其它产品）
//
// 与离屏模式的差异（为什么会有人想用它）：真 UA、真登录态（用户自己扫码登录过的站）。
// 代价：窗口是真实可见的，首次启动会抢前台（这是可接受且必要的——用户要扫码）；后续 CDP 操作不抢前台。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

// 0 = 让 Edge 随机分配（0.33.0 起的默认；以前是固定 9224）
export const DEFAULT_CDP_PORT = 0;
export const LEGACY_CDP_PORT = 9224;
export const CDP_HEADER = 'finalcheck'; // 红线：不冒充其它产品
const LOOPBACK = '127.0.0.1';

// ---- 端口探测（参考实现验证过的抖动处理） ----
// 这台 Windows 的 loopback 会偶发丢包：一个 200 OK 的 /json/version 也可能延迟 1 秒或直接超时。
// 问 3 次，任一次答得上就算「浏览器在」。
export async function isCdpUp(port = DEFAULT_CDP_PORT, attempts = 3) {
  const p = Number(port) || DEFAULT_CDP_PORT;
  if (!p) return false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`http://${LOOPBACK}:${p}/json/version`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return false;
      const body = await res.text();
      return typeof body === 'string' && body.length > 0;
    } catch {
      if (attempt < attempts - 1) await sleep(500 * (attempt + 1));
    }
  }
  return false;
}

// ---- 0.33.0 归属校验：端口上的浏览器必须是「用我们这个 profile 启动的那一个」 ----
// CDP 端口本身没有鉴权。若别的程序占了端口（或用户自己用同一端口开了日常 Edge），
// 我们会把它当成隔离 Edge 去遥控。Chromium 启动时会在 user-data-dir 写 DevToolsActivePort：
//   第 1 行 = 端口，第 2 行 = /devtools/browser/<随机 GUID>
// GUID 每次启动随机生成，只有拿得到这个 profile 目录的进程才知道。
// 端口上 /json/version 报出的 webSocketDebuggerUrl 必须以这个路径结尾，才认定是自己人；
// 之后直接连这个 ws 地址（而不是再问一次 /json/version），中间被换掉也连不上。
export function readActivePort(profile) {
  try {
    const lines = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { port, path: lines[1] || '' };
  } catch { return null; }
}

/** 从 profile 的 DevToolsActivePort 找到端口并校验归属；成功返回 { ok, port, wsEndpoint } */
export async function discoverOwned(profile) {
  const ap = profile ? readActivePort(profile) : null;
  if (!ap) return { ok: false, reason: 'no-active-port-file' };
  const own = await verifyOwnership(ap.port, profile);
  return own.ok ? { ...own, port: ap.port } : own;
}

export async function verifyOwnership(port, profile) {
  const p = Number(port);
  if (!p) return { ok: false, reason: 'no-port' };
  if (!profile) return { ok: false, reason: 'no-profile' };
  let lines;
  try {
    lines = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return { ok: false, reason: 'no-active-port-file' }; }
  if (Number(lines[0]) !== p || !/^\/devtools\/browser\/[\w-]+$/.test(lines[1] || '')) return { ok: false, reason: 'port-mismatch' };
  let ws = '';
  try {
    const res = await fetch(`http://${LOOPBACK}:${p}/json/version`, { signal: AbortSignal.timeout(2500) });
    ws = String((await res.json())?.webSocketDebuggerUrl || '');
  } catch { return { ok: false, reason: 'no-version' }; }
  let wsPath = '';
  try { wsPath = new URL(ws).pathname; } catch { /* 非法 URL */ }
  if (wsPath !== lines[1]) return { ok: false, reason: 'guid-mismatch' };
  return { ok: true, wsEndpoint: `ws://${LOOPBACK}:${p}${lines[1]}` };
}

// ---- 连接（3 次重试：握手失败不等于 Edge 没开，是同一个 loopback 抖动） ----
// 返回 { browser, ctx }；连不上抛 Error('cdp-down') 或 Error('cdp-down:<原因>')。
export async function connect(port = DEFAULT_CDP_PORT, { attempts = 3, wsEndpoint = '' } = {}) {
  const p = Number(port) || DEFAULT_CDP_PORT;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!(await isCdpUp(p))) {
      lastErr = new Error('cdp-down');
      if (attempt < attempts) await sleep(600 * attempt);
      continue;
    }
    try {
      const browser = await chromium.connectOverCDP(wsEndpoint || `http://${LOOPBACK}:${p}`, { headers: { 'User-Agent': CDP_HEADER } });
      const ctx = browser.contexts()[0] || await browser.newContext();
      return { browser, ctx };
    } catch (e) {
      lastErr = new Error('cdp-down:' + String((e && e.message) || e).slice(0, 120));
      if (attempt < attempts) await sleep(600 * attempt);
    }
  }
  throw lastErr || new Error('cdp-down');
}

// ---- 开页 → 执行 → 必关页 ----
export async function withPage(ctx, fn) {
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => { /* 页面可能已被用户手动关掉 */ });
  }
}

// ---- 定位 Edge（Program Files 两个根 + PATH 兜底） ----
export function resolveEdgePath() {
  const roots = [];
  const pf = process.env['ProgramFiles(x86)'];
  const pf2 = process.env.ProgramFiles;
  if (pf) roots.push(pf);
  if (pf2) roots.push(pf2);
  roots.push('C:/Program Files (x86)', 'C:/Program Files');
  for (const r of roots) {
    const candidate = path.resolve(r, 'Microsoft/Edge/Application/msedge.exe');
    if (existsSync(candidate)) return candidate;
  }
  const fromPath = process.env.PATH ? String(process.env.PATH).split(';') : [];
  for (const dir of fromPath) {
    if (!dir) continue;
    try {
      const candidate = path.resolve(dir, 'msedge.exe');
      if (existsSync(candidate)) return candidate;
    } catch {
      // PATH 里有非法项（空串、带引号）：跳过
    }
  }
  throw new Error('msedge.exe 未找到（已查 Program Files (x86) / Program Files / PATH）');
}

// ---- 隔离 profile 目录 ----
// userData 由调用方注入（Electron 里是 app.getPath('userData')）；纯 Node 时给显式目录。
export function profileDir(userDataDir) {
  const base = String(userDataDir || '').trim();
  if (!base) throw new Error('profileDir 需要 userData 目录');
  return path.join(base, 'edge-profile');
}

// 启动参数：抄 D:\rcw-geo\ai-crawler-hk\scripts\open-edge.mjs（已验证可用）
// 关键几条：--disable-features 里的 msImplicitSignin 等（否则新 profile 会弹「同步浏览数据」，
// 那个窗口级 modal 会拦住所有点击）；--use-mock-keychain 避免凭据弹窗。
export function edgeArgs({ port = DEFAULT_CDP_PORT, profile, urls = [] } = {}) {
  return [
    '--remote-debugging-port=' + (Number(port) || 0),
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-fre',
    '--disable-features=msEdgeNotifications,msImplicitSignin,EdgeSyncPromo,msEdgeIdentityFeatureOptimization',
    '--disable-sync',
    '--no-service-autorun',
    '--use-mock-keychain',
    '--disable-component-update',
    ...urls.map(String)
  ];
}

/**
 * 启动隔离 Edge（若端口已就绪则什么都不做——幂等，双击两次不会起第二个实例）。
 * 首次启动窗口在前台是可接受的（用户要扫码登录）；已就绪时不重开。
 * @returns {{ started: boolean, port: number, profile: string, exe: string }}
 */
export async function startIsolatedEdge({ port = DEFAULT_CDP_PORT, profile, urls = [], exe = null, waitMs = 30000 } = {}) {
  if (Number(port) === 9223) throw new Error('拒绝使用 9223：那是 datacrawler 的端口');
  if (!profile) throw new Error('startIsolatedEdge 需要 profile 目录');
  // 已在运行且归属校验通过 → 幂等返回
  const running = await discoverOwned(profile);
  if (running.ok) return { started: false, port: running.port, wsEndpoint: running.wsEndpoint, profile, exe: exe || '' };
  mkdirSync(profile, { recursive: true });
  // 旧的 DevToolsActivePort（上次 Edge 退出后残留）先删，避免读到过期端口
  try { unlinkSync(path.join(profile, 'DevToolsActivePort')); } catch { /* 不存在 */ }
  const resolved = exe || resolveEdgePath();
  const child = spawn(resolved, edgeArgs({ port: 0, profile, urls }), { stdio: 'ignore', detached: true });
  child.unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const own = await discoverOwned(profile);
    if (own.ok) return { started: true, port: own.port, wsEndpoint: own.wsEndpoint, profile, exe: resolved };
  }
  // 最常见原因：这个 profile 已被一个旧版本（固定 9224 端口）启动的 Edge 占着——新进程把参数交给它就退出了
  throw new Error(`cdp-foreign：${Math.round(waitMs / 1000)}s 内没等到隔离 Edge 的调试端口。如果隔离 Edge 的窗口已经开着（旧版本启动的），请先关掉那个窗口再重试。`);
}

/**
 * 断开 CDP 连接 —— **不杀 Edge**。人工启动/已登录的浏览器必须继续存活，
 * 下次连接还能拿到同一套登录态。这是与 close() 的关键区别。
 */
export async function disconnect(browser) {
  if (!browser) return;
  // playwright-core 的 close() 只关 CDP transport，不关远端浏览器进程；
  // 但为了不依赖实现细节，这里显式只做 transport 断开。
  await browser.close().catch(() => { /* 已断开 */ });
}

/**
 * 关掉隔离 Edge 进程（用户显式要求「彻底关闭」时才用）。
 * 通过 CDP 的 Browser.close 命令关闭远端浏览器（playwright 对此有专门语义）。
 */
export async function closeRealEdge(browser) {
  if (!browser) return;
  try {
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.close');
    await session.detach().catch(() => {});
  } catch {
    /* 不支持或已关闭：下面再兜底 transport 断开 */
  }
  await browser.close().catch(() => { /* 已断开 */ });
}

// ---- 登录态判据表（泛化，不写死任何平台专属正则） ----
//
// 设计（任务书的红线）：不要把小红书/Threads 的专属文案写进通用模块。
// 每个平台一条「判据表」，通用引擎只认三类证据：
//   avatar   有头像/已登录标识的 DOM
//   wall     登录墙文案 / 登录按钮
//   none     两者都没有
// 结论：avatar 命中 → signed-in；wall 命中 → signed-out；都没有 → unknown。
// 新增平台只需加一条表项；平台的专属正则集中在表里，不进引擎逻辑。
export const PLATFORM_PLAYBOOKS = Object.freeze({
  xiaohongshu: {
    home: 'https://www.xiaohongshu.com/explore',
    // 小红书未登录时首页给「登录后推荐更懂你的笔记」「扫码」这类文案
    wall: /登录后推荐更懂你的笔记|扫码|新用户可直接登录|登录探索更多内容/,
    avatar: '[class*="avatar"] img, img[class*="avatar"]',
    waitMs: 2500
  },
  threads: {
    home: 'https://www.threads.com/',
    wall: /Log in to Threads|登入後即可|登錄後即可|Scan to log in|^(Log in|Sign up|登入|註冊)$/i,
    avatar: 'img[alt*="profile"], [aria-label*="Profile"]',
    waitMs: 2500
  },
  x: {
    home: 'https://x.com/home',
    wall: /Sign in to X|Join X today|登入 X/i,
    avatar: '[data-testid="SideNav_AccountSwitcher_Button"]',
    waitMs: 2500
  },
  github: {
    home: 'https://github.com/',
    wall: /Sign in to GitHub|Sign up for GitHub/i,
    avatar: '[aria-label*="user navigation"], [data-login]',
    waitMs: 2000
  }
});

export const PLAYBOOK_PLATFORMS = Object.freeze(Object.keys(PLATFORM_PLAYBOOKS));

// 通用判定：给定「页面看到了什么」，返回 { state, detail }。
// state: 'signed-in' | 'signed-out' | 'unknown'
export function judgeLoginState(seen) {
  const avatar = seen?.avatar === true;
  const wall = seen?.wall === true;
  if (avatar && !wall) return { state: 'signed-in', detail: 'logged-in marker on page' };
  if (wall && !avatar) return { state: 'signed-out', detail: 'login wall on page' };
  if (avatar && wall) return { state: 'unknown', detail: 'both markers present (ambiguous)' };
  return { state: 'unknown', detail: 'no login marker either way' };
}

/**
 * 探测某个平台的登录态。
 * @param {object} o
 * @param {string} o.platform    PLATFORM_PLAYBOOKS 的键（未知平台抛错，避免瞎猜）
 * @param {number} [o.port]
 * @param {string|object} [o.url] 可选：覆盖判据表里的首页
 * @returns {Promise<{ state: 'signed-in'|'signed-out'|'unknown'|'unavailable', platform: string, detail: string, url?: string }>}
 */
export async function probeLoginState({ platform, url = '' } = {}) {
  const book = PLATFORM_PLAYBOOKS[String(platform || '').toLowerCase()];
  if (!book) {
    throw new Error(`未支持的平台：${platform}（可用：${PLAYBOOK_PLATFORMS.join(' / ')}）`);
  }
  // 0.33.0：只用已经过归属校验的连接（不再盲连某个固定端口）
  if (!realIsConnected()) return { state: 'unavailable', platform, detail: 'cdp-down：先调用 browser_connect_real' };
  try {
    return await withPage(real.ctx, async (page) => {
      const target = String(url || book.home);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (book.waitMs > 0) await sleep(book.waitMs);
      const seen = await page.evaluate(([wallSource, avatarSelector]) => {
        const text = document.body ? (document.body.innerText || '') : '';
        // 判据（正则源码）由主进程给出：避免在页面里重写平台知识
        let wallHit = false;
        try { wallHit = new RegExp(wallSource, 'i').test(text); } catch { wallHit = false; }
        let avatarHit = false;
        try { avatarHit = !!document.querySelector(avatarSelector); } catch { avatarHit = false; }
        return { wall: wallHit, avatar: avatarHit };
      }, [book.wall.source, book.avatar]);
      const verdict = judgeLoginState(seen);
      return { ...verdict, platform, url: target };
    });
  } catch (e) {
    return { state: 'unavailable', platform, detail: shortNetError(e) };
  }
}

// 页面载不出来不等于「未登录」：网络问题单独归类，便于调用方给出可执行的建议
function shortNetError(e) {
  const msg = String((e && e.message) || e);
  if (/ERR_CONNECTION|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_PROXY/i.test(msg)) {
    return 'network: page did not load (proxy/network down?)';
  }
  return msg.replace(/\s+/g, ' ').slice(0, 120);
}

// ---- 真 Edge 上的页面动作（导航 / 快照 / 点击 / 输入 / 求值 / 截图 / 控制台） ----
//
// 与离屏引擎的接口形状保持一致（navigate / snapshot / click / typeInto / evaluate /
// consoleMessages / screenshot / close），这样工具层可以按 mode 派发而不用写两套。
//
// **不抢前台**：CDP 的 page.click / fill / evaluate 都是合成事件，不激活窗口、不移动鼠标；
// 只有 Edge 首次启动（用户要扫码）会是前台窗口，这是刻意的。
//
// ref 语义与离屏引擎不同：这里用 playwright 自己的 Locator，ref 是「本次会话内的序号」。
// 每个页面各自维护一张 ref → 元素句柄表；页面导航/重载后表失效（旧 ref 一律拒绝）。

// 会话状态（模块级单例）：同一时刻只连一个隔离 Edge
let real = null; // { browser, ctx, port, profile, refs: Map, seq, consoleBuf }

function ensureReal() {
  if (!real) throw new Error('真 Edge 未连接，先调用 browser_connect_real');
  return real;
}

export function realIsConnected() {
  return Boolean(real && real.browser && real.browser.isConnected());
}

export function realInfo() {
  if (!real) return { connected: false, port: 0, profile: '', pid: 0 };
  return {
    connected: realIsConnected(), port: real.port, profile: real.profile,
    pages: real.ctx ? real.ctx.pages().length : 0,
    // 0.31.1：浏览器主进程 id。工具层用它判断「前台窗口是不是我们自己启动的隔离 Edge」——
    // 是的话禁止用 computer_* 去操作它（CDP 不需要前台，用 CU 只会抢用户的键鼠）。
    pid: Number(real.pid) || 0
  };
}

/**
 * 查 CDP 里的浏览器进程 id（用于 CU 混用闸）。失败返回 0（拦不住也不能误伤）。
 * SystemInfo.getProcessInfo 的 processId 就是浏览器主进程 pid；某些版本只返回 browserProcessId，
 * 两处都认，取不到就 0。
 */
export async function browserProcessId() {
  if (!realIsConnected()) return 0;
  try {
    const session = await real.browser.newBrowserCDPSession();
    const info = await session.send('SystemInfo.getProcessInfo');
    await session.detach().catch(() => {});
    const list = Array.isArray(info?.processInfo) ? info.processInfo : [];
    const browserEntry = list.find((x) => x && (x.type === 'browser' || x.type === 'Browser'));
    const pid = Number(browserEntry?.id ?? browserEntry?.processId ?? info?.browserProcessId) || 0;
    if (pid) real.pid = pid;
    return pid;
  } catch { return Number(real.pid) || 0; }
}

/**
 * 连接或启动隔离 Edge（幂等）。已连接则直接返回现有连接。
 * @returns {Promise<{ ok: true, started: boolean, port: number, profile: string, pages: number }>}
 */
export async function connectReal({ port = DEFAULT_CDP_PORT, userDataDir = '', profile = '', urls = [], start = true } = {}) {
  if (Number(port) === 9223) throw new Error('拒绝使用 9223：那是 datacrawler 的端口');
  if (realIsConnected()) return { ok: true, started: false, ...realInfo() };
  const dir = profile || (userDataDir ? profileDir(userDataDir) : '');
  if (!dir) throw new Error('connectReal 需要 profile 或 userDataDir');
  let started = false;
  // 0.33.0：端口从 profile 的 DevToolsActivePort 读、按 GUID 校验归属，再钉死 ws 地址去连
  let own = await discoverOwned(dir);
  if (!own.ok) {
    if (!start) throw new Error('cdp-down：真 Edge 没在运行，且 start=false（不自动启动）');
    const r = await startIsolatedEdge({ profile: dir, urls });
    started = r.started;
    own = await discoverOwned(dir);
    if (!own.ok) throw new Error(`cdp-foreign：隔离 Edge 的调试端口没通过归属校验（${own.reason}），拒绝遥控。`);
  }
  const p = own.port;
  const conn = await connect(p, { wsEndpoint: own.wsEndpoint });
  real = { browser: conn.browser, ctx: conn.ctx, port: p, profile: dir, refs: new Map(), seq: 0, consoleBuf: [], pageUrl: '' };
  // 控制台：只收集「当前页」的消息（和离屏引擎一样的取最近 50 条语义）
  const bind = (page) => {
    try {
      page.on('console', (msg) => {
        real?.consoleBuf.push({ level: msg.type(), text: String(msg.text() || '').slice(0, 300) });
        if (real && real.consoleBuf.length > 50) real.consoleBuf.splice(0, real.consoleBuf.length - 50);
      });
    } catch { /* 页面可能已关 */ }
  };
  for (const page of conn.ctx.pages()) bind(page);
  conn.ctx.on('page', bind);
  // 0.31.1：先把浏览器主进程 pid 查出来（CU 混用闸要用它判断前台窗口是不是这套隔离 Edge）。
  // 查不到就给 0——拦不住也好过误判成「用户日常浏览器」而放开 CU 去操作。
  await browserProcessId().catch(() => 0);
  return { ok: true, started, ...realInfo() };
}

/**
 * 断开连接，Edge 保持运行（人工/半自动启动的浏览器不该被杀）。
 */
export async function disconnectReal() {
  if (!real) return { ok: true, connected: false, note: '本来就没连' };
  const browser = real.browser;
  const info = { port: real.port, profile: real.profile };
  real = null;
  await disconnect(browser);
  return { ok: true, connected: false, ...info, note: 'CDP 连接已断开；Edge 仍在运行（登录态保留）' };
}

/**
 * 显式关闭隔离 Edge（用户要求彻底关闭时才用）。正常断开请用 disconnectReal。
 */
export async function closeRealEdgeAndReset() {
  if (!real) return { ok: true, connected: false, note: '本来就没连' };
  const browser = real.browser;
  const info = { port: real.port, profile: real.profile };
  real = null;
  await closeRealEdge(browser);
  return { ok: true, connected: false, ...info, note: '隔离 Edge 已关闭' };
}

async function pageOf() {
  const r = ensureReal();
  const pages = r.ctx.pages();
  const active = pages.find((p) => p.url() === r.pageUrl) || pages[0] || null;
  if (!active) throw new Error('真 Edge 里没有打开的页面，先调用 browser_navigate');
  return active;
}

/** 导航到 url，并刷新 ref 表（导航后旧 ref 全部失效）。 */
export async function navigateReal(url, { waitMs = 0, observe = false } = {}) {
  const r = ensureReal();
  const page = await pageOf().catch(async () => {
    const created = await r.ctx.newPage();
    return created;
  });
  r.refs.clear();
  r.seq = 0;
  r.consoleBuf = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (waitMs > 0) await sleep(waitMs);
  // 轻量 settle：等 document readyState=complete（不抢前台、不加长等待）
  await page.waitForLoadState('load', { timeout: 10000 }).catch(() => { /* 慢页面：domcontentloaded 已经够 */ });
  r.pageUrl = page.url();
  const result = { ok: true, url: page.url(), title: await page.title() };
  if (observe) result.snapshot = await snapshotReal();
  return result;
}

/** 结构快照：返回与离屏引擎同形状的 { ok, title, url, tree, nodeCount, truncated }。 */
export async function snapshotReal({ maxNodes = 220, includeText = true, query = '' } = {}) {
  const r = ensureReal();
  r.refs.clear();
  r.seq = 0;
  const page = await pageOf();
  r.pageUrl = page.url();
  const limit = Math.max(1, Math.min(2000, Math.floor(Number(maxNodes)) || 220));
  const match = String(query || '').trim().toLowerCase();
  // 在页面里一次性抽取「可操作 + 结构化」节点；ref 由主进程顺序分配（不靠 ID/坐标）
  const raw = await page.evaluate(({ includeText: withText }) => {
    const actionTags = ['button', 'input', 'textarea', 'select', 'summary'];
    const structural = ['a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'main', 'nav', 'p', 'td', 'label', 'img', 'section', 'article', 'form'];
    const skip = ['script', 'style', 'noscript', 'template'];
    const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    // 敏感输入框（密码/隐藏/卡号/验证码）的值绝不进快照——快照会原样发给模型网关。
    // 与 locatorOf 里的 nameOf 必须同一口径，否则动作时签名对不上。
    const sensitive = (el) => el.localName === 'input' && (/^(password|hidden)$/i.test(el.type || '')
      || /(password|cc-|one-time-code)/i.test(el.getAttribute('autocomplete') || ''));
    const out = [];
    const walk = (el, depth) => {
      if (!el || el.nodeType !== 1) return;
      const tag = el.localName.toLowerCase();
      if (skip.includes(tag)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      const style = getComputedStyle(el);
      if (style.display === 'none' || Number(style.opacity) === 0) return;
      const role = el.getAttribute('role') || (tag === 'a' && el.hasAttribute('href') ? 'link' : (tag === 'textarea' ? 'textbox' : tag));
      const actionable = actionTags.includes(tag) || role === 'button' || role === 'link' || el.hasAttribute('onclick')
        || tag === 'input' || role === 'textbox' || role === 'checkbox' || role === 'combobox';
      const name = norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText
        || (tag === 'input' && !sensitive(el) ? el.value : '') || el.getAttribute('alt') || el.getAttribute('title')).slice(0, 80);
      const text = withText && !actionable ? norm(el.innerText).slice(0, 100) : '';
      if (actionable || structural.includes(tag) || el.hasAttribute('role')) {
        out.push({ tag, role, name, actionable, depth, text, href: el.hasAttribute('href') ? norm(el.getAttribute('href')).slice(0, 80) : '' });
      }
      const childDepth = actionable || structural.includes(tag) || el.hasAttribute('role') ? depth + 1 : depth;
      for (const child of el.children) walk(child, childDepth);
    };
    if (document.body) walk(document.body, 0);
    return { title: document.title, url: location.href, nodes: out };
  }, { includeText: includeText !== false });

  const tree = [];
  let truncated = false;
  // 签名计数：同一组（tag|role|name）在本次快照里出现了几次 —— 动作时用它做 fail-closed 复核。
  // 页面在两次调用之间新增/删除了同名控件时总数会变，此时拒绝执行（宁可不点，也不点错）。
  const signatureTotals = new Map();
  for (const node of raw.nodes) {
    const lineText = `${node.role} ${node.name} ${node.text} ${node.href}`.toLowerCase();
    if (match && !lineText.includes(match)) continue;
    if (tree.length >= limit) { truncated = true; break; }
    let line = `${'  '.repeat(node.depth)}- ${node.role}`;
    if (node.name) line += ` ${JSON.stringify(node.name)}`;
    if (node.actionable) {
      const sig = `${node.tag}|${node.role}|${node.name}`;
      const ordinal = signatureTotals.get(sig) || 0;
      signatureTotals.set(sig, ordinal + 1);
      const ref = `r${++r.seq}`;
      // total 先记 0，循环结束后回填（快照期还不知道同名控件总数）
      r.refs.set(ref, { tag: node.tag, role: node.role, name: node.name, ordinal, total: 0, sig });
      line += ` [ref=${ref}]`;
    }
    if (node.href) line += ` href=${JSON.stringify(node.href)}`;
    tree.push(line);
    if (node.text) {
      if (tree.length >= limit) { truncated = true; break; }
      tree.push(`${'  '.repeat(node.depth + 1)}${node.text}`);
    }
  }
  for (const entry of r.refs.values()) entry.total = signatureTotals.get(entry.sig) || 1;
  return {
    ok: true, title: raw.title, url: raw.url, tree: tree.join('\n'),
    nodeCount: tree.length, truncated, note: '可用 ref 点击和填写页面控件（ref 只在当前文档有效）。'
  };
}

// 把 ref 解析成 playwright Locator，并在解析时做「身份复核」（fail-closed）。
//
// 做法：快照时在页面里给每个可操作节点算一个**稳定签名**（tag + 可访问名 + 角色），
// 并记录「同签名元素里的第几个」。动作时重新扫一遍页面：
//   · 同签名总数与快照时不一致（页面重渲染/新增同名控件）→ 拒绝（可能点错）
//   · 找不到 → 拒绝（ref 已失效）
//   · 恰好一致 → 取第 N 个，落到 playwright Locator 上
// 不做 nth(固定索引) 的盲定位，也不用坐标；页面变过就要求重新快照。
async function locatorOf(ref) {
  const r = ensureReal();
  const entry = r.refs.get(String(ref || ''));
  if (!entry) throw new Error('引用已失效，先调用 browser_snapshot 获取当前元素的 ref');
  const page = await pageOf();
  const found = await page.evaluate(({ tag, name, role, ordinal, total, marker }) => {
    const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    const sensitive = (el) => el.localName === 'input' && (/^(password|hidden)$/i.test(el.type || '')
      || /(password|cc-|one-time-code)/i.test(el.getAttribute('autocomplete') || ''));
    const nameOf = (el) => norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText
      || (el.localName === 'input' && !sensitive(el) ? el.value : '') || el.getAttribute('alt') || el.getAttribute('title')).slice(0, 80);
    const roleOf = (el) => el.getAttribute('role') || (el.localName === 'a' && el.hasAttribute('href') ? 'link'
      : (el.localName === 'textarea' ? 'textbox' : el.localName));
    const all = [...document.querySelectorAll('*')].filter((el) => {
      if (el.localName !== tag) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && Number(style.opacity) !== 0;
    });
    const same = all.filter((el) => nameOf(el) === name && roleOf(el) === role);
    if (same.length !== total) return { ok: false, reason: `同签名元素数变化（快照 ${total} → 现在 ${same.length}）` };
    const el = same[ordinal];
    if (!el) return { ok: false, reason: '序号越界' };
    // 标记必须唯一：只用 ordinal 会碰撞（快照里「第 0 个 button」和「第 0 个 input」都是 0，
    // 于是 fill 会拿到 button 并报 "not an <input>"）。用 ref 本身做标记值，天生唯一。
    el.setAttribute('data-fc-real', marker);
    return { ok: true };
  }, { tag: entry.tag, name: entry.name, role: entry.role, ordinal: entry.ordinal, total: entry.total, marker: String(ref) });
  if (!found.ok) throw new Error(`引用已失效（${found.reason}），先调用 browser_snapshot 获取当前元素的 ref`);
  return page.locator(`[data-fc-real="${String(ref)}"]`).first();
}

/** 点击 ref（CDP 合成事件，不激活窗口、不抢前台）。 */
export async function clickReal(ref, { observe = false } = {}) {
  const loc = await locatorOf(ref);
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { /* 已在视口内 */ });
  await loc.click({ timeout: 10000 });
  const result = { ok: true, ref: String(ref) };
  if (observe) result.snapshot = await snapshotReal();
  return result;
}

/** 往 ref 对应的输入控件填文字。 */
export async function typeIntoReal(ref, text) {
  const loc = await locatorOf(ref);
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { /* 已在视口内 */ });
  await loc.fill(String(text ?? ''), { timeout: 10000 });
  return { ok: true, ref: String(ref), note: '已输入。提交表单前建议 browser_snapshot 确认填对了' };
}

/** 在当前页执行 JS（只读用途优先）。 */
export async function evaluateReal(expression) {
  const page = await pageOf();
  const value = await page.evaluate((expr) => {
    // 表达式在页面内执行；这里必须用 Function 构造（表达式是运行时字符串，不是源码里的代码）
    const fn = new Function(`return (async () => { return (${expr}); })()`);
    return fn();
  }, String(expression));
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  return { ok: true, result: text && text.length > 2000 ? text.slice(0, 2000) + '…' : text };
}

export function consoleMessagesReal() {
  const r = real;
  if (!r) return { ok: false, error: '真 Edge 未连接，先调用 browser_connect_real' };
  return { ok: true, messages: r.consoleBuf.slice() };
}

/** 截当前页（真 Edge 的页面内容，不是屏幕截图）。 */
export async function screenshotReal() {
  const page = await pageOf();
  const buf = await page.screenshot({ type: 'png' });
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  return { ok: true, buf, mime: 'image/png', ...size };
}
