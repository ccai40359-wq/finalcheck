// 0.32.7 内置浏览器加固验收（真 Electron，不调模型）。
//
// 验四件事，每件都看页面里真实发生了什么，不看函数返回值：
//   P  权限：网页申请摄像头/通知/定位/权限查询 → 必须被拒绝
//   T  真实输入：点击和输入到达页面时 isTrusted=true；只听 pointerdown 的组件能收到；
//      「自己维护内容模型」的富文本编辑器（模仿 ProseMirror/Lexical：拦 beforeinput 自己改模型）真的收到文字
//   D  深度结构：开放 Shadow DOM 里的按钮、同源 iframe 里的按钮出现在快照里并且能点中；跨域 iframe 单列提示
//   S  会话隔离：对话 A 写的 cookie，对话 B 看不到
// 右栏宽 590 → 页面缩放 0.5，顺带验证缩放下坐标点得准。
//
// 用法：node scripts/browser-use-0327-acceptance.mjs        退出码 0 = 全过
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.versions.electron) {
  const electron = (await import('../desktop/node_modules/electron/index.js')).default;
  const { ELECTRON_RUN_AS_NODE: _nodeMode, ...env } = process.env;
  const boot = path.join(ROOT, '.tmp', 'browser-use-0327', 'bootstrap');
  await mkdir(boot, { recursive: true });
  await writeFile(path.join(boot, 'package.json'), '{"main":"main.cjs"}');
  await writeFile(path.join(boot, 'main.cjs'), `
    void import(${JSON.stringify(import.meta.url)}).catch((error) => {
      console.error(error); require('electron').app.exit(1);
    });
  `);
  const r = spawnSync(electron, [boot, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true, timeout: 180000, env });
  process.exit(typeof r.status === 'number' ? r.status : 1);
}

const { app, BrowserWindow } = await import('electron');
await app.whenReady();

/* ---------------- 两个源：A 是被测页面，B 用来当跨域 iframe ---------------- */
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
let originB = '';
const siteA = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/inner') {
    return html(res, `<!doctype html><body style="margin:0">
      <button id="fb" onclick="parent.__log.frame.push(event.isTrusted)" style="width:200px;height:40px">Frame Go</button></body>`);
  }
  if (u.pathname === '/perm') {
    return html(res, `<!doctype html><title>perm</title><body><p>perm</p><script>
      window.__perm = {};
      Notification.requestPermission().then((r) => { __perm.notif = r; });
      navigator.permissions.query({ name: 'camera' }).then((r) => { __perm.camQuery = r.state; }, (e) => { __perm.camQuery = 'error:' + e.name; });
      navigator.mediaDevices.getUserMedia({ video: true }).then(() => { __perm.cam = 'granted'; }, (e) => { __perm.cam = e.name; });
      navigator.geolocation.getCurrentPosition(() => { __perm.geo = "granted"; }, (e) => { __perm.geo = e.code === 1 ? "denied" : "error:" + e.code + ":" + e.message; }, { timeout: 3000 });
    </script></body>`);
  }
  if (u.pathname === '/cookie') return html(res, '<!doctype html><title>cookie</title><body>cookie</body>');
  // 主测试页
  return html(res, `<!doctype html><title>trusted</title>
  <body style="margin:0;padding:20px;font:16px sans-serif;width:1100px">
    <script>window.__log = { click: [], pointer: [], input: [], editor: [], shadow: [], frame: [] }; window.__model = '';</script>
    <div style="height:900px;background:#eef">占位：把下面的控件推到首屏之外，验证先滚动再点</div>
    <button id="b1" onclick="__log.click.push(event.isTrusted)">Plain Button</button>
    <div id="pd" role="button" aria-label="Pointer Only" style="display:inline-block;width:160px;height:40px;background:#cfc"></div>
    <script>document.getElementById('pd').addEventListener('pointerdown', (e) => __log.pointer.push(e.isTrusted));</script>
    <p><label>Name <input id="i1" placeholder="your name"></label></p>
    <script>document.getElementById('i1').addEventListener('input', (e) => __log.input.push(e.isTrusted));</script>
    <div id="ed" contenteditable="true" role="textbox" aria-label="Rich Editor" style="min-height:40px;border:1px solid #999"></div>
    <script>
      // 模仿 ProseMirror / Lexical：拦住 beforeinput，自己维护内容模型，再按模型重画 DOM
      const ed = document.getElementById('ed');
      ed.addEventListener('beforeinput', (e) => {
        e.preventDefault();
        __log.editor.push(e.isTrusted);
        if (e.inputType.startsWith('insert')) __model += e.data || '';
        else if (e.inputType.startsWith('delete')) __model = '';
        ed.textContent = __model;
      });
    </script>
    <x-card></x-card>
    <script>
      customElements.define('x-card', class extends HTMLElement {
        constructor() {
          super();
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<button style="width:200px;height:40px">Shadow Go</button>';
          root.querySelector('button').addEventListener('click', (e) => __log.shadow.push(e.isTrusted));
        }
      });
    </script>
    <p><iframe id="same" src="/inner" style="width:260px;height:60px;border:2px solid #333;padding:6px"></iframe></p>
    <p><iframe id="cross" src="${originB}/x" style="width:260px;height:60px"></iframe></p>
  </body>`);
});
const siteB = createServer((req, res) => html(res, '<!doctype html><body><button>Cross Go</button></body>'));
const portA = await listen(siteA);
originB = `http://127.0.0.1:${await listen(siteB)}`;
const originA = `http://127.0.0.1:${portA}`;

