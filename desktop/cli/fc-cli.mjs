// FinalCheck 纯终端聊天 CLI（学 Claude Code 的交互形态）。
//
//   fchat [项目目录]        进入终端对话（默认当前目录）
//
// 复用桌面端整条引擎（已核实全部无 Electron 耦合，终端直接可用）：
//   · agent-service.runAgentTurn —— 流式回合主循环（两级压缩 / 40 轮 / usage）
//   · agent-tools.createAgentTools —— 工具面 + 三道闸（敏感路径 / 项目边界 / 删除目标）
//   · sessions —— 会话落库（纯 Node 下自动走 JSON 后端，存 ~/.finalcheck-cli/sessions）
//   · policy —— workspace/readonly 边界闸
//
// 斜杠命令（学 CC）：/help /new /resume /sessions /exit
// Ctrl+C：回合中 = 中止本回合；空闲 = 退出。
import readline from 'node:readline';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const CLI_SESSIONS_DIR = path.join(HOME, '.finalcheck-cli', 'sessions');
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

// ---- 终端图形（学 CC / Hermes CLI）：显示宽度按 CJK=2 算，框线才对得齐 ----
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u4E00-\u9FFF\u3000-\u303F]/.test(ch) ? 2 : 1;
  }
  return w;
}
const padTo = (s, width) => String(s) + ' '.repeat(Math.max(0, width - displayWidth(s)));
function box(lines, title = '') {
  const w = Math.max(...lines.map((l) => displayWidth(l)), displayWidth(title)) + 2;
  const top = title
    ? `╭─ ${title} ${'─'.repeat(Math.max(1, w - displayWidth(title) - 1))}╮`
    : `╭${'─'.repeat(w)}╮`;
  const body = lines.map((l) => `│ ${padTo(l, w)} │`).join('\n');
  return `${top}\n${body}\n╰${'─'.repeat(w)}╯`;
}

const LOGO_LINES = [
  ' ███████╗ ██████╗',
  ' ██╔════╝██╔════╝',
  ' █████╗  ██║',
  ' ██╔══╝  ██║',
  ' ██║     ╚██████╗',
  ' ╚═╝      ╚═════╝'
];

// 回合等待指示器（学 CC 的转菊；只在 TTY 下动，管道模式安静）
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const spinner = { timer: null, frame: 0, label: '思考中…' };
function spinnerStart(label) {
  if (process.stdin.isTTY !== true || spinner.timer) return;
  spinner.label = label || '思考中…';
  spinner.timer = setInterval(() => {
    spinner.frame = (spinner.frame + 1) % SPIN_FRAMES.length;
    process.stdout.write(`\r\x1b[2K${DIM}${SPIN_FRAMES[spinner.frame]} ${spinner.label}${RESET}  `);
  }, 110);
}
function spinnerStop() {
  if (!spinner.timer) return;
  clearInterval(spinner.timer);
  spinner.timer = null;
  process.stdout.write('\r\x1b[2K');
}

const argDir = path.resolve(process.argv[2] || process.cwd());
if (!fsSync.existsSync(argDir)) {
  console.error(`项目目录不存在：${argDir}`);
  process.exit(2);
}

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const { runAgentTurn, TOOLS_SCHEMA } = await import(path.join(ROOT, 'desktop/src/main/agent-service.mjs'));
const { createAgentTools, GREP_CODE_SCHEMA } = await import(path.join(ROOT, 'desktop/src/main/agent-tools.mjs'));
const { createPolicy } = await import(path.join(ROOT, 'desktop/src/main/policy.mjs'));
const { appDataDir } = await import(path.join(ROOT, 'desktop/src/main/platform-paths.mjs'));
const i18n = await import(path.join(ROOT, 'desktop/src/renderer/i18n/core.mjs'));
const sessions = await import(path.join(ROOT, 'desktop/src/main/sessions.mjs'));

