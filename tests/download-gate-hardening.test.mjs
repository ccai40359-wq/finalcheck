import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanSinglePackage, inspectInstallCommand, parseInstallCommand } from '../src/download-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(here, '..', 'integrations', 'claude-code', 'download-gate.mjs');
const OLD = '2010-01-01T00:00:00.000Z';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function registryDoc(name, versions, latest = '1.0.0') {
  return {
    name,
    'dist-tags': { latest },
    time: { created: OLD },
    versions: Object.fromEntries(versions.map(([version, scripts]) => [version, { version, scripts, dependencies: {} }])),
  };
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = original; });
}

/* ---------- 版本化解析与缓存 ---------- */

test('scanSinglePackage resolves requested versions/ranges and caches successes per name@spec for 5 minutes', async (t) => {
  let metaCalls = 0;
  let dlCalls = 0;
  stubFetch(t, async (url) => {
    if (String(url).includes('api.npmjs.org/downloads')) {
      dlCalls += 1;
      return json({ downloads: 500000 });
    }
    metaCalls += 1;
    return json(registryDoc('fc-hard-versioned', [
      ['1.0.0', { postinstall: 'node install.js' }],
      ['1.2.0', {}],
      ['2.0.0', {}],
    ], '2.0.0'));
  });
  const exact = await scanSinglePackage('fc-hard-versioned@1.0.0');
  assert.ok(exact.findings.some((f) => f.rule === 'X1.lifecycle-script'));
  assert.equal(exact.coverageGap, null);
  const range = await scanSinglePackage('fc-hard-versioned@^1.0.0');
  assert.equal(range.findings.filter((f) => f.rule === 'X1.lifecycle-script').length, 0, '^1.0.0 resolves to 1.2.0, the version without postinstall');
  assert.equal(metaCalls, 2, 'different specs must not share a meta cache entry');
  const again = await scanSinglePackage('fc-hard-versioned@1.0.0');
  assert.equal(metaCalls, 2, 'successful registry lookup is cached');
  assert.ok(again.findings.some((f) => f.rule === 'X1.lifecycle-script'));
  assert.equal(dlCalls, 1, 'downloads are cached by package across version specs for the 5-minute window');
  await scanSinglePackage('fc-hard-versioned');
  assert.equal(metaCalls, 3, 'latest is its own name@spec cache entry');
});

test('registry failures are retried immediately instead of being cached as safe', async (t) => {
  let metaCalls = 0;
  stubFetch(t, async (url) => {
    if (String(url).includes('api.npmjs.org/downloads')) return json({ downloads: 1000 });
    metaCalls += 1;
    if (metaCalls === 1) return json({}, 503);
    return json(registryDoc('fc-hard-retry', [['1.0.0', { postinstall: 'echo evil' }]]));
  });
  const failed = await scanSinglePackage('fc-hard-retry@1.0.0');
  assert.ok(failed.coverageGap);
  assert.equal(failed.findings.filter((f) => f.rule === 'X1.lifecycle-script').length, 0);
  const recovered = await scanSinglePackage('fc-hard-retry@1.0.0');
  assert.equal(recovered.coverageGap, null);
  assert.ok(recovered.findings.some((f) => f.rule === 'X1.lifecycle-script'));
  assert.equal(metaCalls, 2, 'a failure must not become a cached safe result');
});

/* ---------- 下载量接口降级 ---------- */

test('downloads API failure/non-number is a warning, not a coverage gap, and X1 is still reported', async (t) => {
  let mode = '500';
  stubFetch(t, async (url) => {
    if (String(url).includes('api.npmjs.org/downloads')) {
      if (mode === '500') return json({ error: 'boom' }, 500);
      if (mode === 'html') return new Response('<html>bad gateway</html>', { status: 200 });
      return json({ downloads: '12' });
    }
    return json(registryDoc('fc-hard-dldown', [['1.0.0', { postinstall: 'node x.js' }]]));
  });
  for (mode of ['500', 'html', 'string']) {
    const r = await scanSinglePackage('fc-hard-dldown@1.0.0');
    assert.ok(r.findings.some((f) => f.rule === 'X1.lifecycle-script'), mode);
    assert.equal(r.coverageGap, null, mode);
    assert.ok(r.warnings.some((w) => w.includes('下载量未验证')), mode);
  }
});

