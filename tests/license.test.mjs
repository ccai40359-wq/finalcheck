import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { checkLicense } from '../src/checks/license.mjs';

const byRule = (findings, rule) => findings.filter((f) => f.rule === rule);

async function makeProject(t, { pkg, installed = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-c1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  if (installed) {
    await mkdir(path.join(dir, 'node_modules'), { recursive: true });
    for (const [name, manifest] of Object.entries(installed)) {
      const pkgDir = path.join(dir, 'node_modules', name);
      await mkdir(pkgDir, { recursive: true });
      await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
    }
  }
  return dir;
}

test('C1：AGPL 依赖 → high C1.copyleft（L3 卡）', async (t) => {
  const dir = await makeProject(t, {
    pkg: { name: 'demo', version: '1.0.0', license: 'MIT', dependencies: { 'agpl-lib': '^2.0.0' } },
    installed: { 'agpl-lib': { name: 'agpl-lib', version: '2.1.0', license: 'AGPL-3.0-only' } }
  });
  const r = await checkLicense(dir, { tier: 'L3' });
  assert.equal(r.checkId, 'C1');
  assert.equal(r.coverageGap, null);
  assert.deepEqual(Object.keys(r).sort(), ['checkId', 'coverageGap', 'findings', 'warnings']);
  const f = byRule(r.findings, 'C1.copyleft');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'high');
  assert.equal(f[0].force, 'card');
  assert.equal(f[0].file, 'package.json');
  assert.equal(f[0].source, 'program');
  assert.match(f[0].snippet, /agpl-lib@2\.1\.0/);
  assert.match(f[0].snippet, /AGPL-3\.0-only/);
  assert.match(f[0].message, /传染性/);
  assert.match(f[0].message, /法务确认/);
});

test('C1：依赖无 license 字段 → medium C1.no-license', async (t) => {
  const dir = await makeProject(t, {
    pkg: { name: 'demo', version: '1.0.0', license: 'MIT', dependencies: { 'bare-lib': '^1.0.0' } },
    installed: { 'bare-lib': { name: 'bare-lib', version: '1.2.0' } }
  });
  const r = await checkLicense(dir, { tier: 'L3' });
  const f = byRule(r.findings, 'C1.no-license');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'medium');
  assert.equal(f[0].force, 'card');
  assert.match(f[0].snippet, /bare-lib@1\.2\.0/);
  assert.match(f[0].message, /license 字段缺失/);
});

test('C1：MIT 依赖不报 finding', async (t) => {
  const dir = await makeProject(t, {
    pkg: { name: 'demo', version: '1.0.0', license: 'MIT', dependencies: { 'mit-lib': '^1.0.0' } },
    installed: { 'mit-lib': { name: 'mit-lib', version: '1.0.0', license: 'MIT' } }
  });
  const r = await checkLicense(dir, { tier: 'L3' });
  assert.deepEqual(r.findings, []);
  assert.equal(r.coverageGap, null);
});

test('C1：无 node_modules → 依赖未安装 coverageGap，不冒充已检查', async (t) => {
  const dir = await makeProject(t, {
    pkg: { name: 'demo', version: '1.0.0', license: 'MIT', dependencies: { 'ghost-lib': '^1.0.0' } }
  });
  const r = await checkLicense(dir, { tier: 'L3' });
  assert.equal(r.coverageGap, 'C1：依赖未安装，许可证关未跑（npm ci 后可跑）');
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.warnings, []);
});

test('C1：项目自身缺 license → medium C1.project-no-license', async (t) => {
  const dir = await makeProject(t, {
    pkg: { name: 'demo', version: '1.0.0', dependencies: { 'mit-lib': '^1.0.0' } },
    installed: { 'mit-lib': { name: 'mit-lib', version: '1.0.0', license: 'MIT' } }
  });
  const r = await checkLicense(dir, { tier: 'L3' });
  const f = byRule(r.findings, 'C1.project-no-license');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'medium');
  assert.equal(f[0].force, 'card');
  assert.equal(f[0].file, 'package.json');
  assert.equal(f[0].snippet, '无 license 字段');
});

test('C1：同类问题超过 40 条 → 39 条明细 + C1.more 汇总，总数封顶 40', async (t) => {
  const deps = {};
  const installed = {};
  for (let i = 1; i <= 45; i++) {
    const name = `gpl-lib-${String(i).padStart(3, '0')}`;
    deps[name] = '^1.0.0';
    installed[name] = { name, version: '1.0.0', license: 'GPL-3.0-only' };
  }
  const dir = await makeProject(t, { pkg: { name: 'demo', version: '1.0.0', license: 'MIT', dependencies: deps }, installed });
  const r = await checkLicense(dir, { tier: 'L3' });
  assert.equal(r.findings.length, 40);
  assert.equal(byRule(r.findings, 'C1.copyleft').length, 39);
  const more = byRule(r.findings, 'C1.more');
  assert.equal(more.length, 1);
  assert.equal(more[0].severity, 'medium');
  assert.equal(more[0].force, 'card');
  assert.equal(more[0].snippet, '另有 6 个');
  assert.match(more[0].message, /共 45 项/);
});

test('C1：dependencies 与 devDependencies 同名依赖只报一次', async (t) => {
  const dir = await makeProject(t, {
    pkg: {
      name: 'demo', version: '1.0.0', license: 'MIT',
      dependencies: { 'agpl-lib': '^2.0.0' },
      devDependencies: { 'agpl-lib': '^2.0.0' }
    },
    installed: { 'agpl-lib': { name: 'agpl-lib', version: '2.1.0', license: 'AGPL-3.0-only' } }
  });
  const r = await checkLicense(dir, { tier: 'L3' });
  assert.equal(byRule(r.findings, 'C1.copyleft').length, 1);
});

test('C1：MIT OR Apache-2.0 按宽松许可处理，但记 warning', async (t) => {
  const dir = await makeProject(t, {
    pkg: { name: 'demo', version: '1.0.0', license: 'MIT', dependencies: { 'dual-lib': '^1.0.0' } },
    installed: { 'dual-lib': { name: 'dual-lib', version: '1.0.0', license: 'MIT OR Apache-2.0' } }
  });
  const r = await checkLicense(dir, { tier: 'L3' });
  assert.deepEqual(r.findings, []);
  assert.ok(r.warnings.some((w) => /较复杂/.test(w)));
});

test('C1：SEE LICENSE IN 指向的文件缺失 → medium C1.no-license', async (t) => {
  const dir = await makeProject(t, {
    pkg: { name: 'demo', version: '1.0.0', license: 'MIT', dependencies: { 'see-lib': '^1.0.0' } },
    installed: { 'see-lib': { name: 'see-lib', version: '1.0.0', license: 'SEE LICENSE IN LICENSE.txt' } }
  });
  const r = await checkLicense(dir, { tier: 'L3' });
  const f = byRule(r.findings, 'C1.no-license');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /文件不存在/);
});
