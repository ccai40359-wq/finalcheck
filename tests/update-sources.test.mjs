import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SITE_HOST,
  SITE_RELEASE_URL,
  compareVersions,
  parseSiteRelease,
  pickBestSource,
  isBlockedHostname,
  resolveDownloadUrl
} from '../desktop/src/renderer/lib/update-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const updaterSrc = readFileSync(path.join(ROOT, 'desktop/src/main/ipc/ipc-updater.mjs'), 'utf8');
// 源码钉分两类：正向（必须有某段代码）用原文；反向（不许出现某写法）必须去注释后再匹配，
// 否则「不要在注释里写 latest.yml」这种说明文字会把自己判失败。
const updaterCode = updaterSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

const SHA = '686d66b4e7f520ed99c5f4dd305a8453105a267a4e3af6e52151e22b53eb4407'; // 64 位十六进制才合法

// 官网 /api/release 的真实形状（缩自实测返回）
const REAL_SITE_JSON = {
  source: 'github',
  latest: {
    version: '0.33.6',
    fileName: 'fc-setup-0.33.6.exe',
    size: 248939280,
    sha256: '686d66b4e7f520ed99c5f4dd305a8453105a267a4e3af6e52151e22b53eb4407',
    downloadUrl: '/api/download?file=fc-setup-0.33.6.exe',
    external: false,
    publishedAt: '2026-11-25T07:46:32Z',
    title: 'FinalCheck 0.33.6 — 界面打磨',
    resolvedLive: true
  },
  localLatest: { version: '0.33.6', fileName: 'fc-setup-0.33.6.exe', size: 248939280 },
  behind: 0,
  mirror: 'complete'
};

// ---------------- compareVersions ----------------

