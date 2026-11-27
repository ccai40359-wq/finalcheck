// 0.35 手机访问：手机和电脑连同一个引擎。这里测「同步判断」纯函数 + 主进程服务的配对 / 票据 / 调用 / 事件镜像。
// 服务只听 127.0.0.1 的随机端口，状态写进临时目录，不碰真实数据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

import { classifyPacket, sameQueue, isOwnSync, selfOrigin } from '../desktop/src/renderer/lib/remote-sync.mjs';
import { createMobileAccess, lanAddresses, maskConfig, restoreKeys, phoneDenyReason, KEY_MASK, encodeOut, decodeIn } from '../desktop/src/main/mobile/mobile-access.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mobile-access-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('classifyPacket：自己的回合照常、别人的回合按是否正看着接上或只转圈', () => {
  const own = new Set(['r-own']);
  assert.equal(classifyPacket({ sid: null }), 'own');
  assert.equal(classifyPacket({ sid: 's', runId: 'r1', kind: 'text', run: { runId: 'r1' } }), 'own');
  assert.equal(classifyPacket({ sid: 's', runId: 'r1', kind: 'text', inflight: true }), 'own');
  assert.equal(classifyPacket({ sid: 's', runId: 'r2', kind: 'text', active: true, ownRunIds: own }), 'attach');
  assert.equal(classifyPacket({ sid: 's', runId: 'r2', kind: 'text', active: false, ownRunIds: own }), 'mark-running');
  assert.equal(classifyPacket({ sid: 's', runId: 'r-own', kind: 'text', active: true, ownRunIds: own }), 'ignore', '自己刚结束回合的迟到包');
  assert.equal(classifyPacket({ sid: 's', runId: 'r2', kind: 'run-settled', run: { reattached: true } }), 'settle-reattached');
  assert.equal(classifyPacket({ sid: 's', runId: 'r2', kind: 'run-settled', active: true, ownRunIds: own }), 'remote-settled');
  assert.equal(classifyPacket({ sid: 's', runId: 'r2', kind: 'run-settled', active: false, ownRunIds: own }), 'mark-idle');
  assert.equal(classifyPacket({ sid: 's', runId: 'r-own', kind: 'run-settled', active: true, ownRunIds: own }), 'ignore');
});

test('sameQueue 不看「待发送」标记；isOwnSync / selfOrigin', () => {
  assert.ok(sameQueue([{ text: 'a', hold: true }], [{ text: 'a' }]));
  assert.ok(!sameQueue([{ text: 'a' }], [{ text: 'b' }]));
  assert.ok(sameQueue(null, []));
  assert.ok(isOwnSync({ origin: 'phone' }, 'phone'));
  assert.ok(!isOwnSync({ origin: 'desktop' }, 'phone'));
  assert.equal(selfOrigin({ __FC_MOBILE__: true }), 'phone');
  assert.equal(selfOrigin({}), 'desktop');
});

test('maskConfig 不下发 Key；restoreKeys 只在网关地址没变时换回原 Key', () => {
  const old = { providers: [{ id: 'a', baseUrl: 'https://gw.example/v1', apiKey: 'sk-real' }], webSearch: { provider: 'tavily', apiKey: 'tv-real' } };
  const m = maskConfig(old);
  assert.equal(m.providers[0].apiKey, KEY_MASK);
  assert.equal(m.webSearch.apiKey, KEY_MASK);
  assert.equal(old.providers[0].apiKey, 'sk-real', '不改原对象');
  assert.equal(restoreKeys(m, old).providers[0].apiKey, 'sk-real');
  assert.equal(restoreKeys(m, old).webSearch.apiKey, 'tv-real');
  const moved = { ...m, providers: [{ ...m.providers[0], baseUrl: 'https://evil.example/v1' }] };
  assert.equal(restoreKeys(moved, old).providers[0].apiKey, '', '改了网关地址，原 Key 不跟过去');
});

test('phoneDenyReason：hooks / 手机访问设置 / 内嵌浏览器 / 安装更新挡掉，普通调用放行', () => {
  assert.ok(phoneDenyReason('finalcheck:hooks-save'));
  assert.ok(phoneDenyReason('finalcheck:mobile:set'));
  assert.ok(phoneDenyReason('finalcheck:browser-goto'));
  assert.equal(phoneDenyReason('finalcheck:rail-rect'), '', '布局自动调用静默返回空，不报错');
  assert.equal(phoneDenyReason('finalcheck:browser-tabs'), '');
  assert.equal(phoneDenyReason('finalcheck:browser-session-info'), null);
  assert.ok(phoneDenyReason('finalcheck:update:install'));
  assert.equal(phoneDenyReason('finalcheck:window-ctl'), '');
  assert.equal(phoneDenyReason('finalcheck:agent-chat'), null);
});

