import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_KINDS,
  applyVerdicts,
  buildSwarmPrompt,
  claimsToJsonl,
  collectClaims,
  lintClaims,
  lintReport,
  normalizeSwarmStep,
  parseAgentJson,
} from '../desktop/src/main/swarm.mjs';

test('swarm: STEP_KINDS 固定为五种，顺序稳定', () => {
  assert.deepEqual(STEP_KINDS, ['recon', 'find', 'verify', 'arbitrate', 'report']);
});

test('swarm: normalizeSwarmStep 校验 kind/model/providerId/blind/targetsFrom', () => {
  const find = normalizeSwarmStep({ kind: 'find' });
  assert.deepEqual(find, { kind: 'find', blind: false }, 'find 默认非盲');
  const verify = normalizeSwarmStep({ kind: 'verify', model: 'm1', providerId: 'p1', targetsFrom: 'f1' });
  assert.deepEqual(verify, { kind: 'verify', model: 'm1', providerId: 'p1', blind: true, targetsFrom: 'f1' }, 'verify 默认盲验');
  assert.equal(normalizeSwarmStep({ kind: 'arbitrate' }).blind, true, 'arbitrate 默认盲仲裁');
  assert.equal(normalizeSwarmStep({ kind: 'verify', blind: false }).blind, false, '显式 blind=false 生效');
  assert.equal(normalizeSwarmStep({}).kind, 'find', '缺省 kind 为 find');
  assert.equal(normalizeSwarmStep({ kind: 'recon' }).blind, false, 'recon 默认非盲');

  assert.throws(() => normalizeSwarmStep({ kind: 'exploit' }), /未知步骤 kind/);
  assert.throws(() => normalizeSwarmStep({ kind: 'find', model: 42 }), /model 必须是字符串/);
  assert.throws(() => normalizeSwarmStep({ kind: 'find', providerId: {} }), /providerId 必须是字符串/);
  assert.throws(() => normalizeSwarmStep({ kind: 'find', blind: 'maybe' }), /blind 必须是布尔值/);
  assert.throws(() => normalizeSwarmStep({ kind: 'find', targetsFrom: 7 }), /targetsFrom 必须是步骤 id 字符串/);
});

test('swarm: recon 提示词要求 targets/path/risk/reason', () => {
  const p = buildSwarmPrompt({ goal: '审查登录', step: { kind: 'recon', prompt: '找攻击面' } });
  assert.match(p, /总目标：审查登录/);
  assert.match(p, /"targets"/);
  assert.match(p, /"path"/);
  assert.match(p, /"risk"/);
  assert.match(p, /"reason"/);
  assert.match(p, /只输出一个 JSON 对象/);
});

test('swarm: find 提示词硬规则「没有证据就不要写」', () => {
  const p = buildSwarmPrompt({
    goal: 'G',
    step: { kind: 'find', prompt: '逐条取证' },
    upstream: [{ id: 'r1', content: '{"targets":[{"id":"t1","path":"a.mjs","risk":"high","reason":"入口"}]}', ok: true }],
  });
  assert.match(p, /没有证据就不要写/);
  assert.match(p, /"findings"/);
  assert.match(p, /"evidence"/);
  assert.match(p, /原始命令\/输出或代码原文/);
  assert.match(p, /t1/, '侦察目标应作为线索注入 find');
});

test('swarm: verify 提示词只给 claims + 证据指针，禁止引用发现者叙述', () => {
  const claims = [
    { id: 'f1', claim: 'A 未校验', evidence: 'cat a.mjs -> exec(user)', severity: 'high', file: 'a.mjs', line: 10 },
  ];
  const p = buildSwarmPrompt({
    goal: 'G',
    step: { kind: 'verify', prompt: '独立复现' },
    upstream: [{ id: 'find1', content: '发现者叙述-MARKER：我认为这里一定有问题', ok: true }],
    claims,
  });
  assert.match(p, /禁止引用发现者的叙述/);
  assert.match(p, /必须独立复现/);
  assert.match(p, /无法复现的 claim 一律判 uncertain/);
  assert.match(p, /confirmed\|rejected\|uncertain/);
  assert.match(p, /"claims"/);
  assert.match(p, /f1/);
  assert.match(p, /a\.mjs:10/, '证据指针必须带文件:行');
  assert.ok(!p.includes('发现者叙述-MARKER'), '盲验提示词不得包含 finder 的叙述');
  assert.ok(!p.includes('我认为这里一定有问题'));
});

