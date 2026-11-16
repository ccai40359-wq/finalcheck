// round9 完全体：对每个仓的发现做 AI 分诊（用 opendesignM）
// 复用 scripts/ai-triage-bench.mjs 的逻辑，但 provider 从用户真实配置读 opendesignM
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';

const roundDir = process.env.ROUND_DIR || 'D:/rcw-geo/.fc-bench2/round9';
const repos = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
const SAMPLE = Number(process.env.SAMPLE || 10);

// provider：直接用用户已装配置里的 opendesignM
const cfgRaw = JSON.parse(readFileSync(path.join(process.env.APPDATA, 'FinalCheck', 'config.json'), 'utf8'));
const prov = cfgRaw.providers.find((p) => p.id === 'p-mw7gt125-xtbip');
if (!prov?.models?.length) { console.error('找不到 opendesignM'); process.exit(2); }
const model = prov.models[0].id || prov.models[0];
console.log(`[provider] ${prov.name || prov.id} model=${model}`);

for (const repo of repos) {
  const repoDir = path.join(roundDir, repo);
  const auditPath = path.join(roundDir, `${repo}-L2.json`);
  if (!existsSync(auditPath)) { console.log(`[skip] ${repo}: 无审计结果`); continue; }

  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  // 采样：优先可行动项，不足则按 severity/force 排序补足，同规则最多 2 条
  const all = (audit.findings || []).slice();
  const sevRank = { high: 0, medium: 1, low: 2, info: 3 };
  const forceRank = { block: 0, card: 1, check: 2, tip: 3 };
  all.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9) || (forceRank[a.force] ?? 9) - (forceRank[b.force] ?? 9));
  const byRule = new Map();
  const picked = all.filter((f) => {
    const c = byRule.get(f.rule) || 0;
    if (c >= 2) return false;
    byRule.set(f.rule, c + 1);
    return true;
  }).slice(0, SAMPLE);
  if (!picked.length) { console.log(`[skip] ${repo}: 无发现`); continue; }

  const compact = picked.map((f, i) => ({
    n: i + 1, rule: f.rule, severity: f.severity, force: f.force,
    file: f.file, line: f.line,
    snippet: String(f.snippet || '').slice(0, 100),
    message: String(f.message || '').slice(0, 120),
  }));

  const tools = createAgentTools({
    repoRoot: repoDir,
    requireAuditIntent: false,
    permissions: {
      noteTarget() {}, sessionAllowed: () => false,
      commandPrefix: (cmd) => String(cmd).split(/\s+/)[0],
      requestApproval: async () => 'denied',
    },
  });

  const prompt = [
    `你是 FinalCheck 的分诊员。项目目录：${repoDir}`,
    `静态审计已完成，下面是 ${compact.length} 条采样发现。`,
    `工具预算硬上限：最多 12 次工具调用，用完必须立即输出结论 JSON。默认信已给的 snippet，只有 snippet 本身可疑才读文件（读命中行 ±40 行，禁止整文件通读）。证据不足判 unclear。`,
    `判定标准：`,
    `- TP：真实问题，应该修`,
    `- FP：误报。只有六种事实性理由（每个都要引用行号证据）：`,
    `  1) 命中文件不存在（必须先用 read_file 验证过不存在）`,
    `  2) 命中值不是真实凭据（占位/示例/空值；引用时脱敏）`,
    `  3) 路径不可达（有白名单/守卫/解析闸，引用行号）`,
    `  4) 命中行位于 tests/examples/docs 等非产品路径`,
    `  5) 命中处不是可执行代码（docstring/注释/纯文本）`,
    `  6) 该行为是被审库/框架自身的设计特性，攻击面不在产品边界内`,
    `禁止理由：「教学/示例仓库所以不算」「README 已说明」。`,
    `拿不准 → unclear。FP 是高成本动作。`,
    `输出一个 JSON 数组（不要输出其他文字），每条：`,
    `{"n":1,"rule":"...","file":"...","line":0,"verdict":"TP|FP|unclear","evidence":"file:line + 关键代码事实","reason":"≤60字"}`,
    `发现的清单：`,
    JSON.stringify(compact, null, 1),
  ].join('\n');

  console.log(`\n===== 分诊 ${repo} (${compact.length} 条) =====`);
  const started = Date.now();
  const out = await runAgentTurn({
    config: { baseUrl: prov.baseUrl, apiKey: prov.apiKey, model },
    messages: [{ role: 'user', content: prompt }],
    tools,
    onEvent: (e) => {
      if (e.kind === 'tool-start') console.log(`  [tool] ${e.name}`);
      if (e.kind === 'retry') console.log(`  [retry] ${e.attempt}/${e.max}`);
    },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  [agent] ${secs}s answer=${(out.answer || '').length} chars error=${out.error || 'none'}`);

  const text = String(out.answer || '');
  const m = text.match(/\[[\s\S]*\]/);
  let triage = null;
  try { triage = m ? JSON.parse(m[0]) : null; } catch { console.error('  [parse] JSON 解析失败'); }

  const outFile = path.join(roundDir, `triage-${repo}.json`);
  writeFileSync(outFile, JSON.stringify({ repo, model, elapsedSec: Number(secs), answer: text, triage, samples: compact }, null, 1));

  if (Array.isArray(triage)) {
    const by = { TP: 0, FP: 0, unclear: 0 };
    for (const t of triage) by[t.verdict] = (by[t.verdict] || 0) + 1;
    console.log(`  [triage] ${JSON.stringify(by)}`);
    for (const t of triage) console.log(`   #${t.n} ${String(t.verdict).padEnd(7)} ${t.rule} ${t.file}:${t.line} — ${String(t.reason || '').slice(0, 55)}`);
  } else {
    console.log('  [triage] 未解析，见', outFile);
  }
}
console.log('\nROUND9-TRIAGE-DONE');
