// 步 6-7 验收（规格 §5.1 数值 + §5.2 行为）：
//   每轮摘要 300-5000 token、摘要库恒定 10 份 + 1 份古老。
//
// 这是本次改造真正要补的那一层：跨轮重建历史时工具结果不进上下文，
// 所以「第 1 轮读过什么」只能靠摘要带过去。纯函数测试，不调 LLM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planRollup, checkSummaryLength, estimateSummaryTokens, buildMergeInput, buildMergeGroups,
  SUMMARY_MAX_TOKENS, KEEP_RECENT_ROUNDS, SUMMARY_FIELDS
} from '../desktop/src/main/round-summary.mjs';
import { toolDigestOf, renderRoundSummaries, writeRoundSummary, awaitPendingRoundSummary } from '../desktop/src/main/round-summary-wire.mjs';

const mk = (n, textOf = (i) => '第 ' + i + ' 轮摘要：读了 src/file' + i + '.mjs，改了第 ' + (i + 10) + ' 行') =>
  Array.from({ length: n }, (_, i) => ({ id: 'r' + i, text: textOf(i), at: i * 1000 }));

test('§5.1: 11 轮摘要 → 最近 10 份 + 1 份待合并（恒定）', () => {
  const p = planRollup(mk(11));
  assert.equal(p.recent.length, KEEP_RECENT_ROUNDS, '最近 10 轮原文');
  assert.equal(p.needsMerge, true, '第 11 轮触发合并');
  assert.equal(p.toMerge.length, 1, '溢出 1 份');
});

test('§5.1: 100 轮 → 仍是 10 份 recent（总量恒定，压 100 次不变）', () => {
  const p = planRollup(mk(100));
  assert.equal(p.recent.length, 10);
  assert.equal(p.toMerge.length, 90, '90 份待合并成 1 份古老');
  // 合并后：1 古老 + 10 recent = 11 份
  const afterMerge = [{ id: 'ancient', text: '合并后的古老摘要', ancient: true }, ...p.recent];
  const again = planRollup(afterMerge);
  assert.equal(again.needsMerge, false, '合并后不再触发（下次再攒满 10 份才合并）');
});

test('§5.1: 不足 10 轮不合并（避免无意义 LLM 调用）', () => {
  for (const n of [1, 3, 10]) {
    const p = planRollup(mk(n));
    assert.equal(p.needsMerge, false, `${n} 轮不该合并`);
    assert.equal(p.recent.length, n);
  }
});

test('§5.1: 摘要长度校验 300-5120 token', () => {
  // 短摘要：允许（内容本来就少）
  assert.equal(checkSummaryLength('一句话').ok, true);
  // 目标区间内
  const mid = 'a'.repeat(4000); // ≈1000 token
  const r = checkSummaryLength(mid);
  assert.equal(r.ok, true);
  assert.ok(r.tokens >= 300 && r.tokens <= SUMMARY_MAX_TOKENS * 0.5, '应落在合理区间');
  // 超上限
  const huge = 'a'.repeat(40000); // ≈10000 token
  const h = checkSummaryLength(huge);
  assert.equal(h.ok, false);
  assert.match(String(h.reason), /超上限/);
});

test('§3.4: 摘要字段固定 6 段（对齐 CC 模板）', () => {
  assert.equal(SUMMARY_FIELDS.length, 6);
  assert.deepEqual(SUMMARY_FIELDS, [
    '用户本轮想要什么',
    '关键技术概念 / 决策',
    '涉及的文件与改动',
    '报过的错与怎么修的',
    '待办 / 未完成项',
    '当前正在做什么'
  ]);
});

