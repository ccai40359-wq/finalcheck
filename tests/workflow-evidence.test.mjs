// 证据链回归：对抗复核不再因「没有结构化 claims」被跳过、红队结论进入 report、
// 节点完整正文落盘且下游能拿到 .out.txt 路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../desktop/src/main/workflow.mjs';

const reportText = '## Conclusion\n已汇总上游结论。\n## Findings\n- 见 claims\n## Verified\n- 红队复核\n## Not covered\nNone\n## Skipped\nNone\n';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-evidence-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const verifyVerdict = (claimId = 's-1', note = '上游结论站不住：未复现') => JSON.stringify({
  verdicts: [{ claimId, verdict: 'rejected', evidence: '亲自跑命令未复现', note }],
});

test('evidence: 无 claims + 上游有正文 → 自动补验必须真跑，report prompt 带红队结论', async () => {
  await withTempDir(async (dir) => {
    const prompts = {};
    const out = await runWorkflow({
      goal: '审查登录接口',
      journalDir: dir,
      script: [
        { op: 'step', id: 's', name: '审查', role: '审查员', prompt: '审查登录接口' },
        { op: 'report', id: 'rep', from: 's', ask: '汇总报告' },
      ],
      callStep: async (ctx) => {
        if (ctx.id === 's') return { content: '上游结论：登录接口未做鉴权（无结构化 findings）', toolCount: 1 };
        if (ctx.kind === 'verify') {
          prompts.verify = ctx.prompt;
          return { content: verifyVerdict(), toolCount: 1 };
        }
        if (ctx.id === 'rep') {
          prompts.report = ctx.prompt;
          return { content: reportText, toolCount: 0 };
        }
        return { content: 'ok', toolCount: 1 };
      },
    });

    assert.equal(out.error, undefined);
    const verify = out.results.find((r) => r.id === '__verify__');
    assert.ok(verify, '上游有正文时自动补的 verify 必须产生结果行（不能被跳过）');
    assert.equal(verify.ok, true);
    assert.equal(verify.autoInserted, true);
    assert.match(prompts.verify, /上游结论：登录接口未做鉴权/, 'verify prompt 必须拿到上游正文');
    assert.match(prompts.verify, /不要相信上游结论/, 'verify prompt 必须明确要求逐条挑刺');
    // Bug 2：report 的 depends_on 要带上 verify，prompt 里能看到红队结论
    const repStep = out.steps.find((s) => s.id === 'rep');
    assert.ok(repStep.depends_on.includes('__verify__'), 'report 必须依赖 verify');
    assert.match(prompts.report, /对抗复核结论/, 'report prompt 必须有对抗复核结论段');
    assert.match(prompts.report, /上游结论站不住/, 'report prompt 必须包含 verify 的裁决内容');
    assert.match(prompts.report, /未做鉴权/, 'report prompt 仍保留上游正文');
  });
});

test('evidence: 无 claims + 上游全空 → verify 仍跳过（不浪费一次调用）', async () => {
  const calls = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 's', name: '审查', role: '审查员', prompt: '审查配置' },
      { op: 'report', id: 'rep', from: 's', ask: '汇总' },
    ],
    callStep: async (ctx) => {
      calls.push(ctx.id);
      if (ctx.id === 's') return { content: '', toolCount: 1 };
      return { content: reportText, toolCount: 0 };
    },
  });
  assert.ok(!out.results.some((r) => r.id === '__verify__'), '上游全空且无 claims 时 verify 不产生结果行');
  assert.ok(!calls.some((id) => id === '__verify__'), '上游全空且无 claims 时 verify 不得调用模型');
  assert.ok(calls.includes('rep'), 'report 照常执行');
});

