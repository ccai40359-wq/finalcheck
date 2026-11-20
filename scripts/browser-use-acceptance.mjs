import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.tmp', 'browser-use-acceptance');
const engineUrl = new URL('../desktop/src/main/browser-use.mjs', import.meta.url);

if (!process.versions.electron) {
  const electron = (await import('../desktop/node_modules/electron/index.js')).default;
  const { ELECTRON_RUN_AS_NODE: _nodeMode, ...env } = process.env;
  const bootstrap = path.join(evidence, 'bootstrap');
  await mkdir(bootstrap, { recursive: true });
  await writeFile(path.join(bootstrap, 'package.json'), '{"main":"main.cjs"}');
  await writeFile(path.join(bootstrap, 'main.cjs'), `
    void import(${JSON.stringify(import.meta.url)}).catch((error) => {
      console.error(error); require('electron').app.exit(1);
    });
  `);
  const result = spawnSync(electron, [bootstrap, ...process.argv.slice(2)], {
    stdio: 'inherit', windowsHide: true, env, timeout: 90000
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  const { app } = await import('electron');
  const profile = path.join(evidence, `profile-${process.pid}`);
  await mkdir(profile, { recursive: true });
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  let server;
  try {
    server = await startFixture();
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await import(engineUrl);
    await verifyBrowser(browser, url);
    const baselinePath = process.argv[process.argv.indexOf('--baseline') + 1];
    if (process.argv.includes('--baseline') && baselinePath) {
      const baseline = await import(pathToFileURL(path.resolve(baselinePath)));
      console.log('Browser workflow comparison:', JSON.stringify({
        baseline: await measureWorkflow(baseline, url),
        updated: await measureWorkflow(browser, url)
      }));
    }
    browser.close();
    console.log('Browser use acceptance passed.');
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    server?.close();
  }
}

async function startFixture() {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/next') {
      response.end('<title>Next document</title><h1>Next document</h1><button>Next action</button>');
      return;
    }
    if (request.url === '/delay') {
      void setTimeout(180).then(() => response.end(
        "<title>Delayed document</title><script>console.error('new delayed error')</script><h1>Delayed document</h1>"
      ));
      return;
    }
    response.end(`<!doctype html><html lang="en"><head><title>Browser controls fixture</title>
      <script>console.error('initial fixture error'); console.warn('initial fixture warning');</script>
      <style>
        body { font: 16px system-ui; color: #152236; margin: 26px; max-width: 900px; background: #f4f7fa; }
        main { background: white; padding: 18px 24px; border-radius: 12px; }
        main h1 { margin-top: 0; } label { margin-right: .5rem; }
        button, input, textarea { margin: 3px; padding: 5px 8px; }
        [contenteditable] { display: inline-block; min-width: 140px; border: 1px solid #7b8792; padding: 5px; }
        .blocked { position: relative; display: inline-block; }
        .overlay { position: absolute; inset: 0; z-index: 2; background: #ffc66b99; }
      </style></head><body><main><h1>Browser controls fixture</h1>
      <p>Reference identity, actionability, form entry and navigation.</p>
      <section id="actions">
        <button id="first" onclick="mark('first')">First action</button>
        <button data-target onclick="mark('original')">Original action</button>
        <button id="replace" onclick="mark('old')">Replaceable control</button>
        <button id="recycled" onclick="mark('older item')">Open older item</button>
        <div role="row" data-key="older"><button onclick="mark('row click')">Open row</button></div>
        <form action="/older"><button type="submit">Submit fixture</button></form>
        <button id="focus-replace" onclick="mark('focus original')">Replace on focus</button>
        <button id="change" onclick="reveal(this)">Reveal result</button>
        <output id="result" role="status"></output>
        <a href="/next">Go to next document</a>
      </section>
      <section><h2>Form controls</h2>
        <label for="email">Contact email</label><input id="email" type="email">
        <label for="notes">Special notes</label><textarea id="notes"></textarea>
        <div role="textbox" aria-label="Plain editor" contenteditable="true">empty</div>
        <input placeholder="Read only field" readonly><input placeholder="Focus changes this field" id="type-focus">
        <input placeholder="Numeric field" type="number"><input aria-label="Consent checkbox" type="checkbox">
        <fieldset disabled><button onclick="mark('disabled')">Disabled control</button></fieldset>
        <span class="blocked"><button onclick="mark('occluded')">Occluded control</button><span class="overlay"></span></span>
        <span class="blocked"><input id="covered-input" placeholder="Occluded text field"><span class="overlay"></span></span>
        <button role="button" aria-disabled="true" onclick="mark('aria disabled')">ARIA disabled control</button>
      </section>
      <section aria-label="Clutter">${'<p>Ordinary clutter text.</p>'.repeat(280)}</section>
      <button id="late" onclick="mark('late')">Late fixture action</button>
      <button onclick="mark('detached on scroll')" id="scroll-replace">Replace during scroll</button>
      </main><script>
        function mark(name) { (window.fixtureActions ||= []).push(name); }
        function reveal(button) {
          button.after(Object.assign(document.createElement('button'), {textContent: 'New result action'}));
          document.querySelector('#result').value = 'Fixture action confirmed';
        }
        document.querySelector('#email').addEventListener('input', (event) => mark('email ' + event.target.value));
        document.querySelector('#notes').addEventListener('change', (event) => mark('notes ' + event.target.value));
      </script></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function refOf(snapshot, name) {
  assert.equal(snapshot?.ok, true, JSON.stringify(snapshot));
  const line = snapshot.tree.split('\n').find((entry) => entry.includes(`"${name}"`));
  const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref, `Missing reference for ${name}. Snapshot is ${snapshot.tree.slice(0, 950)}`);
  return ref;
}

function expectOk(result) {
  assert.equal(result?.ok, true, JSON.stringify(result));
  return result;
}

async function verifyBrowser(browser, url) {
  const click = async (ref, options) => expectOk(await browser.click(ref, options));
  const type = async (ref, text) => expectOk(await browser.typeInto(ref, text));
  const evaluate = async (code) => JSON.parse(expectOk(await browser.evaluate(code)).result);
  const reject = (result, error) => {
    assert.equal(result?.ok, false, JSON.stringify(result));
    assert.match(result.error, error);
  };
  const opening = expectOk(await browser.navigate(url, { observe: true, width: 980, height: 720 }));
  assert.equal(opening.title, 'Browser controls fixture');
  const first = opening.snapshot;
  assert.equal(first.nodeCount, 220);
  assert.equal(first.truncated, true);
  assert.doesNotMatch(first.tree, /Late fixture action/);
  const early = expectOk(await browser.consoleMessages()).messages;
  assert.ok(early.some(({ level, text }) => level === 'error' && text === 'initial fixture error'), JSON.stringify(early));
  assert.ok(early.some(({ level, text }) => level === 'warning' && text === 'initial fixture warning'), JSON.stringify(early));

  const screenshot = expectOk(await browser.screenshot());
  const screenshotPath = path.join(evidence, 'controls.png');
  assert.equal(screenshot.mime, 'image/png');
  assert.ok(screenshot.width > 0 && screenshot.height > 0 && screenshot.buf.length > 1000);
  await writeFile(screenshotPath, screenshot.buf);
  console.log(`Browser fixture screenshot: ${screenshotPath}`);

  const original = refOf(first, 'Original action');
  const replaceable = refOf(first, 'Replaceable control');
  const firstRef = refOf(first, 'First action');
  await evaluate(`(() => {
    document.querySelector('[data-target]').before(Object.assign(document.createElement('button'), { textContent: 'Inserted sibling' }));
    window.__fcResolve = () => document.querySelector('#first');
    globalThis[Symbol.for('finalcheck.browser-use')] = { click: () => ({ ok: false }) };
    HTMLElement.prototype.click = () => mark('overridden prototype');
    return true;
  })()`);
  const focusedQuery = await browser.snapshot({ query: 'original action', maxNodes: 1, includeText: false });
  assert.equal(focusedQuery.nodeCount, 1);
  assert.equal(focusedQuery.truncated, false);
  assert.equal(refOf(focusedQuery, 'Original action'), original);
  await click(original);
  assert.deepEqual(await evaluate('window.fixtureActions'), ['original']);
  await evaluate(`(() => { const previous = document.querySelector('#replace');
    const newer = previous.cloneNode(true);
    newer.setAttribute('onclick', "mark('replacement')");
    previous.replaceWith(newer); return true; })()`);
  reject(await browser.click(replaceable), /引用已失效/);
  const replacement = refOf(await browser.snapshot({ query: 'Replaceable control' }), 'Replaceable control');
  assert.notEqual(replacement, replaceable);
  await click(replacement);
  await evaluate(`(() => { const button = document.querySelector('#first'); button.remove();
    document.querySelector('#actions').prepend(button); return true; })()`);
  reject(await browser.click(firstRef), /引用已失效/);
  assert.deepEqual(await evaluate('window.fixtureActions'), ['original', 'replacement']);

  const recycled = refOf(first, 'Open older item');
  await evaluate(`(() => { const button = document.querySelector('#recycled');
    button.textContent = 'Open newer item'; button.setAttribute('onclick', "mark('newer item')"); return true; })()`);
  const newItemSnapshot = await browser.snapshot({ query: 'Open newer item' });
  assert.notEqual(refOf(newItemSnapshot, 'Open newer item'), recycled);
  reject(await browser.click(recycled), /引用已失效/);
  const link = refOf(first, 'Go to next document');
  await evaluate("document.querySelector('a').setAttribute('href', '/wrong') === undefined");
  reject(await browser.click(link), /引用已失效/);
  const row = refOf(first, 'Open row');
  await evaluate("(document.querySelector('[role=row]').dataset.key = 'newer')");
  reject(await browser.click(row), /引用已失效/);
  const newRow = await browser.snapshot({ query: 'Open row' });
  assert.notEqual(refOf(newRow, 'Open row'), row);
  const form = refOf(first, 'Submit fixture');
  await evaluate("(document.querySelector('form').action = '/different')");
  reject(await browser.click(form), /引用已失效/);
  assert.deepEqual(await evaluate('window.fixtureActions'), ['original', 'replacement']);

  await evaluate(`(() => { const button = document.querySelector('#focus-replace');
    button.addEventListener('focus', () => queueMicrotask(() =>
      queueMicrotask(() => button.replaceWith(button.cloneNode(true)))));
    const input = document.querySelector('#type-focus');
    input.addEventListener('focus', () => queueMicrotask(() =>
      queueMicrotask(() => input.replaceWith(input.cloneNode(true)))));
    return true; })()`);
  reject(await browser.click(refOf(first, 'Replace on focus')), /引用已失效/);
  reject(await browser.typeInto(refOf(first, 'Focus changes this field'), 'forbidden'), /引用已失效/);
  assert.equal(await evaluate("document.querySelector('#type-focus').value"), '');
  reject(await browser.click(refOf(first, 'Disabled control')), /禁用/);
  reject(await browser.click(refOf(first, 'ARIA disabled control')), /禁用/);
  reject(await browser.click(refOf(first, 'Occluded control')), /遮挡/);
  reject(await browser.typeInto(refOf(first, 'Occluded text field'), 'forbidden'), /遮挡/);
  assert.equal(await evaluate("document.querySelector('#covered-input').value"), '');
  reject(await browser.typeInto(refOf(first, 'Read only field'), 'forbidden'), /只读/);
  reject(await browser.typeInto(refOf(first, 'Consent checkbox'), 'forbidden'), /不是可输入/);
  reject(await browser.typeInto(refOf(first, 'Numeric field'), 'not a number'), /数字字段/);

  await type(refOf(first, 'Contact email'), 'fixture@example.invalid');
  await type(refOf(first, 'Special notes'), 'Verified');
  await type(refOf(first, 'Plain editor'), 'Editable text');
  await type(refOf(first, 'Numeric field'), '42');
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#email, #notes, [contenteditable], input[type=number]'),
    (element) => element.isContentEditable ? element.textContent : element.value)`),
  ['fixture@example.invalid', 'Verified', 'Editable text', '42']);
  assert.deepEqual(await evaluate('window.fixtureActions'), ['original', 'replacement', 'email fixture@example.invalid', 'notes Verified']);

  const observedClick = await click(refOf(first, 'Reveal result'), { observe: true });
  refOf(observedClick.snapshot, 'New result action');
  assert.match(observedClick.snapshot.tree, /- status\n\s+Fixture action confirmed/);
  const confirmed = expectOk(await browser.screenshot());
  await writeFile(path.join(evidence, 'confirmed.png'), confirmed.buf);
  const late = await browser.snapshot({ query: 'LATE FIXTURE ACTION', maxNodes: 1 });
  assert.equal(late.nodeCount, 1);
  assert.equal(late.truncated, false);
  await click(refOf(late, 'Late fixture action'));
  assert.equal(await evaluate('window.fixtureActions.at(-1)'), 'late');
  await evaluate(`(() => { window.scrollTo(0, 0); return true; })()`);
  const onScroll = refOf(await browser.snapshot({ query: 'Replace during scroll' }), 'Replace during scroll');
  await evaluate(`(() => { const button = document.querySelector('#scroll-replace');
    addEventListener('scroll', () => { if (scrollY > 0) button.replaceWith(button.cloneNode(true)); }); return true; })()`);
  reject(await browser.click(onScroll), /引用已失效/);
  assert.equal(await evaluate('window.fixtureActions.at(-1)'), 'late');

  await evaluate(`(() => { for (let i = 0; i < 60; i++) console.log('fixture message ' + i); return true; })()`);
  const log = expectOk(await browser.consoleMessages()).messages;
  assert.equal(log.length, 50);
  assert.ok(log.some(({ text }) => text === 'initial fixture error'));
  assert.ok(log.some(({ text }) => text === 'initial fixture warning'));
  assert.ok(!log.some(({ text }) => text === 'fixture message 0'));
  assert.equal(log[49].text, 'fixture message 59');

  const restarted = expectOk(await browser.navigate(url, { observe: true }));
  const restartedOriginal = refOf(restarted.snapshot, 'Original action');
  assert.notEqual(original, restartedOriginal);
  reject(await browser.click(original), /引用已失效/);
  reject(await browser.typeInto(refOf(first, 'Contact email'), 'wrong document'), /引用已失效/);
  assert.ok(expectOk(await browser.consoleMessages()).messages.some(({ text }) => text === 'initial fixture error'));
  assert.ok(!expectOk(await browser.consoleMessages()).messages.some(({ text }) => text === 'fixture message 59'));
  const next = await click(refOf(restarted.snapshot, 'Go to next document'), { observe: true });
  assert.equal(next.snapshot.url, `${url}/next`, JSON.stringify(next));
  refOf(next.snapshot, 'Next action');
  reject(await browser.click(restartedOriginal), /引用已失效/);

  const navigationStart = performance.now();
  const explicitWait = expectOk(await browser.navigate(url, { waitMs: 90 }));
  assert.ok(performance.now() - navigationStart >= 85);
  assert.equal(explicitWait.snapshot, undefined);
  await evaluate("(() => { setTimeout(() => console.error('old document during navigation'), 40); return true; })()");
  const delayed = expectOk(await browser.navigate(`${url}/delay`, { observe: true }));
  assert.equal(delayed.title, 'Delayed document');
  assert.equal(delayed.snapshot.url, delayed.url);
  const delayedLogs = expectOk(await browser.consoleMessages()).messages;
  assert.ok(delayedLogs.some(({ text }) => text === 'new delayed error'), JSON.stringify(delayedLogs));
  assert.ok(!delayedLogs.some(({ text }) => text === 'old document during navigation'), JSON.stringify(delayedLogs));

  const interrupted = browser.navigate(`${url}/delay`, { observe: true });
  await setTimeout(30);
  const winner = expectOk(await browser.navigate(url, { observe: true }));
  reject(await interrupted, /页面正在导航/);
  assert.equal(winner.url, winner.snapshot.url);
  browser.close();
  reject(await browser.click(original), /浏览器还没打开/);
  const reopened = expectOk(await browser.navigate(url, { observe: true }));
  assert.notEqual(refOf(reopened.snapshot, 'Original action'), restartedOriginal);
  reject(await browser.click(restartedOriginal), /引用已失效/);
  const localFile = path.join(evidence, 'local-fixture.html');
  await writeFile(localFile, '<title>Local fixture</title><button>Local action</button>');
  const local = expectOk(await browser.navigate(localFile, { observe: true }));
  assert.equal(local.url, pathToFileURL(localFile).href);
  refOf(local.snapshot, 'Local action');
  await assert.rejects(browser.navigate('data:text/html,<h1>Unsupported URL</h1>'), /只允许/);
  browser.close();
}

async function measureWorkflow(browser, url) {
  await browser.navigate(url, { waitMs: 0 });
  const timingsMs = [];
  let reportedCalls = 0;
  for (let index = 0; index < 5; index++) {
    const started = performance.now();
    let calls = 1;
    const opened = expectOk(await browser.navigate(url, { observe: true }));
    let snapshot = opened.snapshot;
    if (!snapshot) {
      await browser.installConsoleHook();
      snapshot = expectOk(await browser.snapshot());
      calls++;
    }
    const clicked = expectOk(await browser.click(refOf(snapshot, 'Reveal result'), { observe: true }));
    calls++;
    if (!clicked.snapshot) {
      expectOk(await browser.snapshot());
      calls++;
    }
    timingsMs.push(Math.round(performance.now() - started));
    reportedCalls = calls;
  }
  browser.close();
  const median = timingsMs.slice().sort((left, right) => left - right)[2];
  return { calls: reportedCalls, timingsMs, medianMs: median };
}
