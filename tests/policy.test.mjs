// 策略沙箱模块测试（desktop/src/main/policy.mjs）
// 覆盖：项目边界 / .. 穿越 / allowPaths / readonly / off / 大小写 / 敏感路径 /
// 命令黑名单 / cwd / 环境变量剥除 / 拒绝记录形状
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_MODES, createPolicy, assertPathAllowed, assertCwd,
  checkCommand, scrubEnv, checkEnvVarName
} from '../desktop/src/main/policy.mjs';

const WIN_HOME = 'C:\\Users\\dev';
const WIN_APPDATA = WIN_HOME + '\\AppData\\Roaming';
const WIN_ENV = { APPDATA: WIN_APPDATA, USERPROFILE: WIN_HOME };

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

const NIX_HOME = '/home/dev';
const nix = (overrides = {}) => createPolicy({
  platform: 'posix',
  projectPath: '/home/dev/proj',
  env: { HOME: NIX_HOME },
  ...overrides
});

const offNix = (overrides = {}) => createPolicy({
  platform: 'posix',
  mode: 'off',
  env: { HOME: NIX_HOME },
  ...overrides
});

const hasRecordShape = (record) => {
  assert.deepEqual(Object.keys(record).sort(), ['at', 'reason', 'target', 'tool']);
  assert.equal(typeof record.tool, 'string');
  assert.equal(typeof record.target, 'string');
  assert.equal(typeof record.reason, 'string');
  assert.equal(Number.isNaN(Date.parse(record.at)), false, 'at 必须是可解析的时间');
};

/* ---------- 模式与创建 ---------- */
test('policy: 模式常量冻结，非法模式/非法 allowPaths 直接抛错', () => {
  assert.deepEqual([...POLICY_MODES], ['workspace', 'readonly', 'off']);
  assert.ok(Object.isFrozen(POLICY_MODES));
  assert.throws(() => createPolicy({ mode: 'full' }), /未知策略模式/);
  assert.throws(() => createPolicy({ allowPaths: [42] }), /allowPaths/);
});

/* ---------- workspace 项目边界 / .. 穿越 ---------- */
test('policy: workspace 内读写通过，项目外与 .. 穿越拒绝（Windows）', () => {
  const p = win();

  assert.deepEqual(assertPathAllowed(p, 'C:\\proj\\src\\a.js'), {
    ok: true, path: 'C:\\proj\\src\\a.js'
  });
  assert.deepEqual(assertPathAllowed(p, 'C:\\proj\\src\\a.js', { write: true }), {
    ok: true, path: 'C:\\proj\\src\\a.js'
  });
  assert.equal(assertPathAllowed(p, 'C:/proj/src/a.js').ok, true, '正斜杠等价');
  assert.equal(assertPathAllowed(p, 'C:\\proj\\src\\').path, 'C:\\proj\\src', '返回路径去除末尾分隔符');

  const outside = assertPathAllowed(p, 'C:\\other\\a.js');
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /项目边界/);
  hasRecordShape(outside.record);

  const sibling = assertPathAllowed(p, 'C:\\proj2\\a.js');
  assert.equal(sibling.ok, false, '前缀相同但不同目录必须拒绝');

  const traversal = assertPathAllowed(p, 'C:\\proj\\..\\Windows\\System32\\x.dll');
  assert.equal(traversal.ok, false);
  assert.equal(traversal.record.target, 'C:\\Windows\\System32\\x.dll', '.. 解析后再判定');

  const relativeInside = assertPathAllowed(p, 'src\\a.js');
  assert.equal(relativeInside.ok, true);
  assert.equal(relativeInside.path, 'C:\\proj\\src\\a.js', '相对路径按项目根解析');

  const relativeEscape = assertPathAllowed(p, '..\\outside.txt');
  assert.equal(relativeEscape.ok, false);
  assert.equal(relativeEscape.record.target, 'C:\\outside.txt');
});

