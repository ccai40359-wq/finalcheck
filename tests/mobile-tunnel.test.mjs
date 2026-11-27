// 0.34.2 外网访问：FinalCheck 自己维护反向 SSH 隧道。这里全部用假的 ssh / 假的 fetch，不连任何真服务器。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { createTunnel, sshArgs, validTarget, validPublicUrl, explainSshError } from '../desktop/src/main/mobile/tunnel.mjs';
import { createMobileAccess } from '../desktop/src/main/mobile/mobile-access.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(5); } return false; };
const T = { backoffMin: 20, backoffMax: 40, settle: 15, checkEvery: 30 };

function fakeSsh() {
  const spawned = [];
  const spawn = (cmd, args) => {
    const c = new EventEmitter();
    c.stderr = new EventEmitter();
    c.exitCode = null;
    c.args = args;
    c.kill = () => { if (c.exitCode == null) { c.exitCode = 143; c.killed = true; setImmediate(() => c.emit('exit', 143)); } };
    c.die = (msg, code = 255) => { c.stderr.emit('data', Buffer.from(msg)); c.exitCode = code; c.emit('exit', code); };
    spawned.push(c);
    return c;
  };
  return { spawn, spawned };
}
const respond = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('ssh 参数：只开服务器本机端口、不弹密码、端口没绑上就退出；目标不能伪装成参数', () => {
  const a = sshArgs({ target: 'user@1.2.3.4', remotePort: 7788, localPort: 7790 });
  assert.ok(a.includes('BatchMode=yes') && a.includes('ExitOnForwardFailure=yes'));
  assert.equal(a[a.indexOf('-R') + 1], '127.0.0.1:7788:127.0.0.1:7790');
  assert.equal(a.at(-1), 'user@1.2.3.4');
  assert.ok(validTarget('my-server') && validTarget('user@203.0.113.7'));
  for (const bad of ['-oProxyCommand=calc', 'a b', 'x;rm', '', 'a'.repeat(200)]) assert.equal(validTarget(bad), false, bad);
  assert.ok(validPublicUrl('https://x.cn:8443/fc-mobile'));
  assert.equal(validPublicUrl('javascript:alert(1)'), false);
  assert.equal(validPublicUrl('https://u:p@x.cn/'), false);
  assert.match(explainSshError('Error: remote port forwarding failed for listen port 7788'), /端口被占着/);
  assert.match(explainSshError('user@1.2.3.4: Permission denied (publickey).'), /登录被拒绝/);
});

test('连上并验证公网地址 → up；公网 502 两次 → 判定打不开并重建隧道', async () => {
  const { spawn, spawned } = fakeSsh();
  let reply = respond(200, { ok: true, fc: 'me' });
  const states = [];
  const tn = createTunnel({ instanceId: 'me', timing: T, spawn, fetch: (...a) => reply(...a), sshPath: 'ssh',
    config: () => ({ target: 'h', remotePort: 7788, localPort: 7788, publicUrl: 'https://x/fc' }), onChange: (s) => states.push(s.status) });
  tn.start();
  assert.equal(tn.state().status, 'connecting');
  assert.ok(await until(() => tn.state().status === 'up'));
  assert.equal(tn.state().verified, true);

  reply = respond(502, null);
  assert.ok(await until(() => tn.state().status === 'unreachable'));
  assert.match(tn.state().error, /502/);
  assert.ok(await until(() => spawned.length >= 2), '重建了 ssh');
  assert.ok(spawned[0].killed, '旧的 ssh 被结束');
  reply = respond(200, { ok: true, fc: 'me' });
  assert.ok(await until(() => tn.state().status === 'up'));
  tn.stop();
  assert.equal(tn.state().status, 'off');
});

test('公网地址应答的不是本机（旧插件占着端口）→ 不算通', async () => {
  const { spawn } = fakeSsh();
  const tn = createTunnel({ instanceId: 'me', timing: T, spawn, fetch: respond(200, { ok: true, fc: 'someone-else' }), sshPath: 'ssh',
    config: () => ({ target: 'h', remotePort: 7788, localPort: 7788, publicUrl: 'https://x/fc' }) });
  tn.start();
  assert.ok(await until(() => tn.state().status === 'unreachable'));
  assert.match(tn.state().error, /不是这台电脑/);
  tn.stop();
});

test('ssh 掉线 → 显示原因并按退避重连；stop 之后不再重连', async () => {
  const { spawn, spawned } = fakeSsh();
  const tn = createTunnel({ instanceId: 'me', timing: { ...T, settle: 1000 }, spawn, fetch: respond(200, { fc: 'me' }), sshPath: 'ssh',
    config: () => ({ target: 'h', remotePort: 7788, localPort: 7788, publicUrl: '' }) });
  tn.start();
  spawned[0].die('Error: remote port forwarding failed for listen port 7788\n');
  assert.equal(tn.state().status, 'error');
  assert.match(tn.state().error, /端口被占着/);
  assert.ok(await until(() => spawned.length === 2), '自动重连');
  tn.stop();
  assert.ok(spawned[1].killed);
  await sleep(120);
  assert.equal(spawned.length, 2, 'stop 之后不再起 ssh');
  assert.equal(tn.state().status, 'off');
});