test('swarm: normalizeSwarmStep 保留 prompt/role，空白值不写入空串', () => {
  const s = normalizeSwarmStep({ kind: 'verify', prompt: '  独立复现任务  ', role: ' 审核员 ' });
  assert.equal(s.prompt, '独立复现任务', 'prompt 必须保留（trim 后）');
  assert.equal(s.role, '审核员', 'role 必须保留（trim 后）');
  assert.deepEqual(normalizeSwarmStep({ kind: 'find', prompt: '', role: '   ' }), { kind: 'find', blind: false }, '空白 prompt/role 不产生字段');
});

test('swarm: 带 prompt 的 find 步骤，「本步骤任务」后必须拼上原文', () => {
  const task = '逐条取证：检查 auth.mjs 的输入校验是否可绕过';
  const p = buildSwarmPrompt({ goal: 'G', step: { kind: 'find', prompt: `  ${task}  ` } });
  assert.ok(p.includes(`本步骤任务：${task}`), 'trim 后的任务原文必须出现在提示词里');
  assert.ok(!/本步骤任务：\n/.test(p), '「本步骤任务」后不能是空行');
});

test('swarm: verify 给任务文本，但 blind 仍不注入上游 content', () => {
  const claims = [{ id: 'f1', claim: 'A 未校验', evidence: 'cat a.mjs -> exec(user)', file: 'a.mjs', line: 10 }];
  const p = buildSwarmPrompt({
    goal: 'G',
    step: { kind: 'verify', prompt: '独立复现 A 未校验' },
    upstream: [{ id: 'find1', content: '上游叙述-MARKER-CONTENT', ok: true }],
    claims,
  });
  assert.match(p, /本步骤任务：独立复现 A 未校验/, '盲验也必须给出自己的任务文本');
  assert.ok(!p.includes('上游叙述-MARKER-CONTENT'), '盲验不得注入上游 content');
  assert.match(p, /"claims"/, 'claims 仍要注入');
  assert.match(p, /a\.mjs:10/, '证据指针仍要注入');
});

test('swarm: 无 prompt 的旧步骤输出保持旧格式，不凭空编任务', () => {
  const legacy = buildSwarmPrompt({ goal: 'G', step: { id: 'legacy', name: '旧步骤' } });
  const blank = buildSwarmPrompt({ goal: 'G', step: { id: 'legacy', name: '旧步骤', prompt: '   ' } });
  assert.equal(legacy, blank, '空白 prompt 与无 prompt 输出一致');
  assert.equal(legacy.split('\n\n')[0], '总目标：G\n本步骤任务：', '旧格式头部一字不变（冒号后为空）');
  assert.ok(!legacy.includes('undefined'), '不得把 undefined 拼进 prompt');
  assert.ok(!legacy.includes('[object Object]'));
  assert.match(legacy, /你是取证步骤（find）/, 'kind 默认 find 的分支仍在');
});

test('swarm: 步骤 role 在归一化后仍出现在提示词里', () => {
  const p = buildSwarmPrompt({
    goal: 'G',
    step: { kind: 'report', role: '  安全审计负责人 ', prompt: '汇总本轮结论' },
    claims: [],
  });
  assert.match(p, /你的角色：安全审计负责人/, 'role 必须保留并出现在提示词');
  assert.match(p, /本步骤任务：汇总本轮结论/);
});

test('swarm: blind=false 时 verify 才注入上游 content', () => {
  const p = buildSwarmPrompt({
    goal: 'G',
    step: { kind: 'verify', prompt: '独立复现', blind: false },
    upstream: [{ id: 'find1', content: '发现者叙述-MARKER', ok: true }],
    claims: [{ id: 'f1', claim: 'X', evidence: 'e', file: 'a.mjs', line: 1 }],
  });
  assert.match(p, /发现者叙述-MARKER/);
  assert.match(p, /禁止引用发现者的叙述/, '即使看到 content，硬规则仍在');
});

