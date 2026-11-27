// 手机端「electron」替身：桌面端 preload（desktop/src/preload/index.mjs）原样打包进来，
// 它 import 的 { contextBridge, ipcRenderer } 指向这里 ——
//   ipcRenderer.invoke(channel, ...args) → POST /api/rpc（电脑上的 FinalCheck 引擎处理）
//   ipcRenderer.on(channel, cb)           → GET  /api/events（SSE，引擎推给窗口的所有事件）
// 这样桌面端的界面、按钮、交互一个不改，在手机浏览器里原样跑。
// 只有 Electron 才有的几样（原生选文件夹 / 选文件 / 剪贴板 / 用系统程序打开 / 窗口按钮）在这里换成浏览器的做法。

const BEARER_KEY = 'fc-mobile-app-bearer';
// 渲染层据此知道自己是手机那一端（lib/remote-sync.mjs → 自己发出的同步事件不重复处理）
window.__FC_MOBILE__ = true;
const DEVICE_KEY = 'fc-mobile-dev';

/** 页面挂在 /fc-mobile/ 之类子路径下时，接口也要带这个前缀 */
export const BASE = (() => {
  const p = location.pathname.replace(/\/(index\.html|pair)?$/, '');
  return p === '/' ? '' : p;
})();

let bearer = '';
try { bearer = localStorage.getItem(BEARER_KEY) || ''; } catch { /* 无痕模式 */ }

// ---------------- 二进制编解码（Buffer / Uint8Array 走 JSON） ----------------
function b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function bytesFromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function encode(v) {
  if (v instanceof ArrayBuffer) return { __fcb64: b64FromBytes(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { __fcb64: b64FromBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = encode(v[k]);
    return o;
  }
  return v;
}
function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    if (typeof v.__fcb64 === 'string' && Object.keys(v).length === 1) return bytesFromB64(v.__fcb64);
    const o = {};
    for (const k of Object.keys(v)) o[k] = decode(v[k]);
    return o;
  }
  return v;
}

// ---------------- 连接状态条（手机网络不稳时给个交代） ----------------
let bar = null;
let barTimer = null;
function connState(ok, text = '') {
  clearTimeout(barTimer);
  if (ok) { if (bar) bar.style.display = 'none'; return; }
  barTimer = setTimeout(() => {
    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute('data-testid', 'fc-mobile-conn');
      bar.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 6px);transform:translateX(-50%);z-index:2147483000;'
        + 'padding:5px 12px;border-radius:999px;font:12px/1.4 system-ui,sans-serif;background:rgba(40,32,18,.92);color:#f3d9a6;'
        + 'border:1px solid rgba(222,176,106,.4);box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none';
      document.body.appendChild(bar);
    }
    bar.textContent = text || '和电脑的连接断了，正在重连…';
    bar.style.display = 'block';
  }, 1500);
}

// ---------------- 事件流 ----------------
const listeners = new Map(); // channel → Set<handler(event, payload)>
const deferred = new Map();  // rpc id → { resolve, reject }
let es = null;
let lastEventId = '';
let retry = 0;

// 待处理的审批 / 提问：页面刚打开时界面还没挂监听，先存着，挂上就补发（否则刷新后卡片丢了，回合干等到超时）
const STICKY = new Set(['finalcheck:approval-request', 'finalcheck:ask-user']);
const held = [];
function dispatch(channel, payload) {
  const set = listeners.get(channel);
  if (!set || !set.size) { if (STICKY.has(channel) && held.length < 50) held.push([channel, payload]); return; }
  for (const h of [...set]) {
    try { h({ sender: null }, payload); } catch (e) { console.error('[fc-mobile] 事件处理出错', channel, e); }
  }
}

// 手机锁屏 / 切后台回来，或者切换了网络：连接常常已经死了却不报错（iOS 尤其如此）。
// 服务端每 15 秒发一次心跳；40 秒没听到任何东西就当断了重连；网络恢复、页面重新可见时立刻重连，不等退避。
let lastSeen = Date.now();
let retryTimer = null;
function reconnectNow() {
  if (!bearer) return;
  clearTimeout(retryTimer);
  retry = 0;
  openEvents();
}
setInterval(() => { if (es && document.visibilityState === 'visible' && Date.now() - lastSeen > 40000) reconnectNow(); }, 5000);
window.addEventListener('online', () => { if (!es || es.readyState !== 1 || Date.now() - lastSeen > 3000) reconnectNow(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!es || es.readyState !== 1 || Date.now() - lastSeen > 20000) reconnectNow();
});
window.addEventListener('pageshow', (e) => { if (e.persisted) reconnectNow(); });

