import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeReuse, normalizeSteps, normalizeWorkflow, runWorkflow, stepHash } from '../desktop/src/main/workflow.mjs';
import { createJournal, listJournals, loadJournal, runIdOf, saveJournal } from '../desktop/src/main/workflow-journal.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-journal-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('workflow: 校验 steps（空/重复 id/缺依赖/成环）', () => {
  assert.match(normalizeWorkflow([]).error, /不能为空/);
  assert.match(normalizeWorkflow([{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }]).error, /重复/);
  assert.match(normalizeWorkflow([{ id: 'a', prompt: 'x', depends_on: ['zzz'] }]).error, /不存在/);
  assert.match(normalizeWorkflow([{ id: 'a', prompt: 'x', depends_on: ['b'] }, { id: 'b', prompt: 'y', depends_on: ['a'] }]).error, /成环/);
  assert.match(normalizeWorkflow([{ id: 'bad id!', prompt: 'x' }]).error, /id 非法/);
  assert.match(normalizeWorkflow([{ id: 'a', prompt: '' }]).error, /缺少 prompt/);
});

test('workflow: 按依赖分层，上游结果自动注入下游 prompt', async () => {
  const calls = [];
  const out = await runWorkflow({
    goal: '审查登录模块',
    steps: [
      { id: 'scan', name: '扫描', role: '侦察员', prompt: '找入口' },
      { id: 'deep', name: '深挖', role: '审计员', prompt: '分析漏洞', depends_on: ['scan'] },
      { id: 'docs', name: '查资料', role: '研究员', prompt: '查同类 CVE' },
    ],
    callStep: async ({ id, prompt }) => {
      calls.push({ id, prompt });
      return { content: `结果-${id}` };
    },
  });
  assert.equal(out.error, undefined);
  assert.equal(out.ok, true);
  assert.equal(out.results.filter((r) => r.id !== '__verify__').length, 3);
  assert.deepEqual(out.results.filter((r) => r.id !== '__verify__').map((r) => r.id), ['scan', 'deep', 'docs']);
  assert.ok(out.results.some((r) => r.id === '__verify__' && r.ok), '自动补验必须真跑（上游有正文）');
  // 第一层 scan 与 docs 并行，deep 依赖 scan 的输出；再加一个自动补的对抗复核
  assert.equal(calls.length, 4);
  const deep = calls.find((c) => c.id === 'deep');
  assert.match(deep.prompt, /结果-scan/);
  const docs = calls.find((c) => c.id === 'docs');
  assert.ok(!/结果-scan/.test(docs.prompt), '无依赖的步骤不该注入别人的结果');
  assert.match(docs.prompt, /总目标：审查登录模块/);
});

test('workflow: 单个子代理失败不中断其它步骤，下游能看到失败标记', async () => {
  const calls = [];
  const out = await runWorkflow({
    goal: 'g',
    steps: [
      { id: 'a', prompt: 'A' },
      { id: 'b', prompt: 'B', depends_on: ['a'] },
    ],
    callStep: async ({ id, prompt }) => {
      calls.push({ id, prompt });
      if (id === 'a') return { error: '超时' };
      return { content: 'B ok' };
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.results.find((r) => r.id === 'a').ok, false);
  assert.equal(out.results.find((r) => r.id === 'b').ok, true);
  assert.match(calls.find((c) => c.id === 'b').prompt, /\[失败\] 超时/);
});

test('workflow: 默认并发上限 14（对齐 ZCode），显式 concurrency 也能收窄', async () => {
  let running = 0;
  let peak = 0;
  const out = await runWorkflow({
    goal: 'g',
    concurrency: 3, // 显式收窄 → 峰值必须 ≤3
    steps: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, prompt: `P${i}` })),
    callStep: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running -= 1;
      return { content: 'ok' };
    },
  });
  assert.equal(out.ok, true);
  assert.ok(peak <= 3, `并发峰值应 ≤3，实际 ${peak}`);

  // 不传 concurrency → 默认 14：5 个步骤应全部同时在跑
  let peak2 = 0; let live = 0;
  const out2 = await runWorkflow({
    goal: 'g2',
    steps: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, prompt: `P${i}` })),
    onUpdate: (snap) => { const runningNow = snap.steps.filter((x) => x.status === 'running').length; peak2 = Math.max(peak2, runningNow); },
    callStep: async () => {
      live += 1; peak2 = Math.max(peak2, live);
      await new Promise((r) => setTimeout(r, 40));
      live -= 1;
      return { content: 'ok' };
    },
  });
  assert.equal(out2.ok, true);
  assert.ok(peak2 >= 5, `默认并发应 >=5（5 个步骤全并行），实际 ${peak2}`);
});