test('encodeOut / decodeIn 往返二进制，丢掉原型污染键', () => {
  const v = decodeIn(JSON.parse(JSON.stringify(encodeOut({ b: Buffer.from('hi'), n: [1, { x: 2 }] }))));
  assert.equal(v.b.toString(), 'hi');
  assert.deepEqual(v.n, [1, { x: 2 }]);
  const bad = decodeIn(JSON.parse('{"__proto__":{"polluted":1},"ok":1}'));
  assert.equal({}.polluted, undefined);
  assert.equal(bad.ok, 1);
});

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('服务：配对码一次性、凭证调用、手机发起的改动通知电脑、事件流票据一次性且推送窗口事件', async () => {
  const port = await freePort();
  const staticDir = path.join(tmp, 'static');
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>m</title>');
  const configFile = path.join(tmp, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ providers: [{ id: 'a', baseUrl: 'https://gw.example/v1', apiKey: 'sk-real' }] }));

  const ipc = { map: new Map(), handle(ch, fn) { this.map.set(ch, fn); }, removeHandler(ch) { this.map.delete(ch); } };
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } };
  const ma = createMobileAccess({ dataRoot: path.join(tmp, 'data'), staticDir, configFile: () => configFile, env: { FINALCHECK_MOBILE_PORT: String(port) } });
  ma.captureIpc(ipc);
  ipc.handle('finalcheck:get-config', () => JSON.parse(fs.readFileSync(configFile, 'utf8')));
  ipc.handle('finalcheck:sessions:new', (_e, opts) => ({ id: 'new-' + (opts?.title || 'x') }));
  ipc.handle('finalcheck:whoami-test', (e) => (e.fromPhone ? 'phone' : 'desktop'));
  ma.registerIpc(ipc);
  ma.attachWindow(win);
  const st = await ma.apply();
  try {
    assert.equal(st.running, true);
    assert.equal(st.built, true);
    const base = `http://127.0.0.1:${port}`;
    const post = (p, body, bearer) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, body: JSON.stringify(body) });

    assert.equal((await fetch(base + '/')).status, 200, '网页');
    assert.equal((await post('/api/rpc', { channel: 'finalcheck:get-config', args: [] })).status, 401, '没配对不能调');

    const code = await ipc.map.get('finalcheck:mobile:pair-code')();
    assert.ok(code.ok && code.code);
    const paired = await (await post('/api/pair', { token: code.code, deviceId: 'd1', deviceName: 'test' })).json();
    assert.ok(paired.ok && paired.bearer, JSON.stringify(paired));
    assert.equal((await post('/api/pair', { token: code.code, deviceId: 'd1' })).status, 403, '配对码只能用一次');
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'mobile-access.json'), 'utf8'));
    assert.ok(!JSON.stringify(raw).includes(paired.bearer), '凭证只存哈希');

    const rpc = async (channel, args = []) => (await post('/api/rpc', { channel, args }, paired.bearer)).json();
    const cfg = await rpc('finalcheck:get-config');
    assert.equal(cfg.result.providers[0].apiKey, KEY_MASK, '手机拿不到 Key');
    const denied = await rpc('finalcheck:mobile:set', [{ enabled: false }]);
    assert.equal(denied.ok, false, '手机改不了手机访问设置');
    assert.match(denied.error, /电脑/);
    assert.equal((await rpc('finalcheck:whoami-test')).result, 'phone');

    sent.length = 0;
    const made = await rpc('finalcheck:sessions:new', [{ title: 'p' }]);
    assert.equal(made.result.id, 'new-p');
    const sync = sent.find(([ch]) => ch === 'finalcheck:sync');
    assert.ok(sync, '电脑收到同步通知');
    assert.equal(sync[1].scope, 'sessions');
    assert.equal(sync[1].origin, 'phone');

    // 事件流：票据换连接；票据用过就作废
    const { ticket } = await (await post('/api/events-ticket', {}, paired.bearer)).json();
    assert.ok(ticket);
    const got = await new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/events?ticket=${ticket}`, (res) => {
        assert.equal(res.statusCode, 200);
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          const m = buf.match(/data: (\{"channel":"finalcheck:agent-event".*)\n/);
          if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
        });
        // 连上之后电脑窗口收到一条事件 → 手机也收到
        setTimeout(() => win.webContents.send('finalcheck:agent-event', { sessionId: 's1', ev: { kind: 'text', text: 'hi' } }), 50);
        setTimeout(() => win.webContents.send('finalcheck:wakeup-due', { id: 'w' }), 30);
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
      setTimeout(() => reject(new Error('事件没推到手机')), 5000);
    });
    assert.equal(got.payload.ev.text, 'hi');
    assert.equal((await fetch(`${base}/api/events?ticket=${ticket}`)).status, 401, '票据只能用一次');

    // 审批：手机点了，电脑收到 resolved
    ipc.handle('finalcheck:approval-decide', () => ({ ok: true }));
    sent.length = 0;
    await rpc('finalcheck:approval-decide', ['call-1', 'allow']);
    assert.ok(sent.some(([ch, p]) => ch === 'finalcheck:approval-resolved' && p.callId === 'call-1' && p.origin === 'phone'));

    // 命令行生成配对码（远程 SSH 时用）：写进数据目录，能直接拿去配对
    const filed = ma.writePairCodeFile();
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'mobile-pair-code.json'), 'utf8'));
    assert.equal(onDisk.code, filed.code);
    const paired2 = await (await post('/api/pair', { token: onDisk.code, deviceId: 'd1', deviceName: 'test' })).json();
    assert.ok(paired2.ok, '文件里的配对码能用');

    // 解除绑定：旧凭证立即失效
    await ipc.map.get('finalcheck:mobile:unpair')();
    assert.equal((await post('/api/rpc', { channel: 'finalcheck:get-config', args: [] }, paired.bearer)).status, 401);
  } finally {
    await ma.stop();
  }
});

test('lanAddresses：虚拟网卡不列，真实 Wi-Fi 排在电脑热点前面', () => {
  const v4 = (address) => [{ family: 'IPv4', internal: false, address }];
  const got = lanAddresses({
    'VMware Network Adapter VMnet8': v4('192.168.52.1'),
    'vEthernet (WSL (Hyper-V firewall))': v4('172.29.48.1'),
    'WLAN 3': v4('192.168.137.1'),
    'WLAN 2': v4('169.254.18.21'),
    'WLAN': v4('192.168.1.23'),
    '蓝牙网络连接': v4('169.254.133.143'),
    'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }]
  });
  assert.deepEqual(got.map((a) => a.address), ['192.168.1.23', '192.168.137.1']);
  assert.equal(got[1].hotspot, true);
});
