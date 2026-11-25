// Real Electron rail interactions against a loopback fixture and a new profile.
// Run after desktop build: node scripts/testbench-rail-humanflow.mjs
// FINALCHECK_WINDOW_BG=1 keeps the app hidden; renderer and guest CDP images are still required.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createPortProbe } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { newSession, appendUserMessage, appendAssistantMessage, renameSession, closeAllSessionDatabases } from '../desktop/src/main/sessions.mjs';
import { normalizeSteps, stepHash } from '../desktop/src/main/workflow.mjs';
import { createJournal, recordStep, saveJournal } from '../desktop/src/main/workflow-journal.mjs';
import { writeStepTranscript } from '../desktop/src/main/transcripts.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidenceRoot = path.join(root, '.tmp', 'rail-humanflow');
const background = process.env.FINALCHECK_WINDOW_BG === '1';
const refreshMs = 3400; // BrowserPane polls every 3s; the hold spans a full cycle.
const address = 'input[data-browser-address]';
const browserRail = '[data-rail-tab][data-rail-kind="browser"]';
const closeRail = '[data-rail] button[aria-label="关闭右栏"], [data-rail] button[aria-label="Close rail"]';

const title = { primary: '会话一', secondary: '会话二' };
const message = { primary: '第一个会话的真人链路', secondary: '第二个会话的真人链路' };
const stepId = 'local-preview-step';
const stepName = '本地预览核验员';
const stepPrompt = '检查本地测试图片的预览状态。';
const stepAnswer = '本地步骤已确认：预览检查通过 8F3A。';

/**
 * 0.32.6 自伤防护（我从 0.32.5 踩出来的坑，合并时保留）：
 * 这个测试台驱动的是 desktop/out/（构建产物），不是 src/。
 * 只改 src 不重建 → 整套验证跑在旧代码上（我因此在 S15/S16 上反复"复现/消失"，白折腾一整轮）。
 * 所以起 Electron 前主动比对 src 与 out 的 mtime，过期就立刻构建。
 */
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
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['electron-vite', 'build'], { cwd: path.join(root, 'desktop'), stdio: 'ignore' });
  console.log('[build] 完成');
}
await ensureFreshBuild();

await mkdir(evidenceRoot, { recursive: true });
const out = await mkdtemp(path.join(evidenceRoot, 'run-'));
const runTemp = await mkdtemp(path.join(tmpdir(), 'fc-rail-humanflow-'));
const userData = path.join(runTemp, 'fc-ui-selfcheck'); // index.mjs applies this suffix in selfcheck mode.
const projectDir = path.join(runTemp, 'project');
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const results = [];
const screenshots = [];
const sockets = new Set();
let step = 'setup';
let child;
let exited;
let spawnError;
let renderer;
let origin;
let port;
let failure;

const imageFixtures = [
  { name: 'artifact-A.svg', width: 160, height: 100, color: '#c0392b', letter: 'A' },
  { name: 'artifact-B.svg', width: 120, height: 80, color: '#265cc5', letter: 'B' }
].map((image) => {
  const xml = '<svg xmlns="http://www.w3.org/2000/svg" width="' + image.width + '" height="' + image.height + '">'
    + '<rect width="100%" height="100%" fill="' + image.color + '"/>'
    + '<text x="50%" y="62%" fill="white" font-size="40" text-anchor="middle">' + image.letter + '</text></svg>';
  return { ...image, path: path.join(projectDir, image.name), xml,
    src: 'data:image/svg+xml;base64,' + Buffer.from(xml).toString('base64') };
});

const hits = new Map();
const count = (urlPath) => hits.get(urlPath) || 0;
const server = createServer((req, res) => {
  const urlPath = req.url;
  const page = new URL(urlPath, 'http://127.0.0.1').pathname;
  if (!['/one', '/two', '/reopened', '/fresh', '/other'].includes(page)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const n = count(urlPath) + 1;
  hits.set(urlPath, n);
  const isFirst = page === '/one';
  const bg = isFirst ? '#fff7e6' : '#e8f0ff';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><title>Fixture ' + page + '</title>'
    + '<body style="margin:0;padding:20px;background:' + bg + ';font:20px sans-serif">'
    + '<h1>Fixture ' + page + '</h1><p id="hit">' + n + '</p>'
    + (isFirst ? '<a id="popup" href="/two" target="_blank">Open the second fixture page</a>' : '')
    + (urlPath === '/two?from=blank' ? '<script>let tick = 0; setInterval(() => { document.title = "Fixture /two " + ++tick; }, 650);</script>' : '')
    + '</body>');
});

