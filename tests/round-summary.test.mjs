// 步 6-7 验收（规格 §5.1 数值 + §5.2 行为）：
//   每轮摘要 300-5000 token、摘要库恒定 10 份 + 1 份古老。
//
// 这是本次改造真正要补的那一层：跨轮重建历史时工具结果不进上下文，
// 所以「第 1 轮读过什么」只能靠摘要带过去。纯函数测试，不调 LLM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planRollup, checkSummaryLength, estimateSummaryTokens, buildMergeInput,
  SUMMARY_MAX_TOKENS, KEEP_RECENT_ROUNDS, SUMMARY_FIELDS
} from '../desktop/src/main/round-summary.mjs';
import { toolDigestOf, renderRoundSummaries } from '../desktop/src/main/round-summary-wire.mjs';

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

test('§7 已知上限: buildMergeInput 超预算时保留更近的', () => {
  // 造 5 份，每份 5000 字符；预算 12000 → 只能保留最后 2 份左右
  const list = Array.from({ length: 5 }, (_, i) => ({ text: '第' + i + '轮' + 'x'.repeat(4990) }));
  const out = buildMergeInput(list, 12000);
  assert.ok(out.length <= 12000 + 100, '不超预算');
  assert.match(out, /第4轮/, '最近的必须保留');
  assert.doesNotMatch(out, /第0轮/, '最老的被丢掉');
});

test('边界: 空摘要 / 空输入不崩', () => {
  assert.equal(planRollup([]).recent.length, 0);
  assert.equal(planRollup(null).recent.length, 0);
  assert.equal(buildMergeInput([]), '');
  assert.equal(estimateSummaryTokens(''), 0);
  assert.equal(toolDigestOf(null), '');
});
