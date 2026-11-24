#!/usr/bin/env node
// fc-agent：命令行 agent 模式（0.33.2，对齐 `claude -p`）
//
//   fc-agent -p "给 utils.js 补单测" [--project <dir>] [--yes] [--allow "run_command(npm test)"] [--plan]
//            [--model <provider>/<model>] [--output text|json|stream-json] [--continue | --resume <id>] [--max-turns n]
//   echo "解释一下这个仓库" | fc-agent -p
//
// 跑的是桌面端同一套后端（backend.mjs → agent-chat → 工具 / 权限 / hooks / 计划模式），只是没有窗口：
//   · 供应商 / 权限规则 / hooks / 网络搜索配置：从桌面端 config.json 只读借用（不回写）
//   · 会话库 / 项目登记 / 用量：放在独立的 <FinalCheck 数据目录>/cli 下，不和正在跑的桌面端抢同一个库
//   · 没人点审批：默认需要审批的操作一律拒绝（模型会收到「被拒绝」继续想办法），
//     --allow 给持久规则放行，--yes 等同桌面端的「完全权限」
//   · ask_user 提问卡：自动回答「没有用户在线，按你的判断继续」
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineUrl = (rel) => pathToFileURL(path.join(REPO_ROOT, rel)).href;

const HELP = `fc-agent —— FinalCheck 命令行 agent

用法：
  fc-agent -p "<任务>" [选项]
  echo "<任务>" | fc-agent -p [选项]

选项：
  -p, --print [任务]        非交互跑一轮，打印回答后退出（任务也可从 stdin 读）
  --project <dir>           在哪个项目里干活（默认当前目录）
  --yes                     完全权限：需要审批的操作直接放行（等同桌面端 Full access）
  --allow <规则>            放行规则，可重复，如 --allow "run_command(npm test:*)" --allow edit_file
  --deny <规则>             拒绝规则，可重复
  --plan                    计划模式：先调查出计划，没人批准 → 只交计划不动手
  --model <供应商/模型>      覆盖默认模型（供应商写 id 或名字）
  --output <格式>           text（默认）| json（结束时一行 JSON）| stream-json（每个事件一行 JSON）
  --continue                接着本项目最近一个 CLI 会话聊
  --resume <会话 id>        接着指定会话聊
  --quiet                   不在 stderr 打印工具进度
  -h, --help                显示帮助

退出码：0 成功；1 回合出错；2 参数错误。`;

