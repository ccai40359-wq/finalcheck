// 0.31.1：浏览器三模式「先问用户」——提问决策、回答解析、真 Edge 混用闸。
//
// 真实问题（2026-11-23 用户真机截图）：用户只说「打开浏览器，我要登录我的小红书」，
// 模型自己挑了 CDP 真 Edge，中途还调 computer_request_access + computer_screenshot + CU focus
// 去给那个 Edge 窗口聚焦，绕了 5 步。用户要求：涉及浏览器就主动 ask_user 三选一，
// 并且不许拿 CU 去动 CDP 已经接上的浏览器。
//
// 这个文件钉住两边：纯函数直测 + 工具层行为（mock askUser）+ 源码/schema 契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHOICE_MODES, choiceOptions, buildChoicePrompt, parseBrowserChoice, decideBrowserChoice,
  parseRealConsent, buildRealConsentPrompt, choiceNote, realEdgeRedirect, NO_CHANNEL_REAL_DENY
} from '../desktop/src/main/browser-choice.mjs';
import { setLanguage, hasTranslation, t } from '../desktop/src/renderer/i18n/core.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { AGENT_TOOLS_SCHEMA } from '../desktop/src/main/agent-service.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-tools.mjs'), 'utf8');
const promptSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-service.mjs'), 'utf8');
const skillSrc = readFileSync(path.join(repoRoot, 'desktop/skills/browser-use/SKILL.md'), 'utf8');

const CJK = /[\u3400-\u9fff]/;
process.on('exit', () => setLanguage('zh'));

/* ---------------- 纯函数：选项 / 提问 / 解析 ---------------- */

test('browser-choice: 三个模式都在，选项文案说清「写不写盘 / 碰不碰真实账号」', () => {
  assert.deepEqual(CHOICE_MODES, ['oneshot', 'persistent', 'real']);
  const opts = choiceOptions({ realAvailable: true });
  assert.equal(opts.length, 3);
  assert.match(opts[0].label, /一次性|无痕/);
  assert.match(opts[0].description, /不写磁盘/);
  assert.match(opts[1].label, /长期保留/);
  assert.match(opts[1].description, /磁盘/);
  assert.match(opts[2].label, /Edge/);
  assert.match(opts[2].description, /隔离/, '必须说清会开隔离窗口，不碰日常浏览器');
});

test('browser-choice: 真 Edge 通道不可用时只给两个选项（给不出的路不能摆出来）', () => {
  const opts = choiceOptions({ realAvailable: false });
  assert.equal(opts.length, 2);
  assert.ok(!opts.some((o) => /Edge/.test(o.label)));
});

test('browser-choice: 提问正文带域名（卡片是独立出现的，用户看不到上下文）', () => {
  const c = buildChoicePrompt({ url: 'https://www.xiaohongshu.com/explore' });
  assert.match(c.question, /xiaohongshu\.com/, '必须带站点域名');
  assert.ok(c.options.length >= 2);
  const blank = buildChoicePrompt({ url: '' });
  assert.ok(blank.question.length > 0, '没网址时也要有可读的问题');
});

test('browser-choice: 回答解析覆盖三种 label + 序号 + 自由输入，判不出来返回空', () => {
  assert.equal(parseBrowserChoice('一次性（无痕）'), 'oneshot');
  assert.equal(parseBrowserChoice('长期保留'), 'persistent');
  assert.equal(parseBrowserChoice('接我自己的 Edge（真实登录态）'), 'real');
  assert.equal(parseBrowserChoice('接我自己的 Edge'), 'real');
  assert.equal(parseBrowserChoice('1'), 'oneshot');
  assert.equal(parseBrowserChoice('2'), 'persistent');
  assert.equal(parseBrowserChoice('3'), 'real');
  assert.equal(parseBrowserChoice('第 2 个'), 'persistent');
  assert.equal(parseBrowserChoice('Long-term'), 'persistent', '英文界面的 label 也要认');
  assert.equal(parseBrowserChoice('one-shot (private)'), 'oneshot');
  assert.equal(parseBrowserChoice('use my own Edge'), 'real');
  assert.equal(parseBrowserChoice('我想用无痕'), 'oneshot');
  assert.equal(parseBrowserChoice('随便'), '', '判不出来必须返回空（不许猜）');
  assert.equal(parseBrowserChoice(''), '');
  assert.equal(parseBrowserChoice(null), '');
});

