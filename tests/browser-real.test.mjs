// 0.31.0 阶段 2：CDP 真 Edge 通道的纯逻辑 + 源码钉。
//
// 真连 Edge 的部分（连上/点击/截图/断开后存活）由 scripts/browser-real-acceptance.mjs 在真机上跑；
// 这里验证「不需要浏览器就能确定的事」：端口纪律、判据表泛化、断开不杀、ref 语义、工具层 shape。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_CDP_PORT, CDP_HEADER, PLATFORM_PLAYBOOKS, PLAYBOOK_PLATFORMS,
  judgeLoginState, edgeArgs, profileDir, resolveEdgePath, realIsConnected, realInfo,
  disconnectReal, navigateReal
} from '../desktop/src/main/browser-real.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { AGENT_TOOLS_SCHEMA } from '../desktop/src/main/agent-service.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const readSrc = (rel) => readFileSync(path.join(repoRoot, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');
const realSrc = readSrc('desktop/src/main/browser-real.mjs');
const toolsSrc = readSrc('desktop/src/main/agent-tools.mjs');
const serviceSrc = readSrc('desktop/src/main/agent-service.mjs');
const ipcSrc = readSrc('desktop/src/main/ipc/ipc-agent.mjs');
const pkg = JSON.parse(readSrc('package.json'));

/* ---------------- 端口纪律（红线） ---------------- */

test('browser-real: 默认端口 9224，且明确拒绝 9223（datacrawler 的端口）', async () => {
  assert.equal(DEFAULT_CDP_PORT, 9224, 'FC 必须用 9224，绝不能和 datacrawler 抢 9223');
  assert.match(realSrc, /p === 9223/, '启动/连接路径必须有 9223 的硬拒绝');
  // 两次拒绝：connectReal 与 startIsolatedEdge 各一处，缺一处就有绕过去的可能
  const rejects = (realSrc.match(/拒绝使用 9223/g) || []).length;
  assert.equal(rejects, 2, `9223 的硬拒绝应有两处（connectReal / startIsolatedEdge），实际 ${rejects}`);
});

test('browser-real: CDP header 用 finalcheck 自己的标识（不冒充其它产品）', () => {
  assert.equal(CDP_HEADER, 'finalcheck');
  assert.match(realSrc, /headers: \{ 'User-Agent': CDP_HEADER \}/);
  // 红线只看「实际发送的代码/字符串」，注释里提到参照仓库是允许的（那只是出处说明）
  const codeOnly = realSrc.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.doesNotMatch(codeOnly, /ai-crawler-hk/i, '不要在实际代码里沿用参照实现的私有标识');
  assert.doesNotMatch(codeOnly, /'User-Agent':\s*'[^']*'/, 'UA header 必须来自 CDP_HEADER 常量，不能写字面量');
  assert.doesNotMatch(codeOnly, /Chrome\/1\d\d\.0\.0\.0 Safari/, '不要伪造浏览器 UA');
});

/* ---------------- 依赖纪律 ---------------- */

test('依赖: 只引 playwright-core（不引 playwright 完整包）', () => {
  assert.match(realSrc, /from 'playwright-core'/, '真 Edge 通道必须只引 playwright-core');
  assert.doesNotMatch(realSrc, /from 'playwright'/);
  assert.ok(pkg.dependencies['playwright-core'], '根 package.json 的 dependencies 必须声明 playwright-core（打包时随 resources/node_modules 走）');
  assert.equal(pkg.dependencies.playwright, undefined, '不得引入 playwright 完整包');
});

/* ---------------- 登录态判据表（不写死平台） ---------------- */

test('browser-real: 判据表有三类证据，judgeLoginState 只按证据判（不认平台名）', () => {
  assert.deepEqual(judgeLoginState({ avatar: true, wall: false }), { state: 'signed-in', detail: 'logged-in marker on page' });
  assert.deepEqual(judgeLoginState({ avatar: false, wall: true }), { state: 'signed-out', detail: 'login wall on page' });
  assert.deepEqual(judgeLoginState({ avatar: false, wall: false }), { state: 'unknown', detail: 'no login marker either way' });
  // 两种证据同时出现（同一页既有头像又有登录墙）→ unknown，不猜
  assert.equal(judgeLoginState({ avatar: true, wall: true }).state, 'unknown');
  assert.equal(judgeLoginState(null).state, 'unknown');
  assert.equal(judgeLoginState({}).state, 'unknown');
});

test('browser-real: 平台专属文案只在判据表里，通用引擎不认识任何平台名', () => {
  assert.ok(PLAYBOOK_PLATFORMS.length >= 3);
  for (const key of PLAYBOOK_PLATFORMS) {
    const book = PLATFORM_PLAYBOOKS[key];
    assert.ok(book.home.startsWith('https://'), `${key} 必须有 home`);
    assert.ok(book.wall instanceof RegExp, `${key} 必须有 wall 判据`);
    assert.ok(typeof book.avatar === 'string' && book.avatar.length > 0, `${key} 必须有 avatar 选择器`);
  }
  // 引擎主体（judgeLoginState 及其调用处）不得出现平台专属词
  const judgeSection = realSrc.slice(realSrc.indexOf('export function judgeLoginState'), realSrc.indexOf('export async function probeLoginState'));
  for (const word of ['小红书', 'xiaohongshu', 'threads', 'Threads', 'douyin', '抖音']) {
    assert.ok(!judgeSection.includes(word), `通用判定里混进了平台专属词：${word}`);
  }
});

test('browser-real: probeLoginState 未知平台明确报错（不瞎猜首页）', async () => {
  await assert.rejects(
    () => import('../desktop/src/main/browser-real.mjs').then((m) => m.probeLoginState({ platform: 'myspace' })),
    /未支持的平台|myspace/
  );
});

/* ---------------- 断开不杀浏览器（红线） ---------------- */

test('browser-real: disconnect 只做 transport 断开（不杀 Edge 进程）', () => {
  // disconnectReal 走 disconnect()，只调 browser.close()（playwright 语义=断 CDP transport）
  const disc = realSrc.slice(realSrc.indexOf('export async function disconnect(browser)'), realSrc.indexOf('export async function closeRealEdge(browser)'));
  assert.match(disc, /await browser\.close\(\)/, 'disconnect 只做 transport 断开');
  assert.doesNotMatch(disc, /taskkill|spawn|kill/i, '断开路径不得调用 taskkill / spawn kill');
  // 关闭进程是显式动作（Browser.close 命令），只在 closeRealEdge 里出现
  const closing = realSrc.slice(
    realSrc.indexOf('export async function closeRealEdge(browser)'),
    realSrc.indexOf('// ---- 登录态判据表')
  );
  assert.match(closing, /Browser\.close/, '彻底关闭走 CDP 的 Browser.close 命令');
  assert.match(toolsSrc, /close_browser === true/, 'tool 层必须用 close_browser 显式区分');
});

test('browser-real: 未连接时的工具调用给出可执行的错误（不是崩）', async () => {
  assert.equal(realIsConnected(), false, '纯 Node 环境默认未连接');
  const info = realInfo();
  assert.equal(info.connected, false);
  assert.equal(info.port, 9224);
  assert.deepEqual(await disconnectReal(), { ok: true, connected: false, note: '本来就没连' }, '未连接时断开必须幂等');
  await assert.rejects(() => navigateReal('https://example.com/'), /未连接|browser_connect_real/);
});

/* ---------------- 隔离 profile / 启动参数 ---------------- */

test('browser-real: profile 在 userData 下的独立目录（不碰用户日常 Edge）', () => {
  const dir = profileDir('C:/ud');
  assert.ok(dir.endsWith(path.join('ud', 'edge-profile')), dir);
  assert.throws(() => profileDir(''), /userData/);
  // 启动参数抄已验证配方
  const args = edgeArgs({ port: 9224, profile: 'C:/ud/edge-profile', urls: ['https://example.com'] });
  assert.ok(args.includes('--remote-debugging-port=9224'));
  assert.ok(args.includes('--user-data-dir=C:/ud/edge-profile'));
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.some((a) => a.startsWith('--disable-features=')), '必须禁掉 msImplicitSignin 等（否则会弹同步弹窗拦点击）');
  assert.ok(args.includes('https://example.com'));
  assert.equal(args[args.length - 1], 'https://example.com', 'urls 放在最后');
});

test('browser-real: resolveEdgePath 在本机能找到 Edge（找不到时给明确错误）', () => {
  let p = '';
  try { p = resolveEdgePath(); } catch (e) { assert.match(String(e.message), /msedge\.exe 未找到/); }
  if (p) assert.match(p, /msedge\.exe$/i, `实际解析到：${p}`);
});

/* ---------------- 工具层 ---------------- */

function toolsOf(engines = {}) {
  // getDesktopToolsAsync 的形状与生产一致：返回 { computerUse, browserUse } 这一层
  return createAgentTools({
    repoRoot,
    getDesktopToolsAsync: async () => engines,
    getBrowserRealAsync: async () => engines.browserReal || null
  });
}

test('工具层: browser_navigate 默认走 local，mode:real 走真 Edge 并且未连接时明确报错', async () => {
  const localCalls = [];
  const tools = toolsOf({
    browserUse: {
      async navigate(url, options) { localCalls.push({ url, ...options }); return { ok: true, url, title: 'local' }; }
    },
    browserReal: { realIsConnected: () => false, PLATFORM_PLAYBOOKS }
  });
  assert.deepEqual(await tools.browser_navigate({ url: 'https://a.test/' }), { ok: true, url: 'https://a.test/', title: 'local' });
  assert.equal(localCalls.length, 1, '默认必须走离屏引擎');
  const realAttempt = await tools.browser_navigate({ url: 'https://a.test/', mode: 'real' });
  assert.equal(realAttempt.ok, false);
  assert.match(realAttempt.error, /browser_connect_real/);
  assert.equal(localCalls.length, 1, 'mode:real 不应触发离屏导航');
});

test('工具层: 真 Edge 已连接时 snapshot/click/type 按 ref 前缀派发（r* 走真 Edge，e* 走离屏）', async () => {
  const calls = [];
  const real = {
    realIsConnected: () => true,
    PLATFORM_PLAYBOOKS,
    async snapshotReal(o) { calls.push(['snapshotReal', o]); return { ok: true, tree: '- button "X" [ref=r1]', nodeCount: 1 }; },
    async clickReal(ref, o) { calls.push(['clickReal', ref, o]); return { ok: true, ref }; },
    async typeIntoReal(ref, text) { calls.push(['typeIntoReal', ref, text]); return { ok: true }; },
    async evaluateReal(expr) { calls.push(['evaluateReal', expr]); return { ok: true, result: '1' }; },
    consoleMessagesReal() { return { ok: true, messages: [] }; },
    async screenshotReal() { calls.push(['screenshotReal']); return { ok: true, buf: Buffer.from('x'), mime: 'image/png', width: 10, height: 10 }; },
    async disconnectReal() { calls.push(['disconnectReal']); return { ok: true }; },
    async connectReal(o) { calls.push(['connectReal', o]); return { ok: true, started: true, port: 9224 }; },
    async probeLoginState(o) { calls.push(['probeLoginState', o]); return { state: 'signed-in', platform: o.platform }; }
  };
  const local = {
    async click(ref, o) { calls.push(['localClick', ref, o]); return { ok: true, ref }; },
    async typeInto(ref, text) { calls.push(['localType', ref, text]); return { ok: true }; }
  };
  const tools = toolsOf({ browserUse: local, browserReal: real });

  assert.equal((await tools.browser_snapshot({})).ok, true);
  assert.deepEqual(await tools.browser_click({ ref: 'r7' }), { ok: true, ref: 'r7' });
  await tools.browser_click({ ref: 'e7' });
  await tools.browser_type({ ref: 'r8', text: 'hi' });
  const shot = await tools.browser_screenshot();
  assert.equal(shot.ok, true);
  assert.ok(shot.__images, '截图必须带图（模型要看得见）');
  assert.deepEqual(calls.map((c) => c[0]), ['snapshotReal', 'clickReal', 'localClick', 'typeIntoReal', 'screenshotReal']);
});

test('工具层: browser_connect_real / browser_login_state / browser_disconnect_real 的参数与形状', async () => {
  const calls = [];
  const real = {
    PLATFORM_PLAYBOOKS,
    realIsConnected: () => true,
    async connectReal(o) { calls.push(['connectReal', o]); return { ok: true, started: true, port: 9224, profile: 'C:/ud/edge-profile', pages: 1 }; },
    async probeLoginState(o) { calls.push(['probe', o]); return { state: 'signed-in', platform: o.platform, detail: 'ok' }; },
    async disconnectReal() { calls.push(['disconnect']); return { ok: true, connected: false, note: 'Edge 仍在运行' }; },
    async closeRealEdgeAndReset() { calls.push(['closeEdge']); return { ok: true, connected: false }; }
  };
  const tools = toolsOf({ browserReal: real });

  const connected = await tools.browser_connect_real({ platforms: ['github', 'bogus'], start: false });
  assert.equal(connected.ok, true);
  // 未知平台被过滤掉（不让模型乱传）；已知平台映射到各自首页
  assert.deepEqual(calls[0][1].urls, [PLATFORM_PLAYBOOKS.github.home]);
  assert.equal(calls[0][1].start, false);
  // userDataDir 由主进程注入：没注入时是空串（工具仍可跑，但连接会因为没有 profile 失败）
  assert.equal(calls[0][1].userDataDir, '');

  assert.deepEqual(await tools.browser_login_state({ platform: 'threads' }), { state: 'signed-in', platform: 'threads', detail: 'ok' });
  assert.deepEqual(await tools.browser_disconnect_real({}), { ok: true, connected: false, note: 'Edge 仍在运行' });
  assert.deepEqual(await tools.browser_disconnect_real({ close_browser: true }), { ok: true, connected: false });
  assert.deepEqual(calls.slice(1).map((c) => c[0]), ['probe', 'disconnect', 'closeEdge']);
  // 缺 platform 时明确报错
  assert.match((await tools.browser_login_state({})).error, /platform/);
});

test('工具层: 真 Edge 通道不可用时（纯 Node/测试台）三个新工具都返回可执行错误', async () => {
  const tools = toolsOf({ browserUse: { close() {} }, browserReal: null });
  for (const name of ['browser_connect_real', 'browser_login_state', 'browser_disconnect_real']) {
    const r = await tools[name]({ platform: 'github' });
    assert.match(r.error, /需要 FinalCheck 桌面端/, `${name} 应给出明确错误`);
  }
});

/* ---------------- schema 钉子 ---------------- */

test('schema: 三个真 Edge 工具在 AGENT_TOOLS_SCHEMA 里，描述含关键纪律', () => {
  const names = AGENT_TOOLS_SCHEMA.map((t) => t.function.name);
  for (const n of ['browser_connect_real', 'browser_login_state', 'browser_disconnect_real']) {
    assert.ok(names.includes(n), `${n} 必须注册进 schema`);
  }
  const nav = AGENT_TOOLS_SCHEMA.find((t) => t.function.name === 'browser_navigate').function;
  // 0.31.1：用户可以先在提问卡里选模式，模型也能在用户明说时直接传对应的 mode
  assert.deepEqual(nav.parameters.properties.mode.enum, ['local', 'persistent', 'oneshot', 'real'], 'browser_navigate 的 mode 覆盖三模式');
  assert.match(nav.description, /ask_user/, '描述里必须要求先问用户三选一，不许模型自己拍板');
  const connect = AGENT_TOOLS_SCHEMA.find((t) => t.function.name === 'browser_connect_real').function;
  assert.match(connect.description, /9224/, '必须写明端口');
  assert.match(connect.description, /不抢前台/, '必须写明不抢前台');
  const disc = AGENT_TOOLS_SCHEMA.find((t) => t.function.name === 'browser_disconnect_real').function;
  assert.match(disc.description, /Edge 继续运行/, '必须写明断开不杀浏览器');
});

test('源码钉: 真 Edge 引擎懒加载，退出时只断开不杀进程；profile 落在 userData', () => {
  assert.match(ipcSrc, /engineUrl\('desktop\/src\/main\/browser-real\.mjs'\)/);
  assert.match(ipcSrc, /disconnectReal/, '退出钩子必须调 disconnectReal（不是 closeRealEdge）');
  assert.match(ipcSrc, /const browserUserDataDir = \(\) => getDataRoot\(\)/, '真 Edge profile 必须落在 userData 下');
  assert.match(serviceSrc, /browser_connect_real/);
  assert.match(serviceSrc, /browser_login_state/);
  assert.match(serviceSrc, /browser_disconnect_real/);
});
