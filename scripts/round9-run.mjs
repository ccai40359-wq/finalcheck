// round9：按 2026 Stack Overflow 使用率榜单，跑各框架经典项目的 FC 完全体
// 用法: node scripts/round9-run.mjs <roundDir> [tier=L2] repo1,repo2,...
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { audit } from '../src/audit.mjs';

const roundDir = path.resolve(process.argv[2] || 'D:/rcw-geo/.fc-bench2/round9');
const tier = process.argv[3] || 'L2';
const repos = (process.argv[4] || '').split(',').map((s) => s.trim()).filter(Boolean);

for (const repo of repos) {
  const dir = path.join(roundDir, repo);
  console.log(`\n===== ${repo} (${tier}) =====`);
  const t0 = Date.now();
  let res;
  try {
    res = await audit(dir, { tier, interactive: true, runTests: false });
  } catch (err) {
    console.error(`[FAIL] ${repo}:`, err?.message || err);
    writeFileSync(path.join(roundDir, `${repo}-${tier}.json`), JSON.stringify({ repo, tier, error: String(err?.stack || err) }, null, 1));
    continue;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const hits = {};
  for (const f of res.findings) hits[f.checkId] = (hits[f.checkId] || 0) + 1;
  const actionable = res.findings.filter((f) => ['card', 'block'].includes(f.force) && ['high', 'medium'].includes(f.severity));
  console.log(`结论: ${res.conclusion.verdict} | ${String(res.conclusion.reason || '').slice(0, 140)}`);
  console.log(`发现: ${res.findings.length} 条 (${secs}s) | 可行动: ${actionable.length}`);
  console.log(`按关: ${JSON.stringify(hits)}`);
  console.log(`覆盖缺口: ${res.gates.gaps.length}`);
  writeFileSync(path.join(roundDir, `${repo}-${tier}.json`), JSON.stringify(res, null, 1));
}
console.log('\nROUND9-CLI-DONE');
