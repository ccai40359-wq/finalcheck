// 纯函数测试：better-sqlite3 预编译包的 SHA256 校验与清单查找（不联网、不解压）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  sha256File,
  verifySha256,
  manifestKey,
  lookupSha256,
  resolveExpectedSha256,
  loadManifest,
  MANIFEST_FILE,
} from '../desktop/scripts/ensure-sqlite-binding.mjs';

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sqlite-hash-test-'));
  const file = path.join(dir, 'sample.bin');
  fs.writeFileSync(file, content);
  return { dir, file };
}

test('sha256File 计算与 crypto 一致（已知向量 abc）', () => {
  const { dir, file } = tmpFile('abc');
  try {
    assert.equal(sha256File(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifySha256 对正确 hash 通过（大小写不敏感）', () => {
  const { dir, file } = tmpFile('hello better-sqlite3');
  const expected = crypto.createHash('sha256').update('hello better-sqlite3').digest('hex');
  try {
    assert.equal(verifySha256(file, expected), true);
    assert.equal(verifySha256(file, expected.toUpperCase()), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifySha256 对错误 hash 抛错', () => {
  const { dir, file } = tmpFile('tampered');
  try {
    assert.throws(
      () => verifySha256(file, '0'.repeat(64)),
      /SHA256 校验失败/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifySha256 在清单缺失/格式非法时 fail closed', () => {
  const { dir, file } = tmpFile('unverified');
  try {
    for (const bad of [undefined, null, '', 'not-a-hash', 'abc123']) {
      assert.throws(
        () => verifySha256(file, bad),
        /无固定 hash，拒绝未验证预编译包/
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manifestKey 采用 version|runtime|abi|platform 键格式', () => {
  assert.equal(
    manifestKey({ version: '12.11.1', runtime: 'electron', abi: 130, platform: 'win32-x64' }),
    '12.11.1|electron|130|win32-x64'
  );
  assert.equal(
    manifestKey({ version: '12.11.1', runtime: 'node', abi: 137, platform: 'linuxmusl-x64' }),
    '12.11.1|node|137|linuxmusl-x64'
  );
});

test('lookupSha256 命中返回 hash，未命中返回 null', () => {
  const manifest = {
    '12.11.1|electron|130|win32-x64': 'EF294BD3BC46ED90ECC544DE43A833D7E0EEF78B1CFBA2369BBDC5670C1FA78A',
  };
  const hit = lookupSha256(manifest, { version: '12.11.1', runtime: 'electron', abi: 130, platform: 'win32-x64' });
  assert.equal(hit.key, '12.11.1|electron|130|win32-x64');
  assert.equal(hit.sha256, 'ef294bd3bc46ed90ecc544de43a833d7e0eef78b1cfba2369bbdc5670c1fa78a');

  const missEl = lookupSha256(manifest, { version: '12.11.1', runtime: 'electron', abi: 999, platform: 'win32-x64' });
  assert.equal(missEl.sha256, null);

  const missVersion = lookupSha256(manifest, { version: '12.12.0', runtime: 'electron', abi: 130, platform: 'win32-x64' });
  assert.equal(missVersion.sha256, null);

  const missNode = lookupSha256(manifest, { version: '12.11.1', runtime: 'node', abi: 130, platform: 'win32-x64' });
  assert.equal(missNode.sha256, null);

  const invalid = lookupSha256({ '12.11.1|node|137|win32-x64': 'zzz' }, { version: '12.11.1', runtime: 'node', abi: 137, platform: 'win32-x64' });
  assert.equal(invalid.sha256, null);
});

test('resolveExpectedSha256 缺失清单组合默认 fail closed', () => {
  const combo = { version: '12.11.1', runtime: 'node', abi: 137, platform: 'win32-x64' };
  assert.throws(
    () => resolveExpectedSha256({}, combo),
    (err) => /无固定 hash，拒绝未验证预编译包/.test(err.message)
      && err.message.includes('12.11.1|node|137|win32-x64')
  );
});

test('resolveExpectedSha256 仅在显式 allowUnverified 时放行（sha256 仍为 null）', () => {
  const combo = { version: '12.11.1', runtime: 'node', abi: 137, platform: 'win32-x64' };
  const bypass = resolveExpectedSha256({}, combo, { allowUnverified: true });
  assert.equal(bypass.key, '12.11.1|node|137|win32-x64');
  assert.equal(bypass.sha256, null);
  assert.equal(bypass.allowUnverified, true);

  const pinned = resolveExpectedSha256(loadManifest(), combo, { allowUnverified: true });
  assert.match(pinned.sha256, /^[0-9a-f]{64}$/);
  assert.equal(pinned.allowUnverified, false);
});

test('loadManifest 读取真实清单，拒绝缺失/损坏文件', () => {
  const manifest = loadManifest();
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
  assert.ok(Object.keys(manifest).length > 0);
  assert.deepEqual(loadManifest(path.join(os.tmpdir(), 'fc-sqlite-no-such-manifest.json')), {});
});

test('真实清单覆盖当前仓库必需组合且值全为 64 位 hex', () => {
  const manifest = loadManifest(MANIFEST_FILE);
  const required = [
    '12.11.1|electron|130|win32-x64',
    '12.11.1|node|127|win32-x64',
    '12.11.1|node|137|win32-x64',
  ];
  for (const key of required) {
    assert.match(manifest[key] || '', /^[0-9a-f]{64}$/, '清单缺少或 hash 非法：' + key);
  }
  for (const [key, value] of Object.entries(manifest)) {
    assert.equal(key.split('|').length, 4, '键格式错误：' + key);
    assert.match(value, /^[0-9a-f]{64}$/, 'hash 格式错误：' + key);
  }
});