function listen(instance) {
  return new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', () => {
      instance.removeListener('error', reject);
      resolve(instance.address().port);
    });
  });
}

async function seed() {
  await mkdir(userData, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(path.join(userData, 'config.json'), JSON.stringify({
    providers: [{ id: 'p-ui', name: 'UI Test', baseUrl: origin + '/v1', apiFormat: 'chat-completions',
      apiKey: 'test-key', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true }],
    activeProviderId: 'p-ui', language: 'zh', theme: 'dark', browserSessionMode: 'oneshot'
  }));
  process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
  process.env.FINALCHECK_SESSION_STORE = 'sqlite';
  const first = await newSession(title.primary);
  const second = await newSession(title.secondary);
  await appendUserMessage(first.id, message.primary);
  await appendUserMessage(second.id, message.secondary);
  await renameSession(first.id, title.primary);
  await renameSession(second.id, title.secondary);
  await Promise.all(imageFixtures.map((image) => writeFile(image.path, image.xml)));

  const goal = '验证真实会话中右栏预览';
  const normalized = normalizeSteps([{ id: stepId, name: stepName, role: stepName, prompt: stepPrompt }], { goal });
  assert.equal(normalized.error, undefined);
  const { steps } = normalized;
  const [localStep] = steps;
  const run = createJournal({ goal });
  const result = { ...localStep, ok: true, content: stepAnswer, ms: 124, tools: 0 };
  const transcriptRoot = path.join(userData, 'workflow-runs');
  recordStep(run, localStep, { ...result, status: 'success', hash: stepHash(goal, localStep) });
  run.finishedAt = Date.now();
  await saveJournal(run, { dir: transcriptRoot });
  await writeStepTranscript(transcriptRoot, run.runId, stepId, {
    sessionId: first.id, role: stepName, done: true, ms: result.ms, toolCount: 0,
    messages: [{ role: 'user', content: stepPrompt }, { role: 'assistant', content: stepAnswer }]
  });
  await appendAssistantMessage(first.id, {
    content: '可在右栏查看本地图片和工作流步骤。',
    trace: [
      ...imageFixtures.map((image) => ({ tool: 'present_artifact', args: { path: image.path },
        result: { path: image.path, title: image.name } })),
      { tool: 'run_workflow', args: { goal, steps }, result: { runId: run.runId, goal, steps, ok: true, results: [result], ms: result.ms } }
    ]
  });
  return { primary: first.id, secondary: second.id };
}

async function until(read, label, timeoutMs = 9000) {
  const end = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value) return value;
    await sleep(110);
  } while (Date.now() < end);
  throw new Error('Timed out: ' + label);
}

async function stable(read, label, duration = refreshMs) {
  const end = Date.now() + duration;
  do {
    assert.ok(await read(), label);
    await sleep(120);
  } while (Date.now() < end);
  assert.ok(await read(), label);
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let index = 0;
  sockets.add(ws);
  ws.addEventListener('close', () => {
    sockets.delete(ws);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP target disconnected: ' + target.id));
    }
    pending.clear();
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id);
    clearTimeout(request.timer);
    if (msg.error) request.reject(new Error(request.method + ': ' + msg.error.message));
    else request.resolve(msg.result);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timeout: ' + target.id)), 4000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP connection failed: ' + target.id));
    }, { once: true });
  });
  return {
    id: target.id,
    close: () => ws.close(),
    send(method, params = {}, timeout = 5000) {
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error('CDP socket unavailable: ' + method));
          return;
        }
        const id = ++index;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('CDP command timeout: ' + method));
        }, timeout);
        pending.set(id, { method, timer, resolve, reject });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    }
  };
}

async function targets() {
  const reply = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500) });
  assert.ok(reply.ok, 'CDP target list HTTP ' + reply.status);
  return reply.json();
}

function guestTargets() {
  return targets().then((list) => list.filter((target) => target.id !== renderer.id && target.webSocketDebuggerUrl));
}

const byUrl = (list, urlPath) => list.find((target) => target.url === origin + urlPath);
const ids = (list) => list.map((target) => target.id).sort();

async function evaluate(page, fn, ...args) {
  const reply = await page.send('Runtime.evaluate', {
    expression: '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')',
    returnByValue: true, awaitPromise: true
  });
  assert.ok(!reply.exceptionDetails, reply.exceptionDetails?.exception?.description || reply.exceptionDetails?.text);
  return reply.result?.value;
}

