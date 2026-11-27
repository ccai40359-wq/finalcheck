#!/usr/bin/env node
// 剧本运行器：一条命令跑完一个「真人怎么用」的剧本，输出清晰日志 + 报告。
//
//   node scripts/sim/run.mjs scripts/sim/scenarios/cross-turn-memory.json            # 假网关（剧本里的 mock 回复）
//   node scripts/sim/run.mjs <剧本> --live [--provider <id>] [--model <id>]          # 真模型（借用你本机配置里的供应商，只读）
//   node scripts/sim/run.mjs <剧本> --replay <录像.json>                              # 回放一次真模型录像
//   node scripts/sim/run.mjs --all                                                   # 跑 scenarios/ 下所有带 mock 的剧本
//
// 输出目录（默认 .tmp/sim/<剧本名>-<时间>/）：
//   run.log       人读：每轮说了什么、调了哪些工具、耗时
//   events.jsonl  机器读：IPC 调用、界面事件、每次网关请求
//   requests.jsonl 每次网关请求（类型 / 消息条数 / 估算 token / 缓存命中 / 回复摘要）
//   report.md     汇总 + 每条断言的通过情况
//   cassette.json （--live 时）可回放的录像
//
// 隔离：所有数据都在临时目录；项目是复制出来的；不会读写你正在用的 FinalCheck。
import { readFileSync, writeFileSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGateway } from './gateway.mjs';
import { readRealProviders } from './isolate.mjs';
import { checkTurn, prefixReport } from './expect.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

if (flag('--all')) {
  const dir = path.join(HERE, 'scenarios');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const { spawnSync } = await import('node:child_process');
  let failed = 0;
  for (const f of files) {
    const sc = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    if (!sc.mock) { console.log(`跳过 ${f}（没有 mock 回复，只能 --live 跑）`); continue; }
    // 每个剧本一个独立进程：环境变量 / 模块单例互不影响
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), path.join(dir, f)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `\n${failed} 个剧本失败` : '\n全部剧本通过');
  process.exit(failed ? 1 : 0);
}

