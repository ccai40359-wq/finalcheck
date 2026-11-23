// 0.31.2 UI 自检：压缩之后「上下文使用情况」必须立刻跟着降。
//
// 用户真机问题（截图证据）：压缩提示写「约 908451 token → 16411 token」，但输入框上方的
// Context 圆环 + 明细面板一动不动，看起来像压缩没生效。
//
// 这个自检真开 Electron（隔离 userData + 隔离项目目录），预置一个「已经压缩过」的会话，然后：
//   ① 打开该会话 → 开 Context 明细面板 → 读 used/window 与占用率
//   ② 断言打开的是我们的会话（不是空会话的新建页）——上一版就栽在这里：会话没加载，
//      12.6K/1.0M 其实是空会话的固定开销，看着「PASS」其实什么都没验证
//   ③ 反向对照：清掉摘要（同一会话、同一份历史）→ 占用率必须明显变大
//
// 用法：node scripts/ui-selfcheck-context-after-compact.mjs
// 证据：.tmp/context-after-compact/
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'context-after-compact');
const userData = path.join(out, 'user-data');
const projectsFile = path.join(userData, 'projects.json');
const projectDir = path.join(out, 'project');
// 会话目录必须与产品一致：<project>/.finalcheck/sessions（projects.mjs 的 sessionDirOf）。
// 上一版写成 <project>/.finalcheck，于是侧栏「No sessions」、面板全是空会话固定开销。
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
const PORT = 9332; // 与 9223（datacrawler）/ 9224（FC 真 Edge）/ 9331（浏览器会话自检）都不同
const TITLE = '上下文面板自检';

mkdirSync(out, { recursive: true });
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await rm(userData, { recursive: true, force: true }).catch(() => {});
// ⚠️ 三个目录都必须先建好：config.json / projects.json 都写在 userData 里，
// 上一版用 .catch() 吞掉了 ENOENT，Electron 起在「首次使用向导」，预置会话压根没被加载。
await mkdir(userData, { recursive: true });
await mkdir(sessionsDir, { recursive: true });

await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{
    id: 'p-ui', name: 'UI Test', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions',
    apiKey: 'test-key', models: [{ id: 'ui-model', contextWindow: 200000 }], enabled: true
  }],
  activeProviderId: 'p-ui',
  language: 'zh',
  theme: 'dark'
}, null, 2), 'utf8');

/* ---- ① 预置会话：两段很长的历史 + 一份「已压缩」摘要 ---- */
process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
process.env.FINALCHECK_PROJECTS_FILE = projectsFile;
process.env.FINALCHECK_DEFAULT_PROJECT = projectDir;

const sessions = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const { BOUNDARY_HEAD } = await import(pathToFileURL(path.join(root, 'desktop/src/main/compact.mjs')).href);

const created = await sessions.newSession(TITLE);
const sid = String(created.id);
// ⚠️ 顺序必须是「先有两段历史 → 压缩（cutAt 只覆盖这两段）→ 再产生新消息」。
// 上一版先追加了「继续」再压，cutAt 把「继续」也覆盖了，keepAfterCompactCut 的末尾连续对齐
// 匹配不上（matched=false → 退回全量），面板于是显示 16.3%、Messages 61.3%——压缩像没生效。
await sessions.appendUserMessage(sid, '请分析这个项目。' + '甲'.repeat(20000));
await sessions.appendAssistantMessage(sid, '分析结果如下。' + '乙'.repeat(20000), [], {});
const beforeCompact = await sessions.loadSession(sid);
const cutAt = Math.max(...beforeCompact.messages.map((m) => Number(m.at) || 0)) + 1;
await sessions.saveSummary(sid, `${BOUNDARY_HEAD}\n【交接摘要】之前分析了这个项目：读了 core.js、open-tx.cmd、props.js，确认 GPU 编码链路，跑了 nvidia-smi。结论：编码走 h264_nvenc。`, { cutAt });
// 压缩之后才到的新消息（真实 /compact 之后继续对话就是这样）
await sessions.appendUserMessage(sid, '继续');
// ⚠️ 最后显式改名：会话标题会被首条用户消息覆盖（产品行为），不固定名字的话
// 侧栏两条记录的显示文本都是「请分析这个项目。甲甲…」，脚本点谁都分不清（连续两版都栽在这）。
await sessions.renameSession(sid, '压缩后会话');
const seeded = await sessions.loadSession(sid);
console.log('[seed] session', sid, 'title', JSON.stringify(seeded.title), 'msgs', seeded.messages.length,
  'summary', String(seeded.summary || '').length, 'chars, summaryAt', seeded.summaryAt);
