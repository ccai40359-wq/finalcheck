// 2026-11-17 外部审查 4 条 + pip-audit cwd 的回归测试。
//
// 这 5 条全是**静默**的：没有报错、没有日志、界面看不出异常，只有长期使用者
// （"攒了 30 轮工作然后突然全忘了"）才会察觉。所以每条都必须有可执行的对照。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  truncateSummaryText, estimateSummaryTokens, SUMMARY_MAX_TOKENS
} from '../desktop/src/main/round-summary.mjs';
import { dropRoundSummariesCoveredBy, writeRoundSummary } from '../desktop/src/main/round-summary-wire.mjs';

// ───────────────────────── 1（P0）：滚动合并不许丢已有的古老摘要

test('P0: 第 21 轮合并时，第 1 轮的古老摘要内容仍在合并输入里', async () => {
  // 场景：已有 1 份古老摘要（覆盖第 1 轮）+ 20 份普通轮摘要
  // 旧实现只喂 toMerge（第 2-11 轮），ancient 整份丢掉 → 第 1 轮永久消失。
  const ancient = { id: 'ancient', text: '第 1 轮：用户要求重写 shell-resolver，改了 desktop/src/main/shell-resolver.mjs:42', ancient: true, at: 1000, coversUntil: 1000 };
  const normal = Array.from({ length: 20 }, (_, i) => ({
    id: 'r' + i, text: `第 ${i + 2} 轮摘要`, at: 2000 + i * 1000,
  }));
  const list = [ancient, ...normal];

  let mergeInputSeen = '';
  const sessions = {
    loadRoundSummaries: async () => list,
    saveRoundSummaries: async () => {},
  };
  const summarize = async (prompt) => {
    if (prompt.includes('合并成一份')) mergeInputSeen = prompt;
    return '## 合并后的古老摘要\n保留第 1 轮结论';
  };

  const r = await writeRoundSummary({
    sessionId: 's1', userMessage: '继续', trace: [], answer: 'ok', summarize, sessions
  });
  assert.equal(r.ok, true);
  assert.match(mergeInputSeen, /shell-resolver\.mjs:42/, '第 1 轮的古老摘要必须进合并输入，不能凭空消失');
  assert.match(mergeInputSeen, /第 2 轮摘要/, '同时也要把溢出的轮摘要带上');
});

test('P0: 合并后的古老摘要 coversUntil 取最晚一条（覆盖范围只增不减）', async () => {
  const ancient = { id: 'ancient', text: '更早', ancient: true, at: 1000, coversUntil: 1000 };
  const normal = Array.from({ length: 20 }, (_, i) => ({ id: 'r' + i, text: 'x', at: 2000 + i * 1000 }));
  let saved = null;
  const sessions = {
    loadRoundSummaries: async () => [ancient, ...normal],
    saveRoundSummaries: async (_id, l) => { saved = l; },
  };
  await writeRoundSummary({
    sessionId: 's1', userMessage: 'u', trace: [], answer: 'a', summarize: async () => 'merged', sessions
  });
  const mergedAncient = saved.find((s) => s.ancient);
  assert.ok(mergedAncient, '必须产出古老摘要');
  const maxAt = Math.max(...normal.slice(0, normal.length - 10).map((s) => s.at));
  assert.ok(mergedAncient.coversUntil >= maxAt, `coversUntil 必须覆盖到最晚被合并的轮（实际 ${mergedAncient.coversUntil} < ${maxAt}）`);
  assert.ok(mergedAncient.coversUntil >= 1000, '原有覆盖范围不能退化');
});

// ───────────────────────── 2（P1）：手动 summary + 轮摘要不许双份注入

test('P1: 已被会话级摘要覆盖的轮摘要会被剔除（不会双重注入）', () => {
  const list = [
    { id: 'a', text: '第1轮', at: 1000 },
    { id: 'b', text: '第2轮', at: 2000 },
    { id: 'c', text: '第3轮', at: 3000 },
  ];
  // summaryAt=2500：第1、2轮已被摘要覆盖，第3轮是摘要之后新增的
  const kept = dropRoundSummariesCoveredBy(list, 2500);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'c', '只保留摘要覆盖范围之外的轮');
});

test('P1: 没有 summaryAt 时原样返回（不丢任何摘要）', () => {
  const list = [{ id: 'a', text: 'x', at: 1000 }];
  assert.deepEqual(dropRoundSummariesCoveredBy(list, 0), list);
  assert.deepEqual(dropRoundSummariesCoveredBy(list, null), list);
});

test('P1: 古老摘要用 coversUntil 判定；无 coversUntil 的老数据保守保留（只会重复不会丢）', () => {
  const withCover = { id: 'ancient', text: '早', ancient: true, at: 9000, coversUntil: 1000 };
  const legacy = { id: 'ancient2', text: '早2', ancient: true, at: 9000 };
  assert.equal(dropRoundSummariesCoveredBy([withCover], 5000).length, 0, 'coversUntil 已被覆盖 → 剔除');
  assert.equal(dropRoundSummariesCoveredBy([legacy], 5000).length, 1, '缺 coversUntil 时按 at(9000)>5000 保留');
});

// ───────────────────────── 3（P1）：索引行必须有上限

