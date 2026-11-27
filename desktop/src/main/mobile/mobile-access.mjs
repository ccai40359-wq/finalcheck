// 手机访问（0.35）：手机浏览器打开的就是这台电脑上正在跑的 FinalCheck —— 同一个引擎、同一个会话、同一轮对话。
//
// 原理（手机和电脑连的是「同一个后端」，所以天然同屏）：
//   · 手机上跑的是同一份渲染层（out/mobile，由 scripts/build-mobile.mjs 打包，只把 electron 换成网络桥）
//   · 手机的每次 ipcRenderer.invoke → POST /api/rpc → 直接调主进程里同名的 ipcMain 处理函数
//   · 主进程发给窗口的每个事件（流式输出、审批卡、提问卡……）同时推给手机（SSE /api/events，断线按游标续传）
//   · 一边改了会话 / 项目，另一边收到 finalcheck:sync 刷新列表；一边开了新回合，另一边当前停在这个会话就自动接上
//
// 安全：配对码（10 分钟、一次性，只在电脑的设置页显示）→ 绑定一台设备 → 设备凭证（只存哈希）。
// 手机不能改「手机访问」本身、不能改 hooks、不能切到完全权限、拿不到 API Key、碰不到电脑上的内嵌浏览器窗口。
// 默认只监听 127.0.0.1（配合反向隧道 / Tailscale / Cloudflare Tunnel 用）；局域网直连要在设置里单独打开。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createTunnel, validTarget, validPublicUrl, normPublicUrl } from './tunnel.mjs';

export const KEY_MASK = '••••••••';
export const DEFAULT_PORT = 7788;
const PAIR_TTL_MS = 10 * 60 * 1000;
const EVENT_KEEP = 4000;
const BIG_EVENT_BYTES = 48 * 1024;        // 比这大的事件不进事件流，手机按需取
const BIG_KEEP_BYTES = 64 * 1024 * 1024;  // 大事件最多留这么多（旧的先丢；手机取不到就整页重载）
const MAX_REPLAY_BYTES = 1024 * 1024;     // 重连要补的超过这个：直接让手机重载
const MAX_BACKLOG_BYTES = 4 * 1024 * 1024;
const RPC_WAIT_MS = 20000;
const RPC_RESULT_TTL = 10 * 60 * 1000;
const TICKET_TTL_MS = 60 * 1000;
const MAX_STREAMS = 8;
const MAX_DEVICE_TOKENS = 8;

/** 改了「会话 / 项目列表」的调用：做完后通知所有端刷新列表 */
export const SYNC_CHANNELS = new Map([
  ['finalcheck:sessions:new', 'sessions'], ['finalcheck:sessions:delete', 'sessions'], ['finalcheck:sessions:rename', 'sessions'],
  ['finalcheck:sessions:flags', 'sessions'], ['finalcheck:sessions:rewind', 'session'], ['finalcheck:sessions:move', 'sessions'],
  ['finalcheck:sessions:set-model', 'sessions'], ['finalcheck:compact-session', 'session'], ['finalcheck:checkpoint-restore', 'session'],
  ['finalcheck:projects:add', 'projects'], ['finalcheck:projects:remove', 'projects'],
  ['finalcheck:set-config', 'config'], ['finalcheck:sessions:queue-save', 'queue']
]);

const PHONE_SILENT = new Set(['finalcheck:window-ctl', 'finalcheck:rail-rect', 'finalcheck:rail-visible', 'finalcheck:browser-panel-session',
  'finalcheck:browser-panel-close', 'finalcheck:browser-tab-focus', 'finalcheck:browser-tabs']);

/** 手机端不能调的：要么直接在电脑上执行命令，要么操作的是电脑屏幕上的窗口，要么是「手机访问」自己的开关 */
export function phoneDenyReason(channel) {
  if (channel === 'finalcheck:hooks-save' || channel === 'finalcheck:hooks-test') return 'hooks 会直接在电脑上执行命令，手机上不能修改，请在电脑上设置';
  if (channel.startsWith('finalcheck:mobile:')) return '手机访问的设置只能在电脑上改';
  // 界面跟着布局自动发的（右栏位置、当前会话的浏览器、刷新标签列表）：手机上没有那个原生窗口，静默返回空
  if (PHONE_SILENT.has(channel)) return '';
  if (channel === 'finalcheck:browser-session-info') return null; // 只读：设置页显示记不记登录
  if (channel.startsWith('finalcheck:browser-') || channel.startsWith('finalcheck:rail-')) return '内置浏览器窗口在电脑上，手机上不能操作';
  if (channel === 'finalcheck:update:install' || channel === 'finalcheck:update:download') return '更新请在电脑上安装';
  return null;
}