/* ---------------- 产品代码：右栏内嵌宿主 + browser-use ---------------- */
const host = await import(pathToFileURL(path.join(ROOT, 'desktop/src/main/browser-view-host.mjs')).href);
const bu = await import(pathToFileURL(path.join(ROOT, 'desktop/src/main/browser-use.mjs')).href);
const win = new BrowserWindow({ show: false, width: 1280, height: 860 });
host.ensureHost(win, () => {});
bu.setViewHostProvider((sid) => host.hostForSession(sid));
const policy = { mode: 'oneshot', chosen: true, persistent: false, partition: 'fc-browser-use' };
for (const sid of ['A', 'B']) {
  const h = host.hostForSession(sid);
  h.setRect({ x: 0, y: 0, width: 590, height: 800 }); // 590 宽 → 缩放 0.5
  h.setVisible(true);
}

const results = [];
const record = (id, name, ok, detail) => {
  results.push({ id, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${name}  ${String(detail ?? '').slice(0, 260)}`);
};
const refOf = (tree, label) => {
  const line = String(tree || '').split('\n').find((l) => l.includes(label) && l.includes('[ref='));
  return line ? /\[ref=([^\]]+)\]/.exec(line)[1] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const A = bu.forSession('A');

  /* ---- P 权限 ---- */
  // SKIP_PERM=1 只给「改动前的旧代码」对照用：旧代码会真的打开摄像头，后面的步骤会被拖住
  if (process.env.SKIP_PERM !== '1') {
    await A.navigate(originA + '/perm', { policy });
    await sleep(4000);
    const perm = JSON.parse((await A.evaluate('window.__perm')).result || '{}');
    record('P1', '通知权限被拒绝', perm.notif === 'denied', JSON.stringify(perm));
    record('P2', '权限查询（摄像头）回答 denied', perm.camQuery === 'denied', perm.camQuery);
    record('P3', '摄像头请求被拒绝（NotAllowedError）', perm.cam === 'NotAllowedError', perm.cam);
    // 定位不计入结果：这个 Electron 环境里定位接口改动前后都不回调（没有定位服务），判断不了拒绝是否生效
    console.log(`INFO  [P4] 定位回调：${perm.geo ?? '（4 秒内无回调，不计入）'}`);
  }

  /* ---- T / D 真实输入 + 深度结构 ---- */
  const nav = await A.navigate(originA + '/t', { policy });
  record('T0', '页面打开在右栏内嵌宿主里', nav.ok && nav.embedded === true, JSON.stringify({ ok: nav.ok, embedded: nav.embedded }));
  const snap = await A.snapshot({ maxNodes: 400 });
  const tree = snap.tree || '';

  const clickBy = async (label) => {
    const ref = refOf(tree, label);
    if (!ref) return { ok: false, error: `快照里没有「${label}」` };
    return A.click(ref);
  };
  const log = async () => JSON.parse((await A.evaluate('window.__log')).result || '{}');

  const c1 = await clickBy('Plain Button');
  await sleep(100);
  let L = await log();
  record('T1', '普通按钮：点击到达页面且 isTrusted=true（缩放 0.5 + 先滚动）', c1.ok && L.click.length === 1 && L.click[0] === true, JSON.stringify({ result: c1, seen: L.click }));

  const c2 = await clickBy('Pointer Only');
  await sleep(100);
  L = await log();
  record('T2', '只监听 pointerdown 的组件收到了点击', c2.ok && L.pointer.length >= 1 && L.pointer.every(Boolean), JSON.stringify({ result: c2, seen: L.pointer }));

  const tIn = await A.typeInto(refOf(tree, 'Name'), '张三 Zhang');
  const inVal = JSON.parse((await A.evaluate('document.getElementById("i1").value')).result);
  L = await log();
  record('T3', '输入框：值正确且 input 事件 isTrusted=true', tIn.ok && inVal === '张三 Zhang' && L.input.length > 0 && L.input.every(Boolean), JSON.stringify({ result: tIn, value: inVal, seen: L.input }));

  const tEd = await A.typeInto(refOf(tree, 'Rich Editor'), '富文本 hello');
  const model = JSON.parse((await A.evaluate('window.__model')).result);
  L = await log();
  record('T4', '富文本编辑器（自己维护内容模型）真的收到了文字', tEd.ok && model === '富文本 hello' && L.editor.every(Boolean), JSON.stringify({ result: tEd, model, seen: L.editor }));

  record('D1', '开放 Shadow DOM 里的按钮出现在快照里', Boolean(refOf(tree, 'Shadow Go')), '');
  const c3 = await clickBy('Shadow Go');
  await sleep(100);
  L = await log();
  record('D2', 'Shadow DOM 按钮能点中（isTrusted=true）', c3.ok && L.shadow.length === 1 && L.shadow[0] === true, JSON.stringify({ result: c3, seen: L.shadow }));

  record('D3', '同源 iframe 里的按钮出现在快照里', Boolean(refOf(tree, 'Frame Go')), '');
  const c4 = await clickBy('Frame Go');
  await sleep(100);
  L = await log();
  record('D4', '同源 iframe 按钮能点中（带边框/内边距，坐标换算正确）', c4.ok && L.frame.length === 1 && L.frame[0] === true, JSON.stringify({ result: c4, seen: L.frame }));

  const crossLine = tree.split('\n').find((l) => l.includes(originB));
  record('D5', '跨域 iframe 在快照里单列一行并说明看不到', Boolean(crossLine && crossLine.includes('跨域')), crossLine || '(无)');

  /* ---- F 兜底路径：没有右栏宿主（旧的离屏隐藏窗口，拿不到 CDP 通道） ----
     页面不可见 + 控件在首屏之外要先滚动：以前这里会卡死在 requestAnimationFrame 上 */
  bu.setViewHostProvider(null);
  const C = bu.forSession('C');
  await C.navigate(originA + '/t', { policy });
  const treeC = (await C.snapshot({ maxNodes: 400 })).tree || '';
  const started = Date.now();
  const fc = await Promise.race([
    C.click(refOf(treeC, 'Plain Button')),
    sleep(15000).then(() => ({ ok: false, error: '15 秒没有返回（卡死）' }))
  ]);
  const logC = JSON.parse((await C.evaluate('window.__log')).result || '{}');
  record('F1', '兜底路径：页面不可见时点击不卡死、能点到，并如实标 trusted:false',
    fc.ok && fc.trusted === false && logC.click?.length === 1,
    JSON.stringify({ result: fc, seen: logC.click, ms: Date.now() - started }));
  C.close();
  bu.setViewHostProvider((sid) => host.hostForSession(sid));

  /* ---- S 会话隔离 ---- */
  await A.navigate(originA + '/cookie', { policy });
  await A.evaluate('document.cookie = "fc_probe=from-A; path=/"');
  const B = bu.forSession('B');
  await B.navigate(originA + '/cookie', { policy });
  const seenB = JSON.parse((await B.evaluate('document.cookie')).result || '""');
  const seenA = JSON.parse((await A.evaluate('document.cookie')).result || '""');
  record('S1', '对话 A 自己能看到它写的 cookie', seenA.includes('fc_probe=from-A'), seenA);
  record('S2', '对话 B 看不到对话 A 的 cookie（无痕按会话隔离）', !seenB.includes('fc_probe'), JSON.stringify(seenB));
} catch (error) {
  record('X', '脚本跑完不抛错', false, error?.stack || error);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 内置浏览器加固验收 ${failed.length ? failed.length + ' 项失败' : '全过'}（${results.length - failed.length}/${results.length}） ===`);
try { bu.closeAll?.(); host.disposeHost?.(); win.destroy(); } catch { /* 已关 */ }
siteA.close();
app.exit(failed.length ? 1 : 0);