test('compareVersions：数字段按数值比，不是字符串比较', () => {
  // 字符串比较会认为 "0.33.10" < "0.33.9"，这正是要防的
  assert.equal(compareVersions('0.33.10', '0.33.9'), 1);
  assert.equal(compareVersions('0.33.9', '0.33.10'), -1);
  assert.equal(compareVersions('0.34.0', '0.33.99'), 1);
  assert.equal(compareVersions('0.33.99', '0.34.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('compareVersions：相等的各种写法都算相等', () => {
  assert.equal(compareVersions('0.33.6', '0.33.6'), 0);
  assert.equal(compareVersions('v0.33.6', '0.33.6'), 0);
  assert.equal(compareVersions('0.33.6', 'v0.33.6'), 0);
  assert.equal(compareVersions('V0.33.6', '0.33.6'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0, '缺段补 0');
  assert.equal(compareVersions('1.2.0.0', '1.2'), 0);
});

test('compareVersions：v 前缀不影响比较结果', () => {
  assert.equal(compareVersions('v0.34.0', 'v0.33.99'), 1);
  assert.equal(compareVersions('v0.33.9', '0.33.10'), -1);
});

test('compareVersions：预发布后缀低于同版本正式版，且后缀之间按 semver 比', () => {
  assert.equal(compareVersions('0.34.0-beta', '0.34.0'), -1);
  assert.equal(compareVersions('0.34.0', '0.34.0-beta'), 1);
  assert.equal(compareVersions('0.34.0-beta', '0.34.0-alpha'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0-beta'), 1, '段数多的更大');
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-beta.9'), 1);
  assert.equal(compareVersions('1.0.0-2', '1.0.0-10'), -1, '数字后缀按数值比');
});

test('compareVersions：构建元数据（+sha）不参与比较', () => {
  assert.equal(compareVersions('0.33.6+build.5', '0.33.6'), 0);
  assert.equal(compareVersions('0.33.7+build.1', '0.33.6+build.9'), 1);
});

test('compareVersions：脏输入不抛异常', () => {
  assert.equal(compareVersions('', ''), 0);
  assert.equal(compareVersions('abc', 'abc'), 0);
  assert.equal(compareVersions(null, undefined), 0);
  assert.equal(compareVersions(123, '123'), 0);
  assert.equal(compareVersions('0.33.x', '0.33.0'), 0, '非数字段当 0');
});

// ---------------- parseSiteRelease ----------------

test('parseSiteRelease：真实返回能抽出全部字段', () => {
  const r = parseSiteRelease(REAL_SITE_JSON);
  assert.equal(r.version, '0.33.6');
  assert.equal(r.fileName, 'fc-setup-0.33.6.exe');
  assert.equal(r.size, 248939280);
  assert.equal(r.sha256, '686d66b4e7f520ed99c5f4dd305a8453105a267a4e3af6e52151e22b53eb4407');
  assert.equal(r.downloadUrl, '/api/download?file=fc-setup-0.33.6.exe');
  assert.equal(r.title, 'FinalCheck 0.33.6 — 界面打磨');
  assert.equal(r.publishedAt, '2026-11-25T07:46:32Z');
});

test('parseSiteRelease：缺 latest 返回 null，不抛', () => {
  assert.equal(parseSiteRelease({ localLatest: { version: '0.33.6' } }), null);
  assert.equal(parseSiteRelease({ latest: null }), null);
  assert.equal(parseSiteRelease({ latest: undefined }), null);
});

test('parseSiteRelease：latest 里缺 version / version 不可用返回 null', () => {
  assert.equal(parseSiteRelease({ latest: { fileName: 'x.exe' } }), null);
  assert.equal(parseSiteRelease({ latest: { version: '' } }), null);
  assert.equal(parseSiteRelease({ latest: { version: '   ' } }), null);
  assert.equal(parseSiteRelease({ latest: { version: null } }), null);
  assert.equal(parseSiteRelease({ latest: { version: 336 } }), null, '数字版本号不接受');
  assert.equal(parseSiteRelease({ latest: { version: '{"v":"1.0.0"}' } }), null);
  assert.equal(parseSiteRelease({ latest: { version: 'abc' } }), null, '必须数字开头');
});

test('parseSiteRelease：整体是 null / 数组 / 字符串 / 数字都不抛', () => {
  for (const bad of [null, undefined, [], ['0.33.6'], 'json string', 42, true]) {
    assert.equal(parseSiteRelease(bad), null, `${String(bad)} 应返回 null`);
  }
});

test('parseSiteRelease：latest 是数组或字符串时返回 null', () => {
  assert.equal(parseSiteRelease({ latest: [{ version: '1.0.0' }] }), null);
  assert.equal(parseSiteRelease({ latest: '0.33.6' }), null);
});

test('parseSiteRelease：坏字段被丢弃，好字段保留', () => {
  const r = parseSiteRelease({
    latest: {
      version: 'v0.33.6',
      fileName: '../../etc/passwd',
      size: -1,
      sha256: 'not-a-hash',
      downloadUrl: 12345,
      publishedAt: 'yesterday'
    }
  });
  assert.equal(r.version, '0.33.6', 'v 前缀去掉');
  assert.equal(r.fileName, undefined, '带路径的文件名丢弃');
  assert.equal(r.size, undefined, '负数体积丢弃');
  assert.equal(r.sha256, undefined, '非 64 位十六进制丢弃');
  assert.equal(r.downloadUrl, undefined, '非字符串丢弃');
  assert.equal(r.publishedAt, undefined, '非 ISO 日期丢弃');
});

// ---------------- pickBestSource ----------------

test('pickBestSource：官网比当前新 → 选官网，并带绝对下载地址', () => {
  const site = parseSiteRelease(REAL_SITE_JSON);
  const r = pickBestSource({ site, github: '', currentVersion: '0.33.5' });
  assert.equal(r.source, 'site');
  assert.equal(r.version, '0.33.6');
  assert.equal(r.downloadUrl, `https://${SITE_HOST}/api/download?file=fc-setup-0.33.6.exe`);
  assert.equal(r.sha256, SHA);
  assert.equal(r.size, REAL_SITE_JSON.latest.size);
});

test('pickBestSource：官网落后于 GitHub → 选 GitHub', () => {
  const site = parseSiteRelease(REAL_SITE_JSON); // 官网 0.33.6
  const r = pickBestSource({ site, github: '0.34.0', currentVersion: '0.33.5' });
  assert.equal(r.source, 'github');
  assert.equal(r.version, '0.34.0');
  assert.equal(r.downloadUrl, undefined, 'GitHub 源不带官网下载地址');
});

test('pickBestSource：两边都不比当前新 → source null', () => {
  const site = parseSiteRelease(REAL_SITE_JSON);
  assert.deepEqual(pickBestSource({ site, github: '0.33.6', currentVersion: '0.33.6' }), { source: null });
  assert.deepEqual(pickBestSource({ site, github: '0.33.5', currentVersion: '0.33.6' }), { source: null });
  assert.deepEqual(pickBestSource({ site: null, github: '', currentVersion: '0.33.6' }), { source: null });
  assert.deepEqual(pickBestSource({ currentVersion: '0.33.6' }), { source: null });
});

test('pickBestSource：官网 null 而 GitHub 有更新 → 选 GitHub（官网探测失败的降级路径）', () => {
  const r = pickBestSource({ site: null, github: '0.33.7', currentVersion: '0.33.6' });
  assert.equal(r.source, 'github');
  assert.equal(r.version, '0.33.7');
});

test('pickBestSource：官网比当前新但 GitHub 更高 → 仍选 GitHub（不推旧包）', () => {
  const site = parseSiteRelease(REAL_SITE_JSON); // 0.33.6
  const r = pickBestSource({ site, github: '0.33.10', currentVersion: '0.33.9' });
  assert.equal(r.source, 'github', 'GitHub 版本更高');
  assert.equal(r.version, '0.33.10');
});

test('pickBestSource：两源版本相同且都比当前新 → 优先官网（国内下得动）', () => {
  const site = parseSiteRelease(REAL_SITE_JSON);
  const r = pickBestSource({ site, github: '0.33.6', currentVersion: '0.33.5' });
  assert.equal(r.source, 'site');
});

test('pickBestSource：当前版本缺失 → 不误报，source null', () => {
  const site = parseSiteRelease(REAL_SITE_JSON);
  assert.deepEqual(pickBestSource({ site, github: '0.33.6', currentVersion: '' }), { source: null });
  assert.deepEqual(pickBestSource({ site, github: '0.33.6', currentVersion: undefined }), { source: null });
  assert.deepEqual(pickBestSource({ site, github: '0.33.6', currentVersion: 'v' }), { source: null });
});

test('pickBestSource：github 传对象（updateInfo 形状）也能读出版本', () => {
  const site = parseSiteRelease(REAL_SITE_JSON);
  const r = pickBestSource({ site, github: { version: '0.34.0' }, currentVersion: '0.33.5' });
  assert.equal(r.source, 'github');
  assert.equal(r.version, '0.34.0');
});

test('pickBestSource：官网下载地址不是官网域名时被丢弃（不返回可下载 URL）', () => {
  const site = { version: '0.33.6', downloadUrl: 'https://evil.example.com/payload.exe' };
  const r = pickBestSource({ site, github: '', currentVersion: '0.33.5' });
  assert.equal(r.source, 'site');
  assert.equal(r.downloadUrl, undefined, '外部域名一律丢弃');
});

// ---------------- 地址安全 ----------------

test('isBlockedHostname：环回 / 私有 / 链路本地 / 保留地址一律拦', () => {
  const blocked = [
    'localhost', 'LOCALHOST', 'api.localhost',
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '0.1.2.3',
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1', '100.127.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    'metadata.google.internal', 'foo.internal', 'foo.local',
    ''
  ];
  for (const host of blocked) {
    assert.equal(isBlockedHostname(host), true, `${host || '(空)'} 应被拦`);
  }
});

test('isBlockedHostname：公网域名与公网 IP 放行', () => {
  for (const host of ['finalcheck.cncloud.uk', 'github.com', '8.8.8.8', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isBlockedHostname(host), false, `${host} 应放行`);
  }
});

test('isBlockedHostname：带方括号的 IPv6 与末尾点都能识别', () => {
  assert.equal(isBlockedHostname('[::1]'), true);
  assert.equal(isBlockedHostname('localhost.'), true);
});

test('resolveDownloadUrl：相对路径拼成官网绝对地址，其他主机 / 协议 / 带凭据一律拒绝', () => {
  assert.equal(
    resolveDownloadUrl('/api/download?file=fc-setup-0.33.6.exe'),
    `https://${SITE_HOST}/api/download?file=fc-setup-0.33.6.exe`
  );
  assert.equal(resolveDownloadUrl(''), '');
  assert.equal(resolveDownloadUrl(null), '');
  assert.equal(resolveDownloadUrl('javascript:alert(1)'), '');
  assert.equal(resolveDownloadUrl('file:///C:/Windows/System32/calc.exe'), '');
  assert.equal(resolveDownloadUrl('https://evil.example.com/x.exe'), '');
  assert.equal(resolveDownloadUrl('https://127.0.0.1/x.exe'), '');
  assert.equal(resolveDownloadUrl(`https://user:pass@${SITE_HOST}/x.exe`), '', '带凭据拒绝');
});

test('SITE_* 常量固定为官网 HTTPS 地址', () => {
  assert.equal(SITE_HOST, 'finalcheck.cncloud.uk');
  assert.equal(SITE_RELEASE_URL, 'https://finalcheck.cncloud.uk/api/release');
});

// ---------------- 源码钉：主进程必须真的这么接 ----------------

test('ipc-updater.mjs：调用官网 JSON 接口（而不是 /latest.yml）', () => {
  assert.match(updaterSrc, /import \{[^}]*SITE_RELEASE_URL[^}]*\} from '\.\.\/\.\.\/renderer\/lib\/update-sources\.mjs';/);
  assert.match(updaterSrc, /fetch\(url\.toString\(\), \{/, '必须对官网发起请求');
  // 反向检查走去掉注释后的代码：注释里提到 latest.yml 只是解释「为什么不能用」
  assert.ok(!/latest\.yml/.test(updaterCode), '不能把 electron-updater 指到官网的 latest.yml（它返回 HTML）');
  assert.ok(!/finalcheck\.cncloud\.uk\/latest/.test(updaterCode));
});

test('ipc-updater.mjs：官网探测有 8 秒超时', () => {
  assert.match(updaterSrc, /const SITE_PROBE_TIMEOUT_MS = 8 \* 1000;/);
  assert.match(updaterSrc, /signal: AbortSignal\.timeout\(SITE_PROBE_TIMEOUT_MS\)/);
});

test('ipc-updater.mjs：官网探测失败静默降级，不整体报错', () => {
  // probeSiteRelease 的 catch 必须返回 null（而不是抛）
  assert.match(updaterSrc, /async function probeSiteRelease\(\)[\s\S]*?catch \{\s*return null;\s*\}/);
  // 两个源都失败才返回 ok:false；只有一个失败时必须继续走 ok:true
  assert.match(updaterSrc, /if \(siteFailed && githubFailed\) \{/);
  assert.match(updaterSrc, /return \{ ok: true, currentVersion, source: answeredBy \};/);
});

test('ipc-updater.mjs：check 返回值保留 latestVersion 并新增 source/downloadUrl/sha256/size', () => {
  assert.match(updaterSrc, /latestVersion: best\.version/);
  assert.match(updaterSrc, /source: best\.source/);
  assert.match(updaterSrc, /payload\.downloadUrl = best\.downloadUrl/);
  assert.match(updaterSrc, /payload\.sha256 = best\.sha256/);
  assert.match(updaterSrc, /payload\.size = best\.size/);
  // 向后兼容：currentVersion 必须在每个成功分支里出现
  assert.match(updaterSrc, /ok: true,\s*\n\s*currentVersion,/);
});

test('ipc-updater.mjs：发请求前校验协议与主机（SSRF 兜底）', () => {
  assert.match(updaterSrc, /if \(url\.protocol !== 'https:' && url\.protocol !== 'http:'\) return null;/);
  assert.match(updaterSrc, /url\.hostname\.toLowerCase\(\) !== SITE_HOST/);
  assert.match(updaterSrc, /isBlockedHostname\(url\.hostname\)/);
});

test('ipc-updater.mjs：不碰 review 流水线里的下载/安装链路，也不硬编码凭据', () => {
  assert.match(updaterSrc, /au\.downloadUpdate\(\)/, '下载仍走 electron-updater');
  assert.match(updaterSrc, /au\.quitAndInstall\(false, true\)/, '安装仍走 electron-updater');
  assert.ok(!/api[_-]?key|apikey|token|secret|password/i.test(updaterSrc), '不允许出现任何凭据字段');
  assert.ok(!/Authorization/i.test(updaterSrc), '不允许带 Authorization 头');
});

test('ipc-updater.mjs：GitHub 错误先攒着，官网能答就不把红字推给界面', () => {
  assert.match(updaterSrc, /if \(deferGithubError\) \{ pendingGithubError = humanizeUpdaterError\(err\); return; \}/);
  assert.match(updaterSrc, /deferGithubError = false; \/\/ 无论如何都要恢复/, '必须用 finally 恢复，否则错误会被永久吞掉');
  assert.match(updaterSrc, /const message = pendingGithubError \|\| humanizeUpdaterError/);
});

test('ipc-updater.mjs：只有 GitHub 也认这个版本时补发 available（不造死按钮）', () => {
  assert.match(
    updaterSrc,
    /if \(githubResult\?\.ok && compareVersions\(best\.version, githubVersion\) === 0\) \{\s*\n\s*sendUpdateEvent\(\{ type: 'available', version: best\.version \}\);/,
    '官网发现、GitHub 没探到时不能推 available——按钮走 electron-updater，会点不动'
  );
});

test('check 处理器行为：官网可用且 GitHub 不可用时返回 source=site 且不推 available', async () => {
  const { registerUpdaterIpc } = await import('../desktop/src/main/ipc/ipc-updater.mjs');
  const realFetch = globalThis.fetch;
  const events = [];
  const handlers = new Map();
  // 伪造一个「没有新版本」的官网返回，避免测试依赖真实网络：用 fetch 打桩
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      latest: { version: '9.9.9', fileName: 'fc-setup-9.9.9.exe', size: 1024, sha256: SHA, downloadUrl: '/api/download?file=fc-setup-9.9.9.exe' }
    })
  });
  try {
    registerUpdaterIpc({
      ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
      // electron-updater 在测试环境里没装 → ensureUpdater 返回 null，正好模拟「GitHub 链路不可用」
      app: { isPackaged: true, getVersion: () => '1.0.0', getAppPath: () => process.cwd() },
      getWin: () => ({ isDestroyed: () => false, webContents: { send: (ch, ev) => events.push(ev) } })
    });
    const r = await handlers.get('finalcheck:update:check')();
    assert.equal(r.ok, true);
    assert.equal(r.source, 'site');
    assert.equal(r.latestVersion, '9.9.9');
    assert.equal(r.downloadUrl, `https://${SITE_HOST}/api/download?file=fc-setup-9.9.9.exe`);
    assert.equal(r.sha256, SHA);
    assert.equal(r.size, 1024);
    assert.equal(r.currentVersion, '1.0.0', '向后兼容字段必须保留');
    assert.deepEqual(events, [], 'GitHub 不可用时不能补发 available（否则是点不动的按钮）');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('check 处理器行为：两个源都拿不到结果时报错，且错误是人话（不透原始异常）', async () => {
  const { registerUpdaterIpc } = await import('../desktop/src/main/ipc/ipc-updater.mjs');
  const realFetch = globalThis.fetch;
  const handlers = new Map();
  globalThis.fetch = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  try {
    // electron-updater 在测试环境里没有 Electron 宿主，checkForUpdates 必然失败 → 两边都挂
    registerUpdaterIpc({
      ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
      app: { isPackaged: true, getVersion: () => '1.0.0', getAppPath: () => process.cwd() },
      getWin: () => null
    });
    const r = await handlers.get('finalcheck:update:check')();
    assert.equal(r.ok, false);
    assert.equal(r.currentVersion, '1.0.0', '失败分支也要保留向后兼容字段');
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
    // 文案必须是人类可读的那几句之一，不能把堆栈 / JSON / 原始 Error 名透给界面
    assert.ok(!/\{\s*"|Error:|TimeoutError|at .*\.mjs/.test(r.error), `错误文案泄漏了内部细节：${r.error}`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- 0.33.8：渲染层兜底不能被「GitHub 先推 not-available」挡住 ----
// 真实时序：GitHub 那条路先失败/先说没更新 → phase 已变成 not-available；
// 官网随后才返回更高版本。旧写法只在 phase === 'checking' 时才认，于是
// 官网的结论被丢掉，界面显示「已是最新」而其实有新版本。
test('SettingsPage 的 check 兜底：有 latestVersion 就无条件按 available 渲染', () => {
  const src = readFileSync(new URL('../desktop/src/renderer/pages/SettingsPage.jsx', import.meta.url), 'utf8');
  // 取出 checkUpdate 里处理 r.latestVersion 的那一段
  const start = src.indexOf('if (r?.latestVersion)');
  assert.ok(start > 0, '找不到处理 r.latestVersion 的分支');
  const seg = src.slice(start, start + 700);
  assert.ok(
    !/prev\.phase === 'checking' \? reduceUpdateEvent\(prev, \{ type: 'available'/.test(seg),
    '不能再要求 phase 必须是 checking 才认官网的结论（GitHub 会先把它改成 not-available）'
  );
  assert.match(seg, /reduceUpdateEvent\(prev, \{ type: 'available'/, '仍要用 reduceUpdateEvent 迁移状态');
  assert.match(seg, /already/, '要有幂等判断，避免同一版本反复迁移状态');
});

test('updater-state 的 available 事件会记录 latestVersion（界面靠它显示新版本号）', async () => {
  const { reduceUpdateEvent: reduceState, initialUpdateState: IDLE } = await import('../desktop/src/renderer/lib/updater-state.mjs');
  const s = reduceState(IDLE, { type: 'available', version: '9.9.9' });
  assert.equal(s.phase, 'available');
  assert.equal(s.latestVersion, '9.9.9');
  // 从 not-available 再收到 available 也能迁移（这正是 GitHub 先说话的场景）
  const n = reduceState(reduceState(IDLE, { type: 'not-available', version: '1.0.0' }), { type: 'available', version: '9.9.9' });
  assert.equal(n.phase, 'available');
  assert.equal(n.latestVersion, '9.9.9');
});
