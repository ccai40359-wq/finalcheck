// over 引用解析回归：JSON 优先，其次代码块 JSON，最后从人话文本里逐行提取列表。
// 现场 bug：recon 返回「预算/清单」式正文，fanout 的 over 引用整条工作流直接中止。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../desktop/src/main/workflow.mjs';

const reportText = [
  '## Conclusion',
  '最终报告：已汇总上游结果，未覆盖范围见 Not covered。',
  '## Findings',
  '- 证据见上游步骤，未复核结论均按疑似标注。',
  '## Verified',
  '- 无独立复核者覆盖的 claim 不写「已确认」。',
  '## Not covered',
  'None',
  '## Skipped',
  'None',
  '',
].join('\n');

const childRows = (out) => (out.results || []).filter((r) => /^fa#\d+$/.test(String(r.id)));

/** 跑一个 recon → fanout 的最小脚本，recon 返回给定正文。 */
async function runOver(reconContent, overRef = 'recon') {
  const prompts = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 'recon', role: '审查员', prompt: '列出全部入口' },
      { op: 'fanout', id: 'fa', as: 'entry', over: overRef, limit: 20, step: { prompt: '检查 ${entry}' } },
    ],
    callStep: async (ctx) => {
      if (ctx.id === 'recon') return { content: reconContent, toolCount: 1 };
      if (ctx.id === '__report__') return { content: reportText, toolCount: 0 };
      prompts.push(ctx.prompt);
      return { content: 'ok', toolCount: 1 };
    },
  });
  return { out, prompts };
}

test('over/text: JSON 字符串数组 → 按项扇出，不标 overParsedFrom、不写文本解析 warning', async () => {
  const { out, prompts } = await runOver(JSON.stringify(['a.php', 'b.js', 'c.ts']));
  assert.equal(out.error, undefined);
  const rows = childRows(out);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.id), ['fa#0', 'fa#1', 'fa#2']);
  assert.ok(rows.every((r) => r.overParsedFrom === undefined), 'JSON 列表不该标 text');
  assert.ok(!out.warnings.some((w) => /解析出 \d+ 项/.test(w)));
  assert.ok(prompts.some((p) => /检查 a\.php/.test(p)));
});

test('over/text: {items:[...]} 包裹对象 → 当成 JSON 列表', async () => {
  const { out } = await runOver(JSON.stringify({ total: 2, items: ['x.py', 'y.rb'], note: '人话备注' }));
  assert.equal(out.error, undefined);
  const rows = childRows(out);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.overParsedFrom === undefined));
});

test('over/text: 代码块里的 JSON → 解析成功且不算文本提取', async () => {
  const content = ['入口清单如下：', '```json', JSON.stringify(['login.php', 'admin.js']), '```', '以上。'].join('\n');
  const { out } = await runOver(content);
  assert.equal(out.error, undefined);
  const rows = childRows(out);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.overParsedFrom === undefined));
});

test('over/text: 项目符号列表 → 提取、去重、trim、丢弃 <2 字符，并标 overParsedFrom=text', async () => {
  const content = [
    '## 入口清单',
    '- /api/login.php',
    '* src/admin.js   ',
    '- /api/login.php',
    '- x',
    '+ `src/utils.ts`：工具函数',
  ].join('\n');
  const { out } = await runOver(content);
  assert.equal(out.error, undefined);
  const rows = childRows(out);
  assert.deepEqual(rows.map((r) => r.id), ['fa#0', 'fa#1', 'fa#2']);
  assert.ok(rows.every((r) => r.overParsedFrom === 'text'));
  assert.ok(out.warnings.some((w) => /从 recon 的文本里解析出 3 项/.test(w)), out.warnings.join('\n'));
});

test('over/text: 编号列表 → 按编号行提取；编号显示意图多于实际时 warning 点名数量对不上', async () => {
  const content = ['1. /api/one.php', '2. /api/two.php', '3) a'].join('\n');
  const { out } = await runOver(content);
  assert.equal(out.error, undefined);
  const rows = childRows(out);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.overParsedFrom === 'text'));
  assert.ok(out.warnings.some((w) => /从 recon 的文本里解析出 2 项/.test(w)), '编号 3 的行只有 1 个字符，会被丢弃');
  assert.ok(out.warnings.some((w) => /文本里写到 3 项/.test(w)), out.warnings.join('\n'));
});

test('over/text: 表格首列 → 跳过表头与分隔行，只取首列', async () => {
  const content = [
    '| 文件 | 说明 |',
    '| --- | --- |',
    '| /api/login.php | 登录 |',
    '| `src/admin.js` | 后台 |',
  ].join('\n');
  const { out } = await runOver(content);
  assert.equal(out.error, undefined);
  const rows = childRows(out);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.overParsedFrom === 'text'));
  assert.ok(!rows.some((r) => /文件/.test(r.name || '')), '表头不能变成扇出项');
});

