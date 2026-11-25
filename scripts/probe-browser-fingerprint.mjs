// 0.33.5 内置浏览器指纹验收（真 Electron，隔离 profile，窗口在后台不抢前台）：
// 本地起一个站点，把「服务端看到的请求头」和「页面 JS 看到的 navigator」都记下来，逐项断言：
//   UA 是 Edge、不含 Electron/FinalCheck；Sec-CH-UA 品牌有 Microsoft Edge；平台 Windows；
//   navigator.userAgentData / getHighEntropyValues 同样是 Edge；navigator.plugins 非空；webdriver=false；
//   三处版本号一致（UA / Sec-CH-UA / fullVersionList 都跟内核走）。
// 用法：cd desktop && npx electron-vite build；然后 node scripts/probe-browser-fingerprint.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'browser-fingerprint-check');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const PORT = 9363;

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'ui-model' }], enabled: true }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark', permissionMode: 'ask'
}, null, 2), 'utf8');

const seen = { headers: null, js: null, reportHeaders: null };
const site = createServer((req, res) => {
  const u = req.url || '/';
  if (u === '/fp') {
    seen.headers = { ...req.headers };
    // 让浏览器在后续请求里也发高熵提示（真站点常这么做）
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness' });
    return res.end(`<title>FP</title><script>
      (async () => {
        const d = navigator.userAgentData;
        let hi = null;
        try { hi = d ? await d.getHighEntropyValues(['fullVersionList','platformVersion','architecture','bitness','uaFullVersion']) : null; } catch (e) { hi = { error: String(e) }; }
        const js = { ua: navigator.userAgent, brands: d ? d.brands : null, platform: d ? d.platform : null, mobile: d ? d.mobile : null, hi,
          plugins: navigator.plugins.length, pdf: navigator.pdfViewerEnabled, webdriver: navigator.webdriver, languages: navigator.languages,
          vendor: navigator.vendor, hasProcess: typeof window.process !== 'undefined', hasRequire: typeof window.require !== 'undefined' };
        await fetch('/report', { method: 'POST', body: JSON.stringify(js) });
        document.title = 'FP done';
      })();
    </script>`);
  }
  if (u === '/report' && req.method === 'POST') {
    seen.reportHeaders = { ...req.headers };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { seen.js = JSON.parse(body); } catch { seen.js = { raw: body }; } res.writeHead(204); res.end(); });
    return undefined;
  }
  res.writeHead(404); return res.end('nf');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'], {
  env: {
    ...env, FINALCHECK_UI_SELFCHECK: '1', FINALCHECK_WINDOW_BG: '1',
    FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
    FINALCHECK_HOOKS_FILE: path.join(userData, 'hooks.json'),
    FINALCHECK_DEFAULT_PROJECT: projectDir
  },
  stdio: 'ignore', windowsHide: true
});

let ws = null; let seq = 0;
const pending = new Map();
const cdp = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + m)); } }, 60000);
});
const ev = async (x) => {
  const r = await cdp('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r?.result?.value;
};
const results = [];
const record = (n, ok, d) => { results.push({ n, ok, d: String(d ?? '').slice(0, 600) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${String(d ?? '').slice(0, 300)}`); };

try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((tg) => tg.type === 'page' && !String(tg.url || '').startsWith('devtools') && !String(tg.url || '').startsWith('http://127.0.0.1'));
    } catch { /* 等 */ }
  }
  if (!page) throw new Error('CDP 没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); setTimeout(() => j(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const g = JSON.parse(m.data); if (!g.id || !pending.has(g.id)) return; const p = pending.get(g.id); pending.delete(g.id); if (g.error) p.rej(new Error(JSON.stringify(g.error))); else p.res(g.result); };
  await cdp('Runtime.enable');
  await sleep(3400);
  const opened = await ev(`(async () => { const r = await window.finalcheck.browserTabOpen('${SITE}/fp'); return { ok: r?.ok !== false, id: r?.id || null, err: r?.error || null }; })()`);
  for (let i = 0; i < 40 && !seen.js; i++) await sleep(250);
  record('F0 打开测试页', opened?.ok === true && !!seen.headers && !!seen.js, JSON.stringify(opened));
  const h = seen.headers || {};
  const js = seen.js || {};
  const ua = String(h['user-agent'] || '');
  const major = (ua.match(/Edg\/(\d+)/) || [])[1];
  record('F1 请求头 UA 是 Edge，且不含 Electron / FinalCheck', /Edg\/\d+/.test(ua) && !/Electron|FinalCheck/i.test(ua), ua);
  record('F2 Sec-CH-UA 品牌含 Microsoft Edge（版本与 UA 一致）', new RegExp(`"Microsoft Edge";v="${major}"`).test(String(h['sec-ch-ua'] || '')), h['sec-ch-ua']);
  record('F3 Sec-CH-UA-Platform = Windows', String(h['sec-ch-ua-platform'] || '') === '"Windows"', h['sec-ch-ua-platform']);
  record('F4 Accept-Language 是正常浏览器格式（q 值不重复）', /^[a-z]{2}(-[A-Z]{2})?,/.test(String(h['accept-language'] || '')) && !/;q=[\d.]+;q=/.test(String(h['accept-language'] || '')), h['accept-language']);
  record('F5 页面里 navigator.userAgent 也是 Edge', /Edg\/\d+/.test(String(js.ua || '')) && !/Electron|FinalCheck/i.test(String(js.ua || '')), js.ua);
  record('F6 navigator.userAgentData.brands 含 Microsoft Edge', Array.isArray(js.brands) && js.brands.some((b) => b.brand === 'Microsoft Edge' && b.version === major), JSON.stringify(js.brands));
  const fvl = js.hi?.fullVersionList || [];
  record('F7 高熵 fullVersionList 含 Microsoft Edge 完整版本', fvl.some((b) => b.brand === 'Microsoft Edge' && String(b.version).startsWith(`${major}.`)), JSON.stringify(js.hi));
  record('F8 navigator.plugins 非空（PDF 查看器）', Number(js.plugins) > 0 && js.pdf === true, JSON.stringify({ plugins: js.plugins, pdf: js.pdf }));
  record('F9 webdriver=false、页面里没有 Node（process/require）', js.webdriver === false && !js.hasProcess && !js.hasRequire, JSON.stringify({ webdriver: js.webdriver, process: js.hasProcess, require: js.hasRequire }));
  record('F10 vendor = Google Inc.（Chromium 系浏览器都是这个）', js.vendor === 'Google Inc.', js.vendor);
  const rh = seen.reportHeaders || {};
  record('F11 站点要了 Accept-CH 后，后续请求带高熵提示（完整版本 / 系统版本）', /"Microsoft Edge";v="\d+\.\d+\.\d+\.\d+"/.test(String(rh['sec-ch-ua-full-version-list'] || '')) && /^"\d+\.\d+\.\d+"$/.test(String(rh['sec-ch-ua-platform-version'] || '')), JSON.stringify({ fvl: rh['sec-ch-ua-full-version-list'], pv: rh['sec-ch-ua-platform-version'], arch: rh['sec-ch-ua-arch'] }));
  await writeFile(path.join(out, 'result.json'), JSON.stringify({ results, headers: seen.headers, reportHeaders: seen.reportHeaders, js: seen.js }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 内置浏览器指纹验收 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { site.close(); } catch { /* 已关 */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
