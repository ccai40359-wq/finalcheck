// 从仓库根 CHANGELOG.md 抽出指定版本的原始段落，作为 GitHub Release 正文。
// 用法：
//   node scripts/release-notes.mjs 0.13.0                 # 打到 stdout（中文）
//   node scripts/release-notes.mjs 0.13.0 .tmp/notes.md   # 写到文件
//   node scripts/release-notes.mjs 0.13.0 .tmp/notes.md --bilingual
//       中英双语：中文段在前、英文段在后，各带自己的语言标题。
//       英文段从 CHANGELOG.en.md 抽同一版本；缺失就报错退出（不静默只发中文）。
// 发版顺序见根目录 AGENTS.md「发版检查清单」。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogSection } from '../desktop/src/renderer/lib/changelog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const positional = argv.filter((a) => !a.startsWith('--'));
const version = positional[0];
const outFile = positional[1];
const bilingual = flags.includes('--bilingual');

if (!version) {
  console.error('用法: node scripts/release-notes.mjs <version> [输出文件] [--bilingual]');
  process.exit(1);
}

const section = changelogSection(readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
if (!section) {
  console.error(`CHANGELOG.md 里没有找到版本 ${version} 的段落；先补更新记录再发版。`);
  process.exit(2);
}

let body = section;

if (bilingual) {
  const enPath = path.join(ROOT, 'CHANGELOG.en.md');
  let enSection = '';
  if (existsSync(enPath)) {
    enSection = changelogSection(readFileSync(enPath, 'utf8'), version);
  }
  if (!enSection) {
    console.error(`--bilingual 需要 CHANGELOG.en.md 里有版本 ${version} 的段落（中英必须都在，不能只发中文）。`);
    process.exit(3);
  }
  // 中文段保留自己的 `## [x.y.z]` 标题，英文段用同级标题；中间空行分隔。
  body = [
    '<!-- 中文 / Chinese -->',
    '',
    section.replace(/^##\s+\[?v?[^\]]*\]?.*$/m, `## ${version} · 更新内容（中文）`),
    '',
    '---',
    '',
    '<!-- English -->',
    '',
    enSection.replace(/^##\s+\[?v?[^\]]*\]?.*$/m, `## ${version} · What's new (English)`)
  ].join('\n');
}

if (outFile) {
  writeFileSync(path.resolve(process.cwd(), outFile), body + '\n', 'utf8');
  console.log(`已写入 ${outFile}${bilingual ? '（中英双语）' : ''}`);
} else {
  process.stdout.write(body + '\n');
}