test('workflow: goal 为空直接报错', async () => {
  const out = await runWorkflow({ goal: '', steps: [{ id: 'a', prompt: 'x' }], callStep: async () => ({ content: 'x' }) });
  assert.match(out.error, /goal/);
});

test('workflow: onUpdate 推送实时快照（状态流转 pending → running → success）', async () => {
  const snaps = [];
  const out = await runWorkflow({
    goal: 'g',
    steps: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B', depends_on: ['a'] }],
    callStep: async ({ id }) => ({ content: 'ok-' + id }),
    onUpdate: (s) => snaps.push({ running: s.running, steps: s.steps.map((x) => x.status) }),
  });
  assert.equal(out.ok, true);
  assert.ok(snaps.length >= 4, '每一步都要有更新');
  assert.deepEqual(snaps[0].steps, ['pending', 'pending']);
  assert.ok(snaps.some((s) => s.steps[0] === 'running'), '应有运行中状态');
  assert.deepEqual(snaps.at(-1).steps, ['success', 'success']);
  assert.equal(snaps.at(-1).running, false);
});


test('workflow: 暂停期间不起新子代理，恢复后继续（control.paused）', async () => {
  const control = { paused: false, aborted: false, maxConcurrency: 1 };
  const started = [];
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  const run = runWorkflow({
    goal: 'g',
    steps: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B' }, { id: 'c', prompt: 'C' }],
    control,
    callStep: async ({ id }) => {
      started.push(id);
      if (id === 'a') await gate;
      return { content: 'ok-' + id };
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(started, ['a'], '并发=1 时先只跑第一个');
    control.paused = true;
    releaseFirst();
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(started, ['a'], '暂停时不能再起新子代理');
  } finally {
    control.paused = false; // 断言失败也要放开，避免挂住事件循环
  }
  const out = await run;
  assert.equal(out.ok, true);
  assert.deepEqual(started.slice(1).sort(), ['b', 'c']);
});

test('workflow: control.maxConcurrency 限制同时在跑的子代理数', async () => {
  const control = { paused: false, aborted: false, maxConcurrency: 1 };
  let live = 0; let peak = 0;
  const out = await runWorkflow({
    goal: 'g',
    steps: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B' }, { id: 'c', prompt: 'C' }],
    control,
    callStep: async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 60));
      live--;
      return { content: 'ok' };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(peak, 1, '并发=1 时不应同时跑两个');
});

test('workflow: control.aborted 停止后未跑的步骤标为 cancelled', async () => {
  const control = { paused: false, aborted: false, maxConcurrency: 1 };
  const snaps = [];
  const out = await runWorkflow({
    goal: 'g',
    steps: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B', depends_on: ['a'] }],
    control,
    onUpdate: (s) => snaps.push(s.steps.map((x) => x.status)),
    callStep: async ({ id }) => { if (id === 'a') control.aborted = true; return { content: 'ok-' + id }; },
  });
  assert.equal(out.stopped, true);
  assert.equal(out.results.length, 1);
  assert.ok(snaps.at(-1).includes('cancelled'), '未跑的步骤应标记已取消');
});

// ---------------- journal / 断点恢复 / 容量可配 ----------------

test('workflow: stepHash 只由 goal/id/prompt/role/depends_on 决定（稳定）', () => {
  const base = { id: 'a', prompt: 'p', role: 'r', depends_on: ['x'], name: '展示名', budget: { maxTurns: 3 } };
  const h = stepHash('g', base);
  assert.match(h, /^[0-9a-f]{40}$/);
  assert.equal(stepHash('g', { ...base, name: '另一个名字', budget: undefined }), h, 'name/budget 不参与 hash');
  assert.notEqual(stepHash('g', { ...base, prompt: 'p2' }), h);
  assert.notEqual(stepHash('g', { ...base, role: 'r2' }), h);
  assert.notEqual(stepHash('g2', base), h);
  assert.notEqual(stepHash('g', { ...base, depends_on: ['y'] }), h);
});

test('workflow-journal: runId 可注入、原子写读回环、list 按 startedAt 倒序', async () => {
  const r1 = runIdOf({ now: () => 1700000000000, random: () => 0.25 });
  const r2 = runIdOf({ now: () => 1700000000000, random: () => 0.75 });
  assert.match(r1, /^wf-[0-9]{17}-[0-9a-f]{8}$/);
  assert.notEqual(r1, r2, '同一毫秒不同随机数必须得到不同 runId');

  await withTempDir(async (dir) => {
    const nested = join(dir, 'nested');
    const j1 = createJournal({ runId: r1, goal: 'G1', startedAt: 1000 });
    const j2 = createJournal({ runId: r2, goal: 'G2', startedAt: 2000 });
    assert.equal(j1.version, 1);
    assert.deepEqual(Object.keys(j1).sort(), ['finishedAt', 'goal', 'runId', 'startedAt', 'steps', 'stopped', 'version']);
    // 目录不存在 → saveJournal 自动 mkdir
    await saveJournal(j1, { dir: nested });
    await saveJournal(j2, { dir: nested });
    assert.deepEqual(await loadJournal(r1, { dir: nested }), j1, '读回内容与写入一致');
    assert.equal(await loadJournal('missing-run', { dir: nested }), null);
    assert.deepEqual(await listJournals({ dir: join(dir, 'no-such') }), []);
    const files = await readdir(nested);
    assert.deepEqual(files.sort(), [`${r1}.json`, `${r2}.json`].sort(), '只留最终文件，无 .tmp 残留');
    const list = await listJournals({ dir: nested });
    assert.deepEqual(list.map((j) => j.runId), [r2, r1], '按 startedAt 倒序');
    await writeFile(join(nested, 'broken.json'), '{oops', 'utf8');
    assert.equal((await listJournals({ dir: nested })).length, 2, '损坏文件应被跳过');
  });
});

test('workflow-resume: hash 未变的成功步骤不调用 callStep，snapshot 标记 reused', async () => {
  await withTempDir(async (dir) => {
    const steps = [
      { id: 'a', name: 'A', role: '侦察员', prompt: 'PA' },
      { id: 'b', name: 'B', prompt: 'PB', depends_on: ['a'] },
    ];
    let firstCalls = 0;
    const out1 = await runWorkflow({
      goal: 'G',
      steps,
      journalDir: dir,
      callStep: async ({ id }) => { firstCalls++; return { content: `C-${id}`, toolCount: id === 'a' ? 2 : 1 }; },
    });
    assert.equal(firstCalls, 2);
    assert.ok(out1.runId);
    const journal = await loadJournal(out1.runId, { dir });
    assert.equal(journal.steps.a.status, 'success');
    assert.equal(journal.steps.a.hash, stepHash('G', steps[0]));
    assert.equal(typeof journal.finishedAt, 'number');
    assert.equal(journal.stopped, false);

    const snaps = [];
    let secondCalls = 0;
    const out2 = await runWorkflow({
      goal: 'G',
      steps,
      resumeFrom: out1.runId, // 走 runId 字符串 + journalDir 加载路径
      journalDir: dir,
      onUpdate: (s) => snaps.push(s),
      callStep: async () => { secondCalls++; return { content: '不该被调用' }; },
    });
    assert.equal(secondCalls, 0, '两步都可复用，callStep 调用次数必须为 0');
    assert.equal(out2.ok, true);
    assert.equal(out2.runId, out1.runId);
    assert.deepEqual(out2.results.map((r) => r.content), ['C-a', 'C-b']);
    assert.equal(out2.results[0].reused, true);
    assert.equal(out2.results[0].ms, journal.steps.a.ms);
    assert.equal(out2.results[0].tools, 2);
    const last = snaps.at(-1);
    assert.equal(last.runId, out1.runId);
    assert.equal(last.steps.find((s) => s.id === 'a').reused, true);
    assert.equal(last.steps.find((s) => s.id === 'b').reused, true);
    assert.equal(last.steps.find((s) => s.id === 'b').ms, journal.steps.b.ms);
    const j2 = await loadJournal(out1.runId, { dir });
    assert.equal(j2.stopped, false);
    assert.equal(typeof j2.finishedAt, 'number');
  });
});

test('workflow-resume: 改一步 prompt 只重跑该步及其下游（级联失效）', async () => {
  await withTempDir(async (dir) => {
    const steps = [
      { id: 'a', prompt: 'PA' },
      { id: 'b', prompt: 'PB-old', depends_on: ['a'] },
      { id: 'c', prompt: 'PC', depends_on: ['b'] },
      { id: 'd', prompt: 'PD' },
    ];
    const out1 = await runWorkflow({ goal: 'G', steps, journalDir: dir, callStep: async ({ id }) => ({ content: `C-${id}` }) });
    const journal = await loadJournal(out1.runId, { dir });
    const changed = steps.map((s) => (s.id === 'b' ? { ...s, prompt: 'PB-new' } : s));
    const norm = normalizeSteps(changed);
    const { reusable, reasons } = computeReuse(journal, norm, 'G');
    assert.deepEqual([...reusable].sort(), ['a', 'd']);
    assert.match(reasons.b, /变更|hash/);
    assert.match(reasons.c, /依赖 b/);
    assert.equal(stepHash('G', norm.byId.get('c')), journal.steps.c.hash, 'c 自身没变，失效只因上游');

    const calls = [];
    const out2 = await runWorkflow({
      goal: 'G',
      steps: changed,
      resumeFrom: journal,
      journalDir: dir,
      callStep: async ({ id }) => { calls.push(id); return { content: `C2-${id}` }; },
    });
    assert.deepEqual(calls.sort(), ['b', 'c']);
    assert.equal(out2.ok, true);
    assert.equal(out2.results.find((r) => r.id === 'a').reused, true);
    assert.equal(out2.results.find((r) => r.id === 'd').reused, true);
    assert.equal(out2.results.find((r) => r.id === 'b').reused, false);
  });
});

test('workflow-resume: 依赖失败时依赖链下游不可复用', async () => {
  await withTempDir(async (dir) => {
    const steps = [{ id: 'a', prompt: 'PA' }, { id: 'b', prompt: 'PB', depends_on: ['a'] }];
    const out1 = await runWorkflow({
      goal: 'G',
      steps,
      journalDir: dir,
      callStep: async ({ id }) => (id === 'a' ? { error: 'boom' } : { content: 'C-b' }),
    });
    assert.equal(out1.ok, false);
    const journal = await loadJournal(out1.runId, { dir });
    assert.equal(journal.steps.a.status, 'failed');
    assert.equal(journal.steps.b.status, 'success');
    const { reusable, reasons } = computeReuse(journal, normalizeSteps(steps), 'G');
    assert.equal(reusable.size, 0);
    assert.match(reasons.a, /未成功/);
    assert.match(reasons.b, /依赖 a/);

    const calls = [];
    const out2 = await runWorkflow({
      goal: 'G',
      steps,
      resumeFrom: journal,
      journalDir: dir,
      callStep: async ({ id, prompt }) => { calls.push({ id, prompt }); return { content: `C2-${id}` }; },
    });
    assert.deepEqual(calls.map((c) => c.id).sort(), ['a', 'b'], '失败步骤及其下游都要重跑');
    assert.match(calls.find((c) => c.id === 'b').prompt, /C2-a/, '重跑时下游拿到的是本次新结果');
    assert.equal(out2.ok, true);
  });
});

test('workflow-journal: 暂停后 abort 仍写出 stopped/finishedAt，未执行步骤记 cancelled', async () => {
  await withTempDir(async (dir) => {
    const control = { paused: true, aborted: false, maxConcurrency: 1 };
    const run = runWorkflow({
      goal: 'G',
      steps: [{ id: 'a', prompt: 'PA' }, { id: 'b', prompt: 'PB' }],
      control,
      journalDir: dir,
      callStep: async () => ({ content: 'ok' }),
    });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(control.aborted, false);
    control.aborted = true;
    const out = await run;
    assert.equal(out.stopped, true);
    const journal = await loadJournal(out.runId, { dir });
    assert.equal(journal.stopped, true);
    assert.equal(typeof journal.finishedAt, 'number');
    assert.equal(journal.steps.a.status, 'cancelled');
    assert.equal(journal.steps.b.status, 'cancelled');
    assert.equal(journal.steps.a.error, '工作流已停止');
  });
});

test('workflow: maxSteps clamp 1..64，maxConcurrency clamp 1..32', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, prompt: `P${i}` }));
  assert.match(normalizeSteps(many, { maxSteps: 100 }).error, /最多 64 个/);
  assert.equal(normalizeSteps([{ id: 'a', prompt: 'x' }], { maxSteps: 0 }).error, undefined);
  assert.match(normalizeSteps([{ id: 'a', prompt: 'x' }, { id: 'b', prompt: 'y' }], { maxSteps: 0 }).error, /最多 1 个/);
  const steps15 = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, prompt: 'x' }));
  assert.match(normalizeSteps(steps15).error, /最多 14 个/);

  const steps40 = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, prompt: `P${i}` }));
  const runPeak = async (extra) => {
    let live = 0;
    let peak = 0;
    let snapLimit = 0;
    const out = await runWorkflow({
      goal: 'g',
      steps: steps40,
      maxSteps: 64,
      onUpdate: (s) => { snapLimit = Math.max(snapLimit, s.concurrency); },
      callStep: async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 20));
        live--;
        return { content: 'ok' };
      },
      ...extra,
    });
    return { out, peak, snapLimit };
  };
  const ctlRun = await runPeak({ control: { paused: false, aborted: false, maxConcurrency: 100 } });
  assert.equal(ctlRun.out.ok, true);
  assert.equal(ctlRun.snapLimit, 32, 'control.maxConcurrency=100 应 clamp 到 32');
  assert.ok(ctlRun.peak <= 32, `并发峰值应 ≤32，实际 ${ctlRun.peak}`);
  const optRun = await runPeak({ concurrency: 100 });
  assert.equal(optRun.snapLimit, 32, 'concurrency=100 应 clamp 到 32');
  assert.ok(optRun.peak <= 32);
});