function parseArgs(argv) {
  const o = { allow: [], deny: [], output: 'text' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} 需要一个值`); return v; };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-p' || a === '--print') { o.print = true; if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) o.prompt = argv[++i]; }
    else if (a === '--project') o.project = next();
    else if (a === '--yes' || a === '--dangerously-skip-permissions') o.yes = true;
    else if (a === '--allow') o.allow.push(next());
    else if (a === '--deny') o.deny.push(next());
    else if (a === '--plan') o.plan = true;
    else if (a === '--model') o.model = next();
    else if (a === '--output' || a === '--output-format') o.output = next();
    else if (a === '--continue' || a === '-c') o.continue = true;
    else if (a === '--resume' || a === '-r') o.resume = next();
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (!a.startsWith('-') && o.print && o.prompt === undefined) o.prompt = a;
    else throw new Error(`不认识的参数：${a}`);
  }
  if (!['text', 'json', 'stream-json'].includes(o.output)) throw new Error(`--output 只能是 text / json / stream-json`);
  return o;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

const clip = (v, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n\n${HELP}\n`); return 2; }
  if (opts.help || !opts.print) { process.stdout.write(HELP + '\n'); return opts.help ? 0 : 2; }
  const prompt = String(opts.prompt ?? (await readStdin())).trim();
  if (!prompt) { process.stderr.write('没有任务：-p "<任务>" 或从 stdin 传入\n'); return 2; }
  const projectDir = path.resolve(opts.project || process.cwd());
  try { if (!statSync(projectDir).isDirectory()) throw new Error(); } catch { process.stderr.write(`项目目录不存在：${projectDir}\n`); return 2; }

  // ---- 数据目录：桌面端配置只读借用；CLI 自己的东西放 cli/ 下 ----
  const appData = process.env.APPDATA || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Roaming') : path.join(os.homedir(), '.config'));
  const desktopRoot = path.join(appData, 'FinalCheck');
  const desktopConfigFile = process.env.FINALCHECK_CONFIG_FILE || path.join(desktopRoot, 'config.json');
  const cliRoot = process.env.FC_AGENT_HOME || path.join(desktopRoot, 'cli');
  let base = {};
  try { base = JSON.parse(readFileSync(desktopConfigFile, 'utf8')); } catch { /* 没配置：下面报错 */ }
  const providers = Array.isArray(base.providers) ? base.providers.filter((p) => p && p.enabled !== false) : [];
  if (!providers.length) { process.stderr.write(`没找到可用的模型供应商：先在桌面端「设置 → 模型」里配一个（读取 ${desktopConfigFile}）\n`); return 2; }

  let providerId = base.activeProviderId || providers[0].id;
  let model = base.activeModel || '';
  if (opts.model) {
    const cut = opts.model.indexOf('/');
    const pName = cut > 0 ? opts.model.slice(0, cut) : '';
    const mName = cut > 0 ? opts.model.slice(cut + 1) : opts.model;
    const prov = pName ? providers.find((p) => p.id === pName || String(p.name || '').toLowerCase() === pName.toLowerCase()) : providers.find((p) => p.id === providerId) || providers[0];
    if (!prov) { process.stderr.write(`没有这个供应商：${pName}\n`); return 2; }
    providerId = prov.id;
    model = mName;
  }

  const rules = base.permissionRules && typeof base.permissionRules === 'object' ? base.permissionRules : {};
  const cfg = {
    ...base,
    permissionMode: opts.yes ? 'full' : 'ask',
    permissionRules: {
      allow: [...(Array.isArray(rules.allow) ? rules.allow : []), ...opts.allow],
      deny: [...(Array.isArray(rules.deny) ? rules.deny : []), ...opts.deny]
    }
  };
  mkdirSync(cliRoot, { recursive: true });
  const cliConfigFile = path.join(cliRoot, 'config.json'); // 本次运行的配置快照（含 API key，和桌面端 config.json 同一目录权限）
  writeFileSync(cliConfigFile, JSON.stringify(cfg, null, 2));
  Object.assign(process.env, {
    FINALCHECK_CONFIG_FILE: cliConfigFile,
    FINALCHECK_PROJECTS_FILE: path.join(cliRoot, 'projects.json'),
    FINALCHECK_SESSIONS_DIR: path.join(cliRoot, 'sessions'),
    FINALCHECK_SPILL_DIR: path.join(cliRoot, 'spill'),
    FINALCHECK_SNAPSHOTS_DIR: path.join(cliRoot, 'snapshots'),
    FINALCHECK_USAGE_FILE: process.env.FINALCHECK_USAGE_FILE || path.join(cliRoot, 'usage.json'),
    FINALCHECK_SESSION_STORE: process.env.FINALCHECK_SESSION_STORE || 'sqlite'
  });

  const [{ createBackend }, { createConfigStore }, { installSafeIpc }, projects, sessions] = await Promise.all([
    import(engineUrl('desktop/src/main/backend.mjs')),
    import(engineUrl('desktop/src/main/ipc/config-store.mjs')),
    import(engineUrl('desktop/src/main/error-guard.mjs')),
    import(engineUrl('desktop/src/main/projects.mjs')),
    import(engineUrl('desktop/src/main/sessions.mjs'))
  ]);

  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const info = (line) => { if (!opts.quiet && opts.output === 'text') process.stderr.write(line + '\n'); };

  const handlers = new Map();
  const listeners = new Set();
  const fakeWin = { isDestroyed: () => false, webContents: { send: (ch, p) => { for (const fn of [...listeners]) { try { fn(ch, p); } catch { /* 忽略 */ } } } } };
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: (ch) => handlers.delete(ch), on() {} };
  installSafeIpc(ipcMain, { warn: { warn: () => {} } });
  const invoke = (ch, ...args) => { const fn = handlers.get(ch); if (!fn) throw new Error('IPC 未注册：' + ch); return fn({ sender: null }, ...args); };

  const proj = await projects.addProject(projectDir, { name: path.basename(projectDir) || 'project' });
  const store = createConfigStore({ app: { getLocale: () => 'zh-CN' }, getDataRoot: () => cliRoot, engineUrl });
  const backend = createBackend({ ipcMain, getWin: () => fakeWin, getDataRoot: () => cliRoot, engineUrl, repoRoot: REPO_ROOT, store, log: () => {} });
  await backend.boot({ project: proj });
  await backend.registerCoreIpc();
  // 会话库固定在 cli/ 下（桌面端把会话放在 <项目>/.finalcheck/sessions；CLI 不去抢那个库）
  process.env.FINALCHECK_SESSIONS_DIR = path.join(cliRoot, 'sessions', String(proj.id || 'p'));
  mkdirSync(process.env.FINALCHECK_SESSIONS_DIR, { recursive: true });

  let planText = '';
  let sid = null;
  // 审批 / 提问卡：没人在线
  listeners.add((ch, p) => {
    if (ch === 'finalcheck:approval-request') {
      info(`  ⛔ 需要审批，已拒绝：${p?.tool} ${clip(p?.summary, 120)}（--yes 或 --allow 放行）`);
      if (opts.output === 'stream-json') out({ type: 'approval', tool: p?.tool, summary: p?.summary, decision: 'rejected' });
      setImmediate(() => { void invoke('finalcheck:approval-decide', p.callId, 'rejected'); });
    } else if (ch === 'finalcheck:ask-user') {
      const isPlan = p?.kind === 'plan';
      const answer = isPlan ? '继续完善计划' : '（命令行模式，没有用户在线）请按你的最佳判断继续，并在最后的回答里写明你做了哪些假设。';
      if (opts.output === 'stream-json') out({ type: 'ask_user', question: p?.question, kind: p?.kind || null, answer });
      if (isPlan) {
        // 计划模式没人批准：把计划打出来，取消这一轮（不动手）
        planText = String(p?.question || '');
        setImmediate(() => { void invoke('finalcheck:agent-cancel', sid); });
        return;
      }
      setImmediate(() => { void invoke('finalcheck:ask-user-answer', { callId: p.callId, answer }); });
    }
  });

  // ---- 会话 ----
  let history = [];
  if (opts.resume || opts.continue) {
    if (opts.resume) sid = opts.resume;
    else {
      const list = await invoke('finalcheck:sessions:list');
      const arr = Array.isArray(list) ? list : (list?.sessions || []);
      sid = arr.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]?.id || null;
    }
    if (sid) {
      const s = await invoke('finalcheck:sessions:open', sid);
      if (s?.error) { process.stderr.write(`打不开会话 ${sid}：${s.error}\n`); return 2; }
      const { buildSendHistory } = await import(engineUrl('desktop/src/renderer/lib/interrupted-digest.mjs'));
      history = buildSendHistory((s.messages || []).map((m) => ({ role: m.role, content: m.content ?? '', error: m.error ?? null, interrupted: !!m.interrupted, trace: m.trace || [], ...(m.kind ? { kind: m.kind } : {}) }))).wire;
    }
  }
  if (!sid) {
    const s = await invoke('finalcheck:sessions:new', prompt.replace(/\s+/g, ' ').slice(0, 30));
    if (s?.error) { process.stderr.write(`建会话失败：${s.error}\n`); return 1; }
    sid = s.id;
  }
  await invoke('finalcheck:sessions:set-model', sid, { providerId, ...(model ? { model } : {}) });

  // ---- 跑一轮 ----
  let streamed = '';
  const t0 = Date.now();
  listeners.add((ch, p) => {
    if (p?.sessionId !== sid) return;
    if (ch === 'finalcheck:agent-token') {
      streamed += p.text || '';
      if (opts.output === 'text') process.stdout.write(p.text || '');
      else if (opts.output === 'stream-json') out({ type: 'token', text: p.text || '' });
      return;
    }
    if (ch !== 'finalcheck:agent-event') return;
    const ev = p.ev || {};
    if (opts.output === 'stream-json' && !['activity', 'phase', 'thinking-token', 'reasoning'].includes(ev.kind)) out({ type: 'event', ev });
    if (ev.kind === 'tool-start' || ev.kind === 'tool') info(`  ▸ ${ev.tool || ev.name}${ev.args ? ' ' + clip(ev.args, 140) : ''}`);
    else if (ev.kind === 'tool-end' && (ev.ok === false || ev.error)) info(`  ✗ ${ev.tool || ev.name}：${clip(ev.error, 160)}`);
    else if (ev.kind === 'warning' || ev.kind === 'notice') info(`  [${ev.kind}] ${clip(ev.message || ev.text || '', 200)}`);
  });

  const onSig = () => { void invoke('finalcheck:agent-cancel', sid); };
  process.once('SIGINT', onSig);
  let r;
  try {
    r = await invoke('finalcheck:agent-chat', [...history, { role: 'user', content: prompt }], [], sid, { planMode: !!opts.plan });
  } finally {
    process.removeListener('SIGINT', onSig);
  }
  const answer = planText ? `【计划（命令行模式没人批准，未执行）】\n${planText}` : String(r?.answer || streamed || '');
  const trace = Array.isArray(r?.trace) ? r.trace : [];
  const error = planText ? null : (r?.error ? String(r.error) : null);
  if (opts.output === 'text') {
    if (planText) process.stdout.write((streamed ? '\n\n' : '') + answer + '\n');
    else if (!streamed && answer) process.stdout.write(answer + '\n');
    else process.stdout.write('\n');
    if (error) process.stderr.write(`错误：${error}\n`);
    info(`— ${(((Date.now() - t0) / 1000)).toFixed(1)}s · ${trace.length} 次工具 · 会话 ${sid}（--resume ${sid} 接着聊）`);
  } else {
    out({ type: 'result', sessionId: sid, answer, error, planOnly: !!planText, tools: trace.map((x) => x?.tool || x?.name).filter(Boolean), ms: Date.now() - t0 });
  }
  try { await backend.shutdown?.(); } catch { /* 忽略 */ }
  try { sessions.closeAllSessionDatabases?.(); } catch { /* 忽略 */ }
  return error ? 1 : 0;
}

main().then((code) => { process.exitCode = code; setTimeout(() => process.exit(code), 200).unref(); }, (e) => {
  process.stderr.write(`fc-agent 出错：${e?.stack || e}\n`);
  process.exit(1);
});
