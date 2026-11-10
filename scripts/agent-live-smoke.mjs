// 真网关 Agent 能力实测（不进 npm test）：起本机靶子 → 真模型决策 → 自助读方法论 → 探测 → 结论
// 用法：node scripts/agent-live-smoke.mjs
// 退出码：0=通过；1=模型没查方法论/没探测；2=无可用供应商
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import server from '../tests/fixtures/dynamic-target/app.mjs';
import { runAgentTurn } from '../desktop/src/main/agent-service.mjs';
import { createAgentTools } from '../desktop/src/main/agent-tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const raw = JSON.parse(await readFile(path.join(ROOT, 'desktop', 'config.json'), 'utf8'));
const providers = Array.isArray(raw.providers) ? raw.providers : [];
const prov = providers.find((p) => p.enabled && p.baseUrl && p.apiKey && p.id === raw.activeProviderId)
  || providers.find((p) => p.enabled && p.baseUrl && p.apiKey);
if (!prov || !prov.models?.length) {
  console.error('无可用供应商：请先在桌面端「模型设置」里配置并启用');
  process.exit(2);
}

const external = process.env.SMOKE_TARGET || null;
if (!external) await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = external || 'http://127.0.0.1:' + server.address().port;
console.log(`[target] ${base}  model=${prov.models[0]}  gateway=${prov.baseUrl}`);

const tools = createAgentTools({
  repoRoot: ROOT,
  permissions: {
    noteTarget() {},
    sessionAllowed: () => true,
    commandPrefix: (cmd) => String(cmd).split(/\s+/)[0],
    requestApproval: async () => 'allowed-once'
  }
});

const prompt = external
  ? `目标 ${base} 是用户自有的站点，已在对话中授权测试。请先查方法论库选合适类目（优先 02 技术栈指纹 / 27 CORS / 29 点击劫持），只用 probe_target 和少量 curl GET 做非破坏性验证；不要压测、不要目录爆破、不要尝试登录。最后给结论：哪些已复现、哪些没查到。`
  : `目标 ${base} 是我授权的本机测试站。请先查方法论库选合适类目，再按方法论探测这个目标，最后给出带证据的结论：哪些已复现、哪些没查到。`;

const started = Date.now();
const events = [];
const out = await runAgentTurn({
  config: { baseUrl: prov.baseUrl, apiKey: prov.apiKey, model: prov.models[0] },
  messages: [{ role: 'user', content: prompt }],
  tools,
  onEvent: (e) => {
    events.push(e);
    if (e.kind === 'tool-start') console.log(`[tool-start] ${e.name} ${e.args}`);
    if (e.kind === 'tool-end') console.log(`[tool-end]   ${e.name} ${e.ms}ms ok=${e.ok}`);
    if (e.kind === 'retry') console.log(`[retry]      ${e.attempt}/${e.max} ${e.reason}`);
    if (e.kind === 'phase') console.log(`[phase]      ${e.name}`);
  }
});

if (!external) server.close();
const used = (out.trace || []).map((t) => t.tool);
console.log('\n--- tools used ---\n' + (used.join('\n') || '(none)'));
console.log('\n--- answer ---\n' + (out.answer || out.error));
console.log(`\n--- elapsed ${Date.now() - started}ms, reasoning ${(out.reasoning || '').length} chars ---`);

if (!used.includes('list_playbooks') && !used.includes('read_playbook')) {
  console.error('\nFAIL: 模型没有查方法论库');
  process.exit(1);
}
if (!used.includes('probe_target') && !used.includes('run_command')) {
  console.error('\nFAIL: 模型没有实际探测目标');
  process.exit(1);
}
console.log('\nLIVE SMOKE PASS');