test('swarm: arbitrate 提示词要求逐字引用且禁止多数票', () => {
  const claims = [{
    id: 'f1',
    claim: 'A 有问题',
    verdicts: [
      { verdict: 'confirmed', evidence: 'v1 输出', stepId: 'v1' },
      { verdict: 'rejected', evidence: 'v2 输出', stepId: 'v2' },
    ],
  }];
  const p = buildSwarmPrompt({ goal: 'G', step: { kind: 'arbitrate', prompt: '裁决冲突' }, claims });
  assert.match(p, /逐字引用原文或命令输出/);
  assert.match(p, /禁止多数票/);
  assert.match(p, /"decisions"/);
  assert.match(p, /"conflicts"/);
  assert.match(p, /f1/);
  assert.match(p, /v1/);
  assert.match(p, /v2/);
});

test('swarm: report 提示词强制五段且空段写 None', () => {
  const p = buildSwarmPrompt({ goal: 'G', step: { kind: 'report', prompt: '汇总' }, claims: [] });
  for (const name of ['Conclusion', 'Findings', 'Verified', 'Not covered', 'Skipped']) {
    assert.match(p, new RegExp(`## ${name}`), `报告必须包含 ## ${name}`);
  }
  assert.match(p, /没有任何内容的段落写 None/);
  assert.match(p, /Skipped 必须写明跳过项和原因/);
  assert.match(p, /不得增删章节/);
});

test('swarm: parseAgentJson 去围栏/取第一个完整 JSON/失败返回 error', () => {
  assert.deepEqual(parseAgentJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseAgentJson('先说明\n```\n{"targets":[{"id":"t1"}]}\n```\n后说明'), { targets: [{ id: 't1' }] });
  assert.deepEqual(parseAgentJson('前缀 {"a":1} 中间 {"b":2} 后缀'), { a: 1 }, '取第一个完整 JSON');
  assert.deepEqual(parseAgentJson('{"x":"} 不是结尾"}'), { x: '} 不是结尾' }, '字符串里的括号不参与配对');
  assert.deepEqual(parseAgentJson('[1,2,3]'), [1, 2, 3]);
  assert.deepEqual(parseAgentJson('{oops} {"ok":true}'), { ok: true }, '第一个候选坏了要继续找下一个');
  assert.match(parseAgentJson('完全没有 JSON 的一段话').error, /没有找到合法 JSON/);
  assert.match(parseAgentJson('').error, /内容为空/);
  assert.match(parseAgentJson(null).error, /不是字符串/);
});

test('swarm: collectClaims 汇总 findings、默认 pending、带 sourceStep 且跨步去重 id', () => {
  const results = new Map([
    ['f1', { id: 'f1', content: JSON.stringify({ findings: [{ id: 'c1', claim: 'A', evidence: 'e1', severity: 'high', file: 'a.mjs', line: 3, reproduced: true }] }) }],
    ['f2', { id: 'f2', content: JSON.stringify({ findings: [{ id: 'c1', claim: 'B', evidence: 'e2' }] }) }],
  ]);
  const claims = collectClaims(results);
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map((c) => c.id).sort(), ['c1', 'c1~f2']);
  assert.deepEqual(claims.map((c) => c.status), ['pending', 'pending'], 'find 产出必须 pending');
  assert.equal(claims[0].sourceStep, 'f1');
  assert.equal(claims[1].sourceStep, 'f2');
  assert.equal(claims[0].severity, 'high');
  assert.equal(claims[0].line, 3);
  assert.equal(claims[1].evidence, 'e2');
  assert.deepEqual(claims[0].verdicts, []);
});