test('workflow: 每步 budget 校验/clamp 并透传到 callStep ctx', async () => {
  const norm = normalizeSteps([
    { id: 'a', prompt: 'x', budget: { maxTurns: 100, maxTools: 0, maxMs: 100 } },
    { id: 'b', prompt: 'y', budget: { maxTurns: -3, maxTools: 50, maxMs: 1e9 } },
  ]);
  assert.equal(norm.error, undefined);
  assert.deepEqual(norm.steps[0].budget, { maxTurns: 50, maxTools: 1, maxMs: 3000 });
  assert.deepEqual(norm.steps[1].budget, { maxTurns: 1, maxTools: 50, maxMs: 600000 });
  assert.match(normalizeSteps([{ id: 'a', prompt: 'x', budget: { maxMs: 'abc' } }]).error, /budget\.maxMs/);
  assert.match(normalizeSteps([{ id: 'a', prompt: 'x', budget: 'bad' }]).error, /budget 必须是对象/);

  const calls = [];
  const out = await runWorkflow({
    goal: 'g',
    steps: [{ id: 'a', prompt: 'x', budget: { maxTurns: 100, maxTools: 0, maxMs: 100 } }],
    callStep: async (ctx) => { calls.push(ctx); return { content: 'ok' }; },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(calls[0].budget, { maxTurns: 50, maxTools: 1, maxMs: 3000 });
});

test('workflow-resume: 复用内容进入下游 prompt', async () => {
  await withTempDir(async (dir) => {
    const base = [{ id: 'a', prompt: 'PA' }, { id: 'b', prompt: 'PB-old', depends_on: ['a'] }];
    const out1 = await runWorkflow({
      goal: 'G',
      steps: base,
      journalDir: dir,
      callStep: async ({ id }) => ({ content: id === 'a' ? 'ALPHA-复用内容' : 'C-b' }),
    });
    const journal = await loadJournal(out1.runId, { dir });
    const steps2 = [{ id: 'a', prompt: 'PA' }, { id: 'b', prompt: 'PB-new', depends_on: ['a'] }];
    let bPrompt = '';
    const out2 = await runWorkflow({
      goal: 'G',
      steps: steps2,
      resumeFrom: journal,
      journalDir: dir,
      callStep: async ({ id, prompt }) => { if (id === 'b') bPrompt = prompt; return { content: 'C-b2' }; },
    });
    assert.equal(out2.results.find((r) => r.id === 'a').reused, true);
    assert.equal(out2.results.find((r) => r.id === 'b').reused, false);
    assert.match(bPrompt, /ALPHA-复用内容/, '复用的上游 content 必须注入下游 buildPrompt');
  });
});

test('workflow: 不传 journalDir 行为与旧版一致（不落盘、无 reused）', async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const snaps = [];
    const out = await runWorkflow({
      goal: 'G',
      steps: [{ id: 'a', name: '依赖供应链专员', prompt: 'PA' }, { id: 'b', name: '交付报告主编', prompt: 'PB', depends_on: ['a'] }],
      callStep: async ({ id, prompt }) => { calls.push({ id, prompt }); return { content: `C-${id}` }; },
      onUpdate: (s) => snaps.push(s),
    });
    assert.equal(out.ok, true);
    assert.equal(out.error, undefined);
    assert.equal(calls.length, 2);
    assert.deepEqual(out.results.map((r) => r.content), ['C-a', 'C-b']);
    assert.deepEqual(out.steps.map((s) => s.id), ['a', 'b']);
    // 展示名契约改为「职位名」（模型给的合法 name 原样保留，不再是「步骤 N」）
    assert.equal(out.summary, 'a 依赖供应链专员: 完成\nb 交付报告主编: 完成', '返回结构与旧版一致');
    assert.ok(!snaps.some((s) => s.steps.some((x) => x.reused === true)), '无 journal 不应出现 reused');
    assert.deepEqual(snaps.at(-1).phases, [['a'], ['b']]);
    assert.deepEqual(await readdir(dir), [], '不传 journalDir 不应写任何文件');
  });
});

