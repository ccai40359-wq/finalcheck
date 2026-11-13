// CI 自审闸：FinalCheck 报告里不能有未豁免的 high/card finding。
// 用法：node scripts/check-self-audit.mjs <report.json>
import fs from 'node:fs';

const file = process.argv[2] || 'self-audit.json';
let report;
try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
  console.error(`读不到自审报告 ${file}：${e.message}`);
  process.exit(1);
}
const findings = Array.isArray(report?.findings) ? report.findings : [];
const blocking = findings.filter((f) => String(f?.severity) === 'high' && String(f?.force) !== 'tip');
console.log(`self-audit: findings=${findings.length}，high(非 tip)=${blocking.length}，verdict=${report?.conclusion?.verdict || '?'}`);
for (const f of blocking.slice(0, 20)) console.log(`  ${f.rule} ${f.file}:${f.line} force=${f.force}`);
if (blocking.length) {
  console.error('自审出现未豁免的高危 finding，CI 拒绝通过');
  process.exit(1);
}
