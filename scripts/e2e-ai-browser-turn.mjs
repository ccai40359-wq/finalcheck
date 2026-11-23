// 0.32.6 第三层补齐：**AI 操作**这一段（用户图里的「AI 操作 → 验证结果」）。
//
// 为什么需要它（诚实的缺口）：
// 已有的 scripts/testbench-rail-humanflow.mjs 是「真人链路」——真 Electron、真鼠标事件、
// 真原生层（CDP 的 Input.dispatchMouseEvent + WebContentsView bounds 校验），但它的
// provider baseUrl 指向本地 server 的 /v1，而那个 server **没有实现 /v1，一律 404**。
// 结论：它只证明了「人能用」，没证明「AI 替你用完之后结果对不对」。
//
// 这个脚本补的就是那一段：起一个**最小 SSE 网关**（POST /v1/chat/completions），
// 按脚本吐 tool_calls，让产品自己的 agent 引擎（runAgentTurn，与真实运行同一条代码路径）
// 真的跑完一个回合，然后断言：
//   ① 工具真的被调用（不是模型嘴上说 —— 只看 out.trace 里有没有对应条目）
//   ② 页面真的开在右栏、AI 工作标签正确
//   ③ 结论必须与页面实际内容一致（页面里放了一句随机 token，模型只能通过
//      browser_snapshot 读到它；答案里出现这个 token 才算"真的看到了"）
//
// 为什么 token 是关键：不这么做，模型完全可以编一句"已打开页面并确认无误"就收工。
// 随机 token 只存在于页面正文里，只有真调用快照才能拿到 —— 这是"结果验证"的硬判据。
//
// 用法：node scripts/e2e-ai-browser-turn.mjs
// 退出码：0 通过 / 1 失败
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 页面里藏一句随机 token：模型只能靠真的读页面才能拿到它。
// ⚠️ 必须由**父进程**生成并经环境变量传进 Electron 子进程：
// 否则两边各生成一次，断言比的是两个不同的 token（第一次写就踩了这个）。
const SECRET = String(process.env.FC_E2E_SECRET || '');
const PAGE_ONE = 'PAGE ONE';

/* ---------------- 必须在真 Electron 里跑（为什么） ----------------
 * browser_navigate / browser_snapshot 这些工具**只在 getDesktopToolsAsync 存在时才会注册**
 * （它们依赖 Electron 的 desktopCapturer / WebContentsView）。纯 Node 里根本没有这两个工具，
 * 所以"AI 操作内置浏览器"这件事无法在纯 Node 里成立——那不是测试写法问题，是环境问题。
 * 做法沿用产品既有先例 scripts/browser-use-acceptance.mjs：写出 bootstrap 包，
 * 用 electron 启动它，让它回来 import 本文件（此时 process.versions.electron 为真）。 */
