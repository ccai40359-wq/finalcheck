// 校验 .finalcheck/accept.json：每条豁免的文件存在，且行指纹能在当前文件里定位。
// 用法：node scripts/check-accept-entries.mjs [项目根]
import fs from 'node:fs';
import path from 'node:path';
import { lineFingerprint } from '../src/accept.mjs';

const root = path.resolve(process.argv[2] || process.cwd());
const file = path.join(root, '.finalcheck', 'accept.json');
if (!fs.existsSync(file)) {
  console.log('accept.json 不存在，跳过');
  process.exit(0);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
  console.error('accept.json 不是合法 JSON：' + e.message);
  process.exit(1);
}
const entries = Array.isArray(cfg?.entries) ? cfg.entries : [];
let bad = 0;
let moved = 0;
for (const [i, e] of entries.entries()) {
  const label = `#${i + 1} ${e?.rule} ${e?.file}:${e?.line}`;
  if (!e?.file || !e?.hash) { console.error('缺少 file/hash：' + label); bad += 1; continue; }
  const abs = path.join(root, String(e.file));
  if (!fs.existsSync(abs)) { console.error('文件不存在：' + label); bad += 1; continue; }
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const found = lines.filter((line) => lineFingerprint(line) === String(e.hash).toLowerCase());
  if (!found.length) { console.error('行指纹已失效：' + label); bad += 1; continue; }
  const declaredOk = lineFingerprint(lines[Number(e.line) - 1] || '') === String(e.hash).toLowerCase();
  if (!declaredOk) { moved += 1; console.log('行已移动但仍可定位：' + label + `（当前 ${lines.findIndex((line) => lineFingerprint(line) === String(e.hash).toLowerCase()) + 1} 行）`); }
}
console.log(`accept entries: ${entries.length}，失效 ${bad}，行移动 ${moved}`);
if (bad) process.exit(1);
