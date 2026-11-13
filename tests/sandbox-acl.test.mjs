// Windows ACL 沙箱接线：workspace-write 下能跑命令/写项目，写项目外被拒。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { createPolicy } from '../desktop/src/main/policy.mjs';
import { sandboxAvailability } from '../desktop/src/main/sandbox.mjs';

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
