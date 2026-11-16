// Shell 解析器（决策 1，2026-11-16）：
//   ① 用户已装的 Git Bash（C:\Program Files\Git\bin\bash.exe）→ 用它
//   ② 安装包内置（已实测不可行，当前不打包，仅为将来留接口）
//   ③ 回落 cmd.exe（都没有时；记 warning 并在 UI 提示）
//
// 为什么选 Git Bash：AI 在 bash 语法下出错率明显低于 cmd——
// cmd 与 PowerShell 的引号/转义/管道规则各不相同，模型经常混用（`cat` 写成 `type`、
// `2>/dev/null` 写成 `2>nul`）；bash 是训练语料里最常见、模型最熟的一种。
//
// 为什么没打包内置 bash（2026-11-16 实测，与方案预期不同）：
//   「bash.exe + msys-2.0.dll + 十几个 coreutils」这个 5-7MB 最小子集在干净机器上
//   起不来：bash 能启动、内建命令（echo/pwd/BASH_VERSION）正常，但 `ls`、`cat`、`grep`
//   全部 command not found，`ls /` 也是空输出。根因是 MSYS 运行时依赖完整安装树的
//   路径映射与 mount 机制（usr/lib、/etc/fstab 等约 24MB+）。为「干净机器也能用 bash」
//   付这个体积与逐版本验证成本不划算 —— 绝大多数开发机已装 Git for Windows。
//
// 注意：这里只负责「用哪个 shell 起子进程」。窗口隐藏策略（sandboxWindowMode 的三段重试）
// 不在本模块，保持原样不动。

import { existsSync } from 'node:fs';
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
      // 只有在确实打包了完整 Git Bash 结构时才走到这里。当前发行版**不打包**：
      // 2026-11-16 实测结论——「bash.exe + msys-2.0.dll + 十几个 exe」这个最小子集
      // 在干净机器上跑不起来：bash 能启动、内建命令能用（echo/pwd/BASH_VERSION 正常），
      // 但 ls/cat/grep 全部 command not found，连 `ls /` 都是空输出。
      // 根因是 MSYS 运行时依赖完整安装树的路径映射与 mount 机制（/etc/fstab 等），
      // 缺了之后 cygwin 层无法把 Windows 路径映射成 /c/、/cygdrive/c/ 两种形式，
      // 重定向写文件也会失败。要打包就得带上 usr/lib 等约 24MB+ 的额外文件，
      // 且要逐版本验证——不值得为「干净机器也能用 bash」付这个复杂度。
      // 取舍：检测用户已装的 Git for Windows（绝大多数开发机都有），没有就回落 cmd 并提示。
      return {
        kind: 'bash',
        file: bundled,
        args: (cmd) => ['-c', cmd],
        origin: 'bundled'
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