// ---------------- swarm 对抗验证协议接线 ----------------

test('workflow-swarm: normalizeSteps 透传 kind/model/providerId/blind/targetsFrom，未知 kind 报错', () => {
  const norm = normalizeSteps([
    { id: 'r', prompt: '侦察', kind: 'recon' },
    {
      id: 'v',
      prompt: '盲验',
      kind: 'verify',
      depends_on: ['r'],
      model: 'm1',
      providerId: 'p1',
      blind: false,
      targetsFrom: 'r',
    },
  ]);
  assert.equal(norm.error, undefined);
  assert.equal(norm.steps[0].kind, 'recon');
  assert.equal(norm.steps[0].blind, false, 'recon 默认非盲');
  assert.equal(norm.steps[1].kind, 'verify');
  assert.equal(norm.steps[1].model, 'm1');
  assert.equal(norm.steps[1].providerId, 'p1');
  assert.equal(norm.steps[1].blind, false, '显式 blind=false 透传');
  assert.equal(norm.steps[1].targetsFrom, 'r');

  const verifyOnly = normalizeSteps([{ id: 'v', prompt: '盲验', kind: 'verify' }]);
  assert.equal(verifyOnly.steps[0].blind, true, 'verify 默认盲验');

  assert.match(normalizeSteps([{ id: 'a', prompt: 'x', kind: 'nope' }]).error, /未知步骤 kind/);
  const badTarget = normalizeSteps([
    { id: 'a', prompt: 'x', kind: 'verify', targetsFrom: 'zzz' },
  ]);
  assert.match(badTarget.error, /targetsFrom 指向不存在的步骤/);
  assert.match(
    normalizeSteps([{ id: 'a', prompt: 'x', kind: 'find', depends_on: ['a'] }]).error,
    /不能依赖自己/,
  );
});

