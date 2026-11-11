// 子代理展示名（职位名）回归：
// - 关键词表逐条命中（14 条规则都要有自己的样例，改表忘了改测试会立刻红）
// - 合法职位名原样保留；「步骤 1」「Step 2」被替换（禁止序号名）
// - DAG（runWorkflow steps）与 DSL（script fanout）两条链路的卡片标题都是职位名
// - 兜底永远不是空串、不是「步骤」
// 全部用 fake callStep，不碰真实模型/网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_KIND_LABELS,
  AGENT_TITLE_RULES,
  agentKindLabel,
  agentTitleFor,
  agentTitleForFanout,
  isRoleLikeName,
} from '../desktop/src/main/agent-titles.mjs';
import { needsEvidence, normalizeSteps, runWorkflow } from '../desktop/src/main/workflow.mjs';
import { stepDisplayName, isIndexName } from '../desktop/src/renderer/lib/step-view.mjs';

// ---- 关键词表：每条规则一个只命中它的样例（顺序敏感，故意写在紧邻的规则之间） ----
const RULE_SAMPLES = [
  ['注入面审查员', '检查 login.js 的 SQL 注入与 XSS'],
  ['鉴权与越权审查员', '排查 IDOR 越权与 JWT 鉴权配置'],
  ['密钥与凭证审计员', '扫描硬编码密钥与 .env 泄露'],
  ['供应链合规专员', '核对依赖清单的 CVE 与许可证'],
  ['数据与隐私专员', '检查数据库备份与脱敏策略'],
  ['测试覆盖审查员', '补充单元测试与覆盖率'],
  ['性能分析员', '排查慢查询与 N+1'],
  ['运维与可观测性专员', '检查日志、监控与告警'],
  ['代码可读性审查员', '评估代码可读性与复杂度'],
  ['项目侦察员', '盘点项目架构与入口目录'],
  ['交付与交接专员', '整理 README 与交接文档'],
  ['交付报告主编', '写出最终报告'],
  ['红队复核员', '复核上游结论并证伪'],
  ['争议仲裁员', '仲裁两条结论的分歧'],
];

test('agent-titles: 关键词表 14 条规则逐条命中', () => {
  assert.equal(AGENT_TITLE_RULES.length, RULE_SAMPLES.length, '规则数变了就要同步样例');
  for (const [title, sample] of RULE_SAMPLES) {
    assert.equal(agentTitleFor({ prompt: sample }), title, `「${sample}」应命中「${title}」`);
  }
});

test('agent-titles: 关键词表标题去重且都像职位名', () => {
  const titles = AGENT_TITLE_RULES.map((r) => r.title);
  assert.equal(new Set(titles).size, titles.length, '规则标题不能重复');
  for (const title of titles) {
    assert.ok(isRoleLikeName(title), `「${title}」本身必须是合法职位名`);
  }
});

test('agent-titles: 模型给的合法职位名原样保留（只裁长度）', () => {
  assert.equal(agentTitleFor({ name: 'SQL 注入审查员', prompt: '随便写' }), 'SQL 注入审查员');
  assert.equal(agentTitleFor({ name: '依赖供应链专员', kind: 'find' }), '依赖供应链专员');
  assert.equal(agentTitleFor({ name: '鉴权与越权审查员', kind: 'report' }), '鉴权与越权审查员', 'name 优先于 kind');
  assert.ok(isRoleLikeName('登录接口审计员'));
});

test('agent-titles: 「步骤 1」「Step 2」这种序号名被替换成职位名', () => {
  assert.equal(agentTitleFor({ name: '步骤 1', prompt: '检查 SQL 注入' }), '注入面审查员');
  assert.equal(agentTitleFor({ name: 'Step 2', kind: 'find' }), '取证审查员');
  assert.equal(agentTitleFor({ name: 'step 3' }), '审查员');
  for (const name of ['步骤 1', 'Step 2', 's1', 'find', '分析', '检查', '']) {
    assert.ok(!isRoleLikeName(name), `「${name}」不该被当成职位名`);
  }
});

