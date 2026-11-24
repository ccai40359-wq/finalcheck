// 0.33.0 文件检查点回退：用真的 edit_file / write_file 产生 trace 和快照，再按「回退到第 N 个用户回合」恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm, readdir, unlink } from 'node:fs/promises';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'fc-ckpt-'));
process.env.FINALCHECK_SNAPSHOTS_DIR = path.join(tmp, 'snapshots');
const { editFileTool, writeFileTool } = await import('../src/fs-tools.mjs');
const { planFromMessages, planRewindFiles, applyRewindFiles, fileChangeOf, messagesAfterTurn } = await import('../desktop/src/main/checkpoints.mjs');

const tr = (tool, args, result) => ({ tool, args: JSON.stringify(args), result });
const read = (p) => readFile(p, 'utf8');

test.after(() => rm(tmp, { recursive: true, force: true }));

test('回退到第 1 回合之后：第 2、3 回合改过的文件恢复成第 2 回合开始前的样子；新建的删掉；第 1 回合的改动保留', async () => {
  const proj = await mkdtemp(path.join(tmp, 'proj-'));
  const a = path.join(proj, 'a.js');
  const b = path.join(proj, 'b.js');
  const c = path.join(proj, 'new.js');
  await writeFile(a, 'v0\n');
  await writeFile(b, 'b0\n');

  // 回合 1：a v0→v1
  const e1 = await editFileTool({ path: a, old_string: 'v0', new_string: 'v1' });
  // 回合 2：a v1→v2，新建 new.js，b 整体覆盖
  const e2 = await editFileTool({ path: a, old_string: 'v1', new_string: 'v2' });
  const w1 = await writeFileTool({ path: c, content: 'brand new\n' });
  const w2 = await writeFileTool({ path: b, content: 'b1\n' });
  // 回合 3：a v2→v3，一次失败的编辑（不应算改动）
  const e3 = await editFileTool({ path: a, old_string: 'v2', new_string: 'v3' });
  const bad = await editFileTool({ path: b, old_string: 'nope', new_string: 'x' });
  assert.ok(bad.error);

  const messages = [
    { role: 'user', content: '改 a' },
    { role: 'assistant', content: '', trace: [tr('edit_file', { path: a }, e1)] },
    { role: 'user', content: '再改' },
    { role: 'assistant', content: '', trace: [tr('read_file', { path: a }, { content: 'v1' }), tr('edit_file', { path: a }, e2), tr('write_file', { path: c }, w1), tr('write_file', { path: b }, w2)] },
    { role: 'notice', content: '…' },
    { role: 'user', content: '还改' },
    { role: 'assistant', content: '', trace: [tr('edit_file', { path: a }, e3), { tool: 'edit_file', args: { path: b }, result: bad, status: 'error', error: bad.error }] }
  ];

  assert.equal(messagesAfterTurn(messages, 1)[0].content, '再改');
  assert.equal(messagesAfterTurn(messages, 3).length, 0);

  const plan = await planRewindFiles(messages, 1);
  assert.equal(plan.edits, 4);
  const by = Object.fromEntries(plan.files.map((f) => [path.basename(f.path), f]));
  assert.equal(by['a.js'].action, 'restore');
  assert.equal(by['a.js'].snapshotId, e2.snapshotId, '用回退段里「第一次」改动的快照');
  assert.equal(by['new.js'].action, 'delete');
  assert.equal(by['b.js'].action, 'restore');

  const r = await applyRewindFiles(plan);
  assert.equal(r.failed, 0, JSON.stringify(r.results));
  assert.equal(await read(a), 'v1\n', '回到回合 2 开始前（保留回合 1 的改动）');
  assert.equal(await read(b), 'b0\n');
  await assert.rejects(read(c), /ENOENT/);

  // 回退全部（keep 0）：a 回到 v0
  const all = await planRewindFiles(messages, 0);
  await applyRewindFiles(all);
  assert.equal(await read(a), 'v0\n');
});

test('快照被清理 / 要删的文件已不在 → 标出来、不碰；结果超长被截断时也能认出路径和快照', async () => {
  const proj = await mkdtemp(path.join(tmp, 'proj-'));
  const a = path.join(proj, 'a.js');
  await writeFile(a, 'x\n');
  const e = await editFileTool({ path: a, old_string: 'x', new_string: 'y' });
  const gone = path.join(proj, 'gone.js');
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', trace: [
      // 截断形状（agent-service 的 MAX_INLINE_RESULT 落盘路径）
      { tool: 'edit_file', args: '{}', result: { truncated: true, preview: JSON.stringify({ file: 'a.js', path: a, snapshotId: e.snapshotId }).slice(0, 2000) } },
      tr('write_file', { path: gone }, { path: gone, created: true })
    ] }
  ];
  assert.deepEqual(fileChangeOf(messages[1].trace[0]), { path: path.resolve(a), snapshotId: e.snapshotId, created: false });

  // 清掉快照
  const snapRoot = process.env.FINALCHECK_SNAPSHOTS_DIR;
  for (const d of await readdir(snapRoot)) for (const f of await readdir(path.join(snapRoot, d))) if (f.startsWith(e.snapshotId)) await unlink(path.join(snapRoot, d, f));

  const plan = await planRewindFiles(messages, 0);
  const by = Object.fromEntries(plan.files.map((f) => [path.basename(f.path), f]));
  assert.equal(by['a.js'].action, 'unavailable');
  assert.match(by['a.js'].reason, /快照/);
  assert.equal(by['gone.js'].action, 'noop');
  const r = await applyRewindFiles(plan);
  assert.equal(await read(a), 'y\n', '无法恢复的文件不能被改动');
  assert.equal(r.restored + r.deleted, 0);
});

test('只看 edit_file / write_file；没有改动时计划为空', () => {
  const p = planFromMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', trace: [tr('run_command', { command: 'rm -rf x' }, { exitCode: 0 }), tr('read_file', { path: 'a' }, {})] }
  ], 0);
  assert.deepEqual(p, { files: [], edits: 0 });
});
