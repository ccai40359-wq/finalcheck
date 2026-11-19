#!/usr/bin/env node
// 触发评测：真模型在什么情况下会真的调用某个工具（做了工具 AI 不用 = 白做）。
//
//   node scripts/sim/trigger-eval.mjs                       # 跑 trigger-cases.json 全部用例（真模型，借用本机配置的供应商，只读）
//   node scripts/sim/trigger-eval.mjs --only spawn          # 只跑 id 含 spawn 的用例
//   node scripts/sim/trigger-eval.mjs --repeat 2            # 每个用例跑 2 次看稳定性
//
// 每个用例：复制一份项目 → 走模拟客户端（和真人同一条后端链路）发一条消息 →
// 一旦模型调用了「被观察的工具」（spawn_agent / run_workflow）或已经发了 N 次请求还没调用，就立刻停止这一轮，
// 只看它的决策，不等它把活干完（省时间省钱）。run_workflow 额外检查：第一次给的 nodes 能不能直接编译通过。
// 输出：.tmp/sim/trigger-<时间>/report.md + 每个用例的完整日志。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const WATCHED = ['spawn_agent', 'run_workflow'];

// ---- 子进程模式：跑一个用例，结果写到 --result 文件 ----
if (argv.includes('--case')) {
  const c = JSON.parse(readFileSync(opt('--case'), 'utf8'));
  const outDir = opt('--out');
  const { startGateway } = await import('./gateway.mjs');
  const { readRealProviders } = await import('./isolate.mjs');
  const real = readRealProviders();
  const p = real?.providers.find((x) => x.id === (opt('--provider') || real.activeProviderId) && x.enabled !== false && x.apiKey) || real?.providers.find((x) => x.enabled !== false && x.apiKey);
  if (!p) { writeFileSync(opt('--result'), JSON.stringify({ error: '没有可用的供应商' })); process.exit(2); }
  const ids = (p.models || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
  const model = opt('--model') || (ids.includes(real.activeModel) ? real.activeModel : ids[0]);
  const gw = await startGateway({ mode: 'proxy', upstream: { baseUrl: p.baseUrl, apiKey: p.apiKey }, cassette: path.join(outDir, 'cassette.json') });
  const { createSimClient } = await import('./client.mjs');
  const entry = (p.models || []).find((m) => typeof m === 'object' && m?.id === model);
  const sim = await createSimClient({
    label: 'trig', project: { copyFrom: c.project, name: path.basename(c.project) }, gateway: gw, model, apiKey: 'proxied', logDir: outDir,
    providerExtra: { ...(p.contextWindow ? { contextWindow: p.contextWindow } : {}), ...(entry ? { models: [entry] } : {}) },
    config: { thinkingEffort: c.effort || real.thinkingEffort || 'max' } // 和你本机的思考强度一致
  });
  // 和渲染层一样展开 /workflow 等技能指令
  const { expandSkill } = await import(pathToFileURL(path.join(REPO_ROOT, 'desktop/src/renderer/lib/app-helpers.mjs')).href).catch(() => ({ expandSkill: (x) => x }));
  const text = expandSkill(c.prompt.replaceAll('{{project}}', sim.projectDir.replaceAll('\\', '/')), []);
  const sid = await sim.newSession();
  const maxMain = c.maxRequests || 6;
  let called = null;
  let calledArgs = null;
  const toolsSeen = [];
  const turn = await sim.send(sid, text, {
    onEvent: (ev, ctl) => {
      if (ev.kind === 'tool-start') {
        toolsSeen.push(ev.name);
        if (!called && WATCHED.includes(ev.name)) {
          called = ev.name;
          calledArgs = ev.args;
          void ctl.cancel();
        }
      }
      if (ev.kind === 'activity' && typeof ev.request === 'number' && ev.request > maxMain && !called) void ctl.cancel();
    }
  });
  let sameReply = 0; // 同一次回复里调用了几次（spawn_agent 并行派了几个）
  // 界面事件里的参数只是 2000 字符预览：完整参数从网关录像里取（模型实际发出的原文）
  {
    const { replyFromBody } = await import('./gateway.mjs');
    for (const e of gw.tape.entries.filter((x) => x.kind === 'main')) {
      const call = (replyFromBody(e.body, { full: true }).toolCalls || []).find((x) => x.name === called);
      if (call) { calledArgs = call.args; sameReply = (replyFromBody(e.body, { full: true }).toolCalls || []).filter((x) => x.name === called).length; break; }
    }
  }
  let compileOk = null;
  let compileError = null;
  let nodeCount = null;
  let types = null;
  if (called === 'run_workflow') {
    const { compileNodes } = await import(pathToFileURL(path.join(REPO_ROOT, 'desktop/src/main/workflow-nodes.mjs')).href);
    let a = {};
    try { a = typeof calledArgs === 'string' ? JSON.parse(calledArgs) : (calledArgs || {}); } catch (e) { compileError = '参数不是合法 JSON：' + e.message; }
    if (!compileError) {
      if (a.nodes) {
        const r = compileNodes(a.nodes);
        compileOk = !('error' in r);
        compileError = r.error || null;
        nodeCount = Array.isArray(a.nodes) ? a.nodes.length : null;
        types = Array.isArray(a.nodes) ? [...new Set(a.nodes.map((n) => n.type || 'agent'))] : null;
      } else { compileOk = false; compileError = a.steps ? '用了旧写法 steps' : a.script ? '用了旧写法 script' : '没给 nodes'; }
    }
  }
  let spawnInfo = null;
  if (called === 'spawn_agent') {
    try { const a = typeof calledArgs === 'string' ? JSON.parse(calledArgs) : calledArgs; spawnInfo = { type: a?.type || 'explore', description: a?.description, promptChars: String(a?.prompt || '').length }; } catch { /* 参数截断 */ }
    spawnInfo = { ...(spawnInfo || {}), parallel: sameReply || 1 };
  }
  const main = gw.requests.filter((r) => r.kind === 'main');
  writeFileSync(opt('--result'), JSON.stringify({
    called, toolsSeen, compileOk, compileError, nodeCount, types, spawnInfo,
    mainRequests: main.length, ms: turn.ms, firstSay: String(main[0]?.reply?.content || '').slice(0, 200),
    // 被我们自己停掉的不算错；网关报错 / 回合异常才算
    ...(turn.error && !turn.cancelled && !called ? { error: '回合报错：' + String(turn.error).slice(0, 200) } : {})
  }));
  gw.saveCassette();
  await gw.close();
  await sim.close();
  process.exit(0);
}

// ---- 总控：逐个用例起子进程 ----
const cases = JSON.parse(readFileSync(path.join(HERE, 'trigger-cases.json'), 'utf8')).cases
  .filter((c) => !opt('--only') || c.id.includes(opt('--only')));
const repeat = Math.max(1, Number(opt('--repeat', '1')) || 1);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const root = path.join(REPO_ROOT, '.tmp', 'sim', `trigger-${stamp}`);
mkdirSync(root, { recursive: true });
const rows = [];
for (const c of cases) {
  for (let k = 0; k < repeat; k++) {
    const dir = path.join(root, `${c.id}${repeat > 1 ? `-${k + 1}` : ''}`);
    mkdirSync(dir, { recursive: true });
    const caseFile = path.join(dir, 'case.json');
    writeFileSync(caseFile, JSON.stringify(c));
    const resultFile = path.join(dir, 'result.json');
    const t0 = Date.now();
    process.stdout.write(`${c.id.padEnd(22)} 期望 ${String(c.expect).padEnd(12)} … `);
    spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--case', caseFile, '--out', dir, '--result', resultFile,
      ...(opt('--provider') ? ['--provider', opt('--provider')] : []), ...(opt('--model') ? ['--model', opt('--model')] : [])], { stdio: 'ignore', timeout: 15 * 60 * 1000 });
    let r = {};
    try { r = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { r = { error: '用例没跑完（看 ' + dir + '）' }; }
    const actual = r.called || 'none';
    const pass = !r.error && (Array.isArray(c.expect) ? c.expect.includes(actual) : c.expect === actual) && (actual !== 'run_workflow' || r.compileOk === true);
    rows.push({ id: c.id, expect: c.expect, actual, pass, ...r, secs: Math.round((Date.now() - t0) / 1000) });
    console.log(`${pass ? '✓' : '✗'} 实际 ${actual}${r.compileOk === false ? `（nodes 不合法：${r.compileError}）` : ''}${r.error ? ' ' + r.error : ''}  ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}
const ok = rows.filter((r) => r.pass).length;
const lines = [
  '# 工具触发评测（真模型）', '',
  `通过 ${ok} / ${rows.length}`, '',
  '| 用例 | 期望 | 实际 | 结果 | 细节 |', '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.id} | ${Array.isArray(r.expect) ? r.expect.join(' 或 ') : r.expect} | ${r.actual} | ${r.pass ? '✓' : '✗'} | ${[
    r.compileOk === true ? `nodes 一次编译通过（${r.nodeCount} 个，${(r.types || []).join('/')}）` : r.compileOk === false ? `nodes 不合法：${r.compileError}` : '',
    r.spawnInfo ? `type=${r.spawnInfo.type}，同回复派了 ${r.spawnInfo.parallel} 个` : '',
    `前 ${r.mainRequests ?? '?'} 次请求`, `工具：${(r.toolsSeen || []).slice(0, 6).join(',') || '无'}`
  ].filter(Boolean).join('；').replace(/\|/g, '/')} |`)
];
writeFileSync(path.join(root, 'report.md'), lines.join('\n') + '\n');
console.log(`\n通过 ${ok} / ${rows.length}。报告：${path.join(root, 'report.md')}`);
process.exit(ok === rows.length ? 0 : 1);