test('P1: 索引行超过上限时合并成计数行，且 token 不再随调用数线性增长', async () => {
  const { microcompact, INDEX_MAX_LINES } = await import('../desktop/src/main/context.mjs');
  const build = (n) => {
    const list = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
    for (let i = 0; i < n; i++) {
      list.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/f' + i + '.mjs' }) } }] });
      list.push({ role: 'tool', tool_call_id: 'c' + i, content: 'x'.repeat(4000) });
    }
    return list;
  };
  const idx = (l) => l.filter((x) => x.role === 'tool' && String(x.content).startsWith('[索引]'));
  const tok = (l) => idx(l).reduce((n, x) => n + String(x.content).length / 4, 0);

  const small = build(700);
  microcompact(small, { keepRecentTool: 5 });
  const big = build(1400);
  microcompact(big, { keepRecentTool: 5 });

  const smallIdx = idx(small).filter((x) => !String(x.content).includes('⋯'));
  assert.ok(smallIdx.length <= INDEX_MAX_LINES - 1, `明细索引行不得超过上限（实际 ${smallIdx.length}）`);
  assert.ok(idx(small).some((x) => /其余 \d+ 次/.test(String(x.content))), '必须有一条计数行');
  // 调用数翻倍，索引 token 只增加「保留最近明细」的量，不能翻倍
  assert.ok(tok(big) < tok(small) * 1.6, `700→1400 次调用索引 token 不该近似翻倍（${Math.round(tok(small))}→${Math.round(tok(big))}）`);
});

test('P1: 索引上限收口是幂等的，且不会产生空 tool 消息（无悬空 tool_call_id）', async () => {
  const { microcompact } = await import('../desktop/src/main/context.mjs');
  const list = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  for (let i = 0; i < 800; i++) {
    list.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.mjs' }) } }] });
    list.push({ role: 'tool', tool_call_id: 'c' + i, content: 'y'.repeat(2000) });
  }
  microcompact(list, { keepRecentTool: 5 });
  assert.equal(microcompact(list, { keepRecentTool: 5 }), false, '第二次应无改动');
  const empty = list.filter((m) => m.role === 'tool' && !String(m.content || '').trim());
  assert.equal(empty.length, 0, '不许留空 tool 消息');
  const counters = list.filter((m) => m.role === 'tool' && /其余 \d+ 次/.test(String(m.content)));
  assert.equal(counters.length, 1, '计数行全局只能有一条（否则数字会分叉）');
});

// ───────────────────────── 4（P2）：摘要截断保头保尾，不砍掉「下一步」

test('P2: 超长摘要截断后仍保留末尾的「当前正在做什么」', () => {
  const sections = [
    '## 用户本轮想要什么\n' + '用户原话：把 shell-resolver 的路径解析修了。'.repeat(5),
    '## 关键技术概念 / 决策\n' + '冗长的决策讨论。'.repeat(2000),
    '## 涉及的文件与改动\n' + '冗长的文件清单。'.repeat(2000),
    '## 报过的错与怎么修的\n' + '冗长的报错记录。'.repeat(2000),
    '## 待办 / 未完成项\n' + '冗长的待办。'.repeat(2000),
    '## 当前正在做什么\n下一步：重打包 0.20.0 并覆盖 Release',
  ];
  const text = sections.join('\n\n');
  assert.ok(estimateSummaryTokens(text) > SUMMARY_MAX_TOKENS, '前提：原文确实超上限');
  const out = truncateSummaryText(text);
  assert.ok(estimateSummaryTokens(out) <= SUMMARY_MAX_TOKENS, '截断后必须落回上限内');
  assert.match(out, /下一步：重打包 0\.20\.0 并覆盖 Release/, '末尾「下一步」绝不能被砍');
  assert.match(out, /用户原话：把 shell-resolver 的路径解析修了/, '首段用户原话也必须保留');
  assert.match(out, /本节过长已截断/, '中间段要有明确截断标记');
});

test('P2: 未超上限的摘要原样返回（不能改动模型输出）', () => {
  const short = '## 用户本轮想要什么\n随便写点\n## 当前正在做什么\n继续';
  assert.equal(truncateSummaryText(short), short);
});

test('P2: 无段结构的超长文本保头保尾', () => {
  const head = 'HEAD-MARK';
  const tail = 'TAIL-MARK';
  const body = 'z'.repeat(60000);
  const out = truncateSummaryText(head + body + tail);
  assert.ok(estimateSummaryTokens(out) <= SUMMARY_MAX_TOKENS);
  assert.match(out, /HEAD-MARK/);
  assert.match(out, /TAIL-MARK/);
});

// ───────────────────────── 5：pip-audit 必须带 cwd（否则 requirements 里的 `.` 解析失败）

test('S4: pip-audit 调用带 cwd（requirements 里写 `.` 的仓库才审得动）', () => {
  // 静默缺陷：cwd 缺失 → `Directory "." is not installable` → S4 记缺口 → 整份结论「无法验收」
  const src = readFileSync(new URL('../src/checks/deps.mjs', import.meta.url), 'utf8');
  const call = src.match(/runProcess\(tool\.cmd[\s\S]{0,300}?\)/);
  assert.ok(call, '必须能在 deps.mjs 里定位 pip-audit 的调用');
  assert.match(call[0], /cwd:\s*lockDir/, 'pip-audit 调用必须传 cwd（requirements 所在目录）');
});

test('S4: cwd 口径在回归前确实是缺失的（陈旧代码快照对照）', () => {
  // 这条是「防倒退」：如果将来有人把 cwd 又删掉，上面的断言会红；这里只是把
  // 旧实现的形状写清楚，避免「修了但没人知道为什么要修」。
  const legacyCall = "runProcess(tool.cmd, [...tool.prefix, '-r', abs, '-f', 'json'], { timeoutMs: 180000, maxOut: 64 * 1024 * 1024 })";
  assert.doesNotMatch(legacyCall, /cwd:/, '旧实现（无 cwd）就是故障形态，已在 2026-11-17 修掉');
});
