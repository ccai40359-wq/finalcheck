// Windows ACL 沙箱接线：workspace-write 下能跑命令/写项目，写项目外被拒。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { createPolicy } from '../desktop/src/main/policy.mjs';
import { sandboxAvailability, sandboxCompatible } from '../desktop/src/main/sandbox.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const available = sandboxAvailability().available;

function permissionsFor() {
  return {
    requestApproval: async () => 'allowed-once',
    sessionAllowed: () => false,
    commandPrefix: (cmd) => String(cmd).split(/\s+/)[0]
  };
}

test('sandbox: workspace-write 沙箱能跑命令并写项目内', { skip: !available && 'dsh ACL 沙箱不可用' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = createAgentTools({
    repoRoot,
    projectPath: root,
    policy: createPolicy({ projectPath: root, mode: 'workspace' }),
    permissions: permissionsFor()
  });
  const ok = await tools.run_command({ command: 'echo sandbox-ok' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /sandbox-ok/);
  assert.equal(ok.sandbox, 'workspace-write');

  const inside = path.join(root, 'inside.txt');
  const r2 = await tools.run_command({ command: `echo x>${inside}` });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(fs.existsSync(inside), true);
});

test('sandbox: workspace-write 拒写项目外', { skip: !available && 'dsh ACL 沙箱不可用' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-'));
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-out-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outRoot, { recursive: true, force: true }));
  const outside = path.join(outRoot, 'outside.txt');
  const tools = createAgentTools({
    repoRoot,
    projectPath: root,
    policy: createPolicy({ projectPath: root, mode: 'workspace' }),
    permissions: permissionsFor()
  });
  const r = await tools.run_command({ command: `echo x>${outside}` });
  assert.notEqual(r.code, 0, '沙箱必须拒绝项目外写入');
  assert.equal(fs.existsSync(outside), false, '项目外文件不应出现');
});

// 同一张受限令牌由所有子进程继承：cmd、PowerShell、git、python 写项目外都必须被拒。
test('sandbox: cmd / PowerShell / git / python 都写不了项目外', { skip: !available && 'dsh ACL 沙箱不可用' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-'));
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-out-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outRoot, { recursive: true, force: true }));
  const tools = createAgentTools({
    repoRoot,
    projectPath: root,
    policy: createPolicy({ projectPath: root, mode: 'workspace' }),
    permissions: permissionsFor()
  });
  const cases = [
    { name: 'cmd', file: path.join(outRoot, 'cmd.txt'), command: `echo x>${path.join(outRoot, 'cmd.txt')}` },
    { name: 'powershell', file: path.join(outRoot, 'ps.txt'), command: `powershell -NoProfile -Command "Set-Content -LiteralPath '${path.join(outRoot, 'ps.txt')}' -Value x"` },
    { name: 'python', file: path.join(outRoot, 'py.txt'), command: `python -c "open(r'${path.join(outRoot, 'py.txt')}','w').write('x')"` },
    { name: 'git', file: path.join(outRoot, 'gitdir', 'HEAD'), command: `git init ${path.join(outRoot, 'gitdir')}` }
  ];
  for (const c of cases) {
    const r = await tools.run_command({ command: c.command });
    assert.notEqual(r.code, 0, `${c.name} 写项目外应被拒：${r.stderr || r.stdout}`);
    assert.equal(fs.existsSync(c.file), false, `${c.name} 不应在项目外留下 ${c.file}`);
  }
});

