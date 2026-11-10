#!/usr/bin/env node
/**
 * 打包产物端到端冒烟（Windows 无人值守 / CI 可跑）
 *
 * 只做一件事：用 desktop/out 已构建产物直接起 Electron，在「临时隔离环境」里
 * 验证渲染层加载、preload 桥、发消息、SQLite 落盘、截图，然后退出。
 *
 * 隔离约束（绝不碰用户真实数据）：
 *   --user-data-dir=<temp>，且 FINALCHECK_CONFIG_FILE / FINALCHECK_PROJECTS_FILE /
 *   FINALCHECK_SESSIONS_DIR / FINALCHECK_MEMORY_DIR / FINALCHECK_SPILL_DIR /
 *   FINALCHECK_DEFAULT_PROJECT 全部指向 temp。
 *
 * 90s 硬超时是「脚本级保护」：CI 冒烟不允许挂死，超时即 kill 进程树并非 0 退出。
 * 这不是对 agent 工作时间的限制。
 *
 * 用法：npm run smoke:e2e
 * 环境变量 CI=true 时截图写到 e2e-artifacts/smoke.png（其余写到仓库同级 .tmp/e2e/smoke.png）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(SCRIPT_DIR, '..');
const DESKTOP_DIR = join(REPO_ROOT, 'desktop');
const RENDERER_INDEX = join(DESKTOP_DIR, 'out', 'renderer', 'index.html');
const MAIN_ENTRY = join(DESKTOP_DIR, 'out', 'main', 'index.js');
const ELECTRON_BIN = join(
  DESKTOP_DIR, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);
const IS_CI = !!process.env.CI;
const SCREENSHOT_PATH = IS_CI
  ? join(REPO_ROOT, 'e2e-artifacts', 'smoke.png')
  : resolvePath(REPO_ROOT, '..', '.tmp', 'e2e', 'smoke.png');
const TOTAL_TIMEOUT_MS = 90 * 1000;
const STARTED_AT = Date.now();

const SMOKE_CONFIG = {
  providers: [{
    id: 'smoke-provider',
    name: 'Smoke Provider',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiFormat: 'chat-completions',
    apiKey: 'smoke-only-key',
    models: ['smoke-model'],
    enabled: true
  }],
  activeProviderId: 'smoke-provider',
  activeModel: 'smoke-model',
  language: 'en',
  permissionMode: 'ask',
  thinkingEffort: 'max'
};

const logs = [];
let child = null;
let socket = null;
let cdp = null;
let watchdog = null;
let tempRoot = null;
let python = null;
let finished = false;

const elapsed = () => ((Date.now() - STARTED_AT) / 1000).toFixed(1);

function log(message) {
  const line = `[smoke ${elapsed()}s] ${message}`;
  logs.push(line);
  if (logs.length > 2000) logs.splice(0, logs.length - 2000);
  console.log(line);
}

function logRaw(prefix, chunk) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const tagged = `[${prefix}] ${line}`;
    logs.push(tagged);
    if (logs.length > 2000) logs.splice(0, logs.length - 2000);
    console.log(tagged);
  }
}

function artifactDir() {
  return dirname(SCREENSHOT_PATH);
}

function writeFailureLog() {
  try {
    mkdirSync(artifactDir(), { recursive: true });
    writeFileSync(join(artifactDir(), 'smoke.log'), `${logs.slice(-200).join('\n')}\n`, 'utf8');
  } catch { /* best effort：日志写不了不影响退出码 */ }
}