test('browser-choice: 决策顺序 = 显式 > 会话已答 > 设置已选 > 问 > 默认', () => {
  // ① 显式指定：不问
  assert.deepEqual(decideBrowserChoice({ explicitMode: 'real', hasAskChannel: true, realAvailable: true }),
    { ask: false, mode: 'real', reason: 'explicit-real' });
  assert.deepEqual(decideBrowserChoice({ explicitMode: 'oneshot', hasAskChannel: true }),
    { ask: false, mode: 'oneshot', reason: 'explicit-mode' });
  assert.deepEqual(decideBrowserChoice({ explicitMode: 'persistent', hasAskChannel: true }),
    { ask: false, mode: 'persistent', reason: 'explicit-mode' });
  // ② 会话已答：不问
  assert.equal(decideBrowserChoice({ sessionMode: 'persistent', hasAskChannel: true }).ask, false);
  // ③ 设置页已选：不问
  assert.deepEqual(decideBrowserChoice({ hasAskChannel: true, configChosen: true }),
    { ask: false, mode: '', reason: 'config' });
  // ④ 没有提问通道：不问（但也不擅自接真 Edge，见下一条）
  assert.deepEqual(decideBrowserChoice({ hasAskChannel: false }),
    { ask: false, mode: '', reason: 'no-channel' });
  // ⑤ 首次：问
  assert.deepEqual(decideBrowserChoice({ hasAskChannel: true, realAvailable: true }),
    { ask: true, mode: '', reason: 'first-use' });
});

test('browser-choice: 真 Edge 同意解析（同意/拒绝/判不出来三态）', () => {
  assert.equal(parseRealConsent('接我自己的 Edge'), true);
  assert.equal(parseRealConsent('1'), true);
  assert.equal(parseRealConsent('同意'), true);
  assert.equal(parseRealConsent('不用，走离屏浏览器'), false, '「不用」优先于「走」');
  assert.equal(parseRealConsent('2'), false);
  assert.equal(parseRealConsent('拒绝'), false);
  assert.equal(parseRealConsent(''), null);
  assert.equal(parseRealConsent('再看看'), null);
});

test('browser-choice: 附注按模式说明「这次为什么跑这个模式」，真 Edge 强调不抢前台', () => {
  const real = choiceNote('real', { asked: true });
  assert.match(real, /browser_screenshot/, '真 Edge 要指明看页面用什么');
  assert.match(real, /不.*抢前台/, '必须说明 CDP 不抢前台');
  assert.match(real, /提问卡/, '要带「模式由用户选择」的出处');
  assert.match(choiceNote('persistent'), /磁盘/);
  assert.match(choiceNote('oneshot'), /不写磁盘/);
  assert.equal(choiceNote(''), '');
});

/* ---------------- 混用闸：真 Edge 已连接时不许 computer_* ---------------- */

test('browser-choice: 混用闸只拦「我们自己启动的那套隔离 Edge」', () => {
  // 命中：浏览器进程 + pid 与我们的一致
  for (const proc of ['msedge', 'msedge.exe', 'chrome', 'MSEDGE']) {
    const v = realEdgeRedirect({ foreground: { process: proc, pid: 4242 }, realPid: 4242, realConnected: true });
    assert.ok(v, `${proc} 且 pid 一致时必须拦`);
    assert.equal(v.deniedBy, 'real-edge-redirect');
    assert.equal(v.hint, 'use-browser-tools', '要给模型明确替代路');
    assert.match(v.error, /browser_screenshot/);
    assert.match(v.error, /computer_request_access/);
  }
  // 不命中：不是浏览器进程（用户在 Word 里打字不该被拦）
  assert.equal(realEdgeRedirect({ foreground: { process: 'WINWORD', pid: 4242 }, realPid: 4242, realConnected: true }), null);
  // 不命中：浏览器进程但 pid 是用户日常 Edge（不是我们启动的）
  assert.equal(realEdgeRedirect({ foreground: { process: 'msedge', pid: 999 }, realPid: 4242, realConnected: true }), null);
  // 不命中：没连真 Edge / pid 未知（拦不住也不能误伤）
  assert.equal(realEdgeRedirect({ foreground: { process: 'msedge', pid: 4242 }, realPid: 0, realConnected: true }), null);
  assert.equal(realEdgeRedirect({ foreground: { process: 'msedge', pid: 4242 }, realPid: 4242, realConnected: false }), null);
  assert.equal(realEdgeRedirect({ foreground: null, realPid: 4242, realConnected: true }), null);
});

