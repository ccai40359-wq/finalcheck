import { test } from 'node:test';
import assert from 'node:assert/strict';
import server from './fixtures/dynamic-target/app.mjs';
import spaServer from './fixtures/dynamic-spa/app.mjs';
import { probeTarget } from '../src/dynamic/probe.mjs';
import { stressTarget } from '../src/dynamic/stress.mjs';

// 并行整套测试时，Windows 上偶发一次 fetch failed（端口复用时 undici 的旧 keep-alive 连接）；
// 这只影响测试稳定性，探测本身仍会如实报 unreachable。用一次重试消除抖动。
async function probeStable(base) {
  for (let i = 0; i < 3; i++) {
    const out = await probeTarget(base);
    const rows = out.results.filter((r) => r.kind === 'unauth-access');
    if (rows.some((r) => r.status !== null)) return out;
    await new Promise((r) => setTimeout(r, 120));
  }
  return probeTarget(base);
}

test('probe: 无守卫接口复现 + CORS 反射 + 安全头缺失', async (t) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const out = await probeStable(base);
  const users = out.results.find((r) => r.path === '/api/users');
  assert.equal(users.reproduced, false);
  assert.equal(users.accessible, true, 'anonymous accessibility is a signal, not proof of an authorization defect');
  assert.equal(users.status, 200);
  const cors = out.results.find((r) => r.kind === 'cors');
  assert.equal(cors.reflected, true);
  const headers = out.results.find((r) => r.kind === 'security-headers');
  assert.ok(headers.missing.includes('x-frame-options'));
  assert.ok(headers.missing.includes('content-security-policy'));
});

test('stress: 2 秒温和压测产出结构完整', async (t) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const out = await stressTarget(base + '/api/users', { duration: 2, connections: 5 });
  assert.ok(out.rpsAvg > 0);
  assert.equal(out.connections, 5);
  assert.equal(out.duration, 2);
  assert.ok('statusCodes' in out);
  // 自食教训：autocannon 没有 p95；字段必须是真实的 p97_5，而不是永远 null
  assert.equal(typeof out.p97_5LatencyMs, 'number');
  assert.ok(out.p97_5LatencyMs >= 0);
});

test('stress: 5xx 计入错误数（autocannon 没有 non2xx3xx 字段，别把 4xx/5xx 漏掉）', async (t) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const out = await stressTarget(base + '/api/fail', { duration: 2, connections: 5 });
  assert.ok(out.errors >= 1, '500 响应应计入 errors');
  assert.ok(Object.keys(out.statusCodes).some((k) => String(k).startsWith('5')), '状态码分布里应有 5xx');
});

test('probe: SPA 兜底页（任何路径 200 + index.html）不再假阳', async (t) => {
  await new Promise((r) => spaServer.listen(0, '127.0.0.1', r));
  t.after(() => spaServer.close());
  const base = 'http://127.0.0.1:' + spaServer.address().port;
  const out = await probeStable(base);
  const rows = out.results.filter((r) => r.kind === 'unauth-access');
  const get = (p) => rows.find((r) => r.path === p);

  // 与首页同一份 HTML 外壳 → 不是接口数据
  assert.equal(get('/api/users').reproduced, false);
  assert.match(get('/api/users').note, /SPA|外壳/);
  assert.equal(get('/api/config').reproduced, false);

  // 真调试页保留可访问线索，公开意图与敏感性仍需确认。
  assert.equal(get('/debug').reproduced, false);
  assert.equal(get('/debug').accessible, true);

  // 401 / 302 都不算复现，且 302 要留下目标
  assert.equal(get('/api/admin').reproduced, false);
  assert.equal(get('/api/orders').reproduced, false);
  assert.match(get('/api/orders').note, /302/);
});

test('probe: 200 + 未授权错误 JSON 不算复现', async (t) => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/api/')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"error":"unauthorized"}');
      return;
    }
    res.statusCode = 404;
    res.end('nf');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.address().port;
  const out = await probeStable(base);
  const rows = out.results.filter((r) => r.kind === 'unauth-access');
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.reproduced === false));
});
