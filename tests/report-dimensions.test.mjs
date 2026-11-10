import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { audit } from '../src/audit.mjs';
import { renderReport } from '../src/report.mjs';
import { CORE_DIMENSION_NAMES } from '../src/profile.mjs';

// 维度报告：有 profile（res.tier.dimensions）时按维度出结论；没有 profile 时旧输出逐字不变。

const LOCK = {
  name: 'probe', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'probe', version: '1.0.0', license: 'UNLICENSED' } },
};
const README = [
  '# Probe project',
  '',
  'Minimal Node.js project used by FinalCheck dimension-report tests. To install, run the test script:',
  '',
  '```',
  'npm install',
  'npm test',
  '```',
  '',
  'The project deliberately has zero external dependencies, so the dependency audit stays offline.',
  'It contains no secrets, no HTTP routes and no password handling.',
  '',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
  'This paragraph exists only to push the README past the 400-character handover threshold. ',
].join('\n');

async function makeProject(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-dims-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'probe', version: '1.0.0', private: true, license: 'UNLICENSED',
    scripts: { start: 'node app.js', test: 'node -e "process.exit(0)"' },
  }), 'utf8');
  await writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(LOCK), 'utf8');
  await writeFile(path.join(dir, 'README.md'), README, 'utf8');
  await writeFile(path.join(dir, 'app.js'), "const greeting = 'hello';\nconsole.log(greeting);\n", 'utf8');
  return dir;
}

const uniformProfile = (sources = {}, overrides = {}) => ({
  dimensions: {
    ...Object.fromEntries(CORE_DIMENSION_NAMES.map((name) => [name, 'L2'])),
    ...overrides,
  },
  sources,
});

const rowOf = (text, name) => text.split('\n').find((l) => l.startsWith(`| ${name} |`));

const assertFiveSections = (text) => {
  const order = ['## Conclusion', '## Findings', '## Verified', '## Not covered', '## Skipped']
    .map((h) => text.indexOf(h));
  for (let i = 0; i < order.length; i += 1) {
    assert.ok(order[i] >= 0, `缺少段落：${['## Conclusion', '## Findings', '## Verified', '## Not covered', '## Skipped'][i]}`);
    if (i) assert.ok(order[i] > order[i - 1], '五段顺序必须是 Conclusion → Findings → Verified → Not covered → Skipped');
  }
};

test('profile + 无 sources：维度表 11 行、证据 unverified，Not covered 带原因', async (t) => {
  const dir = await makeProject(t);
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false, profile: uniformProfile({}) });
  const text = renderReport(res);

  assertFiveSections(text);
  assert.match(text, /\| 维度 \| 档位 \| 结论 \| 证据等级 \| 覆盖的检查项 \|/);
  assert.ok(text.indexOf('维度结论表：') < text.indexOf('## Findings'), '维度表必须在具体发现之前');
  // 表在报告开头区域：结论头之后就是表
  assert.ok(text.indexOf('维度结论表：') < text.indexOf('本轮覆盖：'));

  for (const name of CORE_DIMENSION_NAMES) {
    const row = rowOf(text, name);
    assert.ok(row, `${name} 必须有维度行`);
    assert.match(row, /\| L2 \|/);
    assert.match(row, /\| unverified \|/);
  }
  // 无源码/URL：每个维度都该把 not-covered/unverified 的原因写进 ## Not covered
  const notCovered = text.slice(text.indexOf('## Not covered'), text.indexOf('## Skipped'));
  assert.match(notCovered, /维度「安全性」证据等级 unverified：未验证（缺源码与 URL）/);
  assert.match(notCovered, /维度「性能」证据等级 unverified：未验证（缺源码与 URL）/);
  // 11 个核心维度各一行（成本未选入）
  const rows = text.split('\n').filter((l) => /^\| \S+ \| L[123] \|/.test(l));
  assert.equal(rows.length, CORE_DIMENSION_NAMES.length);
});

test('profile + 只有源码：代码类维度 full、动态类 static-only', async (t) => {
  const dir = await makeProject(t);
  const res = await audit(dir, {
    tier: 'L2', interactive: true, runTests: false, profile: uniformProfile({ code: './src' }),
  });
  const text = renderReport(res);

  assert.match(rowOf(text, '安全性'), /\| static-only \| S1、S2、S3、S5、S6、S7、S8 \|/);
  assert.match(rowOf(text, '数据与隐私'), /\| static-only \| S3、S8 \|/);
  for (const name of ['供应链与许可证', '可维护性', '代码可读性', '可测试性', '可移交性']) {
    assert.match(rowOf(text, name), /\| full \|/, `${name} 只有源码时应为 full`);
  }
  // 有源码时不该再出现 unverified 维度
  assert.doesNotMatch(text.slice(text.indexOf('维度结论表：'), text.indexOf('## Findings')), /unverified/);
});

