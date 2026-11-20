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

test('linux: 沙箱后端按平台分流（Windows 用 ACL argv，Linux 用 bwrap shell 字符串）', () => {
  const src = read('desktop/src/main/sandbox.mjs');
  // 非 Windows 分支必须先看探测结果：不可用就返回 null（降级到宿主机，调用方决定）
  assert.match(src, /if \(linuxProbe\?\.available !== true\) return null;/, 'Linux 未探测/不可用时必须返回 null');
  // Linux 分支走 createLinuxSandboxedRun（异步，返回 shell 字符串）
  assert.match(src, /return createLinuxSandboxedRun\(/, 'Linux 应走 bubblewrap 后端');
  // 两个后端的返回形状不同：Windows 是 {file,args}，Linux 是 {command}
  assert.match(src, /file: process\.execPath,/, 'Windows 后端仍要返回 argv 形式');
  assert.match(src, /command: wrapped\.command,/, 'Linux 后端要返回 shell 字符串');
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

// ---------------------------------------------------------------- Linux 沙箱（bubblewrap）

test('linux 沙箱: 配置收敛到 CC 的语义（写 allow-only / 读 deny-then-allow / 网络白名单）', async () => {
  const { buildSandboxConfig, DEFAULT_DENY_READ, DEFAULT_WRITE_PATHS } = await import('../desktop/src/main/sandbox-linux.mjs');
  const cfg = buildSandboxConfig({ gatewayUrls: ['https://api.example.com/v1'], extraDomains: ['my.internal'] });
  // 写：allow-only —— 必须有显式白名单，且不能是空
  assert.ok(cfg.filesystem.allowWrite.length >= DEFAULT_WRITE_PATHS.length);
  // 读：默认拒绝凭据目录（这是 Windows ACL 沙箱做不到的）
  assert.ok(cfg.filesystem.denyRead.includes('~/.ssh'), '必须拒绝读 ~/.ssh');
  assert.ok(cfg.filesystem.denyRead.includes('~/.aws'), '必须拒绝读 ~/.aws');
  assert.ok(cfg.filesystem.denyRead.length >= DEFAULT_DENY_READ.length);
  // 网络：网关域名自动进白名单（否则 FC 连不上模型）
  assert.ok(cfg.network.allowedDomains.includes('api.example.com'), '网关 host 必须自动加入');
  assert.equal(cfg.network.allowedDomains.includes('https://api.example.com/v1'), false, '白名单里不能带协议前缀');
  assert.ok(cfg.network.allowedDomains.includes('my.internal'));
});

test('linux 沙箱: 严格模式只认用户填的域名（不自动加开发域名）', async () => {
  const { buildSandboxConfig } = await import('../desktop/src/main/sandbox-linux.mjs');
  const strict = buildSandboxConfig({ strictNetwork: true, extraDomains: ['only.example.com'], gatewayUrls: ['https://gw.example.com'] });
  const allowed = strict.network.allowedDomains;
  assert.ok(allowed.includes('only.example.com'));
  assert.ok(allowed.includes('gw.example.com'));
  assert.equal(allowed.includes('registry.npmjs.org'), false, 'strict 模式不该自动放行 npm');
});

test('linux 沙箱: 完全断网时 deniedDomains 是通配（不是空列表）', async () => {
  const { buildSandboxConfig } = await import('../desktop/src/main/sandbox-linux.mjs');
  const offline = buildSandboxConfig({ allowNetwork: false });
  assert.deepEqual(offline.network.allowedDomains, []);
  assert.deepEqual(offline.network.deniedDomains, ['*']);
});

test('linux 沙箱: hostOfUrl 只取 host（协议/路径/端口噪声都要丢掉）', async () => {
  const { hostOfUrl } = await import('../desktop/src/main/sandbox-linux.mjs');
  assert.equal(hostOfUrl('https://api.example.com/v1'), 'api.example.com');
  assert.equal(hostOfUrl('api.example.com'), 'api.example.com');
  assert.equal(hostOfUrl(''), '');
  assert.equal(hostOfUrl('not a url'), '');
});

test('linux 沙箱: probeSandbox 在 Windows 上明确说走 ACL 后端（不误报可用）', async () => {
  const { probeSandbox } = await import('../desktop/src/main/sandbox-linux.mjs');
  if (process.platform !== 'win32') return; // 只在这台机器上是 Windows 时验证
  const r = await probeSandbox();
  assert.equal(r.available, false);
  assert.match(r.reason, /ACL/);
});

test('linux 沙箱: agent-tools 里 Linux 沙箱走 shell 字符串（不是 argv）', () => {
  const src = read('desktop/src/main/agent-tools.mjs');
  // 两个后端形状不同：Windows 有 args，Linux 只有 command
  assert.match(src, /if \(sandbox && sandbox\.args\) \{/, '缺少 Windows argv 分支');
  assert.match(src, /else if \(sandbox && sandbox\.command\) \{/, '缺少 Linux shell 字符串分支');
  // Linux 分支必须用真 bash 跑（dash 不认 bwrap 命令）
  assert.match(src, /shellSpec\.args\(sandbox\.command\)/, 'Linux 沙箱命令没交给 shell');
});

test('linux 沙箱: createSandboxedRun 调用点必须 await（Linux 侧是异步的）', () => {
  const src = read('desktop/src/main/agent-tools.mjs');
  assert.match(src, /await createSandboxedRun\(/, 'Linux 沙箱初始化是异步的，不 await 会拿到 Promise');
});

test('linux 沙箱: 退出前释放沙箱（否则残留 socat 进程与 Unix socket）', () => {
  const src = read('desktop/src/main/index.mjs');
  assert.match(src, /before-quit[\s\S]{0,200}?releaseSandbox/, '缺 before-quit 释放');
});

// ---------------------------------------------------------------- Playwright

test('playwright: 是依赖而不是 devDependency（打包后要能用）', () => {
  const pkg = JSON.parse(read('desktop/package.json'));
  assert.ok(pkg.dependencies?.playwright, 'playwright 必须在 dependencies');
  // 锁死版本：浏览器与 Node 侧版本必须匹配，^ 会在升级时错配
  assert.match(pkg.dependencies.playwright, /^1\.\d+\.\d+$/, 'playwright 要锁精确版本');
});

test('playwright: 截图后端优先级（Playwright 在 Electron 之后、Chrome 之前）', () => {
  const src = read('desktop/src/main/capture-headless.mjs');
  const idxPlaywright = src.indexOf("kind: 'playwright'");
  const idxElectron = src.indexOf("kind: 'electron'");
  const idxChrome = src.indexOf("kind: 'chrome'");
  assert.ok(idxElectron > 0 && idxPlaywright > 0 && idxChrome > 0);
  // Playwright 探测排在最后（先试 Electron，再 Playwright，最后系统 Chrome）
  assert.ok(idxPlaywright > idxElectron, 'Playwright 应排在 Electron 之后（桌面端 Electron 更快）');
});

test('playwright: 沙箱里启动 Chromium 必须带 --no-sandbox（bwrap 内没有 user namespace）', () => {
  const src = read('desktop/src/main/capture-headless.mjs');
  // 断言「启动参数里含 --no-sandbox」，不锁写法（可能是内联数组，也可能是 launchArgs 常量）
  assert.match(src, /'--no-sandbox'/, '缺 --no-sandbox 时 Chromium 在容器/bwrap 里直接退出');
  assert.match(src, /'--disable-dev-shm-usage'/, '容器里 /dev/shm 太小会崩，必须带这个');
});

test('playwright: 不可用文案给出精确命令（不是"自己装 puppeteer"）', () => {
  const src = read('desktop/src/main/capture-headless.mjs');
  assert.match(src, /npx playwright install --with-deps chromium/, '缺精确的安装命令');
});

test('打包: deb 依赖声明 bubblewrap + socat（Linux 沙箱的硬依赖）', () => {
  const pkg = JSON.parse(read('desktop/package.json'));
  for (const dep of ['bash', 'git', 'ripgrep', 'bubblewrap', 'socat']) {
    assert.ok(pkg.build.deb.depends.includes(dep), `deb 缺 ${dep} 依赖`);
  }
});

// ---------------------------------------------------------------- grep 回退（Linux）

test('linux: grep_code 在非 Windows 上回退到 GNU grep（不再报「请安装 ripgrep」）', { skip: process.platform === 'win32' }, () => {
  const src = read('desktop/src/main/agent-tools.mjs');
  // 旧实现：`return { error: '未找到 ripgrep（rg）：当前平台没有 findstr 兜底，请安装 ripgrep 后重试' }`
  // grep 是 POSIX 标准工具，系统必然自带，没理由让用户为搜索额外装东西。
  // 只断言「不再作为 error 返回」。注释里仍会引用旧文案做历史说明，那是允许的。
  assert.ok(!/error:\s*'未找到 ripgrep/.test(src), '不该再把「未找到 ripgrep」当硬失败返回');
  assert.match(src, /return grepCodeGnuGrep\(\{ target, glob, pattern, max \}\);/, '非 Windows 应回退 GNU grep');
  assert.match(src, /async function grepCodeGnuGrep\(/, '缺 grepCodeGnuGrep 实现');
});

test('linux: GNU grep 回退要带 -H（否则单文件命中解析不出，模型看到 0 处）', { skip: process.platform === 'win32' }, () => {
  const src = read('desktop/src/main/agent-tools.mjs');
  // 取函数体前 900 字符（含 argv 构造），不用 indexOf('}') —— 函数内有多个 }
  const fn = src.slice(src.indexOf('async function grepCodeGnuGrep'));
  assert.match(fn.slice(0, 900), /'-n', '-H', '-I', '-E'/, 'grep argv 必须含 -H（带文件名）与 -I（跳二进制）');
});

test('linux: aclSandbox 的不兼容清单是 Windows 专属，Linux 上 node/grep 不应被判不兼容', { skip: process.platform === 'win32' }, () => {
  const src = read('desktop/src/main/sandbox.mjs');
  const fn = src.slice(src.indexOf('export function sandboxCompatible'));
  const head = fn.slice(0, 900);
  assert.match(head, /if \(process\.platform !== 'win32'\) return \{ compatible: true, reason: null \};/,
    'Linux 上必须先短路返回 compatible（否则 node/npm/grep 全被跳过沙箱落到宿主机）');
});

test('linux: 应用自己的配置目录是敏感路径（config.json 里存着 API Key）', async () => {
  const { createPolicy, isSensitivePath } = await import('../desktop/src/main/policy.mjs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const home = os.homedir();
  // 三个平台各取自己的应用数据目录。这条在 Linux 上最有价值：
  // Windows 分支只认 %APPDATA%，XDG 路径曾完全没被保护（实测能读出来）。
  const cfg = process.platform === 'win32'
    ? pathMod.join(process.env.APPDATA || pathMod.join(home, 'AppData', 'Roaming'), 'FinalCheck', 'config.json')
    : process.platform === 'darwin'
      ? pathMod.join(home, 'Library', 'Application Support', 'FinalCheck', 'config.json')
      : pathMod.join(process.env.XDG_CONFIG_HOME || pathMod.join(home, '.config'), 'FinalCheck', 'config.json');
  const p = createPolicy({ projectPath: process.cwd(), mode: 'workspace' });
  assert.ok(isSensitivePath(p, cfg), `${cfg} 必须命中敏感路径（里面有 config.json 的 API Key）`);
});

test('linux: POSIX 绝对路径必须在项目边界闸里被识别（曾经整块漏掉）', async () => {
  const { createPolicy, checkCommandPaths } = await import('../desktop/src/main/policy.mjs');
  const p = createPolicy({ projectPath: '/tmp/proj', mode: 'workspace' });
  // literalPathsIn 原来只匹配「盘符路径」和「家目录写法」，纯 POSIX 绝对路径一条都不匹配
  // → Linux 上 `cat /etc/passwd` 直接 ok:true，边界闸等于不存在。
  if (process.platform !== 'win32') {
    const r = checkCommandPaths(p, 'cat /etc/passwd', '/tmp/proj');
    assert.equal(r.ok, false, 'POSIX 绝对路径必须触发边界检查');
    assert.equal(r.matchedRule, 'path-outside');
  }
});

// ---------------------------------------------------------------- /dev/null 例外

test('linux: /dev/null 等设备文件不是「项目外路径」（否则 2>/dev/null 全部被拒）', async () => {
  const { createPolicy, checkCommandPaths } = await import('../desktop/src/main/policy.mjs');
  if (process.platform === 'win32') return; // 这条只在 POSIX 上成立
  const p = createPolicy({ projectPath: '/tmp/proj', mode: 'workspace' });
  // 2026-11-20 WSL 真机踩到的回归：加了 POSIX 绝对路径支持后，
  // `> /dev/null` / `2>/dev/null` 被当成「项目外文件」整条拒绝。
  // 这是 bash 最常见写法，比漏拦更糟 —— 必须放行。
  for (const cmd of [
    'echo hi > /dev/null',
    'echo hi 2>/dev/null',
    'ls . 2>/dev/null || true',   // 项目内目录 + 2>/dev/null 的组合
    'echo x > /dev/stdout',
    'cat < /dev/stdin'
  ]) {
    const r = checkCommandPaths(p, cmd, '/tmp/proj');
    assert.equal(r.ok, true, `${cmd} 不该因 /dev/* 被拒`);
  }
  // 但真正的项目外路径仍然要拒
  const bad = checkCommandPaths(p, 'cat /etc/passwd', '/tmp/proj');
  assert.equal(bad.ok, false);
  assert.equal(bad.matchedRule, 'path-outside');
});
