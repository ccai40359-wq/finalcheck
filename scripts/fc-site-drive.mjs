// FC 网站构建驱动：通过 CDP 驱动真机 FC（隔离实例）给 dev 轨 agent 下需求并等回合结束。
// 用法:
//   node scripts/fc-site-drive.mjs state [--port 9487]
//   node scripts/fc-site-drive.mjs send --port 9487 --text "<提示词>" [--text-file <path>] [--timeout-min 45]
// 输出：state/send 结果 JSON 到 stdout；回合结束后打印正文尾部（最后 2500 字）。
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const cmd = args[0] || 'state';
const get = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const PORT = get('port') || '9487';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html|localhost/i.test(t.url || ''));
      if (page) return page;
    } catch { /* 还没起 */ }
    await sleep(1000);
  }
  throw new Error('CDP page 未找到');
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error).slice(0, 300))) : res(msg.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails?.exception?.description || '').slice(0, 300));
  return r.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

// 运行态唯一真信号：Composer 在 busy/stopping 时把发送键换成停止键（title 双语）。
// 别用 body 文本找 Working/思考 chip——回合结束后这些 chip 仍留在 transcript 里。
const BUSY_EXPR =
  "!!document.querySelector('button[title=\"停止本回合\"],button[title=\"Stop this turn\"],button[title=\"正在中断，请稍候\"],button[title=\"Interrupting, please wait\"]')";
const tail = () => ev(`(() => { const t = document.body.innerText || ''; return t.slice(-2500); })()`);

if (cmd === 'state') {
  const out = { busy: await ev(BUSY_EXPR), textarea: await ev("!!document.querySelector('textarea')"), tail: await tail() };
  console.log(JSON.stringify(out, null, 1));
  ws.close();
  process.exit(0);
}

if (cmd === 'send') {
  const textFile = get('text-file');
  const text = textFile ? readFileSync(textFile, 'utf8') : (get('text') || '');
  if (!text.trim()) throw new Error('空消息');
  const force = args.includes('--force'); // --force：不等当前回合，直接排队（Composer 的队列机制会接住）
  if (!force) {
    // 等当前回合结束（若有）：连续 3 次 × 2s 不忙才动手，防止把排队/打断打成两截
  }
  const waitDeadline = Date.now() + Number(get('wait-min') || 45) * 60000;
  let quietW = 0;
  if (force) quietW = 3;
  else {
    while (Date.now() < waitDeadline) {
      quietW = (await ev(BUSY_EXPR).catch(() => false)) ? 0 : quietW + 1;
      if (quietW >= 3) break;
      await sleep(2000);
    }
    if (quietW < 3) throw new Error('等待上一回合结束超时');
  }
  await ev("document.querySelector('textarea').focus()");
  await send('Input.insertText', { text });
  await sleep(300);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  // 等运行态出现（≤90s）
  let started = false;
  for (let i = 0; i < 90; i++) { if (await ev(BUSY_EXPR).catch(() => false)) { started = true; break; } await sleep(1000); }
  if (!started) throw new Error('发送后 90s 没进入运行态（provider/路由问题）');
  console.log('[started]');
  // 等运行态消失（连续 3 次 × 2s 不在运行才算完）
  const timeoutMin = Number(get('timeout-min') || 45);
  const deadline = Date.now() + timeoutMin * 60000;
  let quiet = 0;
  while (Date.now() < deadline) {
    const w = await ev(BUSY_EXPR).catch(() => false);
    quiet = w ? 0 : quiet + 1;
    if (quiet >= 3) { console.log('[done] 回合结束'); console.log('---TAIL---'); console.log(await tail()); ws.close(); process.exit(0); }
    await sleep(2000);
  }
  console.log('[timeout] 超时，回合可能仍在跑'); console.log('---TAIL---'); console.log(await tail());
  ws.close();
  process.exit(1);
}
throw new Error('未知命令: ' + cmd);