test('工具层: 真 Edge 已连接且前台就是那套 Edge 时，computer_screenshot / action / sequence / request_access 全部改路', async () => {
  const calls = [];
  const tools = createAgentTools({
    repoRoot,
    getDesktopToolsAsync: async () => ({
      computerUse: {
        async foregroundContext() { return { ok: true, hwnd: 11, pid: 4242, process: 'msedge', title: 'Edge' }; },
        async captureScreen() { calls.push('captureScreen'); return { ok: true, canAct: true, screenshotId: 's1', mime: 'image/png', buf: Buffer.from('x') }; },
        grantApps(apps) { calls.push(['grant', apps]); return apps; },
        async performAction() { calls.push('performAction'); return { ok: true }; }
      },
      browserUse: { async navigate() { calls.push('navigate'); return { ok: true }; } }
    }),
    getBrowserRealAsync: async () => ({
      realIsConnected: () => true,
      realInfo: () => ({ connected: true, port: 9224, profile: 'C:/ud/edge-profile', pages: 1, pid: 4242 })
    })
  });
  for (const name of ['computer_screenshot', 'computer_request_access', 'computer_action', 'computer_sequence']) {
    const args = name === 'computer_request_access' ? { apps: ['msedge'] }
      : name === 'computer_action' ? { action: 'left_click', screenshot_id: 's1', x: 10, y: 10 }
        : name === 'computer_sequence' ? { screenshot_id: 's1', steps: [{ action: 'left_click', x: 1, y: 1 }] }
          : {};
    const r = await tools[name](args, {});
    assert.equal(r.ok, false, `${name} 必须拒绝`);
    assert.equal(r.deniedBy, 'real-edge-redirect', `${name} 拒绝理由必须是混用闸`);
    assert.match(r.error, /browser_/, `${name} 的错误要指向 browser_* 工具`);
  }
  assert.deepEqual(calls, [], '被拦的调用不能真的碰桌面（不能截图、不能派发动作、不能授权）');
});

test('工具层: 前台不是那套 Edge（用户在用别的应用）时 CU 照常可用', async () => {
  const calls = [];
  const tools = createAgentTools({
    repoRoot,
    getDesktopToolsAsync: async () => ({
      computerUse: {
        async foregroundContext() { return { ok: true, hwnd: 21, pid: 777, process: 'WINWORD', title: '文档1' }; },
        async captureScreen() { calls.push('captureScreen'); return { ok: true, canAct: false, mime: 'image/png', buf: Buffer.from('x'), foreground: { process: 'WINWORD' } }; }
      },
      browserUse: {}
    }),
    getBrowserRealAsync: async () => ({ realIsConnected: () => true, realInfo: () => ({ pid: 4242 }) })
  });
  const r = await tools.computer_screenshot({}, {});
  assert.equal(r.ok, true, 'Word 在当前台时不能因为真 Edge 连过就把 CU 全禁掉');
  assert.deepEqual(calls, ['captureScreen']);
});

/* ---------------- 工具层行为：browser_navigate 先问用户 ---------------- */

function navTools({ askUser, browserUse, real, choice }) {
  return createAgentTools({
    repoRoot,
    askUser,
    getDesktopToolsAsync: async () => ({ browserUse, computerUse: {} }),
    getBrowserRealAsync: async () => real || null,
    browserChoice: choice
  });
}