if (!String(seeded.summary || '').length) throw new Error('预置摘要失败（对照会没有意义）');

// 对照用会话：**同样的两段历史、同一窗口、但完全不带摘要**。
// 为什么不原地清摘要再重启：渲染层启动时已按旧摘要拉过历史，清完重启后它仍复用内存里的
// 那份 messages（实测两次都是 6.3%）。用一个「从一开始就没有摘要」的独立会话做对照，
// 才能在同一个 UI 里干净地对比「有摘要 vs 无摘要」两种口径。
// ⚠️ 首条消息必须**换一个开头**：会话标题会被首条用户消息覆盖（产品行为），
// 两边都用「请分析这个项目。甲甲…」的话，侧栏两条一模一样，脚本点谁都分不清（上一版就栽在这）。
const created2 = await sessions.newSession(TITLE + '（无摘要对照）');
const sid2 = String(created2.id);
await sessions.appendUserMessage(sid2, '请对照这个项目。' + '甲'.repeat(20000));
await sessions.appendAssistantMessage(sid2, '分析结果如下。' + '乙'.repeat(20000), [], {});
await sessions.appendUserMessage(sid2, '继续');
await sessions.renameSession(sid2, '无摘要对照会话');
const seeded2 = await sessions.loadSession(sid2);
console.log('[seed2] control session', sid2, 'title', JSON.stringify(seeded2.title),
  'msgs', seeded2.messages.length, 'summary', String(seeded2.summary || '').length);
if (String(seeded2.summary || '').length) throw new Error('对照会话不该有摘要');

/* ---- ② 起 Electron（隔离 userData + CDP） ---- */
const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
// 必须工厂化：对照阶段要重启同一个配置（摘要清空后必须重启才能按新口径组装）
const spawnElectron = () => spawn(electronExe, [
  path.join(root, 'desktop'),
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userData}`,
  '--no-first-run'
], {
  env: {
    ...env,
    FINALCHECK_UI_SELFCHECK: '1',
    FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: projectsFile,
    FINALCHECK_DEFAULT_PROJECT: projectDir,
    FINALCHECK_SESSIONS_DIR: sessionsDir
  },
  stdio: 'ignore', windowsHide: false
});
const child = spawnElectron();
// 对照阶段重启出来的第二个实例（在 finally 里一并收尸，避免留下僵尸 Electron）
let child2 = null;

let ws = null;
let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r?.result?.value;
};
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  if (!r?.data) throw new Error('screenshot failed');
  const file = path.join(out, name);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('[shot]', file);
  return file;
};

// 打开会话：按**会话标题实际显示的前缀**点侧栏条目。
// 注意：newSession(TITLE) 的标题会被首条用户消息覆盖（产品行为），所以这里按首条消息开头匹配，
// 不能用 TITLE——上一版就是因为按 TITLE 找而 not-found（会话其实已经自动打开在界面上）。
const TITLE_PREFIX = '压缩后会话';
const CONTROL_PREFIX = '无摘要对照会话';
// 点会话行：行是 `<div title="{标题} · {时间}…">`（Sidebar.jsx renderSessionRow），
// 所以最可靠的定位是「title 以会话名开头」。上一版用 textContent 前缀匹配，
// 命中的是包住整棵树的祖先 div（那一行里还有归档按钮，被我的过滤条件排除后选中了祖先），
// 点上去等于点了整个侧栏容器，会话根本没切换（连续几版都栽在这）。
const clickSession = async (title) => {
  const r = await ev(`(() => {
    // ① 首选：title 属性精确命中会话行
    const byTitle = [...document.querySelectorAll('[title]')].find((x) => {
      const tt = (x.getAttribute('title') || '');
      return tt.startsWith(${JSON.stringify(title)} + ' ·') && x.offsetParent !== null;
    });
    if (byTitle) { byTitle.click(); return 'ok:title'; }
    // ② 兜底：文本精确等于标题、且是最内层（自己有文本、子元素不含同一段文字）
    const all = [...document.querySelectorAll('div,li,a,span')].filter((x) => {
      const tx = (x.textContent || '').trim();
      return tx.startsWith(${JSON.stringify(title)}) && x.offsetParent !== null;
    });
    const deepest = all.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    if (!deepest) return 'not-found';
    deepest.click(); return 'ok:deepest';
  })()`);
  await sleep(2400);
  return r;
};
const openSession = () => clickSession(TITLE_PREFIX);
const openSession2 = () => clickSession(CONTROL_PREFIX);
// 开 Context 明细面板并读数。
// ⚠️ 按钮是 toggle（onClick 是 menu==='context' ? null : 'context'），重复点会把已打开的面板关掉——
// 上一版第二轮读出来全空就是这个原因。所以先看面板是否已可见，只有没开才点。
const readPanel = async () => {
  await ev(`(() => {
    const text = document.body.innerText || '';
    const alreadyOpen = text.includes('Context windows') || text.includes('下一轮构成');
    if (alreadyOpen) return 'already-open';
    const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '').includes('上下文使用情况'));
    if (b) { b.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); b.click(); }
    return 'opened';
  })()`);
  await sleep(900);
  return ev(`(() => {
    const text = document.body.innerText || '';
    const ratio = text.match(/([\\d.,]+[KM]?)\\s*\\/\\s*([\\d.,]+[KM]?)/);
    const pct = [...text.matchAll(/(?:实测|估算)\\s*([\\d.]+)%/g)].map((x) => Number(x[1]));
    const messagesLine = text.match(/Messages\\s*([\\d.]+)%/);
    const inWizard = text.includes('首次使用') && text.includes('连接 OpenAI 兼容网关');
    return {
      ratio: ratio ? ratio[0] : '',
      window: ratio ? ratio[2] : '',
      pct: pct.slice(0, 3),
      messagesPct: messagesLine ? Number(messagesLine[1]) : null,
      inWizard,
      panelOpen: text.includes('Context windows') || text.includes('下一轮构成')
    };
  })()`);
};

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail: String(detail ?? '').slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 220)}`);
};

