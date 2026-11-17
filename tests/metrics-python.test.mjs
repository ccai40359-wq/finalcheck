// Q3 Python 支持测试（2026-11-17）。
// 三件事必须锁住：
//   ① 三条纯文本/结构规则对 .py 真的生效（大文件 / 重复块 / 导入环）
//   ② 不支持的（未使用导出）必须显式声明，不能冒充已查
//   ③ 仓库里的第三方库 import 不能算成导入环（否则会报根本不存在的环）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMetrics } from '../src/checks/metrics.mjs';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-pyq3-'));
  t?.after?.(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Q3: Python 超大文件命中 Q3.large-file', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'big.py'), 'value = 1\n'.repeat(900), 'utf8');
  const r = await checkMetrics(dir, { tier: 'L2' });
  const hit = r.findings.filter((f) => f.rule === 'Q3.large-file');
  assert.equal(hit.length, 1, '900 行 > 800 阈值，应命中');
  assert.equal(hit[0].file, 'big.py');
});

test('Q3: Python 跨文件重复块命中 Q3.duplicate-block', async (t) => {
  const dir = tmpDir(t);
  // 原逻辑要求「≥3 处且跨 ≥2 文件」，所以造 3 个文件
  const block = [
    'def transform(payload):',
    '    step_one = normalize_value(payload)',
    '    step_two = enrich_value(step_one)',
    '    step_three = validate_value(step_two)',
    '    step_four = serialize_value(step_three)',
    '    return step_four',
    ''
  ].join('\n');
  for (const name of ['a.py', 'b.py', 'c.py']) fs.writeFileSync(path.join(dir, name), block, 'utf8');
  const r = await checkMetrics(dir, { tier: 'L2' });
  assert.ok(r.findings.some((f) => f.rule === 'Q3.duplicate-block'), '三个文件同一段代码应命中重复块');
});

test('Q3: Python 导入环命中 Q3.import-cycle', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'alpha.py'), 'from beta import helper\nCONST = 1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'beta.py'), 'from alpha import CONST\nhelper = 2\n', 'utf8');
  const r = await checkMetrics(dir, { tier: 'L2' });
  const cyc = r.findings.filter((f) => f.rule === 'Q3.import-cycle');
  assert.equal(cyc.length, 1, 'a→b→a 应报一个环');
  assert.match(String(cyc[0].snippet), /alpha\.py.*beta\.py/, '环路径要写清两头');
});

test('Q3: 第三方库 import 不产生假导入环', async (t) => {
  const dir = tmpDir(t);
  // 典型的「看起来像环」但没有仓库内对应文件
  fs.writeFileSync(path.join(dir, 'app.py'),
    'import logging\nimport uuid\nfrom fastapi import FastAPI\nfrom sqlalchemy.orm import Session\n', 'utf8');
  const r = await checkMetrics(dir, { tier: 'L2' });
  assert.equal(r.findings.filter((f) => f.rule === 'Q3.import-cycle').length, 0,
    'logging/uuid/fastapi 在仓库里没有对应 .py，不能算边');
});

test('Q3: Python 侧明确声明未使用导出不实现（不冒充已查）', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'mod.py'), 'def public_api():\n    return 1\n', 'utf8');
  const r = await checkMetrics(dir, { tier: 'L2' });
  assert.ok(r.pythonCoverage, '有 Python 文件时必须给出覆盖说明');
  assert.equal(r.pythonCoverage.files, 1);
  assert.ok(r.pythonCoverage.unsupported.includes('Q3.unused-export'),
    '未使用导出必须列进 unsupported，不能静默当作已查');
  assert.ok(r.pythonCoverage.rules.includes('Q3.large-file'));
  assert.ok(r.pythonCoverage.rules.includes('Q3.import-cycle'));
});

test('Q3: 纯 JS 项目不出现 pythonCoverage 字段（JS 零回归）', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const x = 1;\n', 'utf8');
  const r = await checkMetrics(dir, { tier: 'L2' });
  assert.equal(r.pythonCoverage, undefined,
    '没有 Python 文件时不该多出字段，保证老调用方拿到的形状不变');
});

test('Q3: 动态导入进 warnings，不静默省略', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'dyn.py'),
    'import importlib\nmod = importlib.import_module(name)\n', 'utf8');
  const r = await checkMetrics(dir, { tier: 'L2' });
  assert.ok(r.warnings.some((w) => /动态导入|未能静态解析/.test(w)),
    '动态导入必须写进 warnings，不能当作已解析');
});

test('Q3: 混合仓（JS + Python）两边都扫到', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'app.mjs'), 'export function a() { return 1; }\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'mod.py'), 'def b():\n    return 2\n', 'utf8');
  const r = await checkMetrics(dir, { tier: 'L2' });
  assert.ok(r.pythonCoverage && r.pythonCoverage.files === 1, 'Python 侧被扫到');
  assert.equal(r.coverageGap, null, '两边都有文件，不该报缺口');
});
