// round8 基准跑批：对三个新仓（fastapi/express/hono）跑 CLI 裸审计，落全量 JSON 供分诊与核验。
// 用法: node scripts/round8-run.mjs <roundDir> [tier=L2]
// 输出: <roundDir>/<repo>-<tier>.json（全量 audit 结果）+ 控制台按关分布
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { audit } from '../src/audit.mjs';

const roundDir = path.resolve(process.argv[2] || 'D:/rcw-geo/.fc-bench2/round8');
const tier = process.argv[3] || 'L2';
const repos = (process.argv[4] || 'fastapi,express,hono').split(',').map((s) => s.trim()).filter(Boolean);

for (const repo of repos) {
  const dir = path.join(roundDir, repo);
  console.log(`\n===== ${repo} (${tier}) =====`);
  const t0 = Date.now();
  let res;
  try {
    res = await audit(dir, { tier, interactive: true, runTests: false }); // 外部靶场不跑其测试
  } catch (err) {
    console.error(`[FAIL] ${repo}:`, err?.message || err);
    writeFileSync(path.join(roundDir, `${repo}-${tier}.json`), JSON.stringify({ repo, tier, error: String(err?.stack || err) }, null, 1));
    continue;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const hits = {};
  for (const f of res.findings) hits[f.checkId] = (hits[f.checkId] || 0) + 1;
  console.log(`结论: ${res.conclusion.verdict} | ${res.conclusion.reason}`);
  console.log(`发现: ${res.findings.length} 条 (${secs}s) | 按关: ${JSON.stringify(hits)}`);
  console.log(`覆盖缺口: ${res.gates.gaps.length}`);
  const actionable = res.findings.filter((f) => ['card', 'block'].includes(f.force) && ['high', 'medium'].includes(f.severity));
  console.log(`可行动(card/block high+medium): ${actionable.length}`);
  writeFileSync(path.join(roundDir, `${repo}-${tier}.json`), JSON.stringify(res, null, 1));
}
console.log('\nROUND8-CLI-DONE');
