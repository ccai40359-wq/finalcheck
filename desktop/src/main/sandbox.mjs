// 沙箱后端分流（2026-11-20）：
//   · Windows        → ACL 受限令牌（dsh-sandbox-windows-acl，只拦写）
//   · Linux / macOS  → bubblewrap / Seatbelt（@anthropic-ai/sandbox-runtime，读写都能拦）
//
// 两个后端的调用契约**不同**，这是要特别注意的地方：
//   · Windows 返回 { file, args } —— 直接 spawn，argv 形式
//   · Linux   返回 { command }    —— 是**一条 shell 命令字符串**，要用 shell 跑
//   Linux 这侧必须由 agent-tools 用 shell 执行，不能再按 argv 拼接。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { appCacheDir } from './platform-paths.mjs';
import { probeSandbox, linuxSandboxOptionsOf, sandboxCwdOf, wrapCommand } from './sandbox-linux.mjs';

const require = createRequire(import.meta.url);

let runnerPath = null;
let runnerError = '';
try {
  runnerPath = require.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner');
} catch (e) {
  runnerError = e?.message || String(e);
}

export const SANDBOX_PACKAGE = '@deepseek-ai/dsh-sandbox-windows-acl';
export const LINUX_SANDBOX_PACKAGE = '@anthropic-ai/sandbox-runtime';

// Linux/macOS 的可用性探测是异步的（要真去查 bwrap/socat），
// 这里缓存在模块级：探测一次，之后同步读结果。失败也缓存，避免每次命令都卡 5 秒。
let linuxProbe = null;       // { available, reason, hint } | null
let linuxProbePromise = null;

/** 触发（或复用）Linux 沙箱探测。调用方可在启动时就预热。 */
export function ensureLinuxSandboxProbe() {
  if (linuxProbe) return Promise.resolve(linuxProbe);
  if (!linuxProbePromise) {
    linuxProbePromise = probeSandbox()
      .then((r) => { linuxProbe = r; return r; })
      .catch((e) => { linuxProbe = { available: false, platform: process.platform, reason: String(e?.message || e) }; return linuxProbe; });
  }
  return linuxProbePromise;
}

/**
 * 沙箱是否可用。
 * Windows 结果同步；Linux/macOS 用最近一次探测结果（未探测过则视为不可用，
 * 调用方应先 ensureLinuxSandboxProbe）。
 */
export function sandboxAvailability() {
  if (process.platform === 'win32') {
    return {
      available: !!runnerPath,
      platform: 'win32',
      backend: 'windows-acl',
      runner: runnerPath,
      error: runnerError || null
    };
  }
  return {
    available: linuxProbe?.available === true,
    platform: process.platform,
    backend: process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap',
    runner: LINUX_SANDBOX_PACKAGE,
    error: linuxProbe?.reason || null,
    hint: linuxProbe?.hint || null
  };
}

function modeOf(policyMode) {
  if (policyMode === 'readonly') return 'read-only';
  if (policyMode === 'workspace') return 'workspace-write';
  return null; // off：用户明确放开边界，不用沙箱
}

// 受限令牌拿不到「命名管道写权限」（Node 的 stdio:pipe）和 cygwin 的共享内存，
// 实测 node --test / npm test 静默失败（EPERM），Git Bash 的 grep/cat/head 直接 fatal。
// Codex 的 Windows restricted-token 沙箱同样报 spawn EPERM —— 这是这类沙箱的共性，不是本包缺陷。
// 因此这些命令改在宿主机执行（应用层路径策略/命令黑名单/审批仍然生效），而不是让它们失败。
const INCOMPATIBLE_HEADS = new Set([
  // Node 工具链（都会用命名管道捕获孙进程输出）
  'node', 'nodejs', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno', 'tsx', 'ts-node', 'tsc',
  'jest', 'vitest', 'mocha', 'ava', 'playwright',
  // CPython 用匿名管道捕获子进程（实测可用），pip 安装也是沙箱该管的写入，故不列入。
  // shell / cygwin 工具（CreateFileMapping 在受限令牌下失败）
  'bash', 'sh', 'dash', 'zsh', 'fish', 'busybox',
  'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'gawk', 'head', 'tail', 'cat', 'less',
  'wc', 'cut', 'tr', 'tee', 'xargs', 'uniq', 'diff', 'patch', 'tar', 'gzip',
  'rm', 'mv', 'cp', 'ln', 'ls', 'mkdir', 'rmdir', 'chmod', 'chown', 'touch', 'stat',
  // 2026-11-17 追加：这几个在 cmd 里**存在但语义完全不同**，比「不存在」更危险——
  // 模型写 GNU 语法会拿到静默错误的结果，而不是一个明显的报错（实测确实发生过）：
  //   find  : cmd 的 find.exe 是文本查找（≈grep），不认 `find . -name x`
  //   sort  : cmd 的 sort.exe 按字符排序单列文本，不认 `-n` / `-k` 等 GNU 选项
  //   which / uname : cmd 里没有（cmd 只有 where），bash 里很常用
  // 命中后改走宿主机 Git Bash，语义才对。
  'find', 'sort', 'which', 'uname'
]);