test('sandbox: 删除/改名项目外一律被拒（应用层兜 DELETE）', { skip: !available && 'dsh ACL 沙箱不可用' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-'));
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-out-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outRoot, { recursive: true, force: true }));
  const tools = createAgentTools({
    repoRoot,
    projectPath: root,
    policy: createPolicy({ projectPath: root, mode: 'workspace' }),
    permissions: permissionsFor()
  });
  const v1 = path.join(outRoot, 'v1.txt');
  const v2 = path.join(outRoot, 'v2.txt');
  const v3 = path.join(outRoot, 'v3.txt');
  const inside = path.join(root, 'inside.txt');
  for (const f of [v1, v2, v3, inside]) fs.writeFileSync(f, 'keep', 'utf8');
  const cases = [
    { name: 'cmd del', command: `del "${v1}"`, file: v1 },
    { name: 'cmd del /f /q', command: `del /f /q "${v2}"`, file: v2 },
    { name: 'powershell Remove-Item', command: `powershell -NoProfile -Command "Remove-Item -LiteralPath '${v3}' -Force"`, file: v3 }
  ];
  for (const c of cases) {
    const r = await tools.run_command({ command: c.command });
    assert.match(String(r.error || ''), /项目外|拒绝/, `${c.name} 应在应用层被拒：${JSON.stringify(r)}`);
    assert.equal(r.deniedBy, 'policy', `${c.name} 拒绝来源应为 policy`);
    assert.equal(fs.existsSync(c.file), true, `${c.name} 不应删掉项目外文件`);
  }
  const r4 = await tools.run_command({ command: `del "${inside}"` });
  assert.equal(r4.code, 0, r4.stderr || r4.error);
  assert.equal(fs.existsSync(inside), false, '项目内删除仍应允许');
});


test('sandbox: 读项目外仍然允许（只限制写/删）', { skip: !available && 'dsh ACL 沙箱不可用' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-'));
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-out-'));
  const readable = path.join(outRoot, 'read.txt');
  fs.writeFileSync(readable, 'readable', 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outRoot, { recursive: true, force: true }));
  const tools = createAgentTools({
    repoRoot,
    projectPath: root,
    policy: createPolicy({ projectPath: root, mode: 'workspace' }),
    permissions: permissionsFor()
  });
  const r = await tools.run_command({ command: `type "${readable}"` });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /readable/);
});

// 已知边界：Node 工具链不进沙箱（受限令牌下必然 EPERM），写项目外不会被 ACL 拦住，
// 只有应用层路径策略/审批兜底 —— 这条测试把边界钉住，避免文档说满。
test('sandbox BOUNDARY: node 命令在宿主机执行，ACL 拦不住它的写入', { skip: !available && 'dsh ACL 沙箱不可用' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-'));
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-out-'));
  const outside = path.join(outRoot, 'node-escape.txt');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outRoot, { recursive: true, force: true }));
  const tools = createAgentTools({
    repoRoot,
    projectPath: root,
    policy: createPolicy({ projectPath: root, mode: 'workspace' }),
    permissions: permissionsFor()
  });
  const escape = path.join(root, 'escape.mjs');
  fs.writeFileSync(escape, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(outside)}, 'x');\n`, 'utf8');
  const r = await tools.run_command({ command: 'node escape.mjs' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.sandbox, 'none');
  assert.equal(fs.existsSync(outside), true, '这是已知边界，不是 bug：node 在宿主机跑');
});

// 受限令牌跑不了「会捕获孙进程输出」的命令：实测 node --test / npm test 静默 EPERM，
// grep / cat / head 直接 CreateFileMapping fatal（Codex 的 Windows 沙箱同样 spawn EPERM）。
// 这些命令按兼容清单改在宿主机执行（路径策略、黑名单、审批仍生效），其余命令照常进沙箱。
test('sandboxCompatible: 按管道段判断兼容性', () => {
  assert.equal(sandboxCompatible('dir').compatible, true);
  assert.equal(sandboxCompatible('git status').compatible, true);
  assert.equal(sandboxCompatible('powershell -NoProfile -Command "Get-Content a.txt"').compatible, true);
  assert.equal(sandboxCompatible('npm test').compatible, false);
  assert.equal(sandboxCompatible('dir | grep x').compatible, false);
  assert.equal(sandboxCompatible('echo ok && node -v').compatible, false);
  assert.equal(sandboxCompatible('cmd /c "node -v"').compatible, true, 'cmd 外壳本身兼容（内部 node 无法静态判断）');
});

test('sandbox: 不兼容命令改在宿主机执行并标注原因', { skip: !available && 'dsh ACL 沙箱不可用' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = createAgentTools({
    repoRoot,
    projectPath: root,
    policy: createPolicy({ projectPath: root, mode: 'workspace' }),
    permissions: permissionsFor()
  });
  const r = await tools.run_command({ command: 'node -v' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.sandbox, 'none', 'node 不进沙箱');
  assert.match(String(r.sandboxSkip), /node/, '必须写明为什么没进沙箱');
});

