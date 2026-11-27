// 0.35 手机访问：两端各自的「当前项目」互不干扰；大事件不进事件流（占位 + 单独取，gzip）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';

import { createMobileAccess } from '../desktop/src/main/mobile/mobile-access.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-mobile-proj-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function setup() {
  const port = await freePort();
  const staticDir = path.join(tmp, 'static-' + port);
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>m</title>' + 'x'.repeat(5000));
  const ipc = { map: new Map(), handle(ch, fn) { this.map.set(ch, fn); }, removeHandler(ch) { this.map.delete(ch); } };
  const win = { isDestroyed: () => false, webContents: { send: () => {} } };
  const ma = createMobileAccess({ dataRoot: path.join(tmp, 'data-' + port), staticDir, configFile: () => path.join(tmp, 'none.json'), env: { FINALCHECK_MOBILE_PORT: String(port) } });
  ma.captureIpc(ipc);
  // 主进程只有一个全局「当前项目」：和真实 backend 一样
  const global = { project: 'A', switches: 0 };
  const sessionsOf = { A: ['a1', 'a2'], B: ['b1'] };
  ipc.handle('finalcheck:projects:current', () => global.project);
  ipc.handle('finalcheck:projects:select', async (_e, id) => { await new Promise((r) => setTimeout(r, 5)); global.project = id; global.switches++; return { id }; });
  ipc.handle('finalcheck:sessions:list', async () => { await new Promise((r) => setTimeout(r, 5)); return sessionsOf[global.project]; });
  ipc.handle('finalcheck:sessions:open', (_e, id) => ({ id }));
  ipc.handle('finalcheck:sessions:new', async (_e, title) => { await new Promise((r) => setTimeout(r, 5)); return { id: title, project: global.project }; });
  ma.registerIpc(ipc);
  ma.attachWindow(win);
  await ma.apply();
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, bearer, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...headers }, body: JSON.stringify(body) });
  const code = await ipc.map.get('finalcheck:mobile:pair-code')();
  const { bearer } = await (await post('/api/pair', { token: code.code, deviceId: 'd', deviceName: 't' })).json();
  const rpc = async (channel, args = []) => (await post('/api/rpc', { channel, args }, bearer)).json();
  const desk = (channel, ...args) => ipc.map.get(channel)({ sender: { id: 1 } }, ...args);
  return { ma, ipc, win, global, base, post, bearer, rpc, desk };
}

test('手机切到别的项目，电脑的当前项目和会话列表不受影响（反过来也一样）', async () => {
  const s = await setup();
  try {
    // 只有电脑在用：完全不介入
    assert.deepEqual(await s.desk('finalcheck:sessions:list'), ['a1', 'a2']);
    assert.equal(s.global.switches, 0);

    // 手机点开 B 项目的会话
    await s.rpc('finalcheck:projects:select', ['B']);
    assert.deepEqual((await s.rpc('finalcheck:sessions:list')).result, ['b1']);
    // 电脑还在 A：列出来的是 A 的会话，不是 B 的
    assert.deepEqual(await s.desk('finalcheck:sessions:list'), ['a1', 'a2']);
    assert.equal(await s.desk('finalcheck:projects:current'), 'A');
    assert.equal((await s.rpc('finalcheck:projects:current')).result, 'B');

    // 两端同时刷新：各拿各的
    const [d, p] = await Promise.all([s.desk('finalcheck:sessions:list'), s.rpc('finalcheck:sessions:list')]);
    assert.deepEqual(d, ['a1', 'a2']);
    assert.deepEqual(p.result, ['b1']);

    // 电脑切到 B、手机切回 A：同样互不影响
    await s.desk('finalcheck:projects:select', 'B');
    await s.rpc('finalcheck:projects:select', ['A']);
    assert.deepEqual(await s.desk('finalcheck:sessions:list'), ['b1']);
    assert.deepEqual((await s.rpc('finalcheck:sessions:list')).result, ['a1', 'a2']);
  } finally { await s.ma.stop(); }
});

test('重启后服务端不记得手机在哪个项目：手机新建会话带着项目 id，仍建在手机的项目里，电脑不受影响', async () => {
  const s = await setup(); // 新实例 = 刚重启：projectOf 全空，全局当前项目是电脑的 A
  try {
    const made = (await s.rpc('finalcheck:sessions:new', ['手机的新会话', 'B'])).result;
    assert.equal(made.project, 'B', '建在手机所在的 B 项目');
    // 电脑接着在 A 里新建 / 列会话：还是 A
    const deskMade = await s.desk('finalcheck:sessions:new', '电脑的新会话', 'A');
    assert.equal(deskMade.project, 'A');
    assert.deepEqual(await s.desk('finalcheck:sessions:list'), ['a1', 'a2']);
    // 老界面不带项目 id（只有电脑在用）：照旧建在当前项目
    const legacy = await s.desk('finalcheck:sessions:new', '老调用');
    assert.equal(legacy.project, 'A');
  } finally { await s.ma.stop(); }
});

test('大事件不进事件流：流里只有占位，按 seq 单独取（gzip）；小事件照常', async () => {
  const s = await setup();
  try {
    const { ticket } = await (await s.post('/api/events-ticket', {}, s.bearer)).json();
    const frames = await new Promise((resolve, reject) => {
      const got = [];
      const req = http.get(`${s.base}/api/events?ticket=${ticket}`, (res) => {
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          for (const m of buf.matchAll(/data: (\{.*\})\n/g)) if (!got.includes(m[1])) got.push(m[1]);
          if (got.filter((x) => !x.includes('"ka"')).length >= 2) { req.destroy(); resolve(got.map((x) => JSON.parse(x))); }
        });
        setTimeout(() => {
          s.win.webContents.send('finalcheck:agent-event', { sessionId: 's', ev: { kind: 'tool-end', image: 'A'.repeat(300 * 1024) } });
          s.win.webContents.send('finalcheck:agent-event', { sessionId: 's', ev: { kind: 'text', text: 'small' } });
        }, 50);
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
      setTimeout(() => reject(new Error('没收到事件')), 5000);
    });
    const [bigStub, small] = frames.filter((f) => !f.ka);
    assert.ok(bigStub.big > 300 * 1024 && !bigStub.payload, '大事件只发占位');
    assert.equal(small.payload.ev.text, 'small');

    const r = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ seq: bigStub.seq });
      const req = http.request(`${s.base}/api/event`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip', authorization: 'Bearer ' + s.bearer } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ enc: res.headers['content-encoding'], raw: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(r.enc, 'gzip');
    assert.ok(r.raw.length < 20 * 1024, '压缩后很小：' + r.raw.length);
    const full = JSON.parse(zlib.gunzipSync(r.raw).toString('utf8'));
    assert.equal(full.payload.ev.image.length, 300 * 1024);
    assert.equal(full.channel, 'finalcheck:agent-event');

    const page = await fetch(s.base + '/', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(page.headers.get('content-encoding'), 'gzip', '网页也压缩');
  } finally { await s.ma.stop(); }
});