async function click(page, selector, label = '', text = '') {
  const point = await until(() => evaluate(page, (query, value) => {
    const matches = [...document.querySelectorAll(query)].filter((el) =>
      el.checkVisibility() && (!value || (el.textContent || '').trim().includes(value)));
    if (matches.length !== 1) return null;
    const node = matches[0];
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = node.getBoundingClientRect();
    const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
    const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
    return rect.width > 0 && rect.height > 0 && node.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
  }, selector, text), 'clickable ' + (label || selector));
  const event = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await page.send('Input.dispatchMouseEvent', { ...event, type: 'mousePressed' });
  await page.send('Input.dispatchMouseEvent', { ...event, type: 'mouseReleased' });
}

async function key(name, code) {
  const event = { key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await renderer.send('Input.dispatchKeyEvent', { ...event, type: 'rawKeyDown' });
  await renderer.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
}

async function snapshot(sessionId) {
  const info = await evaluate(renderer, async (addressSelector, owner) => {
    const host = await window.finalcheck.browserTabs(owner);
    const aside = document.querySelector('[data-rail]');
    const body = document.querySelector('[data-rail-body]');
    const box = document.querySelector('[data-browser-box]');
    const input = document.querySelector(addressSelector);
    const rect = box?.getBoundingClientRect();
    const img = body?.querySelector('img');
    return {
      host, mode: aside?.dataset.rail || null, animating: aside?.dataset.railAnimating === '1',
      kind: body?.dataset.railActiveKind || null, text: body?.innerText || '',
      tabs: [...document.querySelectorAll('[data-rail-tab]')].map((node) => node.title),
      box: rect ? { x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height) } : null,
      address: input ? { value: input.value, focused: input === document.activeElement } : null,
      image: img && { name: img.alt, src: img.currentSrc, complete: img.complete, width: img.naturalWidth, height: img.naturalHeight }
    };
  }, address, ...(sessionId ? [sessionId] : []));
  assert.ok(info?.host?.ok && Array.isArray(info.host.tabs)
    && Array.isArray(info.host.views) && Array.isArray(info.host.showing), 'Browser diagnostics unavailable');
  return info;
}

const viewOf = (state, id) => state.host.views.find((view) => view.id === id);
const showingOnly = (state, id) => Boolean(id && state.kind === 'browser' && state.host.hostVisible
  && state.host.activeId === id && state.host.showing.length === 1 && state.host.showing[0] === id
  && viewOf(state, id)?.showing === true);
const hidden = (state) => !state.host.hostVisible && state.host.showing.length === 0
  && state.host.views.every((view) => !view.showing);
const hasPages = (state, expected) => JSON.stringify(state.host.tabs.map(({ url }) => url === 'about:blank' ? '' : url).sort())
  === JSON.stringify(expected.map((item) => item && origin + item).sort());

async function awaitState(test, label) {
  let last;
  try {
    return await until(async () => {
      last = await snapshot();
      return test(last) ? last : null;
    }, label);
  } catch (error) {
    throw new Error(error.message + ' | last snapshot: ' + JSON.stringify(last), { cause: error });
  }
}

function assertPng(data, name) {
  assert.ok(data.length > 24 && data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0, 'Missing or invalid screenshot: ' + name);
}

async function screenshot(page, name, source) {
  const result = await page.send('Page.captureScreenshot', { format: 'png' }, 9000);
  const data = Buffer.from(result?.data || '', 'base64');
  assertPng(data, name);
  const file = path.join(out, name + '.png');
  await writeFile(file, data);
  screenshots.push({ source, targetId: page.id, file });
}

async function nativeScreenshot(name) {
  if (process.platform !== 'win32' || background) {
    screenshots.push({ source: 'native-window', name, unavailable: background
      ? 'FINALCHECK_WINDOW_BG=1 runs without requiring an interactive foreground window' : 'Native window capture is implemented for Windows' });
    return;
  }
  const file = path.join(out, name + '-native.png');
  // PrintWindow targets only our Electron HWND. Full desktop captures can expose unrelated windows.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Drawing',
    "Add-Type -Name OwnedWindow -Namespace RailFixture -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool GetWindowRect(System.IntPtr handle, out Rect rect); [System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool PrintWindow(System.IntPtr handle, System.IntPtr dest, uint flags); public struct Rect { public int Left, Top, Right, Bottom; }'",
    '$h = (Get-Process -Id ' + child.pid + ').MainWindowHandle',
    'if ($h -eq 0) { throw "Electron has no native window handle" }',
    '$r = New-Object RailFixture.OwnedWindow+Rect',
    'if (-not [RailFixture.OwnedWindow]::GetWindowRect($h, [ref]$r)) { throw "GetWindowRect failed" }',
    '$bmp = New-Object Drawing.Bitmap ($r.Right-$r.Left),($r.Bottom-$r.Top)',
    '$g = [Drawing.Graphics]::FromImage($bmp)',
    '$hdc = $g.GetHdc()',
    'try { $painted = [RailFixture.OwnedWindow]::PrintWindow($h, $hdc, 2) } finally { $g.ReleaseHdc($hdc); $g.Dispose() }',
    'try {',
    '  if (-not $painted) { throw "PrintWindow failed" }',
    '  $colors = @(1..8 | ForEach-Object { $x = [int]($bmp.Width * $_ / 9); 1..8 | ForEach-Object { $bmp.GetPixel($x, [int]($bmp.Height * $_ / 9)).ToArgb() } } | Select-Object -Unique)',
    '  if ($colors.Count -lt 3) { throw "PrintWindow returned a blank image" }',
    "  $bmp.Save('" + file.replace(/'/g, "''") + "', [Drawing.Imaging.ImageFormat]::Png)",
    '} finally { $bmp.Dispose() }'
  ].join('\n');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { timeout: 4500, windowsHide: true, stdio: 'pipe' });
    assertPng(await readFile(file), name);
    screenshots.push({ source: 'native-window', file });
  } catch (error) {
    screenshots.push({ source: 'native-window', name, unavailable: String(error.stderr || error.message).trim().slice(-600) });
  }
}