test('§5.2: renderRoundSummaries 渲染成可注入文本（含古老 + 最近）', () => {
  const list = [
    { id: 'ancient', text: '古老：第 1-90 轮做了 X', ancient: true },
    ...mk(3).map((x) => ({ ...x, ancient: false }))
  ];
  const out = renderRoundSummaries(list);
  assert.match(out, /历史轮次摘要/);
  assert.match(out, /更早的对话（已合并）/, '古老摘要要单列');
  assert.match(out, /最近 3 轮/, '最近的轮次要标数量');
  assert.match(out, /第 1-90 轮做了 X/, '古老内容要在');
  assert.equal(renderRoundSummaries([]), '', '空列表返回空串');
});

test('§3.4: toolDigestOf 把工具调用压成可抄行号的清单', () => {
  const trace = [
    { tool: 'read_file', args: { path: 'src/a.mjs' }, status: 'ok' },
    { tool: 'edit_file', args: { path: 'src/b.mjs' }, status: 'ok' },
    { tool: 'run_command', args: { command: 'npm test' }, status: 'fail', error: 'exit 1' }
  ];
  const digest = toolDigestOf(trace);
  assert.match(digest, /read_file src\/a\.mjs/);
  assert.match(digest, /edit_file src\/b\.mjs/);
  assert.match(digest, /run_command npm test/);
  assert.match(digest, /报错：exit 1/, '报错要带上');
});

test('§7: 合并输入超预算时分组，任何一份都不丢（旧实现从最老的开始丢）', () => {
  // 5 份 × 5000 字符，预算 12000 → 分成多组，但第 0 份（古老摘要所在位置）必须在
  const list = Array.from({ length: 5 }, (_, i) => ({ text: '第' + i + '轮' + 'x'.repeat(4990) }));
  const groups = buildMergeGroups(list, 12000);
  assert.ok(groups.length >= 2, '超预算必须分组');
  const all = groups.join('\n');
  for (let i = 0; i < 5; i++) assert.match(all, new RegExp('第' + i + '轮'), `第 ${i} 份不能丢`);
  for (const g of groups) assert.ok(g.length <= 12000 + 200, '每组不超预算');
  assert.match(groups[0], /第0轮/, '最老的（古老摘要）排在第一组');
  assert.match(buildMergeInput(list), /第0轮/, '兼容接口也不再截断');
});

test('边界: 空摘要 / 空输入不崩', () => {
  assert.equal(planRollup([]).recent.length, 0);
  assert.equal(planRollup(null).recent.length, 0);
  assert.equal(buildMergeInput([]), '');
  assert.equal(estimateSummaryTokens(''), 0);
  assert.equal(toolDigestOf(null), '');
});

// ───────── 2026-11-17 修复回归（fix/zcode-codex-review 分支）─────────

test('toolDigestOf：真实 trace 的 args 是 JSON 字符串，路径/行号必须解析出来', () => {
  const trace = [
    { tool: 'read_file', args: JSON.stringify({ path: 'src/a.mjs' }), result: { totalLines: 120, offset: 0 } },
    { tool: 'grep_code', args: JSON.stringify({ pattern: 'NON_JS_EXTS', path: 'src' }), result: { total: 2, results: [{ file: 'src/scope-policy.mjs', line: 35, text: 'x' }, { file: 'src/walk.mjs', line: 9, text: 'y' }] } },
    { tool: 'edit_file', args: JSON.stringify({ path: 'src/b.mjs', old_string: 'a', new_string: 'b' }), result: { line: 42, added: 1, removed: 1 } },
    { tool: 'run_command', args: JSON.stringify({ command: 'npm test' }), result: { code: 1, stderr: '\nError: boom\n' } },
  ];
  const d = toolDigestOf(trace);
  assert.match(d, /read_file src\/a\.mjs 共 120 行/);
  assert.match(d, /src\/scope-policy\.mjs:35/, 'grep 命中行号要进清单');
  assert.match(d, /edit_file src\/b\.mjs 改动起始于第 42 行/);
  assert.match(d, /npm test 退出码 1 stderr：Error: boom/);
});

