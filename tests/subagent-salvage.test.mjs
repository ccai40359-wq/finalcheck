// 子代理中断/空回复兜底：任何终止都必须留可审阅的交付文字，且洞要进 report prompt 与 lint。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../desktop/src/main/workflow.mjs';
import { lintReport } from '../desktop/src/main/swarm.mjs';
import { SALVAGE_ABORTED_HEADER, SALVAGE_EMPTY_HEADER } from '../desktop/src/main/subagent-salvage.mjs';

const reportWith = (notCovered = 'None') => [
  '## Conclusion',
  '本轮汇总已完成，结论与未覆盖范围见下。',
  '## Findings',
  '- 见上游 claim 与证据。',
  '## Verified',
  '- 有复核者覆盖的结论已单独标注。',
  '## Not covered',
  notCovered,
  '## Skipped',
  'None',
  '',
].join('\n');

const abortedTranscript = [
  { role: 'tool', name: 'read_file', content: '{"path":"a.js","ok":true}\n第二行不应进入摘要' },
  { role: 'tool', name: 'run_command', content: '{"ok":true,"stdout":"pass"}' },
  { role: 'assistant', content: '', reasoning: '我已经读了两处，接下来还要看配置' },
];

test('salvage: 中断（cancelled）→ 正文以【未完成·已中断】开头，保留工具数/名称/推理', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'step', id: 'a', name: '取证', role: '审查员', prompt: '读取 a.js 和配置' }],
    callStep: async () => ({ content: '', cancelled: true, transcript: abortedTranscript }),
  });
  const row = out.results.find((r) => r.id === 'a');
  assert.equal(row.ok, false, '中断必须失败，salvage 不能把它翻绿');
  assert.ok(row.content.startsWith(SALVAGE_ABORTED_HEADER), `正文应以 ${SALVAGE_ABORTED_HEADER} 开头`);
  assert.match(row.content, /已调用工具：2 次/);
  assert.match(row.content, /read_file → .*"path":"a.js"/);
  assert.match(row.content, /run_command → .*"stdout":"pass"/);
  assert.match(row.content, /最后一段模型推理.*我已经读了两处/);
  assert.equal(row.error, '子代理被中断');
  assert.equal(row.errorCode, 'INTERRUPTED');
  assert.equal(row.salvaged, true);
  assert.equal(row.salvageReason, 'aborted');
  assert.equal(row.hole, true, '失败节点必须打洞标记');
});

test('salvage: 空回复（无 cancelled）→ 正文以【未完成·无最终结论】开头，错误码 EMPTY_CONTENT', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'step', id: 'e', role: '记录员', prompt: '把结论抄写成一句话' }],
    callStep: async () => ({ content: '' }),
  });
  const row = out.results.find((r) => r.id === 'e');
  assert.equal(row.ok, false);
  assert.ok(row.content.startsWith(SALVAGE_EMPTY_HEADER), `正文应以 ${SALVAGE_EMPTY_HEADER} 开头`);
  assert.match(row.content, /已调用工具：0 次/);
  assert.match(row.content, /交付状态：未完成/);
  assert.match(row.error, /子代理没有返回内容/);
  assert.equal(row.errorCode, 'EMPTY_CONTENT');
  assert.equal(row.salvaged, true);
  assert.equal(row.salvageReason, 'empty');
  assert.equal(row.hole, true);
});

test('salvage: 正常回复不触发 salvage，也不带 salvaged/hole 标记', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'step', id: 'ok', role: '审查员', prompt: '审查配置' }],
    callStep: async () => ({ content: '配置审查完成：无高危项。', toolCount: 1 }),
  });
  const row = out.results.find((r) => r.id === 'ok');
  assert.equal(row.ok, true);
  assert.equal(row.salvaged, undefined);
  assert.equal(row.hole, undefined);
  assert.equal(row.content, '配置审查完成：无高危项。');
});

test('report: prompt 注入未完成/洞清单并点名失败节点；Not covered 点名后报告可交付', async () => {
  let reportPrompt = '';
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 'f', name: '配置审查', role: '审查员', prompt: '读取配置文件并审查' },
      { op: 'report', id: 'rep', from: 'f', ask: '汇总本轮结果' },
    ],
    callStep: async (ctx) => {
      if (ctx.id === 'f') return { content: '', cancelled: true, transcript: abortedTranscript };
      reportPrompt = ctx.prompt;
      return { content: reportWith('- [f] 配置审查：已中断（用户停止），配置项未覆盖。'), toolCount: 0 };
    },
  });
  assert.match(reportPrompt, /未完成\/洞清单/);
  assert.match(reportPrompt, /\[f\]/);
  assert.match(reportPrompt, /配置审查/);
  assert.match(reportPrompt, /进度摘要/, '洞清单要带上 salvage 进度摘要');
  const rep = out.results.find((r) => r.id === 'rep');
  assert.equal(rep.ok, true);
  assert.deepEqual(rep.holes, ['f']);
  assert.equal(rep.reportLintOk, true);
  assert.equal(rep.delivered, true);
  assert.ok(out.delivered.includes('rep'));
});

test('report: Not covered 漏点失败节点 → lint 失败、delivered=false（不放宽闸门）', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [
      { op: 'step', id: 'f', name: '配置审查', role: '审查员', prompt: '读取配置文件并审查' },
      { op: 'report', id: 'rep', from: 'f', ask: '汇总本轮结果' },
    ],
    callStep: async (ctx) => {
      if (ctx.id === 'f') return { content: '', cancelled: true, transcript: abortedTranscript };
      return { content: reportWith('None'), toolCount: 0 };
    },
  });
  const rep = out.results.find((r) => r.id === 'rep');
  assert.equal(rep.ok, true, '报告正文本身仍是成功产出，lint 问题不能吞掉正文');
  assert.equal(rep.reportLintOk, false);
  assert.equal(rep.delivered, false);
  assert.ok(!out.delivered.includes('rep'));
  assert.ok(rep.reportWarnings.some((w) => /未点名失败节点/.test(w) && /f/.test(w)), rep.reportWarnings.join(' | '));
});

test('lintReport: Not covered 段落必须存在，且每个失败节点都要点名', () => {
  const noSection = reportWith('None').replace('## Not covered\nNone\n', '');
  const missingSection = lintReport(noSection, { holes: [{ id: 'f', name: '配置审查' }] });
  assert.ok(missingSection.some((w) => w.includes('缺少段落 ## Not covered')));
  assert.ok(missingSection.some((w) => w.includes('未点名失败节点')));

  const named = lintReport(reportWith('- [f] 配置审查：已中断'), { holes: [{ id: 'f', name: '配置审查' }] });
  assert.deepEqual(named, [], '点名后不应再有 lint warning');
});
