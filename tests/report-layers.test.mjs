import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/report.mjs';

// 报告分层：会卡交付的（card/high）→ 需要人工判断的（medium）→ 低优先建议（low，默认按规则折叠）。
// 折叠只影响默认展示，不改 findings；--show-low 必须能看全，且条数要写清。

const f = (over = {}) => ({
  checkId: 'Q4', severity: 'low', force: 'check', file: 'src/a.js', line: 1,
  snippet: 'const x = 1;', message: '可读性建议', rule: 'Q4.naming', ...over,
});

const legacyRes = () => ({
  projectDir: 'D:/demo/probe',
  tier: { requested: null, suggested: 'L2', effective: 'L2', signals: [], conservativeNote: null },
  gates: { planned: ['S5', 'Q2', 'Q4'], executed: ['S5', 'Q2', 'Q4'], gaps: [], gapItems: [] },
  findings: [
    f({ checkId: 'S5', severity: 'high', force: 'check', message: 'debug 开启', rule: 'S5.debug-on', line: 2 }),
    f({ checkId: 'Q2', severity: 'medium', force: 'card', message: '质量命令失败', rule: 'Q2.lint-failed', line: 1 }),
    f({ checkId: 'Q4', severity: 'medium', force: 'check', message: '函数过长', rule: 'Q4.fn-length', line: 9 }),
    ...Array.from({ length: 5 }, (_, i) => f({ severity: 'low', message: `变量 q${i} 看不出用途`, line: 10 + i })),
    ...Array.from({ length: 3 }, (_, i) => f({ severity: 'low', message: `函数 long${i} 过长`, rule: 'Q4.fn-length', line: 20 + i })),
    ...Array.from({ length: 2 }, (_, i) => f({ severity: 'low', message: `重复字符串 ${i}`, rule: 'Q4.duplicate-string', line: 30 + i })),
  ],
  conclusion: { verdict: '拦', reason: '1 条高危实锤' },
  warnings: [],
});

const marks = (text) => (text.match(/🔴 高危｜|🟡 中危｜|🔵 低危｜/g) || []).length;

test('老格式默认分层：card/high 在最前，medium 其次，low 折叠但条数写清', () => {
  const text = renderReport(legacyRes());
  const blocking = text.indexOf('## 会卡交付的（2 条：force=card 或 severity=high）');
  const manual = text.indexOf('## 需要人工判断的（1 条：medium）');
  const low = text.indexOf('## 风格与可读性建议（低优先，共 10 条，默认不展开）');
  assert.ok(blocking >= 0 && manual > blocking && low > manual, '三层顺序必须是 卡交付 → 人工判断 → 低优先');

  // 高危 check 与中危 card 都算「会卡交付」；中危 check 才进人工判断
  assert.ok(text.indexOf('debug 开启') < manual, 'severity=high 即使 force=check 也必须进会卡交付');
  assert.ok(text.indexOf('质量命令失败') < manual, 'force=card 即使 severity=medium 也必须进会卡交付');
  assert.ok(text.indexOf('函数过长') > manual && text.indexOf('函数过长') < low, '非卡中危进人工判断');

  assert.match(text, /风格与可读性建议 10 条（命名 5 \/ 函数过长 3 \/ 重复字符串 2），默认不展开/);
  assert.match(text, /加 `--show-low` 重新运行（共 10 条全部保留在 JSON findings 中，未删除）/);
  assert.equal(marks(text), 3, '默认只逐条展示 2 条会卡 + 1 条人工判断');
  assert.ok(!text.includes('变量 q0 看不出用途'), '低优先条目默认不逐条展开');
});

test('--show-low 展开全部低优先条目，且条数一条不少', () => {
  const text = renderReport(legacyRes(), { showLow: true });
  assert.match(text, /## 风格与可读性建议（低优先，共 10 条，已展开）/);
  assert.equal(marks(text), 13, '2 条会卡 + 1 条人工判断 + 10 条低优先全部展示');
  for (let i = 0; i < 5; i += 1) assert.ok(text.includes(`变量 q${i} 看不出用途`));
  assert.ok(!text.includes('默认不展开'), '展开后不应再提示默认折叠');
});

test('维度格式同样分层：维度表保持在前，Findings 内按三层排', () => {
  const res = {
    projectDir: 'D:/demo/probe',
    tier: {
      requested: null, suggested: 'L2', effective: 'L2', signals: [], conservativeNote: null,
      dimensions: {
        安全性: { level: 'L2', verdict: '修完再过' },
        代码可读性: { level: 'L2', verdict: '修完再过' },
      },
    },
    gates: { planned: ['S5', 'Q4'], executed: ['S5', 'Q4'], gaps: [], gapItems: [] },
    evidence: {
      安全性: { level: 'static-only', reason: '仅静态（缺 URL，无实测证据）' },
      代码可读性: { level: 'full', reason: '证据充分（源码可查）' },
    },
    findings: [
      f({ checkId: 'S5', severity: 'high', force: 'card', message: 'debug 开启', rule: 'S5.debug-on' }),
      f({ checkId: 'Q4', severity: 'medium', force: 'check', message: '函数过长', rule: 'Q4.fn-length', line: 9 }),
      ...Array.from({ length: 4 }, (_, i) => f({ severity: 'low', message: `命名建议 ${i}`, line: 20 + i })),
      ...Array.from({ length: 2 }, (_, i) => f({ severity: 'low', message: `重复字符串 ${i}`, rule: 'Q4.duplicate-string', line: 30 + i })),
    ],
    conclusion: { verdict: '拦', reason: '1 条高危实锤' },
    warnings: [],
  };
  const text = renderReport(res);
  const table = text.indexOf('维度结论表：');
  const findings = text.indexOf('## Findings');
  assert.ok(table >= 0 && table < findings, '维度表必须保持在 Findings 之前');
  assert.match(text, /^\| 安全性 \| L2 \| 修完再过 \| static-only \| S1、S2、S3、S5、S6、S7、S8 \|$/m);
  assert.match(text, /^\| 代码可读性 \| L2 \| 修完再过 \| full \| Q4 \|$/m);
  assert.ok(text.indexOf('**会卡交付的（1 条：force=card 或 severity=high）**') < text.indexOf('**需要人工判断的（1 条：medium）**'));
  assert.match(text, /风格与可读性建议 6 条（命名 4 \/ 重复字符串 2），默认不展开/);
  assert.ok(text.indexOf('**风格与可读性建议') < text.indexOf('## Verified'), '低优先折叠段仍在 Findings 内');

  const expanded = renderReport(res, { showLow: true });
  assert.match(expanded, /\*\*风格与可读性建议（低优先，共 6 条，已展开）\*\*/);
  assert.ok(expanded.includes('命名建议 0'));
  assert.ok(expanded.includes('重复字符串 0'));
});
