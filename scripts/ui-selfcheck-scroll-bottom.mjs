// 滚动到底 bug 的真机验收（0.33.3）。
//
// 用户报的现象：点「回到底部」箭头，滚到半路就停。
// 已核实根因：消息行带 .cv-auto { content-visibility:auto; contain-intrinsic-size:auto 400px }，
// 视口外的行只按 400px 记账，而真实的 AI 回答有 1500-2500px → scrollHeight 被严重低估
// → scrollTo(scrollHeight) 到的是「假底部」。
//
// 本脚本**不看实现、只量结果**：
//   造 N 条超高消息 → 滚到顶部 → 点按钮（真实 click）→ 等停稳 → 量「离真实底部的距离」。
//   判定标准：|gap| <= 60px（底部 padding 级别）。修复前应该是几千 px。
//
// 用法：node scripts/ui-selfcheck-scroll-bottom.mjs
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'scroll-check');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const PORT = 9351;
const TALL = 12;          // 造几条超高消息（每条目标 1500-2500px）
const GAP_TOLERANCE = 60; // 离底部允许误差（px）——底部 padding 量级

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await rm(projectDir, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'ui-model' }], enabled: true }],
  activeProviderId: 'p-ui', language: 'zh', theme: 'dark', permissionMode: 'ask'
}, null, 2), 'utf8');

// 预置会话：每轮 = user 短问 + assistant 长回答（标题/表格/代码块/列表，撑到 1500-2500px）
const sessionsDir = path.join(projectDir, '.finalcheck', 'sessions');
process.env.FINALCHECK_SESSIONS_DIR = sessionsDir;
const sessionsLib = await import(pathToFileURL(path.join(root, 'desktop/src/main/sessions.mjs')).href);
const s1 = await sessionsLib.newSession('滚动验收探针');

const filler = (i) => {
  const paras = Array.from({ length: 6 }, (_, k) =>
    `第 ${k + 1} 段：这是一段用于把消息撑高的说明文字，讨论第 ${i} 个话题的细节。`.repeat(3)).join('\n\n');
  return [
    `## 第 ${i} 节的标题（用来撑高度）`,
    '',
    paras,
    '',
    '| 项目 | 说明 | 是否可用 |',
    '| --- | --- | --- |',
    '| A | 第一项说明文字，稍微长一点 | 是 |',
    '| B | 第二项说明文字，也长一点 | 否 |',
    '| C | 第三项说明文字 | 是 |',
    '',
    '### 小节',
    '',
    '```js',
    `const x${i} = ${i};`,
    `console.log('probe', x${i});`,
    '```',
    '',
    '- 列表项一，带一点长度让行高不至于太小',
    '- 列表项二',
    '- 列表项三',
    '',
    `**加粗结论**：第 ${i} 段结束。`
  ].join('\n');
};

for (let i = 1; i <= TALL; i++) {
  await sessionsLib.appendUserMessage(s1.id, `第 ${i} 个问题：请解释一下第 ${i} 个话题。`);
  // appendAssistantMessage 收的是**消息对象**（{role, content, ...}），传裸字符串会写进空内容。
  await sessionsLib.appendAssistantMessage(s1.id, { role: 'assistant', content: filler(i) });
}
await sessionsLib.renameSession(s1.id, '滚动验收探针');
const msgCount = (await sessionsLib.loadSession(s1.id)).messages.length;
console.log(`[seed] 会话 ${s1.id}，消息 ${msgCount} 条（${TALL} 轮超高回答）`);

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'],
  {
    env: {
      ...env, FINALCHECK_UI_SELFCHECK: '1',
      FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
      FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
      FINALCHECK_DEFAULT_PROJECT: projectDir,
      FINALCHECK_SESSIONS_DIR: sessionsDir
    },
    stdio: 'ignore', windowsHide: false
  });

