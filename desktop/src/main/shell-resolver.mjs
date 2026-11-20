// Shell 解析器（决策 1，2026-11-16）：
//   ① 用户已装的 Git Bash（C:\Program Files\Git\bin\bash.exe）→ 用它
//   ② 安装包内置的完整 Git for Windows（resources/gitbash-full）→ 用它（干净机器也能跑 bash）
//   ③ 回落 cmd.exe（都没有时；记 warning 并在 UI 提示）
//
// 为什么选 Git Bash：AI 在 bash 语法下出错率明显低于 cmd——
// cmd 与 PowerShell 的引号/转义/管道规则各不相同，模型经常混用（`cat` 写成 `type`、
// `2>/dev/null` 写成 `2>nul`）；bash 是训练语料里最常见、模型最熟的一种。
//
// 内置包为什么能只用 12MB（踩了四轮才定案，别轻易删这几个文件）：
//   · 必需：bash.exe(2.5M) + 9 个 MSYS DLL(6.6M) + 27 个 coreutils(~3M) + etc/fstab&msystem(1K)
//   · 9 个 DLL 是用粗依赖分析算出来的最小闭包（msys-2.0/intl/iconv/pcre/readline/ncursesw/gmp/mpfr/gcc_s-seh）
//   · **不需要** usr/lib（24MB 里 20MB 是 perl）—— 两次误判都栽在这里
//   · **不需要** terminfo / svn / ssl / gnupg 那 49 个 DLL（与 bash+coreutils 无关）
//   · 缺 etc/fstab+msystem → cygwin 没有挂载表，`ls /` 空、重定向失败
//   · PATH 必须保持 Windows 格式（内置 bin 前置）；换成纯 MSYS 格式会让所有 exe
//     exit 127（它们依赖 Windows 的 DLL 解析）
//   · 验证方式：`.github/workflows/verify-gitbash.yml` 在干净 runner 上删掉注册表项
//     HKLM\SOFTWARE\GitForWindows 后跑 `desktop/scripts/verify-bundled-bash.mjs`。
//     本地跑会因为已装 Git 劫持 mount 表，脚本会自动把相关断言降级为 SKIP。
//
// 注意：这里只负责「用哪个 shell 起子进程」。窗口隐藏策略（sandboxWindowMode 的三段重试）
// 不在本模块，保持原样不动。

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** 用户已装 Git for Windows 的官方安装路径（含 x64/x86 两种可能的 Program Files）。 */
const USER_GITBASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
];

/** 内置 bash 相对 **app 根目录**的位置。
 *
 * ⚠️ 路径语义踩过一次坑（2026-11-16，0.19.0 已经带着这个 bug 出了包）：
 * 调用方传进来的 `appRoot` 是 `process.resourcesPath`，它**已经**指向 `...\resources`；
 * 而本常量又写死了一个 `resources\` 前缀 → 拼成 `resources\resources\gitbash-full\...`，
 * 在打包后的机器上永远找不到内置 bash，干净机器直接回落 cmd（0.19.0 的核心卖点失效）。
 * 本机测不出来是因为第一档「用户已装 Git」先命中；CI 也测不出来是因为
 * verify-bundled-bash.mjs 直接 spawn 绝对路径，从不经过 resolveShell。
 *
 * 所以下面按「appRoot 是 resources 目录」来拼（与调用方保持一致），
 * 并额外容忍 appRoot 是 resources 的**上级**（便于测试与其它入口）。
 * 若将来真要打包：用 usr/bin/bash.exe（真实二进制 2.5MB），不能只用 bin/bash.exe
 * ——后者是 47KB wrapper，会校验完整 Git 安装结构，在精简包里报 `Top-level not found`。
 */
export const BUNDLED_GIT_DIR_REL = path.join('gitbash-full');

/**
 * 解析可用的 shell。
 * @param {object} opts
 * @param {string} [opts.appRoot] 打包后的 app 根目录（用于找内置 bash）
 * @param {string} [opts.platform] 显式平台（测试用）
 * @param {(p:string)=>boolean} [opts.exists] 注入的 existsSync（测试用）
 * @returns {{kind:'bash'|'cmd', file:string, args:(cmd:string)=>string[], origin:'user-installed'|'bundled'|'fallback-cmd', warning?:string, env?:object}}
 */
