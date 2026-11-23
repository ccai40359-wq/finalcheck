import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../desktop/scripts/check-package-hygiene.mjs', import.meta.url));
const manifestPath = 'resources/app/package.json';
const manifest = { name: 'finalcheck-desktop', version: '1.2.3-rc.1+fixture.1' };

function tempRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'fc-hygiene-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFixture(root, rel, contents = 'test fixture') {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function writePackageFixture(root) {
  writeFixture(root, 'FinalCheck.exe', 'MZ');
  writeFixture(root, manifestPath, JSON.stringify(manifest));
}

function check(root, ...args) {
  const result = spawnSync(process.execPath, [checker, ...args], { cwd: root, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

test('package hygiene gives the same result and path lengths from shallow and deep roots', (t) => {
  const root = tempRoot(t);
  const shallow = path.join(root, 'win-unpacked');
  const deep = path.join(root, 'build output'.repeat(6), 'artifact'.repeat(6), 'win-unpacked');
  const rel = 'resources/desktop/' + 'a'.repeat(105) + '.mjs';
  writePackageFixture(shallow);
  writePackageFixture(deep);
  writeFixture(shallow, rel);
  writeFixture(deep, rel);
  assert.ok(path.join(deep, rel).length > 200);

  const shallowResult = check(root, shallow);
  const deepResult = check(root, deep);
  assert.equal(shallowResult.status, 0, shallowResult.stderr);
  assert.equal(deepResult.status, 0, deepResult.stderr);
  assert.equal(deepResult.stdout.split('\n').slice(1).join('\n'),
    shallowResult.stdout.split('\n').slice(1).join('\n'));
});

test('package hygiene allows a 259-character install path and rejects 260', (t) => {
  const root = tempRoot(t);
  const prefix = 'resources/';
  const installRoot = 'C:\\Users\\ExampleUser\\AppData\\Local\\Programs\\FinalCheck';
  const budget = 259 - installRoot.length - 1;
  const atLimit = prefix + 'x'.repeat(budget - prefix.length);
  writePackageFixture(root);
  writeFixture(root, atLimit);

  const allowed = check(root, root);
  assert.equal(allowed.status, 0, allowed.stderr);

  writeFixture(root, atLimit + 'x');
  const rejected = check(root, root);
  assert.equal(rejected.status, 1);
  assert.ok(rejected.stderr.includes(`[路径过长 ${budget + 1}] ${atLimit}x`));
});

test('package hygiene rejects forbidden files and directories even when empty or differently cased', (t) => {
  const root = tempRoot(t);
  mkdirSync(path.join(root, 'resources/desktop/.mimosa'), { recursive: true });
  writeFixture(root, 'resources/.GIT');
  writeFixture(root, 'resources/desktop/Config.json');

  const result = check(root, root);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('[打包结构] FinalCheck.exe'), result.stderr);
  assert.ok(result.stderr.includes(`[打包结构] ${manifestPath}`), result.stderr);
  for (const rel of ['resources/desktop/.mimosa', 'resources/.GIT', 'resources/desktop/Config.json']) {
    assert.ok(result.stderr.includes(`[禁用] ${rel}`), result.stderr);
  }
});

test('package hygiene rejects empty and unrelated existing folders', (t) => {
  const root = tempRoot(t);
  const result = check(root, root);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('[打包结构] FinalCheck.exe'), result.stderr);
  assert.ok(result.stderr.includes(`[打包结构] ${manifestPath}`), result.stderr);

  mkdirSync(path.join(root, 'FinalCheck.exe'));
  writeFixture(root, manifestPath, JSON.stringify({ name: 'unrelated-app', version: '1.2.3' }));
  const unrelated = check(root, root);
  assert.equal(unrelated.status, 1);
  assert.ok(unrelated.stderr.includes('[打包结构] FinalCheck.exe'), unrelated.stderr);
  assert.ok(unrelated.stderr.includes(`[打包结构] ${manifestPath}`), unrelated.stderr);
});

test('package hygiene requires a nonempty executable and readable manifest version', (t) => {
  const root = tempRoot(t);
  writePackageFixture(root);
  writeFixture(root, 'FinalCheck.exe', '');
  const emptyExecutable = check(root, root);
  assert.equal(emptyExecutable.status, 1);
  assert.ok(emptyExecutable.stderr.includes('[打包结构] FinalCheck.exe'), emptyExecutable.stderr);

  writePackageFixture(root);
  for (const contents of ['', '{', JSON.stringify({ name: manifest.name }), JSON.stringify({ ...manifest, version: 'unknown' })]) {
    writeFixture(root, manifestPath, contents);
    const invalidManifest = check(root, root);
    assert.equal(invalidManifest.status, 1);
    assert.ok(invalidManifest.stderr.includes(`[打包结构] ${manifestPath}`), invalidManifest.stderr);
  }
});

test('package hygiene requires an existing directory argument', (t) => {
  const root = tempRoot(t);
  writeFixture(root, 'regular-file');
  for (const args of [[], [''], [root, 'extra']]) {
    const result = check(root, ...args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /用法/);
  }
  for (const rel of ['missing-directory', 'regular-file']) {
    const result = check(root, path.join(root, rel));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /无法检查打包目录/);
  }
});

/* ---------------- 2026-11-23：测试台不进 exe（用户拍板，长期约束） ----------------
 * 为什么这条要有测试：用户明确选择「测试台不进 exe，保持安装包干净」。
 * 那是产品决策，不是一时疏忽 —— 所以必须由检查器强制，而不是靠人记得。
 * 反例价值：一旦有人把 scripts/ 或 tests/ 加进 extraResources，构建能过、
 * 安装包也能装，只有这条检查会红。 */
test('package hygiene rejects the dev test bench inside resources/scripts', (t) => {
  const root = tempRoot(t);
  writePackageFixture(root);
  writeFixture(root, 'resources/scripts/testbench-rail-humanflow.mjs');
  const result = check(root, root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /开发测试台（testbench\/probe\/e2e）不该进安装包/, result.stderr);
});

test('package hygiene rejects unit tests inside resources/tests', (t) => {
  const root = tempRoot(t);
  writePackageFixture(root);
  writeFixture(root, 'resources/tests/browser-view-host.test.mjs');
  const result = check(root, root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /单元\/集成测试不该进安装包/, result.stderr);
});

test('package hygiene rejects probe and e2e scripts at any depth', (t) => {
  const root = tempRoot(t);
  writePackageFixture(root);
  writeFixture(root, 'resources/desktop/scripts/probe-three-issues.mjs');
  writeFixture(root, 'resources/app/e2e-ai-browser-turn.mjs');
  const result = check(root, root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /探针脚本不该进安装包/, result.stderr);
  assert.match(result.stderr, /端到端验收脚本不该进安装包/, result.stderr);
});

test('package hygiene still accepts a clean package (no test bench shipped)', (t) => {
  // 反例对照：干净包必须通过 —— 否则上面的规则会把正常构建也判红（"恒失败"的假检查）
  const root = tempRoot(t);
  writePackageFixture(root);
  writeFixture(root, 'resources/desktop/src/main/browser-view-host.mjs');
  writeFixture(root, 'resources/playbooks/index.json');
  const result = check(root, root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK：打包结构及路径符合要求/, result.stdout);
});
