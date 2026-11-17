// Windows behavior regressions. Uses the real Electron GUI-subsystem executable
// in Node mode for each sandbox runner, not a mock of child_process.spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createSandboxedRun, sandboxAvailability } from '../desktop/src/main/sandbox.mjs';
import { createAgentTools, runCommandWithSignal } from '../desktop/src/main/agent-tools.mjs';
import { createPolicy } from '../desktop/src/main/policy.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const electron = path.join(repoRoot, 'desktop/node_modules/electron/dist/electron.exe');
const available = process.platform === 'win32' && sandboxAvailability().available && fs.existsSync(electron);
const skip = !available && 'requires Windows ACL backend and real Electron executable';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function kill(pid) {
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-hidden-test-'));
  const root = path.join(parent, 'workspace');
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const sandbox = (command, policyMode = 'workspace') => {
    const sb = createSandboxedRun({ workspaceRoot: root, policyMode, command, cwd: root });
    sb.file = electron;
    t.after(() => sb.cleanup());
    return sb;
  };
  return { parent, root, sandbox };
}

test('console: real Electron hidden console preserves stdout, streaming, silence and ACL boundary', { skip }, async (t) => {
  const f = fixture(t);
  for (const [command, pattern] of [
    ['echo normal-output', /normal-output/],
    ['node -e "console.log(0);let i=1;const t=setInterval(()=>{console.log(i++);if(i===5)clearInterval(t)},250)"', /0[\s\S]*4/],
    ['node -e "setTimeout(()=>{},1000)"', /^$/]
  ]) {
    const r = await runCommandWithSignal(command, { sandbox: f.sandbox(command), idleMs: 3000 });
    if (r.background) t.after(() => kill(r.pid));
    assert.equal(r.code, 0, JSON.stringify(r));
    assert.match(r.stdout, pattern);
    assert.equal(r.background, undefined);
  }
  const nativeProbe = path.join(f.root, 'native-console.mjs');
  const koffiPath = createRequire(import.meta.url).resolve('koffi');
  fs.writeFileSync(nativeProbe, `import {createRequire} from 'node:module';
    const koffi=createRequire(import.meta.url)(${JSON.stringify(koffiPath)});
    const window=koffi.load('kernel32.dll').func('void * __stdcall GetConsoleWindow()')();
    const visible=koffi.load('user32.dll').func('int __stdcall IsWindowVisible(void *)')(window);
    console.log(JSON.stringify({attached:!!window,visible}));`);
  const probeCommand = `node "${nativeProbe}"`;
  const probe = await runCommandWithSignal(probeCommand, { sandbox: f.sandbox(probeCommand) });
  assert.equal(probe.code, 0, JSON.stringify(probe));
  assert.deepEqual(JSON.parse(probe.stdout), { attached: true, visible: 0 }, 'restricted grandchild must inherit a hidden real console');
  const inside = path.join(f.root, 'inside.txt');
  const outside = path.join(f.parent, 'outside.txt');
  const good = `echo allowed>"${inside}"`;
  assert.equal((await runCommandWithSignal(good, { sandbox: f.sandbox(good) })).code, 0);
  assert.match(fs.readFileSync(inside, 'utf8'), /allowed/);
  const bad = `echo denied>"${outside}"`;
  assert.notEqual((await runCommandWithSignal(bad, { sandbox: f.sandbox(bad) })).code, 0);
  assert.equal(fs.existsSync(outside), false, 'restricted child must not write outside workspace');
  const readonly = `echo denied>"${path.join(f.root, 'readonly.txt')}"`;
  assert.notEqual((await runCommandWithSignal(readonly, { sandbox: f.sandbox(readonly, 'readonly') })).code, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'readonly.txt')), false);
});

test('console: real Electron background and idle transition stay functional and cleanable', { skip }, async (t) => {
  const f = fixture(t);
  for (const background of [true, false]) {
    const marker = path.join(f.root, `service-${background}.txt`);
    const script = path.join(f.root, `service-${background}.mjs`);
    fs.writeFileSync(script, `import fs from 'node:fs';setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'alive'),1800);setTimeout(()=>{},30000);`);
    const command = `node "${script}"`;
    const sb = f.sandbox(command);
    const r = await runCommandWithSignal(command, { sandbox: sb, background, idleMs: 1000 });
    t.after(() => kill(r.pid));
    assert.equal(r.background, true, JSON.stringify(r));
    assert.ok(r.pid > 0);
    for (let n = 0; n < 60 && !fs.existsSync(marker); n++) await pause(100);
    assert.equal(fs.existsSync(marker), true, 'background command must keep doing work');
    kill(r.pid);
    for (let n = 0; n < 30 && fs.existsSync(sb.tempDir); n++) await pause(100);
    assert.equal(fs.existsSync(sb.tempDir), false, 'background cleanup runs after process close');
  }
});