const SHELL_SPLIT = /\|\||&&|\||;|&|\r?\n/;

/** 命令是否能在 ACL 沙箱里跑：逐段看每个管道的第一个词，命中不兼容清单就改走宿主机。 */
export function sandboxCompatible(command) {
  // 2026-11-20 Linux 移植：这份不兼容清单是**Windows ACL 受限令牌专属**的
  // （受限令牌下拿不到命名管道写权限与 cygwin 共享内存，node/npm/grep 会静默 EPERM）。
  // Linux 的 bwrap 沙箱没有这个限制——`node`、`npm`、`grep` 在 bubblewrap 里都能正常跑。
  // 如果不在这里短路，Linux 上会把这些命令误判成「沙箱不支持」，
  // 结果是它们统统跳过沙箱直接落到宿主机 → 沙箱形同虚设（安全降级，静默发生）。
  if (process.platform !== 'win32') return { compatible: true, reason: null };
  const text = String(command || '');
  for (const raw of text.split(SHELL_SPLIT)) {
    const seg = raw.trim();
    if (!seg) continue;
    const first = seg.split(/\s+/)[0].replace(/^["']/, '').replace(/["']$/, '');
    const base = first.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1|mjs|cjs|js)$/i, '').toLowerCase();
    if (INCOMPATIBLE_HEADS.has(base)) {
      return { compatible: false, reason: `${base} 需要命名管道/cygwin 共享内存，受限令牌下会失败` };
    }
  }
  return { compatible: true, reason: null };
}

