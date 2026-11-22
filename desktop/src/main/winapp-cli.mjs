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

/** ② 级命令组装（纯函数）。winapp v0.8.0 真实参数（核实到源码 UiScreenshotCommand.cs）：
 *  -w/--window <十进制或 0x hwnd>、-o/--output <file>、--json（返回 FilePath/Width/Height/Hwnd）。
 *  ⚠️ 曾写成 --hwnd/--out（这两个参数不存在）→ 未知参数被拒、②级永远失败（0.29.8 真 bug）。
 *  ⚠️ 目标最小化时 winapp 会先 SW_RESTORE 再拍（改变窗口可见状态）——调用方必须按 IsIconic
 *  直落③级，否则会打扰用户（computer-use.mjs 已如此）。
 *  默认 WGC 可拍遮挡窗、旧系统回退 PrintWindow；--capture-screen 是拍屏幕（我们不用）。 */
export function winappScreenshotCommand(exe, hwnd, outPath) {
  return { file: exe, args: ['ui', 'screenshot', '-w', String(hwnd), '-o', outPath, '--json'] };
}

/** 解析 winapp screenshot 的 --json 输出（容错：非 JSON 或无尺寸=null）。
 *  返回 { filePath, width, height }——用于尺寸校验，防黑图/拍错窗被当成功。 */
export function parseWinappScreenshotJson(stdout) {
  try {
    const j = JSON.parse(String(stdout || '').trim());
    const w = Number(j?.Width);
    const h = Number(j?.Height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { filePath: String(j?.FilePath || ''), width: w, height: h };
  } catch { return null; }
}
