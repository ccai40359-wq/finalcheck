// 决策 1 的 shell 解析器单测（2026-11-16）：
// 三档优先：用户已装 Git Bash → 安装包内置 → 回落 cmd（带 warning）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveShell, shellSpawnSpec, BUNDLED_GIT_DIR_REL } from '../desktop/src/main/shell-resolver.mjs';

const mkExists = (paths) => (p) => paths.includes(String(p).replace(/\\\\/g, '\\'));

const USER_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

// 打包后的真实布局：<appRoot>/resources/gitbash-full/{bin,usr/bin,...}
// 而 shellAppRoot 传的是 process.resourcesPath（已含 \resources）。
const REAL_RESOURCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'release', 'win-unpacked', 'resources');
const REAL_BASH = path.join(REAL_RESOURCES, 'gitbash-full', 'bin', 'bash.exe');

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
  // 传参按打包后的真实语义：appRoot = process.resourcesPath（已含 \resources）。
  const appRoot = 'D:\\app\\resources';
  const bundled = path.join(appRoot, BUNDLED_GIT_DIR_REL, 'bin', 'bash.exe');
  const r = resolveShell({ platform: 'win32', appRoot, exists: mkExists([bundled]) });
  assert.equal(r.kind, 'bash');
  assert.equal(r.origin, 'bundled');
  assert.equal(r.file, bundled, '必须用 bin/bash.exe 这个标准入口');
  assert.deepEqual(r.args('ls'), ['-c', 'ls']);
  // PATH 必须是 Windows 格式、且前置内置的 usr/bin（coreutils 在这）与原生 bin（git 在这）。
  // 换成纯 MSYS 格式会让所有 exe exit 127（依赖 Windows 的 DLL 解析路径）。
  assert.ok(r.env.PATH.startsWith(path.join(appRoot, 'gitbash-full', 'usr', 'bin')),
    `内置版 PATH 必须以 Windows 格式的 usr/bin 开头，实际: ${r.env.PATH}`);
  assert.ok(r.env.PATH.includes(path.join('gitbash-full', 'mingw64', 'bin')),
    'PATH 里要包含 mingw64/bin（git 本体在这里）');
  assert.equal(r.env.MSYSTEM, 'MINGW64');
  assert.equal(r.env.MSYS2_ARG_CONV_EXCL, '*');
});

// 回归：0.19.0 带着这个 bug 出了包——BUNDLED_BASH_REL 里又拼了一层 resources，
// 而 appRoot 已经是 process.resourcesPath（含 resources）→ 拼成
// resources\resources\gitbash-full，干净机器上永远找不到内置 bash，直接回落 cmd。
// 本机测不出来（第一档用户已装 Git 先命中）；CI 也测不出来（verify-bundled-bash.mjs
// 直接 spawn 绝对路径，从不经过 resolveShell）。
test('shell: appRoot=resourcesPath 时能找到内置 bash（0.19.0 的 resources 重复拼接 bug）', () => {
  const appRoot = 'D:\\app\\resources';
  const real = path.join(appRoot, 'gitbash-full', 'bin', 'bash.exe');
  const r = resolveShell({ platform: 'win32', appRoot, exists: mkExists([real]) });
  assert.equal(r.origin, 'bundled', '这就是 0.19.0 挂掉的那条路径：appRoot 已含 resources');
  assert.ok(!r.file.includes('resources\\resources'), `拼出了重复的 resources: ${r.file}`);
  assert.ok(!r.env.PATH.includes('resources\\resources'), `PATH 里也有重复: ${r.env.PATH}`);
});

test('shell: appRoot 传 resources 的上级目录也能命中（两种语义都容忍）', () => {
  const appRoot = 'D:\\app';                                   // 上级
  const real = path.join(appRoot, 'resources', 'gitbash-full', 'bin', 'bash.exe');
  const r = resolveShell({ platform: 'win32', appRoot, exists: mkExists([real]) });
  assert.equal(r.origin, 'bundled', '调用方记不清该传哪一层时也要能工作');
});

test('shell: 真实打包产物里能解析到内置 bash（本机有 Git 时降级为布局断言）', () => {
  if (!fs.existsSync(REAL_BASH)) {
    console.log(`  SKIP  没有本地打包产物（先跑 cd desktop && npm run dist），期望路径: ${REAL_BASH}`);
    return;
  }
  // 屏蔽「用户已装」这一档，模拟干净机器
  const noUserGit = (p) => {
    const s = String(p);
    if (s.includes('Program Files')) return false;
    try { return fs.existsSync(s); } catch { return false; }
  };
  const r = resolveShell({ platform: 'win32', appRoot: REAL_RESOURCES, exists: noUserGit });
  assert.equal(r.origin, 'bundled', '干净机器上必须用内置 Git，不能回落 cmd');
  assert.equal(r.file, REAL_BASH, `必须指向真实存在的内置 bash，实际: ${r.file}`);
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
  const appRoot = 'D:\\app\\resources';
  const bundled = path.join(appRoot, BUNDLED_GIT_DIR_REL, 'bin', 'bash.exe');
  const spec = shellSpawnSpec('ls', {
    platform: 'win32',
    appRoot,
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