let inbox = Promise.resolve();
function handleMsg(msg) {
  if (!msg) return;
  if (msg.rpc) { settle(msg.rpc, msg); return; }
  if (msg.reset) { location.reload(); return; } // 断太久、事件缓冲已翻篇：整页重载，桌面界面会按引擎状态复原
  if (msg.channel) dispatch(msg.channel, decode(msg.payload));
}
async function fetchBig(seq) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${BASE}/api/event`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer },
        body: JSON.stringify({ seq })
      });
      const j = await r.json();
      if (j && j.gone) { location.reload(); return null; } // 太旧已被丢弃：重载复原
      return j;
    } catch { await new Promise((res) => setTimeout(res, 800 * (i + 1))); }
  }
  return null;
}

let opening = false;
async function openEvents() {
  clearTimeout(retryTimer);
  if (opening) return;
  if (es) { es.close(); es = null; }
  // 事件流用一次性票据：EventSource 带不了请求头，真凭证不能放进网址（反向代理的访问日志会记下来）
  opening = true;
  let ticket = '';
  try {
    const r = await fetch(`${BASE}/api/events-ticket`, { method: 'POST', headers: { authorization: 'Bearer ' + bearer } });
    if (r.status === 401) { opening = false; unpaired(); return; }
    ticket = (await r.json()).ticket || '';
  } catch { /* 下面按断线处理 */ }
  opening = false;
  if (!ticket) {
    connState(false);
    retryTimer = setTimeout(openEvents, Math.min(8000, 500 * 2 ** retry++));
    return;
  }
  const q = new URLSearchParams({ ticket });
  if (lastEventId) q.set('after', lastEventId);
  es = new EventSource(`${BASE}/api/events?${q}`);
  es.onopen = () => {
    lastSeen = Date.now();
    retry = 0;
    connState(true);
    // 断线期间完成的长调用（比如一整轮对话）：补取结果
    for (const id of deferred.keys()) void fetchDeferred(id);
  };
  es.onmessage = (m) => {
    lastSeen = Date.now();
    if (m.lastEventId) lastEventId = m.lastEventId;
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.ka) return;
    // 大事件（截图、长输出）服务端只发占位，这里按 seq 单独取；排进同一条队列，保证事件顺序不乱
    inbox = inbox.then(() => (msg.big ? fetchBig(msg.seq) : msg)).then(handleMsg, () => {});
  };
  es.onerror = () => {
    connState(false);
    if (es) es.close();
    es = null;
    clearTimeout(retryTimer);
    // 先确认是不是凭证失效（EventSource 拿不到状态码）
    fetch(`${BASE}/api/whoami`, { headers: { authorization: 'Bearer ' + bearer } })
      .then((r) => { if (r.status === 401) return unpaired(); retryTimer = setTimeout(openEvents, Math.min(8000, 500 * 2 ** retry++)); })
      .catch(() => { retryTimer = setTimeout(openEvents, Math.min(8000, 500 * 2 ** retry++)); });
  };
}

function settle(id, msg) {
  const d = deferred.get(id);
  if (!d) return;
  deferred.delete(id);
  if (msg.ok) d.resolve(decode(msg.result));
  else d.reject(new Error(msg.error || '操作失败'));
}

async function fetchDeferred(id) {
  try {
    const r = await fetch(`${BASE}/api/rpc-result`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer },
      body: JSON.stringify({ id })
    });
    const j = await r.json();
    if (j.pending) return;
    settle(id, j);
  } catch { /* 下次重连再取 */ }
}

function unpaired() {
  try { localStorage.removeItem(BEARER_KEY); } catch { /* 忽略 */ }
  location.reload();
}

// ---------------- 远程调用 ----------------
async function rpc(channel, args) {
  let r;
  try {
    r = await fetch(`${BASE}/api/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer },
      body: JSON.stringify({ channel, args: encode(args) })
    });
  } catch {
    connState(false);
    throw new Error('连不上电脑，请检查网络');
  }
  if (r.status === 401) { unpaired(); throw new Error('需要重新配对'); }
  const j = await r.json().catch(() => ({ ok: false, error: '电脑返回了无法识别的内容' }));
  if (j.deferred) return new Promise((resolve, reject) => deferred.set(j.deferred, { resolve, reject }));
  if (!j.ok) throw new Error(j.error || '操作失败');
  return decode(j.result);
}

