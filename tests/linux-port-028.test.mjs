// Linux 移植（基于 0.28.0）：所有机制与原版一致，只把「Windows 专属」的东西平台化。
//
// 这条测试守的是**跨平台行为一致性**，不是「Linux 能跑」这么笼统的目标：
//   · shell 必须是真 bash（不是 dash），否则 run_command 的语法承诺在 Linux 上失效
//   · 路径必须走 XDG（不是 homedir()/FinalCheck 这种散落写法）
//   · ripgrep 必须按平台取二进制（不是把 rg.exe 打进 Linux 包）
//   · ACL 沙箱在 Linux 上不存在时，**不能**因为开关打开就拒绝所有命令
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { resolveShell } from '../desktop/src/main/shell-resolver.mjs';
import { appDataDir, appCacheDir, isWindowsPlatform } from '../desktop/src/main/platform-paths.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

// ---------------------------------------------------------------- shell

test('linux: run_command 用真 bash（dash 会让 [[ ]] / 数组 / $() 全报错）', () => {
  const r = resolveShell({ platform: 'linux', exists: () => true });
  assert.equal(r.kind, 'bash');
  assert.equal(r.file, '/usr/bin/bash');
  assert.deepEqual(r.args('echo hi'), ['-c', 'echo hi']);
});

test('linux: 没有任何 bash 时回落 sh 并给出可见 warning', () => {
  const r = resolveShell({ platform: 'linux', exists: () => false });
  assert.equal(r.file, '/bin/sh');
  assert.ok(r.warning, '静默降级会让 bash 语法神秘失败');
});

test('linux: macOS 也要找 bash（/bin/sh 在 macOS 是 bash 的兼容模式，但 /opt/homebrew 有新版）', () => {
  const r = resolveShell({ platform: 'darwin', exists: (f) => f === '/opt/homebrew/bin/bash' });
  assert.equal(r.file, '/opt/homebrew/bin/bash');
});

// ---------------------------------------------------------------- 路径

test('linux: 配置目录遵循 XDG（~/.config/FinalCheck）', () => {
  assert.equal(
    appDataDir({ platform: 'linux', env: {}, home: '/home/u' }),
    '/home/u/.config/FinalCheck'
  );
});

test('linux: XDG_CONFIG_HOME 优先于默认 ~/.config', () => {
  assert.equal(
    appDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/custom/cfg' }, home: '/home/u' }),
    '/custom/cfg/FinalCheck'
  );
});

test('linux: 缓存目录走 XDG_CACHE_HOME / ~/.cache（不是家目录根上的 FinalCheck）', () => {
  assert.equal(
    appCacheDir({ platform: 'linux', env: {}, home: '/home/u' }),
    '/home/u/.cache/FinalCheck'
  );
  assert.equal(
    appCacheDir({ platform: 'linux', env: { XDG_CACHE_HOME: '/custom/cache' }, home: '/home/u' }),
    '/custom/cache/FinalCheck'
  );
});

test('linux: Windows/macOS 的路径不被 Linux 分支影响', () => {
  // 关键回归：path.join 是「当前运行平台」的实现，Windows 上跑 Linux 分支
  // 曾经返回 \home\u\.config\FinalCheck（反斜杠）。必须用 path.posix 显式指定。
  assert.equal(
    appDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u' }),
    'C:\\Users\\u\\AppData\\Roaming\\FinalCheck'
  );
  assert.equal(
    appDataDir({ platform: 'darwin', env: {}, home: '/Users/u' }),
    '/Users/u/Library/Application Support/FinalCheck'
  );
  // 反斜杠不能出现在 Linux 路径里（跨平台 path API 选错的哨兵）
  assert.ok(!appDataDir({ platform: 'linux', env: {}, home: '/home/u' }).includes('\\'));
});

test('linux: 三个调用方都改走 platform-paths，没有残留的 homedir()/FinalCheck', () => {
  // 旧实现在 hooks / diagnostics / usage-ledger 各写一遍 homedir()/FinalCheck。
  // 三处抄一样的东西，Linux 改 XDG 时极容易漏一处——所以这里扫源码守不变量。
  for (const rel of [
    'desktop/src/main/hooks.mjs',
    'desktop/src/main/diagnostics.mjs',
    'desktop/src/main/usage-ledger.mjs'
  ]) {
    const src = read(rel);
    assert.ok(src.includes("from './platform-paths.mjs'"), `${rel} 没接 platform-paths`);
    assert.ok(!/os\.homedir\(\)/.test(src), `${rel} 还在直接用 os.homedir()`);
    assert.ok(!/path\.join\(os\.homedir\(\), 'FinalCheck'\)/.test(src), `${rel} 还有旧的 homedir/FinalCheck 硬编码`);
  }
});

// ---------------------------------------------------------------- 沙箱