async function check(id, name, test) {
  step = id;
  const detail = await test();
  results.push({ step: id, name, ok: true, detail });
  console.log('PASS [' + id + '] ' + name);
}


// Attribute equality uses quoted CSS string tokens rather than query fragments from labels.
const titled = (selector, value) => selector + '[title=' + JSON.stringify(value) + ']';
const artifactTab = (image) => titled('[data-rail-tab][data-rail-kind="artifact"]', 'artifact:' + image.path);

async function selectSession(which) {
  await click(renderer, 'div[title^=' + JSON.stringify(title[which]) + ']', title[which]);
  await until(() => evaluate(renderer, (expected, previous) =>
    document.body.innerText.includes(expected) && !document.body.innerText.includes(previous),
  message[which], message[which === 'primary' ? 'secondary' : 'primary']), 'active session ' + title[which]);
}

async function bootstrap(urlPath) {
  // The first page is normally opened by AI or an existing browser action.
  const result = await evaluate(renderer, (url) => window.finalcheck.browserGoto(url), origin + urlPath);
  assert.ok(result?.ok && result.embedded, 'Initial in-app navigation failed: ' + JSON.stringify(result));
  return awaitState((state) => showingOnly(state, state.host.activeId) && hasPages(state, [urlPath]), 'browser shows ' + urlPath);
}

function imageSelected(state, image, expectedTabs = 3) {
  return state.mode === 'tabs' && state.kind === 'artifact' && hidden(state)
    && state.host.tabs.length === expectedTabs && state.tabs.includes('artifact:' + image.path)
    && state.image?.complete && state.image.name === image.name && state.image.src === image.src
    && state.image.width === image.width && state.image.height === image.height;
}

async function holdThroughBrowserUpdates(selected, label) {
  const titles = new Set();
  await stable(async () => {
    const state = await snapshot();
    const active = state.host.tabs.find((tab) => tab.id === state.host.activeId);
    if (active?.title) titles.add(active.title);
    return selected(state);
  }, label);
  assert.ok(titles.size > 1, 'No native browser title update observed while holding selection: ' + label);
  return titles.size - 1;
}

async function confirmImage(image, name) {
  await awaitState((state) => imageSelected(state, image), 'decoded ' + image.name);
  const decoded = await evaluate(renderer, async () => {
    const img = document.querySelector('[data-rail-body] img');
    if (!img) return null;
    await img.decode();
    return { name: img.alt, width: img.naturalWidth, height: img.naturalHeight };
  });
  assert.deepEqual(decoded, { name: image.name, width: image.width, height: image.height });
  const browserTitleUpdates = await holdThroughBrowserUpdates((state) => imageSelected(state, image),
    image.name + ' remains selected and unobstructed');
  await screenshot(renderer, name, 'renderer');
  return { ...decoded, browserTitleUpdates };
}

async function waitGuest(urlPath) {
  return until(async () => byUrl(await guestTargets(), urlPath), 'native guest for ' + urlPath);
}

async function guestShot(guestTarget, name) {
  const guest = await connect(guestTarget);
  try {
    await until(() => evaluate(guest, (url) =>
      location.href === url && document.readyState === 'complete' && !!document.querySelector('#hit'),
    guestTarget.url), 'fixture document loaded for ' + name);
    await screenshot(guest, name, 'native-web-content');
  } finally {
    guest.close();
  }
}

async function waitExit(timeout) {
  const end = Date.now() + timeout;
  while (!exited && Date.now() < end) await sleep(80);
  return Boolean(exited);
}

