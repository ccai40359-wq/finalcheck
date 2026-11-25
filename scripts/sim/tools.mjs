#!/usr/bin/env node
// 第一层：不接任何模型，只测工具本身。
//
// 走的是 agent 执行工具的同一个入口（agent-service 的 runToolCall：参数解析、钩子、超长落盘、
// 给模型看的文本都在这里生成），所以日志里的「模型看到」就是模型真实会收到的内容。
//
//   node scripts/sim/tools.mjs                                  # 跑默认套件 tool-suites/basic.json
//   node scripts/sim/tools.mjs scripts/sim/tool-suites/xxx.json
//   node scripts/sim/tools.mjs --project D:/some/repo --tool grep_code --args '{"pattern":"TODO"}'   # 单次试一个工具（项目会先复制）
//
// 输出：.tmp/sim/tools-<时间>/ 下 run.log（人读）、results.jsonl（每次调用的完整结果）、report.md。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateEnv } from './isolate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const engineUrl = (rel) => pathToFileURL(path.join(REPO_ROOT, rel)).href;

/**
 * 跑一组工具调用。
 * @param {{ steps: Array<{tool:string, args:any, expect?:any, note?:string}>, project?: {files?:Record<string,string>, copyFrom?:string} }} suite
 * @param {{ logDir?: string|null, approvals?: 'approve'|'reject', quiet?: boolean }} [o]
 */
