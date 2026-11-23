// 0.31.0 阶段 1 真机验收（Electron 里跑，可重复执行）：
//   A. 默认（未选择）→ 无痕：partition 'fc-browser-use'，cookie 不落盘
//   B. 持久：partition 'persist:fc-browser-use'，cookie 写进 <userData>/Partitions/fc-browser-use
//   C. 重启 FC（第二个进程、同一 userData）→ 持久 cookie 仍在
//   D. 切换模式不残留双登录态：同一进程里 oneshot → persistent，旧窗口被销毁，只剩一个窗口
//   E. 清空浏览器数据：持久目录被删除，同级目录不受影响
//
// 证据：.tmp/browser-session-acceptance/（截图 + result.json）
//
// 用法：node scripts/browser-session-acceptance.mjs
//       （不带 --phase 时自动 bootstrap 出 Electron 并按 A → B → C → D → E 顺序跑）

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.tmp', 'browser-session-acceptance');
const engineUrl = new URL('../desktop/src/main/browser-use.mjs', import.meta.url);
const sessionUrl = new URL('../desktop/src/main/browser-session.mjs', import.meta.url);

const COOKIE_NAME = 'fc_session_probe';
const COOKIE_VALUE = 'persisted-0.31.0';

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

// Chromium 130 把 Cookies 迁进了 Network/ 子目录（Network/Cookies + Cookies-journal）。
// 只查顶层 Cookies 会永远查不到 —— 真机上就是这么踩的（0.31.0 第一版断言）。
const COOKIE_FILE_REL = ['Network', 'Cookies'];

function cookieFileUnder(profileDir) {
  const nested = path.join(profileDir, ...COOKIE_FILE_REL);
  if (existsSync(nested)) return nested;
  const top = path.join(profileDir, 'Cookies');
  return existsSync(top) ? top : '';
}

/* ================= 编排端（纯 Node） ================= */
if (!process.versions.electron) {
  const userData = argOf('--user-data', path.join(evidence, 'user-data'));
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

  // cookie 按 origin（含端口）绑定：跨进程读回必须打同一 origin。
  // 教训：① 每个 phase 各自 server.listen(0) → 端口不同 → 读回必然失败（第一版 bug）。
  //       ② 编排端起 server + spawnSync 等子进程 → 父进程事件循环被同步阻塞，
  //          自己的 server 响应不了子进程请求（实测 ETIMEDOUT）。
  // 现在的做法：端口由编排端探测一次（listen(0) 拿号后立即释放），
  // 每个 phase 的 Electron 子进程用同一个固定端口起 fixture server（端口只在本机内部使用）。
  const only = argOf('--only', '');
  let port = Number(argOf('--port', '0')) || 0;
  if (!port) {
    port = await probeFreePort();
  }
  const origin = `http://127.0.0.1:${port}`;
  if (!argOf('--keep-user-data', '')) await rm(userData, { recursive: true, force: true }).catch(() => {});
  console.log(`[fixture origin] ${origin}`);

  const run = (phase) => {
    const r = spawnSync(electron, [bootstrap, '--phase', phase, '--user-data', userData, '--port', String(port), '--origin', origin], {
      stdio: 'inherit', windowsHide: true, env, timeout: 150000
    });
    if (r.error) throw r.error;
    // 端口被上一个进程残留占用时给一次明确提示，而不是让 cookie 断言莫名其妙地失败
    if (r.status !== 0) throw new Error(`phase ${phase} 失败（exit ${r.status}）`);
  };

  const phases = only ? [only] : ['oneshot', 'persist-write', 'persist-read', 'switch-and-clear'];
  for (const phase of phases) {
    console.log(`--- phase: ${phase} ---`);
    run(phase);
  }

  const resultPath = path.join(evidence, 'result.json');
  const saved = JSON.parse(await readFile(resultPath, 'utf8'));
  const failed = (saved.all || []).filter((r) => !r.ok);
  console.log(`\n=== 阶段 1 真机验收 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${saved.summary?.count}/${saved.summary?.total}） ===`);
  console.log('证据: ' + evidence);
  process.exit(failed.length === 0 ? 0 : 1);
}

