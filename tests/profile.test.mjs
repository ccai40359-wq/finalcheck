import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import {
  DIMENSIONS, CORE_DIMENSION_NAMES, OPTIONAL_DIMENSION_NAMES, LEVELS, PROFILE_FILE,
  UNIMPLEMENTED_REASON, EVIDENCE_LEVELS, DEFAULT_LOAD_LIMIT,
  loadProfile, planFromProfile, normalizeLevel, highestLevel, evidenceMatrix,
} from '../src/profile.mjs';
import { audit, GATES } from '../src/audit.mjs';

const LOCK = {
  name: 'probe', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'probe', version: '1.0.0', license: 'UNLICENSED' } },
};
const README = [
  '# Probe project',
  '',
  'Minimal Node.js project used by FinalCheck profile tests. To install, run the test script:',
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

async function tmpDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function probeProject(t, { app = "const greeting = 'hello';\nconsole.log(greeting);\n" } = {}) {
  const dir = await tmpDir(t);
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'probe', version: '1.0.0', private: true, license: 'UNLICENSED',
    scripts: { start: 'node app.js', test: 'node -e "process.exit(0)"' },
  }), 'utf8');
  await writeFile(path.join(dir, 'package-lock.json'), JSON.stringify(LOCK), 'utf8');
  await writeFile(path.join(dir, 'README.md'), README, 'utf8');
  await writeFile(path.join(dir, 'app.js'), app, 'utf8');
  return dir;
}

const uniform = (lv) => ({ dimensions: Object.fromEntries(CORE_DIMENSION_NAMES.map((name) => [name, lv])) });

test('DIMENSIONS：11 个核心维度 + 可选成本，每维三档字段合法且 L2 并集等于 GATES.L2', () => {
  assert.deepEqual(Object.keys(DIMENSIONS), [...CORE_DIMENSION_NAMES, ...OPTIONAL_DIMENSION_NAMES]);
  assert.equal(CORE_DIMENSION_NAMES.length, 11);
  assert.deepEqual(OPTIONAL_DIMENSION_NAMES, ['成本']);

  const dynamicValues = new Set([false, 'local', 'authorized']);
  const verifyValues = new Set([false, 'single', 'adversarial']);
  const modelValues = new Set(['small', 'standard', 'strong']);
  const fanoutValues = new Set([1, 8, 20]);

  for (const [name, def] of Object.entries(DIMENSIONS)) {
    for (const lv of LEVELS) {
      const spec = def[lv];
      assert.ok(spec, `${name}.${lv} 必须有定义`);
      assert.ok(Array.isArray(spec.checks), `${name}.${lv}.checks 必须是数组`);
      assert.ok(dynamicValues.has(spec.dynamic), `${name}.${lv}.dynamic 非法：${spec.dynamic}`);
      assert.ok(verifyValues.has(spec.verify), `${name}.${lv}.verify 非法：${spec.verify}`);
      assert.ok(modelValues.has(spec.modelTier), `${name}.${lv}.modelTier 非法：${spec.modelTier}`);
      assert.ok(fanoutValues.has(spec.fanoutCap), `${name}.${lv}.fanoutCap 非法：${spec.fanoutCap}`);
    }
  }

  const l2Checks = new Set();
  for (const name of CORE_DIMENSION_NAMES) {
    for (const id of DIMENSIONS[name].L2.checks) l2Checks.add(id);
  }
  assert.deepEqual([...l2Checks].sort(), [...GATES.L2].sort());
});

test('loadProfile：文件缺失 → 全 L2 缺省、零警告；三档合并计划与旧 GATES 逐项相等', async (t) => {
  const dir = await tmpDir(t);
  const profile = await loadProfile(dir);

  assert.equal(profile.source, 'default');
  assert.deepEqual(profile.warnings, []);
  assert.deepEqual(Object.keys(profile.dimensions), CORE_DIMENSION_NAMES);
  assert.ok(Object.values(profile.dimensions).every((lv) => lv === 'L2'));

  assert.deepEqual(planFromProfile(profile).planned, GATES.L2);
  assert.deepEqual(planFromProfile(uniform('L1')).planned, GATES.L1);
  assert.deepEqual(planFromProfile(uniform('L2')).planned, GATES.L2);
  assert.deepEqual(planFromProfile(uniform('L3')).planned, GATES.L3);

  const defaultPlan = planFromProfile(profile);
  assert.equal(defaultPlan.dynamic, 'local');
  assert.equal(defaultPlan.verify, 'single');
  assert.equal(defaultPlan.modelTier, 'standard');
  assert.equal(defaultPlan.fanoutCap, 8);
});

