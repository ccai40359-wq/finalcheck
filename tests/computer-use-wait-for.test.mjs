// 0.30.0 特性 3：wait-for（R7 超时 ok:true 语义 + R10 快速失败）
// R9：现状没有固定 sleep，这是**新增**能力而不是替换。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_POLL_MS, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, WAIT_CONDITIONS,
  evaluateWaitCondition, makeFailFast, normalizePoll, normalizeTimeout,
  validateWaitFor, waitForCondition
} from '../desktop/src/main/wait-for.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const cuSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/computer-use.mjs'), 'utf8');
const toolsSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/agent-tools.mjs'), 'utf8');

// 可控时钟：注入 now + sleep，测试里零真实等待
function clockHarness() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    get time() { return t; },
    sleeps
  };
}

// ---- 预算归一 ----

test('wait: 超时预算归一（默认 5s / 上限 30s / 非法值回默认）', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 5000);
  assert.equal(MAX_TIMEOUT_MS, 30000);
  assert.equal(normalizeTimeout(undefined), 5000);
  assert.equal(normalizeTimeout(null), 5000);
  assert.equal(normalizeTimeout(0), 5000);
  assert.equal(normalizeTimeout(-5), 5000);
  assert.equal(normalizeTimeout('abc'), 5000);
  assert.equal(normalizeTimeout(1200), 1200);
  assert.equal(normalizeTimeout(1000.9), 1000);
  assert.equal(normalizeTimeout(30000), 30000);
  assert.equal(normalizeTimeout(99999), 30000); // 夹到上限，不报错
});

test('wait: 轮询间隔归一（默认 200ms / 下限 50ms 防高频 COM）', () => {
  assert.equal(DEFAULT_POLL_MS, 200);
  assert.equal(normalizePoll(undefined), 200);
  assert.equal(normalizePoll(10), 50);
  assert.equal(normalizePoll(300), 300);
  assert.equal(normalizePoll(0), 200);
  assert.equal(normalizePoll(-1), 200);
});

// ---- 条件求值四态 ----

test('wait: element-exists —— 精确或包含匹配；空 selector 永不命中', () => {
  const obs = { windowAlive: true, elements: ['Settings', 'File', 'Untitled - Notepad'], values: [] };
  assert.equal(evaluateWaitCondition('element-exists', obs, { selector: 'Settings' }).matched, true);
  assert.equal(evaluateWaitCondition('element-exists', obs, { selector: 'Notepad' }).matched, true); // 包含
  assert.equal(evaluateWaitCondition('element-exists', obs, { selector: 'Save' }).matched, false);
  assert.equal(evaluateWaitCondition('element-exists', obs, { selector: '' }).matched, false);
  assert.equal(evaluateWaitCondition('element-exists', null, { selector: 'X' }).matched, false);
});

test('wait: element-gone —— 窗口已关闭也算命中（R10）；元素还在则不命中', () => {
  assert.equal(evaluateWaitCondition('element-gone', { windowAlive: true, elements: ['Save'] }, { selector: 'Save' }).matched, false);
  assert.equal(evaluateWaitCondition('element-gone', { windowAlive: true, elements: ['Open'] }, { selector: 'Save' }).matched, true);
  assert.equal(evaluateWaitCondition('element-gone', { windowAlive: false, elements: [] }, { selector: 'Save' }).matched, true);
  assert.equal(evaluateWaitCondition('element-gone', { windowAlive: false, elements: ['Save'] }, { selector: 'Save' }).windowClosed, true);
});

test('wait: value-equals 全等 / value-contains 包含（大小写敏感，与界面文本一致）', () => {
  const obs = { windowAlive: true, elements: [], values: ['Line 1, Column 1', '已复制'] };
  assert.equal(evaluateWaitCondition('value-equals', obs, { value: '已复制' }).matched, true);
  assert.equal(evaluateWaitCondition('value-equals', obs, { value: '已复制 ' }).matched, false);
  assert.equal(evaluateWaitCondition('value-contains', obs, { value: 'Column' }).matched, true);
  assert.equal(evaluateWaitCondition('value-contains', obs, { value: 'column' }).matched, false); // 大小写敏感
  assert.equal(evaluateWaitCondition('value-contains', obs, { value: '' }).matched, false);
});

test('wait: 未知条件不命中（不抛错）', () => {
  const r = evaluateWaitCondition('bogus', { windowAlive: true, elements: ['x'], values: ['y'] }, {});
  assert.equal(r.matched, false);
  assert.deepEqual(WAIT_CONDITIONS, ['element-exists', 'element-gone', 'value-equals', 'value-contains']);
});

// ---- 参数校验 ----