test('policy: POSIX 项目边界与 .. 穿越区分大小写', () => {
  const p = nix();
  assert.equal(assertPathAllowed(p, '/home/dev/proj/src/a.js').ok, true);
  assert.equal(assertPathAllowed(p, '/home/dev/other/a.js').ok, false);
  assert.equal(assertPathAllowed(p, '/home/dev/proj/../other/a.js').ok, false);
  assert.equal(assertPathAllowed(p, '/home/dev/proj2/a.js').ok, false);
  assert.equal(assertPathAllowed(p, '../etc/passwd').ok, false);

  // POSIX 大小写敏感：Windows 风格的大小写变体不能借项目根前缀混进来
  assert.equal(assertPathAllowed(p, '/HOME/DEV/PROJ/a.js').ok, false);
});

/* ---------- allowPaths ---------- */
test('policy: allowPaths 放行额外目录（读/写），敏感路径仍优先拒绝', () => {
  const p = win({ allowPaths: ['D:\\shared', 'extras'] });
  assert.equal(assertPathAllowed(p, 'D:\\shared\\a.txt').ok, true);
  assert.equal(assertPathAllowed(p, 'D:\\shared\\a.txt', { write: true }).ok, true);
  assert.equal(assertPathAllowed(p, 'C:\\proj\\extras\\a.txt').ok, true, '相对 allowPath 落到项目根');
  assert.equal(assertPathAllowed(p, 'C:\\other\\a.txt').ok, false);

  const sshAllowed = createPolicy({
    platform: 'win32',
    projectPath: 'C:\\proj',
    allowPaths: [WIN_HOME + '\\.ssh'],
    env: WIN_ENV
  });
  assert.equal(assertPathAllowed(sshAllowed, WIN_HOME + '\\.ssh\\id_rsa').ok, false,
    'allowPaths 不能覆盖敏感路径禁令');
});

/* ---------- readonly ---------- */
test('policy: readonly 允许读、拒绝写（项目内与 allowPaths 都拒绝）', () => {
  const p = win({ mode: 'readonly', allowPaths: ['D:\\shared'] });
  assert.equal(assertPathAllowed(p, 'C:\\proj\\a.txt').ok, true);
  const inner = assertPathAllowed(p, 'C:\\proj\\a.txt', { write: true });
  assert.equal(inner.ok, false);
  assert.match(inner.reason, /只读/);
  assert.equal(assertPathAllowed(p, 'D:\\shared\\a.txt', { write: true }).ok, false);
  assert.equal(assertPathAllowed(p, 'C:\\other\\a.txt').ok, false, '只读不扩大项目边界');
  assert.equal(assertCwd(p, 'C:\\proj\\src').ok, true);
});

/* ---------- off ---------- */
test('policy: off 放行普通路径（含写），敏感路径仍拒绝', () => {
  const p = offWin();
  assert.equal(assertPathAllowed(p, 'C:\\anywhere\\a.txt').ok, true);
  assert.equal(assertPathAllowed(p, 'C:\\anywhere\\a.txt', { write: true }).ok, true);
  assert.equal(assertPathAllowed(p, WIN_HOME + '\\.zcode\\settings.json').ok, true,
    '用户自己的工具目录不过度拦截');

  const cases = [
    [WIN_APPDATA + '\\FinalCheck\\config.json', /APPDATA/],
    [WIN_APPDATA + '\\FinalCheck\\projects.json', /APPDATA/],
    [WIN_APPDATA + '\\FinalCheck\\hooks.json', /APPDATA/],
    [WIN_HOME + '\\.ssh\\id_rsa', /SSH/],
    [WIN_HOME + '\\.ssh\\known_hosts', /SSH/],
    [WIN_HOME + '\\.aws\\credentials', /AWS/],
    [WIN_HOME + '\\.gnupg\\pubring.kbx', /GnuPG/],
    [WIN_HOME + '\\.git-credentials', /Git/],
    ['C:\\proj\\keys\\id_rsa', /私钥/],
    ['C:\\proj\\keys\\id_rsa.pub', /私钥/],
    ['C:\\proj\\keys\\id_ed25519', /私钥/],
    ['C:\\proj\\keys\\id_ed25519.pub', /私钥/]
  ];
  for (const [target, label] of cases) {
    const r = assertPathAllowed(p, target);
    assert.equal(r.ok, false, target);
    assert.match(r.reason, label, target);
    assert.equal(assertPathAllowed(p, target, { write: true }).ok, false, '写入同样拒绝');
  }

  // 近似但不命中的路径不应误杀
  assert.equal(assertPathAllowed(p, WIN_HOME + '\\.ssh2\\config').ok, true);
  assert.equal(assertPathAllowed(p, WIN_HOME + '\\.aws2\\config').ok, true);
  assert.equal(assertPathAllowed(p, 'C:\\proj\\id_rsa.txt').ok, true);
  assert.equal(assertPathAllowed(p, 'C:\\proj\\finalcheck.config.json').ok, true);
});

