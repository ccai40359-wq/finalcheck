import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  redactConfig,
  collectApiKeys,
  scrubSecrets,
  readLastErrors,
  buildDiagnostics,
  hooksFilePath
} from '../desktop/src/main/diagnostics.mjs';

async function tmpDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-diag-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('diagnostics: 配置脱敏——apiKey/api_key 一律替换为 ***，不改原对象', () => {
  const cfg = {
    activeModel: 'model-a',
    providers: [
      { id: 'p1', name: '供应商一', baseUrl: 'https://api.example.com', apiKey: 'sk-live-super-secret-123456', models: ['model-a'] },
      { id: 'p2', name: '供应商二', baseUrl: 'https://api2.example.com', api_key: 'nested-key-value', models: [] }
    ],
    deep: { list: [{ APIKEY: 'upper-key-value', keep: 'ok' }] }
  };
  const red = redactConfig(cfg);
  assert.equal(red.providers[0].apiKey, '***');
  assert.equal(red.providers[0].baseUrl, 'https://api.example.com');
  assert.equal(red.providers[0].name, '供应商一');
  assert.equal(red.providers[1].api_key, '***');
  assert.equal(red.deep.list[0].APIKEY, '***');
  assert.equal(red.deep.list[0].keep, 'ok');
  assert.equal(red.activeModel, 'model-a');
  // 原对象不能被改动
  assert.equal(cfg.providers[0].apiKey, 'sk-live-super-secret-123456');
  assert.equal(cfg.providers[1].api_key, 'nested-key-value');

  // 循环引用不崩
  const cyclic = { apiKey: 'x'.repeat(20), self: null };
  cyclic.self = cyclic;
  const safe = redactConfig(cyclic);
  assert.equal(safe.apiKey, '***');
  assert.equal(safe.self, '[circular]');
});

test('diagnostics: 无 config 也不崩，返回完整形状', () => {
  const d = buildDiagnostics();
  assert.deepEqual(Object.keys(d).sort(), [
    'activeModel', 'appVersion', 'arch', 'config', 'electron', 'files',
    'lastErrors', 'node', 'platform', 'providers', 'sessionCount'
  ]);
  assert.deepEqual(d.config, {});
  assert.deepEqual(d.providers, []);
  assert.deepEqual(d.lastErrors, []);
  assert.deepEqual(d.files, { usage: '', hooks: '', sessionsDir: '' });
  assert.equal(d.sessionCount, 0);
  assert.equal(d.activeModel, '');
  assert.equal(typeof d.appVersion, 'string');
});

test('diagnostics: 返回形状与字段来源（providers 名称列表 / activeModel / files）', () => {
  const cfg = {
    activeProviderId: 'p1',
    activeModel: 'model-a',
    providers: [
      { id: 'p1', name: '供应商一', apiKey: 'sk-live-super-secret-123456' },
      { id: 'p2', name: '供应商二', apiKey: 'another-secret-key' }
    ]
  };
  const d = buildDiagnostics({
    appVersion: '0.1.0',
    electron: '33.0.0',
    node: '20.18.0',
    platform: 'win32',
    arch: 'x64',
    config: cfg,
    activeModel: 'model-a',
    sessionCount: 3,
    lastErrors: ['failed: apiKey=sk-live-super-secret-123456'],
    files: { usage: 'C:\\data\\usage.json', hooks: 'C:\\data\\hooks.json', sessionsDir: 'C:\\data\\sessions' }
  });
  assert.equal(d.appVersion, '0.1.0');
  assert.equal(d.electron, '33.0.0');
  assert.equal(d.node, '20.18.0');
  assert.equal(d.platform, 'win32');
  assert.equal(d.arch, 'x64');
  assert.equal(d.activeModel, 'model-a');
  assert.equal(d.sessionCount, 3);
  assert.deepEqual(d.providers, ['供应商一', '供应商二']);
  assert.deepEqual(d.files, { usage: 'C:\\data\\usage.json', hooks: 'C:\\data\\hooks.json', sessionsDir: 'C:\\data\\sessions' });
  assert.equal(d.config.providers[0].apiKey, '***');
  assert.equal(d.config.providers[1].apiKey, '***');

  // 导出的 JSON 里绝不能出现 apiKey 原文
  const json = JSON.stringify(d);
  assert.ok(!json.includes('sk-live-super-secret-123456'));
  assert.ok(!json.includes('another-secret-key'));
  assert.match(d.lastErrors[0], /apiKey=\*\*\*/);

  // providers 可由 config 推导；lastErrors 非数组时为空
  const derived = buildDiagnostics({ config: cfg });
  assert.deepEqual(derived.providers, ['供应商一', '供应商二']);
  assert.deepEqual(derived.lastErrors, []);
});

test('diagnostics: 字符串兜底抹除 sk-/Bearer 令牌与已知密钥', () => {
  assert.equal(scrubSecrets('token sk-abcdefgh12345678 end', []).includes('sk-abcdefgh'), false);
  assert.equal(scrubSecrets('Authorization: Bearer abcdefgh12345678', []), 'Authorization: Bearer ***');
  const secrets = collectApiKeys({ providers: [{ apiKey: 'plain-secret-value' }, { nested: { api_key: 'other-secret-value' } }] });
  assert.deepEqual(secrets.sort(), ['other-secret-value', 'plain-secret-value']);
  assert.equal(scrubSecrets('contains plain-secret-value here', secrets), 'contains *** here');
});

test('diagnostics: readLastErrors 取日志末尾 5 条；不可读返回空数组', async (t) => {
  const dir = await tmpDir(t);
  const logFile = path.join(dir, 'main.log');
  const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1} sk-logsecret123456`);
  await writeFile(logFile, lines.join('\r\n') + '\r\n\r\n', 'utf8');
  const last = await readLastErrors(logFile, { secrets: ['sk-logsecret123456'] });
  assert.equal(last.length, 5);
  assert.equal(last[0], 'line-6 ***');
  assert.equal(last[4], 'line-10 ***');

  assert.deepEqual(await readLastErrors(path.join(dir, 'missing.log')), []);
  assert.deepEqual(await readLastErrors(''), []);
});

test('diagnostics: hooksFilePath 支持 env 覆盖', () => {
  const old = process.env.FINALCHECK_HOOKS_FILE;
  process.env.FINALCHECK_HOOKS_FILE = path.join(os.tmpdir(), 'custom-hooks.json');
  try {
    assert.equal(hooksFilePath(), path.resolve(os.tmpdir(), 'custom-hooks.json'));
  } finally {
    if (old === undefined) delete process.env.FINALCHECK_HOOKS_FILE;
    else process.env.FINALCHECK_HOOKS_FILE = old;
  }
});
