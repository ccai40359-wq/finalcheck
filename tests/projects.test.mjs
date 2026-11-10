import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'fc-projects-'));
process.env.FINALCHECK_PROJECTS_FILE = path.join(root, 'registry.json');
process.env.FINALCHECK_DEFAULT_PROJECT = path.join(root, 'default-project');
const projects = await import('../desktop/src/main/projects.mjs');

test('projects: 默认项目创建在指定根目录，带 .finalcheck/sessions+memory', async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  const p = await projects.ensureDefaultProject();
  assert.equal(p.path, path.resolve(process.env.FINALCHECK_DEFAULT_PROJECT));
  assert.equal(p.isDefault, true);
  assert.ok((await stat(projects.sessionDirOf(p.path))).isDirectory());
  assert.ok((await stat(projects.memoryDirOf(p.path))).isDirectory());
  const list = await projects.listProjects();
  assert.equal(list.length, 1);
});

test('projects: 添加已有目录、重复路径去重、移除只掉注册不删目录', async (t) => {
  t.after(() => rm(root, { recursive: true, force: true }));
  await projects.ensureDefaultProject();
  const dir = path.join(root, 'my-app');
  await mkdir(dir, { recursive: true });
  const a = await projects.addProject(dir);
  const b = await projects.addProject(dir);
  assert.equal(a.id, b.id, '同一路径不应重复注册');
  assert.equal((await projects.listProjects()).length, 2);
  assert.equal(await projects.removeProject(a.id), true);
  assert.equal((await projects.getProject(a.id)), null);
  assert.ok((await stat(dir)).isDirectory());
});

test('projects: 不存在的目录拒绝添加', async () => {
  await assert.rejects(() => projects.addProject(path.join(root, 'nope')), /不存在/);
});
