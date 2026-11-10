// 工作流失败节点的结构化错误码回归：
// - runWorkflow（script 模式）失败路径产出 errorCode（结果行 + 快照 step + summary）
// - deriveNodeErrorCode / errorCodeLabel / extractHttpErrorCode 纯函数
// - humanizeToolError 不把 HTTP 状态码从错误文案里抹掉（时间线失败行靠它保码）
// 全部用 fake callStep / fake runGate，不碰真实模型与网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../desktop/src/main/workflow.mjs';
import { deriveNodeErrorCode, errorCodeLabel, extractHttpErrorCode } from '../desktop/src/main/swarm.mjs';
import { humanizeToolError } from '../desktop/src/renderer/lib/humanize.js';

// ---------- errorCodeLabel：映射逐个断言 ----------

test('errorCodeLabel: HTTP 码映射', () => {
  assert.equal(errorCodeLabel('HTTP 429'), '网关限流（稍后自动重试）');
  assert.equal(errorCodeLabel('HTTP 502'), '网关过载');
  assert.equal(errorCodeLabel('HTTP 503'), '网关过载');
  assert.equal(errorCodeLabel('HTTP 504'), '网关超时');
  assert.equal(errorCodeLabel('HTTP 408'), '网关超时');
  assert.equal(errorCodeLabel('HTTP 402'), '余额/套餐不足');
  assert.equal(errorCodeLabel('HTTP 401'), 'Key 无效或无权限');
  assert.equal(errorCodeLabel('HTTP 403'), 'Key 无效或无权限');
});

test('errorCodeLabel: 判定/程序节点码映射', () => {
  assert.equal(errorCodeLabel('NO_TOOLS'), '子代理空转（0 次工具）');
  assert.equal(errorCodeLabel('EMPTY_CONTENT'), '没有返回内容');
  assert.equal(errorCodeLabel('TRUNCATED'), '输出被截断');
  assert.equal(errorCodeLabel('GATE_FAIL'), '程序闸失败');
});

test('errorCodeLabel: 没有映射的码一律「步骤失败」', () => {
  assert.equal(errorCodeLabel('STEP_FAIL'), '步骤失败');
  assert.equal(errorCodeLabel('HTTP 500'), '步骤失败');
  assert.equal(errorCodeLabel('WEIRD_CODE'), '步骤失败');
  assert.equal(errorCodeLabel(''), '步骤失败');
  assert.equal(errorCodeLabel(null), '步骤失败');
  assert.equal(errorCodeLabel(undefined), '步骤失败');
});

// ---------- extractHttpErrorCode ----------

test('extractHttpErrorCode: 从网关错误里提取状态码', () => {
  assert.equal(extractHttpErrorCode('网关连接失败：HTTP 429 Too Many Requests（已重试 5 次）。请检查：网络代理。'), 'HTTP 429');
  assert.equal(extractHttpErrorCode('网关连接失败：HTTP 429（已重试 5 次）'), 'HTTP 429');
  assert.equal(extractHttpErrorCode('HTTP/1.1 502 Bad Gateway'), 'HTTP 502');
  assert.equal(extractHttpErrorCode('HTTP503'), 'HTTP 503');
  assert.equal(extractHttpErrorCode('子代理调用失败：连接被重置'), null);
  assert.equal(extractHttpErrorCode(''), null);
  assert.equal(extractHttpErrorCode(null), null);
});

// ---------- deriveNodeErrorCode：优先级 ----------

test('deriveNodeErrorCode: HTTP 码优先于一切（含空转/程序节点）', () => {
  assert.equal(deriveNodeErrorCode({
    errorText: '网关连接失败：HTTP 429（已重试 5 次）',
    content: '',
    toolCount: 0,
    toolCountKnown: true,
    requiresTools: true,
  }), 'HTTP 429');
  assert.equal(deriveNodeErrorCode({
    program: true,
    errorText: '上游网关 HTTP 502 Bad Gateway',
    content: '',
  }), 'HTTP 502');
});