test('writeRoundSummary：同一会话并发写入不丢摘要（旧实现后写覆盖先写）', async () => {
  let store = [];
  const sessions = {
    loadRoundSummaries: async () => store.slice(),
    saveRoundSummaries: async (_id, l) => { await new Promise((r) => setTimeout(r, 5)); store = l; },
  };
  const slow = (ms, txt) => async () => { await new Promise((r) => setTimeout(r, ms)); return txt; };
  const a = writeRoundSummary({ sessionId: 'race', roundId: 'r1', userMessage: 'u1', trace: [], answer: 'a1', summarize: slow(30, '## 第一轮'), sessions });
  const b = writeRoundSummary({ sessionId: 'race', roundId: 'r2', userMessage: 'u2', trace: [], answer: 'a2', summarize: slow(1, '## 第二轮'), sessions });
  await Promise.all([a, b]);
  assert.deepEqual(store.map((x) => x.text), ['## 第一轮', '## 第二轮'], '两轮都在，且按回合顺序');
  assert.equal(await awaitPendingRoundSummary('race', { timeoutMs: 10 }), true);
});

test('writeRoundSummary：同一 roundId 重放不产生第二份摘要', async () => {
  let store = [];
  const sessions = { loadRoundSummaries: async () => store.slice(), saveRoundSummaries: async (_id, l) => { store = l; } };
  let calls = 0;
  const summarize = async () => { calls++; return '## 摘要'; };
  await writeRoundSummary({ sessionId: 'idem', roundId: 'x1', userMessage: 'u', trace: [], answer: 'a', summarize, sessions });
  const r = await writeRoundSummary({ sessionId: 'idem', roundId: 'x1', userMessage: 'u', trace: [], answer: 'a', summarize, sessions });
  assert.equal(r.skipped, true);
  assert.equal(store.length, 1);
  assert.equal(calls, 1, '已有摘要时不再调模型');
});

test('awaitPendingRoundSummary：摘要很慢时按超时返回 false，不卡住下一轮', async () => {
  const sessions = { loadRoundSummaries: async () => [], saveRoundSummaries: async () => {} };
  const p = writeRoundSummary({ sessionId: 'slow', roundId: 's', userMessage: 'u', trace: [], answer: 'a', summarize: () => new Promise((r) => setTimeout(() => r('x'), 200)), sessions });
  const t0 = Date.now();
  assert.equal(await awaitPendingRoundSummary('slow', { timeoutMs: 20 }), false);
  assert.ok(Date.now() - t0 < 150);
  await p;
});

test('滚动合并：合并输入超预算时逐组合并，古老摘要不丢', async () => {
  const ancient = { id: 'ancient', text: 'ANCIENT-第1轮 shell-resolver.mjs:42 ' + 'a'.repeat(20000), ancient: true, at: 1000, coversUntil: 1000 };
  const normal = Array.from({ length: 12 }, (_, i) => ({ id: 'r' + i, text: `第 ${i + 2} 轮 ` + 'b'.repeat(6000), at: 2000 + i * 1000 }));
  let saved = null;
  const sessions = { loadRoundSummaries: async () => [ancient, ...normal], saveRoundSummaries: async (_id, l) => { saved = l; } };
  const mergeInputs = [];
  const summarize = async (prompt) => {
    if (prompt.includes('合并成一份')) { mergeInputs.push(prompt); return prompt.includes('ANCIENT') ? 'MERGED-含ANCIENT' : 'MERGED'; }
    return '## 新一轮';
  };
  await writeRoundSummary({ sessionId: 'mg', roundId: 'n', userMessage: 'u', trace: [], answer: 'a', summarize, sessions });
  assert.ok(mergeInputs.length >= 2, '超预算要分组合并');
  assert.ok(mergeInputs.some((p) => p.includes('ANCIENT-第1轮')), '古老摘要必须进合并输入');
  assert.ok(saved.find((s) => s.ancient), '产出新的古老摘要');
});