test('over/text: 独立成行的 URL/路径 → 提取（含无项目符号的裸路径）', async () => {
  const content = ['扫描到这些目标：', 'https://example.com/a.php', '/api/v1/users.json', 'src/index.ts', '', '其余为说明文字。'].join('\n');
  const { out } = await runOver(content);
  assert.equal(out.error, undefined);
  const rows = childRows(out);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.overParsedFrom === 'text'));
});

test('over/text: 纯散文无列表 → 报可执行错误（不再只说「未解析出 JSON 字符串数组」）', async () => {
  const content = '我检查了一遍登录模块，没有发现明显问题，代码结构清晰，建议保持现状。';
  const { out } = await runOver(content);
  // 错误可能直接中止（out.error），也可能被运行期降级成洞挂在 fanout 结果行上；两处都要带同一句可执行文案
  const hole = (out.results || []).find((r) => String(r.id) === 'fa');
  const surfaced = [out.error, hole?.error, ...(out.warnings || [])].filter(Boolean).join('\n');
  assert.match(surfaced, /over 引用 recon 没有解析出列表/);
  assert.match(surfaced, /让 recon 输出 JSON 字符串数组（或每行一项）/);
  assert.match(surfaced, /在 fanout 里直接写 over:\[\.\.\.\]/);
  assert.equal(childRows(out).length, 0, '解析不出列表时不应扇出任何子节点');
});

// 输出契约（2026-11-11 现场事故）：recon 交人话 → fanout 解析失败 → 整条停机。
// 现在：prompt 里先写死契约；没做到给一次纠正重试；仍然不行才走文本提取/降级。
test('over/契约：被 fanout 消费的 step，prompt 必须带「只输出 JSON 字符串数组」硬要求', async () => {
  let reconPrompt = '';
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 'recon', role: '审查员', prompt: '列出全部入口' },
      { op: 'fanout', id: 'fa', as: 'entry', over: 'recon', limit: 20, step: { prompt: '检查 ${entry}' } },
    ],
    callStep: async (ctx) => {
      if (ctx.id === 'recon') { reconPrompt = ctx.prompt; return { content: '["a.php"]', toolCount: 1 }; }
      if (ctx.id === '__report__') return { content: reportText, toolCount: 0 };
      return { content: 'ok', toolCount: 1 };
    },
  });
  assert.equal(out.error, undefined);
  assert.ok(reconPrompt, 'recon 的 prompt 必须能拿到');
  assert.match(reconPrompt, /输出契约·硬要求/);
  assert.match(reconPrompt, /JSON 字符串数组/);
});

test('over/契约：首次交人话 → 自动纠正重试一次，拿到数组后照常扇出', async () => {
  let reconCalls = 0;
  const retryPrompts = [];
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 'recon', role: '审查员', prompt: '列出全部入口' },
      { op: 'fanout', id: 'fa', as: 'entry', over: 'recon', limit: 20, step: { prompt: '检查 ${entry}' } },
    ],
    callStep: async (ctx) => {
      if (ctx.id === 'recon') {
        reconCalls += 1;
        if (reconCalls === 1) return { content: '我看了下，大概有三个入口：登录、上传、导出。', toolCount: 2 };
        retryPrompts.push(ctx.prompt);
        return { content: '["login.php","upload.php","export.php"]', toolCount: 1 };
      }
      if (ctx.id === '__report__') return { content: reportText, toolCount: 0 };
      return { content: 'ok', toolCount: 1 };
    },
  });
  assert.equal(out.error, undefined);
  assert.equal(reconCalls, 2, '必须且只能重试一次');
  assert.match(retryPrompts[0], /上一次输出不合格/);
  assert.equal(childRows(out).length, 3, '重试拿到数组后应按 3 项扇出');
  assert.ok(out.warnings.some((w) => /首次输出不是 JSON 数组/.test(w)));
});

test('over/契约：两次都交人话 → 只重试一次，然后走文本提取（不中止）', async () => {
  let reconCalls = 0;
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 'recon', role: '审查员', prompt: '列出全部入口' },
      { op: 'fanout', id: 'fa', as: 'entry', over: 'recon', limit: 20, step: { prompt: '检查 ${entry}' } },
    ],
    callStep: async (ctx) => {
      if (ctx.id === 'recon') {
        reconCalls += 1;
        return { content: '- login.php\n- upload.php', toolCount: 1 };
      }
      if (ctx.id === '__report__') return { content: reportText, toolCount: 0 };
      return { content: 'ok', toolCount: 1 };
    },
  });
  assert.equal(reconCalls, 2, '失败也只纠正一次，不许无限重试');
  assert.equal(out.error, undefined, '两次都不合格不能中止整条工作流');
  assert.equal(childRows(out).length, 2, '文本提取兜底：两行 → 两项');
});
