import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { audit } from '../src/audit.mjs';
import { createPolicy, assertPathAllowed, checkCommand } from '../desktop/src/main/policy.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { grantOnce, consumeGrant, sessionAllowed as scopedSessionAllowed, resetLedger } from '../desktop/src/main/permissions.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const permissions = { requestApproval: async () => 'allowed-once', sessionAllowed: () => false };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-reliability-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('default audit remains static and records tests as pending authorization', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'safe-default', scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'unexpected\')"' } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  const result = await audit(root, { tier: 'L2' });
  assert.equal(await readFile(path.join(root, 'ran.txt'), 'utf8').catch(() => null), null);
  assert.ok(result.gates.gapItems.some((g) => g.checkId === 'Q1' && g.kind === 'unauthorized'));
});

test('readonly policy refuses arbitrary commands before approval or execution', async (t) => {
  const root = await fixture(t);
  const policy = createPolicy({ projectPath: root, mode: 'readonly' });
  assert.equal(checkCommand(policy, 'echo hello').ok, false);
  const tools = createAgentTools({ repoRoot, projectPath: root, policy, permissions });
  const result = await tools.run_command({ command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'unexpected\')"' });
  assert.equal(result.deniedBy, 'policy');
  assert.equal(await readFile(path.join(root, 'ran.txt'), 'utf8').catch(() => null), null);
  await writeFile(path.join(root, 'finalcheck.quality.json'), JSON.stringify({ checks: [{ id: 'unsafe', command: 'echo unsafe' }] }));
  assert.equal((await tools.quality_gate({ dir: root })).deniedBy, 'policy');
  assert.equal((await tools.remember_project({ fact: 'must not write' })).deniedBy, 'policy');
});

test('junction cannot read or create a file outside the actual project root', async (t) => {
  const root = await fixture(t);
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  await mkdir(project); await mkdir(outside);
  await writeFile(path.join(outside, 'marker.txt'), 'outside project');
  await symlink(outside, path.join(project, 'bridge'), process.platform === 'win32' ? 'junction' : 'dir');
  const policy = createPolicy({ projectPath: project });
  const tools = createAgentTools({ repoRoot, projectPath: project, policy, permissions });
  assert.equal(assertPathAllowed(policy, path.join(project, 'bridge/marker.txt')).ok, false);
  assert.equal(assertPathAllowed(policy, path.join(project, 'bridge/new.txt'), { write: true }).ok, false);
  assert.equal((await tools.read_file({ path: path.join(project, 'bridge/marker.txt') })).deniedBy, 'policy');
});

test('quality commands cannot select a directory outside the project', async (t) => {
  const root = await fixture(t);
  const project = path.join(root, 'project'); const outside = path.join(root, 'outside');
  await mkdir(project); await mkdir(outside);
  const tools = createAgentTools({ repoRoot, projectPath: project, policy: createPolicy({ projectPath: project }), permissions });
  assert.equal((await tools.quality_gate({ dir: outside })).deniedBy, 'policy');
});

test('quality gate applies the command deny rules and executes the approved config snapshot', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'finalcheck.quality.json');
  const policy = createPolicy({ projectPath: root });
  await writeFile(file, JSON.stringify({ checks: [{ id: 'blocked', command: 'echo rm -rf /' }] }));
  const tools = createAgentTools({ repoRoot, projectPath: root, policy, permissions });
  assert.equal((await tools.quality_gate({ dir: root })).deniedBy, 'policy');
  const config = { checks: [{ id: 'ok', command: 'node -e "require(\'fs\').writeFileSync(\'approved.txt\',\'ok\')"' }] };
  await writeFile(file, JSON.stringify(config));
  const changingPermissions = { ...permissions, requestApproval: async () => {
    await writeFile(file, JSON.stringify({ checks: [{ id: 'changed', command: 'node -e "require(\'fs\').writeFileSync(\'changed.txt\',\'unexpected\')"' }] }));
    return 'allowed-once';
  } };
  const approved = createAgentTools({ repoRoot, projectPath: root, policy, permissions: changingPermissions });
  const result = await approved.quality_gate({ dir: root });
  assert.ok(!result.error, JSON.stringify(result));
  assert.equal(await readFile(path.join(root, 'approved.txt'), 'utf8'), 'ok');
  assert.equal(await readFile(path.join(root, 'changed.txt'), 'utf8').catch(() => null), null);
});

test('quality gate cannot bypass fingerprint approval with a directory-only grant', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'finalcheck.quality.json');
  const marker = path.join(root, 'ran.txt');
  await writeFile(file, JSON.stringify({ checks: [{ id: 'bypass', command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'unexpected\')"' }] }));
  const projectPath = root;
  const scope = { sessionId: null, projectPath };
  resetLedger();
  t.after(() => resetLedger());
  grantOnce('quality_gate', path.resolve(root), scope);
  const approvals = [];
  const gatedPermissions = {
    requestApproval: async (payload) => { approvals.push(payload); return 'rejected'; },
    sessionAllowed: (tool, target, s) => scopedSessionAllowed(tool, target, s),
    consumeGrant: (tool, target, s) => consumeGrant(tool, target, s)
  };
  const tools = createAgentTools({ repoRoot, projectPath, policy: createPolicy({ projectPath }), permissions: gatedPermissions });
  const result = await tools.quality_gate({ dir: root });
  assert.equal(result.error, '用户拒绝了质量闸执行');
  assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
  assert.equal(approvals.length, 1, '目录免批券不得跳过指纹审批');
  assert.equal(approvals[0].tool, 'quality_gate');
  assert.ok(approvals[0].target.includes('#'), '审批目标应带配置指纹');
  assert.match(approvals[0].summary, /ran\.txt/, '审批摘要应包含实际命令');
});
