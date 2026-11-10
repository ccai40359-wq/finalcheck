// 异步子进程：Electron 主进程里绝对不能用 spawnSync —— 主线程被卡住时所有 IPC 一起停摆，
// 界面就会显示「未响应」（用户实测：对话跑体检时点模型设置/切会话直接卡死）。
import { spawn } from 'node:child_process';

export function runProcess(cmd, args, { cwd, timeoutMs = 120000, env, maxOut = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ status: null, stdout: '', stderr: '', error: e });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr, error });
    };
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish(124); // 超时：不等待孙进程占住管道
    }, timeoutMs);
    child.stdout?.on('data', (d) => { if (stdout.length < maxOut) stdout += d.toString(); });
    child.stderr?.on('data', (d) => { if (stderr.length < 1024 * 1024) stderr += d.toString(); });
    child.on('close', (c) => finish(c ?? 0));
    child.on('error', (e) => finish(null, e));
  });
}
