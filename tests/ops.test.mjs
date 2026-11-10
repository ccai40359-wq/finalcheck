import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { checkOps } from '../src/checks/ops.mjs';

const byRule = (findings, rule) => findings.filter((f) => f.rule === rule);

async function makeProject(t, files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fc-o1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return dir;
}

test('O1：根 Dockerfile 缺 USER → high O1.docker-root', async (t) => {
  const dir = await makeProject(t, { 'Dockerfile': 'FROM node:20-alpine\nCMD ["node", "app.js"]\n' });
  const r = await checkOps(dir, { tier: 'L3' });
  assert.equal(r.checkId, 'O1');
  assert.equal(r.coverageGap, null);
  const f = byRule(r.findings, 'O1.docker-root');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'high');
  assert.equal(f[0].force, 'card');
  assert.equal(f[0].file, 'Dockerfile');
  assert.match(f[0].message, /root/);
});

test('O1：Dockerfile 非 root → 不报 O1.docker-root', async (t) => {
  const dir = await makeProject(t, { 'Dockerfile': 'FROM node:20-alpine\nUSER node\nCMD ["node", "app.js"]\n' });
  const r = await checkOps(dir, { tier: 'L3' });
  assert.deepEqual(byRule(r.findings, 'O1.docker-root'), []);
});

test('O1：最终阶段 USER root → high O1.docker-root（带行号）', async (t) => {
  const dir = await makeProject(t, { 'docker/Dockerfile': 'FROM alpine:3.20\nUSER root\nCMD ["sh"]\n' });
  const r = await checkOps(dir, { tier: 'L3' });
  const f = byRule(r.findings, 'O1.docker-root');
  assert.equal(f.length, 1);
  assert.equal(f[0].file, 'docker/Dockerfile');
  assert.equal(f[0].line, 2);
});

test('O1：FROM :latest → low O1.docker-latest', async (t) => {
  const dir = await makeProject(t, { 'Dockerfile': 'FROM node:latest\nUSER node\n' });
  const r = await checkOps(dir, { tier: 'L3' });
  const f = byRule(r.findings, 'O1.docker-latest');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'low');
  assert.equal(f[0].force, 'card'); // L3 计分
  assert.equal(f[0].line, 1);
  assert.deepEqual(byRule(r.findings, 'O1.docker-root'), []);
});

test('O1：完全没有 CI → medium O1.no-ci', async (t) => {
  const dir = await makeProject(t, { 'README.md': '# demo\n' });
  const r = await checkOps(dir, { tier: 'L3' });
  const f = byRule(r.findings, 'O1.no-ci');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'medium');
  assert.equal(f[0].force, 'card');
  assert.equal(f[0].file, '(仓库根)');
});

test('O1：CI 存在但没有测试步骤 → medium O1.ci-no-test', async (t) => {
  const dir = await makeProject(t, {
    '.github/workflows/ci.yml': [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm install',
      '      - run: node --version'
    ].join('\n')
  });
  const r = await checkOps(dir, { tier: 'L3' });
  const f = byRule(r.findings, 'O1.ci-no-test');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'medium');
  assert.equal(f[0].file, '.github/workflows/ci.yml');
  assert.match(f[0].snippet, /未发现测试步骤/);
});

test('O1：CI 含 npm test → 不报 O1.ci-no-test', async (t) => {
  const dir = await makeProject(t, {
    '.github/workflows/test.yml': 'steps:\n  - run: npm test\n'
  });
  const r = await checkOps(dir, { tier: 'L3' });
  assert.deepEqual(byRule(r.findings, 'O1.ci-no-test'), []);
  assert.deepEqual(byRule(r.findings, 'O1.no-ci'), []);
});

test('O1：迁移目录无 down/rollback → medium O1.migration-no-down', async (t) => {
  const dir = await makeProject(t, {
    'migrations/001_init.sql': 'CREATE TABLE users (id INTEGER PRIMARY KEY);\n'
  });
  const r = await checkOps(dir, { tier: 'L3' });
  const f = byRule(r.findings, 'O1.migration-no-down');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'medium');
  assert.equal(f[0].file, 'migrations');
});

test('O1：迁移文件名带 down → 不报 O1.migration-no-down', async (t) => {
  const dir = await makeProject(t, {
    'migrations/001_init.up.sql': 'CREATE TABLE users (id INTEGER PRIMARY KEY);\n',
    'migrations/001_init.down.sql': 'DROP TABLE users;\n'
  });
  const r = await checkOps(dir, { tier: 'L3' });
  assert.deepEqual(byRule(r.findings, 'O1.migration-no-down'), []);
});

test('O1：无迁移目录 → 不报 finding，只记 warning', async (t) => {
  const dir = await makeProject(t, { 'README.md': '# demo\n' });
  const r = await checkOps(dir, { tier: 'L3' });
  assert.deepEqual(byRule(r.findings, 'O1.migration-no-down'), []);
  assert.ok(r.warnings.some((w) => /migrations|db\/migrate/.test(w)));
});

test('O1：无备份/恢复 → low O1.no-backup（仅 L3 计分）', async (t) => {
  const dir = await makeProject(t, { 'README.md': '# demo\n' });
  const r = await checkOps(dir, { tier: 'L3' });
  const f = byRule(r.findings, 'O1.no-backup');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'low');
  assert.equal(f[0].force, 'card');
});

test('O1：存在 backup 脚本 → 不报 O1.no-backup', async (t) => {
  const dir = await makeProject(t, {
    'scripts/backup.sh': '#!/bin/sh\npg_dump "$DATABASE_URL" > /srv/backup/db.sql\n'
  });
  const r = await checkOps(dir, { tier: 'L3' });
  assert.deepEqual(byRule(r.findings, 'O1.no-backup'), []);
});

test('O1：L2 不产生 backup low finding（留 warning）', async (t) => {
  const dir = await makeProject(t, { 'README.md': '# demo\n' });
  const r = await checkOps(dir, { tier: 'L2' });
  assert.deepEqual(byRule(r.findings, 'O1.no-backup'), []);
  assert.ok(r.warnings.some((w) => /仅 L3 计分/.test(w)));
});