let ws = null; let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r?.result?.value;
};
const shot = async (name) => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(out, name);
  await writeFile(file, Buffer.from(r.data, 'base64'));
  return file;
};
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail: String(detail ?? '').slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 300)}`);
};

// 量当前滚动位置与「真实底部」的差距。
// 关键：真实底部要在**挂上 .cv-off** 后量（否则量到的也是被低估的 scrollHeight，会假通过）。
const measure = async () => ev(`(() => {
  const el = document.querySelector('[data-testid="message-scroll"]');
  if (!el) return { err: 'no scroller' };
  const naiveH = el.scrollHeight;               // 布局估计下的高度
  el.classList.add('cv-off');                   // 临时打开真实布局
  void el.offsetHeight;                          // 强制重排
  const realH = el.scrollHeight;                 // 真实高度
  const pos = el.scrollTop;
  const clientH = el.clientHeight;
  el.classList.remove('cv-off');
  return {
    naiveH, realH, pos, clientH,
    gap: realH - pos - clientH,                  // 离真实底部的距离（>0 = 没到底）
    estimatedUnderBy: realH - naiveH             // 估计把总高度低估了多少
  };
})()`);

try {
  let page = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools'));
      if (page) break;
    } catch { /* 等 */ }
  }
  if (!page) throw new Error('CDP 没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); setTimeout(() => rej(new Error('ws timeout')), 15000); });
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (!msg.id || !pending.has(msg.id)) return; const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result); };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3400);

  // 0) 进入会话
  const entered = await ev(`(async () => {
    const rows = await window.finalcheck.sessions.list();
    const list = Array.isArray(rows) ? rows : (rows?.sessions || []);
    const hit = list.find((x) => String(x?.title || '').includes('滚动验收探针'));
    const nodes = [...document.querySelectorAll('div[title]')].filter((x) => x.offsetParent !== null);
    const node = nodes.find((x) => (x.getAttribute('title') || '').includes('滚动验收探针')) || nodes[0];
    if (!node) return { missing: true, n: nodes.length };
    node.click();
    await new Promise((r) => setTimeout(r, 1800));
    return { ok: true, title: hit?.title || null };
  })()`);
  record('S0 进入预置会话', entered?.ok === true, JSON.stringify(entered));

  // 1) 确认消息真的很高（否则这个测试没意义）
  const shape = await ev(`(() => {
    const el = document.querySelector('[data-testid="message-scroll"]');
    const rows = [...el.querySelectorAll('.cv-auto')];
    return { rowCount: rows.length, firstH: rows[0]?.getBoundingClientRect().height || 0 };
  })()`);
  record('S1 会话里有带 .cv-auto 的消息行', (shape?.rowCount || 0) >= 6, JSON.stringify(shape));

  // 2) 先滚到最顶（模拟「往上翻历史」→ 箭头出现）
  const toTop = await ev(`(() => {
    const el = document.querySelector('[data-testid="message-scroll"]');
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { top: el.scrollTop };
  })()`);
  await sleep(600);
  record('S2 能滚到顶部', toTop?.top === 0, JSON.stringify(toTop));

  // 3) 箭头出现了吗
  const arrow = await ev(`(() => {
    const b = document.querySelector('[data-testid="scroll-bottom"]');
    if (!b) return { visible: false };
    const r = b.getBoundingClientRect();
    return { visible: r.width > 0 && r.height > 0, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  record('S3 「回到底部」箭头出现', arrow?.visible === true, JSON.stringify(arrow));

  const beforeShot = await shot('01-before-click.png');

  // 4) 点之前量一次（应为「离底部很远」）
  const before = await measure();
  record('S4 点之前确实离底部很远（证明场景有效）', (before?.gap || 0) > 1000,
    JSON.stringify({ gap: before?.gap, realH: before?.realH, naiveH: before?.naiveH, underestimatedBy: before?.estimatedUnderBy }));

  // 5) 真实点击（走 DOM click，和用户点一样）
  const clicked = await ev(`(() => {
    const b = document.querySelector('[data-testid="scroll-bottom"]');
    if (!b) return { err: 'no arrow' };
    b.click();
    return { ok: true };
  })()`);
  record('S5 能点中箭头', clicked?.ok === true, JSON.stringify(clicked));

  // 6) 等平滑滚动停稳（兜底定时器 1600ms + 余量）
  await sleep(2600);
  const after = await measure();
  const afterShot = await shot('02-after-click.png');

  record('S6 点完之后真的到了底部（|gap| <= ' + GAP_TOLERANCE + 'px）',
    Math.abs(after?.gap || 99999) <= GAP_TOLERANCE,
    JSON.stringify({ gap: after?.gap, realH: after?.realH, pos: after?.pos, clientH: after?.clientH, before: before?.gap }));

  // 7) .cv-off 必须已摘掉（否则长会话永久全量渲染 = 卡）
  const leftover = await ev(`(() => {
    const el = document.querySelector('[data-testid="message-scroll"]');
    const rows = [...el.querySelectorAll('.cv-off')];
    const rowCv = [...el.querySelectorAll('.cv-auto')].slice(0, 1).map((n) => getComputedStyle(n).contentVisibility);
    return { cvOffNodes: rows.length, sampleContentVisibility: rowCv[0] || null };
  })()`);
  record('S7 滚动结束后 .cv-off 已摘掉（不永久全量渲染）',
    (leftover?.cvOffNodes || 0) === 0 && String(leftover?.sampleContentVisibility) === 'auto',
    JSON.stringify(leftover));

  // 8) 再点一次仍然到底（幂等 + 上一轮定时器不会把这一轮搞坏）
  await ev(`(() => { const el = document.querySelector('[data-testid="message-scroll"]'); el.scrollTop = 0; el.dispatchEvent(new Event('scroll', { bubbles: true })); })()`);
  await sleep(500);
  await ev(`document.querySelector('[data-testid="scroll-bottom"]')?.click()`);
  await sleep(2600);
  const again = await measure();
  record('S8 连点第二次仍然到底（幂等）', Math.abs(again?.gap || 99999) <= GAP_TOLERANCE, JSON.stringify({ gap: again?.gap }));

  const finalShot = await shot('03-after-second-click.png');

  await writeFile(path.join(out, 'result.json'), JSON.stringify({
    results, shape, before, after, again, leftover,
    shots: { beforeShot, afterShot, finalShot }
  }, null, 2), 'utf8');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 滚动到底真机验收 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
  console.log(`修复前离底部: ${before?.gap}px  修复后: ${after?.gap}px  真实总高: ${after?.realH}px（估计低估了 ${before?.estimatedUnderBy}px）`);
  console.log('截图:', beforeShot, afterShot, finalShot);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('[FATAL]', e?.stack || e?.message || e);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch { /* 已关 */ }
  try { child.kill(); } catch { /* 已退 */ }
  await sleep(800);
  process.exit(process.exitCode || 0);
}
