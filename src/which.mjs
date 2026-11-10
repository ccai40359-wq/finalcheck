import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.tools');

export function findBinary(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const local = path.join(TOOLS_DIR, exe);
  if (existsSync(local)) return local;
  if (spawnSync(name, ['--version'], { encoding: 'utf8' }).status === 0) return name;
  return null;
}