async function cleanup() {
  let electron = 'not started';
  if (child?.pid) {
    if (!exited && renderer) {
      try { await renderer.send('Browser.close', {}, 1400); } catch { /* Target often disappears before responding. */ }
    }
    electron = 'exited';
    if (!await waitExit(1800)) {
      electron = 'terminated test process tree';
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 2400, windowsHide: true, stdio: 'ignore' });
        } catch { child.kill(); }
      } else child.kill('SIGKILL');
      assert.ok(await waitExit(2200), 'Owned Electron process did not exit after termination');
    }
  }
  return { electron };
}

let mainCleanup;
try {
  const desktop = path.join(root, 'desktop');
  assert.ok(existsSync(path.join(desktop, 'out', 'main', 'index.js'))
    && existsSync(path.join(desktop, 'out', 'renderer', 'index.html')), 'Build desktop before running the harness (npm --prefix desktop run build)');
  const electron = (await import('../desktop/node_modules/electron/index.js')).default;
  assert.ok(existsSync(electron), 'Electron executable is missing');
  origin = 'http://127.0.0.1:' + await listen(server);
  const sessionIds = await seed().finally(closeAllSessionDatabases);
  const reservation = createPortProbe();
  port = await listen(reservation);
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(FINALCHECK_|ELECTRON_)/i.test(name)));
  child = spawn(electron, [
    '--remote-debugging-port=' + port, '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + userData, '--no-first-run', '--no-proxy-server',
    '--disable-features=CalculateNativeWinOcclusion', desktop
  ], {
    cwd: desktop, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
    env: {
      ...env, TEMP: runTemp, TMP: runTemp, TMPDIR: runTemp, APPDATA: runTemp, LOCALAPPDATA: runTemp,
      FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_WINDOW_BG: background ? '1' : '0',
      FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'), FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
      FINALCHECK_DEFAULT_PROJECT: projectDir, FINALCHECK_SESSIONS_DIR: sessionsDir, FINALCHECK_SESSION_STORE: 'sqlite'
    }
  });
  child.on('error', (error) => { spawnError = error; });
  child.on('close', (code, signal) => { exited = { code, signal }; });
  for (const [source, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('data', (data) => appendFileSync(path.join(out, 'electron-' + source + '.log'), data));
  }
  const mainTarget = await until(async () => {
    if (spawnError) throw spawnError;
    if (exited) throw new Error('Electron exited during startup: ' + JSON.stringify(exited));
    let list;
    try { list = await targets(); } catch { return null; }
    return list.find((target) => target.type === 'page' && /out\/renderer\/index\.html(?:[?#]|$)/i.test(target.url));
  }, 'FinalCheck renderer CDP target', 30000);
  renderer = await connect(mainTarget);

  await check('S0', '启动进入工作区，尚无右栏和客体页面', async () => {
    await until(() => evaluate(renderer, (label) => [...document.querySelectorAll('div[title]')]
      .some((node) => node.title.startsWith(label) && node.checkVisibility()), title.primary), 'seeded workspace visible', 20000);
    const state = await snapshot();
    assert.ok(state.mode === null && hidden(state));
    assert.deepEqual(await guestTargets(), []);
  });

  await check('S0b', '通过会话列表进入有预置消息的真实会话', async () => {
    await selectSession('primary');
    return { title: title.primary, message: message.primary };
  });

  let first;
  let firstId;
  await check('S1', '第一个网页的原生画面贴合右栏占位区', async () => {
    const state = await bootstrap('/one');
    firstId = state.host.activeId;
    const shown = viewOf(state, firstId);
    assert.deepEqual(shown.bounds, state.box);
    first = await waitGuest('/one');
    assert.deepEqual(ids(await guestTargets()), [first.id]);
    await screenshot(renderer, 's1-renderer', 'renderer');
    await guestShot(first, 's1-web-content');
    return { bounds: shown.bounds, targetId: first.id };
  });

  let second;
  let secondId;
  await check('S2', '点击内嵌网页 target=_blank 链接，仅新增一个内嵌标签', async () => {
    const guest = await connect(first);
    try {
      assert.deepEqual(await evaluate(guest, () => {
        const link = document.querySelector('#popup');
        return [link?.target, link?.getAttribute('href')];
      }), ['_blank', '/two']);
      await click(guest, '#popup', 'nested target=_blank link');
    } finally { guest.close(); }
    const state = await awaitState((item) => hasPages(item, ['/one', '/two'])
      && showingOnly(item, item.host.activeId) && viewOf(item, item.host.activeId)?.url === origin + '/two', 'one new active popup tab');
    secondId = state.host.activeId;
    assert.notEqual(secondId, firstId);
    second = await waitGuest('/two');
    assert.notEqual(second.id, first.id);
    await stable(async () => JSON.stringify(ids(await guestTargets())) === JSON.stringify(ids([first, second]))
      && count('/one') === 1 && count('/two') === 1, 'Exactly one new WebContents responds to popup click', 550);
    await screenshot(renderer, 's2-renderer', 'renderer');
    await guestShot(second, 's2-web-content');
    await click(renderer, titled('span', origin + '/one'), 'first webpage strip tab');
    await awaitState((item) => showingOnly(item, firstId), 'switch to first page');
    await click(renderer, titled('span', origin + '/two'), 'second webpage strip tab');
    await awaitState((item) => showingOnly(item, secondId), 'switch to second page');
    return { previous: first.id, added: second.id, hits: count('/two') };
  });

  let blank;
  let blankId;
  const typedPath = '/two?from=blank';
  await check('S3', '点加号创建实际空白页，空地址栏得到焦点', async () => {
    await click(renderer, '[data-browser-new-tab]');
    const state = await awaitState((item) => hasPages(item, ['/one', '/two', ''])
      && showingOnly(item, item.host.activeId) && item.address?.focused && item.address.value === '', 'new blank tab and focused empty address');
    blankId = state.host.activeId;
    const list = await guestTargets();
    assert.equal(list.length, 3);
    [blank] = list.filter((item) => item.id !== first.id && item.id !== second.id);
    assert.ok(blank && (blank.url === '' || blank.url === 'about:blank'));
    await screenshot(renderer, 's3-focused-blank-tab', 'renderer');
    return { tabId: blankId, targetId: blank.id, address: state.address };
  });

  await check('S4', '真实地址栏编辑跨同步保留，回车在同一个空白页里加载', async () => {
    const url = origin + typedPath;
    assert.equal((await snapshot()).address?.focused, true);
    await renderer.send('Input.insertText', { text: url + 'x' });
    await key('Backspace', 8);
    await stable(async () => {
      const state = await snapshot();
      return showingOnly(state, blankId) && state.address?.focused && state.address.value === url && count(typedPath) === 0;
    }, 'Typed and edited URL stays focused and unchanged across polling');
    await key('Enter', 13);
    const state = await awaitState((item) => showingOnly(item, blankId) && hasPages(item, ['/one', '/two', typedPath])
      && item.address?.value === url, 'Enter loads typed URL in original blank tab');
    const target = await waitGuest(typedPath);
    assert.equal(target.id, blank.id);
    assert.deepEqual(ids(await guestTargets()), ids([first, second, blank]));
    assert.equal(count(typedPath), 1);
    await guestShot(target, 's4-typed-url-web-content');
    return { targetId: target.id, activeTab: state.host.activeId, url: state.address.value };
  });

  await check('S5', '刷新只给活动网址增加一次 HTTP 主文档请求', async () => {
    const before = [count('/one'), count('/two'), count(typedPath)];
    const target = await waitGuest(typedPath);
    const guest = await connect(target);
    try {
      await click(renderer, '[data-browser-reload]');
      await until(() => evaluate(guest, (expected) => Number(document.querySelector('#hit')?.textContent) === expected,
        before[2] + 1), 'same guest rendered exactly the next reload request');
      await stable(async () => {
        const state = await snapshot();
        return showingOnly(state, blankId) && hasPages(state, ['/one', '/two', typedPath])
          && count('/one') === before[0] && count('/two') === before[1] && count(typedPath) === before[2] + 1
          && JSON.stringify(ids(await guestTargets())) === JSON.stringify(ids([first, second, blank]));
      }, 'Only the current WebContents reloads exactly once', 600);
      await screenshot(guest, 's5-reload-web-content', 'native-web-content');
    } finally { guest.close(); }
    return { targetId: target.id, before, after: [count('/one'), count('/two'), count(typedPath)] };
  });

  await check('S6', '折叠右栏隐藏原生画面，保留三个网页标签', async () => {
    await click(renderer, '[data-rail-toggle="collapse"]');
    await awaitState((state) => state.mode === 'collapsed' && !state.animating && hidden(state)
      && hasPages(state, ['/one', '/two', typedPath]), 'collapsed without destroying browser');
    assert.deepEqual(ids(await guestTargets()), ids([first, second, blank]));
    await screenshot(renderer, 's6-collapsed', 'renderer');
    await nativeScreenshot('s6-collapsed');
  });

  await check('S7', '展开右栏恢复原活动网页与浏览器画面', async () => {
    await click(renderer, '[data-rail-toggle="expand"]');
    const state = await awaitState((item) => item.mode === 'tabs' && !item.animating && showingOnly(item, blankId)
      && hasPages(item, ['/one', '/two', typedPath]), 'expanded same active page');
    assert.deepEqual(viewOf(state, blankId).bounds, state.box);
    assert.equal((await waitGuest(typedPath)).id, blank.id);
    await screenshot(renderer, 's7-expanded', 'renderer');
    await nativeScreenshot('s7-expanded');
  });

  await check('S8', '点聊天里的图片 A/B，再点右栏 A，三次验证对应图片与无网页覆盖', async () => {
    const [a, b] = imageFixtures;
    await click(renderer, titled('button', a.path), 'image A chip');
    const selectedA = await confirmImage(a, 's8a-artifact-A');
    await nativeScreenshot('s8a-artifact-A');
    await click(renderer, titled('button', b.path), 'image B chip');
    const selectedB = await confirmImage(b, 's8b-artifact-B');
    await click(renderer, artifactTab(a), 'image A rail tab');
    const backToA = await confirmImage(a, 's8c-artifact-A-restored');
    assert.deepEqual(ids(await guestTargets()), ids([first, second, blank]));
    return [selectedA, selectedB, backToA];
  });

  await check('S8d', '点存档工作流步骤，实际展示对应的本地任务和答案', async () => {
    await click(renderer, browserRail);
    await awaitState((state) => showingOnly(state, blankId), 'restored browser before workflow click');
    await click(renderer, 'button[title^=' + JSON.stringify(stepName) + ']', 'completed-workflow step chip', stepName);
    const selected = (state) => state.kind === 'subagent' && hidden(state) && state.tabs.includes('subagent:' + stepId)
      && state.text.includes(stepName) && state.text.includes(stepPrompt) && state.text.includes(stepAnswer);
    await awaitState(selected, 'stored workflow transcript visible in right rail');
    const browserTitleUpdates = await holdThroughBrowserUpdates(selected, 'Workflow result stays visible throughout refresh interval');
    await screenshot(renderer, 's8d-workflow-transcript', 'renderer');
    await nativeScreenshot('s8d-workflow-transcript');
    return { stepId, answer: stepAnswer, browserTitleUpdates };
  });

  await check('S9', '从浏览器切到设置页并隐藏原生网页', async () => {
    await click(renderer, browserRail);
    await awaitState((state) => showingOnly(state, blankId), 'active native browser before settings');
    await click(renderer, 'button', 'settings button', 'Settings');
    await until(() => evaluate(renderer, () => document.body.innerText.includes('返回工作区')
      || document.body.innerText.includes('Back to workspace')), 'settings view');
    await awaitState(hidden, 'native browser hidden in settings');
    assert.deepEqual(ids(await guestTargets()), ids([first, second, blank]));
    await screenshot(renderer, 's9-settings', 'renderer');
    await nativeScreenshot('s9-settings');
  });

  await check('S10', '返回工作区后，恢复原活动网页与同一个客体', async () => {
    await click(renderer, 'button', 'back to workspace', '返回工作区');
    await awaitState((state) => state.mode === 'tabs' && showingOnly(state, blankId)
      && hasPages(state, ['/one', '/two', typedPath]), 'settings return restored active browser');
    assert.equal((await waitGuest(typedPath)).id, blank.id);
    await screenshot(renderer, 's10-back-to-workspace', 'renderer');
  });

  await check('S11', '窄右栏按设计宽度缩放内嵌网页', async () => {
    const state = await snapshot();
    const { zoom } = viewOf(state, blankId);
    assert.ok(state.box.width > 0 && Number.isFinite(zoom) && zoom > 0 && zoom <= 1);
    assert.ok(state.box.width >= 1180 ? zoom === 1 : zoom < 1);
    return { zoom, width: state.box.width };
  });

  await check('S12', '外部浏览器按钮存在，拒绝空网址且保留内嵌标签', async () => {
    assert.ok(await evaluate(renderer, () => !!document.querySelector('[data-browser-external]')?.checkVisibility()));
    const probe = await evaluate(renderer, () => window.finalcheck.browserOpenExternal(''));
    assert.equal(probe?.ok, false);
    assert.deepEqual(ids(await guestTargets()), ids([first, second, blank]));
  });

  let other;
  await check('S13', '切换到另一个真实会话，原生网页隐藏且由该会话独立开页', async () => {
    await selectSession('secondary');
    await awaitState((state) => state.mode === null && hidden(state), 'switch hides original browser rail');
    await until(async () => hidden(await snapshot(sessionIds.primary)), 'inactive primary native host is hidden');
    await screenshot(renderer, 's13-other-session-empty', 'renderer');
    await bootstrap('/other');
    other = await waitGuest('/other');
    assert.deepEqual(ids(await guestTargets()), ids([first, second, blank, other]));
    assert.ok(hidden(await snapshot(sessionIds.primary)));
    await guestShot(other, 's13-other-session-web-content');
    return { browserTarget: other.id };
  });

  await check('S14', '切回原会话，原有网页与产物及步骤标签恢复', async () => {
    await selectSession('primary');
    const state = await awaitState((item) => item.mode === 'tabs' && showingOnly(item, blankId)
      && hasPages(item, ['/one', '/two', typedPath]), 'return restores original session tabs');
    assert.equal((await waitGuest(typedPath)).id, blank.id);
    assert.ok(hidden(await snapshot(sessionIds.secondary)));
    assert.ok(imageFixtures.every((image) => state.tabs.includes('artifact:' + image.path)));
    assert.ok(state.tabs.includes('subagent:' + stepId));
    await screenshot(renderer, 's14-session-restored', 'renderer');
    return { tabs: state.tabs, browserTarget: blank.id };
  });

  await check('S15', '网页标签上的 X 确实销毁该 WebContents', async () => {
    await click(renderer, titled('span', origin + typedPath) + ' button', 'close active webpage tab');
    await awaitState((state) => hasPages(state, ['/one', '/two'])
      && state.host.activeId !== blankId && showingOnly(state, state.host.activeId), 'active tab removed and fallback visible');
    await until(async () => JSON.stringify(ids(await guestTargets())) === JSON.stringify(ids([first, second, other])),
      'closed webpage target destroyed');
    return { destroyed: blank.id };
  });

  let reopened;
  await check('S16', '浏览器面板 X 销毁原有网页，再开只显示新网页', async () => {
    await click(renderer, browserRail + ' button', 'close browser rail tab');
    await awaitState((state) => !state.tabs.includes('browser') && hidden(state), 'browser panel closed');
    await until(async () => JSON.stringify(ids(await guestTargets())) === JSON.stringify([other.id]),
      'all WebContents of closed browser panel destroyed');
    await bootstrap('/reopened');
    reopened = await waitGuest('/reopened');
    assert.deepEqual(ids(await guestTargets()), ids([other, reopened]));
    assert.ok(![first.id, second.id, blank.id].includes(reopened.id));
    await guestShot(reopened, 's16-reopened-web-content');
    return { destroyed: [first.id, second.id], reopened: reopened.id };
  });

  await check('S17', '关闭整条右栏销毁该会话画面，重新打开只有新的浏览器标签', async () => {
    await click(renderer, closeRail);
    await awaitState((state) => state.mode === null && hidden(state) && state.tabs.length === 0, 'all-close removed rail panels');
    await until(async () => JSON.stringify(ids(await guestTargets())) === JSON.stringify([other.id]),
      'all-close destroyed reopened WebContents and preserved other session');
    const state = await bootstrap('/fresh');
    assert.deepEqual(state.tabs, ['browser']);
    const fresh = await waitGuest('/fresh');
    assert.deepEqual(ids(await guestTargets()), ids([other, fresh]));
    assert.notEqual(fresh.id, reopened.id);
    await screenshot(renderer, 's17-cleared-and-fresh', 'renderer');
    await guestShot(fresh, 's17-fresh-web-content');
    return { destroyed: reopened.id, fresh: fresh.id };
  });
} catch (error) {
  failure = error.stack || String(error);
  results.push({ step, ok: false, detail: failure });
  console.error('FAIL [' + step + '] ' + failure);
  if (renderer) await screenshot(renderer, 'failure-' + step, 'renderer').catch(() => {});
} finally {
  try { mainCleanup = await cleanup(); } catch (error) { failure ||= error.stack || String(error); }
  for (const socket of sockets) socket.close();
  const serverClosed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await serverClosed;
  if (mainCleanup) {
    try {
      const resolvedTemp = await realpath(runTemp);
      assert.equal(path.dirname(resolvedTemp), await realpath(tmpdir()));
      assert.ok(path.basename(resolvedTemp).startsWith('fc-rail-humanflow-'));
      await rm(resolvedTemp, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
    } catch (error) {
      failure ||= error.stack || String(error);
    }
  }
  await writeFile(path.join(out, 'result.json'), JSON.stringify({
    ok: !failure, origin, profile: userData, port, results, screenshots, cleanup: mainCleanup, counts: [...hits], failure
  }, null, 2));
  process.exitCode = failure ? 1 : 0;
  console.log('Rail human flow ' + (failure ? 'failed' : 'passed') + '. Evidence: ' + out);
}
