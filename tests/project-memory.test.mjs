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

test('project-memory: 首条记忆默认进「## 规范与禁忌」，日期放在行尾注释里', async () => {
  const { dir, done } = await sandbox();
  try {
    const r = await rememberProject(dir, '体检默认跑 L2，别跑 L3（太慢）');
    assert.equal(r.added, true);
    const text = await readFile(path.join(dir, MEMORY_FILE), 'utf8');
    assert.match(text, /^## 规范与禁忌$/m);
    assert.match(text, /^- 体检默认跑 L2.*<!-- \d{4}-\d{2}-\d{2} -->$/m);
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
    await rememberProject(dir, '压测上限 60s / 50 连接', { section: '记忆' });
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

test('project-memory: 产物清单 / 行号 / 进度 / 会变的数量直接拒绝，文件不被改动（2026-11-18 用户实测）', async () => {
  const { dir, done } = await sandbox();
  try {
    const bad = await rememberProject(dir, 'PPT 工程在 deck/：产物 deck/out/finalcheck-deck.pptx（13 页）、finalcheck-deck.pdf、deck/out/slides/*.png；质检脚本 deck/tools/qa_layout.py、qa_contrast.py');
    assert.equal(bad.rejected, true);
    assert.match(bad.error, /会变的数量/);
    assert.match(bad.error, /产物清单/);
    assert.equal((await rememberProject(dir, 'SQL 注入在 app.py:42 已修好')).rejected, true);
    assert.equal(await readProjectMemory(dir), null, '被拒绝时不能创建 AGENTS.md');
  } finally { await done(); }
});

test('project-memory: kind 分节；replace 就地更新旧条目，找不到就报错不追加', async () => {
  const { dir, done } = await sandbox();
  try {
    await rememberProject(dir, '重建 PPT：python build_deck.py', { kind: 'commands' });
    await rememberProject(dir, '源文件在 deck/src/，产物在 deck/out/，不要手改产物', { kind: 'layout' });
    let text = await readFile(path.join(dir, MEMORY_FILE), 'utf8');
    assert.match(text, /## 常用命令\n\n- 重建 PPT/);
    assert.match(text, /## 目录约定\n\n- 源文件在 deck\/src/);
    const r = await rememberProject(dir, '重建 PPT：python deck/tools/build_deck.py --all', { kind: 'commands', replace: 'python build_deck.py' });
    assert.equal(r.replaced, true);
    text = await readFile(path.join(dir, MEMORY_FILE), 'utf8');
    assert.equal((text.match(/重建 PPT/g) || []).length, 1, '替换而不是追加');
    assert.match(text, /--all/);
    const miss = await rememberProject(dir, '新命令 make deck', { kind: 'commands', replace: '不存在的旧条目' });
    assert.match(miss.error, /没找到要替换的旧条目/);
  } finally { await done(); }
});
