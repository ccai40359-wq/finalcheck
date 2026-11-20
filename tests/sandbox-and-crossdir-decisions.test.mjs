// 决策 1 + 决策 2 的回归测试（2026-11-17 用户拍板）。
//
// 决策 1：沙箱默认关闭，统一走宿主机 Git Bash（只留正则闸/黑名单/敏感路径）。
//         依据：ACL 只防写不防读、只覆盖 cmd 那半命令、bash 在受限令牌下起不来。
// 决策 2：默认允许跨目录（off 模式），记忆（AGENTS.md）跟**目录**走而不是跟会话走。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';
import { createPolicy, checkCommand, checkCommandPaths } from '../desktop/src/main/policy.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const perms = () => ({ requestApproval: async () => 'allowed-once', sessionAllowed: () => false });

function tmp(t, prefix = 'fc-dec-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/* ---------------- 决策 1：沙箱默认关闭，bash 生效 ---------------- */

test('决策1: 默认无沙箱，run_command 走 Git Bash（bash 语法可用）', async (t) => {
  const saved = process.env.FINALCHECK_ACL_SANDBOX;
  process.env.FINALCHECK_ACL_SANDBOX = '';
  t.after(() => { if (saved == null) delete process.env.FINALCHECK_ACL_SANDBOX; else process.env.FINALCHECK_ACL_SANDBOX = saved; });

  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n', 'utf8');
  const tools = createAgentTools({
    repoRoot, projectPath: dir,
    policy: createPolicy({ projectPath: dir, mode: 'off' }),
    permissions: perms(), recordAudit: async () => {}
  });
  // 这些全是 bash-only 写法：ls / wc -l / 2>/dev/null / &&
  const r = await tools.run_command({ command: 'ls -1 | wc -l && echo OK 2>/dev/null' });
  assert.equal(r.code, 0, r.stderr || r.error);
  assert.match(String(r.stdout || ''), /OK/, 'bash 语法必须能跑');
  assert.equal(r.sandbox ?? 'none', 'none', '默认不该有沙箱标记');
});

test('决策1: cmd 专有语法在 bash 下失败（证明真的换成了 bash）', async (t) => {
  const saved = process.env.FINALCHECK_ACL_SANDBOX;
  process.env.FINALCHECK_ACL_SANDBOX = '';
  t.after(() => { if (saved == null) delete process.env.FINALCHECK_ACL_SANDBOX; else process.env.FINALCHECK_ACL_SANDBOX = saved; });

  const dir = tmp(t);
  const tools = createAgentTools({
    repoRoot, projectPath: dir,
    policy: createPolicy({ projectPath: dir, mode: 'off' }),
    permissions: perms(), recordAudit: async () => {}
  });
  const r = await tools.run_command({ command: 'findstr /S hello .' });
  assert.notEqual(r.code, 0, 'bash 里没有 findstr，应该失败');
});

test('决策1: 敏感路径与灾难命令仍然拒绝（关沙箱不等于放弃底线）', () => {
  const p = createPolicy({ projectPath: 'D:/x', mode: 'off' });
  // 敏感路径
  for (const cmd of ['cat ~/.ssh/id_rsa', 'rm -rf ~/.aws', 'cat ~/.gnupg/secring.gpg']) {
    const r = checkCommandPaths(p, cmd, 'D:/x');
    assert.equal(r.ok, false, `${cmd} 必须拒`);
    assert.equal(r.matchedRule, 'sensitive-path', cmd);
  }
  // 灾难命令
  for (const cmd of ['rm -rf /', 'rm -Rf /', 'rm -r -f /', 'format C:', 'dd if=/dev/zero of=/dev/sda', 'mkfs.ext4 /dev/sda1']) {
    const r = checkCommand(p, cmd);
    assert.equal(r.ok, false, `${cmd} 必须拒`);
  }
});

test('决策1: 正常开发操作不被误伤（rm -rf 相对路径放行）', () => {
  const p = createPolicy({ projectPath: 'D:/x', mode: 'off' });
  for (const cmd of ['rm -rf ./node_modules', 'rm -rf dist', 'rm -rf src/old', 'rm file.txt']) {
    assert.equal(checkCommand(p, cmd).ok, true, `${cmd} 是正常开发操作，不该拦`);
  }
});

/* ---------------- 决策 2：跨目录 + 记忆跟目录走 ---------------- */

test('决策2: off 模式（新默认）可跨目录读写', async (t) => {
  const a = tmp(t, 'fc-decA-');
  const b = tmp(t, 'fc-decB-');
  fs.writeFileSync(path.join(b, 'bug.py'), 'def f():\n    return 1/0\n', 'utf8');
  const tools = createAgentTools({
    repoRoot, projectPath: a,
    policy: createPolicy({ projectPath: a, mode: 'off' }),
    permissions: perms(), recordAudit: async () => {}
  });

  const read = await tools.read_file({ path: path.join(b, 'bug.py') });
  assert.ok(!read.error, `跨目录读应放行: ${read.error}`);
  assert.match(String(read.content), /return 1\/0/);

  const edit = await tools.edit_file({
    path: path.join(b, 'bug.py'),
    old_string: '    return 1/0',
    new_string: '    return 1'
  });
  assert.ok(!edit.error, `跨目录写应放行: ${edit.error}`);
  assert.match(fs.readFileSync(path.join(b, 'bug.py'), 'utf8'), /return 1$/m);
});

test('决策2: workspace 模式仍保持项目边界（显式要边界时有效）', () => {
  // 2026-11-20 Linux 移植：原来写死 Windows 盘符路径 'C:/projA'。
  // 在 POSIX 上 'C:/projB/x.txt' 不是绝对路径（会被当相对路径解析），
  // 于是边界闸根本没触发 → 这条测试在 Linux 上假红。
  // 改用 path.join 构造当前平台的绝对路径（也避开反斜杠转义陷阱）。
  const onWin = process.platform === 'win32';
  const base = onWin ? path.win32.join('C:', 'fc') : '/tmp/fc-boundary';
  const root = path.join(base, 'projA');
  const outside = path.join(base, 'projB');
  const a = createPolicy({ projectPath: root, mode: 'workspace' });
  const cat = onWin ? 'type' : 'cat';
  const r = checkCommandPaths(a, `${cat} ${path.join(outside, 'x.txt')}`, root);
  assert.equal(r.ok, false, 'workspace 模式仍应拒绝项目外路径');
  assert.equal(r.matchedRule, 'path-outside');
});

test('决策2: 记忆跟目录走——remember_project 传 dir 时写那个项目', async (t) => {
  const a = tmp(t, 'fc-memA-');
  const b = tmp(t, 'fc-memB-');
  fs.writeFileSync(path.join(a, 'AGENTS.md'), '# A\n', 'utf8');
  fs.writeFileSync(path.join(b, 'AGENTS.md'), '# B\n', 'utf8');
  const tools = createAgentTools({
    repoRoot, projectPath: a,
    policy: createPolicy({ projectPath: a, mode: 'off' }),
    permissions: perms(), recordAudit: async () => {}
  });

  const r = await tools.remember_project({ fact: 'B 项目用 pytest 跑测试', dir: b });
  assert.equal(r.added, true);
  assert.equal(r.dir, path.resolve(b), '应写进 B');
  assert.match(fs.readFileSync(path.join(b, 'AGENTS.md'), 'utf8'), /pytest/, 'B 的记忆里有这条');
  assert.doesNotMatch(fs.readFileSync(path.join(a, 'AGENTS.md'), 'utf8'), /pytest/, 'A 的记忆不该被污染');
});

test('决策2: 不传 dir 时记忆仍写当前项目（旧调用方式不破）', async (t) => {
  const a = tmp(t, 'fc-memA2-');
  fs.writeFileSync(path.join(a, 'AGENTS.md'), '# A\n', 'utf8');
  const tools = createAgentTools({
    repoRoot, projectPath: a,
    policy: createPolicy({ projectPath: a, mode: 'off' }),
    permissions: perms(), recordAudit: async () => {}
  });
  const r = await tools.remember_project({ fact: 'A 项目统一走 Git Bash' });
  assert.equal(r.added, true);
  assert.equal(r.dir, path.resolve(a));
  assert.match(fs.readFileSync(path.join(a, 'AGENTS.md'), 'utf8'), /Git Bash/);
});
