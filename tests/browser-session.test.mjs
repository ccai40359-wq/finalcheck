// 0.31.0 阶段 1：浏览器会话两模式（离屏无痕 / 离屏持久）的纯逻辑 + 源码钉。
//
// 这里刻意不 import electron：partition 选择、配置归一、清空目录都应当能在纯 Node 里验证。
// Electron 侧的真实行为（窗口重建 / cookie 落盘）由 scripts/browser-session-acceptance.mjs 在真 Electron 里跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

import {
  PARTITION_ONESHOT, PARTITION_PERSISTENT, SESSION_MODES,
  resolvePartition, normalizeSessionMode, sessionPolicyOf,
  partitionDataDir, browserDataPaths, clearBrowserData
} from '../desktop/src/main/browser-session.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
// 统一去掉 CR：git 在 Windows 上会把检出文件转成 CRLF，源码钉正则不该因此失败
const readSrc = (rel) => readFileSync(path.join(repoRoot, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');
const engineSrc = readSrc('desktop/src/main/browser-use.mjs');
const toolsSrc = readSrc('desktop/src/main/agent-tools.mjs');
const settingsSrc = readSrc('desktop/src/renderer/pages/SettingsPage.jsx');
const configSrc = readSrc('desktop/src/main/ipc/config-store.mjs');
const agentIpcSrc = readSrc('desktop/src/main/ipc/ipc-agent.mjs');

/* ---------------- partition 选择（纯函数） ---------------- */

test('browser-session: 默认无痕，只有 persistent=true 才写盘', () => {
  assert.equal(resolvePartition(), PARTITION_ONESHOT);
  assert.equal(resolvePartition(false), PARTITION_ONESHOT);
  assert.equal(resolvePartition(null), PARTITION_ONESHOT);
  assert.equal(resolvePartition(undefined), PARTITION_ONESHOT);
  assert.equal(resolvePartition('true'), PARTITION_ONESHOT, '字符串 true 不算持久（避免配置脏值悄悄写盘）');
  assert.equal(resolvePartition(1), PARTITION_ONESHOT);
  assert.equal(resolvePartition(true), PARTITION_PERSISTENT);
  assert.equal(PARTITION_ONESHOT, 'fc-browser-use', '无痕 partition 必须是 0.30.4 之前的同一个值（不破坏现有用户 session 语义）');
  assert.equal(PARTITION_PERSISTENT, 'persist:fc-browser-use');
});

test('browser-session: 配置归一只产出 oneshot / persistent / 空（未选择）', () => {
  assert.deepEqual([...SESSION_MODES], ['oneshot', 'persistent']);
  assert.equal(normalizeSessionMode('persistent'), 'persistent');
  assert.equal(normalizeSessionMode('oneshot'), 'oneshot');
  for (const bad of ['', undefined, null, 'persist', 'PERSISTENT', true, 1, {}]) {
    assert.equal(normalizeSessionMode(bad), '', `${JSON.stringify(bad)} 应归一为「未选择」`);
  }
});

test('browser-session: sessionPolicyOf 默认（未选择）按无痕跑，chosen=false 供首次提示', () => {
  const fresh = sessionPolicyOf({});
  assert.equal(fresh.mode, 'oneshot');
  assert.equal(fresh.chosen, false);
  assert.equal(fresh.persistent, false);
  assert.equal(fresh.partition, PARTITION_ONESHOT);

  const undef = sessionPolicyOf(null);
  assert.equal(undef.mode, 'oneshot');
  assert.equal(undef.chosen, false);

  const oneShot = sessionPolicyOf({ browserSessionMode: 'oneshot' });
  assert.equal(oneShot.mode, 'oneshot');
  assert.equal(oneShot.chosen, true, '显式选过一次性之后不再弹提示');
  assert.equal(oneShot.persistent, false);

  const persist = sessionPolicyOf({ browserSessionMode: 'persistent' });
  assert.equal(persist.mode, 'persistent');
  assert.equal(persist.chosen, true);
  assert.equal(persist.persistent, true);
  assert.equal(persist.partition, PARTITION_PERSISTENT);

  const dirty = sessionPolicyOf({ browserSessionMode: 'persist:' });
  assert.equal(dirty.mode, 'oneshot');
  assert.equal(dirty.chosen, false);
});

/* ---------------- 清空浏览器数据 ---------------- */

test('browser-session: 清空目录只指向 persist partition，且拒绝空参数乱删', () => {
  assert.equal(partitionDataDir('C:/data', PARTITION_PERSISTENT), path.join('C:/data', 'Partitions', 'fc-browser-use'));
  assert.deepEqual(browserDataPaths(path.join(path.sep, 'ud')), [path.join(path.sep, 'ud', 'Partitions', 'fc-browser-use')]);
  assert.deepEqual(browserDataPaths(''), []);
});

test('browser-session: clearBrowserData 先关窗口再删目录，且只删 persist 那一套', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'fc-bsession-'));
  const userData = path.join(base, 'userData');
  const target = path.join(userData, 'Partitions', 'fc-browser-use');
  const untouched = path.join(userData, 'Local Storage');
  await mkdir(target, { recursive: true });
  await mkdir(untouched, { recursive: true });
  await writeFile(path.join(target, 'Cookies'), 'x', 'utf8');
  await writeFile(path.join(untouched, 'keep.txt'), 'x', 'utf8');

  const calls = [];
  const browserUse = {
    close() { calls.push(['close']); },
    isOpen() { return true; }
  };
  try {
    const r = await clearBrowserData({ userDataDir: userData, browserUse, rm });
    assert.deepEqual(calls, [['close']], 'close 必须在删除前发生');
    assert.equal(r.ok, true);
    assert.deepEqual(r.removed, [target]);
    assert.deepEqual(r.failed, []);
    // 只删目标：同级的 Local Storage 必须原样在
    await assert.rejects(() => readFileSafe(path.join(target, 'Cookies')), /ENOENT/);
    assert.equal(await readFileSafe(path.join(untouched, 'keep.txt')), 'x');
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test('browser-session: clearBrowserData 调 clearStorageData（真正的登录态清除点）', async () => {
  let clearCalled = 0;
  const fakeSession = { async clearStorageData() { clearCalled += 1; } };
  const r = await clearBrowserData({ userDataDir: 'C:/nonexistent-ud', browserUse: null, rm, session: fakeSession });
  assert.equal(clearCalled, 1, '必须调用 session.clearStorageData()');
  assert.equal(r.cleared, true);
  assert.equal(r.ok, true, '目录不存在（force）也算成功');
});

test('browser-session: 目录 EBUSY 时 ok 仍为 true（数据已由 clearStorageData 清掉）', async () => {
  // 真机实测：Chromium 不退进程时目录会 EBUSY，但 cookie 已在 clearStorageData 里清空。
  // 这时判失败会让用户以为「没清成功」，而实际登录态已经没了。
  const failingRm = async () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
  const clearCalled = [];
  const fakeSession = { async clearStorageData() { clearCalled.push(1); } };
  const r = await clearBrowserData({ userDataDir: '/ud', browserUse: null, rm: failingRm, session: fakeSession });
  assert.equal(r.ok, true, '有 clearStorageData 兜底时不能判失败');
  assert.equal(r.cleared, true);
  assert.deepEqual(r.removed, []);
  assert.equal(r.failed.length, 1);
});

test('browser-session: 既没 clearStorageData 又删不掉 → ok=false（如实报告）', async () => {
  const failingRm = async () => { throw new Error('EBUSY'); };
  const r = await clearBrowserData({ userDataDir: '/ud', browserUse: null, rm: failingRm, session: null });
  assert.equal(r.ok, false);
  assert.equal(r.cleared, false);
});

async function readFileSafe(file) {
  const { readFile } = await import('node:fs/promises');
  return readFile(file, 'utf8');
}

test('browser-session: clearBrowserData 在没有窗口时不抛（幂等），目录不存在也算成功', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'fc-bsession2-'));
  try {
    const r = await clearBrowserData({ userDataDir: base, browserUse: null, rm });
    assert.equal(r.ok, true, 'force:true 让不存在的目录也成功');
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
  // close() 抛错不能阻断清空
  const r2 = await clearBrowserData({ userDataDir: '', browserUse: { close() { throw new Error('boom'); } }, rm });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.paths, []);
});