test('profile + 源码和 URL：动态维度按 dynamicAuth 降级，静态维度 full', async (t) => {
  const dir = await makeProject(t);
  const res = await audit(dir, {
    tier: 'L2',
    interactive: true,
    runTests: false,
    profile: uniformProfile({ code: './src', url: 'https://example.com' }),
  });
  const text = renderReport(res);

  for (const name of ['安全性', '鲁棒性', '性能', '运行稳定性']) {
    assert.match(rowOf(text, name), /\| static-only \|/, `${name} 未授权压测应为 static-only`);
  }
  for (const name of ['数据与隐私', '可维护性', '代码可读性', '可测试性', '供应链与许可证', '可观测性与可运维', '可移交性']) {
    assert.match(rowOf(text, name), /\| full \|/, `${name} 源码 + URL 应为 full`);
  }
  // 证据降级的原因只在证据等级列出现，不篡改结论列
  assert.match(rowOf(text, '安全性'), /\| (过|修完再过|拦|待授权|无法验收|不适用) \| static-only \|/);
});

test('不传 profile：旧输出逐字不变（黄金样本 + 真实审计都不出现维度表）', async (t) => {
  const legacyRes = {
    projectDir: 'D:/demo/probe',
    tier: { requested: null, suggested: 'L2', effective: 'L2', signals: ['未找到 package.json'], conservativeNote: null },
    gates: {
      planned: ['S3', 'Q1'],
      executed: ['S3'],
      gaps: ['Q1：未授权执行测试'],
      gapItems: [{ checkId: 'Q1', kind: 'unauthorized', reason: '未授权执行测试' }],
    },
    findings: [{
      checkId: 'S3', severity: 'high', force: 'card', file: 'app.js', line: 3,
      snippet: "const k = 'abcdef1234567890';", message: '硬编码密钥', rule: 'S3.secret-literal',
    }],
    conclusion: { verdict: '待授权', reason: '仅缺授权执行项：Q1：未授权执行测试；其余检查初判「拦」' },
    warnings: ['跳过目录：node_modules', '跳过目录：dist'],
  };
  const GOLDEN = [
    '',
    '【🟡 待授权】结论：待授权',
    '理由：仅缺授权执行项：Q1：未授权执行测试；其余检查初判「拦」',
    '',
    '项目：D:/demo/probe',
    '档位：L2（自动建议 L2）',
    '定档信号：未找到 package.json',
    '覆盖：S3（计划 S3、Q1）',
    '  🟡 待授权：Q1：未授权执行测试',
    '下一步：授权后重跑：Q1 需要执行项目测试',
    '  ℹ️ 跳过目录（共 2 条，已排除出扫描范围）',
    '',
    '本轮覆盖：S3；未跑：Q1；未启用：S1/S2/S4/S5/S6/S7/S8/D1/D2/D3/Q2/H1/Q3/Q4/Q5/C1/O1。',
    '',
    '🔴 高危｜密钥与弱默认（S3）｜硬编码密钥',
    "   证据：app.js:3  const k = 'abcdef1234567890';",
    '   判定来源：S3.secret-literal（程序判定/实锤）',
    '   修复提示词（粘回 AI）：把密钥移入 .env（并确认 .gitignore 含 .env），代码改用 process.env 读取；若该密钥曾提交过 git，视为已泄漏，立即作废并轮换。',
    '',
  ].join('\n');
  assert.equal(renderReport(legacyRes), GOLDEN, '无 profile 时输出必须与旧格式逐字相同');

  const dir = await makeProject(t);
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: true });
  const text = renderReport(res);
  assert.ok(!('dimensions' in res.tier));
  assert.doesNotMatch(text, /## Conclusion|维度结论表|## Not covered/);
  assert.match(text, /本轮覆盖：/);
});