function killElectron() {
  if (!child || !child.pid) return;
  const pid = child.pid;
  try {
    if (process.platform === 'win32') {
      // /T 连子进程（renderer / GPU / utility）一起杀，避免 CI 里残留僵尸进程
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* 进程可能已退出 */ }
  child = null;
}

function waitChildExit(timeout = 5_000) {
  return new Promise((resolvePromise) => {
    if (!child || child.exitCode !== null) { resolvePromise(true); return; }
    const current = child;
    const timer = setTimeout(() => {
      current.removeListener('exit', onExit);
      resolvePromise(false);
    }, timeout);
    timer.unref?.();
    function onExit() {
      clearTimeout(timer);
      resolvePromise(true);
    }
    current.once('exit', onExit);
  });
}

async function closeElectronGracefully() {
  try { await evaluate(`window.finalcheck?.windowCtl?.('close')`); } catch { /* 已关闭 */ }
  return waitChildExit();
}

function cleanup({ keepTemp }) {
  if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  try { socket?.close(); } catch { /* 已断开 */ }
  socket = null;
  cdp = null;
  killElectron();
  if (tempRoot && !keepTemp) {
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      return true;
    } catch {
      return false; // Windows 句柄释放慢：临时目录残留不影响冒烟结论
    }
  }
  return false;
}

function fail(reason) {
  if (finished) return;
  finished = true;
  writeFailureLog();
  console.error(`\n[smoke] FAIL: ${reason}`);
  if (tempRoot) console.error(`[smoke] isolated temp kept: ${tempRoot}`);
  console.error(`[smoke] last ${Math.min(logs.length, 200)} log lines:`);
  for (const line of logs.slice(-200)) console.error(line);
  cleanup({ keepTemp: true });
  process.exit(1);
}

function armWatchdog() {
  watchdog = setTimeout(() => {
    fail(`hard timeout after ${TOTAL_TIMEOUT_MS / 1000}s（脚本级保护，kill 进程树）`);
  }, TOTAL_TIMEOUT_MS);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(predicate, label, { timeout = 30_000, interval = 250 } = {}) {
  const until = Math.min(Date.now() + timeout, STARTED_AT + TOTAL_TIMEOUT_MS);
  let lastError = null;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) {
      throw new Error(`Electron exited early (code=${child.exitCode}) while waiting for ${label}`);
    }
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function findFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
  });
}

function findPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  candidates.push(['python', []], ['python3', []], ['py', ['-3']]);
  for (const [cmd, prefix] of candidates) {
    const probe = spawnSync(cmd, [...prefix, '-I', '-c', 'import sqlite3; print(sqlite3.sqlite_version)'], {
      encoding: 'utf8', windowsHide: true
    });
    if (probe.status === 0) {
      return { cmd, prefix, sqliteVersion: String(probe.stdout || '').trim() };
    }
  }
  throw new Error('Python 3 + sqlite3 not found（DB 断言需要；请安装 Python 或设置 PYTHON 环境变量）');
}

const PY_READ_DB = `
import json, pathlib, sqlite3, sys
uri = pathlib.Path(sys.argv[1]).as_uri() + "?mode=ro"
con = sqlite3.connect(uri, uri=True, timeout=5)
try:
    tables = [row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
    counts = {}
    for table in ("session", "message", "part"):
        if table in tables:
            counts[table] = con.execute("SELECT COUNT(*) FROM " + table).fetchone()[0]
    last_user = None
    if "message" in tables:
        row = con.execute("SELECT content FROM message WHERE role = 'user' ORDER BY created_at DESC, seq DESC LIMIT 1").fetchone()
        last_user = row[0] if row else None
    print(json.dumps({"tables": tables, "counts": counts, "lastUser": last_user}, ensure_ascii=False))
finally:
    con.close()
`;

function readSessionDb(dbFile) {
  const result = spawnSync(python.cmd, [...python.prefix, '-I', '-c', PY_READ_DB, dbFile], {
    encoding: 'utf8', windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || '').trim() || `python exited with ${result.status}`);
  }
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('sqlite readback returned no output');
  return JSON.parse(lines[lines.length - 1]);
}