export async function runToolSuite(suite, { logDir = null, approvals = 'approve', quiet = false } = {}) {
  const env = isolateEnv({ label: 'tools' });
  const projDir = path.join(env.projectsRoot, suite.project?.name || 'proj');
  if (suite.project?.copyFrom) cpSync(suite.project.copyFrom, projDir, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git|\.finalcheck)([\\/]|$)/.test(s.slice(suite.project.copyFrom.length)) });
  mkdirSync(projDir, { recursive: true });
  for (const [rel, content] of Object.entries(suite.project?.files || {})) {
    const f = path.join(projDir, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  const [{ runToolCall }, { createAgentTools }, permissions, { createPolicy }, { recordAudit }] = await Promise.all([
    import(engineUrl('desktop/src/main/agent-service.mjs')),
    import(engineUrl('desktop/src/main/agent-tools.mjs')),
    import(engineUrl('desktop/src/main/permissions.mjs')),
    import(engineUrl('desktop/src/main/policy.mjs')),
    import(engineUrl('desktop/src/main/memory.mjs'))
  ]);
  permissions.setMode(approvals === 'approve' ? 'full' : 'ask');
  permissions.setApprovalEmitter(null); // ask 模式下没有界面 = fail-closed 拒绝（用来测审批闸）
  const policy = createPolicy({ projectPath: projDir, mode: 'workspace', allowPaths: [] });
  const tools = createAgentTools({
    repoRoot: REPO_ROOT, permissions, recordAudit, projectPath: projDir, policy, sessionId: 'tools-sim',
    // 0.33.9 起越界是「问用户」：无头模拟里一律答「不允许」，以测拒绝路径；其它提问照旧选第一个
    askUser: async (a) => {
      const labels = (a?.options || []).map((o) => o?.label);
      return { answer: labels.includes('不允许') ? '不允许' : (labels[0] || '好的') };
    },
    todoWrite: (a) => ({ ok: true, items: a?.items || [] }),
    runWorkflow: null
  });
  if (logDir) mkdirSync(logDir, { recursive: true });
  const human = (s) => { if (!quiet) console.log(s); if (logDir) appendFileSync(path.join(logDir, 'run.log'), s + '\n'); };
  let lastSpill = ''; // 上一次超长结果的落盘路径：步骤里用 {{lastSpill}} 引用（测「落盘全文模型读不读得到」）
  const fill = (v) => JSON.parse(JSON.stringify(v ?? {})
    .replaceAll('{{project}}', projDir.replaceAll('\\', '/'))
    .replaceAll('{{lastSpill}}', lastSpill.replaceAll('\\', '/')));
  human(`项目：${projDir}`);
  const rows = [];
  for (const [i, st] of (suite.steps || []).entries()) {
    const args = fill(st.args);
    const events = [];
    const t0 = Date.now();
    const r = await runToolCall({ id: `t${i}`, function: { name: st.tool, arguments: JSON.stringify(args) } }, tools, (ev) => events.push(ev));
    const ms = Date.now() - t0;
    const result = r?.trace?.result;
    const modelText = String(r?.modelContent ?? '');
    const ok = !(result && typeof result === 'object' && result.error);
    const checks = [];
    const ex = st.expect || {};
    const want = ex.ok ?? true;
    checks.push({ name: want ? '成功' : '失败（预期被拒/报错）', ok: ok === want, detail: ok ? '' : String(result?.error).slice(0, 200) });
    if (ex.contains) checks.push({ name: `模型看到的内容包含 ${ex.contains}`, ok: modelText.includes(ex.contains), detail: modelText.slice(0, 200) });
    if (ex.notContains) checks.push({ name: `不含 ${ex.notContains}`, ok: !modelText.includes(ex.notContains), detail: modelText.slice(0, 200) });
    if (ex.errorMatches) checks.push({ name: `报错匹配 /${ex.errorMatches}/`, ok: new RegExp(ex.errorMatches, 'i').test(String(result?.error || '')), detail: String(result?.error || '没有报错') });
    if (ex.maxChars) checks.push({ name: `模型看到 ≤ ${ex.maxChars} 字符`, ok: modelText.length <= ex.maxChars, detail: `实际 ${modelText.length}` });
    if (ex.maxMs) checks.push({ name: `耗时 ≤ ${ex.maxMs}ms`, ok: ms <= ex.maxMs, detail: `实际 ${ms}ms` });
    if (ex.fileContains) for (const [rel, s] of Object.entries(ex.fileContains)) {
      let text = '';
      try { text = readFileSync(path.join(projDir, rel), 'utf8'); } catch { /* 不存在 */ }
      checks.push({ name: `${rel} 包含 ${s}`, ok: text.includes(s), detail: text.slice(0, 160) });
    }
    const spill = /完整输出: (.+)/.exec(modelText);
    if (spill && spill[1] && !spill[1].startsWith('(')) lastSpill = spill[1].trim();
    const pass = checks.every((c) => c.ok);
    rows.push({ i, tool: st.tool, note: st.note || '', args, ms, ok, pass, chars: modelText.length, images: r?.images?.length || 0, checks, modelHead: modelText.slice(0, 600) });
    human(`${pass ? '✓' : '✗'} ${String(i).padStart(2)} ${st.tool.padEnd(18)} ${String(ms).padStart(5)}ms  ${String(modelText.length).padStart(6)} 字符${r?.images?.length ? ` +${r.images.length} 图` : ''}  ${st.note || ''}`);
    for (const c of checks.filter((x) => !x.ok)) human(`      ✗ ${c.name}：${c.detail}`);
    if (logDir) appendFileSync(path.join(logDir, 'results.jsonl'), JSON.stringify({ i, tool: st.tool, args, ms, result, modelContent: modelText.slice(0, 20000), events: events.map((e) => e.kind) }) + '\n');
  }
  const failed = rows.filter((r) => !r.pass);
  if (logDir) {
    writeFileSync(path.join(logDir, 'report.md'), [
      `# 工具层测试（不接模型）`, '', `${rows.length} 次调用，${failed.length} 个未通过`, '',
      '| # | 工具 | 说明 | 耗时 | 模型看到 | 结果 |', '|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.i} | ${r.tool} | ${r.note} | ${r.ms}ms | ${r.chars} 字符 | ${r.pass ? '✓' : '✗ ' + r.checks.filter((c) => !c.ok).map((c) => c.name).join('；')} |`)
    ].join('\n') + '\n');
  }
  return { rows, failed, projectDir: projDir };
}

// ---- CLI ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  let suite;
  if (opt('--tool')) {
    suite = { project: opt('--project') ? { copyFrom: path.resolve(opt('--project')) } : {}, steps: [{ tool: opt('--tool'), args: JSON.parse(opt('--args') || '{}') }] };
  } else {
    const file = argv.find((a) => a.endsWith('.json')) || path.join(HERE, 'tool-suites', 'basic.json');
    suite = JSON.parse(readFileSync(file, 'utf8'));
    if (opt('--project')) suite.project = { ...(suite.project || {}), copyFrom: path.resolve(opt('--project')) };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logDir = path.join(REPO_ROOT, '.tmp', 'sim', `tools-${stamp}`);
  const { rows, failed } = await runToolSuite(suite, { logDir });
  console.log(`\n${rows.length} 次调用，${failed.length ? `✗ ${failed.length} 个未通过` : '全部通过'}。日志：${logDir}`);
  process.exit(failed.length ? 1 : 0);
}