test('发现按维度分组：标题用维度名，不出现 Q4 可读性度量 这类内部名', async (t) => {
  const res = {
    projectDir: 'D:/demo/probe',
    tier: {
      requested: null, suggested: 'L2', effective: 'L2', signals: [], conservativeNote: null,
      dimensions: {
        安全性: { level: 'L2', verdict: '修完再过' },
        代码可读性: { level: 'L2', verdict: '修完再过' },
      },
    },
    gates: {
      planned: ['S5', 'Q4', 'Q2'], executed: ['S5', 'Q4', 'Q2'], gaps: [], gapItems: [],
    },
    evidence: {
      安全性: { level: 'static-only', reason: '仅静态（缺 URL，无实测证据）' },
      代码可读性: { level: 'full', reason: '证据充分（源码可查）' },
    },
    findings: [
      { checkId: 'Q4', severity: 'medium', force: 'check', file: 'a.js', line: 9, snippet: 'x', message: '函数过长', rule: 'Q4.long-function' },
      { checkId: 'S5', severity: 'high', force: 'card', file: 'a.js', line: 2, snippet: 'debug', message: 'debug 开启', rule: 'S5.debug-on' },
      { checkId: 'Q2', severity: 'medium', force: 'card', file: 'q.json', line: 1, snippet: 'lint', message: '质量命令失败', rule: 'Q2.lint-failed' },
    ],
    conclusion: { verdict: '拦', reason: '1 条高危实锤' },
    warnings: [],
  };
  const text = renderReport(res);

  assert.match(text, /^### 安全性$/m);
  assert.match(text, /^### 代码可读性$/m);
  assert.match(text, /^### 其他检查$/m, 'Q2 不属于任何维度，单独成组');
  assert.doesNotMatch(text, /Q4 可读性度量/);
  // 发现落在自己维度的标题之后、下一个标题之前
  const safety = text.indexOf('### 安全性');
  const read = text.indexOf('### 代码可读性');
  assert.ok(safety < text.indexOf('debug 开启') && text.indexOf('debug 开启') < read);
  assert.ok(read < text.indexOf('函数过长'));
});

test('无法验收维度带原因：成本未接入检查，写进 Not covered 与 Skipped', async (t) => {
  const dir = await makeProject(t);
  const res = await audit(dir, {
    tier: 'L2', interactive: true, runTests: false,
    profile: uniformProfile({ code: './src' }, { 成本: 'L2' }),
  });
  const text = renderReport(res);

  assert.match(rowOf(text, '成本'), /\| L2 \| 无法验收 \| static-only \| 无（该档位不要求检查） \|/);
  const notCovered = text.slice(text.indexOf('## Not covered'), text.indexOf('## Skipped'));
  assert.match(notCovered, /维度「成本」无法验收：该维度尚未接入检查/);
  const skipped = text.slice(text.indexOf('## Skipped'));
  assert.match(skipped, /成本：该维度尚未接入检查（能力缺失，未执行）/);
});

test('待授权维度：可测试性行结论待授权，表格标出未跑检查', async (t) => {
  const dir = await makeProject(t);
  const res = await audit(dir, {
    tier: 'L2', interactive: true, runTests: false, profile: uniformProfile({ code: './src' }),
  });
  const text = renderReport(res);

  assert.equal(res.tier.dimensions.可测试性.verdict, '待授权');
  assert.match(rowOf(text, '可测试性'), /\| L2 \| 待授权 \| full \| Q1（未跑：Q1） \|/);
  const skipped = text.slice(text.indexOf('## Skipped'));
  assert.match(skipped, /Q1：未授权执行测试.*（待授权，未执行）/);
  // 待授权不是「无法验收」：该维度不该出现在 Not covered 的无法验收行
  assert.doesNotMatch(text.slice(text.indexOf('## Not covered'), text.indexOf('## Skipped')), /维度「可测试性」无法验收/);
});

test('不适用维度：L1 可测试性证据 not-covered，原因写进 Not covered', async (t) => {
  const dir = await makeProject(t);
  const res = await audit(dir, {
    tier: 'L2', interactive: true, runTests: false,
    profile: uniformProfile({ code: './src' }, { 可测试性: 'L1' }),
  });
  const text = renderReport(res);

  assert.equal(res.tier.dimensions.可测试性.verdict, '不适用');
  assert.match(rowOf(text, '可测试性'), /\| L1 \| 不适用 \| not-covered \| 无（该档位不要求检查） \|/);
  const notCovered = text.slice(text.indexOf('## Not covered'), text.indexOf('## Skipped'));
  assert.match(notCovered, /维度「可测试性」证据等级 not-covered：未覆盖（该档位不要求检查）/);
});