test('swarm: applyVerdicts confirmed 保留 / uncertain→lead / rejected→rejected，未覆盖保持 pending', () => {
  const claims = [
    { id: 'c1', claim: 'A', evidence: 'e1', status: 'pending' },
    { id: 'c2', claim: 'B', evidence: 'e2', status: 'pending' },
    { id: 'c3', claim: 'C', evidence: 'e3', status: 'pending' },
    { id: 'c4', claim: 'D', evidence: 'e4', status: 'pending' },
  ];
  const out = applyVerdicts(claims, [
    { claimId: 'c1', verdict: 'confirmed', evidence: '亲自复现 e1', note: 'ok' },
    { claimId: 'c2', verdict: 'uncertain', evidence: '复现失败', note: '不能确认' },
    { claimId: 'c3', verdict: 'rejected', evidence: '与 claim 冲突', note: '驳回' },
  ], { model: 'm1', providerId: 'p1', stepId: 'v1' });

  const byId = new Map(out.map((c) => [c.id, c]));
  assert.equal(byId.get('c1').status, 'confirmed');
  assert.equal(byId.get('c1').verifiedBy.model, 'm1');
  assert.equal(byId.get('c1').verifiedBy.stepId, 'v1');
  assert.equal(byId.get('c1').verifiedEvidence, '亲自复现 e1');
  assert.equal(byId.get('c2').status, 'lead');
  assert.equal(byId.get('c3').status, 'rejected');
  assert.equal(byId.get('c4').status, 'pending', '没有 verify 覆盖不许变成 confirmed');
  assert.equal(byId.get('c1').verdicts.length, 1);
  assert.equal(claims[0].status, 'pending', 'applyVerdicts 不修改入参');
});

test('swarm: lintClaims 缺 evidence / confirmed 缺 verifiedBy 都降 lead 并给 warning', () => {
  const { claims, warnings } = lintClaims([
    { id: 'c1', claim: 'A', evidence: '', status: 'pending' },
    { id: 'c2', claim: 'B', evidence: 'e2', status: 'confirmed' },
    { id: 'c3', claim: 'C', evidence: 'e3', status: 'confirmed', verifiedBy: { model: 'm1' } },
    { id: 'c4', claim: 'D', evidence: 'e4', status: 'rejected' },
  ]);
  const byId = new Map(claims.map((c) => [c.id, c]));
  assert.equal(byId.get('c1').status, 'lead');
  assert.equal(byId.get('c2').status, 'lead');
  assert.equal(byId.get('c3').status, 'confirmed', '有 verifiedBy/model 的 confirmed 保留');
  assert.equal(byId.get('c4').status, 'rejected');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /c1 缺少 evidence/);
  assert.match(warnings[1], /c2 标为 confirmed 但缺少 verifiedBy\/model/);
});

test('swarm: lintReport 五段齐全/空段 None/Skipped 写原因，只返回 warnings 不抛错', () => {
  const good = [
    '## Conclusion', '全部查完',
    '## Findings', '- f1 confirmed',
    '## Verified', '- f1 @ a.mjs:1',
    '## Not covered', 'None',
    '## Skipped', 'None',
  ].join('\n');
  assert.deepEqual(lintReport(good), []);

  const missing = good.replace('## Skipped\nNone', '');
  assert.match(lintReport(missing).join('\n'), /缺少段落 ## Skipped/);

  const empty = good.replace('## Conclusion\n全部查完', '## Conclusion\n');
  assert.match(lintReport(empty).join('\n'), /段落 ## Conclusion 为空/);

  const skippedEmpty = good.replace('## Skipped\nNone', '## Skipped\n');
  assert.match(lintReport(skippedEmpty).join('\n'), /段落 ## Skipped 为空/);

  const skippedReason = good.replace('## Skipped\nNone', '## Skipped\n- 并发验证：因为时间预算不足跳过');
  assert.deepEqual(lintReport(skippedReason), []);

  const reordered = [
    '## Findings', '- f1',
    '## Conclusion', 'ok',
    '## Verified', 'None',
    '## Not covered', 'None',
    '## Skipped', 'None',
  ].join('\n');
  assert.match(lintReport(reordered).join('\n'), /段落顺序不对/);

  assert.deepEqual(lintReport(''), ['报告为空：缺少全部五个段落', ...['Conclusion', 'Findings', 'Verified', 'Not covered', 'Skipped'].map((n) => `缺少段落 ## ${n}`)]);
});

test('swarm: claimsToJsonl 每行一个 claim，空数组返回空串', () => {
  assert.equal(claimsToJsonl([]), '');
  const claims = [
    { id: 'c1', status: 'confirmed', evidence: 'e1' },
    { id: 'c2', status: 'lead', evidence: 'e2' },
  ];
  const text = claimsToJsonl(claims);
  assert.ok(text.endsWith('\n'));
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => JSON.parse(l).id), ['c1', 'c2']);
});