function connectCdp(webSocketUrl) {
  return new Promise((resolvePromise, reject) => {
    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== 'function') {
      reject(new Error('global WebSocket unavailable：需要 Node 22+'));
      return;
    }
    const ws = new WebSocketCtor(webSocketUrl);
    const pending = new Map();
    let nextId = 0;
    let opened = false;

    const api = {
      send(method, params = {}) {
        return new Promise((resolveCall, rejectCall) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            rejectCall(new Error(`CDP timeout after 20s: ${method}`));
          }, 20_000);
          timer.unref?.();
          pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() {
        try { ws.close(); } catch { /* 已关闭 */ }
      }
    };

    ws.addEventListener('open', () => { opened = true; resolvePromise(api); });
    ws.addEventListener('error', () => {
      if (!opened) reject(new Error(`CDP websocket failed to open: ${webSocketUrl}`));
    });
    ws.addEventListener('close', () => {
      for (const [, handlers] of pending) {
        if (handlers.timer) clearTimeout(handlers.timer);
        handlers.reject(new Error('CDP websocket closed'));
      }
      pending.clear();
      if (!opened) reject(new Error('CDP websocket closed before open'));
    });
    ws.addEventListener('message', (event) => {
      let message = null;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message || !message.id) return;
      const handlers = pending.get(message.id);
      if (!handlers) return;
      pending.delete(message.id);
      if (handlers.timer) clearTimeout(handlers.timer);
      if (message.error) handlers.reject(new Error(`CDP ${message.error.message || 'error'}`));
      else handlers.resolve(message.result);
    });
  });
}

async function evaluate(expression, awaitPromise = false) {
  if (!cdp) throw new Error('CDP not connected');
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  });
  if (result?.exceptionDetails) {
    const exception = result.exceptionDetails.exception;
    throw new Error(`evaluate threw: ${exception?.description || result.exceptionDetails.text || 'unknown'}`);
  }
  return result?.result?.value;
}

