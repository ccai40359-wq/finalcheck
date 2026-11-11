// 从仓库根 CHANGELOG.md 抽出指定版本的原始段落，作为 GitHub Release 正文。
// 用法：
//   node scripts/release-notes.mjs 0.13.0                 # 打到 stdout
//   node scripts/release-notes.mjs 0.13.0 .tmp/notes.md   # 写到文件
// 发版顺序见根目录 AGENTS.md「发版检查清单」。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogSection } from '../desktop/src/renderer/lib/changelog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
const outFile = process.argv[3];

if (!version) {
  console.error('用法: node scripts/release-notes.mjs <version> [输出文件]');
  process.exit(1);
}

const section = changelogSection(readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
if (!section) {
  console.error(`CHANGELOG.md 里没有找到版本 ${version} 的段落；先补更新记录再发版。`);
  process.exit(2);
}

if (outFile) {
  writeFileSync(path.resolve(process.cwd(), outFile), section + '\n', 'utf8');
  console.log(`已写入 ${outFile}`);
} else {
  process.stdout.write(section + '\n');
}
