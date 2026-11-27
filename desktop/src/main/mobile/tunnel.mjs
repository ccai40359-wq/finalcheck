// 0.34.2 外网访问：FinalCheck 自己维护一条反向 SSH 隧道（以前要手动在终端里开 ssh -R，断了也没人知道）。
//
//   手机 ──HTTPS──▶ 你的服务器 nginx（公网端口）──▶ 服务器 127.0.0.1:<远端端口>
//                                                      │  反向隧道（电脑主动连出去，服务器上不暴露）
//   电脑 FinalCheck 手机服务 127.0.0.1:<本地端口> ◀──────┘
//
// 这里只管「隧道在不在、外网到底能不能打开」：
//   · ssh 进程掉了 → 退避重连（5s 起，最长 60s）
//   · ssh 活着但公网地址打不开（nginx 挂了 / 端口被旧会话占着）→ 显示「外网打不开」并重建
//   · 公网地址验证：GET <公网地址>/api/ping，回来的必须是**本机这一次启动**的随机 id，
//     这样连到别人的 / 旧插件的服务也不会被误判为通
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BACKOFF_MIN = 5000;
const BACKOFF_MAX = 60000;
const SETTLE_MS = 3500;        // ssh 起来后多久开始验证公网（ExitOnForwardFailure 失败通常 1–2 秒内退出）
const CHECK_EVERY_MS = 60000;  // 连通后每分钟验一次
const CHECK_FAILS_TO_RESTART = 2;

/** ssh 目标：user@host 或 ~/.ssh/config 里的别名；不允许以 - 开头（防止被当成 ssh 参数） */
export function validTarget(t) {
  return typeof t === 'string' && /^[A-Za-z0-9._@-]{1,120}$/.test(t) && !t.startsWith('-');
}
export function validPublicUrl(u) {
  try { const x = new URL(String(u)); return (x.protocol === 'https:' || x.protocol === 'http:') && !x.username && !x.password; } catch { return false; }
}
/** 公网地址统一成不带结尾斜杠的形式：https://a.b:8443/fc-mobile */
export const normPublicUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

/** ssh 的报错翻译成人话（只取最有用的一条） */
export function explainSshError(text) {
  const s = String(text || '');
  if (/remote port forwarding failed/i.test(s)) return '服务器上的转发端口被占着（多半是上一条隧道还没断干净，或者别的程序在用）：稍等一分钟会自动重试';
  if (/Permission denied/i.test(s)) return 'SSH 登录被拒绝：检查用户名和密钥（这台电脑需要能免密码 ssh 登录服务器）';
  if (/Could not resolve hostname/i.test(s)) return '找不到这台服务器：检查服务器地址，或者 ~/.ssh/config 里的别名';
  if (/Connection timed out|Operation timed out/i.test(s)) return '连服务器超时：检查网络，或服务器的 SSH 端口是否开着';
  if (/Connection refused/i.test(s)) return '服务器拒绝连接：SSH 服务没开，或端口不对';
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) return '服务器的指纹变了：先在终端里手动 ssh 一次确认';
  if (/Network is unreachable|No route to host/i.test(s)) return '网络不通';
  const line = s.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !/post-quantum|store now|openssh\.com\/pq|^\*\*/i.test(x)).pop();
  return line ? line.slice(0, 200) : '';
}

export function sshArgs({ target, remotePort, localPort }) {
  return [
    '-N', '-T',
    '-o', 'BatchMode=yes',               // 永远不弹密码框（后台进程没人回答，会一直卡着）
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',    // 端口没绑上就退出，不要假装连上了
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-R', `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`,
    target
  ];
}

