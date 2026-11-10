// 子代理 transcript 落盘：重开 App 后点旧 chip 还能读回对话（内存没了就走磁盘）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  safeStepId, runDirOf, writeStepTranscript, readStepTranscript, pruneRuns, trimTranscriptMessages
} from '../desktop/src/main/transcripts.mjs';

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fc-transcripts-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

const payload = (stepId, extra = {}) => ({
  stepId, name: stepId, role: '代码安全审查员', startedAt: Date.now() - 60_000, ms: 60_000,
  toolCount: 3, messages: [{ role: 'user', content: '任务' }, { role: 'tool', content: 'x'.repeat(5000), name: 'read_file' }],
  done: true, ...extra
});

test('transcripts: 写→读（指定 runId）原样回来，工具输出按 2000 字截断', async () => {
  await withTemp(async (dir) => {
    const file = await writeStepTranscript(dir, 'wf-run-1', 'review#0', payload('review#0'));
    assert.ok(file && file.endsWith('review#0.json'));
    const back = await readStepTranscript(dir, 'review#0', { runId: 'wf-run-1' });
    assert.equal(back.role, '代码安全审查员');
    assert.equal(back.messages.length, 2);
    assert.ok(back.messages[1].content.length <= 2000 + 20, '工具输出应被截断');
    assert.match(back.messages[1].content, /已截断/);
  });
});

test('transcripts: 不给 runId 时按目录 mtime 找最新一份（跨 run 的同一个 step id）', async () => {
  await withTemp(async (dir) => {
    await writeStepTranscript(dir, 'wf-old', 'review#0', payload('review#0', { role: '旧' }));
    await writeStepTranscript(dir, 'wf-new', 'review#0', payload('review#0', { role: '新' }));
    await utimes(runDirOf(dir, 'wf-old'), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    const back = await readStepTranscript(dir, 'review#0');
    assert.equal(back.role, '新');
    assert.equal(back.runId, 'wf-new');
  });
});

test('transcripts: pruneRuns 只留最近 keep 个 run 目录', async () => {
  await withTemp(async (dir) => {
    for (let i = 0; i < 8; i += 1) {
      const runId = `wf-${i}`;
      await writeStepTranscript(dir, runId, 's1', payload('s1'));
      await utimes(runDirOf(dir, runId), new Date(Date.now() - (8 - i) * 60_000), new Date(Date.now() - (8 - i) * 60_000));
    }
    const removed = await pruneRuns(dir, 3);
    assert.equal(removed, 5);
    const { readdir } = await import('node:fs/promises');
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, ['wf-5', 'wf-6', 'wf-7']);
  });
});

test('transcripts: 非法 runId 不落盘；step id 会压成安全文件名', async () => {
  await withTemp(async (dir) => {
    const bad = await writeStepTranscript(dir, '../evil', 's1', payload('s1'));
    assert.equal(bad, null);
    assert.equal(await readStepTranscript(dir, 's1', { runId: '../evil' }), null);
    assert.equal(safeStepId('D:/x/审查 a.mjs #1'), 'D__x____a.mjs_#1');
  });
});

test('transcripts: trimTranscriptMessages 只截 tool 消息，不动 user/assistant', () => {
  const msgs = [
    { role: 'system', content: 'S'.repeat(9000) },
    { role: 'user', content: 'U'.repeat(9000) },
    { role: 'assistant', content: 'A'.repeat(9000) },
    { role: 'tool', content: 'T'.repeat(9000) }
  ];
  const out = trimTranscriptMessages(msgs, { maxToolChars: 100 });
  assert.equal(out[0].content.length, 9000);
  assert.equal(out[1].content.length, 9000);
  assert.equal(out[2].content.length, 9000);
  assert.ok(out[3].content.length <= 120);
  assert.match(out[3].content, /已截断 8900 字/);
});
