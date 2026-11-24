// 0.32.7 内置浏览器加固：权限默认拒绝 + 无痕存储按会话隔离 + 真实输入通道接线。
// 真实行为（摄像头被拒、isTrusted、Shadow DOM/iframe、cookie 隔离）由真 Electron 验收脚本
// scripts/browser-use-0327-acceptance.mjs 覆盖；这里锁住纯逻辑和接线，防止被改回去。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hardenSession, isHardened, permissionAllowed, ALLOWED_PERMISSIONS } from '../desktop/src/main/browser-hardening.mjs';
import { sessionPartition, PARTITION_ONESHOT, PARTITION_PERSISTENT } from '../desktop/src/main/browser-session.mjs';

function fakeSession() {
  const s = { calls: 0 };
  s.setPermissionRequestHandler = (fn) => { s.calls++; s.request = fn; };
  s.setPermissionCheckHandler = (fn) => { s.check = fn; };
  s.setDevicePermissionHandler = (fn) => { s.device = fn; };
  return s;
}
const ask = (s, permission) => new Promise((resolve) => s.request(null, permission, resolve, { requestingUrl: 'https://evil.test/' }));

test('权限：只放行全屏和净化后的剪贴板写入', () => {
  assert.deepEqual([...ALLOWED_PERMISSIONS].sort(), ['clipboard-sanitized-write', 'fullscreen']);
  for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'midiSysex', 'pointerLock', 'openExternal', 'hid', 'serial', 'usb', 'idle-detection', 'display-capture']) {
    assert.equal(permissionAllowed(p), false, p);
  }
  assert.equal(permissionAllowed('fullscreen'), true);
  assert.equal(permissionAllowed(undefined), false);
});

test('hardenSession：请求/查询/设备三路都默认拒绝，拒绝时回调 onDenied', async () => {
  const s = fakeSession();
  const denied = [];
  hardenSession(s, { onDenied: (p, url) => denied.push([p, url]) });
  assert.equal(await ask(s, 'media'), false);
  assert.equal(await ask(s, 'notifications'), false);
  assert.equal(await ask(s, 'fullscreen'), true);
  assert.deepEqual(denied, [['media', 'https://evil.test/'], ['notifications', 'https://evil.test/']]);
  assert.equal(s.check(null, 'media'), false);
  assert.equal(s.check(null, 'fullscreen'), true);
  assert.equal(s.device({ deviceType: 'usb' }), false);
  assert.equal(isHardened(s), true);
});

test('hardenSession：同一个 session 只装一次；空值不抛错', () => {
  const s = fakeSession();
  hardenSession(s);
  hardenSession(s);
  assert.equal(s.calls, 1);
  assert.equal(hardenSession(null), null);
});

test('无痕存储按会话派生：不同对话不同、同一对话稳定、幂等', () => {
  const a = sessionPartition(PARTITION_ONESHOT, 'session-a');
  const b = sessionPartition(PARTITION_ONESHOT, 'session-b');
  assert.notEqual(a, PARTITION_ONESHOT);
  assert.notEqual(a, b);
  assert.equal(sessionPartition(PARTITION_ONESHOT, 'session-a'), a);
  assert.equal(sessionPartition(a, 'session-a'), a, '已派生的名字原样返回');
  assert.ok(!a.startsWith('persist:'), '无痕必须仍是内存存储');
});

test('「长期保留」按用户选择仍全局共享；没有会话 id 时保持原名', () => {
  assert.equal(sessionPartition(PARTITION_PERSISTENT, 'session-a'), PARTITION_PERSISTENT);
  assert.equal(sessionPartition(PARTITION_ONESHOT, null), PARTITION_ONESHOT);
  assert.equal(sessionPartition(PARTITION_ONESHOT, ''), PARTITION_ONESHOT);
  assert.equal(sessionPartition('', 'x'), sessionPartition(PARTITION_ONESHOT, 'x'));
});

test('接线：所有加载任意网页的地方都装了权限加固', async () => {
  const src = (f) => readFile(new URL(`../desktop/src/main/${f}`, import.meta.url), 'utf8');
  assert.match(await src('browser-view-host.mjs'), /hardenSession\(view\.webContents\.session\)/);
  assert.match(await src('browser-use.mjs'), /hardenSession\(window\.webContents\.session\)/);
  assert.match(await src('capture.mjs'), /hardenSession\(win\.webContents\.session\)/);
});

test('接线：点击/输入优先走 CDP 真实输入，拿不到通道才退回脚本事件并标 trusted:false', async () => {
  const s = await readFile(new URL('../desktop/src/main/browser-use.mjs', import.meta.url), 'utf8');
  assert.match(s, /Input\.dispatchMouseEvent/);
  assert.match(s, /Input\.insertText/);
  assert.match(s, /trusted: true/);
  assert.match(s, /\.trusted = false/);
  // 页面不可见时 requestAnimationFrame 不触发：必须有超时兜底，不能裸等
  assert.doesNotMatch(s, /await new Promise\(requestAnimationFrame\)/);
});
