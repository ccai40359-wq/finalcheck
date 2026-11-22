// winapp CLI（微软官方 microsoft/winappcli，可选增强）运行时探测——0.29.7-beta。
// 绝不硬依赖：探测不到 → 捕获链跳过 ② 级直接走 ③ screen 兜底，全链路照常工作。
// 探测顺序：where.exe winapp（PATH）→ npm 全局目录（%APPDATA%\npm\winapp.cmd）。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let cached; // undefined = 未探测；null = 不可用；{ exe, via } = 可用
let probing = null;

export function resetWinappCache() {
  cached = undefined;
  probing = null;
}

export function winappCandidatePaths(homeDir = os.homedir()) {
  if (process.platform !== 'win32') return [];
  const npmBin = path.join(homeDir, 'AppData', 'Roaming', 'npm');
  return [path.join(npmBin, 'winapp.cmd'), path.join(npmBin, 'winapp')];
}

/** 探测结果进程内缓存（首次调用探测一次；测试用 resetWinappCache 清）。 */
export async function detectWinapp() {
  if (cached !== undefined) return cached;
  probing ??= (async () => {
    try {
      const { stdout } = await execFileAsync('where.exe', ['winapp'], { timeout: 8000, windowsHide: true });
      const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (first) {
        cached = { exe: first, via: 'where' };
        return cached;
      }
    } catch { /* PATH 上没有 winapp */ }
    for (const p of winappCandidatePaths()) {
      try {
        if (existsSync(p)) {
          cached = { exe: p, via: 'npm-global' };
          return cached;
        }
      } catch { /* 忽略单个候选路径的错误 */ }
    }
    cached = null;
    return cached;
  })();
  return probing;
}

/** ② 级命令组装（纯函数）：winapp ui screenshot --hwnd <hwnd> --out <file>。
 *  默认 WGC 可拍遮挡窗，旧系统回退 PrintWindow；--capture-screen 才是拍屏幕（我们不用）。 */
export function winappScreenshotCommand(exe, hwnd, outPath) {
  return { file: exe, args: ['ui', 'screenshot', '--hwnd', String(hwnd), '--out', outPath] };
}
