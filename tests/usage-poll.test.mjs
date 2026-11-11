// Bug B 回归 2：Usage 页在回合进行中每 5 秒自动刷新，回合结束/接口不支持时完全不轮询（不是常驻轮询）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USAGE_POLL_MS, usagePollInterval, startUsagePolling } from '../desktop/src/renderer/lib/usage-poll.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('usage-poll: running 时 5 秒一次，idle / 接口不支持时不轮询', () => {
  assert.equal(USAGE_POLL_MS, 5000);
  assert.equal(usagePollInterval({ running: true }), 5000);
  assert.equal(usagePollInterval({ running: false }), 0);
  assert.equal(usagePollInterval({}), 0);
  assert.equal(usagePollInterval({ running: true, unsupported: true }), 0);
});

test('usage-poll: 定时器只在 running 时创建，stop 后清理', () => {
  let id = null;
  let ms = null;
  let tick = null;
  const stop = startUsagePolling({
    running: true,
    tick: () => {},
    setIntervalFn: (fn, delay) => { tick = fn; ms = delay; id = 42; return id; },
    clearIntervalFn: (cleared) => { assert.equal(cleared, 42); id = null; }
  });
  assert.equal(ms, 5000);
  assert.equal(typeof tick, 'function');
  assert.equal(id, 42);
  stop();
  assert.equal(id, null, 'effect 清理时停掉轮询');

  let scheduled = false;
  const stopIdle = startUsagePolling({
    running: false,
    tick: () => {},
    setIntervalFn: () => { scheduled = true; return 1; },
    clearIntervalFn: () => {}
  });
  assert.equal(scheduled, false, 'idle 时不能起定时器');
  stopIdle();
});

test('UsagePage/SettingsPage/App：running 状态已接线（自动刷新开关来自真实回合状态）', async () => {
  const usagePage = await readFile(path.join(ROOT, 'desktop/src/renderer/pages/UsagePage.jsx'), 'utf8');
  assert.match(usagePage, /export default function UsagePage\(\{ running = false \}\)/);
  assert.match(usagePage, /useEffect\(\(\) => startUsagePolling\(\{[\s\S]{0,160}running,[\s\S]{0,160}tick:[\s\S]{0,120}\}\), \[running, unsupported, days, load\]\);/);
  assert.match(usagePage, /silent: true/, '自动刷新要静默（不闪 loading、不禁用刷新按钮）');

  const settings = await readFile(path.join(ROOT, 'desktop/src/renderer/pages/SettingsPage.jsx'), 'utf8');
  assert.match(settings, /<UsagePage running=\{running\} \/>/);

  const app = await readFile(path.join(ROOT, 'desktop/src/renderer/App.jsx'), 'utf8');
  assert.match(app, /const anyRunning = Object\.values\(runningIds\)\.some\(Boolean\);/);
  assert.match(app, /<SettingsPage onBack=\{\(\) => setPage\('chat'\)\} running=\{anyRunning\}/);
});