test('workflow-swarm: 无 kind 的旧步骤 prompt 与旧版逐字一致', async () => {
  let ctxSeen;
  const out = await runWorkflow({
    goal: 'G',
    steps: [{ id: 'a', role: 'R', prompt: 'P' }],
    callStep: async (ctx) => {
      ctxSeen = ctx;
      return { content: 'ok' };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(
    ctxSeen.prompt,
    '总目标：G\n你的角色：R\n本步骤任务：P\n\n只输出本步骤的交付物（结论/清单/代码/证据），不要复述总目标，不要寒暄。',
    '旧步骤 prompt 必须逐字不变',
  );
  assert.equal(ctxSeen.kind, null);
  assert.equal(ctxSeen.model, null);
  assert.equal(ctxSeen.providerId, null);
  assert.equal(ctxSeen.blind, null);
  assert.deepEqual(out.claims, [], '旧步骤不产生 claim');
});

test('workflow-swarm: recon→find 3 claims→verify 1 rejected/1 uncertain/1 confirmed→report 端到端', async () => {
  const calls = [];
  const snaps = [];
  const finderNarrative = '发现者叙述-MARKER-不得进入盲验提示词';
  const findContent = JSON.stringify({
    narrative: finderNarrative,
    findings: [
      { id: 'f1', claim: 'A 路径可被未校验输入命中', evidence: 'node repro-a.mjs -> hit', severity: 'high', file: 'a.mjs', line: 10, reproduced: true },
      { id: 'f2', claim: 'B 路径行为不确定', evidence: 'node repro-b.mjs -> 无稳定输出', severity: 'medium', file: 'b.mjs', line: 20, reproduced: false },
      { id: 'f3', claim: 'C 路径会被拦截', evidence: 'node repro-c.mjs -> blocked', severity: 'low', file: 'c.mjs', line: 30, reproduced: true },
    ],
  });
  const reportContent = [
    '## Conclusion',
    'A 可复现，B 不确定，C 已驳回。',
    '## Findings',
    '- f1 [confirmed] A 路径可被未校验输入命中',
    '- f2 [lead] B 路径行为不确定',
    '## Verified',
    '- f1 @ a.mjs:10（独立复现）',
    '## Not covered',
    'None',
    '## Skipped',
    'None',
  ].join('\n');

  const out = await runWorkflow({
    goal: '审查输入校验',
    steps: [
      { id: 'r1', name: '侦察', kind: 'recon', prompt: '列攻击面' },
      { id: 'f1s', name: '取证', kind: 'find', depends_on: ['r1'], prompt: '逐条取证' },
      { id: 'v1', name: '盲验', kind: 'verify', depends_on: ['f1s'], prompt: '独立复现', model: 'verifier-1' },
      { id: 'rep', name: '报告', kind: 'report', depends_on: ['v1'], prompt: '汇总五段' },
    ],
    onUpdate: (s) => snaps.push(s),
    callStep: async (ctx) => {
      calls.push(ctx);
      if (ctx.kind === 'recon') {
        return { content: JSON.stringify({ targets: [{ id: 't1', path: 'a.mjs', risk: 'high', reason: '入口' }] }) };
      }
      if (ctx.kind === 'find') return { content: findContent };
      if (ctx.kind === 'verify') {
        return {
          content: JSON.stringify({
            verdicts: [
              { claimId: 'f1', verdict: 'confirmed', evidence: '亲自运行 repro-a -> hit', note: '复现成功' },
              { claimId: 'f2', verdict: 'uncertain', evidence: '复现无稳定输出', note: '不能确认' },
              { claimId: 'f3', verdict: 'rejected', evidence: '亲自运行 repro-c -> blocked，与 claim 冲突', note: '驳回' },
            ],
          }),
          model: 'verifier-1',
        };
      }
      if (ctx.kind === 'report') return { content: reportContent };
      return { content: 'ok' };
    },
  });

  assert.equal(out.error, undefined);
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.map((r) => r.id), ['r1', 'f1s', 'v1', 'rep']);

  const findCall = calls.find((c) => c.kind === 'find');
  assert.match(findCall.prompt, /侦察目标/, 'recon 产出的 targets 要作为线索进入 find');
  assert.match(findCall.prompt, /t1/);
  assert.equal(findCall.blind, false);

  const verifyCall = calls.find((c) => c.kind === 'verify');
  assert.equal(verifyCall.blind, true, 'verify 默认盲验');
  assert.equal(verifyCall.model, 'verifier-1');
  assert.match(verifyCall.prompt, /"claims"/);
  assert.match(verifyCall.prompt, /f1/);
  assert.ok(!verifyCall.prompt.includes(finderNarrative), 'verify prompt 不得包含 finder 叙述');
  assert.ok(!verifyCall.prompt.includes('"findings"'), 'verify prompt 不得包含 finder 原始 JSON');

  const byId = new Map(out.claims.map((c) => [c.id, c]));
  assert.equal(byId.size, 3);
  assert.equal(byId.get('f1').status, 'confirmed');
  assert.equal(byId.get('f1').verifiedBy.model, 'verifier-1');
  assert.equal(byId.get('f2').status, 'lead');
  assert.equal(byId.get('f3').status, 'rejected');
  assert.deepEqual(out.claimWarnings, [], '状态流转后不应有 lint warning');

  const findResult = out.results.find((r) => r.id === 'f1s');
  assert.equal(findResult.claims.length, 3);
  assert.deepEqual(findResult.claims.map((c) => c.status), ['pending', 'pending', 'pending'], 'find 产出默认 pending');

  const last = snaps.at(-1);
  const findStep = last.steps.find((s) => s.id === 'f1s');
  assert.equal(findStep.kind, 'find');
  assert.equal(findStep.claims, 3);
  assert.equal(findStep.confirmed, 1, 'snapshot.find 步 confirmed 计数必须为 1');
  assert.equal(last.steps.find((s) => s.id === 'r1').kind, 'recon');
  assert.equal(last.steps.find((s) => s.id === 'v1').kind, 'verify');

  const reportResult = out.results.find((r) => r.id === 'rep');
  assert.deepEqual(reportResult.reportWarnings, [], '合规五段报告不应有 lint warning');
});

test('workflow-swarm: 没有 verify 覆盖时 claim 不能变成 confirmed', async () => {
  const out = await runWorkflow({
    goal: 'G',
    steps: [
      { id: 'f', kind: 'find', prompt: '取证' },
      { id: 'v', kind: 'verify', prompt: '盲验', depends_on: ['f'] },
    ],
    callStep: async ({ kind }) => {
      if (kind === 'find') {
        return {
          content: JSON.stringify({
            findings: [{ id: 'only', claim: '未验证结论', evidence: 'e', file: 'a.mjs', line: 1, reproduced: false }],
          }),
        };
      }
      return { content: JSON.stringify({ verdicts: [] }) };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.claims.length, 1);
  assert.equal(out.claims[0].status, 'pending', 'verify 没有 verdict 时必须保持 pending');
  assert.ok(out.results.find((r) => r.id === 'v').verdictsEmpty);
});

test('workflow-swarm: journalDir 存在时写 <runId>.claims.jsonl', async () => {
  await withTempDir(async (dir) => {
    const out = await runWorkflow({
      goal: 'G',
      journalDir: dir,
      steps: [
        { id: 'f', kind: 'find', prompt: '取证', model: 'finder-1' },
        { id: 'v', kind: 'verify', prompt: '盲验', depends_on: ['f'], model: 'verifier-1' },
      ],
      callStep: async ({ kind }) => {
        if (kind === 'find') {
          return {
            content: JSON.stringify({
              findings: [
                { id: 'c1', claim: 'A', evidence: 'e1', file: 'a.mjs', line: 1, reproduced: true },
                { id: 'c2', claim: 'B', evidence: 'e2', file: 'b.mjs', line: 2, reproduced: false },
              ],
            }),
          };
        }
        return {
          content: JSON.stringify({
            verdicts: [
              { claimId: 'c1', verdict: 'confirmed', evidence: '亲自复现', note: 'ok' },
              { claimId: 'c2', verdict: 'uncertain', evidence: '无法复现', note: '待定' },
            ],
          }),
        };
      },
    });
    assert.equal(out.ok, true);
    const claimsFile = `${out.runId}.claims.jsonl`;
    assert.ok((await readdir(dir)).includes(claimsFile), 'claims 文件必须与 journal 同目录');
    assert.equal(out.claimsFile, join(dir, claimsFile));
    const lines = (await readFile(join(dir, claimsFile), 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, 2);
    const rows = lines.map((l) => JSON.parse(l));
    assert.equal(rows.find((r) => r.id === 'c1').status, 'confirmed');
    assert.equal(rows.find((r) => r.id === 'c2').status, 'lead');
  });
});

test('workflow-swarm: 断点恢复时从复用内容重建 claim 状态', async () => {
  await withTempDir(async (dir) => {
    const steps = [
      { id: 'f', kind: 'find', prompt: '取证', model: 'finder-1' },
      { id: 'v', kind: 'verify', prompt: '盲验', depends_on: ['f'], model: 'verifier-1' },
    ];
    const out1 = await runWorkflow({
      goal: 'G',
      steps,
      journalDir: dir,
      callStep: async ({ kind }) => {
        if (kind === 'find') {
          return {
            content: JSON.stringify({
              findings: [
                { id: 'c1', claim: 'A', evidence: 'e1', file: 'a.mjs', line: 1, reproduced: true },
                { id: 'c2', claim: 'B', evidence: 'e2', file: 'b.mjs', line: 2, reproduced: false },
              ],
            }),
          };
        }
        return {
          content: JSON.stringify({
            verdicts: [
              { claimId: 'c1', verdict: 'confirmed', evidence: '亲自复现', note: 'ok' },
              { claimId: 'c2', verdict: 'rejected', evidence: '与 claim 冲突', note: '驳回' },
            ],
          }),
        };
      },
    });
    assert.equal(out1.ok, true);

    let resumedCalls = 0;
    const out2 = await runWorkflow({
      goal: 'G',
      steps,
      resumeFrom: out1.runId,
      journalDir: dir,
      callStep: async () => { resumedCalls += 1; return { content: '不该被调用' }; },
    });
    assert.equal(resumedCalls, 0, '两步 hash 未变，应全部复用');
    assert.equal(out2.results.every((r) => r.reused), true);
    assert.equal(out2.claims.length, 2);
    assert.equal(out2.claims.find((c) => c.id === 'c1').status, 'confirmed', '复用的 verify 输出要重建 confirmed');
    assert.equal(out2.claims.find((c) => c.id === 'c2').status, 'rejected', '复用的 verify 输出要重建 rejected');
    assert.deepEqual(out2.claimWarnings, []);
  });
});
