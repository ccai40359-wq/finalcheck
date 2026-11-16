// 决策 1 的 shell 解析器单测（2026-11-16）：
// 三档优先：用户已装 Git Bash → 安装包内置 → 回落 cmd（带 warning）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShell, shellSpawnSpec, BUNDLED_BASH_REL } from '../desktop/src/main/shell-resolver.mjs';

const mkExists = (paths) => (p) => paths.includes(String(p).replace(/\\\\/g, '\\'));

const USER_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

test('shell: 用户已装 Git Bash 优先（-c 参数，不加载 profile）', () => {
  const r = resolveShell({ platform: 'win32', exists: mkExists([USER_BASH]) });
  assert.equal(r.kind, 'bash');
  assert.equal(r.file, USER_BASH);
  assert.equal(r.origin, 'user-installed');
  assert.deepEqual(r.args('ls -la'), ['-c', 'ls -la'], '用 -c 不用 -lc：-lc 加载 profile 要 ~1s，会触发空闲看门狗误判');
  assert.equal(r.warning, undefined);
});

test('shell: 没有用户版时用内置完整 Git（Windows 格式 PATH 前置）', () => {
  // 内置包现在是**完整 Git for Windows**（resources/gitbash-full，约 400MB）：
  // 裁剪版两次踩「漏 DLL → 静默 exit 127」，完整版自带全部依赖，不用逐版本验证闭包。
  const bundled = 'D:\\app\\' + BUNDLED_BASH_REL;
  const r = resolveShell({ platform: 'win32', appRoot: 'D:\\app', exists: mkExists([bundled]) });
  assert.equal(r.kind, 'bash');
  assert.equal(r.origin, 'bundled');
  assert.deepEqual(r.args('ls'), ['-c', 'ls']);
  // PATH 必须是 Windows 格式、且前置内置的 usr/bin（coreutils 在这）与 mingw64/bin（原生程序在这）。
  // 换成纯 MSYS 格式会让所有 exe exit 127（依赖 Windows 的 DLL 解析路径）。
  assert.ok(r.env.PATH.startsWith('D:\\app\\resources\\gitbash-full\\usr\\bin'),
    `内置版 PATH 必须以 Windows 格式的 usr/bin 开头，实际: ${r.env.PATH}`);
  assert.ok(r.env.PATH.includes('gitbash-full\\mingw64\\bin'),
    'PATH 里要包含 mingw64/bin（git 本体在这里）');
  assert.equal(r.env.MSYSTEM, 'MINGW64');
  assert.equal(r.env.MSYS2_ARG_CONV_EXCL, '*');
});

test('shell: 两者都没有 → 回落 cmd 且带 warning', () => {
  const r = resolveShell({ platform: 'win32', appRoot: 'D:\\app', exists: () => false });
  assert.equal(r.kind, 'cmd');
  assert.equal(r.origin, 'fallback-cmd');
  assert.deepEqual(r.args('dir'), ['/d', '/s', '/c', 'dir']);
  assert.ok(r.warning && /Git Bash/.test(r.warning), '必须给出警告文案');
});

test('shell: 非 Windows 走 /bin/sh，不碰 Git Bash 逻辑', () => {
  const r = resolveShell({ platform: 'linux', exists: () => true });
  assert.equal(r.file, '/bin/sh');
  assert.deepEqual(r.args('ls'), ['-c', 'ls']);
});

test('shell: 用户版存在时不因为内置版缺失而回落', () => {
  const r = resolveShell({ platform: 'win32', appRoot: 'D:\\app', exists: mkExists([USER_BASH]) });
  assert.equal(r.origin, 'user-installed', '内置缺失不该影响用户已装的那档');
});

test('shellSpawnSpec: 合并 env、带 windowsHide、cwd 透传', () => {
  const spec = shellSpawnSpec('echo hi', {
    platform: 'win32',
    exists: mkExists([USER_BASH]),
    cwd: 'C:\\proj',
    env: { PATH: 'x', FOO: 'bar' }
  });
  assert.equal(spec.file, USER_BASH);
  assert.deepEqual(spec.args, ['-c', 'echo hi']);
  assert.equal(spec.options.windowsHide, true);
  assert.equal(spec.options.cwd, 'C:\\proj');
  assert.equal(spec.options.env.FOO, 'bar');
  assert.equal(spec.origin, 'user-installed');
});

test('shellSpawnSpec: 内置版也保留调用方 env 与 windowsHide', () => {
  const bundled = 'D:\\app\\' + BUNDLED_BASH_REL;
  const spec = shellSpawnSpec('ls', {
    platform: 'win32',
    appRoot: 'D:\\app',
    exists: mkExists([bundled]),
    env: { PATH: 'x', FOO: 'bar' }
  });
  // PATH 是唯一允许被内置版改写的一键（必须前置内置 bin，否则 exe 解析不到），
  // 其余调用方 env 原样保留。
  assert.ok(spec.options.env.PATH.includes('gitbash'), '内置版会前置自己的 bin 目录');
  assert.equal(spec.options.env.FOO, 'bar', '其它 env 不能被丢掉');
  assert.equal(spec.options.windowsHide, true);
  assert.equal(spec.origin, 'bundled');
});

test('shellSpawnSpec: 回落 cmd 时仍返回 warning 供 UI 提示', () => {
  const spec = shellSpawnSpec('dir', { platform: 'win32', exists: () => false });
  assert.equal(spec.origin, 'fallback-cmd');
  assert.ok(spec.warning);
});

test('shellSpawnSpec: 空命令不崩', () => {
  const spec = shellSpawnSpec(null, { platform: 'win32', exists: mkExists([USER_BASH]) });
  assert.deepEqual(spec.args, ['-c', '']);
});
