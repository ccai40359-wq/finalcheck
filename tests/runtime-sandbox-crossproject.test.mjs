// 规格《FC-运行环境与跨项目账本》验收测试（2026-11-17）。
// 覆盖 §6.1 三道闸 / §6.2 单轨 shell / §6.3 文件名 / §6.4 跨项目。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPolicy, checkCommandPaths, checkDestructiveTargets, checkFileName
} from '../desktop/src/main/policy.mjs';
import { extractAbsolutePaths, resolveCrossProjects, ledgerFor } from '../desktop/src/main/cross-project.mjs';
import { sandboxEnabled } from '../desktop/src/main/agent-tools.mjs';

function tmp(t, p = 'fc-spec-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/* ---- §6.1 三道闸：aclSandbox=false（默认）时全部仍在 ---- */

test('§6.1 闸①: 敏感路径无条件拒（默认关沙箱时）', () => {
  const p = createPolicy({ projectPath: 'D:/proj', mode: 'workspace' });
  for (const cmd of ['cat ~/.ssh/id_ed25519', 'cat ~/.aws/credentials', 'cat ~/.gnupg/secring.gpg']) {
    const r = checkCommandPaths(p, cmd, 'D:/proj');
    assert.equal(r.ok, false, `${cmd} 必须拒`);
    assert.equal(r.matchedRule, 'sensitive-path');
  }
});

test('§6.1 闸②: 项目边界仍生效（默认 workspace，不是 off）', () => {
  const p = createPolicy({ projectPath: 'D:/projA', mode: 'workspace' });
  const r = checkCommandPaths(p, 'cat D:/projB/x.txt', 'D:/projA');
  assert.equal(r.ok, false);
  assert.equal(r.matchedRule, 'path-outside');
});

test('§6.1 闸③: 删除目标在 off 模式也拒（不再被 mode 短路）', (t) => {
  const A = tmp(t, 'fc-gA-');
  const B = tmp(t, 'fc-gB-');
  fs.writeFileSync(path.join(B, 'x.txt'), 'x', 'utf8');
  // 关键：mode='off' —— 旧实现这里会直接 return {ok:true}
  const p = createPolicy({ projectPath: A, mode: 'off' });
  for (const cmd of [`del "${path.join(B, 'x.txt')}"`, `rm "${path.join(B, 'x.txt')}"`]) {
    const r = checkDestructiveTargets(p, cmd, A);
    assert.equal(r.ok, false, `${cmd} 在 off 模式下也必须拒`);
  }
});

test('§6.1 闸③: rm/unlink/shred 都被识别为删除命令（沙箱关后 rm 是主要手段）', (t) => {
  const A = tmp(t, 'fc-rmA-');
  const B = tmp(t, 'fc-rmB-');
  fs.writeFileSync(path.join(B, 'x.txt'), 'x', 'utf8');
  const p = createPolicy({ projectPath: A, mode: 'workspace' });
  for (const cmd of [`rm "${path.join(B, 'x.txt')}"`, `unlink "${path.join(B, 'x.txt')}"`]) {
    const r = checkDestructiveTargets(p, cmd, A);
    assert.equal(r.ok, false, `${cmd} 必须拒`);
  }
  // 项目内删除仍放行
  fs.writeFileSync(path.join(A, 'a.txt'), 'x', 'utf8');
  assert.equal(checkDestructiveTargets(p, `rm "${path.join(A, 'a.txt')}"`, A).ok, true);
});

test('§6.1: 跨项目授权后 B 变成可删（allowPaths 合并进 roots）', (t) => {
  const A = tmp(t, 'fc-okA-');
  const B = tmp(t, 'fc-okB-');
  fs.writeFileSync(path.join(B, 'x.txt'), 'x', 'utf8');
  const p = createPolicy({ projectPath: A, mode: 'workspace', allowPaths: [B] });
  assert.equal(checkDestructiveTargets(p, `rm "${path.join(B, 'x.txt')}"`, A).ok, true,
    '授权后应允许');
  // 未授权的第三方仍拒
  const C = tmp(t, 'fc-okC-');
  fs.writeFileSync(path.join(C, 'c.txt'), 'x', 'utf8');
  assert.equal(checkDestructiveTargets(p, `rm "${path.join(C, 'c.txt')}"`, A).ok, false);
});

/* ---- 开关拆分：aclSandbox 独立于 policy.mode ---- */

test('开关拆分: aclSandbox 默认关（env 未设时）', () => {
  const saved = process.env.FINALCHECK_ACL_SANDBOX;
  delete process.env.FINALCHECK_ACL_SANDBOX;
  try {
    assert.equal(sandboxEnabled(), false);
    assert.equal(sandboxEnabled({ aclSandbox: true }), true, '显式 true 优先');
    assert.equal(sandboxEnabled({ aclSandbox: false }), false, '显式 false 优先');
  } finally {
    if (saved != null) process.env.FINALCHECK_ACL_SANDBOX = saved;
  }
});

test('开关拆分: env FINALCHECK_ACL_SANDBOX=on 可开启', () => {
  const saved = process.env.FINALCHECK_ACL_SANDBOX;
  process.env.FINALCHECK_ACL_SANDBOX = 'on';
  try {
    assert.equal(sandboxEnabled(), true);
  } finally {
    if (saved == null) delete process.env.FINALCHECK_ACL_SANDBOX; else process.env.FINALCHECK_ACL_SANDBOX = saved;
  }
});

/* ---- §6.3 文件名校验 ---- */

test('§6.3: 代码片段当文件名 → 拒绝（D:\\finalcheck 垃圾文件的根因）', () => {
  for (const bad of ['ids.indexOf(v)!', 'x[1])', 'a.b.slice(0)', 'foo[0]']) {
    const r = checkFileName(bad);
    assert.equal(r.ok, false, `${bad} 必须拒`);
    assert.equal(r.matchedRule, 'filename-code-fragment');
  }
});

test('§6.3: 正常文件名放行', () => {
  for (const good of ['normal-file.txt', 'index.html', 'src/foo.ts', 'README.md', 'a-b_c.json']) {
    assert.equal(checkFileName(good).ok, true, `${good} 应放行`);
  }
});

test('§6.3: Windows 非法字符与保留名拒绝', () => {
  assert.equal(checkFileName('x<y>.txt').ok, false);
  assert.equal(checkFileName('a|b.txt').ok, false);
  assert.equal(checkFileName('CON').ok, false);
  assert.equal(checkFileName('NUL.txt').ok, false);
});

/* ---- §6.4 跨项目授权 ---- */

test('§6.4: 用户本轮提到的目录 → user-mentioned', () => {
  const r = resolveCrossProjects({
    userMessage: String.raw`去改 D:\projectB 里的 bug`,
    currentRoot: 'D:/projA',
    registeredProjects: []
  });
  assert.equal(r.allowed.length, 1);
  assert.equal(r.allowed[0].reason, 'user-mentioned');
});

test('§6.4: 已登记项目 → registered', () => {
  const r = resolveCrossProjects({
    userMessage: String.raw`去改 D:\projectB 里的 bug`,
    currentRoot: 'D:/projA',
    registeredProjects: [{ path: 'D:/projectB', name: 'B' }]
  });
  assert.equal(r.allowed[0].reason, 'registered');
  assert.equal(r.allowed[0].name, 'B');
});

test('§6.4: 用户没提其他目录 → 零授权（默认拒绝是特性）', () => {
  const r = resolveCrossProjects({ userMessage: '帮我看看这个项目', currentRoot: 'D:/projA', registeredProjects: [] });
  assert.equal(r.allowed.length, 0);
});

test('§6.4: 提到当前项目自己 → 不算跨项目', () => {
  const r = resolveCrossProjects({
    userMessage: String.raw`改 D:\projA\src\x.ts`,
    currentRoot: 'D:/projA',
    registeredProjects: []
  });
  assert.equal(r.allowed.length, 0);
});

test('§6.4: 账本按被写文件所属项目路由，跨项目时标交叉引用', (t) => {
  const A = tmp(t, 'fc-lgA-');
  const B = tmp(t, 'fc-lgB-');
  const a = ledgerFor({ absFilePath: path.join(A, 'x.ts'), currentRoot: A, extraRoots: [] });
  assert.equal(a.ledger, path.join(A, '.finalcheck', 'ledger.md'));
  assert.equal(a.crossRef, false);
  const b = ledgerFor({ absFilePath: path.join(B, 'y.md'), currentRoot: A, extraRoots: [B] });
  assert.equal(b.ledger, path.join(B, '.finalcheck', 'ledger.md'));
  assert.equal(b.crossRef, true, 'A 的账本要留交叉引用');
});

test('§6.4: 未授权目录的账本为 null（不猜归属）', (t) => {
  const A = tmp(t, 'fc-lgA2-');
  const r = ledgerFor({ absFilePath: 'D:/projC/z.ts', currentRoot: A, extraRoots: [] });
  assert.equal(r, null);
});

test('§6.4: 路径抽取支持反斜杠/正斜杠/~', () => {
  assert.deepEqual(extractAbsolutePaths(String.raw`去改 D:\projectB 里的 bug`), [String.raw`D:\projectB`]);
  assert.deepEqual(extractAbsolutePaths('把 D:/other 的 README 更新'), ['D:/other']);
  assert.equal(extractAbsolutePaths('没有路径').length, 0);
});
