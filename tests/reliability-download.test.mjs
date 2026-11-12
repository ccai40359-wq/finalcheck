import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanDownload, scanSinglePackage, parseInstallCommand, inspectInstallCommand } from '../src/download-gate.mjs';

test('download gate checks requested and locked versions, not latest, with separate version caches', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-versioned-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).includes('downloads/point') ? { downloads: 100000 } : {
    name: 'fc-review-versioned', 'dist-tags': { latest: '2.0.0' }, time: { created: '2010-01-01' },
    versions: { '1.0.0': { version: '1.0.0', scripts: { postinstall: 'echo old' } }, '1.1.0': { version: '1.1.0', scripts: {} }, '2.0.0': { version: '2.0.0', scripts: {} } },
  }), { status: 200 });
  t.after(() => { globalThis.fetch = original; });
  assert.ok((await scanSinglePackage('fc-review-versioned@1.0.0')).findings.some((f) => f.rule === 'X1.lifecycle-script'));
  assert.equal((await scanSinglePackage('fc-review-versioned@2.0.0')).findings.filter((f) => f.rule === 'X1.lifecycle-script').length, 0);
  assert.equal((await scanSinglePackage('fc-review-versioned@^1.0.0')).findings.filter((f) => f.rule === 'X1.lifecycle-script').length, 0);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'version-root', dependencies: { 'fc-review-versioned': '^1.0.0' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/fc-review-versioned': { version: '1.0.0' } } }));
  const locked = await scanDownload(root);
  assert.ok(locked.findings.some((f) => f.rule === 'X1.lifecycle-script' && f.snippet.includes('@1.0.0')));
  assert.deepEqual(parseInstallCommand('npm install fc-review-versioned@1.0.0'), ['fc-review-versioned@1.0.0']);
  const missing = await scanSinglePackage('fc-review-versioned@9.0.0');
  assert.ok(missing.coverageGap);
});

test('registry failure is an explicit coverage gap and is not permanently cached as safe', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try { assert.ok((await scanSinglePackage('fc-review-offline')).coverageGap); }
  finally { globalThis.fetch = original; }
});

test('install inspection checks project installs and retains unsupported/offline states', async () => {
  const calls = [];
  const scanProject = async (cwd) => { calls.push(cwd); return { findings: [], warnings: [], coverageGap: null }; };
  const scanPackage = async (spec) => ({ findings: [], warnings: [], coverageGap: spec.endsWith('@1') ? 'offline' : null });
  assert.equal((await inspectInstallCommand('git status')).applicable, false);
  assert.equal((await inspectInstallCommand('npm ci', { cwd: '/project', scanProject })).coverageGap, null);
  assert.deepEqual(calls, ['/project']);
  assert.equal((await inspectInstallCommand('npm i foo@1', { scanPackage })).coverageGap, 'offline');
  for (const cmd of ['npm i user/repo', 'npm i https://example.com/a.tgz', 'cd other && npm ci', 'npm --prefix other i foo', 'npm i --registry https://example.com foo', 'pnpm add foo']) {
    assert.ok((await inspectInstallCommand(cmd, { scanPackage, scanProject })).coverageGap, cmd);
  }
});
