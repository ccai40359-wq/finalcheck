// 项目记忆（AGENTS.md）：读取、追加、去重、截断
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readProjectMemory, rememberProject, MEMORY_FILE } from '../desktop/src/main/project-memory.mjs';

async function sandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), 'fc-mem-'));
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

test('project-memory: 没有 AGENTS.md → null（不报错）', async () => {
  const { dir, done } = await sandbox();
  try {
    assert.equal(await readProjectMemory(dir), null);
    assert.equal(await readProjectMemory(null), null);
  } finally { await done(); }
});

test('project-memory: 读取内容 + 超长截断', async () => {
  const { dir, done } = await sandbox();
  try {
    await writeFile(path.join(dir, MEMORY_FILE), '  项目是 RCW 客服机器人，技术栈 PHP + MySQL。  ', 'utf8');
    const r = await readProjectMemory(dir);
    assert.match(r.text, /RCW 客服机器人/);
    assert.equal(r.truncated, false);

    await writeFile(path.join(dir, MEMORY_FILE), 'x'.repeat(9000), 'utf8');
    const big = await readProjectMemory(dir);
    assert.equal(big.truncated, true);
    assert.match(big.text, /已截断/);
  } finally { await done(); }
});

test('project-memory: 首条记忆创建 ## 记忆 小节', async () => {
  const { dir, done } = await sandbox();
  try {
    const r = await rememberProject(dir, '体检默认跑 L2，别跑 L3（太慢）');
    assert.equal(r.added, true);
    const text = await readFile(path.join(dir, MEMORY_FILE), 'utf8');
    assert.match(text, /^## 记忆$/m);
    assert.match(text, /- \d{4}-\d{2}-\d{2} 体检默认跑 L2/);
  } finally { await done(); }
});

test('project-memory: 追加进已有小节，不会跑到下一个标题下面', async () => {
  const { dir, done } = await sandbox();
  try {
    await writeFile(path.join(dir, MEMORY_FILE), [
      '# 项目',
      '',
      '## 记忆',
      '',
      '- 2026-01-01 已有事实',
      '',
      '## 部署',
      '',
      '用 docker compose。',
      ''
    ].join('\n'), 'utf8');
    await rememberProject(dir, '压测上限 60s / 50 连接');
    const text = await readFile(path.join(dir, MEMORY_FILE), 'utf8');
    const memIdx = text.indexOf('压测上限');
    const deployIdx = text.indexOf('## 部署');
    assert.ok(memIdx > 0 && memIdx < deployIdx, '新事实应插在「## 记忆」里、部署标题之前');
    assert.match(text, /已有事实/);
    assert.match(text, /用 docker compose/);
  } finally { await done(); }
});

test('project-memory: 重复事实不重复写', async () => {
  const { dir, done } = await sandbox();
  try {
    await rememberProject(dir, '项目根是 D:\\workspace');
    const r2 = await rememberProject(dir, '项目根是 D:\\workspace');
    assert.equal(r2.added, false);
    const text = await readFile(path.join(dir, MEMORY_FILE), 'utf8');
    assert.equal((text.match(/项目根是/g) || []).length, 1);
  } finally { await done(); }
});

test('project-memory: 空事实 / 没有项目 → 报错', async () => {
  const { dir, done } = await sandbox();
  try {
    await assert.rejects(() => rememberProject(dir, '   '), /为空/);
    await assert.rejects(() => rememberProject(null, '有内容'), /没有项目/);
  } finally { await done(); }
});