test('工具层: 首次导航先 ask_user 三选一，用户选「长期保留」就按持久 partition 跑', async () => {
  const asked = [];
  const navCalls = [];
  const tools = navTools({
    askUser: async (arg) => { asked.push(arg); return { answer: '长期保留' }; },
    browserUse: { async navigate(url, o) { navCalls.push({ url, ...o }); return { ok: true, url, title: 'T' }; } },
    real: { realIsConnected: () => false, PLATFORM_PLAYBOOKS: {} }
  });
  const r = await tools.browser_navigate({ url: 'https://a.test/' });
  assert.equal(r.ok, true);
  assert.equal(asked.length, 1, '第一次必须问一次');
  assert.deepEqual(asked[0].options.map((o) => o.label).length, 3, '三选一');
  assert.equal(navCalls.length, 1);
  assert.equal(navCalls[0].policy.partition, 'persist:fc-browser-use', '用户选的持久必须真的落到 partition');
  assert.match(r.note, /磁盘/, '结果里要说清这次是持久模式');
});

test('工具层: 用户选「一次性无痕」按内存 partition 跑，且不再接真 Edge', async () => {
  const navCalls = [];
  const tools = navTools({
    askUser: async () => ({ answer: '一次性（无痕）' }),
    browserUse: { async navigate(url, o) { navCalls.push({ url, ...o }); return { ok: true, url }; } },
    real: { realIsConnected: () => false, PLATFORM_PLAYBOOKS: {} }
  });
  const r = await tools.browser_navigate({ url: 'https://a.test/' });
  assert.equal(r.ok, true);
  assert.equal(navCalls[0].policy.partition, 'fc-browser-use');
  assert.match(r.note, /不写磁盘/);
});

test('工具层: 用户选「接我自己的 Edge」→ 不弹第二张卡，直接连并导航', async () => {
  const asked = [];
  const realCalls = [];
  const tools = navTools({
    askUser: async (arg) => { asked.push(arg.question); return { answer: '接我自己的 Edge（真实登录态）' }; },
    browserUse: { async navigate() { throw new Error('不该走离屏'); } },
    real: {
      realIsConnected: () => false,
      PLATFORM_PLAYBOOKS: {},
      async connectReal(o) { realCalls.push(['connect', o]); return { ok: true, started: true, port: 9224, pid: 4242 }; },
      async navigateReal(url, o) { realCalls.push(['navigate', url, o]); return { ok: true, url, title: 'XHS' }; }
    }
  });
  const r = await tools.browser_navigate({ url: 'https://www.xiaohongshu.com/explore' });
  assert.equal(r.ok, true);
  assert.equal(asked.length, 1, '三选一里选了真 Edge 就算同意，不许再弹授权卡');
  assert.deepEqual(realCalls.map((c) => c[0]), ['connect', 'navigate']);
  assert.match(r.note, /真 Edge/, '结果要说明这次跑在真 Edge');
  assert.match(r.note, /不.*抢前台/);
});

test('工具层: 用户回答判不出来时不猜，明确报错并要求再问', async () => {
  const tools = navTools({
    askUser: async () => ({ answer: '看看再说' }),
    browserUse: { async navigate() { throw new Error('不该导航'); } },
    real: { realIsConnected: () => false, PLATFORM_PLAYBOOKS: {} }
  });
  const r = await tools.browser_navigate({ url: 'https://a.test/' });
  assert.equal(r.ok, false);
  assert.equal(r.deniedBy, 'browser-mode-unclear');
  assert.match(r.error, /再问一次|不要猜/);
});

test('工具层: 本会话已答过就不再问（同一任务连续导航不反复弹卡）', async () => {
  const asked = [];
  const memory = new Map();
  const choice = { get: () => memory.get('s1') || '', set: (m) => memory.set('s1', m) };
  const navCalls = [];
  const tools = navTools({
    askUser: async (a) => { asked.push(a); return { answer: '一次性（无痕）' }; },
    browserUse: { async navigate(url, o) { navCalls.push(o); return { ok: true, url }; } },
    real: { realIsConnected: () => false, PLATFORM_PLAYBOOKS: {} },
    choice
  });
  await tools.browser_navigate({ url: 'https://a.test/' });
  assert.equal(asked.length, 1);
  assert.equal(choice.get(), 'oneshot', '答过要记住');
  await tools.browser_navigate({ url: 'https://a.test/b' });
  assert.equal(asked.length, 1, '第二次不许再问');
  assert.equal(navCalls.length, 2);
});

