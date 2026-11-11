import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { createBackup, redactConfig, scrubText } from '../scripts/backup.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-backup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function readZip(buf) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD signature');
  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central signature');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtra;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nameLen;
  }
  return out;
}

test('backup: 生成 zip、config 与 session 脱敏、包含数据库、保留份数生效', async (t) => {
  const dir = await tmp(t);
  const profile = path.join(dir, 'profile');
  const project = path.join(dir, 'project');
  const out = path.join(dir, 'out');
  await mkdir(path.join(profile, 'sessions'), { recursive: true });
  await mkdir(path.join(profile, 'memory'), { recursive: true });
  await mkdir(path.join(project, '.finalcheck'), { recursive: true });
  const fakeKey = ['sk', 'live', 'synthetic', 'backup', 'key'].join('-');
  await writeFile(path.join(profile, 'config.json'), JSON.stringify({
    activeProviderId: 'p1',
    providers: [{ id: 'p1', apiKey: fakeKey, baseUrl: 'https://example.com' }],
  }));
  await writeFile(path.join(profile, 'sessions', 's1.json'), JSON.stringify({ note: `token=${fakeKey}` }));
  await writeFile(path.join(profile, 'memory', 'm1.md'), 'remember this');
  await writeFile(path.join(project, '.finalcheck', 'finalcheck.db'), 'SQLite format 3\0not-a-real-db');

  const res = await createBackup({ outDir: out, profileDir: profile, projectDir: project, keep: 1, now: new Date('2026-11-11T10:20:30') });
  assert.ok(res.zipPath.endsWith('finalcheck-backup-20261111-102030.zip'));
  const buf = await readFile(res.zipPath);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const entries = readZip(buf);
  assert.ok(entries.has('MANIFEST.json'));
  assert.ok(entries.has('profile/config.json'));
  assert.ok(entries.has('profile/sessions/s1.json'));
  assert.ok(entries.has('profile/memory/m1.md'));
  assert.ok(entries.has('project/finalcheck.db'));
  const cfg = entries.get('profile/config.json').toString('utf8');
  assert.ok(cfg.includes('[REDACTED]'), 'apiKey must be redacted in the archive');
  assert.equal(cfg.includes(fakeKey), false, 'raw key must never enter the archive');
  const session = entries.get('profile/sessions/s1.json').toString('utf8');
  assert.ok(session.includes('[REDACTED]'), 'session text must be scrubbed');
  assert.equal(session.includes(fakeKey), false);

  // 第二份备份（更晚）保留 1 份 → 第一份被清掉
  const res2 = await createBackup({ outDir: out, profileDir: profile, projectDir: project, keep: 1, now: new Date('2026-11-11T10:21:30') });
  const names = (await readdir(out)).filter((n) => n.endsWith('.zip')).sort();
  assert.deepEqual(names, [path.basename(res2.zipPath)], 'retention must keep only the newest archive');
});

test('backup: redactConfig/scrubText 不误伤普通字段，也不回显密钥', () => {
  const cfg = redactConfig({ activeProviderId: 'p1', providers: [{ apiKey: 'abc', secret: 'x', name: 'provider' }] });
  assert.equal(cfg.activeProviderId, 'p1');
  assert.equal(cfg.providers[0].apiKey, '[REDACTED]');
  assert.equal(cfg.providers[0].secret, '[REDACTED]');
  assert.equal(cfg.providers[0].name, 'provider');
  assert.equal(scrubText('normal text'), 'normal text');
  const fake = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789'].join('_');
  assert.equal(scrubText(`token ${fake}`), 'token [REDACTED]');
});
