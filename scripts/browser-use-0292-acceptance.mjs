// 0.29.2 browser-use 验收：① navigate settle（SPA fetch 完才渲染的页面，首次快照即渲染结果）
// ② ref 失效自动重绑定（重渲染替换节点后旧 ref 仍点中同一控件）。复用 0.29.1 验收脚本的引导模式。
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.tmp', 'browser-use-0292');
const engineUrl = new URL('../desktop/src/main/browser-use.mjs', import.meta.url);

if (!process.versions.electron) {
  const electron = (await import('../desktop/node_modules/electron/index.js')).default;
  const { ELECTRON_RUN_AS_NODE: _nodeMode, ...env } = process.env;
  await mkdir(evidence, { recursive: true });
  const bootstrap = path.join(evidence, 'bootstrap');
  await mkdir(bootstrap, { recursive: true });
  await writeFile(path.join(bootstrap, 'package.json'), '{"main":"main.cjs"}');
  await writeFile(path.join(bootstrap, 'main.cjs'), `
    void import(${JSON.stringify(import.meta.url)}).catch((error) => { console.error(error); require('electron').app.exit(1); });
  `);
  const result = spawnSync(electron, [bootstrap], { stdio: 'inherit', windowsHide: true, env, timeout: 120000 });
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
  let failures = 0;
  const check = (name, ok, detail = '') => { failures += ok ? 0 : 1; console.log((ok ? 'OK ' : 'FAIL ') + name + (detail ? ' — ' + String(detail).slice(0, 150) : '')); };
  try {
    server = createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/slow-page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        // shell 用 <p>（文本类标签，快照可见），避免夹具本身对 a11y 树不可见造成假失败
        res.end(`<!doctype html><html><body><p id="shell">正在加载…</p><script>
          fetch('/api/slow?d=800').then(function(r){return r.json();}).then(function(j){document.getElementById('shell').textContent = j.text;});
        </script></body></html>`);
      } else if (u.pathname === '/api/slow') {
        const d = Number(u.searchParams.get('d')) || 800;
        setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: 'slow-rendered-OK' })); }, d);
      } else if (u.pathname === '/rebind') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><button id="b" onclick="window.__clicks=(window.__clicks||0)+1">提交订单</button><script>
          window.replaceBtn = function(){ var old = document.getElementById('b'); var n = old.cloneNode(true); old.replaceWith(n); };
        </script></body></html>`);
      } else if (u.pathname === '/dup') {
        // 两个同签名按钮（同名/同属性/同祖先上下文）：重绑必须拒绝歧义，不静默绑第一个
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body>
          <button onclick="window.__clicks=(window.__clicks||0)+1">提交订单</button>
          <button onclick="window.__clicks=(window.__clicks||0)+1">提交订单</button>
        </body></html>`);
      } else { res.writeHead(404); res.end(); }
    }).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    console.log('[checkpoint] server up:', base);
    const browser = await import(engineUrl);
    console.log('[checkpoint] browser module loaded');

    // 场景 1：settle —— fetch(800ms) 完成后才渲染的页面，首次快照即渲染结果
    console.log('[checkpoint] navigating slow-page…');
    const nav = await browser.navigate(`${base}/slow-page`, { observe: true });
    console.log('[checkpoint] nav probe=', JSON.stringify(nav.snapshot?.probe), 'rebindDebug=', JSON.stringify(nav.snapshot?.rebindDebug));
    console.log('[checkpoint] navigate done, title=', nav.title);
    const navTree = nav.snapshot?.tree || '';
    check('settle: 首次快照即渲染结果（不等二次 snapshot）', navTree.includes('slow-rendered-OK') && !navTree.includes('正在加载'), navTree.slice(0, 120));

    // 场景 2：rebind —— 重渲染整体替换按钮节点后，旧 ref 仍点中同一控件
    await browser.navigate(`${base}/rebind`);
    const snap = await browser.snapshot({ maxNodes: 100 });
    const m = /- button\s+"提交订单"\s+\[ref=(e\S+)\]/.exec(snap.tree || '');
    check('rebind: snapshot 拿到按钮 ref', !!m, (snap.tree || '').slice(0, 150));
    const ref = m ? m[1] : null;
    console.log('[checkpoint] page=', await browser.evaluate('location.pathname'));
    console.log('[checkpoint] replaceBtn type=', await browser.evaluate('String(typeof window.replaceBtn)'));
    console.log('[checkpoint] reset clicks=', JSON.stringify(await browser.evaluate('window.__clicks = 0')));
    console.log('[checkpoint] old marker=', JSON.stringify(await browser.evaluate('document.getElementById("b").dataset.old = "yes"')));
    console.log('[checkpoint] replace=', JSON.stringify(await browser.evaluate('window.replaceBtn()')));
    const swapped = await browser.evaluate('String(document.querySelector("button").dataset.old || "new-node")');
    console.log('[checkpoint] swapped=', JSON.stringify(swapped));
    const click = await browser.click(ref);
    check('rebind: 旧 ref 点击成功（自动重绑）', click.ok === true, click.ok ? click.tag + '/' + click.text : click.error);
    const clicks = await browser.evaluate('String(window.__clicks)');
    check('rebind: 点击落在替换后的新节点上（__clicks=1）', clicks.result === '"1"', `__clicks=${clicks.result} 旧节点标记在=${swapped.result}`);

    // 场景 3：真正的失效（目标消失）仍然拒绝，不静默点错
    await browser.navigate(`${base}/rebind`);
    const snap2 = await browser.snapshot({ maxNodes: 100 });
    const m2 = /- button\s+"提交订单"\s+\[ref=(e\S+)\]/.exec(snap2.tree || '');
    await browser.evaluate('(document.getElementById("b").remove(), 1)');
    const click2 = await browser.click(m2 ? m2[1] : 'e-none');
    check('rebind: 控件真消失时仍报引用失效（fail-closed）', click2.ok === false && /失效/.test(click2.error || ''), click2.error || 'unexpected ok');

    // 场景 4：同签名重复控件 —— 重绑必须拒绝歧义（fail-closed），不静默绑第一个
    await browser.navigate(`${base}/dup`);
    const snapD = await browser.snapshot({ maxNodes: 100 });
    const refsD = [...(snapD.tree || '').matchAll(/- button\s+"提交订单"\s+\[ref=(e\S+)\]/g)];
    check('dup: 两个同签名按钮都能拿到 ref', refsD.length === 2, refsD.map((r) => r[1]).join(','));
    await browser.evaluate('window.__clicks = 0');
    await browser.evaluate('(function(){ var b = document.querySelectorAll("button")[1]; var n = b.cloneNode(true); b.replaceWith(n); })()');
    const clickD = await browser.click(refsD[1] ? refsD[1][1] : 'e-none');
    check('dup: 歧义重绑被拒绝（不静默绑第一个）', clickD.ok === false && /失效/.test(clickD.error || ''), clickD.error || 'unexpected ok');
  } catch (e) {
    failures++;
    console.error('ACCEPTANCE FAILED:', e?.stack || e);
  } finally {
    try { const browser = await import(engineUrl); await browser.close(); } catch { /* ignore */ }
    if (server) server.close();
    console.log(`\n=== 0.29.2 browser-use 验收 ${failures === 0 ? '全过' : failures + ' 项失败'} ===`);
    app.exit(failures === 0 ? 0 : 1);
  }
}