test('console: cancellation and timeout kill restricted tree without rerunning command', { skip }, async (t) => {
  const f = fixture(t);
  for (const cancelled of [true, false]) {
    const marker = path.join(f.root, `after-${cancelled}.txt`);
    const started = path.join(f.root, `started-${cancelled}.txt`);
    const script = path.join(f.root, `cancel-${cancelled}.mjs`);
    fs.writeFileSync(script, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(started)},'once\\n');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'escaped'),3000);`);
    const command = `node "${script}"`;
    const sb = f.sandbox(command);
    const ctl = new AbortController();
    const options = cancelled ? { signal: ctl.signal } : { timeoutMs: 1500 };
    const timer = cancelled && setTimeout(() => ctl.abort(), 1500);
    const r = await runCommandWithSignal(command, { sandbox: sb, ...options });
    clearTimeout(timer);
    assert.equal(cancelled ? r.cancelled : r.code, cancelled ? true : 124, JSON.stringify(r));
    await pause(2300);
    assert.equal(fs.existsSync(marker), false, 'terminated descendants must not continue work');
    assert.equal(fs.readFileSync(started, 'utf8').trim().split(/\r?\n/).length, 1);
    assert.equal(fs.existsSync(sb.tempDir), false);
  }
});

test('console: DLL-init failure is returned once without visible/detached retry', { skip }, async (t) => {
  // 2026-11-17：沙箱默认关闭后，DLL 初始化失败这个场景只在显式 required 时存在
  // （受限令牌 + cmd 才可能撞上）。测试保留，但要显式开启沙箱。
  const previous = process.env.FINALCHECK_ACL_SANDBOX;
  process.env.FINALCHECK_ACL_SANDBOX = 'on';
  t.after(() => { if (previous == null) delete process.env.FINALCHECK_ACL_SANDBOX; else process.env.FINALCHECK_ACL_SANDBOX = previous; });

  const f = fixture(t);
  const marker = path.join(f.root, 'attempts.txt');
  const tools = createAgentTools({ repoRoot, projectPath: f.root,
    policy: createPolicy({ projectPath: f.root, mode: 'workspace' }),
    permissions: { requestApproval: async () => 'allowed-once' }
  });
  const r = await tools.run_command({ command: `echo once>>"${marker}" & exit /b -1073741502` });
  assert.ok([3221225794, -1073741502].includes(r.code), JSON.stringify(r));
  assert.equal(r.sandboxFailure, 'dll-init');
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).length, 1, 'must execute once');
});

test('console: required mode rejects incompatible command before any host execution', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-required-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.FINALCHECK_ACL_SANDBOX;
  process.env.FINALCHECK_ACL_SANDBOX = 'on';
  t.after(() => previous == null ? delete process.env.FINALCHECK_ACL_SANDBOX : process.env.FINALCHECK_ACL_SANDBOX = previous);
  fs.writeFileSync(path.join(root, 'attempt.mjs'), "import fs from 'node:fs';fs.writeFileSync('must-not-exist.txt','bad');");
  for (const mode of ['workspace', 'off']) {
    const tools = createAgentTools({ repoRoot, projectPath: root,
      policy: createPolicy({ projectPath: root, mode }),
      permissions: { requestApproval: async () => 'allowed-once' }
    });
    const r = await tools.run_command({ command: 'node attempt.mjs' });
    assert.equal(r.deniedBy, 'policy', JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(root, 'must-not-exist.txt')), false);
  }
});

test('console: wrapper rejects a launcher without SW_HIDE before starting vendor command', { skip }, async (t) => {
  const f = fixture(t);
  const marker = path.join(f.root, 'unsafe.txt');
  const sb = f.sandbox(`echo bad>"${marker}"`);
  // Electron is a GUI executable, so this does not itself allocate a console.
  const result = await new Promise((resolve) => {
    const child = spawn(sb.file, sb.args, { windowsHide: false, env: { ...process.env, ...sb.env }, stdio: 'pipe' });
    let err = '';
    child.stderr.on('data', (d) => err += d);
    child.on('close', (code) => resolve({ code, err }));
  });
  assert.equal(result.code, 127, result.err);
  assert.match(result.err, /STARTF_USESHOWWINDOW\/SW_HIDE/);
  assert.equal(fs.existsSync(marker), false);
});