test('deriveNodeErrorCode: 程序节点失败 → GATE_FAIL（不看工具计数）', () => {
  assert.equal(deriveNodeErrorCode({ program: true, errorText: 'review_diff 命令执行失败', content: '' }), 'GATE_FAIL');
  // 程序节点没有 out.error、只缺内容：同样是 GATE_FAIL，而不是 EMPTY_CONTENT
  assert.equal(deriveNodeErrorCode({ program: true, errorText: '', content: '' }), 'GATE_FAIL');
});

test('deriveNodeErrorCode: 判定失败 → NO_TOOLS / EMPTY_CONTENT / TRUNCATED', () => {
  assert.equal(deriveNodeErrorCode({
    errorText: '',
    content: '代码看起来没问题。',
    toolCount: 0,
    toolCountKnown: true,
    requiresTools: true,
  }), 'NO_TOOLS');
  // 工具次数未知（旧 mock 没带 toolCount）时不判空转：与 judgeSubagentOutcome 同条件
  assert.equal(deriveNodeErrorCode({
    errorText: '',
    content: '代码看起来没问题。',
    toolCount: 0,
    toolCountKnown: false,
    requiresTools: true,
  }), 'STEP_FAIL');
  assert.equal(deriveNodeErrorCode({ errorText: '', content: '', toolCount: 1, requiresTools: false }), 'EMPTY_CONTENT');
  assert.equal(deriveNodeErrorCode({ errorText: '', content: '半截 JSON{"a":', toolCount: 1, truncated: true, requiresTools: true }), 'TRUNCATED');
});

test('deriveNodeErrorCode: out.error 有内容但没有码 → STEP_FAIL（不冒充空内容/空转）', () => {
  // callStep 抛错时 content 必为空、工具计数未知：原因在调用本身，不是「没有返回内容」
  assert.equal(deriveNodeErrorCode({
    errorText: '子代理调用失败：连接被重置',
    content: '',
    toolCount: 0,
    toolCountKnown: false,
    requiresTools: true,
  }), 'STEP_FAIL');
  assert.equal(deriveNodeErrorCode({ errorText: '当前通道不支持子代理调用', content: '' }), 'STEP_FAIL');
});

// ---------- runWorkflow（script 模式）集成：结果行 / 快照 / summary 都带码 ----------

test('errorcode/run: 网关 HTTP 429 → 结果行、快照、summary 都带 HTTP 429', async () => {
  const snaps = [];
  const out = await runWorkflow({
    goal: '检查登录模块',
    script: [{ op: 'step', id: 'a', name: '扫描', role: '审查员', prompt: '检查登录模块' }],
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
  // 原始人话错误仍然保留：码是补充，不是替换
  assert.match(row.error, /HTTP 429/);
  assert.match(out.summary, /失败（HTTP 429 · 网关限流（稍后自动重试））/);
  // 快照 step 也带码（UI 卡片 chip 从这里取）
  const snapStep = snaps.at(-1).steps.find((s) => s.id === 'a');
  assert.equal(snapStep.status, 'failed');
  assert.equal(snapStep.errorCode, 'HTTP 429');
});

test('errorcode/run: 0 工具空转 → NO_TOOLS，summary 带码', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'step', id: 'r', name: '复核', role: '审查员', prompt: '审查配置' }],
    callStep: async () => ({ content: '代码看起来没问题。', toolCount: 0 }),
  });
  const row = out.results.find((r) => r.id === 'r');
  assert.equal(row.ok, false);
  assert.match(row.error, /未产生任何工具调用/);
  assert.equal(row.errorCode, 'NO_TOOLS');
  assert.match(out.summary, /失败（NO_TOOLS · 子代理空转（0 次工具））/);
});

test('errorcode/run: 空内容（不需要取证的步骤）→ EMPTY_CONTENT', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'step', id: 'e', name: '抄写', role: '记录员', prompt: '把结论抄写成一句话' }],
    callStep: async () => ({ content: '', toolCount: 1 }),
  });
  const row = out.results.find((r) => r.id === 'e');
  assert.equal(row.ok, false);
  assert.match(row.error, /子代理没有返回内容/);
  assert.equal(row.errorCode, 'EMPTY_CONTENT');
  assert.match(out.summary, /失败（EMPTY_CONTENT · 没有返回内容）/);
});