test('工具层: 没有提问通道（子代理/测试台）不问、也不擅自接真 Edge', async () => {
  const navCalls = [];
  const tools = navTools({
    askUser: null,
    browserUse: { async navigate(url, o) { navCalls.push(o); return { ok: true, url }; } },
    real: { realIsConnected: () => false, PLATFORM_PLAYBOOKS: {} }
  });
  const r = await tools.browser_navigate({ url: 'https://a.test/', mode: 'real' });
  assert.equal(r.ok, false);
  assert.equal(r.deniedBy, 'real-edge-needs-consent');
  assert.ok(r.error.includes(NO_CHANNEL_REAL_DENY));
  assert.equal(navCalls.length, 0, '拒绝时不能偷偷跑离屏（会让模型以为在用真登录态）');
});

test('工具层: browser_connect_real 自己也要过用户点头，拒绝就不连', async () => {
  const asked = [];
  let connectCalled = false;
  const memory = new Map();
  const tools = createAgentTools({
    repoRoot,
    askUser: async (a) => { asked.push(a.question); return { answer: '不用，走离屏浏览器' }; },
    getDesktopToolsAsync: async () => ({ browserUse: {}, computerUse: {} }),
    getBrowserRealAsync: async () => ({
      realIsConnected: () => false,
      PLATFORM_PLAYBOOKS: { github: { home: 'https://github.com' } },
      async connectReal() { connectCalled = true; return { ok: true }; }
    }),
    browserChoice: { get: () => memory.get('k') || '', set: (m) => memory.set('k', m) }
  });
  const r = await tools.browser_connect_real({ platforms: ['github'] });
  assert.equal(r.ok, false);
  assert.equal(r.deniedBy, 'user-declined');
  assert.equal(connectCalled, false, '用户拒绝后绝不能真的连');
  assert.match(r.note, /不要重试/, '要明确让模型不要反复弹');
});

/* ---------------- schema / 提示 / 技能文件契约 ---------------- */

test('schema: browser_navigate 的 mode 覆盖三模式，描述要求先问用户', () => {
  const nav = AGENT_TOOLS_SCHEMA.find((x) => x.function.name === 'browser_navigate').function;
  assert.deepEqual(nav.parameters.properties.mode.enum, ['local', 'persistent', 'oneshot', 'real']);
  assert.match(nav.description, /ask_user/, '描述里必须要求先问');
  assert.match(nav.description, /不要自己拍板/);
});

test('常驻提示: 要求先问三选一 + 真 Edge 连上后不许用 computer_*（且仍守住 6k 上限）', () => {
  const a = promptSrc.indexOf('const AUTOMATION_GUIDANCE');
  const b = promptSrc.indexOf('].join(', a);
  const guidance = promptSrc.slice(a, b);
  assert.match(guidance, /ask_user 问「一次性无痕 \/ 长期保留 \/ 接我自己的 Edge」三选一/, '常驻要写清三选一');
  assert.match(guidance, /不要自己拍板/);
  assert.match(guidance, /绝不能用 computer_\* 去拍或聚焦浏览器窗口/, '混用禁令必须在常驻提示里');
  assert.ok(guidance.length < 6000, `常驻提示不得超过 6000 字符（实际 ${guidance.length}）`);
});