test('单维度改档：数据与隐私 L3 只追加该维检查并抬高合并调度参数', () => {
  const up = planFromProfile({ 数据与隐私: 'L3' });
  assert.equal(up.dimensions.数据与隐私.level, 'L3');
  assert.deepEqual(up.dimensions.数据与隐私.checks, ['S3', 'S8', 'D1', 'D2', 'D3']);
  assert.deepEqual(up.planned, [...GATES.L2, 'D1', 'D2', 'D3']);
  assert.equal(up.dimensions.安全性.level, 'L2');
  assert.equal(up.dynamic, 'authorized');
  assert.equal(up.verify, 'adversarial');
  assert.equal(up.modelTier, 'strong');
  assert.equal(up.fanoutCap, 20);

  const down = planFromProfile({ 可测试性: 'L1' });
  assert.equal(down.dimensions.可测试性.level, 'L1');
  assert.deepEqual(down.dimensions.可测试性.checks, []);
  assert.ok(!down.planned.includes('Q1'));
  assert.deepEqual(down.planned, GATES.L2.filter((id) => id !== 'Q1'));
});

test('非法档位回落 L2 并留 warning；l3/数字/对象写法仍可识别', async (t) => {
  const dir = await tmpDir(t);
  await writeFile(path.join(dir, PROFILE_FILE), JSON.stringify({
    dimensions: {
      安全性: 'L9',
      数据与隐私: null,
      性能: 'l3',
      可测试性: { level: 3 },
    },
  }), 'utf8');

  const profile = await loadProfile(dir);
  assert.equal(profile.source, PROFILE_FILE);
  assert.equal(profile.dimensions.安全性, 'L2');
  assert.equal(profile.dimensions.数据与隐私, 'L2');
  assert.equal(profile.dimensions.性能, 'L3');
  assert.equal(profile.dimensions.可测试性, 'L3');
  assert.equal(profile.dimensions.可维护性, 'L2', '未写出的维度仍缺省 L2');
  assert.equal(profile.warnings.length, 2);
  assert.match(profile.warnings.join(' '), /安全性/);
  assert.match(profile.warnings.join(' '), /数据与隐私/);
  assert.match(profile.warnings.join(' '), /回落 L2/);

  assert.equal(normalizeLevel('2'), 'L2');
  assert.equal(normalizeLevel('L3'), 'L3');
  assert.equal(normalizeLevel('L4'), null);
  assert.equal(normalizeLevel('strong'), null);
  assert.equal(highestLevel(['L1', 'bad', 'L3', 'L2']), 'L3');
  assert.equal(highestLevel([]), 'L1');

  // 审计入口不吞 loadProfile 的警告
  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false, profile });
  assert.ok(res.warnings.some((w) => w.includes('回落 L2')));
});

test('未实现维度：成本记 coverageGap「该维度尚未接入检查」，audit 结论无法验收', async (t) => {
  const plan = planFromProfile({ 成本: 'L2' });
  assert.equal(plan.dimensions.成本.implemented, false);
  assert.deepEqual(plan.gapsForUnimplemented, [
    { dimension: '成本', level: 'L2', reason: UNIMPLEMENTED_REASON },
  ]);
  assert.deepEqual(plan.planned, GATES.L2, '未实现维度不往计划里塞假检查');

  const dir = await probeProject(t);
  const res = await audit(dir, {
    tier: 'L2', interactive: true, runTests: false, profile: { 成本: 'L2' },
  });
  const gap = res.gates.gapItems.find((g) => g.checkId === '成本');
  assert.equal(gap.kind, 'unavailable');
  assert.equal(gap.reason, UNIMPLEMENTED_REASON);
  assert.ok(res.gates.gaps.includes(`成本：${UNIMPLEMENTED_REASON}`));
  assert.deepEqual(res.tier.dimensions.成本, { level: 'L2', verdict: '无法验收' });
  assert.equal(res.conclusion.verdict, '无法验收');
});

