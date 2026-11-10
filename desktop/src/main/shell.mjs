// run_command：coding agent 式命令执行（用户明确要求"能随便使用命令"）
// 三个护栏：灾难命令拦截 / 超时（默认 60s，上限 120s）/ 输出截断
import { spawn } from 'node:child_process'; // 用户实测抓到的漏 import——spawn is not defined
import { existsSync } from 'node:fs';

const BLOCK_RE = /rm\s+-rf\s+[\/\\]|format\s+[a-z]:\s*$|shutdown|del\s+\/[sq]\s|rd\s+\/s\s/i;

export function isBlocked(command) {
  return BLOCK_RE.test(String(command || ''));
}

export function runCommand(command, { cwd, timeoutMs = 60000, env: envInput } = {}) {
  return new Promise((resolve) => {
    const cmd = String(command || '').trim();
    if (!cmd) return resolve({ blocked: false, code: 1, stdout: '', stderr: '命令为空' });
    if (isBlocked(cmd)) return resolve({ blocked: true, code: null, stdout: '', stderr: '命令被安全策略拦截（灾难性操作）' });
    const timeout = Math.min(Math.max(Number(timeoutMs) || 60000, 3000), 120000);
    const isWin = process.platform === 'win32';
    // 可选 env 注入（agent-tools 传脱敏快照）；不传时行为与原来一致（继承 process.env）
    const env = envInput && typeof envInput === 'object' ? { ...envInput } : { ...process.env };
    if (isWin) {
      // Git Bash 的 find/sort/more 会抢先命中 PATH，导致 `find /c /v ""` 这类 cmd 语法卡死；
      // 把 System32 放到最前，保证 run_command 真的按 Windows cmd 语义执行
      const sys = 'C:\\Windows\\System32;C:\\Windows;';
      const old = env.PATH || env.Path || '';
      env.PATH = sys + old;
      env.Path = env.PATH;
    }
    const proc = spawn(cmd, {
      shell: true,
      cwd: cwd && existsSync(String(cwd)) ? String(cwd) : undefined,
      windowsHide: isWin,
      env
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