test('errorcode/run: 验证步骤被截断且 JSON 解析失败 → TRUNCATED', async () => {
  const out = await runWorkflow({
    goal: '检查登录模块',
    script: [
      { op: 'step', id: 'a', name: '扫描', role: '审查员', prompt: '检查登录模块的越权风险' },
      { op: 'verify', id: 'v1', name: '盲验', from: ['a'] },
    ],
    callStep: async (ctx) => {
      if (ctx.id === 'a') return { content: '发现登录接口未做权限校验，存在越权风险。', toolCount: 1 };
      return { content: '{"verdicts":[{"claimId":"f1","verdict":"conf', toolCount: 1, truncated: true };
    },
  });
  const row = out.results.find((r) => r.id === 'v1');
  assert.ok(row, '验证节点应产生结果行');
  assert.equal(row.ok, false);
  assert.match(row.error, /输出被截断/);
  assert.equal(row.errorCode, 'TRUNCATED');
  assert.match(out.summary, /失败（TRUNCATED · 输出被截断）/);
});

test('errorcode/run: 程序闸失败 → GATE_FAIL', async () => {
  const out = await runWorkflow({
    goal: 'g',
    // 终局校验要求脚本必须有 report/aggregate；这里关心的是 gate 自己的失败码。
    script: [
      { op: 'gate', id: 'g1', name: '整改闸', tool: 'review_diff', args: { dir: 'D:/tmp' } },
      { op: 'report', id: 'rep', from: 'g1', ask: '汇总' },
    ],
    runGate: async () => { throw new Error('review_diff 命令执行失败'); },
  });
  const row = out.results.find((r) => r.id === 'g1');
  assert.equal(row.ok, false);
  assert.match(row.error, /review_diff 命令执行失败/);
  assert.equal(row.errorCode, 'GATE_FAIL');
  assert.match(out.summary, /失败（GATE_FAIL · 程序闸失败）/);
});

test('errorcode/run: callStep 抛错且无码 → STEP_FAIL', async () => {
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'step', id: 'x', name: '步骤X', role: '审查员', prompt: '检查配置' }],
    callStep: async () => { throw new Error('子代理调用失败：连接被重置'); },
  });
  const row = out.results.find((r) => r.id === 'x');
  assert.equal(row.ok, false);
  assert.equal(row.errorCode, 'STEP_FAIL');
  assert.match(out.summary, /失败（STEP_FAIL · 步骤失败）/);
});

test('errorcode/run: 成功节点 errorCode 为 null，不产生误导', async () => {
  const reportText = [
    '## Conclusion', '扫描完成，无问题。', '## Findings', 'None',
    '## Verified', 'None', '## Not covered', 'None', '## Skipped', 'None', '',
  ].join('\n');
  const out = await runWorkflow({
    goal: 'g',
    script: [{ op: 'step', id: 'ok1', name: '扫描', role: '审查员', prompt: '检查配置' }],
    callStep: async (ctx) => ({
      content: ctx.id === '__report__' ? reportText : '扫描完成，无问题。',
      toolCount: ctx.id === '__report__' ? 0 : 1,
    }),
  });
  assert.equal(out.ok, true);
  const row = out.results.find((r) => r.id === 'ok1');
  assert.equal(row.ok, true);
  assert.equal(row.errorCode, null);
  assert.match(out.summary, /完成/);
});

// ---------- humanize 兜底：HTTP 状态码必须在人话文案里存活（时间线失败行靠它保码） ----------

test('errorcode/humanize: 网关错误人话化后状态码仍可见', () => {
  const out = humanizeToolError('网关连接失败：HTTP 429 Too Many Requests（已重试 5 次）。请检查：网络代理。');
  assert.match(out, /429/);
  assert.match(humanizeToolError('HTTP 502 Bad Gateway'), /502/);
  assert.match(humanizeToolError('网关连接失败：HTTP 429（已重试 5 次）'), /429/);
});