test('evidence: DAG 模式同样：无 claims + 上游正文 → verify 真跑，report 依赖并看到红队结论', async () => {
  const prompts = {};
  const out = await runWorkflow({
    goal: '审查登录接口',
    steps: [
      { id: 's', name: '审查', role: '审查员', prompt: '审查登录接口' },
      { id: 'rep', name: '汇总', kind: 'report', prompt: '汇总五段报告' },
    ],
    callStep: async (ctx) => {
      if (ctx.id === 's') return { content: '上游结论：登录接口未做鉴权（无结构化 findings）', toolCount: 1 };
      if (ctx.kind === 'verify') {
        prompts.verify = ctx.prompt;
        return { content: verifyVerdict(), toolCount: 1 };
      }
      if (ctx.kind === 'report') {
        prompts.report = ctx.prompt;
        return { content: reportText, toolCount: 0 };
      }
      return { content: 'ok', toolCount: 1 };
    },
  });
  const verify = out.results.find((r) => r.id === '__verify__');
  assert.ok(verify, 'DAG 自动补验必须真跑');
  assert.equal(verify.ok, true);
  const repStep = out.steps.find((s) => s.id === 'rep');
  assert.ok(repStep.depends_on.includes('__verify__'), 'DAG report 必须依赖 verify');
  assert.match(prompts.verify, /上游结论：登录接口未做鉴权/);
  assert.match(prompts.verify, /不要相信上游结论/);
  assert.match(prompts.report, /对抗复核结论/);
  assert.match(prompts.report, /上游结论站不住/);
});

test('evidence: 6000 字正文原样保留 + .out.txt 全文 + 下游 prompt 带完整输出路径', async () => {
  await withTempDir(async (dir) => {
    const full = '证'.repeat(6000);
    const prompts = {};
    const out = await runWorkflow({
      goal: 'g',
      journalDir: dir,
      script: [
        { op: 'step', id: 'long', name: '长审查', role: '审查员', prompt: '审查全部文件' },
        { op: 'step', id: 'down', name: '下游', role: '记录员', prompt: '基于 ${long.content} 写结论', depends_on: ['long'] },
        { op: 'step', id: 'inline', name: '插值', role: '记录员', prompt: '结论：${long.content}' },
        { op: 'report', id: 'rep', from: 'down', ask: '汇总' },
      ],
      callStep: async (ctx) => {
        if (ctx.id === 'long') return { content: full, toolCount: 1 };
        if (ctx.kind === 'verify') return { content: verifyVerdict('down-1'), toolCount: 1 };
        if (ctx.id === 'rep') return { content: reportText, toolCount: 0 };
        if (ctx.id === 'inline') {
          prompts.inline = ctx.prompt;
          return { content: '插值结论', toolCount: 1 };
        }
        prompts.down = ctx.prompt;
        return { content: '下游结论：见上游完整输出', toolCount: 1 };
      },
    });
    const row = out.results.find((r) => r.id === 'long');
    assert.equal(row.content, full, '6000 字未超 8000 上限，必须原样保留');
    const outFile = join(dir, out.runId, 'long.out.txt');
    assert.equal(await readFile(outFile, 'utf8'), full, '.out.txt 必须是完整正文');
    assert.match(prompts.down, /完整输出：/, '下游 prompt 必须带完整输出指针');
    assert.ok(prompts.down.includes(outFile), `下游 prompt 必须包含具体路径：${outFile}`);
    assert.match(prompts.down, /read_file/);
    assert.match(prompts.inline, /完整输出：/, '${node.content} 插值也必须带完整输出指针');
    assert.ok(prompts.inline.includes(outFile));
  });
});

test('evidence: 9000 字正文 → 内存 8000 + 截断标记，.out.txt 仍是完整 9000 字', async () => {
  await withTempDir(async (dir) => {
    const full = '证'.repeat(9000);
    const out = await runWorkflow({
      goal: 'g',
      journalDir: dir,
      script: [
        { op: 'step', id: 'long', name: '长审查', role: '审查员', prompt: '审查全部文件' },
        { op: 'report', id: 'rep', from: 'long', ask: '汇总' },
      ],
      callStep: async (ctx) => {
        if (ctx.id === 'long') return { content: full, toolCount: 1 };
        if (ctx.kind === 'verify') return { content: verifyVerdict('long-1'), toolCount: 1 };
        return { content: reportText, toolCount: 0 };
      },
    });
    const row = out.results.find((r) => r.id === 'long');
    assert.ok(row.content.length > 8000, '超限正文必须带截断标记（长度大于 8000）');
    assert.ok(row.content.startsWith(full.slice(0, 8000)), '前 8000 字必须保留');
    assert.match(row.content, /已截断 1000 字/);
    const outFile = join(dir, out.runId, 'long.out.txt');
    assert.equal((await readFile(outFile, 'utf8')).length, 9000, '.out.txt 必须是完整 9000 字');
  });
});