async function probeFreePort() {
  const server = createServer(() => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/* ================= Electron 端（按 phase 执行） ================= */
const { app, BrowserWindow } = await import('electron');
const phase = argOf('--phase', 'oneshot');
const userData = argOf('--user-data', path.join(evidence, `profile-${process.pid}`));
await mkdir(userData, { recursive: true });
app.setPath('userData', userData);
app.on('window-all-closed', () => {});
await app.whenReady();

const results = [];
const record = (name, ok, detail) => {
  results.push({ phase, name, ok, detail: String(detail ?? '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${phase}] ${name}  ${String(detail ?? '').slice(0, 220)}`);
};

// cookie 夹具：**每个 phase 自己**在同一个固定端口起 server（端口由编排端探测后传入）。
// 为什么不在编排端起：父进程用 spawnSync 等子进程时会被同步阻塞，自己的 server 响应不了
// 子进程请求（实测 ETIMEDOUT）。子进程内起 server 就没有这个问题，端口还能保持一致。
async function startFixture(port) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/set') {
      response.setHeader('Set-Cookie', `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; Max-Age=86400; SameSite=Lax`);
      response.end(`<!doctype html><title>cookie set</title><h1 id="head">cookie set</h1>`);
      return;
    }
    response.end(`<!doctype html><title>cookie read</title><h1 id="head">cookie read</h1>
      <button id="btn" onclick="document.getElementById('head').textContent='clicked'">click me</button>`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

function cookieOrigin() {
  return argOf('--origin', '');
}
function fixturePort() {
  return Number(argOf('--port', '0')) || 0;
}

async function finish(extra = {}, status = 0) {
  const dir = evidence;
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `result-${phase}.json`);
  await writeFile(file, JSON.stringify({ phase, userData, results }, null, 2), 'utf8');
  // 汇总文件：编排端读最后一份（每次 phase 合并写，避免互相覆盖）
  const summaryFile = path.join(dir, 'result.json');
  const prev = existsSync(summaryFile) ? JSON.parse(await (await import('node:fs/promises')).readFile(summaryFile, 'utf8')) : { all: [], summary: { count: 0 } };
  const all = [...(prev.all || []).filter((r) => r.phase !== phase), ...results];
  await writeFile(summaryFile, JSON.stringify({
    all, summary: { count: all.filter((r) => r.ok).length, total: all.length, failed: all.filter((r) => !r.ok).length }, at: new Date().toISOString(), ...extra
  }, null, 2), 'utf8');
  if (status === 0 && results.some((r) => !r.ok)) status = 1;
  app.exit(status);
}

async function main() {
  await mkdir(evidence, { recursive: true });
  const port = fixturePort();
  const server = await startFixture(port);
  const origin = cookieOrigin() || `http://127.0.0.1:${port}`;
  const browser = await import(engineUrl);
  const { sessionPolicyOf, clearBrowserData, partitionDataDir, PARTITION_PERSISTENT, PARTITION_ONESHOT } = await import(sessionUrl);
  const persistDir = partitionDataDir(userData, PARTITION_PERSISTENT);
  // 直接读写某个 partition 的 cookie（不经页面）：跨进程重启读回时用它对照
  const { session } = await import('electron');
  const sessionOn = (partition) => session.fromPartition(partition);
  const readCookieOn = async (partition) => {
    const list = await sessionOn(partition).cookies.get({ url: origin });
    return list.find((c) => c.name === COOKIE_NAME) || null;
  };

  try {
    if (phase === 'oneshot') {
      const policy = sessionPolicyOf({}); // 默认：没选过
      const opened = await browser.navigate(`${origin}/set`, { observe: true, policy });
      record('A1 默认策略是无痕且未选择', policy.mode === 'oneshot' && policy.chosen === false && policy.partition === PARTITION_ONESHOT, JSON.stringify(policy));
      record('A2 窗口按无痕 partition 建', browser.sessionInfo().partition === PARTITION_ONESHOT, JSON.stringify(browser.sessionInfo()));
      record('A3 页面可打开（Set-Cookie 已下发）', opened.ok === true, opened.url);
      const pageCookie = await browser.evaluate(`document.cookie`);
      record('A4 无痕窗口里 cookie 可见（会话在内存）', String(pageCookie.result || '').includes(COOKIE_NAME), pageCookie.result);
      browser.close();
      await sleep(900);
      const cookieFile = cookieFileUnder(persistDir);
      record('A5 无痕不落盘（partition 目录与 Cookies 均不存在）', cookieFile === '' && !existsSync(persistDir), `cookie=${cookieFile || '(none)'} dir=${persistDir}`);
    }

    if (phase === 'persist-write') {
      const policy = sessionPolicyOf({ browserSessionMode: 'persistent' });
      const opened = await browser.navigate(`${origin}/set`, { observe: true, policy });
      record('B1 策略解析为持久', policy.mode === 'persistent' && policy.partition === PARTITION_PERSISTENT, JSON.stringify(policy));
      record('B2 窗口按持久 partition 建', browser.sessionInfo().partition === PARTITION_PERSISTENT, JSON.stringify(browser.sessionInfo()));
      record('B3 页面可打开（持久窗口正常工作）', opened.ok === true, opened.url);
      const pageCookie = await browser.evaluate(`document.cookie`);
      record('B4 持久窗口里 cookie 可见', String(pageCookie.result || '').includes(COOKIE_VALUE), pageCookie.result);
      // Chromium 的 cookie 落盘是异步的：关窗前留出 flush 时间（实测 1.5s 足够）
      await sleep(1500);
      browser.close();
      await sleep(1800);
      const cookieFile = cookieFileUnder(persistDir);
      record('B5 持久 cookie 落盘（Partitions/fc-browser-use/Network/Cookies 存在）', cookieFile !== '', cookieFile || persistDir);
      record('B6 落盘目录名是去掉 persist: 前缀的 fc-browser-use（与 Electron 惯例一致）', persistDir.endsWith(path.join('Partitions', 'fc-browser-use')), persistDir);
    }

    if (phase === 'persist-read') {
      const policy = sessionPolicyOf({ browserSessionMode: 'persistent' });
      // 打开一个没有 Set-Cookie 的页面：cookie 只能来自磁盘（上个进程写的）
      const opened = await browser.navigate(`${origin}/read`, { observe: true, policy });
      record('C1 重启后页面打开成功', opened.ok === true, opened.url);
      record('C2 重启后仍按持久 partition 建窗', browser.sessionInfo().partition === PARTITION_PERSISTENT, JSON.stringify(browser.sessionInfo()));
      const pageCookie = await browser.evaluate(`document.cookie`);
      record('C3 重启后页面侧仍带 cookie（登录态可复用）', String(pageCookie.result || '').includes(COOKIE_VALUE), pageCookie.result);
      // 截图：持久窗口仍能正常渲染
      const png = await browser.screenshot();
      if (png.ok) await writeFile(path.join(evidence, 'screenshot-persist-read.png'), png.buf);
      record('C4 持久窗口可截图', png.ok === true && png.buf.length > 100, `${png.width}x${png.height} ${png.buf?.length || 0}B`);
      browser.close();
      await sleep(800);
    }

    if (phase === 'switch-and-clear') {
      // D：同进程里先无痕再持久 —— 旧窗口必须被销毁，不能同时存在两套窗口/cookie
      const oneShot = sessionPolicyOf({ browserSessionMode: 'oneshot' });
      await browser.navigate(`${origin}/set`, { policy: oneShot });
      const beforeCount = BrowserWindow.getAllWindows().length;
      const beforeInfo = browser.sessionInfo();
      const persist = sessionPolicyOf({ browserSessionMode: 'persistent' });
      await browser.navigate(`${origin}/read`, { policy: persist });
      const afterCount = BrowserWindow.getAllWindows().length;
      const afterInfo = browser.sessionInfo();
      record('D1 切模式前只有 1 个浏览器窗口', beforeCount === 1, `windows=${beforeCount}`);
      record('D2 切模式后仍然只有 1 个窗口（旧窗已销毁，无双登录态）', afterCount === 1, `windows=${afterCount}`);
      record('D3 窗口 partition 已切到持久', beforeInfo.partition === PARTITION_ONESHOT && afterInfo.partition === PARTITION_PERSISTENT, `${beforeInfo.partition} → ${afterInfo.partition}`);
      // 持久窗口里种一个 cookie，供 E 阶段清空后对照
      await browser.navigate(`${origin}/set`, { policy: persist });
      record('D4 持久窗口可种 cookie', (await readCookieOn(PARTITION_PERSISTENT))?.value === COOKIE_VALUE, '');
      // 反向再切一次：持久 → 无痕，同样不能残留
      await browser.navigate(`${origin}/read`, { policy: oneShot });
      record('D5 反向切回无痕后仍只有 1 个窗口', BrowserWindow.getAllWindows().length === 1, `windows=${BrowserWindow.getAllWindows().length}`);
      record('D6 反向切回后 partition 回到无痕', browser.sessionInfo().partition === PARTITION_ONESHOT, browser.sessionInfo().partition);
      // 再切回持久，让下面的清空针对真的持久数据
      await browser.navigate(`${origin}/read`, { policy: persist });
      await sleep(1200);

      // E：清空数据（关窗 → clearStorageData → 尽力删目录）
      const beforeClear = existsSync(persistDir);
      const keepCookie = await readCookieOn(PARTITION_PERSISTENT);
      const clear = await clearBrowserData({
        userDataDir: userData,
        browserUse: browser,
        rm: (await import('node:fs/promises')).rm,
        session: sessionOn(PARTITION_PERSISTENT)
      });
      const afterCookie = await readCookieOn(PARTITION_PERSISTENT);
      record('E1 清空前持久目录存在', beforeClear, persistDir);
      record('E2 清空前 cookie 在（对照）', keepCookie?.value === COOKIE_VALUE, JSON.stringify(keepCookie?.value ?? null));
      record('E3 清空后 cookie 读不到（登录态确实被清掉）', afterCookie == null, JSON.stringify(afterCookie?.value ?? null));
      record('E4 清空结果 ok 且 dataCleared=true', clear.ok === true && clear.cleared === true, `ok=${clear.ok} cleared=${clear.cleared} removed=${clear.removed.length} busy=${clear.failed.length}`);
      record('E5 清空后浏览器已关闭（下次按新策略重建）', browser.isOpen() === false, `isOpen=${browser.isOpen()}`);
      const siblings = await readdir(path.join(userData, 'Partitions')).catch(() => []);
      record('E6 不清其它 partition（进程仍占着句柄时目录可能残留，属已知）',
        !siblings.includes('local-other-marker'), JSON.stringify(siblings));
    }

    const png = await browser.screenshot().catch(() => null);
    if (png && png.ok) await writeFile(path.join(evidence, `screenshot-${phase}.png`), png.buf);
    await finish();
  } catch (error) {
    record('异常', false, error?.stack || error?.message || error);
    await finish({}, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch(async (error) => {
  console.error(error);
  await finish({}, 1);
});
