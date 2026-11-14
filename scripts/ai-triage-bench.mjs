// 完全体试点：桌面同一套 agent（runAgentTurn + createAgentTools）对 FC 审计结果做 AI 分诊。
// 用法：node scripts/ai-triage-bench.mjs <repoDir> <auditJson> [maxFindings]
// 输出：D:\rcw-geo\.fc-bench2\round4\triage-<repoName>.json
// 只读：requestApproval 一律 denied（run_command/edit/write 全拒绝），只允许读文件与 audit。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , repoArg, auditArg, maxArg] = process.argv;
if (!repoArg || !auditArg) {
  console.error('用法: node scripts/ai-triage-bench.mjs <repoDir> <auditJson> [maxFindings=12]');
  process.exit(2);
}
const repoDir = path.resolve(repoArg);
const auditPath = path.resolve(auditArg);
const maxFindings = Number(maxArg) || 12;
const repoName = path.basename(repoDir);

// 1) provider：读桌面端已配置网关（key 只在本地用，不打印）
const cfgRaw = JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'config.json'), 'utf8'));
const providers = Array.isArray(cfgRaw.providers) ? cfgRaw.providers : [];
const prov = providers.find((p) => p.enabled && p.baseUrl && p.apiKey && p.id === cfgRaw.activeProviderId)
  || providers.find((p) => p.enabled && p.baseUrl && p.apiKey);
if (!prov?.models?.length) {
  console.error('无可用供应商：请先在桌面端「模型设置」配置并启用');
  process.exit(2);
}
const model = prov.models[0];
console.log(`[provider] ${prov.id} model=${model}`);

// 2) 取 FC 审计的可行动项（card/block 的 high+medium）
const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
const findings = (audit.findings || [])
  .filter((f) => ['card', 'block'].includes(f.force) && ['high', 'medium'].includes(f.severity))
  .sort((a, b) => String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0))
  .slice(0, maxFindings);
if (!findings.length) {
  console.log('[triage] 无可行动项，无需分诊');
  process.exit(0);
}
const compact = findings.map((f, i) => ({
  n: i + 1,
  rule: f.rule,
  severity: f.severity,
  file: f.file,
  line: f.line,
  snippet: String(f.snippet || '').slice(0, 100),
  message: String(f.message || '').slice(0, 120),
}));

// 3) 工具：真只读（sessionAllowed=false + 审批一律拒绝 → run_command/edit/write 全部不可用；
//    read_file 只走路径边界，不受影响）
const tools = createAgentTools({
  repoRoot: repoDir,
  requireAuditIntent: false,
  permissions: {
    noteTarget() {},
    sessionAllowed: () => false,
    commandPrefix: (cmd) => String(cmd).split(/\s+/)[0],
    requestApproval: async () => 'denied',
  },
});

const prompt = [
  `你是 FinalCheck 的分诊员。项目目录：${repoDir}`,
  `静态审计已经完成，下面是 ${compact.length} 条可行动发现（card/block 的 high+medium）。`,
  `不要重跑审计（audit_project 已被禁用）；用 read_file 读每条发现的命中行上下文（±30 行），判断它是：`,
  `- TP：真实问题，应该修`,
  `- FP：误报（测试/示例/框架约定/工具不适用等），说清为什么`,
  `- unclear：证据不足或需要运行时才能定`,
  `输出一个 JSON 数组（不要输出其他文字），每条：`,
  `{"n":1,"rule":"...","file":"...","line":0,"verdict":"TP|FP|unclear","evidence":"file:line + 关键代码事实","reason":"≤60字"}`,
  `发现的清单：`,
  JSON.stringify(compact, null, 1),
].join('\n');

// 4) 跑桌面同一套 agent 引擎
const started = Date.now();
const out = await runAgentTurn({
  config: { baseUrl: prov.baseUrl, apiKey: prov.apiKey, model },
  messages: [{ role: 'user', content: prompt }],
  tools,
  onEvent: (e) => {
    if (e.kind === 'tool-start') console.log(`[tool] ${e.name} ${String(JSON.stringify(e.args || {})).slice(0, 120)}`);
    if (e.kind === 'retry') console.log(`[retry] ${e.attempt}/${e.max} ${e.reason}`);
    if (e.kind === 'phase') console.log(`[phase] ${e.name}`);
  },
});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`[agent] ${elapsed}s answer=${(out.answer || '').length} chars error=${out.error || 'none'}`);

// 5) 解析 JSON（容忍 markdown 代码块）
const text = String(out.answer || '');
const m = text.match(/\[[\s\S]*\]/);
let triage = null;
try {
  triage = m ? JSON.parse(m[0]) : null;
} catch (e) {
  console.error('[parse] JSON 解析失败，保存原始回答');
}
const outDir = 'D:/rcw-geo/.fc-bench2/round4';
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `triage-${repoName}.json`);
writeFileSync(outFile, JSON.stringify({ repo: repoName, model, elapsedSec: Number(elapsed), answer: text, triage }, null, 1));
console.log(`[saved] ${outFile}`);

if (Array.isArray(triage)) {
  const by = { TP: 0, FP: 0, unclear: 0 };
  for (const t of triage) by[t.verdict] = (by[t.verdict] || 0) + 1;
  console.log('[triage]', JSON.stringify(by));
  for (const t of triage) console.log(` #${t.n} ${t.verdict.padEnd(7)} ${t.rule} ${t.file}:${t.line} — ${String(t.reason || '').slice(0, 70)}`);
} else {
  console.log('[triage] 未解析出 JSON，见 saved answer');
}