/* ---------- Windows 大小写不敏感 / POSIX 敏感 ---------- */
test('policy: Windows 路径比较大小写不敏感，敏感路径同样不敏感', () => {
  const p = win();
  assert.equal(assertPathAllowed(p, 'C:\\PROJ\\SRC\\A.JS').ok, true);
  assert.equal(assertPathAllowed(p, 'C:\\PROJ\\SRC\\A.JS').path, 'C:\\PROJ\\SRC\\A.JS');

  const pOff = offWin();
  assert.equal(assertPathAllowed(pOff, 'C:\\USERS\\DEV\\APPDATA\\ROAMING\\FINALCHECK\\CONFIG.JSON').ok, false);
  assert.equal(assertPathAllowed(pOff, 'C:\\Users\\Dev\\.SSH\\ID_RSA').ok, false);
});

test('policy: POSIX 路径比较大小写敏感（普通路径与敏感路径）', () => {
  const pOff = offNix();
  assert.equal(assertPathAllowed(pOff, '/home/dev/.ssh/id_rsa').ok, false);
  assert.equal(assertPathAllowed(pOff, '/home/dev/.SSH/ID_RSA').ok, true, 'POSIX 下大小写变体不是同一路径');
  assert.equal(assertPathAllowed(pOff, '/tmp/keys/id_rsa').ok, false, '私钥文件名任何位置都拒绝');
  assert.equal(assertPathAllowed(pOff, '/tmp/keys/ID_RSA').ok, true);

  const p = nix({ allowPaths: ['/shared'] });
  assert.equal(assertPathAllowed(p, '/shared/a.txt').ok, true);
  assert.equal(assertPathAllowed(p, '/SHARED/a.txt').ok, false);
});

/* ---------- cwd ---------- */
test('policy: assertCwd 在 workspace/readonly 受项目边界约束，off 放行', () => {
  const p = win();
  assert.equal(assertCwd(p, 'C:\\proj\\src').ok, true);
  const outside = assertCwd(p, 'C:\\Windows');
  assert.equal(outside.ok, false);
  assert.match(outside.reason, /项目边界/);
  assert.equal(outside.record.tool, 'cwd');
  hasRecordShape(outside.record);

  const withAllowed = win({ allowPaths: ['D:\\shared'] });
  assert.equal(assertCwd(withAllowed, 'D:\\shared\\x').ok, true);

  const ro = win({ mode: 'readonly' });
  assert.equal(assertCwd(ro, 'C:\\proj').ok, true);

  const off = offWin();
  assert.equal(assertCwd(off, 'C:\\anywhere').ok, true);
  assert.equal(assertCwd(off, WIN_HOME + '\\.ssh').ok, false, '敏感 cwd 在 off 下同样拒绝');

  // 缺省 cwd：受限模式落到项目根；off 无边界
  assert.deepEqual(assertCwd(p, undefined), { ok: true, path: 'C:\\proj' });
  assert.deepEqual(assertCwd(off, ''), { ok: true, path: null });

  // 没有 projectPath 的 workspace：fail-closed
  const empty = createPolicy({ platform: 'win32', env: WIN_ENV });
  assert.equal(assertCwd(empty, undefined).ok, false);
  assert.equal(assertPathAllowed(empty, 'C:\\proj\\a.txt').ok, false);
});

