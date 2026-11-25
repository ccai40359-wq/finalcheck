// Windows ACL 沙箱接线。
//
// 2026-11-17 决策变更：**沙箱默认关闭**（统一走宿主机 Git Bash）。
// 理由与证据见 agent-tools.mjs 的 sandboxEnabled 注释：ACL 只防写不防读、
// 受限令牌下 Git Bash 起不来、且只覆盖 cmd 那一半命令。
//
// 所以本文件改成显式开启才测沙箱行为：在文件顶部设 FINALCHECK_ACL_SANDBOX=required。
// 沙箱能力本身仍然保留（给需要写保护的高保证场景），不该被删掉测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import agent-tools 之前设置：模块内的 sandboxEnabled() 每次调用都读 env，
// 但测试用具也要保证整个文件都在「显式开启」语义下，避免顺序依赖。
process.env.FINALCHECK_ACL_SANDBOX = 'on';

const { createAgentTools } = await import('../desktop/src/main/agent-tools.mjs');
const { createPolicy } = await import('../desktop/src/main/policy.mjs');
const { sandboxAvailability, sandboxCompatible } = await import('../desktop/src/main/sandbox.mjs');

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
    // 0.34.0：`del /f /q` 命中安全黑名单（del-force），黑名单**不可提问**，所以仍是 deniedBy:'policy'
    { name: 'cmd del', command: `del "${v1}"`, file: v1, expect: 'ask-unavailable' },
    { name: 'cmd del /f /q', command: `del /f /q "${v2}"`, file: v2, expect: 'policy' },
    { name: 'powershell Remove-Item', command: `powershell -NoProfile -Command "Remove-Item -LiteralPath '${v3}' -Force"`, file: v3, expect: 'ask-unavailable' }
  ];
  for (const c of cases) {
    const r = await tools.run_command({ command: c.command });
    assert.match(String(r.error || ''), /项目外|拒绝/, `${c.name} 应在应用层被拒：${JSON.stringify(r)}`);
    // 拒绝来源：黑名单类永远不可提问（policy）；越界类在本测试里没有 askUser 通道 → ask-unavailable。
    // 0.34.0 之前一律报 'policy'，把「问不了」和「黑名单」混成一个标签。
    assert.equal(r.deniedBy, c.expect, `${c.name} 拒绝来源应为 ${c.expect}`);
    assert.equal(fs.existsSync(c.file), true, `${c.name} 不应删掉项目外文件`);
  }
  const r4 = await tools.run_command({ command: `del "${inside}"` });
  assert.equal(r4.code, 0, r4.stderr || r4.error);
  assert.equal(fs.existsSync(inside), false, '项目内删除仍应允许');
});


test('sandbox: 命令读项目外文件已被路径闸拒绝（决策 3，2026-11-16 收紧）', { skip: !available && 'dsh ACL 沙箱不可用' }, async (t) => {
  // 契约变更：早先这里断言「读项目外仍然允许，只限制写/删」。
  // 决策 3 把边界收紧为「项目外一律不可读」，所以本测试现在断言**必须被拒绝**。
  // 注意：ACL 沙箱本身不做读隔离，拦住它的是应用层 checkCommandPaths。
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
  assert.notEqual(r.code, 0, '项目外路径必须被拒绝');
  assert.match(String(r.error || r.stderr || ''), /项目外/, '拒绝原因要说清是项目边界');
});

// 已知边界：Node 工具链不进沙箱（受限令牌下必然 EPERM），写项目外不会被 ACL 拦住，
// 只有应用层路径策略/审批兜底 —— 这条测试把边界钉住，避免文档说满。
test('沙箱默认关闭时 node 能正常跑（走宿主机 Git Bash）', async (t) => {
  // 2026-11-17 决策：沙箱默认关闭。原来的「sandbox BOUNDARY」测试证明了
  // node 在宿主机执行时 ACL 拦不住它的写入 —— 那正是关掉沙箱的依据之一
  // （沙箱只覆盖 cmd 那一半命令，真正能写盘的 node/npm/rm 本来就拦不住）。
  // 现在改成验证默认行为：node 能跑，且没有 sandbox 标记。
  // 注意：本文件顶部设了 FINALCHECK_ACL_SANDBOX=required，这里临时清掉以测默认态。
  const saved = process.env.FINALCHECK_ACL_SANDBOX;
  process.env.FINALCHECK_ACL_SANDBOX = '';
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-nosbx-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const tools = createAgentTools({
      repoRoot,
      projectPath: root,
      policy: createPolicy({ projectPath: root, mode: 'workspace' }),
      permissions: permissionsFor()
    });
    fs.writeFileSync(path.join(root, 'ok.mjs'), "console.log('NODE_OK');\n", 'utf8');
    const r = await tools.run_command({ command: 'node ok.mjs' });
    assert.equal(r.code, 0, r.stderr || r.error);
    assert.match(String(r.stdout || ''), /NODE_OK/, '默认态下 node 应能跑');
    assert.equal(r.sandbox ?? 'none', 'none', '默认不该有沙箱标记');
  } finally {
    process.env.FINALCHECK_ACL_SANDBOX = saved;
  }
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

// 2026-11-17：这些词在 cmd 里**存在但语义不同**，进去会得到静默错误的结果，
// 比「命令不存在」更危险（实测 FastAPI 会话里模型就写了 find/sort）。
// 必须改走宿主机 Git Bash，语义才对。
test('sandboxCompatible: cmd 里语义不同的 bash 工具必须走宿主机', () => {
  for (const cmd of [
    'find . -name "*.py"',
    'find . -type f -newer x',
    'sort -n x',
    'which python',
    'uname -a'
  ]) {
    assert.equal(sandboxCompatible(cmd).compatible, false,
      `${cmd} 在 cmd 下语义不对（find.exe 是文本查找、sort.exe 按字符排），必须走 bash`);
  }
  // 对照：真正的 cmd 原生命令仍应进沙箱（有写保护）
  assert.equal(sandboxCompatible('dir /b').compatible, true, 'dir 是 cmd 原生，仍进沙箱');
  assert.equal(sandboxCompatible('type x.txt').compatible, true, 'type 是 cmd 原生');
  assert.equal(sandboxCompatible('findstr /S x').compatible, true, 'findstr 是 cmd 原生（不是 find）');
});

test('sandbox(required): 不兼容命令直接拒绝，不改走宿主机（沙箱不能被绕过）', { skip: !available && 'dsh ACL 沙箱不可用' }, async (t) => {
  // 2026-11-17 契约变更：显式 required 时，不兼容命令**不许**静默改走宿主机——
  // 那等于用户要求了沙箱却被绕开。必须拒绝并说明原因。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-sbx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = createAgentTools({
    repoRoot,
    projectPath: root,
    policy: createPolicy({ projectPath: root, mode: 'workspace' }),
    permissions: permissionsFor()
  });
  const r = await tools.run_command({ command: 'node -v' });
  assert.notEqual(r.code, 0, 'required 模式下 node 不应被放行到宿主机');
  assert.match(String(r.error || ''), /沙箱不支持|FINALCHECK_ACL_SANDBOX=required/,
    '必须明确说明「沙箱不支持这条命令，已拒绝在宿主机执行」');
});