try {
  let page = null;
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools'));
      if (page) break;
    } catch { /* 还没起来 */ }
  }
  if (!page) throw new Error('CDP 25s 内没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
    else p.res(msg.result);
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await sleep(3200);
  await shot('00-startup.png');

  // 前置：必须不在首次向导里（上一版就是起在向导页，全部数字都是空会话）
  const startup = await readPanel();
  record('启动后已进入工作区（不是首次使用向导）', !startup.inWizard, JSON.stringify(startup));

  // ① 打开预置会话（会话可能在启动时已自动打开，点一次是幂等的）
  const opened = await openSession();
  record('能打开预置的会话（侧栏点得到）', String(opened).startsWith('ok') || opened === 'already-open', opened);
  await shot('01-session-opened.png');

  // ② 读压缩后的面板
  const compacted = await readPanel();
  await shot('02-context-after-compact.png');
  console.log('[compacted]', JSON.stringify(compacted));

  record('窗口是配置里的 200K（不是 1.0M 默认值 → 证明 config.json 真被读进来）',
    /200/.test(String(compacted.window)), `window=${compacted.window} ratio=${compacted.ratio}`);
  record('压缩后占用率明显低于「两段 4 万字符历史」应有的量级（< 10%）',
    Number.isFinite(compacted.pct[0]) && compacted.pct[0] < 10,
    `pct=${compacted.pct.join('/')} ratio=${compacted.ratio}`);
  record('Messages 占比接近 0（压缩前那两段已被摘要替代）',
    compacted.messagesPct != null && compacted.messagesPct < 5,
    `messages=${compacted.messagesPct}%`);

  // ③ 反向对照：打开「同样的历史、但没有摘要」的第二个会话。
  // 同一个应用实例、同一个窗口、同一份 wire 内容——唯一差别是压缩口径。
  // （原地清摘要再重启这条路走不通：渲染层启动时已按旧摘要拉过历史，清完仍复用内存里那份）
  const opened2 = await openSession2();
  record('对照：能打开「无摘要」的第二个会话', String(opened2).startsWith('ok') || opened2 === 'already-open', opened2);
  await sleep(1500);
  const control = await readPanel();
  await shot('03-control-no-summary.png');
  console.log('[control]', JSON.stringify(control));

  const compactedPct = Number(compacted.pct[0]);
  const controlPct = Number(control.pct[0]);
  record('反向对照：清掉摘要后占用率明显变大（证明 <15% 确实来自压缩口径）',
    Number.isFinite(compactedPct) && Number.isFinite(controlPct) && controlPct > compactedPct + 3,
    `压缩后=${compactedPct}% vs 无摘要=${controlPct}%`);

  await writeFile(path.join(out, 'result.json'),
    JSON.stringify({ sid, cutAt, results, compacted, control }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 上下文面板自检 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}） ===`);
  console.log('证据:', out);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  try { child2?.kill?.(); } catch { /* 已退 */ }
  await sleep(800);
}