test('wait: validateWaitFor 校验条件与必需字段', () => {
  assert.equal(validateWaitFor(null), null);
  assert.equal(validateWaitFor(undefined), null);
  assert.equal(validateWaitFor({ condition: 'element-exists', target: { selector: 'Save' } }), null);
  assert.equal(validateWaitFor({ condition: 'value-equals', value: 'ok' }), null);
  assert.match(validateWaitFor({ condition: 'bogus' }), /只支持/);
  assert.match(validateWaitFor({ condition: 'element-exists' }), /target\.selector/);
  assert.match(validateWaitFor({ condition: 'element-exists', target: { selector: '  ' } }), /target\.selector/);
  assert.match(validateWaitFor({ condition: 'value-equals' }), /需要字符串 value/);
  assert.match(validateWaitFor({ condition: 'value-equals', value: 42 }), /需要字符串 value/);
  assert.match(validateWaitFor('nope'), /必须是对象/);
  assert.match(validateWaitFor([]), /必须是对象/);
});

// ---- 轮询逻辑（注入 clock 直测）----

test('wait R7: 超时返回 ok:true + matched:false + timedOut:true（绝不 ok:false）', async () => {
  const h = clockHarness();
  const r = await waitForCondition({
    condition: 'element-exists', selector: 'Save', timeoutMs: 1000, pollMs: 200,
    now: h.now, sleep: h.sleep,
    observe: async () => ({ windowAlive: true, elements: [], values: [] })
  });
  assert.equal(r.ok, true);
  assert.equal(r.matched, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.windowClosed, false);
  assert.ok(r.attempts >= 5, `attempts=${r.attempts}`);
  assert.equal(r.elapsedMs, 1000);
  // 有预算提醒文案（模型能据此决定重截）
  assert.match(r.reason, /1000ms/);
});