// ---------------- 浏览器里替代 Electron 原生能力 ----------------
function pickFilesInBrowser() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    const finish = (v) => { if (done) return; done = true; input.remove(); resolve(v); };
    input.addEventListener('change', async () => {
      const paths = [];
      for (const f of Array.from(input.files || [])) {
        if (f.size > 20 * 1024 * 1024) continue;
        const buf = new Uint8Array(await f.arrayBuffer());
        const saved = await rpc('finalcheck:attachment:save', [{ name: f.name || 'file', dataBase64: b64FromBytes(buf) }]).catch(() => null);
        if (saved?.path) paths.push(saved.path);
      }
      finish(paths);
    });
    // 取消选择：页面重新拿到焦点后还没 change 就当取消
    window.addEventListener('focus', () => setTimeout(() => finish([]), 1500), { once: true });
    input.click();
  });
}

async function copyInBrowser(text) {
  try { await navigator.clipboard.writeText(String(text ?? '')); return { ok: true }; } catch { /* 非安全上下文 */ }
  const ta = document.createElement('textarea');
  ta.value = String(text ?? '');
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* 忽略 */ }
  ta.remove();
  return { ok };
}

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', html: 'text/html', htm: 'text/html', txt: 'text/plain', md: 'text/plain', json: 'application/json', csv: 'text/csv', mp4: 'video/mp4', webm: 'video/webm' };
async function openInBrowser(p) {
  const bytes = await rpc('finalcheck:artifact:bytes', [p]);
  if (!(bytes instanceof Uint8Array)) return { ok: false, error: '读不到这个文件' };
  const ext = String(p).split('.').pop().toLowerCase();
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME_BY_EXT[ext] || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  if (!MIME_BY_EXT[ext]) a.download = String(p).split(/[\\/]/).pop();
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { ok: true };
}

