// 草稿页「仍在后台运行」横幅 UI 自检（真机 Electron + CDP）。
// 前置：由外层脚本以 FINALCHECK_UI_SELFCHECK=1 + --remote-debugging-port=<port> 启动应用，
//       隔离 userData 里预置 provider config 与独立测试项目。
// 流程：① textarea 发一条消息（真跑网关回合）→ ② Working 出现后点 New Session 清屏进草稿
//       → ③ 截图横幅 → ④ 点横幅按钮跳回 → ⑤ 截图恢复态。
// 产出：D:/rcw-geo/.fc-bench2/ui-check/banner.png、restored.png + 控制台 PASS/FAIL 清单。
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.argv[2] || '9223';
const OUT = 'D:/rcw-geo/.fc-bench2/ui-check';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html|localhost/i.test(t.url || ''));
      if (page) return page;
    } catch { /* 应用还没起 */ }
    await sleep(500);
  }
  throw new Error('CDP page target 未找到（应用没起来或端口不对）');
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval 失败: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, 'base64'));
  console.log(`[shot] ${OUT}/${name}`);
};

await send('Runtime.enable');
await send('Page.enable');

// ① 等 UI 就绪（textarea 出现）
let ready = false;
for (let i = 0; i < 40; i++) {
  ready = await evaluate("!!document.querySelector('textarea')").catch(() => false);
  if (ready) break;
  await sleep(500);
}
if (!ready) throw new Error('textarea 未出现（应用没渲染完）');
// 首启卡（若出现）点掉：按文本找跳过/Skip 按钮
await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /跳过|Skip|稍后|以后再说/i.test(b.textContent || ''));
  if (btn) { btn.click(); return 'skipped'; }
  return 'none';
})()`).then((v) => console.log('[firstrun]', v));
await sleep(600);

// ② 发一条需要多步工具调用的消息（回合够长才能在运行态里点 New Session）
await evaluate("document.querySelector('textarea').focus()");
await send('Input.insertText', { text: '请用 run_command 依次执行两条命令：1) dir 2) node -e "console.log(1+1)"。两条都跑完后用一句话总结结果。' });
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

// ③ 快轮询抓运行态（回合短，150ms 间隔；抓到 Working 后停 1.5s 让思考/工具卡可见）
let running = false;
for (let i = 0; i < 800; i++) {
  const s = await evaluate("document.body.innerText.includes('Working')").catch(() => false);
  if (s) { running = true; break; }
  await sleep(150);
}
if (!running) throw new Error('FAIL: 90s 内没抓到 Working 运行态（发送失败/provider 问题）');
await sleep(1500);
console.log('[send] PASS 回合运行态已抓到');

// ④ 点 New Session → 清屏进草稿
const newClicked = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => /New Session|新对话|新建会话/i.test(b.textContent || '') || /New Session|新对话|新建会话/i.test(b.title || ''));
  if (btn) { btn.click(); return true; }
  return false;
})()`);
console.log('[new-session]', newClicked);
await sleep(800);

// ⑤ 断言横幅出现 + 截图
const bannerText = await evaluate("document.body.innerText.includes('仍在后台运行')");
await shot('banner.png');
if (!bannerText) throw new Error('FAIL: 草稿页没有出现「仍在后台运行」横幅');
console.log('[banner] PASS 横幅出现');

// ⑥ 点横幅跳回 → 断言恢复（流式气泡/Working 回来）
const jumped = await evaluate(`(() => {
  const btn = document.querySelector('[data-ui="draft-runner"]');
  if (btn) { btn.click(); return true; }
  return false;
})()`);
console.log('[jump]', jumped);
// 回合还在跑 → 跳回后 Working 应重新出现（流式气泡由 runsRef 恢复）
let restored = false;
for (let i = 0; i < 20; i++) {
  restored = await evaluate("document.body.innerText.includes('Working')").catch(() => false);
  if (restored) break;
  await sleep(300);
}
await shot('restored.png');
if (!jumped) throw new Error('FAIL: 横幅跳回按钮没点中');
if (!restored) throw new Error('FAIL: 跳回后没有恢复运行视图（Working 不在）');
console.log('[restored] PASS 跳回后运行视图恢复');
console.log('UI-SELFCHECK: ALL PASS');
ws.close();
process.exit(0);