test('linux: aclSandbox 开关不得让 Linux 上所有命令被拒（沙箱后端根本不存在）', () => {
  const src = read('desktop/src/main/agent-tools.mjs');
  // 判据：拒绝分支必须同时检查「平台真的支持沙箱」。
  // 旧逻辑只判 sandboxOn，于是 Linux 用户一勾这个开关就再也跑不了任何命令。
  assert.match(
    src,
    /if \(!sandbox && sandboxOn && platformHasSandbox\)/,
    'run_command 的拒绝分支必须排除「平台没有沙箱后端」这种情况'
  );
  assert.match(src, /sandboxAvailability\(\)\.available === true/, '缺少平台能力判定');
});

test('linux: createSandboxedRun 在非 Windows 上返回 null（不是抛错）', () => {
  const src = read('desktop/src/main/sandbox.mjs');
  assert.match(src, /if \(process\.platform !== 'win32' \|\| !runnerPath\) return null;/, '非 Windows 应静默不可用');
});

// ---------------------------------------------------------------- ripgrep

test('linux: 打包按平台取 rg 二进制，不把 rg.exe 塞进 Linux 包', () => {
  const pkg = JSON.parse(read('desktop/package.json'));
  const rgRes = pkg.build.extraResources.find((x) => String(x.to).startsWith('rg'));
  assert.ok(rgRes, 'extraResources 里没有 rg');
  assert.equal(rgRes.from, 'resources/rg', '必须指向按平台准备的目录，而不是硬写 ../vendor/rg/rg.exe');
  // 脚本存在且会按平台选文件名
  for (const f of ['desktop/scripts/prepare-rg.mjs', 'desktop/scripts/fetch-rg-linux.mjs']) {
    assert.ok(existsSync(path.join(repoRoot, f)), `缺脚本 ${f}`);
  }
  const prep = read('desktop/scripts/prepare-rg.mjs');
  assert.match(prep, /platform === 'win32' \? 'rg\.exe' : 'rg'/, 'prepare-rg 必须按平台选二进制名');
});

test('linux: 复制后的 rg 必须补执行位（copyFileSync 会丢 +x）', () => {
  const prep = read('desktop/scripts/prepare-rg.mjs');
  assert.match(prep, /chmodSync\(dest, 0o755\)/, '不带 +x 的 rg 在 Linux 上无法执行');
});

// ---------------------------------------------------------------- 打包

test('linux: electron-builder 有 linux 目标（AppImage + deb）', () => {
  const pkg = JSON.parse(read('desktop/package.json'));
  assert.deepEqual(pkg.build.linux.target, ['AppImage', 'deb']);
  assert.equal(pkg.build.linux.executableName, 'finalcheck');
  assert.ok(pkg.build.deb.depends.includes('bash'), 'deb 必须声明 bash 依赖（run_command 靠它）');
  assert.ok(pkg.scripts['dist:linux'].includes('--linux'), '缺 dist:linux 脚本');
});

test('linux: SQLite 预编译清单已覆盖 Linux（含 musl/Alpine）', () => {
  const manifest = JSON.parse(read('desktop/scripts/sqlite-prebuild-sha256.json'));
  const keys = Object.keys(manifest.sha256 || manifest);
  assert.ok(keys.some((k) => k.includes('linux-x64')), '缺 linux-x64 组合（Debian/Ubuntu）');
  assert.ok(keys.some((k) => k.includes('linuxmusl-x64')), '缺 linuxmusl-x64（Alpine/容器）');
  assert.ok(keys.some((k) => k.includes('linux-arm64')), '缺 linux-arm64（ARM 服务器）');
});

test('linux: sandbox 的 temp 走 appCacheDir（不在家目录根上建 FinalCheck）', () => {
  const src = read('desktop/src/main/sandbox.mjs');
  assert.ok(src.includes("from './platform-paths.mjs'"), 'sandbox 没接 platform-paths');
  assert.match(src, /path\.join\(appCacheDir\(\), 'sandbox-tmp'\)/, 'temp 回落目录没走 XDG cache');
});

// ---------------------------------------------------------------- 机制一致性

test('linux: 0.28 的机制文件一个不少（压缩落库 / 全文历史 / 验收单）', () => {
  // 「所有机制和原版一致」的可执行定义：这些模块必须存在且被 ipc-agent 接线。
  const required = [
    'desktop/src/main/compact.mjs',        // 0.27 一次性压缩落库
    'desktop/src/main/full-history.mjs',   // 0.25 跨轮完整工具历史
    'desktop/src/main/todo-list.mjs',      // 验收单
    'desktop/src/main/shell-route.mjs',    // 读文件改道
    'desktop/src/main/platform-paths.mjs'  // 本轮新增
  ];
  for (const rel of required) assert.ok(existsSync(path.join(repoRoot, rel)), `缺 ${rel}`);
  const ipc = read('desktop/src/main/ipc/ipc-agent.mjs');
  assert.ok(ipc.includes('full-history.mjs'), 'ipc-agent 没接跨轮完整历史');
  assert.ok(ipc.includes('todo-list.mjs'), 'ipc-agent 没接验收单');
});

test('linux: isWindowsPlatform 是唯一平台判断入口', () => {
  assert.equal(isWindowsPlatform('win32'), true);
  assert.equal(isWindowsPlatform('linux'), false);
  assert.equal(isWindowsPlatform('darwin'), false);
});
