// DAG（steps）模式失败节点的结构化错误码回归：
// - 结果行 / 快照 step / journal 记录都带 errorCode（与 script 模式同一套 deriveNodeErrorCode）
// - summary 失败行格式「失败（CODE · 人话）」，无码时回落「失败（原始 error）」
// - 下游步骤按自己的失败原因取码，不继承上游
// 全部用 fake callStep，不碰真实模型与网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../desktop/src/main/workflow.mjs';
import { loadJournal } from '../desktop/src/main/workflow-journal.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-dagerror-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('dagerror: 网关 HTTP 429 → 结果行、快照、summary、journal 都带码', async () => {
  await withTempDir(async (journalDir) => {
    const snaps = [];
    const out = await runWorkflow({
      goal: '检查登录模块',
      journalDir,
      steps: [{ id: 'a', name: '扫描', role: '审查员', prompt: '检查登录模块' }],
      callStep: async () => ({
        error: '网关连接失败：HTTP 429 Too Many Requests（已重试 5 次）。请检查：网络代理、API Key 与模型套餐状态。',
        toolCount: 0,
      }),
      onUpdate: (s) => snaps.push(s),
    });
    assert.equal(out.error, undefined);
    assert.equal(out.ok, false);
    const row = out.results.find((r) => r.id === 'a');
    assert.equal(row.ok, false);
    assert.equal(row.errorCode, 'HTTP 429');
    assert.match(row.error, /HTTP 429/); // 原始错误保留，码只是补充
    assert.match(out.summary, /失败（HTTP 429 · 网关限流（稍后自动重试））/);
    // 快照 step 直接来自 state，卡片 chip 读这里
    const snapStep = snaps.at(-1).steps.find((s) => s.id === 'a');
    assert.equal(snapStep.status, 'failed');
    assert.equal(snapStep.errorCode, 'HTTP 429');
    // journal 记录也带码（旧 journal 没有该字段时按无码回落）
    const journal = await loadJournal(out.runId, { dir: journalDir });
    assert.ok(journal);
    assert.equal(journal.steps.a.status, 'failed');
    assert.equal(journal.steps.a.errorCode, 'HTTP 429');
  });
});

test('dagerror: 0 工具 + 审查类角色 → NO_TOOLS，summary 带码', async () => {
  const out = await runWorkflow({
    goal: 'g',
    // 审查类角色会触发 needsEvidence（requiresTools=true），0 次工具即判定空转
    steps: [{ id: 'r', name: '复核', role: '审查员', prompt: '审查配置' }],
    // 自动补的盲验节点没有 claim 可复核 → 直接跳过，不会二次调用 callStep
    callStep: async () => ({ content: '代码看起来没问题。', toolCount: 0 }),
  });
  const row = out.results.find((r) => r.id === 'r');
  assert.equal(row.ok, false);
  assert.match(row.error, /未产生任何工具调用/);
  assert.equal(row.errorCode, 'NO_TOOLS');
  assert.match(out.summary, /失败（NO_TOOLS · 子代理空转（0 次工具））/);
});

test('dagerror: 成功步骤 errorCode 为 null', async () => {
  const out = await runWorkflow({
    goal: 'g',
    steps: [{ id: 'ok1', name: '抄写', role: '记录员', prompt: '把结论抄写成一句话' }],
    callStep: async () => ({ content: '扫描完成，无问题。', toolCount: 1 }),
  });
  assert.equal(out.ok, true);
  const row = out.results.find((r) => r.id === 'ok1');
  assert.equal(row.ok, true);
  assert.equal(row.errorCode, null);
  assert.match(out.summary, /完成/);
});

test('dagerror: 下游步骤照常执行，错误码按自己的失败原因取（不继承上游）', async () => {
  const calls = [];
  const out = await runWorkflow({
    goal: 'g',
    steps: [
      { id: 'a', name: '上游', role: '侦察员', prompt: '找入口' },
      { id: 'b', name: '下游', role: '记录员', prompt: '汇总记录', depends_on: ['a'] },
    ],
    callStep: async ({ id }) => {
      calls.push(id);
      if (id === 'a') return { error: '网关连接失败：HTTP 502 Bad Gateway' };
      return { error: '下游自己失败：汇总文件写入被拒绝' };
    },
  });
  assert.deepEqual(calls.sort(), ['a', 'b']);
  const up = out.results.find((r) => r.id === 'a');
  const down = out.results.find((r) => r.id === 'b');
  assert.equal(up.errorCode, 'HTTP 502');
  assert.equal(down.ok, false);
  assert.equal(down.errorCode, 'STEP_FAIL');
  assert.notEqual(down.errorCode, up.errorCode);
  assert.match(out.summary, /失败（STEP_FAIL · 步骤失败）/);
});

test('dagerror: 旧 journal 缺 errorCode 字段仍可正常读取（向后兼容）', async () => {
  await withTempDir(async (dir) => {
    // 模拟旧版 journal：steps.a 只有 error 没有 errorCode
    const runId = 'wf-old-1';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, `${runId}.json`), JSON.stringify({
      version: 1,
      runId,
      goal: 'g',
      startedAt: Date.now() - 1000,
      finishedAt: null,
      stopped: false,
      steps: {
        a: { name: '扫描', role: '审查员', hash: 'h', depends_on: [], status: 'failed', content: '', error: '旧错误', ms: 10, tools: 0, startedAt: 0, finishedAt: 10 },
      },
    }), 'utf8');
    const journal = await loadJournal(runId, { dir });
    assert.ok(journal);
    assert.equal(journal.steps.a.error, '旧错误');
    assert.equal(journal.steps.a.errorCode, undefined); // 不吃掉旧字段，也不会误报
  });
});