test('技能文件: 三选一流程 + 混用禁令 + 扫码不代劳都写在技能里（详情不占常驻）', () => {
  assert.match(skillSrc, /## 三种模式（0\.31\.0 \/ 0\.31\.1）/, '技能要标出 0.31.1 改动');
  assert.match(skillSrc, /### 第一步：先问用户三选一（0\.31\.1 硬规则）/);
  assert.match(skillSrc, /模式是\*\*用户的隐私决定\*\*/);
  assert.match(skillSrc, /不要反复弹卡/);
  assert.match(skillSrc, /两张卡连着弹/, '要写明「选了真 Edge 别再弹授权卡」的原因');
  assert.match(skillSrc, /绝不要用 `computer_\*` 操作这个 Edge 窗口/);
  assert.match(skillSrc, /扫码是他自己的动作，不要代劳/, '登录必须用户自己扫');
});

test('源码钉: 混用闸接在 4 个 CU 工具入口上，且不再有第二处绕过路径', () => {
  const gateCalls = (toolsSrc.match(/await blockedByRealEdge\(/g) || []).length;
  assert.equal(gateCalls, 4, `computer_screenshot / request_access / action / sequence 各一处，实际 ${gateCalls}`);
  assert.match(toolsSrc, /realEdgeRedirect\(\{ foreground: fg, realPid: pid, realConnected: true \}\)/, '必须按 pid 精确判定');
  assert.match(toolsSrc, /if \(!fg\) return null;/, '读不到前台时不拦（宁可不拦也不误伤）');
});

test('0.31.1 新增文案：英文界面全部有非中文译文（提问卡是用户直接看到的）', () => {
  setLanguage('en');
  const keys = [
    ...choiceOptions({ realAvailable: true }).flatMap((o) => [o.label, o.description]),
    buildChoicePrompt({ url: 'https://a.test/' }).question.replace('a.test', '{host}'),
    buildRealConsentPrompt({ purpose: 'X' }).question.replace('X', '{purpose}'),
    ...buildRealConsentPrompt({ purpose: 'X' }).options.flatMap((o) => [o.label, o.description]),
    choiceNote('real', { asked: true }),
    choiceNote('persistent', { asked: true }),
    choiceNote('oneshot', { asked: true }),
    realEdgeRedirect({ foreground: { process: 'msedge', pid: 1 }, realPid: 1, realConnected: true }).error,
    NO_CHANNEL_REAL_DENY
  ];
  for (const k of keys) {
    if (!CJK.test(k)) continue; // 纯英文条目（如 'Long-term' 的 key 本身）跳过
    assert.ok(hasTranslation(k), `缺英文译文：${k.slice(0, 60)}`);
    const en = t(k);
    assert.ok(en.trim(), `英文译文为空：${k.slice(0, 40)}`);
    assert.ok(!CJK.test(en), `英文译文仍含中文：${en.slice(0, 80)}`);
    assert.notEqual(en, k, `英文译文回退成中文原文：${k.slice(0, 40)}`);
  }
});

test('0.33.4 英文界面同意接真 Edge：「Use my own Edge」算同意（以前判成 null → 被拒 → 反复弹卡）', async () => {
  setLanguage('en');
  try {
    const [agree, decline] = buildRealConsentPrompt().options.map((o) => o.label);
    assert.equal(agree, 'Use my own Edge');
    assert.equal(parseRealConsent(agree), true);
    assert.equal(parseRealConsent(decline), false, '「No, use the offscreen browser」含 use，也必须是拒绝');
    assert.equal(parseRealConsent('use my own edge'), true);
    assert.equal(parseRealConsent('Connect it'), true);
    assert.equal(parseRealConsent("don't connect"), false);
    // 全链路：英文界面点了同意 → 不再是 user-declined；会话记住 real，第二次不再问
    let asks = 0;
    let stored = '';
    let connected = false;
    const tools = createAgentTools({
      repoRoot,
      askUser: async () => { asks++; return { answer: agree }; },
      getDesktopToolsAsync: async () => ({ browserUse: {}, computerUse: {} }),
      getBrowserRealAsync: async () => ({
        realIsConnected: () => connected,
        PLATFORM_PLAYBOOKS: { github: { home: 'https://github.com' } },
        async connectReal() { connected = true; return { ok: true }; }
      }),
      browserChoice: { get: () => stored, set: (m) => { stored = m; } }
    });
    const r = await tools.browser_connect_real({ platforms: ['github'] });
    assert.notEqual(r?.deniedBy, 'user-declined', JSON.stringify(r));
    assert.equal(connected, true, '同意后真的去连了');
    assert.equal(stored, 'real', '会话记住了同意');
    connected = false; // 模拟断开后再连：本会话已同意，不再弹卡
    await tools.browser_connect_real({ platforms: ['github'] });
    assert.equal(asks, 1, '同一会话只问一次');
  } finally {
    setLanguage('zh');
  }
});
