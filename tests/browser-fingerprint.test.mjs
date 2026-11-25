// 0.33.5 内置浏览器指纹对齐 Edge（真 Electron 验收见 scripts/probe-browser-fingerprint.mjs，12/12）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  edgeIdentity, windowsPlatformVersion, acceptLanguageFor, brandHeader, isSecureForHints, clientHintHeaders, parseAcceptCh
} from '../desktop/src/main/browser-fingerprint.mjs';

test('Edge 身份：UA / 品牌 / 完整版本三处一致，跟内核版本走；不含 Electron', () => {
  const id = edgeIdentity({ chromeVersion: '130.0.6723.191', osRelease: '10.0.22631', arch: 'x64', locale: 'zh-CN' });
  assert.equal(id.userAgent, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0');
  assert.doesNotMatch(id.userAgent, /Electron|FinalCheck/);
  assert.deepEqual(id.metadata.brands.map((b) => b.brand), ['Microsoft Edge', 'Not?A_Brand', 'Chromium']);
  assert.ok(id.metadata.brands.every((b) => b.brand === 'Not?A_Brand' || b.version === '130'));
  assert.equal(id.metadata.fullVersionList[0].version, '130.0.6723.191');
  assert.equal(id.metadata.platformVersion, '15.0.0');
  assert.equal(id.metadata.architecture, 'x86');
  assert.equal(id.metadata.bitness, '64');
  assert.equal(id.acceptLanguage, 'zh-CN,zh,en,en-US', '不自己写 q 值（Chromium 会补）');
  // 版本号不合法时退回 130，不崩
  assert.match(edgeIdentity({ chromeVersion: 'weird' }).userAgent, /Edg\/130\.0\.0\.0/);
});

test('Windows 版本 / 语言 / 品牌头写法', () => {
  assert.equal(windowsPlatformVersion('10.0.19045'), '10.0.0');
  assert.equal(windowsPlatformVersion('10.0.22000'), '14.0.0');
  assert.equal(windowsPlatformVersion('10.0.26100'), '15.0.0');
  assert.equal(acceptLanguageFor('en-US'), 'en-US,en');
  assert.equal(brandHeader([{ brand: 'Microsoft Edge', version: '130' }, { brand: 'Chromium', version: '130' }]), '"Microsoft Edge";v="130", "Chromium";v="130"');
});

test('Client Hints 请求头：安全来源带低熵三项；Accept-CH 要过才带高熵；http 外网不带', () => {
  const id = edgeIdentity({ chromeVersion: '130.0.6723.191', osRelease: '10.0.22631', arch: 'x64', locale: 'zh-CN' });
  assert.ok(isSecureForHints('https://www.reddit.com/login'));
  assert.ok(isSecureForHints('http://127.0.0.1:5173/'));
  assert.ok(isSecureForHints('http://localhost:3000/'));
  assert.equal(isSecureForHints('http://example.com/'), false);
  assert.deepEqual(clientHintHeaders(id, 'http://example.com/'), {});
  const low = clientHintHeaders(id, 'https://www.reddit.com/');
  assert.deepEqual(Object.keys(low).sort(), ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
  assert.match(low['sec-ch-ua'], /"Microsoft Edge";v="130"/);
  assert.equal(low['sec-ch-ua-platform'], '"Windows"');
  const want = parseAcceptCh('Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Viewport-Width');
  assert.deepEqual([...want].sort(), ['sec-ch-ua-full-version-list', 'sec-ch-ua-platform-version']);
  const hi = clientHintHeaders(id, 'https://accounts.example.com/', want);
  assert.match(hi['sec-ch-ua-full-version-list'], /"Microsoft Edge";v="130\.0\.6723\.191"/);
  assert.equal(hi['sec-ch-ua-platform-version'], '"15.0.0"');
  assert.equal(hi['sec-ch-ua-arch'], undefined, '没要的不带');
});

test('接线：内嵌标签与离屏窗口都套 Edge 身份；Client Hints 在首个请求前设好；开 PDF 插件', () => {
  const host = readFileSync(new URL('../desktop/src/main/browser-view-host.mjs', import.meta.url), 'utf8');
  assert.match(host, /applyEdgeIdentityToSession\(view\.webContents\.session\)/);
  const at = host.indexOf('await applyEdgeIdentityToContents(wc)'); // 前面有 if (wc.debugger)
  assert.ok(at > 0 && at < host.indexOf('await wc.loadURL(url)'), '必须在首个 loadURL 之前');
  assert.match(host, /plugins: true/);
  const use = readFileSync(new URL('../desktop/src/main/browser-use.mjs', import.meta.url), 'utf8');
  assert.match(use, /applyEdgeIdentityToSession\(window\.webContents\.session\)/);
});

test('0.33.5 搜索后端 serper（谷歌结果）：带 X-API-KEY；答案框排最前；没 key 回退必应', async () => {
  const { webSearch, searchOrder, SEARCH_PROVIDERS } = await import('../desktop/src/main/web-tools.mjs');
  assert.ok(SEARCH_PROVIDERS.includes('serper'));
  assert.deepEqual(searchOrder({ provider: 'serper' }), ['serper', 'bing']);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({
      answerBox: { title: 'Electron', answer: 'Electron 39 ships Chromium 142', link: 'https://www.electronjs.org/' },
      organic: [{ title: 'Electron Releases', link: 'https://releases.electronjs.org/', snippet: 'All releases', date: '2026-11-01' }]
    }) };
  };
  const r = await webSearch({ query: 'electron chromium version', cfg: { provider: 'serper', apiKey: 'k-test' }, fetchImpl });
  assert.equal(r.engine, 'serper');
  assert.equal(calls[0].url, 'https://google.serper.dev/search');
  assert.equal(calls[0].init.headers['X-API-KEY'], 'k-test');
  assert.equal(JSON.parse(calls[0].init.body).q, 'electron chromium version');
  assert.equal(r.results[0].url, 'https://www.electronjs.org/');
  assert.equal(r.results[1].date, '2026-11-01');
});