const scenarioFile = argv.find((a) => a.endsWith('.json') && argv[argv.indexOf(a) - 1] !== '--replay');
if (!scenarioFile) { console.error('用法：node scripts/sim/run.mjs <剧本.json> [--live|--replay 录像.json]'); process.exit(2); }
const sc = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const mode = flag('--live') ? 'proxy' : (opt('--replay') ? 'replay' : 'script');
if (mode === 'script' && !sc.mock) { console.error(`剧本 ${sc.name} 没有 mock 回复：请用 --live 跑真模型，或 --replay 回放录像`); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(opt('--out') || path.join(REPO_ROOT, '.tmp', 'sim', `${sc.name || path.basename(scenarioFile, '.json')}-${mode}-${stamp}`));
mkdirSync(outDir, { recursive: true });

// ---- 网关 ----
let upstream = null;
let model = sc.model || 'sim-model';
let providerExtra = sc.providerExtra || {};
if (mode === 'proxy') {
  const real = readRealProviders();
  if (!real || !real.providers.length) { console.error('读不到本机 FinalCheck 配置里的供应商（%APPDATA%/FinalCheck/config.json），无法跑真模型'); process.exit(2); }
  const want = opt('--provider') || real.activeProviderId;
  const p = real.providers.find((x) => x.id === want && x.enabled !== false && x.baseUrl && x.apiKey) || real.providers.find((x) => x.enabled !== false && x.baseUrl && x.apiKey);
  if (!p) { console.error('没有可用（启用且有 key）的供应商'); process.exit(2); }
  const ids = (p.models || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
  model = opt('--model') || (ids.includes(real.activeModel) ? real.activeModel : ids[0]);
  const entry = (p.models || []).find((m) => typeof m === 'object' && m?.id === model);
  providerExtra = { ...(p.contextWindow ? { contextWindow: p.contextWindow } : {}), ...(p.maxOutputTokens ? { maxOutputTokens: p.maxOutputTokens } : {}), ...providerExtra };
  if (entry) providerExtra.models = [entry];
  upstream = { baseUrl: p.baseUrl, apiKey: p.apiKey };
  sc.config = { thinkingEffort: real.thinkingEffort || 'max', ...(sc.config || {}) }; // 和你本机的思考强度一致
  console.log(`真模型：${p.name || p.id} / ${model}（key 不会写进任何日志）`);
}

let projectDirForMock = null;
const queue = (sc.mock?.replies || []).map((r, i) => ({ ...r, _i: i }));
const subQueue = (sc.mock?.subagentReplies || []).map((r, i) => ({ ...r, _i: i }));
const fill = (v) => JSON.parse(JSON.stringify(v).replaceAll('{{project}}', (projectDirForMock || '').replaceAll('\\', '/')));
const requestsFile = path.join(outDir, 'requests.jsonl');
const gw = await startGateway({
  mode,
  upstream,
  cassette: mode === 'replay' ? path.resolve(opt('--replay')) : path.join(outDir, 'cassette.json'),
  respond: (body, { kind }) => {
    const take = (list) => {
      // 带 match 的回复：只在请求里最后一条用户消息（或子代理任务）匹配时使用。
      // 0.29.7：引擎的轻闸/催收会注入 [系统] 开头的提醒消息（反过度思考/死磕/复读催收），
      // 那些是透明提醒、不是用户说的话——剧本按用户原话匹配，跳过它们（否则一次注入就让剧本脱轨）。
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user' && !(typeof m.content === 'string' && m.content.startsWith('[系统]')));
      const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
      const idx = list.findIndex((r) => !r.match || new RegExp(r.match).test(text));
      if (idx < 0) return null;
      const [r] = list.splice(idx, 1);
      return fill(r);
    };
    if (kind === 'main') return take(queue);
    if (kind === 'subagent') return take(subQueue) || { content: '（子代理：剧本没有准备回复）' };
    return null;
  },
  onRequest: (rec) => {
    const line = {
      n: rec.n, kind: rec.kind, status: rec.status, ms: rec.ms, msgs: rec.messages?.length, toolChoice: rec.toolChoice,
      estPromptTokens: rec.estPromptTokens, estCachedTokens: rec.estCachedTokens, usage: rec.usage || undefined, reply: rec.reply, error: rec.error
    };
    try { appendFileSync(requestsFile, JSON.stringify(line) + '\n'); } catch { /* 忽略 */ }
    // --dump：完整请求体另存（排查前缀为什么断；真模型长任务会很大，默认不存）
    if (flag('--dump')) { try { appendFileSync(path.join(outDir, 'requests-full.jsonl'), JSON.stringify({ n: rec.n, kind: rec.kind, messages: rec.messages }) + '\n'); } catch { /* 忽略 */ } }
  }
});

const { createSimClient } = await import('./client.mjs');
const project = { ...(sc.project || {}) };
if (project.copyFrom && !path.isAbsolute(project.copyFrom)) project.copyFrom = path.resolve(path.dirname(scenarioFile), project.copyFrom);
const sim = await createSimClient({
  label: 'sim-' + (sc.name || 'run'),
  project,
  gateway: gw,
  model,
  apiKey: mode === 'proxy' ? 'proxied' : 'sim-key',
  config: sc.config || {},
  providerExtra,
  logDir: outDir,
  guard: sc.guard || null,
  answerAsk: sc.askAnswers ? ((ask) => {
    for (const a of sc.askAnswers) if (!a.match || new RegExp(a.match).test(ask.question || '')) return a.answer;
    return null;
  }) : null
});
projectDirForMock = sim.projectDir;
console.log(`剧本：${sc.name}（${mode === 'script' ? '假网关' : mode === 'proxy' ? '真模型' : '回放'}）  日志：${outDir}`);

const results = [];
let sid = null;
const t0 = Date.now();
for (const [i, step] of (sc.turns || []).entries()) {
  if (step.restart) { await sim.restart(); if (sid) await sim.open(sid); results.push({ i, restart: true }); continue; }
  if (step.newSession || !sid) sid = await sim.newSession();
  // 手动 /compact：和渲染层一样调 IPC，成功后重新打开会话
  if (step.compact) {
    const reqBefore = gw.requests.length;
    sim.log.human('▶ 用户：/compact');
    const r = await sim.invoke('finalcheck:compact-session', sid);
    await sim.open(sid);
    const reqs = gw.requests.slice(reqBefore);
    const s = await sim.loadSession(sid);
    const checks = [{ name: '手动压缩成功', ok: !!r?.ok, detail: JSON.stringify(r).slice(0, 300) }];
    if (step.expect?.summaryRequests != null) checks.push({ name: `摘要请求 = ${step.expect.summaryRequests} 次`, ok: reqs.filter((q) => q.kind === 'summary').length === step.expect.summaryRequests, detail: `实际 ${reqs.filter((q) => q.kind === 'summary').length}` });
    for (const c of [].concat(step.expect?.dbSummaryContains || [])) checks.push({ name: `边界里有 /${c}/`, ok: new RegExp(c).test(String(s.summary || '')), detail: String(s.summary || '').slice(0, 200) });
    for (const c of [].concat(step.expect?.summaryRequestIncludes || [])) {
      const hay = JSON.stringify(reqs.filter((q) => q.kind === 'summary').map((q) => q.messages));
      checks.push({ name: `摘要材料里有 /${c}/`, ok: new RegExp(c).test(hay), detail: '没找到' });
    }
    results.push({ i, compact: r, checks });
    for (const c of checks) sim.log.human(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '：' + c.detail}`);
    continue;
  }
  if (!step.send) continue;
  const cancelAfterTool = step.cancelAfterTool || null;
  let seenTools = 0;
  const turn = await sim.send(sid, step.send, {
    cancelAfterMs: step.cancelAfterMs ?? null,
    onEvent: (ev, ctl) => {
      if (cancelAfterTool && ev.kind === 'tool-end' && (cancelAfterTool === '*' || ev.tool === cancelAfterTool || ev.name === cancelAfterTool)) {
        seenTools++;
        if (seenTools === (step.cancelAfterToolCount || 1)) void ctl.cancel();
      }
      if (step.steer && ev.kind === 'tool-end' && !step._steered) { step._steered = true; void ctl.steer(step.steer); }
    }
  });
  const checks = await checkTurn(turn, step.expect || {}, { projectDir: sim.projectDir, sim });
  results.push({ i, send: step.send, turn, checks });
  for (const c of checks) sim.log.human(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.ok ? '' : '：' + c.detail}`);
}

// ---- 汇总 ----
const all = gw.requests;
const byKind = (k) => all.filter((r) => r.kind === k);
const sumMs = (list) => list.reduce((a, r) => a + (r.ms || 0), 0);
const toolMs = results.reduce((a, r) => a + (r.turn?.toolMs || 0), 0);
const usageCached = byKind('main').reduce((a, r) => a + (Number(r.usage?.prompt_tokens_details?.cached_tokens ?? r.usage?.prompt_cache_hit_tokens ?? 0) || 0), 0);
const usagePrompt = byKind('main').reduce((a, r) => a + (Number(r.usage?.prompt_tokens ?? 0) || 0), 0);
const prefix = prefixReport(byKind('main'));
const failed = results.flatMap((r) => (r.checks || []).filter((c) => !c.ok).map((c) => ({ ...c, turn: r.i })));
const lines = [
  `# 模拟客户端报告：${sc.name}`,
  '',
  `- 模式：${mode === 'script' ? '假网关（剧本）' : mode === 'proxy' ? `真模型（${model}）` : '回放录像'}`,
  `- 总耗时：${((Date.now() - t0) / 1000).toFixed(1)}s；网关请求 ${all.length} 次（主 ${byKind('main').length} / 子代理 ${byKind('subagent').length} / 摘要 ${byKind('summary').length} / 标题 ${byKind('title').length}）`,
  `- 等模型：${(sumMs(byKind('main')) / 1000).toFixed(1)}s（主）+ ${(sumMs(byKind('subagent')) / 1000).toFixed(1)}s（子代理，可能并行）；工具执行合计 ${(toolMs / 1000).toFixed(1)}s`,
  `- 前缀稳定性（主 agent）：${prefix.breaks} 次断开 / ${prefix.total} 次请求${prefix.breaks ? `（断在第 ${prefix.at.join('、')} 次）` : ''}；估算缓存命中 ${prefix.cachedRatio}%`,
  ...(usagePrompt ? [`- 网关实报：prompt ${usagePrompt} token，缓存命中 ${usageCached}（${Math.round((usageCached / usagePrompt) * 100)}%）`] : []),
  '',
  '| # | 用户 | 工具 | 请求 | 耗时 | 结果 |',
  '|---|---|---|---|---|---|',
  ...results.map((r) => r.restart
    ? `| ${r.i} | （重启应用） | | | | |`
    : r.compact ? `| ${r.i} | /compact | | | | ${r.checks.every((c) => c.ok) ? '✓' : '✗ ' + r.checks.filter((c) => !c.ok).map((c) => c.name).join('；')} |`
    : `| ${r.i} | ${String(r.send).slice(0, 40).replace(/\|/g, '/')} | ${r.turn.tools.join(', ').slice(0, 80)} | ${r.turn.requests.length} | ${(r.turn.ms / 1000).toFixed(1)}s | ${r.checks.every((c) => c.ok) ? '✓' : '✗ ' + r.checks.filter((c) => !c.ok).map((c) => c.name).join('；')} |`),
  '',
  failed.length ? '## 未通过\n\n' + failed.map((f) => `- 第 ${f.turn} 步 · ${f.name}：${f.detail}`).join('\n') : '全部断言通过。'
];
writeFileSync(path.join(outDir, 'report.md'), lines.join('\n') + '\n');
if (mode === 'proxy') gw.saveCassette();
if (mode === 'script' && queue.length) sim.log.human(`注意：剧本还有 ${queue.length} 条主 agent 回复没用上`);
console.log(lines.slice(2, 7).join('\n'));
console.log(failed.length ? `✗ ${failed.length} 条断言未通过（见 ${path.join(outDir, 'report.md')}）` : `✓ 全部通过（${path.join(outDir, 'report.md')}）`);
await gw.close();
await sim.close();
process.exit(failed.length ? 1 : 0);