if (!process.versions.electron) {
  const electron = (await import('../desktop/node_modules/electron/index.js')).default;
  const { ELECTRON_RUN_AS_NODE: _nodeMode, ...env } = process.env;
  const secret = 'FC-' + randomBytes(6).toString('hex').toUpperCase();
  const evidence = path.join(ROOT, '.tmp', 'e2e-ai-browser-turn');
  await mkdir(path.join(evidence, 'bootstrap'), { recursive: true });
  await writeFile(path.join(evidence, 'bootstrap', 'package.json'), '{"main":"main.cjs"}');
  await writeFile(path.join(evidence, 'bootstrap', 'main.cjs'), `
    void import(${JSON.stringify(import.meta.url)}).catch((error) => {
      console.error(error); require('electron').app.exit(1);
    });
  `);
  console.log('[parent] secret=' + secret);
  const r = spawnSync(electron, [path.join(evidence, 'bootstrap'), ...process.argv.slice(2)], {
    stdio: 'inherit', windowsHide: true, timeout: 180000,
    env: { ...env, FC_E2E_SECRET: secret }
  });
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

/* ---------------- 网关：默认用**真网关**，--fake 才用脚本网关 ----------------
 * 为什么默认真网关（用户明确要求）：
 *   假网关只能证明「链路接对了」——工具注册、宿主注入、结果可验证都通。
 *   但它证明不了「真模型会不会用这些工具、会不会老实读页面再答」。
 *   真模型会自己决定调哪个工具、调几次、参数对不对，这才是端到端要验的。
 * 真网关来源：本机 `%APPDATA%/FinalCheck/config.json`（用户真实配置，不写死任何凭据）。
 * --fake 保留给离线/CI 回归（不需要网络和额度）。 */

const USE_FAKE = process.argv.includes('--fake');

async function resolveRealGateway() {
  const fs = await import('node:fs/promises');
  const candidates = [
    process.env.FC_E2E_CONFIG || '',
    process.env.FINALCHECK_CONFIG_FILE || '',
    path.join(process.env.APPDATA || '', 'FinalCheck', 'config.json'),
    path.join(ROOT, 'desktop', 'finalcheck.config.json')
  ].filter(Boolean);
  for (const file of candidates) {
    let raw;
    try { raw = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
    const providers = Array.isArray(raw?.providers) ? raw.providers : [];
    const usable = providers.filter((p) => p && p.enabled !== false && p.baseUrl && p.apiKey && (p.models || []).length);
    if (!usable.length) continue;
    // 优先 activeProviderId；它缺失时取第一个可用
    const pick = usable.find((p) => p.id === raw.activeProviderId) || usable[0];
    const model = pick.models[0];
    return {
      file,
      providerId: pick.id,
      baseUrl: String(pick.baseUrl),
      apiKey: String(pick.apiKey),
      model: typeof model === 'string' ? model : (model?.id || ''),
      apiFormat: pick.apiFormat || 'chat-completions'
    };
  }
  return null;
}


// 页面站：/one 里嵌 SECRET（模拟"课程页/登录后页面"里才有的信息）
const site = createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><head><title>${PAGE_ONE}</title></head>
    <body style="margin:0;padding:24px;background:#fff7e6;font:18px/1.6 sans-serif">
      <h1>${PAGE_ONE}</h1>
      <p id="secret">页面校验码：<b>${SECRET}</b></p>
      <p>这段文字用于验证「AI 真的读到了页面内容」，而不是编一句结论。</p>
    </body></html>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteOrigin = `http://127.0.0.1:${site.address().port}`;

// 假网关：按脚本决定第 N 次请求该吐什么
//   第 1 轮 → tool_call browser_navigate(url)
//   第 2 轮 → tool_call browser_snapshot()
//   第 3 轮 → 纯文本结论（必须包含 SECRET 才算真读到）
let llmRound = 0;
const seenRequests = [];

function sse(res, payload) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  for (const part of payload) res.write(`data: ${JSON.stringify(part)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** 一轮 tool_call 的 SSE 片段（OpenAI 流式格式：tool_calls 分片下发） */
function toolCallChunks({ id, name, args }) {
  return [
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] },
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] },
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
  ];
}
/** 一轮纯文本收尾的 SSE 片段 */
function textChunks(text) {
  return [
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] },
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] },
    { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ];
}

const gateway = createServer((req, res) => {
  if (!req.url.startsWith('/v1/chat/completions') || req.method !== 'POST') {
    res.writeHead(404); return res.end('not found');
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    llmRound += 1;
    const msgCount = Array.isArray(parsed?.messages) ? parsed.messages.length : 0;
    const toolResults = Array.isArray(parsed?.messages)
      ? parsed.messages.filter((m) => m.role === 'tool').length : 0;
    seenRequests.push({ round: llmRound, msgCount, toolResults });
    console.log(`[gateway] round=${llmRound} messages=${msgCount} toolResults=${toolResults}`);

    // 决策：以"已经收到几条 tool 结果"为准（比轮次更稳：重试/心跳不会打乱）
    if (toolResults === 0) {
      return sse(res, toolCallChunks({
        id: 'call_nav',
        name: 'browser_navigate',
        args: JSON.stringify({ url: siteOrigin + '/one' })
      }));
    }
    if (toolResults === 1) {
      return sse(res, toolCallChunks({ id: 'call_snap', name: 'browser_snapshot', args: '{}' }));
    }
    // 收尾：必须引用 SECRET（真读到了才有）
    return sse(res, textChunks(
      `已打开 ${PAGE_ONE}，页面校验码是 ${SECRET}。结论：AI 通过内置浏览器成功读取了页面内容。`
    ));
  });
});
let fakeGatewayBase = null;
if (USE_FAKE) {
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  fakeGatewayBase = `http://127.0.0.1:${gateway.address().port}/v1`;
}
console.log('[site]', siteOrigin);
console.log('[mode]', USE_FAKE ? 'FAKE gateway（离线回归）' : 'REAL gateway（真模型）');
console.log('[SECRET]', SECRET);


/* ---------------- 真引擎：与产品运行同一条代码路径 ---------------- */

const results = [];
const record = (step, name, ok, detail) => {
  results.push({ step, name, ok, detail: String(detail ?? '').slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${step}] ${name}  ${String(detail ?? '').slice(0, 220)}`);
};

try {
  const { runAgentTurn } = await import(pathToFileURL(path.join(ROOT, 'desktop/src/main/agent-service.mjs')).href);
  const { createAgentTools } = await import(pathToFileURL(path.join(ROOT, 'desktop/src/main/agent-tools.mjs')).href);

  // 关键：getDesktopToolsAsync 必须提供 —— browser_navigate / browser_snapshot
  // **只在它存在时才注册**（它们要 Electron 的 desktopCapturer / WebContentsView）。
  // 走的就是产品 ipc-agent 里那条加载路径（动态 import browser-use.mjs）。
  let buModule = null;
  let winRef = null;
  const getDesktopToolsAsync = async () => {
    if (!buModule) {
      buModule = await import(pathToFileURL(path.join(ROOT, 'desktop/src/main/browser-use.mjs')).href);
      // 把「右栏内嵌宿主」交给它：不注入的话它会退回旧的隐藏窗口（页面在一个看不见的窗口里）。
      // ⚠️ 契约是 viewHostProvider(sessionId) 必须返回**一个可用宿主对象**（要带 newTab），
      // 不能返回 { hostForSession } 这种包装器——ensureViewHost 直接判 h.newTab，
      // 包装器没有 newTab 就会被当成"没有宿主"而静默退回隐藏窗口（第一次写踩了这个，
      // 表现为 browser_snapshot 照样成功但 listTabs 说 embedded:false）。
      const host = await import(pathToFileURL(path.join(ROOT, 'desktop/src/main/browser-view-host.mjs')).href);
      // 宿主必须先认一个主窗口（它是 WebContentsView 的父窗口）；不认就拿不到可用的 view。
      // 这里建一个真的 Electron 窗口（不显示），与产品里「内嵌进右栏」的物理前提一致。
      const { BrowserWindow } = await import('electron');
      const win = new BrowserWindow({ show: false, width: 900, height: 700 });
      host.ensureHost(win, () => {});
      winRef = win;
      buModule.setViewHostProvider?.((sid) => host.hostForSession(sid));
    }
    return { browserUse: buModule, computerUse: null };
  };

  // 只暴露浏览器工具（够用且不引入审计/命令执行带来的副作用）
  const allTools = createAgentTools({
    repoRoot: ROOT,
    getDesktopToolsAsync,
    // ⚠️ askUser 必须提供（真网关实测暴露的缺口）：
    // 模型第一次开网页前会调 ask_user 问「用哪种浏览器模式」；没有实现就返回 ok=false，
    // 它得自己改路径再试（本次实测它绕过去了，换个模型可能就卡死在这里）。
    // 真机上这是一张提问卡由用户点选；探针里没人点，所以这里替它答「一次性无痕」。
    askUser: async () => ({ selected: ['一次性无痕'], text: '', source: 'e2e-probe' }),
    permissions: {
      noteTarget() {},
      sessionAllowed: () => true,
      commandPrefix: (cmd) => String(cmd).split(/\s+/)[0],
      requestApproval: async () => 'allowed-once'
    },
    // 浏览器策略：无痕（不写盘，测试结束即丢）
    browserSessionPolicy: async () => ({ mode: 'oneshot', chosen: true, persistent: false, partition: 'fc-browser-use' })
  });
  const tools = {
    browser_navigate: allTools.browser_navigate,
    browser_snapshot: allTools.browser_snapshot,
    browser_evaluate: allTools.browser_evaluate,
    browser_click: allTools.browser_click,
    browser_close: allTools.browser_close
  };
  for (const [k, v] of Object.entries(tools)) {
    if (typeof v !== 'function') throw new Error('缺少工具：' + k);
  }

  // ---- 网关选择：默认真网关（用户明确要求），--fake 才用脚本网关 ----
  let llmConfig;
  if (USE_FAKE) {
    llmConfig = { baseUrl: fakeGatewayBase, apiKey: 'test-key', model: 'ui-model' };
  } else {
    const real = await resolveRealGateway();
    if (!real) {
      record('A0', '找到真网关配置', false,
        '本机没有可用的 provider（查过 FC_E2E_CONFIG / FINALCHECK_CONFIG_FILE / %APPDATA%/FinalCheck/config.json）。'
        + '若只想验链路请加 --fake。');
      throw new Error('no-real-gateway');
    }
    console.log(`[gateway] REAL ${real.baseUrl}  model=${real.model}  source=${real.file}`);
    llmConfig = { baseUrl: real.baseUrl, apiKey: real.apiKey, model: real.model };
  }

  const events = [];
  const started = Date.now();
  const out = await runAgentTurn({
    config: llmConfig,
    messages: [{
      role: 'user',
      content: `请用内置浏览器打开 ${siteOrigin}/one ，读一下页面内容，然后把页面上的校验码原样告诉我。`
    }],
    tools,
    // 真模型会自己决定调几次工具 —— 给足轮次，但不要无限（这是脚本级保护）
    maxTurns: 8,
    onEvent: (e) => {
      events.push(e);
      if (e.kind === 'tool-start') console.log(`  [tool-start] ${e.name} ${String(e.args || '').slice(0, 120)}`);
      if (e.kind === 'tool-end') console.log(`  [tool-end]   ${e.name} ok=${e.ok} ${e.ms}ms`);
      if (e.kind === 'retry') console.log(`  [retry]      ${e.attempt}/${e.max} ${e.reason}`);
    }
  });
  const elapsed = Date.now() - started;
  const used = (out.trace || []).map((t) => t.tool);
  console.log('\n--- tools used ---\n' + (used.join('\n') || '(none)'));
  console.log('\n--- answer ---\n' + String(out.answer || out.error || '').slice(0, 800));
  console.log(`\n--- elapsed ${elapsed}ms  reasoning=${String(out.reasoning || '').length} ---`);
  if (out.error) console.log('[engine error]', String(out.error).slice(0, 400));

  /* ① 工具真的被调用 */
  record('A1', 'AI 真的调用了 browser_navigate（不是嘴上说）',
    used.includes('browser_navigate'),
    JSON.stringify({ used, error: out.error || null }));

  /* ② AI 真的拿到了页面内容
     真网关实测纠正了一个我原本写错的假设：
     `browser_navigate` 默认就带 `observe: args.observe !== false`（**默认把整页快照塞进返回值**，
     产品有意设计，省一次往返）。所以模型常常**只调 navigate 就能读到内容**，
     再调 snapshot/evaluate 反而是多余动作。判据必须认这一点，否则会把正常行为判成失败
     ——这正是一次真网关跑出来才发现的（第一次跑它调 evaluate，第二次跑它只调 navigate）。 */
  const READ_TOOLS = ['browser_snapshot', 'browser_evaluate'];
  const readTool = used.find((t) => READ_TOOLS.includes(t)) || null;
  // navigate 的返回值也可能带快照：把它算作"读取证据"的一种（但下面 A5 会区分来源）
  const navEntry = (out.trace || []).find((t) => t.tool === 'browser_navigate');
  const navText = navEntry ? JSON.stringify(navEntry.result || {}) : '';
  const navCarriedSnapshot = navText.includes(SECRET);
  record('A2', 'AI 拿到了页面内容（读页面工具，或 navigate 返回值自带快照）',
    Boolean(readTool) || navCarriedSnapshot,
    JSON.stringify({ used, readTool, navCarriedSnapshot }));

  /* ③ 页面真的开在内置浏览器里（宿主视图存在） */
  // ⚠️ 必须用同一个 sessionId 读取：宿主按会话隔离（hosts Map），
  // 而 runAgentTurn 未传 sessionId 时作用域是 null；用默认 listTabs 会在另一个作用域里查。
  const bu = buModule || await import(pathToFileURL(path.join(ROOT, 'desktop/src/main/browser-use.mjs')).href);
  const tabs = bu.forSession ? bu.forSession(null).listTabs() : bu.listTabs?.() || {};
  const opened = (tabs.tabs || []).some((t) => String(t.url || '').includes('/one'));
  record('A3', '页面真的开在内置浏览器里（宿主标签含 /one）',
    Boolean(tabs.embedded) && opened,
    JSON.stringify({ embedded: tabs.embedded, tabs: (tabs.tabs || []).map((t) => t.url) }));

  /* ④-A 工具级证据（唯一可信来源）
     真网关实测的教训：模型在总结里写「browser_snapshot 与 innerText 两处独立读取一致」，
     但它**只调了 browser_evaluate / 只调了 navigate** —— 模型在自我描述上会编。
     所以这里**不看模型怎么说**，只从工具返回值里找 token：
     任一次工具返回值（navigate 自带快照 / snapshot / evaluate）里出现 token 才算真读到。 */
  const readEntries = (out.trace || []).filter((t) => READ_TOOLS.includes(t.tool));
  const readText = JSON.stringify(readEntries.map((e) => e.result || {}));
  const allToolText = readText + navText;
  const toolHasSecret = allToolText.includes(SECRET);
  const secretSource = navCarriedSnapshot ? 'navigate 自带快照' : (readText.includes(SECRET) ? '读页面工具' : '未找到');
  record('A5', '工具返回值里真的含页面校验码（工具级证据，不看模型自述）',
    toolHasSecret,
    JSON.stringify({ secretSource, readTools: readEntries.map((e) => e.tool), hasSecret: toolHasSecret, hasTitle: allToolText.includes(PAGE_ONE), len: allToolText.length }));

  /* ④-B 结论一致性：答案里的校验码必须与**工具返回值里实际出现的那一个**一致 */
  const answerText = String(out.answer || '');
  record('A4', 'AI 的结论引用了读到的校验码（且工具返回值确实含同一个码）',
    toolHasSecret && answerText.includes(SECRET),
    JSON.stringify({ secretInAnswer: answerText.includes(SECRET), toolHasSecret, secretSource, answerHead: answerText.slice(0, 160) }));

  /* ⑥ 诚实性：模型自述里点名了某个工具，它就**必须真的调用过**那个工具。
     真网关实测抓到过：它写「snapshot 与 innerText 两处独立读取一致」，但没调 snapshot。 */
  const claimedTools = READ_TOOLS.filter((t) => answerText.includes(t));
  const phantomTools = claimedTools.filter((t) => !used.includes(t));
  record('A6', '模型没有"声称调用过某工具但实际没调"（防自我描述编造）',
    phantomTools.length === 0,
    JSON.stringify({ claimedTools, phantomTools, used }));

  try { await bu.close?.(); } catch { /* 已关 */ }
  try { winRef?.destroy?.(); } catch { /* 已关 */ }
} catch (e) {
  record('A0', '引擎跑完一个回合（不抛错）', false, e?.stack || e?.message || e);
} finally {
  if (USE_FAKE) { try { gateway.close(); } catch { /* 已关 */ } }
  try { site.close(); } catch { /* 已关 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== AI 操作端到端 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}） ===`);
process.exitCode = failed.length === 0 ? 0 : 1;
// 真 Electron 里必须显式退出，否则隐藏窗口会把进程挂住
try { const { app } = await import('electron'); if (app?.isReady?.()) app.exit(process.exitCode); } catch { /* 纯 Node 无 app */ }
await sleep(200);
process.exit(process.exitCode);