test('agent-titles: kind 兜底与最终兜底（永不为空、永不是「步骤」）', () => {
  assert.equal(agentTitleFor({ kind: 'recon' }), '项目侦察员');
  assert.equal(agentTitleFor({ kind: 'find' }), '取证审查员');
  assert.equal(agentTitleFor({ kind: 'verify' }), '红队复核员');
  assert.equal(agentTitleFor({ kind: 'arbitrate' }), '争议仲裁员');
  assert.equal(agentTitleFor({ kind: 'report' }), '交付报告主编');
  for (const input of [{}, { name: '' }, { prompt: '' }, { kind: 'unknown-kind' }]) {
    const title = agentTitleFor(input);
    assert.ok(title && title.trim(), '兜底名不能为空');
    assert.ok(!/步骤/.test(title), `兜底名不能是序号名：${title}`);
    assert.ok(!/^[a-z]+$/i.test(title), `兜底名不能是英文枚举：${title}`);
  }
  assert.equal(agentTitleFor({ index: 3 }), '审查员 #3', '什么都没有时序号才当后缀');
});

test('agent-titles: goal/role 也参与关键词推断', () => {
  assert.equal(agentTitleFor({ goal: '审计鉴权与越权', prompt: '按目录逐个看' }), '鉴权与越权审查员');
  assert.equal(agentTitleFor({ role: '性能压测', prompt: '跑一下' }), '性能分析员');
});

test('agent-titles: kind 中文小标签（英文枚举不许裸奔）', () => {
  assert.equal(agentKindLabel('find'), '取证');
  assert.equal(agentKindLabel('verify'), '复核');
  assert.equal(agentKindLabel('report'), '汇总');
  assert.equal(agentKindLabel('recon'), '侦察');
  assert.equal(agentKindLabel('FIND'), '取证', '大小写不敏感');
  assert.equal(agentKindLabel(''), '');
  assert.equal(agentKindLabel(null), '');
  assert.equal(agentKindLabel('mystery'), '', '未知 kind 不渲染英文');
  for (const [kind, label] of Object.entries(AGENT_KIND_LABELS)) {
    assert.ok(/[\u4e00-\u9fa5]/.test(label), `${kind} 的标签必须是中文：${label}`);
  }
});

test('agent-titles: fanout 子名带扇出项 + 容器职位名', () => {
  assert.equal(
    agentTitleForFanout({ baseTitle: '鉴权与越权审查员', item: '/api/login', index: 0 }),
    '/api/login 鉴权与越权审查员',
  );
  assert.equal(
    agentTitleForFanout({ baseTitle: '路由审查员', item: '/api/login', index: 1 }),
    '/api/login 路由审查员',
  );
  // 扇出项没有信息量（纯序号）→ 职位名 #序号
  assert.equal(agentTitleForFanout({ baseTitle: '注入面审查员', item: '2', index: 2 }), '注入面审查员 #3');
  // 扇出项过长截断，总长压到一行放得下
  const long = agentTitleForFanout({ baseTitle: '代码可读性审查员', item: 'src/components/deep/nested/file.js', index: 0 });
  assert.ok(long.length <= 28, `子名不能太长：${long}`);
  assert.ok(long.includes('…'), '超长扇出项要截断');
});

test('agent-titles: DAG runWorkflow 无名步骤 → 结果行 name 是职位名、不含「步骤」', async () => {
  const out = await runWorkflow({
    goal: '审计登录模块',
    steps: [
      { id: 'a', prompt: '登录接口的鉴权与越权风险', depends_on: [] },
      { id: 'b', prompt: '依赖清单里的 CVE 与许可证', depends_on: [] },
      { id: 'c', name: '步骤 3', prompt: '整理交接文档', depends_on: ['a', 'b'] },
    ],
    callStep: async ({ id }) => ({ content: `content-${id}` }),
  });
  assert.equal(out.error, undefined);
  const byId = Object.fromEntries(out.steps.map((s) => [s.id, s]));
  assert.equal(byId.a.name, '鉴权与越权审查员');
  assert.equal(byId.b.name, '供应链合规专员');
  assert.equal(byId.c.name, '交付与交接专员', '模型写「步骤 3」也要换成职位名');
  for (const s of out.steps) assert.ok(!/步骤/.test(s.name), `${s.id} 的展示名不能含「步骤」：${s.name}`);
});