export function resolveShell({ appRoot = null, platform = process.platform, exists = existsSync } = {}) {
  const isWin = platform === 'win32';

  if (!isWin) {
    // 非 Windows（Linux / macOS）：必须用真正的 bash，**不能返回 /bin/sh**。
    //
    // 为什么不给 /bin/sh：Ubuntu/Debian 的 /bin/sh 是 dash，只支持 POSIX sh。
    // 而 run_command 的工具描述（agent-service.mjs）明确承诺「统一一种 shell 语法」，
    // 模型会写 `[[ ]]`、`for f in "${arr[@]}"`、`$'...'`、`2>/dev/null`、进程替换
    // `<(cmd)` —— 在 dash 下全是语法错误。Windows 侧已经统一到 Git Bash，
    // Linux 侧返回 /bin/sh 就成了「同一个提示词、不同平台不同行为」，
    // 与「一种 shell、一套语法」的设计目标直接矛盾。
    //
    // 解析顺序：/usr/bin/bash → /bin/bash → /usr/local/bin/bash → /opt/homebrew/bin/bash
    //          → （都找不到）回落 /bin/sh 并记 warning（fail-visible，不静默降级）
    const BASH_CANDIDATES = [
      '/usr/bin/bash',          // Linux 标准位置
      '/bin/bash',              // 老发行版 / 部分容器镜像
      '/usr/local/bin/bash',    // 用户自己装的新版 bash（macOS Intel 也常见）
      '/opt/homebrew/bin/bash'  // macOS Apple Silicon Homebrew
    ];
    for (const candidate of BASH_CANDIDATES) {
      let ok = false;
      try { ok = exists(candidate); } catch { ok = false; }
      if (ok) {
        return {
          kind: 'bash',
          file: candidate,
          // 与 Windows 同一口径用 -c 而不是 -lc：-lc 会加载 /etc/profile 与
          // 用户 profile，实测慢 4-5 倍，会触发命令空闲看门狗误判。
          args: (cmd) => ['-c', cmd],
          origin: 'user-installed'
        };
      }
    }
    // 一个 bash 都没有：这台机器跑不了 bash 语法。回落 sh 但要让用户看见。
    return {
      kind: 'bash',
      file: '/bin/sh',
      args: (cmd) => ['-c', cmd],
      origin: 'fallback-cmd', // 复用「降级」这个 origin，下游能据此提示
      warning: '没有找到 bash（/usr/bin/bash、/bin/bash 均不存在），已回落到 /bin/sh。'
        + '若系统是 Ubuntu/Debian，/bin/sh 是 dash：[[ ]]、数组、$\'...\' 等 bash 语法会失败。'
        + '请安装 bash（Debian/Ubuntu: apt install bash；Alpine: apk add bash）。'
    };
  }

  // ① 用户已装
  for (const candidate of USER_GITBASH_CANDIDATES) {
    let ok = false;
    try { ok = exists(candidate); } catch { ok = false; }
    if (ok) {
      return {
        kind: 'bash',
        file: candidate,
        // 用 -c 而不是 -lc：-lc 会加载 /etc/profile 与用户 profile，
        // 实测本机耗时 981ms（-c 只要 195ms）。命令空闲看门狗（默认 120s，
        // 测试里常设 800ms）在启动期间看不到任何输出，会把「还没起来」误判成
        // 「已卡住」并转后台——这是真回归，不是测试问题。
        // 需要 login 语义（读 ~/.bash_profile 的 PATH 等）时由调用方显式 opt-in。
        args: (cmd) => ['-c', cmd],
        origin: 'user-installed'
      };
    }
  }

  // ② 安装包内置的**完整 Git for Windows**（resources/gitbash-full，约 400MB）。
  //    为什么是完整版而不是裁剪版：裁剪版（12MB）两次踩坑都出在「漏了某个 DLL 就
  //    静默 exit 127 零输出」，而完整版自带全部依赖，不需要逐版本重新验证依赖闭包。
  //    CI workflow（verify-gitbash.yml）在干净 runner 上删掉 Git 注册表项后验证过。
  //
  //    appRoot 语义：优先当「resources 目录」（打包后 process.resourcesPath 就是这个），
  //    若那里没有 gitbash-full，再试一层上级（resources 的父目录）。两种都试是为了
  //    不再依赖调用方记住该传哪一层——0.19.0 就是传错层导致内置分支永不命中。
  if (appRoot) {
    const candidates = [
      path.join(appRoot, BUNDLED_GIT_DIR_REL),                                    // resources/gitbash-full
      path.join(appRoot, 'resources', BUNDLED_GIT_DIR_REL)                        // <appRoot>/resources/gitbash-full
    ];
    const gitRoot = candidates.find((p) => {
      try { return exists(path.join(p, 'bin', 'bash.exe')); } catch { return false; }
    });
    if (gitRoot) {
      const bundled = path.join(gitRoot, 'bin', 'bash.exe');
      // 完整版的 bash 在 bin/bash.exe（wrapper），真正的二进制在 usr/bin/bash.exe；
      // 两者都随完整包一起提供，所以直接用 bin/ 这个标准入口即可。
      const usrBin = path.join(gitRoot, 'usr', 'bin');
      // 原生侧目录名随发行变体而变（官方 x64 是 mingw64，GitHub runner 上是 ucrt64），
      // 不能写死；按候选顺序取第一个存在的。
      const nativeBin = ['mingw64', 'ucrt64', 'clang64', 'mingw32']
        .map((n) => path.join(gitRoot, n, 'bin'))
        .find((p) => { try { return existsSync(p); } catch { return false; } }) || path.join(gitRoot, 'mingw64', 'bin');
      const tmpDir = path.join(gitRoot, 'tmp');
      try { mkdirSync(tmpDir, { recursive: true }); } catch { /* 只读安装位置 */ }
      return {
        kind: 'bash',
        file: bundled,
        // -c 而非 -lc：-lc 要加载 profile，实测 ~1s 会让空闲看门狗误判「卡住」
        args: (cmd) => ['-c', cmd],
        origin: 'bundled',
        env: {
          MSYSTEM: 'MINGW64',
          MSYS2_ARG_CONV_EXCL: '*',
          TMPDIR: tmpDir,
          // PATH 用 **Windows 格式**并把内置目录前置（调用方的 PATH 由 shellSpawnSpec 合并）。
          // 换成纯 MSYS 格式（/d/xxx:/usr/bin）会让 cat/grep 全部 exit 127 零输出，
          // 因为 exe 依赖的 DLL 要经 Windows 的 CreateProcess 解析。
          // usr/bin 提供 coreutils；原生 bin（mingw64/ucrt64）提供 git 等原生程序。
          PATH: `${usrBin};${nativeBin};${process.env.PATH || ''}`
        }
      };
    }
  }

  // ③ 回落 cmd（当前发行的默认兜底）
  return {
    kind: 'cmd',
    file: process.env.ComSpec || 'cmd.exe',
    args: (cmd) => ['/d', '/s', '/c', cmd],
    origin: 'fallback-cmd',
    warning: '未检测到 Git Bash，已回落 cmd。建议安装 Git for Windows（AI 在 bash 下语法出错率最低）'
  };
}

/**
 * 给 spawn 用的一体化描述：返回 {file, args, options}，包含 windowsHide 与合并后的 env。
 * @param {object} opts resolveShell 的同名参数 + {cmd, cwd, env}
 */
export function shellSpawnSpec(cmd, { appRoot = null, platform = process.platform, exists = existsSync, cwd = null, env = null } = {}) {
  const shell = resolveShell({ appRoot, platform, exists });
  const baseEnv = env && typeof env === 'object' ? { ...env } : { ...process.env };
  const extraEnv = shell.env || {};
  return {
    file: shell.file,
    args: shell.args(String(cmd ?? '')),
    origin: shell.origin,
    warning: shell.warning || null,
    options: {
      cwd: cwd && exists ? cwd : undefined,
      windowsHide: platform === 'win32',
      env: { ...baseEnv, ...extraEnv }
    }
  };
}
