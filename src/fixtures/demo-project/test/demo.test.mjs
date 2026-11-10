// 演示项目的两条必过测试：只测纯函数与导出形状，不启动网络、不碰真实数据库。
import test from 'node:test';
import assert from 'node:assert/strict';
import { app, DEMO_CHECKS, normalizePort } from '../app.js';

test('normalizePort 接受合法端口并回退到 3000', () => {
  assert.equal(normalizePort('8080'), 8080);
  assert.equal(normalizePort('0'), 3000);
  assert.equal(normalizePort('not-a-port'), 3000);
});

test('导出 app 形状正确，且演示清单覆盖三类高危', () => {
  assert.equal(typeof app.get, 'function');
  assert.equal(typeof app.use, 'function');
  assert.ok(DEMO_CHECKS.length >= 3);
  assert.ok(DEMO_CHECKS.some((item) => item.startsWith('S1:')));
  assert.ok(DEMO_CHECKS.some((item) => item.startsWith('S2.sqli-concat:')));
  assert.ok(DEMO_CHECKS.some((item) => item.startsWith('S3.secret-literal:')));
});
