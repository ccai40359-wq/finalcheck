// Windows ACL 受限令牌沙箱适配（dsh-sandbox-windows-acl, BSD-3-Clause）。
// - 只在 Windows 上启用；包不可用/平台不支持 → 返回 null，由调用方决定 fail-open 还是 fail-closed。
// - runner 是 argv 前缀：node runner.js --workspace ... --temp ... --mode ... -- <argv>
// - 文件写入/删除被限制在 workspace + 私有 temp；读/网络/进程可见性不在该后端范围（诚实标注）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

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

function tempDirFor(workspaceRoot) {
  const candidates = [
    path.join(os.tmpdir(), 'fc-sandbox'),
    path.join(process.env.LOCALAPPDATA || os.homedir(), 'FinalCheck', 'sandbox-tmp')
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
  // cmd /c 对内联引号的处理不可靠（node -e "..." 会被吞掉）；把命令写成私有 temp 里的
  // .cmd 批处理再交给 cmd /c，引号/重定向/多行都按 cmd 的批处理语义解析。
  const scriptPath = path.join(tempDir, 'run.cmd');
  fs.writeFileSync(scriptPath, `@echo off\r\n${String(command)}\r\n`, 'utf8');
  const runnerArgs = [
    runnerPath,
    '--workspace', root,
    '--temp', tempDir,
    '--mode', mode,
    '--',
    'cmd.exe', '/d', '/s', '/c', scriptPath
  ];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 后台进程可能仍占用 */ }
  };
  return {
    file: process.execPath,
    args: runnerArgs,
    cwd: cwd || root,
    // Electron 的 execPath 默认是 GUI；ELECTRON_RUN_AS_NODE=1 让它按 Node 跑 runner
    env: { ELECTRON_RUN_AS_NODE: '1' },
    tempDir,
    mode,
    workspaceRoot: root,
    cleanup
  };
}
