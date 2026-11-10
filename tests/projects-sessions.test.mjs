// 侧栏「同时展开多个 Workspace」的主进程支撑：
// project-sessions.mjs 按 projectId 列会话，必须完全隔离——不改当前项目注册的
// activeProjectId、不改 FINALCHECK_SESSIONS_DIR，并发列多个项目也不会互相踩。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'fc-project-sessions-'));
const globalDir = path.join(root, 'global-sessions');
const projA = path.join(root, 'proj-a');
const projB = path.join(root, 'proj-b');
const dirA = path.join(projA, '.finalcheck', 'sessions');
const dirB = path.join(projB, '.finalcheck', 'sessions');
const registryFile = path.join(root, 'projects.json');

await mkdir(globalDir, { recursive: true });
await mkdir(projA, { recursive: true });
await mkdir(projB, { recursive: true });
process.env.FINALCHECK_PROJECTS_FILE = registryFile;
process.env.FINALCHECK_SESSION_STORE = 'sqlite'; // 生产后端（Electron 默认）
process.env.FINALCHECK_SESSIONS_DIR = globalDir;

const projects = await import('../desktop/src/main/projects.mjs');
const sessions = await import('../desktop/src/main/sessions.mjs');
const { listForProject } = await import('../desktop/src/main/project-sessions.mjs');

const A = await projects.addProject(projA, { name: '项目 A' });
const B = await projects.addProject(projB, { name: '项目 B' });
await projects.setActiveProject(B.id); // 当前项目 = B（模拟用户正在 B 里工作）

// 临时把默认目录指到某个项目目录，建完会话立刻恢复：模拟各项目在自己的 .finalcheck/ 里落会话
async function newSessionIn(dir, title) {
  const prev = process.env.FINALCHECK_SESSIONS_DIR;
  process.env.FINALCHECK_SESSIONS_DIR = dir;
  try {
    return await sessions.newSession(title);
  } finally {
    process.env.FINALCHECK_SESSIONS_DIR = prev;
  }
}

const sessionA = await newSessionIn(dirA, 'A 的会话');
const sessionB = await newSessionIn(dirB, 'B 的会话');
process.env.FINALCHECK_SESSIONS_DIR = dirB; // 当前项目 B 的实际会话目录

after(async () => {
  sessions.closeAllSessionDatabases(); // Windows 下先释放 sqlite 句柄再删临时目录
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

test('listForProject(A) 只返回 A 的会话，且 activeProjectId 与环境变量前后不变', async () => {
  const envBefore = process.env.FINALCHECK_SESSIONS_DIR;
  const activeBefore = (await projects.getActiveProject())?.id;
  assert.equal(activeBefore, B.id, '前置：当前项目是 B');

  const listA = await listForProject(A.id);
  assert.deepEqual(listA.map((s) => s.id), [sessionA.id], '只返回 A 自己的会话');
  assert.ok(!listA.some((s) => s.id === sessionB.id), '不能混进 B 的会话');
  // 返回形状与 sessions.listSessions() 一致（渲染层缓存直接复用）
  for (const key of ['id', 'title', 'createdAt', 'updatedAt', 'turns', 'pinned', 'archived', 'unread', 'path']) {
    assert.ok(key in listA[0], '会话条目包含字段：' + key);
  }

  assert.equal(process.env.FINALCHECK_SESSIONS_DIR, envBefore, 'FINALCHECK_SESSIONS_DIR 不能被改写');
  assert.equal((await projects.getActiveProject())?.id, activeBefore, 'activeProjectId 不能被改写');
  const reg = JSON.parse(await readFile(registryFile, 'utf8'));
  assert.equal(reg.activeProjectId, B.id, '注册表里的 activeProjectId 仍是 B');

  // 当前项目（B）的常规列表不受影响，仍只有 B 的会话
  const current = await sessions.listSessions();
  assert.deepEqual(current.map((s) => s.id), [sessionB.id], '列 A 不能污染当前项目列表');
});

test('不存在的 projectId 返回空数组（渲染层按空列表显示，不弹错误）', async () => {
  assert.deepEqual(await listForProject('00000000-0000-4000-8000-000000000000'), []);
  assert.deepEqual(await listForProject('not-a-project'), []);
  assert.deepEqual(await listForProject(null), [], 'null/非法入参同样返回空数组');
});

test('SQLite 后端同一项目连续两次列表一致（幂等，含并发列两个项目）', async () => {
  const first = await listForProject(A.id);
  const second = await listForProject(A.id);
  assert.deepEqual(second, first, '两次结果完全一致');
  assert.equal(first.length, 1);

  // 并发列 A / B：目录各归各的，不能串（sqlite 连接按 dbPath 隔离）
  const [againA, againB] = await Promise.all([listForProject(A.id), listForProject(B.id)]);
  assert.deepEqual(againA.map((s) => s.id), [sessionA.id]);
  assert.deepEqual(againB.map((s) => s.id), [sessionB.id]);
});
