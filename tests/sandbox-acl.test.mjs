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