test('未知维度：进 gapsForUnknown 并只作为 warning，不污染计划与结论', async (t) => {
  const plan = planFromProfile({ 火星基地: 'L3' });
  assert.equal(plan.gapsForUnknown.length, 1);
  assert.equal(plan.gapsForUnknown[0].dimension, '火星基地');
  assert.ok(!('火星基地' in plan.dimensions));
  assert.deepEqual(plan.planned, GATES.L2);

  const dir = await probeProject(t);
  const res = await audit(dir, {
    tier: 'L2', interactive: true, runTests: false, profile: { 火星基地: 'L3' },
  });
  assert.ok(res.warnings.some((w) => w.includes('未知维度') && w.includes('火星基地')));
  assert.ok(!res.gates.gapItems.some((g) => g.checkId === '火星基地'));
  assert.deepEqual(res.gates.planned, GATES.L2);
});

test('audit 带 profile：tier.dimensions 给出每维 level/verdict；不带 profile 时无该字段', async (t) => {
  const dir = await probeProject(t);
  const profile = await loadProfile(dir);

  const withProfile = await audit(dir, {
    tier: 'L2', interactive: true, runTests: true, profile,
  });
  assert.deepEqual(Object.keys(withProfile.tier.dimensions), CORE_DIMENSION_NAMES);
  const verdicts = new Set(['过', '修完再过', '拦', '待授权', '无法验收', '不适用']);
  for (const name of CORE_DIMENSION_NAMES) {
    assert.equal(withProfile.tier.dimensions[name].level, 'L2');
    assert.ok(verdicts.has(withProfile.tier.dimensions[name].verdict), `${name} verdict 非法`);
  }
  assert.equal(withProfile.conclusion.verdict, '过');
  assert.deepEqual(withProfile.gates.planned, GATES.L2);
  assert.deepEqual(withProfile.gates.executed, GATES.L2);

  const legacy = await audit(dir, { tier: 'L2', interactive: true, runTests: true });
  assert.ok(!('dimensions' in legacy.tier));
  assert.deepEqual(legacy.gates.planned, withProfile.gates.planned, 'profile 缺省与旧 GATES 计划一致');
  assert.equal(legacy.conclusion.verdict, withProfile.conclusion.verdict);
});

test('每维结论按本维发现判定：密钥高危同时打中安全性与数据隐私', async (t) => {
  const dir = await probeProject(t, { app: "const apiKey = 'abcdef1234567890';\nconsole.log(apiKey);\n" });
  const res = await audit(dir, {
    tier: 'L2', interactive: true, runTests: false, profile: { dimensions: {} },
  });

  assert.equal(res.tier.dimensions.安全性.verdict, '拦');
  assert.equal(res.tier.dimensions.数据与隐私.verdict, '拦');
  assert.equal(res.tier.dimensions.性能.verdict, '过');
  assert.equal(res.tier.dimensions.可测试性.verdict, '待授权', 'Q1 未授权只在可测试性里体现');
  assert.ok(res.findings.some((f) => f.checkId === 'S3' && f.severity === 'high'));
});

test('audit 单维度降档：可测试性 L1 不再计划 Q1，维度结论为不适用', async (t) => {
  const dir = await probeProject(t);
  const res = await audit(dir, {
    tier: 'L2', interactive: true, runTests: false, profile: { 可测试性: 'L1' },
  });

  assert.ok(!res.gates.planned.includes('Q1'));
  assert.deepEqual(res.gates.planned, GATES.L2.filter((id) => id !== 'Q1'));
  assert.deepEqual(res.tier.dimensions.可测试性, { level: 'L1', verdict: '不适用' });
  assert.equal(res.tier.dimensions.安全性.level, 'L2');
  assert.ok(!res.gates.gapItems.some((g) => g.checkId === 'Q1'));
  assert.equal(res.conclusion.verdict, '过');
});

// ---- sources / evidenceMatrix（三轴模型第二轴） ----

