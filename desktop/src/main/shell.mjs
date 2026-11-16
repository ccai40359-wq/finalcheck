// run_command：coding agent 式命令执行（用户明确要求"能随便使用命令"）
// 三个护栏：灾难命令拦截 / 超时（默认 60s，上限 120s）/ 输出截断
import { spawn } from 'node:child_process'; // 用户实测抓到的漏 import——spawn is not defined
import { existsSync } from 'node:fs';
import { resolveShell } from './shell-resolver.mjs';

const BLOCK_RE = /rm\s+-rf\s+[\/\\]|format\s+[a-z]:\s*$|shutdown|del\s+\/[sq]\s|rd\s+\/s\s/i;

export function isBlocked(command) {
  return BLOCK_RE.test(String(command || ''));
}

export function runCommand(command, { cwd, timeoutMs = 60000, env: envInput, appRoot: appRootForShell = null } = {}) {
  return new Promise((resolve) => {
    const cmd = String(command || '').trim();
    if (!cmd) return resolve({ blocked: false, code: 1, stdout: '', stderr: '命令为空' });
    if (isBlocked(cmd)) return resolve({ blocked: true, code: null, stdout: '', stderr: '命令被安全策略拦截（灾难性操作）' });
    const timeout = Math.min(Math.max(Number(timeoutMs) || 60000, 3000), 120000);
    const isWin = process.platform === 'win32';
    // 可选 env 注入（agent-tools 传脱敏快照）；不传时行为与原来一致（继承 process.env）
    const env = envInput && typeof envInput === 'object' ? { ...envInput } : { ...process.env };
    // 决策 1（2026-11-16）：统一走 Git Bash（用户已装 → 内置 → cmd 回落）。
    // 早期为了保 cmd 语义，这里把 System32 插到 PATH 最前——那条 hack 是 **cmd 专属**：
    // 在 bash 下它会让 Windows 的 find/sort 盖住 GNU 版，`find . -name x` 直接语义错。
    // 所以只在回落 cmd 时保留那段 PATH 调整。
    const shell = resolveShell({ appRoot: appRootForShell });
    if (shell.kind === 'cmd' && isWin) {
      const sys = 'C:\\Windows\\System32;C:\\Windows;';
      const old = env.PATH || env.Path || '';
      env.PATH = sys + old;
      env.Path = env.PATH;
    }
    const spawnFile = shell.file;
    const spawnArgs = shell.args(cmd);
    const spawnEnv = { ...env, ...(shell.env || {}) };
    const proc = spawn(spawnFile, spawnArgs, {
      // 不再用 shell:true：shell 已由 resolver 显式给出，避免二次套壳（cmd 会吃掉引号）
      cwd: cwd && existsSync(String(cwd)) ? String(cwd) : undefined,
      windowsHide: isWin,
      env: spawnEnv
    });
    let out = '', err = '', settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ blocked: false, code, stdout: out.slice(0, 8000), stderr: err.slice(0, 4000) });
    };
    const timer = setTimeout(() => {
      err += '\n[超时已终止]';
      try {
        if (isWin && proc.pid) spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else proc.kill('SIGKILL');
      } catch { /* 已退出 */ }
      done(124); // 不等待子树 close，避免孙进程占住管道导致工具调用悬挂
    }, timeout);
    proc.stdout?.on('data', (d) => { if (out.length < 200000) out += d.toString(); });
    proc.stderr?.on('data', (d) => { if (err.length < 100000) err += d.toString(); });
    proc.on('close', (c) => done(c ?? 0));
    proc.on('error', (e) => { err += e.message; done(1); });
  });
}