/* ---------------- 源码钉：不得硬编码单一 partition ---------------- */

test('源码钉: browser-use.mjs 不再硬编码 partition 字面量，而是按策略解析 + 策略变化先关窗', () => {
  assert.doesNotMatch(engineSrc, /partition:\s*'fc-browser-use'/, 'partition 不能写死在窗口配置里');
  assert.match(engineSrc, /\n\s+partition\n/, '窗口的 partition 必须来自 resolvePartition 的结果（短写 partition 字段）');
  // 0.32.7：无痕存储按会话派生（sessionPartition 包在策略解析结果外面）
  // 0.33.6：外面再包一层 partitionFor（浏览器子代理 isolated 时用自己的无痕分区，否则仍是 sessionPartition(…, sessionId)）
  assert.match(engineSrc, /const partition = partitionFor\(scope, want\.partition \|\| resolvePartition\(want\.persistent === true\)\)/);
  assert.match(engineSrc, /function partitionFor\(scope, partition\) \{[\s\S]{0,300}sessionPartition\(partition, scope\.sessionId\)/);
  assert.match(engineSrc, /import \{[^}]*resolvePartition[^}]*\} from '\.\/browser-session\.mjs'/);
  // 策略变了必须 close 再重建（else 就会有两套 cookie）
  assert.match(engineSrc, /if \(partition === activePolicy\.partition\) return active;/);
  assert.match(engineSrc, /close\(\);\s*\/\/\s*策略变了/);
});