test('loadProfile：sources 缺省 {}；非法 sources 回落空输入面并留 warning', async (t) => {
  const empty = await tmpDir(t);
  assert.deepEqual((await loadProfile(empty)).sources, {});

  const bad = await tmpDir(t);
  await writeFile(path.join(bad, PROFILE_FILE), JSON.stringify({ sources: 'not-an-object' }), 'utf8');
  const badProfile = await loadProfile(bad);
  assert.deepEqual(badProfile.sources, {});
  assert.ok(badProfile.warnings.some((w) => w.includes('sources 必须是对象')));

  const arr = await tmpDir(t);
  await writeFile(path.join(arr, PROFILE_FILE), JSON.stringify({ sources: ['https://example.com'] }), 'utf8');
  assert.deepEqual((await loadProfile(arr)).sources, {});

  // 非法 sources 下没有任何输入面 → 证据等级是 unverified，而不是 full/static-only
  const ev = evidenceMatrix({ sources: 'not-an-object' });
  assert.equal(ev.安全性.level, 'unverified');
  assert.match(ev.安全性.reason, /缺源码与 URL/);
});

test('sources.loadLimit：缺省 10s/10 连接，部分值补齐，非法值与超限回落', async (t) => {
  const dir = await tmpDir(t);
  await writeFile(path.join(dir, PROFILE_FILE), JSON.stringify({ sources: { code: './src' } }), 'utf8');
  const base = await loadProfile(dir);
  assert.deepEqual(base.sources, {
    code: './src', dynamicAuth: false, loadLimit: { ...DEFAULT_LOAD_LIMIT },
  });
  assert.deepEqual(DEFAULT_LOAD_LIMIT, { seconds: 10, connections: 10 });

  const partial = await tmpDir(t);
  await writeFile(path.join(partial, PROFILE_FILE), JSON.stringify({
    sources: { url: 'https://example.com/app', loadLimit: { seconds: 30 } },
  }), 'utf8');
  const p = await loadProfile(partial);
  assert.deepEqual(p.sources.loadLimit, { seconds: 30, connections: 10 });

  const invalid = await tmpDir(t);
  await writeFile(path.join(invalid, PROFILE_FILE), JSON.stringify({
    sources: { code: './src', loadLimit: { seconds: 0, connections: 'many' } },
  }), 'utf8');
  const i = await loadProfile(invalid);
  assert.deepEqual(i.sources.loadLimit, { seconds: 10, connections: 10 });
  assert.equal(i.warnings.filter((w) => w.includes('loadLimit.')).length, 2);

  const capped = await tmpDir(t);
  await writeFile(path.join(capped, PROFILE_FILE), JSON.stringify({
    sources: { code: './src', loadLimit: { seconds: 999, connections: 999 } },
  }), 'utf8');
  const c = await loadProfile(capped);
  assert.deepEqual(c.sources.loadLimit, { seconds: 60, connections: 50 });
  assert.equal(c.warnings.filter((w) => w.includes('封顶')).length, 2);
});

test('evidenceMatrix 只有源码：代码类维度 full，动态/观测类 static-only，成本按输入面', () => {
  const ev = evidenceMatrix({ sources: { code: './src' } });
  for (const name of ['可维护性', '代码可读性', '可移交性', '供应链与许可证', '可测试性']) {
    assert.equal(ev[name].level, 'full', `${name} 只有源码也应 full`);
  }
  for (const name of ['安全性', '数据与隐私', '鲁棒性', '运行稳定性', '性能', '可观测性与可运维']) {
    assert.equal(ev[name].level, 'static-only', `${name} 只有源码应是 static-only`);
  }
  assert.match(ev.安全性.reason, /仅静态（缺 URL，无实测证据）/);
  assert.ok(!('成本' in ev), '未显式选入的维度不出现');

  const withCost = evidenceMatrix({ dimensions: { 成本: 'L2' }, sources: { code: './src' } });
  assert.equal(withCost.成本.level, 'static-only', '成本有源码时按 static-only 计证据');
  assert.match(withCost.成本.reason, /缺 URL/);
});

