// Shell 解析器（决策 1，2026-11-16）：
//   ① 用户已装的 Git Bash（C:\Program Files\Git\bin\bash.exe）→ 用它
//   ② 安装包内置的 12MB 子集（resources/gitbash）→ 用它（干净机器也能跑 bash）
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

/** 内置 bash 相对 appRoot 的位置（当前发行不打包，仅为将来接口保留）。
 * 若将来真要打包：用 usr/bin/bash.exe（真实二进制 2.5MB），不能只用 bin/bash.exe
 * ——后者是 47KB wrapper，会校验完整 Git 安装结构，在精简包里报 `Top-level not found`。 */
export const BUNDLED_BASH_REL = path.join('resources', 'gitbash', 'usr', 'bin', 'bash.exe');

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
    // 非 Windows：直接用系统 shell（/bin/sh），不进 bash 分支
    return {
      kind: 'bash',
      file: '/bin/sh',
      args: (cmd) => ['-c', cmd],
      origin: 'user-installed'
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

  // ② 安装包内置：已实测不可行，保留检测代码但不再打包（见下方说明）
  if (appRoot) {
    const bundled = path.join(appRoot, BUNDLED_BASH_REL);
    let ok = false;
    try { ok = exists(bundled); } catch { ok = false; }
    if (ok) {
      // 内置版可用配置（2026-11-16 CI 验证过的三点，缺一不可）：
      //  ① etc/fstab + etc/msystem 必须一起打包（共 1KB）。缺了它们 cygwin 层
      //     就没有挂载表，`ls /`、重定向、路径映射全部失效。
      //  ② PATH 必须保持 **Windows 格式**（把内置 usr/bin 前置），不能换成
      //     纯 MSYS 格式（`/d/xxx:/usr/bin`）——那样 cat/grep 全部 exit 127 零输出，
      //     因为 exe 依赖的 DLL 要经 Windows 的 CreateProcess 解析。
      //  ③ MSYSTEM=MINGW64 + MSYS2_ARG_CONV_EXCL='*'，否则 /d /s 这类参数被当路径改写。
      const binDir = path.join(appRoot, 'resources', 'gitbash', 'usr', 'bin');
      const tmpDir = path.join(appRoot, 'resources', 'gitbash', 'tmp');
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
          // 内置 bin 前置到 Windows 格式 PATH（调用方的 PATH 由 shellSpawnSpec 合并）
          PATH: `${binDir};${process.env.PATH || ''}`
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
