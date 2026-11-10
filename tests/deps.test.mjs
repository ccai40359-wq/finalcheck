import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { interpretAuditOutput, buildAuditArgs, resolveNodeTooling } from '../src/checks/deps.mjs';

test('S4: registry 未实现审计端点 → 识别为可回退，而不是 0 漏洞', () => {
  const mirror = JSON.stringify({
    message: '404 Not Found - POST https://registry.npmmirror.com/-/npm/v1/security/advisories/bulk - [NOT_IMPLEMENTED]',
    method: 'POST',
    uri: 'https://registry.npmmirror.com/-/npm/v1/security/advisories/bulk',
  });
  assert.equal(interpretAuditOutput(mirror).kind, 'endpoint-unsupported');
});

test('S4: 认证/网络类错误不回退，如实报 gap', () => {
  assert.equal(interpretAuditOutput(JSON.stringify({ error: { code: 'E401', summary: 'Unauthorized' } })).kind, 'error');
  assert.equal(interpretAuditOutput(JSON.stringify({ message: 'connect ECONNREFUSED 127.0.0.1:443' })).kind, 'error');
});

test('S4: 正常报告可解析；缺 vulnerabilities 一律当失败', () => {
  const ok = interpretAuditOutput(JSON.stringify({ vulnerabilities: { lodash: { severity: 'high', range: '<4.17.21' } } }));
  assert.equal(ok.kind, 'ok');
  assert.equal(Object.keys(ok.vulnerabilities).length, 1);
  const clean = interpretAuditOutput(JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }));
  assert.equal(clean.kind, 'ok');
  assert.equal(Object.keys(clean.vulnerabilities).length, 0);
  assert.equal(interpretAuditOutput('{}').kind, 'error');
  assert.equal(interpretAuditOutput('{"statusCode":404}').kind, 'error');
  assert.equal(interpretAuditOutput('not json').kind, 'invalid');
  assert.equal(interpretAuditOutput('').kind, 'invalid');
});

test('S4: 只有回退时才追加 --registry', () => {
  assert.deepEqual(buildAuditArgs(), ['audit', '--json', '--package-lock-only']);
  assert.ok(buildAuditArgs({ registry: 'https://registry.npmjs.org' }).includes('--registry=https://registry.npmjs.org'));
});

test('S4: 桌面端（execPath 不是 node）从 PATH 找 node + npm-cli', () => {
  const node = path.join('/opt/node/bin', 'node');
  const t = resolveNodeTooling({
    execPath: 'C:/Program Files/FinalCheck/FinalCheck.exe',
    env: { PATH: '/opt/node/bin' },
    platform: 'linux',
    exists: (p) => p === node || p.endsWith('npm-cli.js'),
  });
  assert.equal(t.node, node);
  assert.equal(t.npmCli, path.join('/opt/node/bin', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
});

test('S4: npm run 场景优先用 npm_execpath', () => {
  const t = resolveNodeTooling({
    execPath: '/usr/bin/node',
    env: { PATH: '/usr/bin', npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' },
    platform: 'linux',
    exists: (p) => ['/usr/bin/node', '/usr/lib/node_modules/npm/bin/npm-cli.js'].includes(p),
  });
  assert.equal(t.npmCli, '/usr/lib/node_modules/npm/bin/npm-cli.js');
  assert.equal(t.node, '/usr/bin/node');
});

test('S4: 完全没有 node/npm 时返回 null（调用方给可读 gap，不静默 clean）', () => {
  const t = resolveNodeTooling({ execPath: 'C:/FinalCheck.exe', env: { PATH: '' }, platform: 'win32', exists: () => false });
  assert.equal(t.node, null);
  assert.equal(t.npmCli, null);
});