test('evidenceMatrix 只有 URL 且未授权：动态维度 static-only，代码类维度 not-covered', () => {
  const ev = evidenceMatrix({ sources: { url: 'https://example.com' } });
  for (const name of ['安全性', '鲁棒性', '性能', '运行稳定性']) {
    assert.equal(ev[name].level, 'static-only');
    assert.match(ev[name].reason, /未授权压测/);
  }
  assert.equal(ev['供应链与许可证'].level, 'static-only');
  assert.equal(ev.可观测性与可运维.level, 'static-only');
  for (const name of ['可维护性', '代码可读性', '可测试性', '可移交性', '数据与隐私']) {
    assert.equal(ev[name].level, 'not-covered', `${name} 只有 URL 应 not-covered`);
    assert.match(ev[name].reason, /缺源码/);
  }

  const withCost = evidenceMatrix({ dimensions: { 成本: 'L2' }, sources: { url: 'https://example.com' } });
  assert.equal(withCost.成本.level, 'not-covered', '成本没有源码时无法核算');
});

test('evidenceMatrix 只有 URL + dynamicAuth：动态维度升级 full，代码类维度仍 not-covered', () => {
  const ev = evidenceMatrix({ sources: { url: 'https://example.com', dynamicAuth: true } });
  for (const name of ['安全性', '鲁棒性', '性能', '运行稳定性']) {
    assert.equal(ev[name].level, 'full');
    assert.match(ev[name].reason, /已授权/);
    assert.match(ev[name].reason, /10s\/10 连接/);
  }
  assert.equal(ev['供应链与许可证'].level, 'static-only');
  assert.equal(ev.可维护性.level, 'not-covered');
});

test('evidenceMatrix 源码 + URL：静态维度全 full；动态维度开关 dynamicAuth', () => {
  const noAuth = evidenceMatrix({ sources: { code: './src', url: 'https://example.com' } });
  for (const name of ['安全性', '鲁棒性', '性能', '运行稳定性']) {
    assert.equal(noAuth[name].level, 'static-only');
    assert.match(noAuth[name].reason, /未授权压测/);
  }
  for (const name of ['数据与隐私', '可维护性', '代码可读性', '可测试性', '供应链与许可证', '可观测性与可运维', '可移交性']) {
    assert.equal(noAuth[name].level, 'full', `${name} 源码 + URL 应 full`);
  }

  const authed = evidenceMatrix({ sources: { code: './src', url: 'https://example.com', dynamicAuth: true } });
  for (const name of CORE_DIMENSION_NAMES) assert.equal(authed[name].level, 'full', `${name} 应 full`);

  const cost = evidenceMatrix({ dimensions: { 成本: 'L2' }, sources: { code: './src', url: 'https://example.com' } });
  assert.equal(cost.成本.level, 'full', '源码 + URL 时成本也可核算');
});

test('evidenceMatrix 按档位：L1 空检查维度 not-covered，有检查维度照常判定', () => {
  const ev = evidenceMatrix({
    dimensions: { 可维护性: 'L1', 可测试性: 'L1', 安全性: 'L1' },
    sources: { code: './src' },
  });
  assert.equal(ev.可维护性.level, 'not-covered');
  assert.match(ev.可维护性.reason, /该档位不要求检查/);
  assert.equal(ev.可测试性.level, 'not-covered');
  assert.equal(ev.安全性.level, 'static-only', 'L1 安全性仍有检查，按输入面判');
  assert.equal(ev.性能.level, 'static-only');
});

test('audit 带 sources 的 profile：结果多出 evidence；不传 profile 时不出现', async (t) => {
  const dir = await probeProject(t);
  await writeFile(path.join(dir, PROFILE_FILE), JSON.stringify({
    sources: { code: './src' },
  }), 'utf8');
  const profile = await loadProfile(dir);

  const res = await audit(dir, { tier: 'L2', interactive: true, runTests: false, profile });
  assert.ok(res.evidence, '带 profile 必须有 evidence');
  assert.deepEqual(Object.keys(res.evidence), CORE_DIMENSION_NAMES);
  for (const name of CORE_DIMENSION_NAMES) {
    assert.ok(EVIDENCE_LEVELS.includes(res.evidence[name].level), `${name} 证据等级非法`);
    assert.equal(typeof res.evidence[name].reason, 'string');
    assert.ok(res.evidence[name].reason.length > 0);
  }
  assert.equal(res.evidence.安全性.level, 'static-only');
  assert.equal(res.evidence.可维护性.level, 'full');

  const legacy = await audit(dir, { tier: 'L2', interactive: true, runTests: false });
  assert.ok(!('evidence' in legacy));
});
