// Windows ACL 受限令牌沙箱适配（dsh-sandbox-windows-acl, BSD-3-Clause）。
// - 只在 Windows 上启用；包不可用/平台不支持 → 返回 null，由调用方决定 fail-open 还是 fail-closed。
// - runner 是 argv 前缀：node runner.js --workspace ... --temp ... --mode ... -- <argv>
// - 文件写入/删除被限制在 workspace + 私有 temp；读/网络/进程可见性不在该后端范围（诚实标注）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { appCacheDir } from './platform-paths.mjs';

const require = createRequire(import.meta.url);

let runnerPath = null;
let runnerError = '';
try {
  runnerPath = require.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner');
} catch (e) {
  runnerError = e?.message || String(e);
}

export const SANDBOX_PACKAGE = '@deepseek-ai/dsh-sandbox-windows-acl';

/** 沙箱是否可用（Windows + runner 可解析）。 */
export function sandboxAvailability() {
  return {
    available: process.platform === 'win32' && !!runnerPath,
    platform: process.platform,
    runner: runnerPath,
    error: runnerError || null
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
 * 构造一次沙箱执行：返回 { file, args, cwd, env, tempDir, cleanup } 或 null。
 * @param {{workspaceRoot:string, policyMode:string, command:string, cwd?:string}} opts
 */
export function createSandboxedRun({ workspaceRoot, policyMode, command, cwd = null }) {
  if (process.platform !== 'win32' || !runnerPath) return null;
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