test('agent-titles: DSL fanout 子节点 name 是职位名且看得出扇出对象', async () => {
  const out = await runWorkflow({
    goal: '逐接口审计登录鉴权',
    script: [
      {
        op: 'fanout',
        id: 'fa',
        over: ['/api/login', '/api/admin'],
        as: 'r',
        step: { prompt: '审计 ${r} 的鉴权与越权' },
      },
    ],
    callStep: async ({ id }) => ({ content: `ok-${id}`, toolCount: 1 }),
  });
  assert.equal(out.error, undefined);
  const rows = out.results.filter((r) => r.id.startsWith('fa#'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, '/api/login 鉴权与越权审查员');
  assert.ok(rows[0].name.includes('/api/login'), '名字里要能看出扇出的是哪一项');
  assert.ok(rows[0].name.includes('审查员'), '名字要保持职位名形态');
  for (const r of rows) assert.ok(!/步骤/.test(r.name), `fanout 子名不能含「步骤」：${r.name}`);
});

test('agent-titles: DSL verify/report 兜底不再是「验证 N」「汇总 N」', async () => {
  const out = await runWorkflow({
    goal: '给出一份结论',
    script: [
      { op: 'step', id: 's', prompt: '读代码给出结论', depends_on: [] },
      { op: 'verify', id: 'v', from: ['s'] },
      { op: 'report', id: 'rp', from: ['v'] },
    ],
    callStep: async ({ id }) => ({ content: id === 'rp' ? '## Conclusion\nNone\n## Findings\nNone\n## Verified\nNone\n## Not covered\nNone\n## Skipped\nNone' : `ok-${id}`, toolCount: 2 }),
  });
  assert.equal(out.error, undefined);
  const byId = Object.fromEntries(out.steps.map((s) => [s.id, s]));
  assert.equal(byId.v.name, '红队复核员');
  assert.equal(byId.rp.name, '交付报告主编');
  for (const s of out.steps) assert.ok(!/^(?:步骤|验证|汇总|程序|循环|递归)\s*[\d.]*$/.test(s.name), `${s.id}: ${s.name}`);
});

test('agent-titles: normalizeSteps 保留合法 name、无 name 时生成职位名', () => {
  const norm = normalizeSteps([
    { id: 'a', name: '依赖供应链专员', prompt: '看依赖' },
    { id: 'b', prompt: '查 SQL 注入' },
  ]);
  assert.equal(norm.error, undefined);
  assert.equal(norm.steps[0].name, '依赖供应链专员');
  assert.equal(norm.steps[1].name, '注入面审查员');
  assert.equal(norm.steps[0].originalName, '依赖供应链专员');
  assert.equal(norm.steps[1].originalName, '', '没给 name 时 originalName 是空串');
});

test('agent-titles: 生成职位名不改变取证判定（needsEvidence 只看原始 name）', () => {
  // 展示名「审查员」自带取证关键词：模型没给 name 的纯文本步骤不该因此被强制跑工具
  assert.equal(needsEvidence({ name: '审查员', originalName: '', prompt: '写一段介绍文字', role: '' }), false);
  // 没有 originalName 的老数据仍按旧口径（name 参与判定）
  assert.equal(needsEvidence({ name: '审查员', prompt: '写一段介绍文字', role: '' }), true);
  // 模型自己给了带关键词的 name，照旧要求取证
  assert.equal(needsEvidence({ name: 'SQL 注入审查员', originalName: 'SQL 注入审查员', prompt: '看代码', role: '' }), true);
});

test('agent-titles: 卡片渲染兜底（老会话的「步骤 1」不在界面上露出来）', () => {
  assert.ok(isIndexName('步骤 1'));
  assert.ok(isIndexName('验证 1.0'));
  assert.ok(isIndexName('程序 2'));
  assert.ok(!isIndexName('注入面审查员'));
  assert.equal(stepDisplayName({ name: '注入面审查员' }), '注入面审查员');
  assert.equal(stepDisplayName({ name: '步骤 1', kind: 'find' }), '取证审查员');
  assert.equal(stepDisplayName({ name: '程序 2', opType: 'gate' }), '程序校验员');
  assert.equal(stepDisplayName({}), '审查员');
});
