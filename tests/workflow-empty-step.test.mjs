// 工作流子代理空转/截断回归：用本地 fake provider（不碰真实付费 key）验证 runSubagentStep 与 judgeSubagentOutcome。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  SUBAGENT_CONTEXT_MAX_CHARS,
  SUBAGENT_MAX_OUTPUT_TOKENS,
  SUBAGENT_MAX_TOOLS,
  SUBAGENT_MAX_TURNS,
  SUBAGENT_STEP_BUDGET_MS,
  SUBAGENT_TOOL_RETRY_REMINDER,
  judgeSubagentOutcome,
  needsEvidence,
  runSubagentStep,
  runWorkflow,
  trimToolResults
} from '../desktop/src/main/workflow.mjs';
import { SUBAGENT_TOOL_DENIED, SUBAGENT_TOOL_NAMES, buildSwarmPrompt, stepRequiresToolEvidence } from '../desktop/src/main/swarm.mjs';

const TOOLS = [{
  type: 'function',
  function: { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
}];

async function startFakeProvider(handler) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* 忽略坏 JSON */ }
      requests.push(body);
      const out = handler(body, requests.length) || {};
      res.statusCode = out.status || 200;
      res.setHeader('content-type', 'application/json');
      if (typeof out.raw === 'string') res.end(out.raw);
      else res.end(JSON.stringify(out.json || { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}/v1`;
  return {
    baseUrl,
    requests,
    close: () => new Promise((r) => srv.close(r))
  };
}

const plain = (content, { finishReason } = {}) => ({
  choices: [{ message: { role: 'assistant', content }, ...(finishReason ? { finish_reason: finishReason } : {}) }]
});
const toolCall = (id = 'c1', args = '{"path":"README.md"}') => ({
  choices: [{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: args } }]
    },
    finish_reason: 'tool_calls'
  }]
});

test('空转硬闸：find 首轮纯文本 → 系统提醒重试 → 仍纯文本 → failed（含「未产生任何工具调用」）', async (t) => {
  const fake = await startFakeProvider(() => ({ json: plain('我先去跑一下，稍后给你结论。', { finishReason: 'stop' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    prompt: '逐条取证 desktop/src/main/index.mjs',
    kind: 'find',
    tools: TOOLS,
    executeTool: async () => ({ ok: true })
  });
  assert.match(out.error, /未产生任何工具调用/);
  assert.equal(out.toolCount, 0);
  assert.equal(fake.requests.length, 2, '应自动重试一次（共 2 次请求）');
  assert.equal(fake.requests[0].tool_choice, 'required', 'find 首轮必须强制 tool_choice=required');
  assert.equal(fake.requests[0].max_tokens, SUBAGENT_MAX_OUTPUT_TOKENS);
  const reminder = fake.requests[1].messages.find((m) => m.role === 'system' && m.content === SUBAGENT_TOOL_RETRY_REMINDER);
  assert.ok(reminder, '重试前应追加 system 提醒');
});

test('正常路径：首轮 tool_calls → 工具执行 → 最终正文 → success，finish_reason 缺失不算截断', async (t) => {
  let executed = 0;
  const fake = await startFakeProvider((_body, n) => (n === 1 ? { json: toolCall() } : { json: plain('{"findings":[{"id":"f1","claim":"已取证","evidence":"README.md:1","severity":"low","file":"README.md","line":1,"reproduced":true}]}', { finishReason: 'stop' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    prompt: '逐条取证 README.md',
    kind: 'find',
    tools: TOOLS,
    executeTool: async () => { executed += 1; return { content: '# repo' }; }
  });
  assert.equal(out.error, undefined);
  assert.equal(out.toolCount, 1);
  assert.equal(executed, 1);
  assert.equal(out.truncated, false);
  assert.match(out.content, /findings/);
  assert.equal(fake.requests.length, 2);
  // 工具结果要回灌给模型
  assert.ok(fake.requests[1].messages.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'));
});

test('report 步允许 0 工具调用，100 字正文可成功', async (t) => {
  const text = '本报告汇总本轮取证结果：' + '已核实结论与未覆盖范围。'.repeat(8);
  assert.ok(text.length >= 80);
  const fake = await startFakeProvider(() => ({ json: plain(text, { finishReason: 'stop' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    prompt: '汇总五段报告',
    kind: 'report',
    tools: TOOLS,
    executeTool: async () => ({ ok: true })
  });
  assert.equal(out.error, undefined);
  assert.equal(out.toolCount, 0);
  assert.equal(out.content.length >= 80, true);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].tool_choice, undefined, 'report 不需要强制工具');
});

test('report 步正文不足 80 字 → failed「汇总为空」', async (t) => {
  const fake = await startFakeProvider(() => ({ json: plain('汇总完成。', { finishReason: 'stop' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    prompt: '汇总五段报告',
    kind: 'report',
    tools: TOOLS,
    executeTool: async () => ({ ok: true })
  });
  assert.match(out.error, /汇总为空/);
});

test('网关不支持 tool_choice：400 → 去掉字段重试 → 后续 tool_calls 正常判定', async (t) => {
  const fake = await startFakeProvider((body, n) => {
    if (body.tool_choice) return { status: 400, json: { error: { message: 'tool_choice is not supported' } } };
    if (n === 2) return { json: toolCall('c2', '{"path":"README.md"}') };
    return { json: plain('{"findings":[{"id":"f1","claim":"已取证","evidence":"README.md:1","severity":"low","file":"README.md","line":1,"reproduced":true}]}', { finishReason: 'stop' }) };
  });
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    prompt: '逐条取证 README.md',
    kind: 'find',
    tools: TOOLS,
    executeTool: async () => ({ content: '# repo' })
  });
  assert.equal(out.error, undefined);
  assert.equal(out.toolCount, 1);
  assert.equal(fake.requests.length, 3, '400 后去掉 tool_choice 重试一次，再走工具轮');
  assert.ok(!('tool_choice' in fake.requests[1]), '降级请求不能带 tool_choice');
  assert.ok(out.warnings.some((w) => /tool_choice/.test(w)), '应记录 tool_choice 降级 warning');
});

test('find 输出被 finish_reason=length 截断且 JSON 解析失败 → failed「输出被截断，取证不完整」', async (t) => {
  const fake = await startFakeProvider((_body, n) => {
    if (n === 1) return { json: toolCall('c3', '{"path":"README.md"}') };
    return { json: plain('{"findings":[{"id":"f1","claim":"已取证', { finishReason: 'length' }) };
  });
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    prompt: '逐条取证 README.md',
    kind: 'find',
    tools: TOOLS,
    executeTool: async () => ({ content: '# repo' })
  });
  assert.match(out.error, /输出被截断，取证不完整/);
  assert.equal(out.truncated, true);
  assert.ok(out.warnings.some((w) => /被截断/.test(w)));
});

test('report 被截断但有完整正文：仍成功，但标 truncated 并给 warning', async (t) => {
  const text = '## Conclusion\n' + '本轮结论已核实，未覆盖范围见下。'.repeat(8);
  const fake = await startFakeProvider(() => ({ json: plain(text, { finishReason: 'length' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    prompt: '汇总五段报告',
    kind: 'report',
    tools: TOOLS,
    executeTool: async () => ({ ok: true })
  });
  assert.equal(out.error, undefined);
  assert.equal(out.truncated, true);
  assert.ok(out.warnings.some((w) => /被截断/.test(w)));
});

test('取证判定：find/verify 与 Windows 反斜杠盘符路径都要求工具调用，report 例外', () => {
  assert.equal(stepRequiresToolEvidence('find', '随便写写'), true);
  assert.equal(stepRequiresToolEvidence('verify', '复现一下'), true);
  assert.equal(stepRequiresToolEvidence(null, '读取 D:\\repo\\a.mjs'), true, 'Windows 反斜杠路径也要识别');
  assert.equal(stepRequiresToolEvidence(null, '运行 read_file 看看'), true);
  assert.equal(stepRequiresToolEvidence('report', '汇总 read_file 的结果'), false);
  assert.equal(stepRequiresToolEvidence(null, '总结一下'), false);
});

// —— 步骤语义判定（needsEvidence）：名称/角色/关键词驱动，不再只认 kind 与工具名/盘符 ——

test('needsEvidence：name=代码审查 0 工具 → failed（首轮强制 tool_choice + 重试一次仍失败）', async (t) => {
  const fake = await startFakeProvider(() => ({ json: plain('代码看起来没问题，没有发现风险。', { finishReason: 'stop' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    name: '代码审查',
    prompt: '看看 index.mjs 有没有问题',
    tools: TOOLS,
    executeTool: async () => ({ ok: true })
  });
  assert.match(out.error, /未产生任何工具调用：该步没有取证（疑似空转）/, '失败文案必须统一');
  assert.equal(out.toolCount, 0);
  assert.equal(fake.requests[0].tool_choice, 'required', '名称命中审查语义 → 首轮强制工具');
  assert.equal(fake.requests.length, 2, '空转后应追加提醒重试一次');
});

test('needsEvidence：role=安全审计员 0 工具 → failed', async (t) => {
  const fake = await startFakeProvider(() => ({ json: plain('审计完成，未发现问题。', { finishReason: 'stop' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    role: '安全审计员',
    prompt: '看一遍项目安全性',
    tools: TOOLS,
    executeTool: async () => ({ ok: true })
  });
  assert.equal(out.error, '未产生任何工具调用：该步没有取证（疑似空转）');
  assert.equal(out.toolCount, 0);
  assert.equal(fake.requests[0].tool_choice, 'required');
  assert.equal(fake.requests.length, 2);
});

test('needsEvidence：name=依赖扫描 0 工具 → failed', async (t) => {
  const fake = await startFakeProvider(() => ({ json: plain('依赖清单已整理，没有高危项。', { finishReason: 'stop' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    name: '依赖扫描',
    prompt: '列出 package.json 的依赖风险',
    tools: TOOLS,
    executeTool: async () => ({ ok: true })
  });
  assert.equal(out.error, '未产生任何工具调用：该步没有取证（疑似空转）');
  assert.equal(out.toolCount, 0);
  assert.equal(fake.requests[0].tool_choice, 'required');
  assert.equal(fake.requests.length, 2);
});

test('needsEvidence：kind=report 且 name=汇总报告 0 工具 + 正文够长 → success（豁免）', async (t) => {
  const text = '## Conclusion\n' + '本轮结论汇总如下，已覆盖取证范围。'.repeat(6);
  assert.ok(text.length >= 80);
  const fake = await startFakeProvider(() => ({ json: plain(text, { finishReason: 'stop' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    kind: 'report',
    name: '汇总报告',
    prompt: '把上游结果汇总成报告',
    tools: TOOLS,
    executeTool: async () => ({ ok: true })
  });
  assert.equal(out.error, undefined);
  assert.equal(out.toolCount, 0);
  assert.equal(fake.requests.length, 1, 'report 豁免：不重试');
  assert.equal(fake.requests[0].tool_choice, undefined, '汇总步骤不强制工具');
});

test('needsEvidence：kind=arbitrate 0 工具 → success（允许只读 claims 与证据文本）', async (t) => {
  const fake = await startFakeProvider(() => ({ json: plain('{"decisions":[]}', { finishReason: 'stop' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    kind: 'arbitrate',
    prompt: '按证据原文裁决冲突清单',
    tools: TOOLS,
    executeTool: async () => ({ ok: true })
  });
  assert.equal(out.error, undefined);
  assert.equal(out.toolCount, 0);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].tool_choice, undefined, '仲裁只读上游，不应强制工具');
});

test('needsEvidence：name=翻译成英文 0 工具 → success（不该误伤纯翻译）', async (t) => {
  const fake = await startFakeProvider(() => ({ json: plain('Translated text.', { finishReason: 'stop' }) }));
  t.after(() => fake.close());
  const out = await runSubagentStep({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    systemPrompt: '你是子代理',
    name: '翻译成英文',
    prompt: '把这段中文翻译成英文',
    tools: TOOLS,
    executeTool: async () => ({ ok: true })
  });
  assert.equal(out.error, undefined);
  assert.equal(out.toolCount, 0);
  assert.equal(fake.requests.length, 1, '纯翻译不重试');
  assert.equal(fake.requests[0].tool_choice, undefined, '纯翻译不强制工具');
  // 非回归：buildSwarmPrompt 生成的 find prompt 里带出的盘符路径仍能命中
  const builtFind = buildSwarmPrompt({
    goal: '检查仓库',
    step: { id: 'f1', kind: 'find' },
    upstream: [{ id: 'r1', targets: [{ id: 't1', path: 'D:\\repo\\a.mjs', risk: 'high', reason: '值得查' }] }]
  });
  assert.ok(/[A-Za-z]:[\\/]/.test(builtFind), '生成的 find prompt 应保留上游目标里的盘符路径');
  assert.equal(needsEvidence({ kind: null, prompt: builtFind }), true, 'prompt 里的盘符路径仍能命中');
  assert.equal(needsEvidence({ kind: 'find', name: '取证', prompt: '随便写写' }), true);
});

test('judgeSubagentOutcome：未知 toolCount 不做硬闸，明确 0 次才判空转', () => {
  assert.equal(judgeSubagentOutcome({ kind: 'find', content: 'x', toolCountKnown: false, requiresTools: true }).ok, true);
  const judged = judgeSubagentOutcome({ kind: 'find', content: 'x', toolCount: 0, toolCountKnown: true, requiresTools: true });
  assert.equal(judged.ok, false);
  assert.match(judged.error, /未产生任何工具调用/);
});

test('子代理工具白名单：放开改代码/质量/报告工具，禁止嵌套工作流与写记忆', () => {
  for (const name of ['quality_gate', 'review_diff', 'get_report', 'edit_file', 'write_file', 'present_artifact', 'run_command', 'read_file']) {
    assert.ok(SUBAGENT_TOOL_NAMES.includes(name), `白名单应包含 ${name}`);
  }
  for (const name of ['run_workflow', 'remember_project']) {
    assert.ok(!SUBAGENT_TOOL_NAMES.includes(name), `白名单不得包含 ${name}`);
  }
  assert.deepEqual(SUBAGENT_TOOL_DENIED, ['run_workflow', 'remember_project']);
});

test('子代理预算：轮次/工具数/单步时间默认不限（长时间自主工作）；输出 token 保留防跑飞', () => {
  assert.equal(SUBAGENT_MAX_TURNS, Number.POSITIVE_INFINITY);
  assert.equal(SUBAGENT_MAX_TOOLS, Number.POSITIVE_INFINITY);
  assert.equal(SUBAGENT_STEP_BUDGET_MS, Number.POSITIVE_INFINITY);
  assert.equal(SUBAGENT_MAX_OUTPUT_TOKENS, 8000); // 单次回复的生成上限，不是工作时长限制
  assert.equal(SUBAGENT_CONTEXT_MAX_CHARS, 120000); // 上下文字符护栏（内存保护，不是工作限制）
});

test('trimToolResults：未超限不改；超限只裁最老工具结果；system/user/assistant 不动', () => {  const msgs = [
    { role: 'system', content: 'S'.repeat(1000) },
    { role: 'user', content: 'U'.repeat(1000) },
    { role: 'tool', tool_call_id: 'old', content: 'OLD'.repeat(1000) },
    { role: 'assistant', content: 'ASSIST'.repeat(400) },
    { role: 'tool', tool_call_id: 'new', content: 'NEW'.repeat(1000) }
  ];
  // 未超限：原样返回（同一引用）
  const untouched = trimToolResults(msgs, { maxChars: 20000 });
  assert.equal(untouched, msgs, '未超限不应复制或改动');
  // 超限：只裁最老的那条，裁到预算内即停
  const out = trimToolResults(msgs, { maxChars: 9000 });
  assert.notEqual(out, msgs);
  assert.match(out[2].content, /^OLDOLDOLD/);
  assert.match(out[2].content, /…\[已截断 \d+ 字\]…/);
  assert.equal(out[4].content, msgs[4].content, '较新的工具结果不应被裁');
  assert.equal(out[0].content, msgs[0].content, 'system 正文不动');
  assert.equal(out[1].content, msgs[1].content, 'user 正文不动');
  assert.equal(out[3].content, msgs[3].content, 'assistant 正文不动');
  assert.ok(JSON.stringify(out).length <= 9000);
});

test('runWorkflow 兜底：find 步骤 callStep 明确返回 0 次工具调用 → 结果与快照都 failed', async () => {
  const snaps = [];
  const out = await runWorkflow({
    goal: '检查空转',
    steps: [{ id: 'f1', kind: 'find', prompt: '逐条取证' }],
    callStep: async () => ({ content: '我先去跑一下，稍后给你结论。', toolCount: 0 }),
    onUpdate: (s) => snaps.push(s)
  });
  assert.equal(out.ok, false);
  const row = out.results.find((r) => r.id === 'f1');
  assert.equal(row.ok, false);
  assert.match(row.error, /未产生任何工具调用/);
  const last = snaps.at(-1);
  const step = last.steps.find((s) => s.id === 'f1');
  assert.equal(step.status, 'failed', '快照里必须是 failed（UI 不显示 ✓）');
  assert.match(step.error, /未产生任何工具调用/);
});