test('源码钉: 设置页有「清空浏览器数据」按钮与持久模式可见标识', () => {
  assert.match(settingsSrc, /y\.browserClearData\(\)/, '清空按钮必须走 preload 的 browserClearData');
  assert.match(settingsSrc, /t\('清空浏览器数据'\)/);
  assert.match(settingsSrc, /BROWSER_SESSION_MODES/, '两种模式在界面上可切换');
  assert.match(settingsSrc, /browserPolicy\?\.persistent === true/, '持久模式必须有可见标识');
  assert.match(settingsSrc, /t\('记住登录'\)/);
  assert.match(settingsSrc, /browserSessionMode: browserMode === 'persistent'/, '保存时写回配置字段');
});

test('源码钉: config 归一（browserSessionMode）与 IPC 通道齐全', () => {
  assert.match(configSrc, /out\.browserSessionMode = cfg\.browserSessionMode === 'persistent'/);
  assert.match(configSrc, /=== 'oneshot' \? 'oneshot' : ''/);
  assert.match(agentIpcSrc, /finalcheck:browser-clear-data/);
  assert.match(agentIpcSrc, /finalcheck:browser-session-info/);
  assert.match(agentIpcSrc, /finalcheck:browser-first-use/);
  assert.match(agentIpcSrc, /browserSessionPolicy\b/);
  // 清空通道必须把 session 传给 clearBrowserData（否则 cookie 只能靠删目录，Windows 上会 EBUSY 失败）
  assert.match(agentIpcSrc, /session: ses\b/);
});

test('源码钉: browser_navigate 把策略透传给引擎（测试台缺省仍是无痕）', () => {
  assert.match(toolsSrc, /browserSessionPolicy = null/, 'createAgentTools 必须接受策略提供器');
  assert.match(toolsSrc, /onBrowserFirstUse = null/);
  assert.match(toolsSrc, /sessPolicy = await browserSessionPolicy\(\)/);
  // 0.31.1：用户选过的模式优先于设置页策略（wantPolicy 覆盖），两者都按存在与否透传
  assert.match(toolsSrc, /\.\.\.\(wantPolicy \? \{ policy: wantPolicy \} : \{\}\)/, '策略按存在与否透传，缺省不改变旧调用形状');
  assert.match(toolsSrc, /const wantPolicy = chosenMode/, '用户选的模式必须覆盖设置页默认');
});