// ---- 配置（读桌面端同一份 config.json）----
function loadCfg() {
  try {
    const p = path.join(appDataDir(), 'config.json');
    return JSON.parse(fsSync.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}
const cfg = loadCfg();
i18n.setLanguage(i18n.resolveLanguage(cfg.language, process.env.LANG));
const t = i18n.t;

const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
const wanted = providers.find((p) => p.id === cfg.activeProviderId) || null;
const prov = (wanted && wanted.enabled !== false && wanted.baseUrl && wanted.apiKey && (wanted.models || []).length)
  ? wanted
  : providers.find((p) => p.enabled !== false && p.baseUrl && p.apiKey && (p.models || []).length) || null;
if (!prov) {
  console.error('还没有可用的模型供应商：请在桌面端「模型设置」里配好（Base URL / API Key / 模型），CLI 读同一份配置。');
  console.error(`配置路径：${path.join(appDataDir(), 'config.json')}`);
  process.exit(2);
}
const modelIds = (prov.models || []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
const model = (modelIds.includes(cfg.activeModel) ? cfg.activeModel : modelIds[0]) || null;
if (!model) {
  console.error(`供应商「${prov.name}」没有可用模型。`);
  process.exit(2);
}
if (prov.apiFormat && prov.apiFormat !== 'chat-completions') {
  console.error(`供应商「${prov.name}」的 API 格式（${prov.apiFormat}）暂不支持，请改用 chat-completions。`);
  process.exit(2);
}

// ---- 会话存储（CLI 自己的目录，纯 Node 自动走 JSON 后端）----
fsSync.mkdirSync(CLI_SESSIONS_DIR, { recursive: true });
sessions.setSessionDirResolver(() => CLI_SESSIONS_DIR);

const policyModeOf = (v) => (v === 'off' ? 'off' : v === 'readonly' ? 'readonly' : 'workspace');
const policy = createPolicy({ projectPath: argDir, mode: policyModeOf(cfg.sandboxMode) });

// 终端审批（学 CC 的权限询问）：打印请求摘要，y 确认 / 其它拒绝
async function terminalApproval(req) {
  let summary = '';
  try {
    const o = typeof req === 'string' ? null : req;
    summary = o ? JSON.stringify(o).slice(0, 300) : String(req).slice(0, 300);
  } catch { summary = String(req).slice(0, 300); }
  process.stdout.write(`\n${YELLOW}需要批准：${summary}${RESET}\n批准？(y/N) `);
  const ok = await askLine();
  return /^y(es)?$/i.test(ok.trim()) ? 'allowed-once' : 'denied';
}

// 单行提问（/resume 选编号、终端审批）：优先从输入队列取（管道模式下应答行早就排进来了），
// 队列空才等 readline 的下一行。asking=true 时主队列忽略新行。
let asking = false;
let askPending = null;
function askLine() {
  asking = true;
  if (queue.length) {
    asking = false;
    return Promise.resolve(queue.shift());
  }
  return new Promise((resolve) => {
    const onLine = (line) => { rl.removeListener('line', onLine); asking = false; askPending = null; resolve(line); };
    askPending = () => { rl.removeListener('line', onLine); asking = false; askPending = null; resolve(''); };
    rl.once('line', onLine);
  });
}

const permissions = { requestApproval: terminalApproval };
const recordAudit = async () => {};

let sessionId = null;
let history = [];

function newLocalSession() {
  return sessions.newSession(t('新会话')).then((s) => {
    sessionId = s.id;
    history = [];
  });
}

const turnAbort = { current: null };
let turning = false;

function dimLine(s) { process.stdout.write(`${DIM}${s}${RESET}\n`); }

function handleEvent(ev) {
  if (!ev || !ev.kind) return;
  switch (ev.kind) {
    case 'tool-start':
      spinnerStop();
      dimLine(`  ⏺ ${ev.name}(${String(ev.args || '').replace(/\s+/g, ' ').slice(0, 110)})`);
      break;
    case 'tool-end':
      if (ev.ok === false && !ev.cancelled) dimLine(`  ✗ ${ev.name} 失败（${ev.ms ?? '?'}ms）`);
      break;
    case 'warning':
      spinnerStop();
      process.stdout.write(`${YELLOW}⚠ ${ev.message || ''}${RESET}\n`);
      break;
    case 'compact-boundary':
      dimLine('  [上下文已压缩]');
      break;
    case 'error':
      process.stdout.write(`${RED}${ev.message || ev.error || '错误'}${RESET}\n`);
      break;
    default:
      break; // reasoning / activity / turn-start 等终端上不刷屏
  }
}

async function runTurn(text) {
  turning = true;
  let anyToken = false;
  spinnerStart('思考中…');
  try {
    const tools = createAgentTools({
      repoRoot: argDir,
      projectPath: argDir,
      policy,
      permissions,
      recordAudit,
      sessionId,
      commandIdleMs: cfg.commandIdleMs,
      aclSandbox: cfg.sandboxMode === 'on' ? true : undefined,
      signal: turnAbort.current.signal,
      onActivity: handleEvent
    });
    const out = await runAgentTurn({
      roleMode: /验收|体检|审计|渗透|压测|下载闸|报告|red ?team|audit|pentest|probe\b|L1\b|L2\b|L3\b/i.test(text) ? 'audit' : 'dev',
      config: {
        baseUrl: prov.baseUrl,
        apiKey: prov.apiKey,
        model,
        providerId: prov.id,
        toolConcurrency: Number(cfg.toolConcurrency) || 8
      },
      messages: [...history, { role: 'user', content: text }],
      tools,
      toolsSchema: [...TOOLS_SCHEMA, GREP_CODE_SCHEMA],
      sessionId,
      cwd: argDir,
      signal: turnAbort.current.signal,
      onToken: (d) => { if (!anyToken) spinnerStop(); anyToken = true; process.stdout.write(String(d)); },
      onEvent: handleEvent
    });
    spinnerStop();
    if (anyToken) process.stdout.write('\n');
    if (out?.error) {
      process.stdout.write(`${RED}${out.error}${RESET}\n`);
      if (out.partialContent) process.stdout.write(`${DIM}${out.partialContent}${RESET}\n`);
      return;
    }
    if (out?.cancelled) dimLine('  [已中止]');
    if (out?.usage) {
      const u = out.usage;
      dimLine(`  [tokens ↑${u.prompt ?? '?'} ↓${u.completion ?? '?'} · ${out.roundsUsed ?? '?'} 轮]`);
    }
    await sessions.appendTurn(sessionId, text, {
      content: out?.answer ?? out?.partialContent ?? '',
      reasoning: out?.reasoning ?? '',
      trace: Array.isArray(out?.trace) ? out.trace : [],
      model,
      interrupted: !!out?.cancelled
    });
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: out?.answer ?? out?.partialContent ?? '', trace: out?.trace ?? [] });
  } catch (e) {
    spinnerStop();
    process.stdout.write('\n');
    process.stdout.write(`${RED}回合异常：${String(e?.message || e)}${RESET}\n`);
  } finally {
    spinnerStop();
    turning = false;
    turnAbort.current = null;
  }
}

const HELP = [
  '直接输入 = 对话；模型可以读写本目录、跑命令（过 FC 三道闸：敏感路径/项目边界/删除目标）。',
  '/new 开新会话    /resume 选老会话继续    /sessions 只列出    /exit 退出    Ctrl+C 中止本回合/退出'
].join('\n');

function printWelcome() {
  const info = [
    `${BOLD}FinalCheck CLI${RESET}`,
    `${DIM}终端里的交付前验收助手（学 Claude Code 交互）${RESET}`,
    '',
    `模型  ${prov.name} / ${model}`,
    `项目  ${argDir}`,
    `会话  ${CLI_SESSIONS_DIR}`
  ];
  const width = Math.max(...LOGO_LINES.map((l) => displayWidth(l)));
  const rows = Math.max(LOGO_LINES.length, info.length);
  for (let i = 0; i < rows; i++) {
    const logoPart = CYAN + padTo(LOGO_LINES[i] || '', width) + RESET;
    process.stdout.write(logoPart + '   ' + (info[i] || '') + '\n');
  }
  console.log();
  console.log(box([
    '直接输入 = 对话；跑命令过 FC 三道闸（敏感路径 / 项目边界 / 删除目标）',
    '/new 开新会话   /resume 选老会话   /sessions 列出   /help 全部   /exit 退出',
    'Ctrl+C 中止本回合；再按一次退出'
  ], '开始'));
  console.log();
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${DIM}>${RESET} `,
  terminal: process.stdin.isTTY === true
});

async function doResume() {
  const list = (await sessions.listSessions() || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10);
  if (!list.length) { dimLine('（还没有历史会话）'); return; }
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
    console.log(`  [${i + 1}] ${(s.title || t('未命名会话')).slice(0, 40)}  ${s.turns ?? 0} 轮  ${when}`);
  }
  process.stdout.write('选择编号（回车取消）：');
  const ans = await askLine();
  const n = parseInt(String(ans).trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > list.length) { dimLine('（取消）'); return; }
  const s = await sessions.loadSession(list[n - 1].id);
  sessionId = s.id;
  history = Array.isArray(s.messages) ? s.messages.slice() : [];
  dimLine(`已切到「${s.title || t('未命名会话')}」（${history.filter((m) => m.role === 'user').length} 条用户消息）`);
}

// ---- 输入队列：TTY 与管道共用；一行处理完才处理下一行（管道 EOF 不丢回合）----
const queue = [];
let processing = false;
let inputClosed = false;

function schedule(line) {
  if (asking) return; // 提问中的行只给 askLine
  queue.push(String(line || ''));
  void drainQueue();
}

async function drainQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length) {
      await handleLine(queue.shift());
    }
  } catch (e) {
    process.stdout.write(`${RED}处理异常：${String(e?.message || e)}${RESET}\n`);
  }
  processing = false;
  if (inputClosed && !turning) finish();
}

async function handleLine(line) {
  const text = String(line || '').trim();
  if (!text) return;
  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    if (cmd === '/exit' || cmd === '/quit') { inputClosed = true; queue.length = 0; return; }
    if (cmd === '/help') { console.log(HELP); return; }
    if (cmd === '/new') { await newLocalSession(); dimLine(`新会话 ${sessionId}`); return; }
    if (cmd === '/sessions') {
      const list = (await sessions.listSessions() || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10);
      for (const s of list) console.log(`  ${(s.title || t('未命名会话')).slice(0, 40)}  ${s.turns ?? 0} 轮`);
      return;
    }
    if (cmd === '/resume') { await doResume(); return; }
    console.log(`未知命令 ${cmd}（/help 查看可用命令）`);
    return;
  }
  if (!sessionId) await newLocalSession();
  turnAbort.current = new AbortController();
  process.stdout.write(`${DIM}──── ${new Date().toLocaleTimeString()} ────${RESET}\n`);
  await runTurn(text);
}

function finish() {
  if (turnAbort.current) { try { turnAbort.current.abort(); } catch { /* 已退出 */ } }
  console.log('');
  process.exit(0);
}

rl.on('line', (line) => schedule(line));
rl.on('close', () => {
  inputClosed = true;
  if (askPending) askPending(); // EOF 时挂着的提问按「拒绝」收尾，回合正常结束再退出
  if (!processing && !turning) finish();
});
rl.on('SIGINT', () => {
  if (turning && turnAbort.current) {
    try { turnAbort.current.abort(); } catch { /* 已中止 */ }
    return;
  }
  rl.close();
});

// ---- 启动 ----
printWelcome();
if (process.stdin.isTTY !== true) dimLine('（非交互模式：从 stdin 逐行读，EOF 或 /exit 结束）');
await newLocalSession();
if (process.stdin.isTTY === true) rl.prompt();
