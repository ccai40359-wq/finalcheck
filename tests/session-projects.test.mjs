// 切项目不中断回合（ZCode 语义）：会话 → 项目目录注册表 + 会话级 dirFor + 切项目计划。
// 不依赖 electron，全部在临时目录里验证。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';

const root = await mkdtemp(path.join(os.tmpdir(), 'fc-session-projects-'));
const globalDir = path.join(root, 'global-sessions');
const projectA = path.join(root, 'proj-a');
const projectB = path.join(root, 'proj-b');
const dirA = path.join(projectA, '.finalcheck', 'sessions');
const dirB = path.join(projectB, '.finalcheck', 'sessions');
await mkdir(globalDir, { recursive: true });
await mkdir(dirA, { recursive: true });
await mkdir(dirB, { recursive: true });

process.env.FINALCHECK_SESSIONS_DIR = globalDir;
const sessions = await import('../desktop/src/main/sessions.mjs');
const reg = await import('../desktop/src/main/session-projects.mjs');
const { planProjectSwitch } = await import('../desktop/src/main/project-switch.mjs');

sessions.setSessionDirResolver((id) => reg.getSessionDir(id));

after(() => rm(root, { recursive: true, force: true }));
beforeEach(() => {
  reg.resetSessionDirs();
  process.env.FINALCHECK_SESSIONS_DIR = globalDir;
});

const writeSession = (dir, id, extra = {}) => writeFile(
  path.join(dir, `session-${id}.json`),
  JSON.stringify({ id, title: 't', createdAt: 1, updatedAt: 1, messages: [], ...extra }),
  'utf8'
);
const listFiles = (dir) => readdir(dir).catch(() => []);

test('会话按所属项目读写：切当前项目后 append 仍写回原项目，不串到新项目', async () => {
  const idA = randomUUID();
  const idB = randomUUID();
  await writeSession(dirA, idA);
  await writeSession(dirB, idB);
  await reg.scanSessionsDir(dirA);
  await reg.scanSessionsDir(dirB);
  assert.equal(reg.getSessionDir(idA), path.resolve(dirA));
  assert.equal(reg.getSessionDir(idB), path.resolve(dirB));

  // 打开旧会话：按登记目录读，即使当前项目已经是 B
  process.env.FINALCHECK_SESSIONS_DIR = dirB;
  const loadedA = await sessions.loadSession(idA);
  assert.equal(loadedA.id, idA);

  // 切到 B 后，A 会话的回合继续写 A 项目目录
  await sessions.appendUserMessage(idA, '第二问');
  await sessions.appendAssistantMessage(idA, { content: '第二答', interrupted: false });
  const onA = JSON.parse(await readFile(path.join(dirA, `session-${idA}.json`), 'utf8'));
  assert.deepEqual(onA.messages.map((m) => [m.role, m.content]), [['user', '第二问'], ['assistant', '第二答']]);
  assert.ok(!(await listFiles(dirB)).includes(`session-${idA}.json`), '不能写到新项目目录');
  // B 自己的会话不受影响
  const onB = JSON.parse(await readFile(path.join(dirB, `session-${idB}.json`), 'utf8'));
  assert.equal(onB.messages.length, 0);
});

test('dirFor 未登记的会话回退默认目录（不抛错）', async () => {
  const unregistered = randomUUID();
  assert.equal(sessions.dirFor(unregistered), path.resolve(globalDir));
  assert.equal(sessions.dirFor(null), path.resolve(globalDir));
  assert.equal(reg.getSessionDir(unregistered), null);
  // 走完整读写链路也不炸：新建会话默认落在当前项目目录
  const s = await sessions.newSession('回退');
  assert.equal(sessions.dirFor(s.id), path.resolve(globalDir));
  const loaded = await sessions.loadSession(s.id);
  assert.equal(loaded.id, s.id);
});

test('扫描只登记存在的 session 文件名（不读内容、忽略目录/临时文件）', async () => {
  const scanDir = path.join(root, 'scan-project', '.finalcheck', 'sessions');
  await mkdir(scanDir, { recursive: true });
  const id = randomUUID();
  await writeFile(path.join(scanDir, `session-${id}.json`), 'not-json{{{', 'utf8'); // 内容损坏也照样登记
  await writeFile(path.join(scanDir, 'notes.txt'), 'x', 'utf8');
  await writeFile(path.join(scanDir, `session-${id}.json.tmp`), 'x', 'utf8');
  await writeFile(path.join(scanDir, 'session-bad.json'), 'x', 'utf8'); // id 不合法
  await mkdir(path.join(scanDir, `session-${randomUUID()}.json`)); // 同名目录不是会话文件
  const r = await reg.scanSessionsDir(scanDir);
  assert.equal(reg.getSessionDir(id), path.resolve(scanDir), '合法会话文件名被登记');
  assert.equal(r.files, 1);
  assert.equal(reg.registeredSessionDirs().length, 1);
  // 不读内容：扫描阶段不解析 JSON（损坏文件只有真正 load 时才报错）
  await assert.rejects(() => sessions.loadSession('not-a-real-id'), /非法会话 ID/);
});

test('移动会话后登记目标目录：后续写入落到目标项目（源目录不再有文件）', async () => {
  const id = randomUUID();
  await writeSession(dirA, id, { messages: [{ role: 'user', content: '旧消息' }] });
  reg.registerSessionDir(id, dirA);
  await sessions.moveSessionTo(id, dirB);
  assert.ok(!(await listFiles(dirA)).includes(`session-${id}.json`), '源文件应被删除');
  assert.ok((await listFiles(dirB)).includes(`session-${id}.json`), '目标文件应存在');
  reg.registerSessionDir(id, dirB); // 主进程 sessions:move 语义：登记目标目录
  await sessions.appendAssistantMessage(id, { content: '移动后继续写' });
  const moved = JSON.parse(await readFile(path.join(dirB, `session-${id}.json`), 'utf8'));
  assert.deepEqual(moved.messages.map((m) => m.content), ['旧消息', '移动后继续写']);
  assert.ok(!(await listFiles(dirA)).includes(`session-${id}.json`), '不能写回源项目');
});

test('项目根反推：<project>/.finalcheck/sessions → 项目根；全局目录返回 null', () => {
  assert.equal(reg.projectRootOfSessionsDir(dirA), path.resolve(projectA));
  assert.equal(reg.projectRootOfSessionsDir(globalDir), null);
  assert.equal(reg.projectRootOfSessionsDir(''), null);
});

test('planProjectSwitch：只切 active / 目录，绝不 abort 在跑回合、不清会话 context', () => {
  const p = { id: 'pid-a', path: projectA };
  const plan = planProjectSwitch(p);
  assert.ok(plan);
  assert.equal(plan.activeProjectId, 'pid-a');
  assert.equal(plan.activeProjectPath, projectA);
  assert.equal(plan.sessionsDir, path.join(projectA, '.finalcheck', 'sessions'));
  assert.equal(plan.memoryDir, path.join(projectA, '.finalcheck', 'memory'));
  assert.equal(plan.abortRunningTurns, false);
  assert.equal(plan.clearSessionHookContext, false);
  assert.equal(plan.reloadHooksConfig, true);
  assert.equal(planProjectSwitch(p, { reloadHooks: false }).reloadHooksConfig, false);
  assert.equal(planProjectSwitch(null), null);
  assert.equal(planProjectSwitch({ id: 'x' }), null);
});