/** 选电脑上的文件夹（桌面端是系统对话框）：一个简单的目录浏览器，目录列表由电脑提供 */
function pickDirectoryInBrowser() {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-testid', 'fc-mobile-dirpicker');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center';
    wrap.innerHTML = `
      <div style="width:min(560px,100%);max-height:80vh;display:flex;flex-direction:column;background:rgb(var(--fc-card,28 28 32));color:rgb(var(--fc-ink,235 230 220));
        border-radius:16px 16px 0 0;border:1px solid rgba(222,176,106,.25);font:14px/1.5 system-ui,sans-serif;padding-bottom:env(safe-area-inset-bottom,0px)">
        <div style="padding:14px 16px 8px;font-weight:600">选择电脑上的文件夹</div>
        <input data-k="path" spellcheck="false" style="margin:0 16px;padding:9px 10px;border-radius:9px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font:13px ui-monospace,monospace" />
        <div data-k="list" style="flex:1;overflow:auto;margin:8px 8px 0;-webkit-overflow-scrolling:touch"></div>
        <div style="display:flex;gap:8px;padding:10px 16px 14px">
          <button data-k="cancel" style="flex:1;padding:10px;border-radius:10px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit">取消</button>
          <button data-k="ok" style="flex:2;padding:10px;border-radius:10px;border:0;background:#deb06a;color:#1b1408;font-weight:600">选这个文件夹</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const $ = (k) => wrap.querySelector(`[data-k="${k}"]`);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } else if (e.key === 'Enter' && e.target === $('path')) close($('path').value.trim() || null); };
    const close = (v) => { document.removeEventListener('keydown', onKey, true); wrap.remove(); resolve(v); };
    document.addEventListener('keydown', onKey, true);
    const load = async (dir) => {
      const list = $('list');
      list.textContent = '读取中…';
      try {
        const r = await rpc('fc-mobile:list-dirs', [dir || '']);
        $('path').value = r.dir || '';
        list.textContent = '';
        const row = (label, target) => {
          const b = document.createElement('button');
          b.textContent = label;
          b.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:13px ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
          b.onclick = () => load(target);
          list.appendChild(b);
        };
        if (r.parent != null) row('⬑  上一级', r.parent);
        for (const d of r.dirs || []) row('▸  ' + d.name, d.path);
        if (!r.dirs?.length && r.parent == null && !r.dir) list.textContent = '没有可选的位置';
      } catch (e) { list.textContent = e.message || '读不到'; }
    };
    $('path').addEventListener('keydown', (e) => { if (e.key === 'Enter') load($('path').value.trim()); });
    $('cancel').onclick = () => close(null);
    $('ok').onclick = () => close($('path').value.trim() || null);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(null); });
    void load('');
  });
}

const LOCAL = {
  'finalcheck:window-ctl': () => null,
  'finalcheck:pick-files': () => pickFilesInBrowser(),
  'finalcheck:pick-directory': () => pickDirectoryInBrowser(),
  'finalcheck:clipboard:write': (text) => copyInBrowser(text),
  'finalcheck:artifact:open': (p) => openInBrowser(p)
};

export const ipcRenderer = {
  invoke(channel, ...args) {
    const local = LOCAL[channel];
    if (local) return Promise.resolve().then(() => local(...args));
    return rpc(channel, args);
  },
  on(channel, handler) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(handler);
    if (held.some(([c]) => c === channel)) {
      const mine = held.filter(([c]) => c === channel);
      for (let i = held.length - 1; i >= 0; i--) if (held[i][0] === channel) held.splice(i, 1);
      setTimeout(() => { for (const [, p] of mine) dispatch(channel, p); }, 0);
    }
    return ipcRenderer;
  },
  removeListener(channel, handler) {
    listeners.get(channel)?.delete(handler);
    return ipcRenderer;
  },
  removeAllListeners(channel) { listeners.delete(channel); return ipcRenderer; },
  send() { /* 桌面 preload 没用到单向 send */ }
};

export const contextBridge = {
  exposeInMainWorld(key, api) { window[key] = api; }
};

// ---------------- 配对（没凭证时，桌面界面挂载前先走这一步） ----------------
function pairScreen() {
  return new Promise((resolve) => {
    const q = new URLSearchParams(location.search);
    const wrap = document.createElement('div');
    wrap.setAttribute('data-testid', 'fc-mobile-pair');
    wrap.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0f0f12;color:#ece6da;font:15px/1.6 system-ui,sans-serif;padding:24px';
    wrap.innerHTML = `
      <form style="width:min(360px,100%);display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700"><span style="color:#deb06a">FC</span> FinalCheck 手机端</div>
        <div style="color:#9b958a;font-size:13px">在电脑上打开「设置 → 手机访问」，点「生成配对码」，在手机上打开配对链接，或把配对码填在这里（10 分钟内有效，用一次就作废）。配上以后，手机和电脑看到的是同一个 FinalCheck，实时同步。</div>
        <input name="t" autocomplete="one-time-code" placeholder="配对码" spellcheck="false"
          style="padding:12px 14px;border-radius:12px;border:1px solid #3a3630;background:#1a1a1e;color:inherit;font:15px ui-monospace,monospace" />
        <button style="padding:12px;border-radius:12px;border:0;background:#deb06a;color:#1b1408;font-weight:700;font-size:15px">连接电脑</button>
        <div data-k="err" style="min-height:1.5em;color:#e58b7a;font-size:13px"></div>
      </form>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const err = wrap.querySelector('[data-k="err"]');
    form.t.value = q.get('t') || '';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = form.t.value.trim();
      if (!token) return;
      err.textContent = '正在连接…';
      let deviceId = '';
      try {
        deviceId = localStorage.getItem(DEVICE_KEY) || '';
        if (!deviceId) { deviceId = 'dev-' + (crypto.randomUUID?.() || Math.random().toString(36).slice(2)); localStorage.setItem(DEVICE_KEY, deviceId); }
      } catch { deviceId = 'dev-' + Math.random().toString(36).slice(2); }
      try {
        const r = await fetch(`${BASE}/api/pair`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token, deviceId, deviceName: /Mobi|Android|iPhone/i.test(navigator.userAgent) ? 'FinalCheck 手机' : 'FinalCheck 网页' })
        });
        const j = await r.json();
        if (!j.ok) { err.textContent = j.error || '配对失败'; return; }
        bearer = j.bearer;
        try { localStorage.setItem(BEARER_KEY, bearer); } catch { /* 只在本页有效 */ }
        history.replaceState(null, '', location.pathname.replace(/\/pair$/, '/'));
        wrap.remove();
        resolve();
      } catch { err.textContent = '连不上电脑，请重试'; }
    });
    if (form.t.value) form.requestSubmit();
  });
}

/** 桌面界面挂载前调用：确保已配对、事件流已连上 */
export async function ready() {
  if (bearer) {
    const ok = await fetch(`${BASE}/api/whoami`, { headers: { authorization: 'Bearer ' + bearer } }).then((r) => r.status !== 401).catch(() => true);
    if (!ok) { bearer = ''; try { localStorage.removeItem(BEARER_KEY); } catch { /* 忽略 */ } }
  }
  if (!bearer) await pairScreen();
  openEvents();
}
