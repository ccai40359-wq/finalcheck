import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listTextFiles, prunedWarning } from '../src/walk.mjs';

test('walk: release/out 构建产物被跳过，并且跳过行为可见（不静默漏检）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-walk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = async (rel) => {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, 'x');
  };
  await write('src/app.js');
  await write('release/win-unpacked/resources/playbooks/a.md');
  await write('out/main/index.js');
  await write('desktop/out/renderer/index.js');
  await write('release-next/win-unpacked/resources/src/app.js');
  await write('release-0110/win-unpacked/resources/src/app.js');
  await write('dist/bundle.js');
  await write('build/bundle.js');
  await write('node_modules/x.js');

  const { files, pruned } = await listTextFiles(dir);
  assert.deepEqual(files.map((f) => path.relative(dir, f).replace(/\\/g, '/')), ['src/app.js']);
  assert.ok(pruned.includes('release'));
  assert.ok(pruned.includes('out'));
  assert.ok(pruned.includes('desktop/out'), '任意层级的 out 都按构建产物跳过');
  assert.ok(pruned.includes('release-next'), 'release-* 目录按形态跳过（不再只认字面 release）');
  assert.ok(pruned.includes('release-0110'), 'release-0110 这类打包副本目录按形态跳过');
  assert.ok(pruned.includes('dist'), 'dist 按构建产物跳过并明示');
  assert.ok(pruned.includes('build'), 'build 按构建产物跳过并明示');
  assert.match(prunedWarning(pruned), /构建产物目录/);
  assert.equal(prunedWarning([]), null);
});

test('walk: 项目 finalcheck.config.json 的 exclude 优先级不变（显式排除的目录不报 pruned）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-walk-ex-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'vendor'), { recursive: true });
  await writeFile(path.join(dir, 'vendor', 'x.js'), 'x');
  const { files, pruned } = await listTextFiles(dir, ['vendor']);
  assert.deepEqual(files, []);
  assert.deepEqual(pruned, [], '显式 exclude 的目录不算「构建产物跳过」');
});
