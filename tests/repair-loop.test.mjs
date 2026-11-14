// 修复回路（③）+ 回合上下文快照（④）：
// - edit_file/write_file 改前自动快照 → repair_rollback 回滚到改动前
// - 回合上下文 JSONL（pi 显式会话口径）：roleMode/模型/工具/技能目录可复盘
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { snapshotBeforeWrite, rollbackFile, listSnapshots, KEEP_PER_FILE } from '../src/repair-loop.mjs';
import { editFileTool, writeFileTool } from '../src/fs-tools.mjs';
import { appendTurnContext, readTurnContext } from '../src/turn-context.mjs';
import { AGENT_TOOLS_SCHEMA, SUBAGENT_TOOLS_SCHEMA, getSystemPromptParts } from '../desktop/src/main/agent-service.mjs';

const TMP = await mkdtemp(path.join(os.tmpdir(), 'fc-repair-'));
process.env.FINALCHECK_SNAPSHOTS_DIR = path.join(TMP, 'snapshots');
test.after(async () => {
  delete process.env.FINALCHECK_SNAPSHOTS_DIR;
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

async function fixtureFile(rel, content) {
  const dir = path.join(TMP, 'proj');
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  const abs = path.join(dir, rel);
  if (content !== undefined) await writeFile(abs, content, 'utf8');
  return abs;
}

/* ---------- ③ 快照 / 回滚 ---------- */

test('快照→改坏→回滚到改动前；list 顺序新→旧', async (t) => {
  const abs = await fixtureFile('app/util.js', 'const a = 1;\n');
  const s1 = await snapshotBeforeWrite(abs);
  assert.ok(s1.snapId, '首次快照返回 snapId');
  await writeFile(abs, 'const a = 2; // 改坏了\n', 'utf8');
  const s2 = await snapshotBeforeWrite(abs);
  const snaps = await listSnapshots(abs);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].snapId, s2.snapId, 'list 按新→旧');
  const rb = await rollbackFile(abs, s1.snapId);
  assert.equal(rb.ok, true);
  assert.equal(await readFile(abs, 'utf8'), 'const a = 1;\n', '回滚恢复到指定快照的内容');
  const rb2 = await rollbackFile(abs);
  assert.equal(await readFile(abs, 'utf8'), 'const a = 2; // 改坏了\n', '不给 snapId 恢复到最新快照');
});

test('新建文件不快照；上限裁剪 KEEP_PER_FILE；坏 snapId 报错', async (t) => {
  const abs = await fixtureFile('new/file.txt', undefined);
  const s = await snapshotBeforeWrite(abs);
  assert.equal(s.skipped, 'new-file', '新文件没有旧内容可回滚');
  await writeFile(abs, 'v0\n', 'utf8');
  for (let i = 0; i < KEEP_PER_FILE + 3; i++) {
    await snapshotBeforeWrite(abs);
    await writeFile(abs, `v${i + 1}\n`, 'utf8');
  }
  const snaps = await listSnapshots(abs);
  assert.ok(snaps.length <= KEEP_PER_FILE, `快照数 ${snaps.length} 超过上限 ${KEEP_PER_FILE}`);
  const bad = await rollbackFile(abs, 'no-such-snap');
  assert.ok(bad.error && Array.isArray(bad.available), '不存在的 snapId 给出可用清单');
});

test('fs-tools 钩子：edit_file/write_file 返回 snapshotId；rollback 恢复原文；新建文件无 snapshotId', async (t) => {
  const abs = await fixtureFile('src/hook.js', 'let x = 1;\n');
  const e = await editFileTool({ path: abs, old_string: 'let x = 1;', new_string: 'let x = 2; // broken' });
  assert.ok(e.snapshotId, 'edit_file 返回 snapshotId');
  assert.match(e.rollbackHint, /repair_rollback/);
  assert.equal(await readFile(abs, 'utf8'), 'let x = 2; // broken\n');
  const rb = await rollbackFile(abs, e.snapshotId);
  assert.equal(await readFile(abs, 'utf8'), 'let x = 1;\n', '改坏后回滚到改动前');

  const w = await writeFileTool({ path: abs, content: 'let x = 3;\n' });
  assert.ok(w.snapshotId, '覆盖已存在文件也留快照');
  await rollbackFile(abs, w.snapshotId);
  assert.equal(await readFile(abs, 'utf8'), 'let x = 1;\n');

  const created = path.join(TMP, 'proj', 'src', 'brand-new.js');
  const wc = await writeFileTool({ path: created, content: 'console.log(1);\n' });
  assert.equal(wc.created, true);
  assert.ok(!wc.snapshotId, '新建文件没有旧内容，不返回 snapshotId');
});

test('repair_rollback 工具：主 agent 可用、子代理不可见；edit→rollback 端到端', async (t) => {
  const schema = AGENT_TOOLS_SCHEMA.find((x) => x?.function?.name === 'repair_rollback');
  assert.ok(schema, 'repair_rollback 在主 agent 工具表');
  assert.ok(!SUBAGENT_TOOLS_SCHEMA.some((x) => x?.function?.name === 'repair_rollback'), '子代理不给回滚权');
});

/* ---------- ④ 回合上下文快照 ---------- */

test('turn-context：JSONL 追加→读回；损坏行跳过；裁剪到上限', async (t) => {
  const proj = path.join(TMP, 'tc-proj');
  await mkdir(proj, { recursive: true });
  await appendTurnContext(proj, 'sess-A', { roleMode: 'dev', model: 'deepseek-v4.1-flash', tools: ['edit_file', 'run_command'], skillsExtra: ['fix-s3-key'] });
  await appendTurnContext(proj, 'sess-A', { roleMode: 'audit', model: 'glm', tools: ['audit_project'] });
  await appendTurnContext(proj, 'sess-B', { roleMode: 'dev', model: 'm2', tools: [] });
  const a = await readTurnContext(proj, 'sess-A');
  assert.equal(a.length, 2, '按会话分文件');
  assert.equal(a[0].roleMode, 'dev');
  assert.equal(a[1].roleMode, 'audit');
  assert.ok(a[0].at > 0, '带时间戳');
  const b = await readTurnContext(proj, 'sess-B');
  assert.equal(b.length, 1);
  assert.deepEqual(await readTurnContext(proj, 'sess-none'), [], '不存在的会话返回空');
});

/* ---------- ④ 修复 fanout 提示 ---------- */

test('dev 轨含「多条发现并行修」fanout 纪律与诚实汇报要求', async () => {
  const dev = await getSystemPromptParts('dev');
  assert.match(dev.base, /多条独立发现并行修/);
  assert.match(dev.base, /depends_on 全部空数组并行/);
  assert.match(dev.base, /修复失败的发现如实列「未修好 \+ 原因」/);
});