// ---------- 二进制 <-> JSON ----------
export function encodeOut(v, depth = 0) {
  if (depth > 40) return null;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __fcb64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  if (v instanceof ArrayBuffer) return { __fcb64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map((x) => encodeOut(x, depth + 1));
  if (v instanceof Map) return encodeOut(Object.fromEntries(v), depth + 1);
  if (v instanceof Set) return [...v].map((x) => encodeOut(x, depth + 1));
  if (v instanceof Error) return { error: v.message };
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    if (typeof v.toJSON === 'function') return encodeOut(v.toJSON(), depth + 1);
    const o = {};
    for (const k of Object.keys(v)) {
      const x = v[k];
      if (x === undefined || typeof x === 'function') continue;
      o[k] = encodeOut(x, depth + 1);
    }
    return o;
  }
  return v;
}
export function decodeIn(v, depth = 0) {
  if (depth > 40) return null;
  if (Array.isArray(v)) return v.map((x) => decodeIn(x, depth + 1));
  if (v && typeof v === 'object') {
    if (typeof v.__fcb64 === 'string' && Object.keys(v).length === 1) return Buffer.from(v.__fcb64, 'base64');
    const o = {};
    for (const k of Object.keys(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      o[k] = decodeIn(v[k], depth + 1);
    }
    return o;
  }
  return v;
}

const originOf = (u) => { try { return new URL(String(u)).origin; } catch { return null; } };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------- 配置：Key 不下发；保存时按「同一网关地址」换回 ----------
export function maskConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return cfg;
  const out = { ...cfg };
  if (Array.isArray(cfg.providers)) out.providers = cfg.providers.map((p) => (p && p.apiKey ? { ...p, apiKey: KEY_MASK } : p));
  if (typeof cfg.apiKey === 'string' && cfg.apiKey) out.apiKey = KEY_MASK;
  if (cfg.webSearch && typeof cfg.webSearch === 'object') {
    const ws = { ...cfg.webSearch };
    for (const k of Object.keys(ws)) if (/key|token|secret/i.test(k) && typeof ws[k] === 'string' && ws[k]) ws[k] = KEY_MASK;
    out.webSearch = ws;
  }
  return out;
}
export function restoreKeys(next, old) {
  if (!next || typeof next !== 'object') return next;
  const oldProviders = Array.isArray(old?.providers) ? old.providers : [];
  const out = { ...next };
  if (Array.isArray(next.providers)) {
    out.providers = next.providers.map((p) => {
      if (!p || p.apiKey !== KEY_MASK) return p;
      const prev = oldProviders.find((o) => o && o.id === p.id);
      // 网关地址被改过：原 Key 不跟过去（防止「改个地址就把 Key 发到别处」）
      const same = prev && originOf(prev.baseUrl) && originOf(prev.baseUrl) === originOf(p.baseUrl);
      return { ...p, apiKey: same ? prev.apiKey : '' };
    });
  }
  if (next.apiKey === KEY_MASK) out.apiKey = originOf(old?.baseUrl) === originOf(next.baseUrl) ? old.apiKey : '';
  if (next.webSearch && typeof next.webSearch === 'object') {
    const ws = { ...next.webSearch };
    for (const k of Object.keys(ws)) if (ws[k] === KEY_MASK) ws[k] = old?.webSearch?.[k] ?? '';
    out.webSearch = ws;
  }
  return out;
}

/** 本机可用于局域网访问的 IPv4 地址 */
// 虚拟网卡（虚拟机 / WSL / 容器 / VPN 隧道 / 蓝牙）手机连不上，不列出来
const VIRTUAL_NIC = /vmware|virtualbox|vbox|vethernet|hyper-v|wsl|docker|podman|\btap\b|tap-windows|npcap|loopback|bluetooth|蓝牙|zerotier|tailscale|utun|vnic|^br-|^veth|^virbr/i;
/** 电脑开的「移动热点」（Windows 网络共享固定用 192.168.137.1）：只有手机连着电脑热点时才有用 */
export const isHotspotAddress = (ip) => ip === '192.168.137.1';

/** 本机可用于局域网访问的 IPv4 地址：真实 Wi-Fi / 网线在前，电脑热点在后，虚拟网卡不列 */
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL_NIC.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || /^169\.254\./.test(a.address)) continue;
      out.push({ name, address: a.address, hotspot: isHotspotAddress(a.address) });
    }
  }
  return out.sort((x, y) => Number(x.hotspot) - Number(y.hotspot));
}

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/**
 * @param {object} o
 * @param {string} o.dataRoot        手机访问的状态文件放这里（mobile-access.json）
 * @param {string} o.staticDir       out/mobile（手机网页）
 * @param {() => string} o.configFile
 * @param {(line: string) => void} [o.log]
 * @param {Record<string, string>} [o.env]
 */
