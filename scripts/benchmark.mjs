// 打靶脚本：对任意目标跑全量验收，输出按关命中分布（§6 召回指标）
// 用法: node scripts/benchmark.mjs <targetDir> [tier=L3]
import { audit } from '../src/audit.mjs';

const target = process.argv[2];
if (!target) { console.error('用法: node scripts/benchmark.mjs <targetDir> [tier=L3]'); process.exit(2); }
const tier = process.argv[3] || 'L3';
const res = await audit(target, { tier, interactive: true, runTests: false }); // 外部靶场：§7 禁跑其测试
const hits = {};
for (const f of res.findings) hits[f.checkId] = (hits[f.checkId] || 0) + 1;
const rules = {};
for (const f of res.findings) { const k = `${f.checkId}/${f.rule}`; rules[k] = (rules[k] || 0) + 1; }
console.log('目标:', target);
console.log('档位:', tier, '| 结论:', res.conclusion.verdict, '|', res.conclusion.reason);
console.log('覆盖关:', res.gates.executed.join(', '), '| 覆盖缺口:', res.gates.gaps.length);
console.log('按关命中:', JSON.stringify(hits));
console.log('按规则明细:', JSON.stringify(rules));
console.log('发现总数:', res.findings.length);
