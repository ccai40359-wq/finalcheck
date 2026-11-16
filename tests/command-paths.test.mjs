// 决策 3 路径闸的单测（2026-11-16）：
//   checkCommandPaths —— 命令文本里的字面路径要过「敏感路径」与「项目边界」两道闸
//   isSensitivePath  —— 独立判定敏感路径（不依赖 assertPathAllowed 的模式分支）
//
// 背景：run_command 早先只验 cwd，命令正文里的路径完全没检查，
// 于是 `type C:\Users\x\.ssh\key` 与 `cd /d D:\other && type config.json` 都能过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy, isSensitivePath, checkCommandPaths } from '../desktop/src/main/policy.mjs';

const WIN_HOME = 'C:\\Users\\dev';
const WIN_ENV = { APPDATA: WIN_HOME + '\\AppData\\Roaming', USERPROFILE: WIN_HOME };

const win = (overrides = {}) => createPolicy({
  platform: 'win32',
  projectPath: 'C:\\proj',
  env: WIN_ENV,
  ...overrides
});

const offWin = (overrides = {}) => createPolicy({
  platform: 'win32',
  mode: 'off',
  env: WIN_ENV,
  ...overrides
});

// ---- 第 1 层：敏感路径 ----

test('路径闸: 读 ~/.ssh 下的私钥 → 无条件拒绝', () => {
  const p = win();
  const r = checkCommandPaths(p, 'type C:\\Users\\dev\\.ssh\\id_rsa', 'C:\\proj');
  assert.equal(r.ok, false, '必须拒绝');
  assert.equal(r.matchedRule, 'sensitive-path');
});

test('路径闸: 敏感私钥文件名（id_ed25519）在任何目录都拒', () => {
  const p = win();
  const r = checkCommandPaths(p, 'type C:\\proj\\id_ed25519', 'C:\\proj');
  assert.equal(r.ok, false, '私钥文件名本身即敏感，即便在项目内');
  assert.equal(r.matchedRule, 'sensitive-path');
});

test('路径闸: .aws / .gnupg / .git-credentials 都算敏感', () => {
  const p = win();
  for (const [cmd, expect] of [
    ['cat C:\\Users\\dev\\.aws\\credentials', true],
    ['cat C:\\Users\\dev\\.gnupg\\secring.gpg', true],
    ['cat C:\\Users\\dev\\.git-credentials', true]
  ]) {
    const r = checkCommandPaths(p, cmd, 'C:\\proj');
    assert.equal(r.ok === false, expect, `${cmd} 应拒绝`);
    if (expect) assert.equal(r.matchedRule, 'sensitive-path');
  }
});

test('路径闸: off 模式仍拒敏感路径（边界放开，敏感不放）', () => {
  const p = offWin();
  const r = checkCommandPaths(p, 'type C:\\Users\\dev\\.ssh\\id_rsa', 'C:\\proj');
  assert.equal(r.ok, false);
  assert.equal(r.matchedRule, 'sensitive-path');
});

// ---- 第 2 层：项目边界 ----

test('路径闸: 命令引用项目外路径 → 拒绝', () => {
  const p = win();
  const r = checkCommandPaths(p, 'type D:\\other-project\\config.json', 'C:\\proj');
  assert.equal(r.ok, false);
  assert.equal(r.matchedRule, 'path-outside');
});

test('路径闸: cd 到项目外再读文件 → 拒绝（整条命令）', () => {
  const p = win();
  const r = checkCommandPaths(p, 'cd /d D:\\elsewhere && type package.json', 'C:\\proj');
  assert.equal(r.ok, false, '命令里出现项目外路径，整条拒绝');
  assert.equal(r.matchedRule, 'path-outside');
});

test('路径闸: 项目内路径放行', () => {
  const p = win();
  assert.equal(checkCommandPaths(p, 'type C:\\proj\\package.json', 'C:\\proj').ok, true);
  assert.equal(checkCommandPaths(p, 'node C:\\proj\\server.mjs', 'C:\\proj').ok, true);
});

test('路径闸: 相对路径按 cwd 解析（项目内的放行）', () => {
  const p = win();
  assert.equal(checkCommandPaths(p, 'type package.json', 'C:\\proj').ok, true);
  assert.equal(checkCommandPaths(p, 'type .\\src\\a.js', 'C:\\proj').ok, true);
});

test('路径闸: off 模式放行项目外路径（但仍做敏感检查）', () => {
  const p = offWin();
  assert.equal(checkCommandPaths(p, 'type D:\\other\\x.txt', 'C:\\proj').ok, true, 'off 放开边界');
});

// ---- 嵌套壳 ----

test('路径闸: powershell -command "..." 里的路径也要查', () => {
  const p = win();
  const r = checkCommandPaths(p, 'powershell -NoProfile -Command "type C:\\Users\\dev\\.ssh\\id_rsa"', 'C:\\proj');
  assert.equal(r.ok, false);
  assert.equal(r.matchedRule, 'sensitive-path');
});

test('路径闸: bash -c "..." 里的路径也要查', () => {
  const p = win();
  const r = checkCommandPaths(p, 'bash -c "cat C:\\Users\\dev\\.ssh\\id_rsa"', 'C:\\proj');
  assert.equal(r.ok, false);
  assert.equal(r.matchedRule, 'sensitive-path');
});

// ---- 不误伤 ----

test('路径闸: 纯命令与参数不误判（无路径分隔符）', () => {
  const p = win();
  for (const cmd of ['node --version', 'npm test', 'git status', 'dir /b', 'curl -s http://127.0.0.1:8787/healthz']) {
    assert.equal(checkCommandPaths(p, cmd, 'C:\\proj').ok, true, `${cmd} 不该被拦`);
  }
});

test('路径闸: 含 %VAR% 或通配符的路径不猜（交给黑名单与审批）', () => {
  const p = win();
  assert.equal(checkCommandPaths(p, 'type %USERPROFILE%\\x.txt', 'C:\\proj').ok, true);
  assert.equal(checkCommandPaths(p, 'dir C:\\proj\\*.js', 'C:\\proj').ok, true);
});

test('路径闸: 空命令 / 缺 policy 安全返回', () => {
  assert.deepEqual(checkCommandPaths(win(), '', 'C:\\proj'), { ok: true });
  assert.deepEqual(checkCommandPaths(null, 'type x', null), { ok: true });
  assert.deepEqual(checkCommandPaths(win(), null, null), { ok: true });
});

// ---- isSensitivePath 独立可用 ----

test('isSensitivePath: 敏感目录返回原因，普通文件返回 null', () => {
  const p = win();
  assert.ok(isSensitivePath(p, 'C:\\Users\\dev\\.ssh\\id_rsa'), 'ssh 私钥应命中');
  assert.equal(isSensitivePath(p, 'C:\\proj\\package.json'), null, '普通文件不该命中');
  assert.equal(isSensitivePath(p, 'C:\\proj\\src\\policy.mjs'), null);
  assert.equal(isSensitivePath(null, 'x'), null, '缺 policy 不崩');
  assert.equal(isSensitivePath(p, ''), null, '空路径不崩');
});