test('npm ci and npm i keep coverageGap:null when only the downloads API fails', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-dl-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'dl-fail-project', dependencies: { 'fc-hard-clean': '^1.0.0' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'dl-fail-project' }, 'node_modules/fc-hard-clean': { version: '1.0.0' } },
  }));
  stubFetch(t, async (url) => String(url).includes('api.npmjs.org/downloads')
    ? json({ error: 'down' }, 500)
    : json(registryDoc('fc-hard-clean', [['1.0.0', {}]])));

  const ci = await inspectInstallCommand('npm ci', { cwd: root });
  assert.equal(ci.applicable, true);
  assert.equal(ci.coverageGap, null);
  assert.ok(ci.warnings.some((w) => w.includes('下载量未验证')));

  const install = await inspectInstallCommand('npm i fc-hard-clean@1.0.0', { cwd: root });
  assert.equal(install.applicable, true);
  assert.equal(install.coverageGap, null);
  assert.ok(install.warnings.some((w) => w.includes('下载量未验证')));
});

/* ---------- 安装命令前缀绕过 ---------- */

test('install inspection treats sudo/env/assignment/shell/time/nice/command prefixes as applicable with a gap', async () => {
  const seen = [];
  const projectCalls = [];
  const scanPackage = async (spec) => { seen.push(spec); return { findings: [], warnings: [], coverageGap: null }; };
  const scanProject = async (cwd) => { projectCalls.push(cwd); return { findings: [], warnings: [], coverageGap: null }; };
  const commands = [
    'sudo npm install foo',
    'sudo -E npm i foo',
    'env npm install foo',
    'FOO=1 npm install foo',
    'bash -c "npm install foo"',
    'sh -lc "npm install foo"',
    'cmd /c "npm install foo"',
    'cmd.exe /c "npm install foo"',
    'powershell -Command "npm install foo"',
    'pwsh -c "npm install foo"',
    'time npm install foo',
    'nice npm install foo',
    'command npm install foo',
    'timeout 5 npm install foo',
    'xargs npm install',
    'stdbuf -oL npm install foo',
    'exec npm install foo',
    'nohup npm install foo',
    'setsid npm install foo',
  ];
  for (const cmd of commands) {
    const r = await inspectInstallCommand(cmd, { cwd: '/project', scanPackage, scanProject });
    assert.equal(r.applicable, true, cmd);
    assert.ok(r.coverageGap, `${cmd} must expose a non-empty coverageGap (hook exit 2)`);
  }
  assert.ok(seen.length >= commands.length - 1, 'the underlying npm target is still scanned');
  assert.deepEqual([...new Set(seen)], ['foo']);
  assert.deepEqual(projectCalls, ['/project'], 'bare xargs npm install still scans the project');
});

test('non-install commands stay non-applicable (hook exit 0)', async () => {
  const scanPackage = async () => assert.fail('non-install command must not scan packages');
  const scanProject = async () => assert.fail('non-install command must not scan the project');
  for (const cmd of ['sudo apt install foo', 'bash -c ls', 'npm run test', 'timeout 5 ls', 'xargs echo', 'stdbuf -oL ls']) {
    const r = await inspectInstallCommand(cmd, { scanPackage, scanProject });
    assert.equal(r.applicable, false, cmd);
    assert.equal(r.coverageGap, null, cmd);
  }
});

test('parseInstallCommand keeps @version ranges for npm and scoped npx targets', () => {
  assert.deepEqual(parseInstallCommand('npm install foo@1.2.3 @scope/pkg@^2.0.0'), ['foo@1.2.3', '@scope/pkg@^2.0.0']);
  assert.deepEqual(parseInstallCommand('npx -p @scope/evil@1.0.0 run'), ['@scope/evil@1.0.0']);
  assert.deepEqual(parseInstallCommand('npm i a@latest && npx b@^2'), ['a@latest', 'b@^2']);
});

