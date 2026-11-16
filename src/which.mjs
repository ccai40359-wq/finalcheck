import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.tools');

export function findBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const local = path.join(TOOLS_DIR, exe);
  if (existsSync(local)) return local;
  // windowsHide 必须传：Electron 主进程没有控制台，spawnSync 起控制台程序会新建一个
  // 可见命令行窗口（round9 用户在"正在工作时疯狂弹窗"的真因之一：每次审计都探测检查器）。
  if (spawnSync(name, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).status === 0) return name;
  return null;
}
