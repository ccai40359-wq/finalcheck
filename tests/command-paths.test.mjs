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

test('路径闸: 通配符与无法静态展开的变量不猜（交给黑名单与审批）', () => {
  const p = win();
  // `%USERPROFILE%` 是本机家目录，能静态展开 → 展开后判定。
  // 2026-11-16 收紧：项目外的家目录路径要拒，否则 `type %USERPROFILE%\x.txt`
  // 等于绕过项目边界（以前放行是因为没有展开机制）。
  assert.equal(checkCommandPaths(p, 'type %USERPROFILE%\\x.txt', 'C:\\proj').ok, false,
    '%USERPROFILE% 现在会展开并过边界闸（收紧，不是放松）');
  // 通配符仍然不猜（无法确定实际匹配到哪些文件）
  assert.equal(checkCommandPaths(p, 'dir C:\\proj\\*.js', 'C:\\proj').ok, true);
  // 非家目录的未知变量也不猜
  assert.equal(checkCommandPaths(p, 'type %SOME_OTHER_VAR%\\x.txt', 'C:\\proj').ok, true);
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

// ---- 家目录写法（~ / $HOME / %USERPROFILE%）----
// 2026-11-16：宿主机 shell 从 cmd 换成 Git Bash 之后暴露的漏洞。
// cmd 里 `~` 不展开所以无害；bash 里 `~` 会真展开成 /c/Users/x，
// 于是 `rm -rf ~/.ssh`、`cat ~/.ssh/id_rsa` 以前全部被放行（实测）。
// 修法是字面量提取阶段就认出这几种写法，展开成绝对路径再过敏感/边界闸。

test('路径闸: ~/.ssh 必须拒绝（bash 会展开波浪号）', () => {
  const r = checkCommandPaths(win(), 'rm -rf ~/.ssh', 'C:\proj');
  assert.equal(r.ok, false, 'bash 下 ~/.ssh 会真展开，必须拦');
  assert.equal(r.matchedRule, 'sensitive-path');
});

test('路径闸: $HOME / ${HOME} / %USERPROFILE% 三种写法都拒绝', () => {
  for (const cmd of [
    'rm -rf $HOME/.ssh',
    'rm -rf ${HOME}/.ssh',
    'rm -rf %USERPROFILE%/.aws'
  ]) {
    const r = checkCommandPaths(win(), cmd, 'C:\proj');
    assert.equal(r.ok, false, `必须拒绝: ${cmd}`);
    assert.equal(r.matchedRule, 'sensitive-path', cmd);
  }
});

test('路径闸: 读私钥（cat ~/.ssh/id_ed25519）拒绝', () => {
  const r = checkCommandPaths(win(), 'cat ~/.ssh/id_ed25519', 'C:\proj');
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /SSH/);
});

test('路径闸: 家目录下的非敏感项目外路径也拒绝（~ 被展开成绝对路径）', () => {
  const r = checkCommandPaths(win(), 'ls -la ~/projects', 'C:\proj');
  assert.equal(r.ok, false, '~ 展开后在项目外，应拒绝');
  assert.equal(r.matchedRule, 'path-outside');
});

test('路径闸: 裸 ~ 指家目录本身，算项目外', () => {
  const r = checkCommandPaths(win(), 'rm -rf ~', 'C:\proj');
  assert.equal(r.ok, false);
});

test('路径闸: gnu 敏感目录都覆盖（.ssh/.aws/.gnupg）', () => {
  for (const [dir, label] of [['.ssh', 'SSH'], ['.aws', 'AWS'], ['.gnupg', 'GnuPG']]) {
    const r = checkCommandPaths(win(), `cat ~/${dir}/x`, 'C:\proj');
    assert.equal(r.ok, false, `${dir} 必须拒绝`);
    assert.match(String(r.reason), new RegExp(label), `${dir} 应带标签 ${label}`);
  }
});

test('路径闸: 项目内相对路径与 URL 仍然放行（别误伤）', () => {
  assert.equal(checkCommandPaths(win(), 'rm -rf ./node_modules', 'C:\proj').ok, true);
  assert.equal(checkCommandPaths(win(), 'curl -s http://127.0.0.1:8787/healthz', 'C:\proj').ok, true);
  assert.equal(checkCommandPaths(win(), 'cat README.md', 'C:\proj').ok, true);
});

test('路径闸: off 模式下家目录敏感路径仍拒绝（敏感不受 mode 影响）', () => {
  const r = checkCommandPaths(offWin(), 'cat ~/.ssh/id_rsa', 'C:\\proj');
  assert.equal(r.ok, false);
  assert.equal(r.matchedRule, 'sensitive-path');
});

// ---- Windows 8.3 短名（只有 CI 才暴露的误伤）----
// 2026-11-16 第一版家目录正则没有词边界，`C:\Users\RUNNER~1\...\v1.txt` 里那个 `~`
// 被单独抽出来当成了家目录 → `del "项目内文件"` 被误判成「引用了项目外的路径：~」
// 而拒绝，两条 sandbox 测试在 CI 上红。本机临时目录不含 `~`，本地全绿测不出来，
// 只有 CI 的 runner 用户名（RUNNER~1）能触发。

test('路径闸: Windows 8.3 短名里的 ~ 不算家目录（RUNNER~1）', () => {
  const proj = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\proj';
  const p = createPolicy({
    platform: 'win32',
    projectPath: proj,
    env: { APPDATA: 'C:\\Users\\RUNNER~1\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\RUNNER~1' }
  });
  // 项目内删除必须放行（~1 在路径中间，不是参数开头）
  const inside = 'del "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\proj\\inside.txt"';
  assert.equal(checkCommandPaths(p, inside, proj).ok, true, '8.3 短名不该被拆成家目录');
  // 项目外仍拒绝，理由必须是项目边界（不是把 ~ 当路径）
  const out = checkCommandPaths(p, 'del "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\other\\v1.txt"', proj);
  assert.equal(out.ok, false);
  assert.equal(out.matchedRule, 'path-outside', `实际理由: ${out.reason}`);
  // 作为参数出现的 ~1 后缀也不该被当成路径
  assert.equal(checkCommandPaths(p, 'ls -la RUNNER~1', proj).ok, true);
});