/* ---------- 命令黑名单 ---------- */
test('policy: 灾难命令黑名单命中并返回规则名', () => {
  const p = win();
  const cases = [
    ['del /s /q C:\\x', 'del-recursive'],
    ['DEL /S /Q C:\\x', 'del-recursive'],
    ['del /q C:\\x', 'del-force'],
    ['erase /s C:\\x', 'del-recursive'],
    ['rd /s /q C:\\x', 'rd-recursive'],
    ['rmdir /s C:\\x', 'rd-recursive'],
    ['format d:', 'format-disk'],
    ['format.com /q D:', 'format-disk'],
    ['format', 'format-disk'],
    ['Format-Volume -DriveLetter D', 'format-volume'],
    ['Remove-Item -Recurse -Force C:\\x', 'remove-item-recurse'],
    ['reg delete HKLM\\Software\\Foo /f', 'reg-delete'],
    ['bcdedit /set {default} safeboot minimal', 'bcdedit'],
    ['diskpart', 'diskpart'],
    ['netsh firewall set opmode disable', 'netsh-firewall'],
    ['netsh advfirewall firewall add rule name=x dir=in action=allow', 'netsh-firewall'],
    ['shutdown /s /t 0', 'shutdown'],
    ['shutdown.exe -h now', 'shutdown'],
    ['logoff', 'logoff'],
    ['cipher /w C:\\', 'cipher-wipe'],
    ['takeown /f C:\\x', 'takeown-force'],
    ['icacls C:\\x /grant Everyone:F', 'icacls-grant'],
    ['icacls C:\\x /grant:r Everyone:F', 'icacls-grant'],
    ['rm -rf /tmp/x', 'rm-recursive'],
    ['rm -fr /tmp/x', 'rm-recursive'],
    ['rm -r -f /tmp/x', 'rm-recursive'],
    ['sudo rm -rf /tmp/x', 'rm-recursive'],
    ['cmd /c del /s /q C:\\x', 'del-recursive'],
    ['powershell -Command "Remove-Item -Recurse C:\\x"', 'remove-item-recurse']
  ];
  for (const [cmd, rule] of cases) {
    const r = checkCommand(p, cmd);
    assert.equal(r.ok, false, cmd);
    assert.equal(r.matchedRule, rule, cmd);
    assert.match(r.reason, /黑名单/);
  }
});

test('policy: 正常命令放行，不因参数里出现敏感词误报', () => {
  const p = win();
  const safe = [
    'dir /b',
    'npm test',
    'git status --short',
    'npm run format',
    'del C:\\proj\\tmp.txt',
    'rm file.txt',
    'echo shutdown',
    'echo del /s /q C:\\x',
    'git commit -m "del /s"'
  ];
  for (const cmd of safe) assert.deepEqual(checkCommand(p, cmd), { ok: true }, cmd);

  assert.deepEqual(checkCommand(p, ''), { ok: true });
  const invalid = checkCommand(p, null);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.matchedRule, 'invalid-command');
});

/* ---------- 环境变量 ---------- */
test('policy: checkEnvVarName 敏感命名识别 + 白名单', () => {
  assert.equal(checkEnvVarName('OPENAI_API_KEY'), true);
  assert.equal(checkEnvVarName('GITHUB_TOKEN'), true);
  assert.equal(checkEnvVarName('DB_PASSWORD'), true);
  assert.equal(checkEnvVarName('AWS_SECRET_ACCESS_KEY'), true);
  assert.equal(checkEnvVarName('MY_CREDENTIAL'), true);
  assert.equal(checkEnvVarName('USER_AUTH'), true);
  assert.equal(checkEnvVarName('PWD'), true);
  assert.equal(checkEnvVarName('NODE_OPTIONS'), true, '可注入代码，不在白名单');

  assert.equal(checkEnvVarName('PATH'), false);
  assert.equal(checkEnvVarName('Path'), false, 'Windows 大小写变体同样保留');
  assert.equal(checkEnvVarName('PATHEXT'), false);
  assert.equal(checkEnvVarName('HOME'), false);
  assert.equal(checkEnvVarName('USERPROFILE'), false);
  assert.equal(checkEnvVarName('TEMP'), false);
  assert.equal(checkEnvVarName('TMP'), false);
  assert.equal(checkEnvVarName('SYSTEMROOT'), false);
  assert.equal(checkEnvVarName('COMSPEC'), false);
  assert.equal(checkEnvVarName('LANG'), false);
  assert.equal(checkEnvVarName('LC_ALL'), false);
  assert.equal(checkEnvVarName('TERM'), false);
  assert.equal(checkEnvVarName(''), false);
  assert.equal(checkEnvVarName(null), false);
});