// ---------- 接进手机访问服务 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mobile-tunnel-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('服务：/api/ping 免凭证回本机 id；开了外网后配对链接用公网地址；隧道跟着开关起停；开机自启走注入的开关', async () => {
  const port = await freePort();
  const staticDir = path.join(tmp, 'static');
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>m</title>');
  const { spawn, spawned } = fakeSsh();
  let login = false;
  const ipc = { map: new Map(), handle(ch, fn) { this.map.set(ch, fn); }, removeHandler(ch) { this.map.delete(ch); } };
  const ma = createMobileAccess({
    dataRoot: path.join(tmp, 'data'), staticDir, configFile: () => path.join(tmp, 'none.json'),
    env: { FINALCHECK_MOBILE_PORT: String(port) },
    loginItem: { get: () => login, set: (v) => { login = v; } },
    tunnelDeps: { spawn, sshPath: 'ssh', timing: T, fetch: (url) => fetch(url.replace('https://pub.example/fc', `http://127.0.0.1:${port}/fc`)) }
  });
  ma.captureIpc(ipc);
  ma.registerIpc(ipc);
  ma.attachWindow({ isDestroyed: () => false, webContents: { send: () => {} } });
  const call = (ch, ...a) => ipc.map.get(ch)({ sender: { id: 1 } }, ...a);
  try {
    await ma.apply();
    // ping：子路径下也能打到，免凭证，只有 id
    const ping = await (await fetch(`http://127.0.0.1:${port}/fc-mobile/api/ping`)).json();
    assert.equal(Object.keys(ping).sort().join(), 'fc,ok');

    // 没开外网：分享链接是本机地址；没有起 ssh
    let st = await call('finalcheck:mobile:state');
    assert.equal(st.shareKind, 'local');
    assert.equal(spawned.length, 0);

    // 参数不合法的拒掉
    assert.equal((await call('finalcheck:mobile:set', { tunnel: { enabled: true, target: '-oProxyCommand=calc' } })).ok, false);
    assert.equal((await call('finalcheck:mobile:set', { tunnel: { publicUrl: 'ftp://x' } })).ok, false);
    assert.equal(spawned.length, 0);

    // 打开外网：起 ssh，验证走 ping 回到本机 → up；配对链接 = 公网地址
    const r = await call('finalcheck:mobile:set', { tunnel: { enabled: true, target: 'my-server', remotePort: 7788, publicUrl: 'https://pub.example/fc/' } });
    assert.equal(r.ok, true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].args.at(-1), 'my-server');
    assert.equal(spawned[0].args[spawned[0].args.indexOf('-R') + 1], `127.0.0.1:7788:127.0.0.1:${port}`);
    assert.ok(await until(() => ma.publicState().tunnel.status === 'up'), '公网验证通过');
    const code = await call('finalcheck:mobile:pair-code');
    assert.equal(code.kind, 'internet');
    assert.equal(code.url, `https://pub.example/fc/pair?t=${code.code}`);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'mobile-access.json'), 'utf8'));
    assert.deepEqual(saved.tunnel, { enabled: true, target: 'my-server', remotePort: 7788, publicUrl: 'https://pub.example/fc' });

    // 手机在线：走隧道来的请求（本机地址 + X-Forwarded-For）记成「外网」
    const { bearer } = await (await fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: code.code, deviceId: 'd1', deviceName: 'iPhone' }) })).json();
    await fetch(`http://127.0.0.1:${port}/api/whoami`, { headers: { authorization: 'Bearer ' + bearer, 'x-forwarded-for': '1.2.3.4' } });
    st = ma.publicState();
    assert.equal(st.device.deviceName, 'iPhone');
    assert.equal(st.device.via, 'internet');
    assert.ok(st.device.lastSeenAt > 0);
    assert.equal(st.device.online, false, '没开事件流 = 不算在线');

    // 开机自启
    assert.equal(st.autostart, false);
    assert.equal((await call('finalcheck:mobile:autostart', true)).state.autostart, true);
    assert.equal(login, true);

    // 关掉外网：ssh 被结束
    await call('finalcheck:mobile:set', { tunnel: { enabled: false } });
    assert.ok(spawned[0].killed);
    assert.equal(ma.publicState().tunnel.status, 'off');
    assert.equal(ma.publicState().shareKind, 'local');
  } finally { await ma.stop(); }
});
