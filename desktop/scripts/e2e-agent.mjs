// 真实模型端到端测试（无头）：用桌面端同一套 agent 代码（runAgentTurn + createAgentTools），
// 让 AI 在真实仓库上做一次验收，记录工具调用、审计结果与最终回答。
//
//   node desktop/scripts/e2e-agent.mjs --project D:/fc-e2e/DVWA [--provider opendesignM] [--model deepseek-v4.1-flash-eco]
//        [--root <引擎根目录，默认仓库根；测打包产物传 desktop/release/win-unpacked/resources>] [--out out.json]
//        [--prompt "..."] [--timeout-min 20]
//
// 供应商配置读 %APPDATA%/FinalCheck/config.json（与桌面端同一份）；API Key 不打印、不写入输出。
// 权限模式 full（无人值守，不弹审批）；沙箱/路径闸照常生效。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const projectPath = path.resolve(opt('--project') || process.exit(console.error('--project 必填') || 2));
const providerName = opt('--provider', 'opendesignM');
const modelId = opt('--model', 'deepseek-v4.1-flash-eco');
const root = path.resolve(opt('--root', path.resolve(import.meta.dirname, '..', '..')));
const outFile = opt('--out');
const timeoutMin = Number(opt('--timeout-min', '20'));
const roleMode = opt('--mode', 'audit'); // audit（验收轨）| dev（开发轨）
const prompt = opt('--prompt', '对这个项目做一次 L2 验收：给出能不能交付的结论、最主要的风险（每条带文件:行号证据）和修复建议。只验收，不要修改任何代码。');

const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { runAgentTurn } = await imp('desktop/src/main/agent-service.mjs');
const { createAgentTools } = await imp('desktop/src/main/agent-tools.mjs');
const permissions = await imp('desktop/src/main/permissions.mjs');
const { createPolicy } = await imp('desktop/src/main/policy.mjs');
const { createTodoRegistry } = await imp('desktop/src/main/todo-list.mjs');

const cfgPath = path.join(process.env.APPDATA || '', 'FinalCheck', 'config.json');
const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
const prov = (cfg.providers || []).find((p) => p.name === providerName || p.id === providerName);
if (!prov) { console.error(`找不到供应商 ${providerName}`); process.exit(2); }

permissions.setMode('full');
const policy = createPolicy({ projectPath, mode: 'workspace', allowPaths: [] });
const events = [];
// ask_user：无人值守时自动回答（模拟用户「按你的判断来」），并记录问了什么；todo_write 接真实台账
const ac = new AbortController(); // 超时中止：同时传给工具层，正在跑的命令也要被打断
const asked = [];
const todos = createTodoRegistry();
const tools = createAgentTools({
  repoRoot: root, permissions, projectPath, policy, cwd: projectPath, signal: ac.signal,
  onActivity: (e) => events.push({ at: Date.now(), activity: e }),
  askUser: async (q) => { asked.push(q?.question || ''); return { ok: true, answer: '按你的判断继续：L2，11 维全选，只验收不改代码。' }; },
  todoWrite: (a) => todos.write('e2e', a),
});

const started = Date.now();
const toolLog = [];
const usage = { prompt: 0, completion: 0, requests: 0 };
const timer = setTimeout(() => ac.abort(), timeoutMin * 60000);
let lastPrint = 0;
const out = await runAgentTurn({
  roleMode,
  config: { baseUrl: prov.baseUrl, apiKey: prov.apiKey, model: modelId, providerId: prov.id, contextWindow: prov.contextWindow || 128000, toolConcurrency: 8, vision: (prov.models || []).some((m) => (m?.id || m) === modelId && m?.vision === true) },
  messages: [{ role: 'user', content: prompt }],
  tools,
  cwd: projectPath,
  signal: ac.signal,
  onToken: () => {},
  onEvent: (ev) => { if (ev?.kind && ev.kind !== 'token') events.push({ at: Date.now() - started, kind: ev.kind, message: ev.message }); },
  onUsage: (u) => { usage.prompt += Number(u.prompt) || 0; usage.completion += Number(u.completion) || 0; usage.requests++; },
  onToolLifecycle: (ev) => {
    if (ev?.phase === 'start') {
      toolLog.push({ at: Math.round((Date.now() - started) / 1000), name: ev.name, args: String(ev.args || '').slice(0, 300) });
      const now = Date.now();
      if (now - lastPrint > 1000) { lastPrint = now; process.stderr.write(`[${Math.round((now - started) / 1000)}s] ${ev.name} ${String(ev.args || '').slice(0, 120)}\n`); }
    } else if (ev?.phase === 'end') {
      const t = [...toolLog].reverse().find((x) => x.name === ev.name && x.status === undefined);
      if (t) { t.status = ev.status; t.ms = ev.ms; t.result = typeof ev.result === 'string' ? ev.result.slice(0, 4000) : JSON.stringify(ev.result ?? ev.error ?? '').slice(0, 4000); }
    }
  },
});
clearTimeout(timer);

const result = {
  project: projectPath, provider: prov.name, model: modelId, root,
  seconds: Math.round((Date.now() - started) / 1000),
  timedOut: ac.signal.aborted,
  error: out.error || null,
  usage,
  toolCounts: toolLog.reduce((m, t) => ((m[t.name] = (m[t.name] || 0) + 1), m), {}),
  tools: toolLog,
  asked,
  answer: out.answer || out.partialContent || '',
  events: events.slice(-40),
};
if (outFile) await writeFile(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ project: path.basename(projectPath), seconds: result.seconds, timedOut: result.timedOut, error: result.error, usage, toolCounts: result.toolCounts }, null, 1));
console.log('\n===== 回答 =====\n' + result.answer.slice(0, 6000));
