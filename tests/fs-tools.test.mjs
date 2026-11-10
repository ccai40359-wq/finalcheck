import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { readFileTool, editFileTool, writeFileTool, computeDiff } from '../src/fs-tools.mjs';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'fc-fs-'));

test('fs: read_file 返回行数/分页，越界 offset 安全', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.txt');
  await writeFile(file, 'line1\nline2\nline3\n');
  const r = await readFileTool({ path: file });
  assert.equal(r.file, 'a.txt');
  assert.equal(r.totalLines, 3);
  assert.match(r.content, /line1/);
  const part = await readFileTool({ path: file, offset: 6, limit: 1000 });
  assert.ok(part.content.startsWith('line2'));
  assert.equal(part.offset, 6);
  const tail = await readFileTool({ path: file, offset: 99999 });
  assert.equal(tail.content, '');
  assert.equal(tail.nextOffset, null);
});

test('fs: edit_file 唯一替换成功，返回 +N/-M 与 diff', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'b.txt');
  await writeFile(file, 'const a = 1;\nconst b = 2;\n');
  const r = await editFileTool({ path: file, old_string: 'const b = 2;', new_string: 'const b = 3;\nconst c = 4;' });
  assert.equal(r.added, 2);
  assert.equal(r.removed, 1);
  assert.ok(r.diff.some((l) => l.type === 'add' && l.text.includes('const c')));
  assert.ok(r.diff.some((l) => l.type === 'del' && l.text.includes('const b = 2')));
  assert.match(await readFile(file, 'utf8'), /const c = 4/);
  const leftovers = (await readdir(dir)).filter((f) => f.includes('.finalcheck-'));
  assert.deepEqual(leftovers, [], '原子写不应残留 tmp');
});

test('fs: edit_file 拒绝 0 次/多次匹配，且不改文件', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'c.txt');
  await writeFile(file, 'foo\nfoo\nbar\n');
  const before = await readFile(file, 'utf8');
  const none = await editFileTool({ path: file, old_string: 'nope', new_string: 'x' });
  assert.match(none.error, /未找到/);
  const multi = await editFileTool({ path: file, old_string: 'foo', new_string: 'x' });
  assert.match(multi.error, /出现 2 次/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('fs: write_file 新建/覆盖都返回 diff，父目录不存在则拒绝', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'new.txt');
  const created = await writeFileTool({ path: file, content: 'a\nb\n' });
  assert.equal(created.created, true);
  assert.equal(created.added, 2);
  assert.equal(created.removed, 0);
  const overwritten = await writeFileTool({ path: file, content: 'a\nc\n' });
  assert.equal(overwritten.created, false);
  assert.equal(overwritten.added, 1);
  assert.equal(overwritten.removed, 1);
  const bad = await writeFileTool({ path: path.join(dir, 'missing', 'x.txt'), content: 'x' });
  assert.match(bad.error, /父目录不存在/);
});

test('fs: 二进制与超 2MB 文件拒绝读写', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin.dat');
  await writeFile(bin, Buffer.from([0x41, 0x00, 0x42]));
  const r1 = await readFileTool({ path: bin });
  assert.match(r1.error, /二进制/);
  const big = path.join(dir, 'big.txt');
  await writeFile(big, 'x'.repeat(2 * 1024 * 1024 + 10));
  const r2 = await readFileTool({ path: big });
  assert.match(r2.error, /文件过大/);
  const r3 = await editFileTool({ path: big, old_string: 'x', new_string: 'y' });
  assert.match(r3.error, /读取失败/);
});

test('fs: computeDiff 前后缀 + 上下文，行数统计正确', () => {
  const d = computeDiff('a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.ok(d.lines.some((l) => l.type === 'ctx' && l.text === 'b'));
  assert.ok(d.lines.some((l) => l.type === 'add' && l.text === 'X'));
  const same = computeDiff('a\nb', 'a\nb');
  assert.equal(same.added, 0);
  assert.equal(same.removed, 0);
  assert.deepEqual(same.lines, []);
});