test('policy: scrubEnv 剥除密钥变量、保留白名单、removed 只有名字且不改入参', () => {
  const input = {
    NODE_OPTIONS: '--require ./evil.js',
    OPENAI_API_KEY: 'sk-live-abc',
    GITHUB_TOKEN: 'ghp_xyz',
    DB_PASSWORD: 'hunter2',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    MY_CREDENTIAL: 'cred-value',
    USER_AUTH: 'auth-value',
    PATH: '/usr/bin',
    Path: 'C:\\Windows',
    PATHEXT: '.COM',
    HOME: WIN_HOME,
    USERPROFILE: WIN_HOME,
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    SYSTEMROOT: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    TERM: 'xterm-256color'
  };
  const snapshot = { ...input };
  const { env, removed } = scrubEnv(input);

  const sensitive = [
    'NODE_OPTIONS', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'DB_PASSWORD',
    'AWS_SECRET_ACCESS_KEY', 'MY_CREDENTIAL', 'USER_AUTH'
  ];
  assert.deepEqual([...removed].sort(), [...sensitive].sort());
  for (const name of sensitive) assert.equal(Object.prototype.hasOwnProperty.call(env, name), false, name);

  const kept = [
    'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
    'SYSTEMROOT', 'COMSPEC', 'LANG', 'LC_ALL', 'TERM'
  ];
  for (const name of kept) {
    assert.equal(env[name], input[name], name);
  }

  assert.ok(!JSON.stringify(removed).includes('sk-live-abc'), 'removed 不能放值');
  assert.ok(!JSON.stringify(removed).includes('hunter2'), 'removed 不能放值');
  assert.ok(removed.every((name) => typeof name === 'string'));
  assert.deepEqual(input, snapshot, 'scrubEnv 不修改入参');
});

/* ---------- 拒绝记录 ---------- */
test('policy: 拒绝 record 固定四字段，不含密钥值，只记目标路径', () => {
  const p = createPolicy({
    platform: 'win32',
    mode: 'off',
    env: { ...WIN_ENV, OPENAI_API_KEY: 'sk-record-secret' }
  });
  const r = assertPathAllowed(p, WIN_HOME + '\\.ssh\\id_rsa', { tool: 'read_file' });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.record).sort(), ['at', 'reason', 'target', 'tool']);
  assert.equal(r.record.tool, 'read_file');
  assert.equal(r.record.target, WIN_HOME + '\\.ssh\\id_rsa');
  assert.match(r.record.reason, /敏感路径/);
  assert.equal(Number.isNaN(Date.parse(r.record.at)), false);
  assert.ok(!JSON.stringify(r).includes('sk-record-secret'), 'record/reason 不夹带环境变量值');

  const outside = assertPathAllowed(win(), 'C:\\proj\\..\\secret.txt', { tool: 'edit_file' });
  assert.equal(outside.ok, false);
  assert.equal(outside.record.tool, 'edit_file');
  assert.equal(outside.record.target, 'C:\\secret.txt');

  const def = assertPathAllowed(win(), 'C:\\outside');
  assert.equal(def.ok, false);
  assert.equal(def.record.tool, 'read', 'tool 缺省是 read');

  const bad = assertPathAllowed(null, 'C:\\x');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, '策略对象无效');
  hasRecordShape(bad.record);
});