export function findSsh(env = process.env) {
  if (process.platform === 'win32') {
    const sys = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'ssh';
}

/**
 * @param {object} o
 * @param {() => {target:string, remotePort:number, localPort:number, publicUrl:string}|null} o.config 当前配置（null = 不该开）
 * @param {string} o.instanceId 本次启动的随机 id（/api/ping 回这个）
 * @param {(s:object) => void} [o.onChange]
 * @param {Function} [o.spawn] 测试注入
 * @param {Function} [o.fetch] 测试注入
 * @param {string} [o.sshPath]
 * @param {(s:string) => void} [o.log]
 */
export function createTunnel({ config, instanceId, onChange = () => {}, spawn = nodeSpawn, fetch: doFetch = globalThis.fetch, sshPath = findSsh(), log = () => {}, timing = {} }) {
  const T = { backoffMin: BACKOFF_MIN, backoffMax: BACKOFF_MAX, settle: SETTLE_MS, checkEvery: CHECK_EVERY_MS, ...timing };
  let child = null;
  let wanted = false;
  let backoff = T.backoffMin;
  let retryTimer = null;
  let checkTimer = null;
  let checkFails = 0;
  let gen = 0;                        // 每起一次 ssh +1：旧进程的回调一律作废
  let state = { status: 'off', error: '', since: Date.now(), checkedAt: 0 };

  const set = (patch) => {
    const next = { ...state, ...patch };
    if (patch.status && patch.status !== state.status) next.since = Date.now();
    state = next;
    try { onChange(snapshot()); } catch { /* 忽略 */ }
  };
  const snapshot = () => ({ ...state });

  function clearTimers() {
    clearTimeout(retryTimer); retryTimer = null;
    clearTimeout(checkTimer); checkTimer = null;
  }
  function killChild() {
    const c = child; child = null;
    if (c && c.exitCode == null) { try { c.kill(); } catch { /* 已退出 */ } }
  }

  async function probe(publicUrl) {
    if (!publicUrl) return { ok: true, skipped: true };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await doFetch(`${publicUrl}/api/ping`, { signal: ctl.signal, cache: 'no-store' });
      if (r.status === 502 || r.status === 504) return { ok: false, error: `公网地址返回 ${r.status}：服务器收到了请求，但隧道那头没接上` };
      if (!r.ok) return { ok: false, error: `公网地址返回 ${r.status}：检查服务器上的转发规则（路径、端口）` };
      const j = await r.json().catch(() => null);
      if (j?.fc !== instanceId) return { ok: false, error: '公网地址通了，但应答的不是这台电脑的 FinalCheck（端口可能被别的程序或旧插件占着）' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.name === 'AbortError' ? '打开公网地址超时' : `打不开公网地址：${e?.cause?.code || e?.message || e}` };
    } finally { clearTimeout(t); }
  }

  function scheduleCheck(myGen, delay) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(async () => {
      if (myGen !== gen || !child) return;
      const cfg = config();
      const r = await probe(cfg?.publicUrl);
      if (myGen !== gen || !child) return;
      if (r.ok) {
        checkFails = 0; backoff = T.backoffMin;
        set({ status: 'up', error: '', checkedAt: Date.now(), verified: !r.skipped });
      } else {
        checkFails += 1;
        set({ status: 'unreachable', error: r.error, checkedAt: Date.now() });
        // 连着两次打不开：重建隧道（服务器那头的转发可能已经失效，ssh 自己察觉不到）
        if (checkFails >= CHECK_FAILS_TO_RESTART) { checkFails = 0; restartSoon(); return; }
      }
      scheduleCheck(myGen, state.status === 'up' ? T.checkEvery : Math.min(T.checkEvery, 15000));
    }, delay);
  }

  function restartSoon() {
    killChild();
    clearTimers();
    if (!wanted) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, T.backoffMax);
    retryTimer = setTimeout(launch, wait);
    set({ retryAt: Date.now() + wait });
  }

  function launch() {
    clearTimers();
    if (!wanted) return;
    const cfg = config();
    if (!cfg) { stop(); return; }
    const myGen = ++gen;
    let errText = '';
    set({ status: 'connecting', retryAt: 0 });
    let c;
    try {
      c = spawn(sshPath, sshArgs(cfg), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      set({ status: 'error', error: `启动 ssh 失败：${e?.message || e}` });
      restartSoon();
      return;
    }
    child = c;
    c.stderr?.on('data', (d) => { errText = (errText + d).slice(-4000); });
    c.on('error', (e) => {
      if (myGen !== gen) return;
      set({ status: 'error', error: e?.code === 'ENOENT' ? '这台电脑上找不到 ssh（Windows 需要「OpenSSH 客户端」）' : `ssh 出错：${e?.message || e}` });
      child = null;
      restartSoon();
    });
    c.on('exit', (code) => {
      if (myGen !== gen) return;
      child = null;
      if (!wanted) return;
      const why = explainSshError(errText) || `ssh 退出了（${code}）`;
      log(`[tunnel] 断开：${why}`);
      set({ status: 'error', error: why });
      restartSoon();
    });
    scheduleCheck(myGen, T.settle);
  }

  function start() {
    wanted = true;
    backoff = T.backoffMin;
    checkFails = 0;
    killChild();
    launch();
  }
  function stop() {
    wanted = false;
    gen++;
    clearTimers();
    killChild();
    set({ status: 'off', error: '', retryAt: 0 });
  }
  /** 立刻重试（用户点「重新连接」） */
  function retryNow() { if (wanted) start(); }

  return { start, stop, retryNow, state: snapshot, _probe: probe };
}