async function fetchJson(url) {
  const response = await globalThis.fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function waitForPageTarget(port) {
  return waitFor(async () => {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const pages = (Array.isArray(targets) ? targets : []).filter((target) => target.type === 'page');
    return pages.find((target) => /out[\\/]+renderer[\\/]+index\.html/i.test(String(target.url || '')))
      || pages.find((target) => String(target.url || '').startsWith('file:'))
      || null;
  }, 'CDP page target', { timeout: 45_000, interval: 200 });
}

async function main() {
  log(`repo: ${REPO_ROOT}`);
  log('checking built artifacts and Electron binary');

  if (!existsSync(MAIN_ENTRY) || !existsSync(RENDERER_INDEX)) {
    throw new Error(`desktop/out 不完整：先执行 (cd desktop && npx electron-vite build)`);
  }
  if (!existsSync(ELECTRON_BIN)) {
    throw new Error(`Electron 二进制缺失：${ELECTRON_BIN}（先执行 cd desktop && npm install）`);
  }
  python = findPython();
  log(`python sqlite3 ${python.sqliteVersion}`);

  tempRoot = mkdtempSync(join(tmpdir(), 'finalcheck-e2e-'));
  const userDataDir = join(tempRoot, 'user-data');
  const projectDir = join(tempRoot, 'project');
  const projectDataDir = join(projectDir, '.finalcheck');
  const sessionsDir = join(projectDataDir, 'sessions');
  const memoryDir = join(projectDataDir, 'memory');
  const spillDir = join(tempRoot, 'spill');
  const projectsFile = join(tempRoot, 'projects.json');
  const configFile = join(tempRoot, 'config.json');
  for (const dir of [userDataDir, projectDir, sessionsDir, memoryDir, spillDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configFile, `${JSON.stringify(SMOKE_CONFIG, null, 2)}\n`, 'utf8');
  log(`isolated temp: ${tempRoot}`);

  const port = await findFreePort();
  log(`CDP port: ${port}`);

  const childEnv = {
    ...process.env,
    FINALCHECK_CONFIG_FILE: configFile,
    FINALCHECK_PROJECTS_FILE: projectsFile,
    FINALCHECK_SESSIONS_DIR: sessionsDir,
    FINALCHECK_MEMORY_DIR: memoryDir,
    FINALCHECK_SPILL_DIR: spillDir,
    FINALCHECK_DEFAULT_PROJECT: projectDir,
    FINALCHECK_SESSION_STORE: 'sqlite'
  };
  // 防止外部 shell 里残留的 dev server 地址把窗口指向 vite，而不是 out/renderer
  delete childEnv.ELECTRON_RENDERER_URL;
  delete childEnv.ELECTRON_RUN_AS_NODE;

  child = spawn(ELECTRON_BIN, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    // Windows 的「原生窗口遮挡检测」会把后台窗口标成 hidden，CDP 截图会一直等不到帧；
    // 冒烟要的是可复现截图，关掉遮挡检测让页面保持 visible。
    '--disable-features=CalculateNativeWinOcclusion',
    DESKTOP_DIR
  ], {
    cwd: DESKTOP_DIR,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  });
  child.stdout.on('data', (chunk) => logRaw('electron:out', chunk));
  child.stderr.on('data', (chunk) => logRaw('electron:err', chunk));
  child.on('error', (error) => log(`electron spawn error: ${error.message}`));
  child.on('exit', (code, signal) => log(`electron exited code=${code} signal=${signal || 'none'}`));
  log(`electron pid=${child.pid}`);

  const target = await waitForPageTarget(port);
  log(`page target: ${target.url}`);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  log('CDP connected');

  // a. 页面标题 / readyState / Workspaces
  const ready = await waitFor(async () => {
    const state = await evaluate(`(() => ({
      title: document.title,
      readyState: document.readyState,
      workspaces: !!(document.body && document.body.innerText.includes('Workspaces'))
    }))()`);
    return state && state.readyState === 'complete' && state.workspaces ? state : null;
  }, 'document readyState=complete + Workspaces', { timeout: 40_000 });
  if (!String(ready.title).includes('FinalCheck')) {
    throw new Error(`unexpected document.title: ${JSON.stringify(ready.title)}`);
  }
  log(`title=${JSON.stringify(ready.title)} readyState=${ready.readyState} Workspaces=ok`);

  // b. window.finalcheck + getConfig()
  const config = await waitFor(async () => {
    const result = await evaluate(`(async () => {
      const api = window.finalcheck;
      if (!api || typeof api.getConfig !== 'function') return { ok: false, reason: 'window.finalcheck.getConfig missing' };
      try {
        const cfg = await api.getConfig();
        return {
          ok: !!cfg && typeof cfg === 'object',
          providerCount: Array.isArray(cfg?.providers) ? cfg.providers.length : -1,
          activeProviderId: cfg?.activeProviderId ?? null
        };
      } catch (error) {
        return { ok: false, reason: String((error && error.message) || error) };
      }
    })()`, true);
    return result?.ok && result.providerCount > 0 ? result : null;
  }, 'window.finalcheck.getConfig()', { timeout: 30_000 });
  log(`getConfig ok: providers=${config.providerCount} activeProviderId=${config.activeProviderId}`);

  // 等 UI 真正拿到模型（否则 send() 会走「未配置模型」提前返回，不建会话）
  await waitFor(
    async () => evaluate(`document.body.innerText.includes('smoke-model')`),
    'composer model smoke-model visible',
    { timeout: 30_000 }
  );
  log('composer ready with smoke-model');

  // c1. 输入 "smoke test" + Enter（React 受控输入：用原生 setter + input 事件）
  const submitted = await evaluate(`(async () => {
    const textarea = Array.from(document.querySelectorAll('textarea')).find((el) => el.rows === 1 && !el.disabled);
    if (!textarea) return { ok: false, reason: 'composer textarea not found' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) return { ok: false, reason: 'HTMLTextAreaElement value setter missing' };
    setter.call(textarea, 'smoke test');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    textarea.focus();
    const keyEvent = new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
    });
    textarea.dispatchEvent(keyEvent);
    await new Promise((r) => setTimeout(r, 400));
    return {
      ok: true,
      handled: keyEvent.defaultPrevented,
      value: textarea.value,
      hasMessage: document.body.innerText.includes('smoke test')
    };
  })()`, true);
  if (!submitted?.ok) throw new Error(`composer submit failed: ${submitted?.reason || 'unknown'}`);
  if (!submitted.handled) throw new Error('Enter keydown was not handled by the composer');
  log('Enter handled by composer');

  const accepted = await waitFor(async () => {
    const state = await evaluate(`(() => {
      const textarea = Array.from(document.querySelectorAll('textarea')).find((el) => el.rows === 1);
      return {
        value: textarea ? textarea.value : null,
        hasMessage: document.body.innerText.includes('smoke test')
      };
    })()`);
    return state && state.value === '' && state.hasMessage ? state : null;
  }, 'message accepted and input cleared', { timeout: 15_000 });
  log(`message accepted, input cleared=${accepted.value === ''}`);

  // c2. DB 落盘：<temp project>/.finalcheck/finalcheck.db 存在，session 表 + 消息行
  const dbFile = join(projectDataDir, 'finalcheck.db');
  const database = await waitFor(async () => {
    if (!existsSync(dbFile)) return null;
    const snapshot = readSessionDb(dbFile);
    const hasSessionTable = Array.isArray(snapshot.tables) && snapshot.tables.includes('session');
    const hasRows = (snapshot.counts?.session || 0) > 0 && (snapshot.counts?.message || 0) > 0;
    const hasSmokeMessage = String(snapshot.lastUser || '').includes('smoke test');
    return hasSessionTable && hasRows && hasSmokeMessage ? snapshot : null;
  }, 'sqlite session/message rows', { timeout: 35_000, interval: 300 });
  log(`DB tables: ${database.tables.join(', ')}`);
  log(`DB counts: session=${database.counts.session} message=${database.counts.message}${database.counts.part != null ? ` part=${database.counts.part}` : ''}`);

  // d. 截图
  await sleep(300);
  log('capturing screenshot');
  const pageState = await evaluate(`({ visibility: document.visibilityState, width: window.innerWidth, height: window.innerHeight })`);
  log(`page state: ${JSON.stringify(pageState)}`);
  await cdp.send('Page.enable');
  try { await cdp.send('Page.bringToFront'); } catch { /* 非交互桌面可能不支持 */ }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  if (!shot?.data) throw new Error('Page.captureScreenshot returned no data');
  mkdirSync(artifactDir(), { recursive: true });
  writeFileSync(SCREENSHOT_PATH, Buffer.from(shot.data, 'base64'));
  const shotSize = statSync(SCREENSHOT_PATH).size;
  if (shotSize < 5_000) throw new Error(`screenshot too small: ${shotSize} bytes`);
  log(`screenshot: ${SCREENSHOT_PATH} (${shotSize} bytes)`);

  const summary = {
    elapsedSeconds: Number(elapsed()),
    dbFile,
    tables: database.tables,
    counts: database.counts,
    lastUser: database.lastUser,
    screenshot: SCREENSHOT_PATH,
    screenshotBytes: shotSize,
    cdpPort: port,
    tempRoot
  };

  finished = true;
  const graceful = await closeElectronGracefully();
  if (!graceful) log('graceful close timed out; killing process tree');
  await sleep(300); // 给 Windows 一点时间释放 user-data 文件句柄，再删临时目录
  const tempRemoved = cleanup({ keepTemp: false });
  try { rmSync(join(artifactDir(), 'smoke.log'), { force: true }); } catch { /* 清理上次失败留下的日志 */ }
  summary.elapsedSeconds = Number(elapsed());
  console.log(`\n[smoke] PASS in ${summary.elapsedSeconds}s`);
  console.log(`[smoke] DB tables: ${summary.tables.join(', ')}`);
  console.log(`[smoke] DB rows: session=${summary.counts.session} message=${summary.counts.message}`);
  console.log(`[smoke] screenshot: ${summary.screenshot} (${summary.screenshotBytes} bytes)`);
  console.log(`[smoke] temp profile: ${summary.tempRoot} (${tempRemoved ? 'removed' : 'kept: Windows handle still busy'})`);
  process.exit(0);
}

armWatchdog();
main().catch((error) => fail(error?.stack || String(error)));