/* ---------- hook 进程退出码（用 preload 伪造 registry，避免真实网络） ---------- */

test('hook exit codes: clean ci 0, wrapped/postinstall/registry-failure 2, downloads-only 0, non-install 0', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-hook-smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'package.json'), JSON.stringify({
    name: 'hook-project', version: '1.0.0', dependencies: { 'fc-hook-clean': '^1.0.0' },
  }));
  await writeFile(path.join(project, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'hook-project', version: '1.0.0', dependencies: { 'fc-hook-clean': '^1.0.0' } },
      'node_modules/fc-hook-clean': { version: '1.0.0' },
    },
  }));

  const fixtures = {
    'fc-hook-postinstall': registryDoc('fc-hook-postinstall', [['1.0.0', { postinstall: 'node install.js' }]]),
    'fc-hook-clean': registryDoc('fc-hook-clean', [['1.0.0', {}]]),
  };
  const preloadPath = path.join(root, 'registry-preload.mjs');
  await writeFile(preloadPath, [
    `const FIXTURES = ${JSON.stringify(fixtures)};`,
    'globalThis.fetch = async (url) => {',
    '  const u = String(url);',
    "  if (u.includes('registry.npmjs.org/')) {",
    "    const name = decodeURIComponent(u.split('registry.npmjs.org/')[1] || '');",
    '    const doc = FIXTURES[name];',
    "    if (!doc) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });",
    "    return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/json' } });",
    '  }',
    "  if (u.includes('api.npmjs.org/downloads')) {",
    "    return new Response(JSON.stringify({ error: 'downloads down' }), { status: 500, headers: { 'content-type': 'application/json' } });",
    '  }',
    "  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });",
    '};',
  ].join('\n'));

  const run = (command, cwd = project) => spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, hook], {
    cwd,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });

  const cases = [
    ['npm ci', 0],
    ['npm install fc-hook-clean@1.0.0', 0],
    ['npm install fc-hook-postinstall@1.0.0', 2],
    ['sudo npm install fc-hook-postinstall@1.0.0', 2],
    ['sudo -E npm i fc-hook-postinstall@1.0.0', 2],
    ['env npm install fc-hook-postinstall@1.0.0', 2],
    ['FOO=1 npm install fc-hook-postinstall@1.0.0', 2],
    ['bash -c "npm install fc-hook-postinstall@1.0.0"', 2],
    ['sh -lc "npm install fc-hook-postinstall@1.0.0"', 2],
    ['cmd /c "npm install fc-hook-postinstall@1.0.0"', 2],
    ['cmd.exe /c "npm install fc-hook-postinstall@1.0.0"', 2],
    ['powershell -Command "npm install fc-hook-postinstall@1.0.0"', 2],
    ['pwsh -c "npm install fc-hook-postinstall@1.0.0"', 2],
    ['time npm install fc-hook-postinstall@1.0.0', 2],
    ['nice npm install fc-hook-postinstall@1.0.0', 2],
    ['command npm install fc-hook-postinstall@1.0.0', 2],
    ['timeout 5 npm install fc-hook-postinstall@1.0.0', 2],
    ['xargs npm install', 2],
    ['stdbuf -oL npm install fc-hook-postinstall@1.0.0', 2],
    ['exec npm install fc-hook-postinstall@1.0.0', 2],
    ['nohup npm install fc-hook-postinstall@1.0.0', 2],
    ['setsid npm install fc-hook-postinstall@1.0.0', 2],
    ['npm install fc-hook-offline@1.0.0', 2],
    ['sudo apt install foo', 0],
    ['bash -c ls', 0],
    ['npm run test', 0],
    ['timeout 5 ls', 0],
    ['xargs echo', 0],
    ['stdbuf -oL ls', 0],
  ];
  for (const [command, expected] of cases) {
    const result = run(command);
    assert.equal(result.status, expected, `${command}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
});
