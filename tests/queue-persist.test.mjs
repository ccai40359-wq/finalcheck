// 排队消息持久化（F8）：重启/切走后队列不能静默丢。
// 存档写 session_meta（不是 message 表）：恢复出来一律 hold=「待发送」，必须用户点发送。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../desktop/package.json', import.meta.url));
const Database = require('better-sqlite3');
const bs3Entry = require.resolve('better-sqlite3');
const nodeBinding = path.join(path.dirname(bs3Entry), '..', 'prebuilds-node', 'better_sqlite3.node');

process.env.FINALCHECK_SESSION_STORE = 'sqlite';
const root = await mkdtemp(path.join(os.tmpdir(), 'fc-queue-persist-'));
process.env.FINALCHECK_SESSIONS_DIR = root;
const sessions = await import('../desktop/src/main/sessions.mjs');

after(async () => {
  sessions.closeAllSessionDatabases();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

const dbIn = (dir) => path.join(dir, 'finalcheck.db');

async function freshDir(t, prefix = 'fc-queue-one-') {
  const dir = await mkdtemp(path.join(root, prefix));
  process.env.FINALCHECK_SESSIONS_DIR = dir;
  t.after(async () => {
    sessions.closeAllSessionDatabases();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

const item = (id, text, extra = {}) => ({ id, text, pasted: [], previews: [], ...extra });

test('排队存档：写入 session_meta 后（模拟重启）读回同一条，且标记为待发送', async (t) => {
  const dir = await freshDir(t);
  const s = await sessions.newSession('排队持久化');
  const list = [item('q1', '第一条'), item('q2', '第二条', { pasted: ['粘贴块'] })];
  assert.deepEqual(await sessions.saveSessionQueue(s.id, list), { id: s.id, count: 2 });

  // 模拟重开 App：关库重开
  sessions.closeAllSessionDatabases();
  const restored = await sessions.loadSessionQueue(s.id);
  assert.deepEqual(restored.map((x) => x.text), ['第一条', '第二条']);
  assert.deepEqual(restored[1].pasted, ['粘贴块']);
  assert.ok(restored.every((x) => x.hold === true), '恢复出来必须是「待发送」，不能自动发');

  // 存档在 session_meta，不在 message 表
  const raw = new Database(dbIn(dir), { nativeBinding: nodeBinding });
  try {
    const row = raw.prepare("SELECT value FROM session_meta WHERE key = ?").get(`queue:${s.id}`);
    assert.ok(row, '排队消息必须写 session_meta');
    const msgs = raw.prepare('SELECT COUNT(*) AS n FROM message WHERE session_id = ?').get(s.id);
    assert.equal(msgs.n, 0, '还没发出的消息不能进 message 表');
  } finally { raw.close(); }
});

test('排队存档：附件预览（base64）不落库，只留路径/名字；空队列入库=清档', async (t) => {
  await freshDir(t);
  const s = await sessions.newSession('附件不落库');
  const previews = [
    { path: 'D:/x/a.png', name: 'a.png', size: 10, preview: 'data:image/png;base64,' + 'A'.repeat(4000) },
    { path: '  ' } // 脏数据：没有路径
  ];
  await sessions.saveSessionQueue(s.id, [item('q1', '看截图', { previews })]);
  sessions.closeAllSessionDatabases();

  const restored = await sessions.loadSessionQueue(s.id);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].previews, [{ path: 'D:/x/a.png', name: 'a.png', size: 10 }], '预览 data URL 不能进 DB');
  assert.ok(JSON.stringify(restored[0]).length < 500);

  await sessions.saveSessionQueue(s.id, []);
  assert.deepEqual(await sessions.loadSessionQueue(s.id), [], '空数组必须清档（用户已发完/删光）');
});

test('排队存档：脏数据被丢弃，超量截断（不让幽灵消息出现）', async (t) => {
  await freshDir(t);
  const s = await sessions.newSession('脏队列');
  const many = Array.from({ length: 80 }, (_, i) => item(`q${i}`, `消息 ${i}`));
  many.unshift(item('empty', '   '), null, { id: 'x' }, 'not-an-object');
  await sessions.saveSessionQueue(s.id, many);
  const restored = await sessions.loadSessionQueue(s.id);
  assert.ok(restored.length <= sessions.MAX_QUEUED_MESSAGES, '最多保留 MAX_QUEUED_MESSAGES 条');
  assert.ok(restored.length >= sessions.MAX_QUEUED_MESSAGES - 4, '有效条目都在（只有脏数据被丢掉）');
  assert.ok(restored.every((x) => String(x.text || '').trim()), '空文本不可能被恢复成一条「点了没内容」的消息');

  assert.equal(sessions.normalizeQueuedItems('nope').length, 0, '非数组入参不崩');
  assert.deepEqual(await sessions.loadSessionQueue('../../etc/passwd'), [], '非法 id 直接给空，不抛错');
  await assert.rejects(() => sessions.saveSessionQueue('has space', []), /非法会话 ID/, '保存时必须校验 id');
});

test('排队存档：不存在的会话不会凭空建库/写入', async (t) => {
  const dir = await freshDir(t);
  const ghost = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'; // 格式合法但不存在
  assert.deepEqual(await sessions.loadSessionQueue(ghost), [], '读不存在的会话：空队列，不抛错');
  assert.deepEqual(await sessions.saveSessionQueue(ghost, [item('q1', 'x')]), { id: ghost, count: 0 });
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(dbIn(dir)), false, '读/写不存在的会话都不该建库');
});