function tempDirFor(workspaceRoot) {
  const candidates = [
    path.join(os.tmpdir(), 'fc-sandbox'),
    // 回落目录走 appCacheDir：Linux 是 ~/.cache/FinalCheck（XDG），macOS 是
    // ~/Library/Caches/FinalCheck。旧实现硬写 LOCALAPPDATA||homedir 的
    // 'FinalCheck/sandbox-tmp'，在 Linux 上会落在 ~/FinalCheck/sandbox-tmp——
    // 家目录根上多出一个不像应用目录的文件夹。
    path.join(appCacheDir(), 'sandbox-tmp')
  ];
  for (const base of candidates) {
    try {
      fs.mkdirSync(base, { recursive: true });
      const dir = fs.mkdtempSync(path.join(base, 'run-'));
      // dsh runner 拒绝 workspace 包含 temp root 的组合；换一个 base 再试。
      const rel = path.relative(path.resolve(workspaceRoot), dir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return dir;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* 试下一个 */ }
  }
  throw new Error('无法创建沙箱私有 temp 目录');
}

/**
 * 构造一次沙箱执行。
 *
 * 两个后端的返回形状不同，调用方必须分流：
 *   · Windows → { file, args, cwd, env, tempDir, cleanup }  用 spawn(file, args)
 *   · Linux   → { command, cwd, env, cleanup, backend:'bubblewrap' }
 *               command 是一条 **shell 命令字符串**，要交给 shell 跑（不能当 argv）
 *
 * @param {{workspaceRoot:string, policyMode:string, command:string, cwd?:string, cfg?:object}} opts
 * @returns {null | {file:string,args:string[],cwd:string,env?:object,tempDir?:string,cleanup:()=>void}
 *                | Promise<{command:string,cwd:string,env?:object,cleanup:()=>void,backend:string}>}
 */
export function createSandboxedRun({ workspaceRoot, policyMode, command, cwd = null, cfg = null }) {
  if (process.platform !== 'win32') {
    // 非 Windows：异步（initialize 要起代理）。调用方需要 await。
    if (linuxProbe?.available !== true) return null; // 未探测或不可用：降级到宿主机（调用方决定）
    const mode = modeOf(policyMode);
    if (!mode) return null; // off：用户明确放开，不用沙箱
    return createLinuxSandboxedRun({ workspaceRoot, policyMode, command, cwd, cfg, mode });
  }
  if (!runnerPath) return null;
  const mode = modeOf(policyMode);
  if (!mode) return null;
  const root = path.resolve(String(workspaceRoot || cwd || '.'));
  const tempDir = tempDirFor(root);
  // 沙箱路径**必须**继续用 cmd（2026-11-16 实测结论，与决策 1 的预期不同）：
  // 受限令牌（restricted token + 低完整性）下 msys-2.0.dll 无法 CreateFileMapping，
  // bash 一启动就 fatal：`bash.exe: *** fatal error - CreateFileMapping ..., Win32 error 5`
  // （Git Bash 需要进程间共享内存来跑 fork/pipe，受限令牌没这个权限）。
  // 所以分工是：宿主机命令走 Git Bash（决策 1），沙箱内命令走 cmd（这里保持原样）。
  // 这不是妥协而是物理约束；想统一成 bash 得先换成支持读隔离的真容器（WSL/Docker）。
  // 早期用 cmd /c 的理由是「cmd 对内联引号处理不可靠，写成 .cmd 批处理更稳」——对 cmd 成立。
  const scriptPath = path.join(tempDir, 'run.cmd');
  fs.writeFileSync(scriptPath, `@echo off\r\n${String(command)}\r\n`, 'utf8');
  // Source files are shipped under extraResources in packaged builds; import.meta
  // points at out/main/index.js after bundling, so resolve that layout explicitly.
  const packagedWrapper = process.resourcesPath && path.join(process.resourcesPath, 'desktop', 'src', 'main', 'sandbox-runner.mjs');
  const wrapper = packagedWrapper && fs.existsSync(packagedWrapper)
    ? packagedWrapper : fileURLToPath(new URL('./sandbox-runner.mjs', import.meta.url));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 后台进程可能仍占用 */ }
  };
  return {
    file: process.execPath,
    // `--` 之后是要交给受限子进程执行的「shell + 脚本路径」。
    // 沙箱内固定 cmd（见上面注释：受限令牌下 bash 起不来）。
    args: [wrapper, runnerPath, '--workspace', root, '--temp', tempDir, '--mode', mode, '--', process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', scriptPath],
    cwd: cwd || root,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    tempDir,
    mode,
    workspaceRoot: root,
    cleanup
  };
}

/**
 * Linux / macOS 沙箱（bubblewrap / Seatbelt，对齐 Claude Code）。
 *
 * 与 Windows 后端的三个关键差异：
 *   1. 返回的 command 是 **shell 字符串**，调用方必须走 shell 执行；
 *   2. 读写都能拦（bwrap 用 --tmpfs 盖住 denyRead 目录），比 Windows 那套只拦写更强；
 *   3. initialize 要起代理进程，是异步的，所以整个函数是 async。
 *
 * readonly 模式下不允许任何写入：把 allowWrite 清空（bwrap 的写是 allow-only 语义，
 * 空列表 = 全拒）。
 */
async function createLinuxSandboxedRun({ workspaceRoot, policyMode, command, cwd, cfg, mode }) {
  const root = sandboxCwdOf(workspaceRoot || cwd, process.cwd());
  const opts = linuxSandboxOptionsOf(cfg || {});
  if (mode === 'read-only') {
    // readonly：连工作目录也不给写。只保留 /tmp（很多工具会写临时文件，
    // 不给的话编译/测试全失败；/tmp 里的东西本来就不是持久数据）。
    opts.filesystem.allowWrite = ['/tmp'];
  } else {
    // workspace-write：把工作目录本身加进允许写列表（默认只放了 '.'，
    // bwrap 需要绝对路径）
    opts.filesystem.allowWrite = [...new Set([root, ...opts.filesystem.allowWrite.map((p) => (p === '.' ? root : p))])];
  }
  const shellPath = process.env.SHELL && /bash/.test(process.env.SHELL) ? process.env.SHELL : '/usr/bin/bash';
  const wrapped = await wrapCommand({
    command: String(command || ''),
    cwd: root,
    config: opts,
    shellPath,
    commandId: `fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  });
  return {
    command: wrapped.command,   // shell 字符串
    backend: process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap',
    cwd: root,
    mode,
    workspaceRoot: root,
    // Linux 沙箱没有私有 temp 要清；代理是全局的，由 releaseSandbox 统一释放
    cleanup: () => { /* 单次命令无需清理 */ }
  };
}