test('wait: 元素出现即命中（不等满预算）', async () => {
  const h = clockHarness();
  let n = 0;
  const r = await waitForCondition({
    condition: 'element-exists', selector: 'Save', timeoutMs: 5000, pollMs: 200,
    now: h.now, sleep: h.sleep,
    observe: async () => {
      n++;
      return { windowAlive: true, elements: n >= 3 ? ['Save'] : ['Open'], values: [] };
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.matched, true);
  assert.equal(r.timedOut, false);
  assert.equal(r.attempts, 3);
  assert.ok(r.elapsedMs < 5000);
});

test('wait R10: 窗口关闭立即返回（不硬等满超时）', async () => {
  const h = clockHarness();
  const r = await waitForCondition({
    condition: 'element-exists', selector: 'Save', timeoutMs: 30000, pollMs: 200,
    now: h.now, sleep: h.sleep,
    observe: async () => ({ windowAlive: false, elements: [], values: [] })
  });
  assert.equal(r.ok, true);
  assert.equal(r.matched, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.windowClosed, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.elapsedMs, 0);
  assert.match(r.reason, /已关闭/);
});

test('wait R10: 无 UIA 树（微信/Electron）快速失败（failFast，一次就返回）', async () => {
  const h = clockHarness();
  const r = await waitForCondition({
    condition: 'element-exists', selector: '发送', timeoutMs: 30000, pollMs: 200,
    now: h.now, sleep: h.sleep,
    observe: async () => ({ windowAlive: true, elements: [], values: [] }),
    failFast: makeFailFast('element-exists', 'weixin', { cache: new Map() })
  });
  assert.equal(r.ok, true);
  assert.equal(r.matched, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.reason, 'no-uia-tree');
  assert.equal(r.attempts, 1);
  assert.equal(h.time, 0); // 没有任何真实等待
});

test('wait: makeFailFast 对 UIA 富应用返回 null（正常轮询）', () => {
  assert.equal(makeFailFast('element-exists', 'notepad', { cache: new Map() }), null);
  assert.equal(makeFailFast('element-exists', 'unknownapp', { cache: new Map() }), null); // 未知先正常探
});

test('wait: 观测抛出 → 按窗口失效处理（element-gone 命中；其它如实返回）', async () => {
  const h = clockHarness();
  const gone = await waitForCondition({
    condition: 'element-gone', selector: 'Save', timeoutMs: 5000,
    now: h.now, sleep: h.sleep,
    observe: async () => { throw new Error('UIA host down'); }
  });
  assert.equal(gone.ok, true);
  assert.equal(gone.matched, true);
  assert.equal(gone.windowClosed, true);
  assert.match(gone.reason, /UIA host down/);

  const exists = await waitForCondition({
    condition: 'element-exists', selector: 'Save', timeoutMs: 5000,
    now: h.now, sleep: h.sleep,
    observe: async () => { throw new Error('window destroyed'); }
  });
  assert.equal(exists.ok, true);
  assert.equal(exists.matched, false);
  assert.equal(exists.timedOut, false);
  assert.equal(exists.windowClosed, true);
});

test('wait: 默认参数（不传 timeout/poll）与常量一致', async () => {
  const h = clockHarness();
  const r = await waitForCondition({
    condition: 'value-equals', value: 'x',
    now: h.now, sleep: h.sleep,
    observe: async () => ({ windowAlive: true, elements: [], values: [] })
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.elapsedMs, DEFAULT_TIMEOUT_MS);
  assert.ok(h.sleeps.every((ms) => ms === DEFAULT_POLL_MS));
});

// ---- 源码钉 ----

test('钉 R9: wait-for 是新增能力（computer_action 原动作链没有固定 sleep）', () => {
  // 原 runAction 里不得出现 sleep/延时（新增的只有 wait_for 分支）
  const runAction = cuSrc.slice(cuSrc.indexOf('async function runAction'), cuSrc.indexOf('async function dispatchPostType'));
  assert.doesNotMatch(runAction, /setTimeout|await sleep|Thread\.Sleep/);
  // dispatchAction 也不延时
  const dispatch = cuSrc.slice(cuSrc.indexOf('async function dispatchAction'), cuSrc.indexOf('export function shutdown'));
  assert.doesNotMatch(dispatch, /setTimeout|sleep/);
});

test('钉 R7: 工具层把 wait 结果合并进动作结果，超时不改写 ok', () => {
  const body = toolsSrc.slice(toolsSrc.indexOf('tools.computer_action = withDesktopTool'), toolsSrc.indexOf("tools.browser_navigate"));
  // 动作失败直接返回，绝不追加 wait（没动手就没有界面变化可等）
  assert.match(body, /if \(!r\.ok\) return \{ \.\.\.r, error: r\.error \|\| '桌面动作失败' \};/);
  const afterFail = body.indexOf("if (!r.ok) return");
  const waitBlock = body.indexOf('if (waitFor != null && typeof computerUse.waitFor');
  assert.ok(waitBlock > afterFail, 'wait 必须在动作成功之后求值');
  // 结果合并：result.wait = waited；timedOut 只改 note，不改 ok
  assert.match(body, /result\.wait = waited;/);
  assert.doesNotMatch(body, /result\.ok = false/);
  assert.match(body, /if \(waited\?\.timedOut\)/);
  assert.match(body, /等待界面变化超时/);
  // 参数先校验（参数错不动手）
  assert.match(body, /const bad = validateWaitFor\(waitFor\);/);
  assert.match(body, /if \(bad\) return \{ error: bad \};/);
});

test('钉: computer-use 的 waitFor 使用进程适用性做 R10 快速失败，且 hwnd 存活复检', () => {
  const fn = cuSrc.slice(cuSrc.indexOf('export async function waitFor('), cuSrc.indexOf('export function performAction'));
  assert.match(fn, /makeFailFast\(condition, processName, \{ cache: uiaVerdicts \}\)/);
  assert.match(fn, /const info = await input\.windowInfo\(hwnd\)\.catch\(\(\) => null\);/);
  assert.match(fn, /if \(!info\?\.hwnd \|\| info\.hwnd !== hwnd\) return \{ windowAlive: false/);
  // 观测走 UIA 子树（不是像素/截图）
  assert.match(fn, /uiaObserve\(hwnd, \{ maxNodes: 400 \}\)/);
  // 超时预算归一在入口就做
  assert.match(fn, /normalizeTimeout\(waitFor\?\.timeout_ms\)/);
});

test('钉: UIA observe 只读（枚举名字/值，不 Invoke、不改窗口状态）', () => {
  const uiaSrc = readFileSync(path.join(repoRoot, 'desktop/src/main/uia-adapter.mjs'), 'utf8');
  const observe = uiaSrc.slice(uiaSrc.indexOf('public static string Observe'), uiaSrc.indexOf('public static string Invoke'));
  assert.doesNotMatch(observe, /InvokePattern\.Pattern\)\.Invoke|Toggle\(\)|Select\(\)|SetWindowPos|ShowWindow|SetForegroundWindow/);
  assert.match(observe, /ValuePattern\.Pattern/);
  assert.match(observe, /TextPattern\.Pattern/);
  // 有节点预算
  assert.match(observe, /visited < budget/);
});

test('钉: 观测预算默认 400 节点（防超大 UIA 树拖住轮询）', () => {
  assert.match(cuSrc, /uiaObserve\(hwnd, \{ maxNodes: 400 \}\)/);
});