export function createMobileAccess({ dataRoot, staticDir, configFile, log = () => {}, env = process.env, loginItem = null, tunnelDeps = {} }) {
  const stateFile = path.join(dataRoot, 'mobile-access.json');
  const handlers = new Map();      // channel → 注册到 ipcMain 的处理函数（含错误边界）
  const rawHandlers = new Map();   // channel → 原处理函数（不带同步 / 项目切换包装）
  let win = null;
  let server = null;
  let listening = null;            // { host, port }
  let lastError = '';
  const pairCodes = new Map();     // code → createdAt
  const tickets = new Map();       // ticket → { at, deviceId }
  const clients = new Set();       // SSE 响应
  const events = [];               // { seq, frame }：已序列化好的 SSE 帧（大事件是占位帧）
  const bigEvents = new Map();     // seq → 完整事件 JSON
  let bigBytes = 0;
  const gzCache = new Map();       // 静态文件 → 压缩后的内容
  let seq = 0;
  const results = new Map();       // 长调用结果：id → entry
  const prompts = new Map();       // 还没处理的审批 / 提问：callId → { channel, payload, at }
  const PROMPT_TTL = { 'finalcheck:approval-request': 125 * 1000, 'finalcheck:ask-user': 6 * 3600 * 1000 };
  // 本次启动的随机 id：/api/ping 回它，隧道据此确认「公网地址连到的确实是我」
  const instanceId = crypto.randomBytes(12).toString('base64url');
  // 手机在线情况（只在内存里）：最近一次请求的时间、从哪条路来的
  const presence = { lastSeenAt: 0, via: '' };

  // ---------- 持久状态 ----------
  const NO_TUNNEL = { enabled: false, target: '', remotePort: DEFAULT_PORT, publicUrl: '' };
  let saved = readState();
  function readTunnel(t) {
    if (!t || typeof t !== 'object') return { ...NO_TUNNEL };
    return {
      enabled: t.enabled === true,
      target: validTarget(t.target) ? t.target : '',
      remotePort: Number.isInteger(t.remotePort) && t.remotePort >= 1024 && t.remotePort < 65536 ? t.remotePort : DEFAULT_PORT,
      publicUrl: validPublicUrl(t.publicUrl) ? normPublicUrl(t.publicUrl) : ''
    };
  }
  function readState() {
    try {
      const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return {
        enabled: j.enabled === true,
        port: Number.isInteger(j.port) && j.port > 0 && j.port < 65536 ? j.port : DEFAULT_PORT,
        lan: j.lan === true,
        device: j.device && typeof j.device.deviceId === 'string' ? j.device : null,
        tokens: Array.isArray(j.tokens) ? j.tokens.filter((x) => typeof x?.hash === 'string').slice(-MAX_DEVICE_TOKENS) : [],
        tunnel: readTunnel(j.tunnel)
      };
    } catch { return { enabled: false, port: DEFAULT_PORT, lan: false, device: null, tokens: [], tunnel: { ...NO_TUNNEL } }; }
  }

  // ---------- 外网隧道 ----------
  const tunnelReady = () => saved.tunnel.enabled && validTarget(saved.tunnel.target) && !!listening;
  const tunnel = createTunnel({
    instanceId,
    config: () => (tunnelReady() ? { target: saved.tunnel.target, remotePort: saved.tunnel.remotePort, localPort: listening.port, publicUrl: saved.tunnel.publicUrl } : null),
    onChange: () => emitAll('finalcheck:mobile:changed', publicState()),
    log,
    ...tunnelDeps
  });
  let tunnelKey = '';
  function syncTunnel() {
    const key = tunnelReady() ? JSON.stringify([saved.tunnel, listening.port]) : '';
    if (key === tunnelKey) return;
    tunnelKey = key;
    if (key) tunnel.start(); else tunnel.stop();
  }
  function writeState() {
    fs.mkdirSync(dataRoot, { recursive: true });
    const tmp = stateFile + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, stateFile);
  }

  // ---------- 1. 收集 ipcMain 处理函数（要在任何 handle 注册之前调用） ----------
  function captureIpc(ipcMain) {
    if (ipcMain.__fcMobileCapture) return;
    Object.defineProperty(ipcMain, '__fcMobileCapture', { value: true });
    const prevHandle = ipcMain.handle.bind(ipcMain);
    const prevRemove = ipcMain.removeHandler.bind(ipcMain);
    ipcMain.handle = (channel, fn) => {
      if (typeof fn === 'function') rawHandlers.set(channel, fn);
      const synced = typeof fn === 'function' ? wrapForSync(channel, fn) : fn;
      const wrapped = typeof synced === 'function' ? wrapForProject(channel, synced) : synced;
      handlers.set(channel, wrapped);
      return prevHandle(channel, wrapped);
    };
    ipcMain.removeHandler = (channel) => { handlers.delete(channel); return prevRemove(channel); };
  }

  // ---------- 每端各自的「当前项目」 ----------
  // 主进程只有一个「当前项目」（会话目录 / 记忆目录 / activeProjectId）。两端都在用时，手机点开别的项目的会话
  // 会把电脑的当前项目也切走：电脑侧栏按当前项目列会话，就把另一个项目的会话挂到自己项目下面了。
  // 做法：记住每端自己选的项目；依赖「当前项目」的那几个调用，执行前先把主进程切到调用方的项目（加锁，两端不交错）。
  // 只有电脑在用（手机没选过项目）时完全不介入，和以前一模一样。
  const PROJECT_SCOPED = new Set(['finalcheck:sessions:list', 'finalcheck:sessions:new', 'finalcheck:agent-chat',
    'finalcheck:projects:current', 'finalcheck:project-files', 'finalcheck:project-browse']);
  const projectOf = { desktop: null, phone: null };
  let projectLock = Promise.resolve();
  const rawCurrent = async () => { try { const v = await rawHandlers.get('finalcheck:projects:current')?.({ sender: null }); return typeof v === 'string' ? v : null; } catch { return null; } };
  const rawSelect = async (id) => { try { await rawHandlers.get('finalcheck:projects:select')?.({ sender: null }, id); } catch { /* 项目没了：留在当前项目 */ } };
  async function underProject(want, fn) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const prev = projectLock;
    projectLock = prev.then(() => gate);
    await prev;
    // 回合 / 长调用开头就快照了项目路径：最多占 3 秒，之后放行另一端（不让一轮对话把另一端卡住）
    const timer = setTimeout(release, 3000);
    try {
      if (want && (await rawCurrent()) !== want) await rawSelect(want);
      return await fn();
    } finally { clearTimeout(timer); release(); }
  }
  function wrapForProject(channel, fn) {
    const whoOf = (e) => (e?.fromPhone ? 'phone' : 'desktop');
    if (channel === 'finalcheck:projects:select') {
      return async (e, id, ...rest) => {
        const who = whoOf(e);
        // 手机第一次切项目：先记下电脑此刻的项目，之后电脑的调用才能切回来
        if (who === 'phone' && !projectOf.desktop) projectOf.desktop = await rawCurrent();
        return underProject(null, async () => {
          const r = await fn(e, id, ...rest);
          if (r && typeof r === 'object' && r.id) projectOf[who] = r.id;
          return r;
        });
      };
    }
    if (channel === 'finalcheck:projects:remove') {
      return async (e, id, ...rest) => {
        const r = await underProject(null, () => fn(e, id, ...rest));
        for (const k of Object.keys(projectOf)) if (projectOf[k] === id) projectOf[k] = null;
        return r;
      };
    }
    if (channel === 'finalcheck:sessions:new') {
      // 界面带了项目 id（0.35 起）：建在那个项目里——不靠「记住每端选了哪个项目」，重启 / 断线后也不会建错地方
      return (e, title, projectId, ...rest) => {
        const who = whoOf(e);
        const want = typeof projectId === 'string' && projectId ? projectId : projectOf[who];
        if (want) projectOf[who] = want;
        if (!want || (!projectOf.phone && who === 'desktop' && !projectId)) return fn(e, title, ...rest);
        return underProject(want, () => fn(e, title, ...rest));
      };
    }
    if (!PROJECT_SCOPED.has(channel)) return fn;
    return (e, ...args) => {
      const who = whoOf(e);
      if (!projectOf.phone) return fn(e, ...args); // 手机没在用：不介入
      if (channel === 'finalcheck:projects:current' && projectOf[who]) return projectOf[who];
      return underProject(projectOf[who], () => fn(e, ...args));
    };
  }

  // 改动类调用做完后广播 sync；审批 / 提问被任一端处理后，通知其它端收起卡片
  function wrapForSync(channel, fn) {
    const scope = SYNC_CHANNELS.get(channel);
    const whoOf = (e) => (e?.fromPhone ? 'phone' : 'desktop');
    if (channel === 'finalcheck:agent-chat') {
      // (messages, confirmedHosts, sessionId, opts)：回合开始 / 结束都让另一端刷新侧栏（新会话、更新时间、未读点）
      return async (e, ...args) => {
        const sid = typeof args[2] === 'string' ? args[2] : null;
        emitAll('finalcheck:sync', { scope: 'sessions', channel, sessionId: sid, phase: 'start', origin: whoOf(e) });
        try { return await fn(e, ...args); } finally {
          emitAll('finalcheck:sync', { scope: 'sessions', channel, sessionId: sid, phase: 'end', origin: whoOf(e) });
        }
      };
    }
    if (channel === 'finalcheck:approval-decide') {
      return async (e, callId, ...rest) => {
        const r = await fn(e, callId, ...rest);
        prompts.delete(String(callId ?? ''));
        emitAll('finalcheck:approval-resolved', { callId: String(callId ?? ''), origin: whoOf(e) });
        return r;
      };
    }
    if (channel === 'finalcheck:ask-user-answer') {
      return async (e, payload, ...rest) => {
        const r = await fn(e, payload, ...rest);
        const callId = String(payload?.callId ?? '');
        prompts.delete(callId);
        emitAll('finalcheck:ask-user-resolved', { callId, ok: !!r?.ok, answer: r?.answer ?? '', origin: whoOf(e) });
        return r;
      };
    }
    if (!scope) return fn;
    return async (e, ...args) => {
      const r = await fn(e, ...args);
      const sessionId = typeof args[0] === 'string' ? args[0] : (args[0]?.sessionId ?? args[0]?.id ?? null);
      emitAll('finalcheck:sync', { scope, channel, sessionId, origin: whoOf(e) });
      return r;
    };
  }

  // ---------- 2. 主进程 → 窗口的事件同时推给手机 ----------
  function attachWindow(w) {
    win = w;
    const wc = w?.webContents;
    if (!wc || wc.__fcMobileMirror) return;
    Object.defineProperty(wc, '__fcMobileMirror', { value: true });
    const send = wc.send.bind(wc);
    wc.send = (channel, ...args) => {
      try { send(channel, ...args); } finally { mirror(channel, args[0]); }
    };
  }
  /** 发给电脑窗口（已镜像给手机）；窗口不在时只发手机 */
  function emitAll(channel, payload) {
    if (win && !win.isDestroyed?.()) {
      try { win.webContents.send(channel, payload); return; } catch { /* 窗口正在销毁 */ }
    }
    mirror(channel, payload);
  }
  // 只交给电脑端的事件：会触发「自动发一条消息」的（两端都收到就会发两遍），以及电脑窗口专属的
  const DESKTOP_ONLY = new Set(['finalcheck:wakeup-due', 'finalcheck:bg-task-done', 'finalcheck:browser-first-use',
    'finalcheck:browser-tabs-changed', 'finalcheck:browser-rail-open', 'finalcheck:update-event',
    'finalcheck:mobile:changed']); // 手机访问自己的状态（隧道服务器、设备）只给电脑看
  function mirror(channel, payload) {
    if (typeof channel !== 'string' || DESKTOP_ONLY.has(channel)) return;
    if (PROMPT_TTL[channel] && payload?.callId) prompts.set(String(payload.callId), { channel, payload, at: Date.now() });
    else if (channel === 'finalcheck:agent-event' && payload?.ev?.kind === 'run-settled' && payload.sessionId != null) {
      for (const [k, v] of prompts) if (v.channel === 'finalcheck:ask-user' && String(v.payload.sessionId) === String(payload.sessionId)) prompts.delete(k);
    }
    if (!listening && !clients.size) return; // 没开手机访问：不攒事件
    push({ channel, payload: encodeOut(payload) });
  }
  // 大事件（截图、长工具输出、长调用结果）不走事件流：流里只放一个「去取」的占位，手机按 seq 用 HTTP（gzip）单独取。
  // 否则弱网 / 隧道下几 MB 的事件会把流堵死：积压超限被掐断 → 重连补发又是这几 MB → 永远连不上，其它请求也排不上队。
  function push(obj) {
    const ev = { ...obj, seq: ++seq };
    const json = JSON.stringify(ev);
    let data = json;
    if (json.length > BIG_EVENT_BYTES) {
      bigEvents.set(ev.seq, json);
      bigBytes += json.length;
      for (const [k, v] of bigEvents) { if (bigBytes <= BIG_KEEP_BYTES || k === ev.seq) break; bigEvents.delete(k); bigBytes -= v.length; }
      data = JSON.stringify({ seq: ev.seq, big: json.length });
    }
    const frame = `id: ${ev.seq}\ndata: ${data}\n\n`;
    events.push({ seq: ev.seq, frame });
    if (events.length > EVENT_KEEP) events.shift();
    for (const res of clients) {
      if (res.writableLength > MAX_BACKLOG_BYTES) { res.destroy(); clients.delete(res); } else res.write(frame);
    }
  }

  // ---------- 3. 手机调主进程 ----------
  const phoneSender = {
    id: -1, isDestroyed: () => false,
    send: (channel, payload) => mirror(channel, payload) // 处理函数「回给调用方」的消息：推给手机
  };
  function readRawConfig() {
    try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch { return {}; }
  }
  async function call(channel, args) {
    const deny = phoneDenyReason(channel);
    if (deny === '') return null;
    if (deny) throw new HttpError(403, deny);
    const fn = handlers.get(channel);
    if (!fn) throw new HttpError(501, '电脑端没有这个功能');
    const ev = { sender: phoneSender, senderFrame: null, fromPhone: true };
    if (channel === 'finalcheck:get-config') return maskConfig(await fn(ev, ...args));
    if (channel === 'finalcheck:set-config') {
      const next = args[0];
      if (next?.permissionMode === 'full' && readRawConfig().permissionMode !== 'full') throw new HttpError(403, '完全权限只能在电脑上开启');
      return fn(ev, restoreKeys(next, readRawConfig()), ...args.slice(1));
    }
    if (channel === 'finalcheck:test-provider') {
      const p = args[0];
      if (p && p.apiKey === KEY_MASK) {
        const old = readRawConfig();
        const hit = (old.providers || []).find((o) => o && (o.id === p.id || (o.baseUrl && o.baseUrl === p.baseUrl)));
        args = [{ ...p, apiKey: hit && originOf(hit.baseUrl) === originOf(p.baseUrl) ? hit.apiKey : '' }, ...args.slice(1)];
      }
    }
    return fn(ev, ...args);
  }

  async function listDirs(dir) {
    const raw = String(dir || '').trim();
    if (!raw) {
      const roots = [{ name: os.homedir(), path: os.homedir() }];
      if (process.platform === 'win32') {
        for (const letter of 'CDEFGHIJKLMN') {
          const p = letter + ':\\';
          try { fs.accessSync(p); roots.push({ name: p, path: p }); } catch { /* 没有这个盘 */ }
        }
      } else roots.push({ name: '/', path: '/' });
      return { dir: '', parent: null, entries: roots };
    }
    const abs = path.resolve(raw);
    const list = await fs.promises.readdir(abs, { withFileTypes: true }).catch(() => { throw new HttpError(400, '读不到这个文件夹'); });
    const entries = list.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !/^\$|^System Volume Information$/i.test(d.name))
      .slice(0, 500).map((d) => ({ name: d.name, path: path.join(abs, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(abs);
    return { dir: abs, parent: parent === abs ? '' : parent, entries };
  }

  // ---------- 4. HTTP ----------
  // 弱网 / 隧道下 JSON 压缩后通常只剩 1/5～1/10：会话历史、配置、大事件都走这里
  function sendBody(res, status, body, headers) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    if (res.__gz && buf.length > 1024) {
      res.writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
      res.end(zlib.gzipSync(buf, { level: 6 }));
    } else {
      res.writeHead(status, headers);
      res.end(buf);
    }
  }
  function sendJson(res, status, value) {
    sendBody(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  }
  async function readBody(req, limit = 1024 * 1024) {
    const length = Number(req.headers['content-length'] || 0);
    if (length > limit) { req.resume(); throw new HttpError(413, '请求体过大'); }
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size <= limit) chunks.push(c); }
    if (size > limit) throw new HttpError(413, '请求体过大');
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('x');
      return v;
    } catch { throw new HttpError(400, '请求格式无效'); }
  }
  function deviceOf(req) {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ') || !saved.device) return null;
    const hash = sha(h.slice(7));
    if (!saved.tokens.some((t) => t.hash === hash)) return null;
    notePresence(req);
    return saved.device;
  }
  // 走反向隧道 / 反向代理来的请求：本机地址 + 带 X-Forwarded-For；直接连本机端口的是局域网（或本机）
  const viaOf = (req) => {
    const ra = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const local = ra === '127.0.0.1' || ra === '::1';
    if (local && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) return 'internet';
    return local ? 'local' : 'lan';
  };
  function notePresence(req) {
    const via = viaOf(req);
    const changed = via !== presence.via || Date.now() - presence.lastSeenAt > 60000;
    presence.lastSeenAt = Date.now();
    presence.via = via;
    if (changed) emitAll('finalcheck:mobile:changed', publicState());
  }

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ico': 'image/x-icon' };
  async function serveStatic(route, res) {
    let file; let cache = 'no-store';
    if (route === '/' || route === '/pair' || route === '/index.html') file = path.join(staticDir, 'index.html');
    else if (route.startsWith('/assets/')) {
      const rel = decodeURIComponent(route.slice('/assets/'.length));
      if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('\0') || rel.includes('/')) return false;
      file = path.join(staticDir, 'assets', rel);
      cache = 'public, max-age=31536000, immutable';
    } else return false;
    const body = await fs.promises.readFile(file).catch(() => null);
    if (!body) {
      if (route.startsWith('/assets/')) return false;
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('手机网页还没打包：在 desktop 目录运行 node scripts/build-mobile.mjs');
      return true;
    }
    const headers = { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': cache, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    const ext = path.extname(file).toLowerCase();
    if (res.__gz && body.length > 1024 && ['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm'].includes(ext)) {
      // 打包产物不变：压一次缓存起来（1MB 级的 js 每次现压太慢）
      let gz = gzCache.get(file);
      if (!gz || gz.size !== body.length) { gz = { size: body.length, data: zlib.gzipSync(body, { level: 9 }) }; gzCache.set(file, gz); }
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
      res.end(gz.data);
      return true;
    }
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }

  async function pair(body, res) {
    const created = typeof body.token === 'string' ? pairCodes.get(body.token) : null;
    if (!created || Date.now() - created > PAIR_TTL_MS) throw new HttpError(403, '配对码无效或已过期：请在电脑的「设置 → 手机访问」里重新生成');
    const deviceId = typeof body.deviceId === 'string' && body.deviceId ? body.deviceId.slice(0, 100) : '';
    if (saved.device && saved.device.deviceId !== deviceId) throw new HttpError(403, '电脑已绑定另一台设备：请先在电脑的「设置 → 手机访问」里解除绑定');
    pairCodes.delete(body.token);
    if (!saved.device) saved.device = { deviceId: deviceId || crypto.randomBytes(8).toString('hex'), deviceName: String(body.deviceName || '手机').slice(0, 40), pairedAt: Date.now() };
    const bearer = crypto.randomBytes(32).toString('base64url');
    saved.tokens = [...saved.tokens, { hash: sha(bearer), at: Date.now() }].slice(-MAX_DEVICE_TOKENS);
    writeState();
    emitAll('finalcheck:mobile:changed', publicState());
    sendJson(res, 200, { ok: true, bearer, device: saved.device });
  }

  function openEvents(req, res, url) {
    if (clients.size >= MAX_STREAMS) throw new HttpError(429, '实时连接过多，请关闭闲置页面后重试');
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'referrer-policy': 'no-referrer' });
    res.write(': connected\n\n');
    const raw = req.headers['last-event-id'] ?? url.searchParams.get('after');
    const cursor = raw != null && /^\d+$/.test(String(raw)) ? Number(raw) : null;
    if (cursor != null) {
      const first = events[0]?.seq ?? seq + 1;
      // 断太久（缓冲已翻篇）或要补的太多：让手机整页重载、按引擎当前状态复原，比一口气补几 MB 快也稳
      const missed = events.filter((ev) => ev.seq > cursor);
      const bytes = missed.reduce((n, ev) => n + ev.frame.length, 0);
      if (cursor < first - 1 || cursor > seq || bytes > MAX_REPLAY_BYTES) res.write(`id: ${seq}\ndata: ${JSON.stringify({ reset: true })}\n\n`);
      else for (const ev of missed) res.write(ev.frame);
    } else {
      // 新打开的页面：补发还挂着的审批 / 提问（不带 id，不影响续传游标）
      const now = Date.now();
      for (const [k, v] of prompts) {
        if (now - v.at > PROMPT_TTL[v.channel]) { prompts.delete(k); continue; }
        res.write(`data: ${JSON.stringify({ channel: v.channel, payload: encodeOut(v.payload) })}\n\n`);
      }
    }
    clients.add(res);
    notePresence(req);
    if (clients.size === 1) emitAll('finalcheck:mobile:changed', publicState()); // 「手机在线」亮起来
    // 带数据的心跳（注释行浏览器收不到）：手机端 40 秒听不到任何东西就判定连接已死、主动重连
    const ka = setInterval(() => res.write('data: {"ka":1}\n\n'), 15000);
    res.on('close', () => {
      clearInterval(ka);
      clients.delete(res);
      // 手机切后台 / 刷新会短暂断开：等几秒还没连回来才算离线，免得电脑上的状态一闪一闪
      if (!clients.size) setTimeout(() => { if (!clients.size) emitAll('finalcheck:mobile:changed', publicState()); }, 8000).unref?.();
    });
  }

  async function rpc(req, res) {
    const body = await readBody(req, 32 * 1024 * 1024);
    const channel = body.channel;
    const args = decodeIn(body.args);
    if (typeof channel !== 'string' || !/^(finalcheck|fc-mobile):[\w:.-]{1,80}$/.test(channel) || !Array.isArray(args) || args.length > 8) throw new HttpError(400, '操作格式无效');
    const work = channel === 'fc-mobile:list-dirs' ? () => listDirs(args[0]) : () => call(channel, args);
    const id = crypto.randomBytes(9).toString('base64url');
    const entry = { at: Date.now(), done: false };
    const p = Promise.resolve().then(work).then(
      (result) => Object.assign(entry, { done: true, ok: true, result: encodeOut(result) }),
      (error) => {
        if (!(error instanceof HttpError)) log(`[mobile] ${channel} 失败：${error?.message || error}`);
        Object.assign(entry, { done: true, ok: false, error: error?.message || '操作失败' });
      }
    );
    let timer;
    const waited = await Promise.race([p.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), RPC_WAIT_MS); })]);
    clearTimeout(timer);
    if (waited) return entry.ok ? sendJson(res, 200, { ok: true, result: entry.result }) : sendJson(res, 200, { ok: false, error: entry.error });
    // 长调用（比如一整轮对话）：先回个 id，结果完成后从事件流推（断线重连后可用 /api/rpc-result 补取）
    results.set(id, entry);
    p.then(() => push({ rpc: id, ok: entry.ok, result: entry.result, error: entry.error }));
    sendJson(res, 200, { ok: true, deferred: id });
  }
  async function rpcResult(req, res) {
    const { id } = await readBody(req);
    const now = Date.now();
    for (const [k, v] of results) if (v.done && now - v.at > RPC_RESULT_TTL) results.delete(k);
    const entry = typeof id === 'string' ? results.get(id) : null;
    if (!entry) return sendJson(res, 200, { ok: false, error: '结果已过期，请刷新页面' });
    if (!entry.done) return sendJson(res, 200, { pending: true });
    results.delete(id);
    sendJson(res, 200, { ok: entry.ok, result: entry.result, error: entry.error });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    res.__gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    // 挂在反向代理的子路径下（/fc-mobile/…）也能用：只看最后的路由部分
    let route = url.pathname;
    const api = route.indexOf('/api/');
    const assets = route.indexOf('/assets/');
    if (api >= 0) route = route.slice(api);
    else if (assets >= 0) route = route.slice(assets);
    else if (/\/(pair|index\.html)?$/.test(route)) route = route.endsWith('/pair') ? '/pair' : '/';
    // 隧道自检用：不需要凭证，只回本次启动的随机 id（不含任何别的信息）
    if (req.method === 'GET' && route === '/api/ping') return sendJson(res, 200, { ok: true, fc: instanceId });
    if (req.method === 'GET' && await serveStatic(route, res)) return;
    if (req.method === 'POST' && route === '/api/pair') return pair(await readBody(req), res);
    if (req.method === 'GET' && route === '/api/events') {
      const t = tickets.get(url.searchParams.get('ticket') || '');
      tickets.delete(url.searchParams.get('ticket') || '');
      if (!t || Date.now() - t.at > TICKET_TTL_MS || !saved.device || t.deviceId !== saved.device.deviceId) throw new HttpError(401, '未配对或凭证失效，请重新配对');
      return openEvents(req, res, url);
    }
    if (!route.startsWith('/api/')) throw new HttpError(404, '没有这个页面');
    const device = deviceOf(req);
    if (!device) throw new HttpError(401, '未配对或凭证失效，请重新配对');
    if (req.method === 'GET' && route === '/api/whoami') return sendJson(res, 200, { ok: true, device });
    // 事件流的一次性票据：EventSource 带不了请求头，真凭证不出现在网址里（反向代理的访问日志会记网址）
    if (req.method === 'POST' && route === '/api/events-ticket') {
      const now = Date.now();
      for (const [k, v] of tickets) if (now - v.at > TICKET_TTL_MS) tickets.delete(k);
      const ticket = crypto.randomBytes(24).toString('base64url');
      tickets.set(ticket, { at: now, deviceId: device.deviceId });
      return sendJson(res, 200, { ok: true, ticket });
    }
    if (req.method === 'POST' && route === '/api/rpc') return rpc(req, res);
    if (req.method === 'POST' && route === '/api/rpc-result') return rpcResult(req, res);
    if (req.method === 'POST' && route === '/api/event') {
      const { seq: want } = await readBody(req);
      const json = bigEvents.get(Number(want));
      if (!json) return sendJson(res, 200, { ok: false, gone: true });
      return sendBody(res, 200, json, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    }
    throw new HttpError(404, '没有这个接口');
  }

  // ---------- 5. 开关 ----------
  function publicState() {
    const port = listening?.port ?? saved.port;
    const lanUrls = listening && saved.lan ? lanAddresses().map((a) => ({ name: a.name, hotspot: a.hotspot, url: `http://${a.address}:${port}/` })) : [];
    const t = saved.tunnel;
    const ts = tunnel.state();
    // 发给手机的链接：开了外网就用公网地址；否则局域网（热点排在最后）；都没有就本机
    const publicBase = t.enabled && t.publicUrl ? `${t.publicUrl}/` : null;
    const shareUrl = listening ? (publicBase || lanUrls[0]?.url || `http://127.0.0.1:${port}/`) : null;
    return {
      enabled: saved.enabled, running: !!listening, port: saved.port, lan: saved.lan, error: lastError,
      localUrl: listening ? `http://127.0.0.1:${port}/` : null,
      lanUrls,
      shareUrl,
      shareKind: !listening ? null : publicBase ? 'internet' : lanUrls[0] ? (lanUrls[0].hotspot ? 'hotspot' : 'lan') : 'local',
      tunnel: { enabled: t.enabled, target: t.target, remotePort: t.remotePort, publicUrl: t.publicUrl, status: ts.status, error: ts.error, since: ts.since, checkedAt: ts.checkedAt, retryAt: ts.retryAt || 0, verified: !!ts.verified },
      device: saved.device ? {
        deviceName: saved.device.deviceName, pairedAt: saved.device.pairedAt,
        online: clients.size > 0, lastSeenAt: presence.lastSeenAt || null, via: presence.via || null
      } : null,
      autostart: loginItem ? !!safeLogin(() => loginItem.get(), false) : null,
      built: fs.existsSync(path.join(staticDir, 'index.html')),
      clients: clients.size
    };
  }
  function safeLogin(fn, fallback) { try { return fn(); } catch (e) { log(`[mobile] 开机启动设置失败：${e?.message || e}`); return fallback; } }
  async function stopServer() {
    tunnelKey = ''; tunnel.stop();
    if (!server) return;
    for (const r of clients) { try { r.end(); } catch { /* ignore */ } }
    clients.clear();
    const s = server; server = null; listening = null;
    await new Promise((r) => s.close(() => r()));
    s.closeAllConnections?.();
  }
  async function startServer() {
    await stopServer();
    const envPort = Number(env.FINALCHECK_MOBILE_PORT || 0);
    const port = envPort > 0 ? envPort : saved.port;
    const host = saved.lan ? '0.0.0.0' : '127.0.0.1';
    const s = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        if (res.headersSent) { res.destroy(); return; }
        if (!(error instanceof HttpError)) log(`[mobile] 请求失败：${error?.stack || error}`);
        sendJson(res, error instanceof HttpError ? error.status : 500, { ok: false, error: error instanceof HttpError ? error.message : '操作失败，请重试' });
      });
    });
    s.requestTimeout = 0; // SSE / 长调用不按请求超时掐断
    await new Promise((resolve) => {
      s.once('error', (e) => { lastError = e?.code === 'EADDRINUSE' ? `端口 ${port} 被占用（可能还开着旧的手机端插件）：换个端口或关掉占用它的程序` : String(e?.message || e); resolve(); });
      s.listen(port, host, () => { server = s; listening = { host, port }; lastError = ''; resolve(); });
    });
    if (server) log(`[mobile] 手机访问已开启：${host}:${port}`);
  }
  async function apply() {
    const on = saved.enabled || Number(env.FINALCHECK_MOBILE_PORT || 0) > 0;
    if (on) await startServer(); else { await stopServer(); lastError = ''; }
    syncTunnel();
    emitAll('finalcheck:mobile:changed', publicState());
    return publicState();
  }

  function newPairCode() {
    const now = Date.now();
    for (const [k, v] of pairCodes) if (now - v > PAIR_TTL_MS) pairCodes.delete(k);
    const code = crypto.randomBytes(18).toString('base64url');
    pairCodes.set(code, now);
    return { code, expiresAt: now + PAIR_TTL_MS, path: `pair?t=${code}` };
  }

  function issuePairCode() {
    if (!listening) return { ok: false, error: '先打开手机访问' };
    const c = newPairCode();
    const st = publicState();
    return { ok: true, ...c, url: st.shareUrl ? st.shareUrl + c.path : null, kind: st.shareKind };
  }
  /** 人不在电脑前（只连着 SSH）：FinalCheck.exe --mobile-pair-code 把配对码写进数据目录的 mobile-pair-code.json（仅本机用户可读） */
  function writePairCodeFile() {
    const r = issuePairCode();
    const file = path.join(dataRoot, 'mobile-pair-code.json');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...r, writtenAt: Date.now() }, null, 2), { encoding: 'utf8', mode: 0o600 });
    log(`[mobile] 已按命令行生成配对码 → ${file}`);
    return r;
  }
  /** 设置页用的 IPC（手机调不到：phoneDenyReason 挡掉 finalcheck:mobile:*） */
  function registerIpc(ipcMain) {
    ipcMain.handle('finalcheck:mobile:state', () => publicState());
    ipcMain.handle('finalcheck:mobile:set', async (_e, patch = {}) => {
      if (typeof patch.enabled === 'boolean') saved.enabled = patch.enabled;
      if (typeof patch.lan === 'boolean') saved.lan = patch.lan;
      if (patch.port != null) {
        const p = Number(patch.port);
        if (!Number.isInteger(p) || p < 1024 || p > 65535) return { ok: false, error: '端口要在 1024–65535 之间' };
        saved.port = p;
      }
      if (patch.tunnel && typeof patch.tunnel === 'object') {
        const t = { ...saved.tunnel };
        const x = patch.tunnel;
        if (typeof x.enabled === 'boolean') t.enabled = x.enabled;
        if (x.target != null) {
          const v = String(x.target).trim();
          if (v && !validTarget(v)) return { ok: false, error: '服务器写成 用户名@地址，或者 ~/.ssh/config 里的别名' };
          t.target = v;
        }
        if (x.remotePort != null) {
          const p = Number(x.remotePort);
          if (!Number.isInteger(p) || p < 1024 || p > 65535) return { ok: false, error: '服务器端口要在 1024–65535 之间' };
          t.remotePort = p;
        }
        if (x.publicUrl != null) {
          const v = normPublicUrl(x.publicUrl);
          if (v && !validPublicUrl(v)) return { ok: false, error: '公网地址要以 https:// 开头' };
          t.publicUrl = v;
        }
        if (t.enabled && !t.target) return { ok: false, error: '先填服务器（用户名@地址 或 ssh 别名）' };
        saved.tunnel = t;
      }
      writeState();
      return { ok: true, state: await apply() };
    });
    ipcMain.handle('finalcheck:mobile:tunnel-retry', () => { tunnel.retryNow(); return { ok: true, state: publicState() }; });
    ipcMain.handle('finalcheck:mobile:autostart', (_e, on) => {
      if (!loginItem) return { ok: false, error: '这个环境不支持开机启动' };
      if (typeof on === 'boolean') safeLogin(() => loginItem.set(on), null);
      const state = publicState();
      emitAll('finalcheck:mobile:changed', state);
      return { ok: true, state };
    });
    ipcMain.handle('finalcheck:mobile:pair-code', () => issuePairCode());
    ipcMain.handle('finalcheck:mobile:unpair', () => {
      saved.device = null; saved.tokens = []; writeState();
      // 已连着的手机立刻断开
      for (const r of clients) { try { r.end(); } catch { /* ignore */ } }
      clients.clear();
      emitAll('finalcheck:mobile:changed', publicState());
      return { ok: true, state: publicState() };
    });
  }

  return {
    captureIpc, attachWindow, registerIpc, apply, stop: stopServer, publicState, newPairCode, issuePairCode, writePairCodeFile,
    /** 测试用 */ _handlers: handlers, _prompts: prompts
  };
}
