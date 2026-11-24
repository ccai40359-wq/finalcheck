// slash 菜单真机自检（0.32.9）：起真 Electron → 打 `/` → 截图 → 用 DOM 断言钉住三处修复。
// 判据全部来自**渲染后的真实 DOM**（不是读源码）：
//   ① 没有描述是孤立的 `>` / `>-`；/fc-browser-use 显示完整句子
//   ② 英文界面命令副标题不含中文（含 /wake → Scheduled wake-up）
//   ③ 分组标题出现且顺序固定；方法论按编号 01..40；自带技能在外部技能之前
// 用法：node scripts/ui-selfcheck-slash-menu.mjs [--lang=en]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.tmp', 'slash-menu-selfcheck');
const userData = path.join(out, 'user-data');
const projectDir = path.join(out, 'project');
const PORT = 9341;
const LANG = process.argv.includes('--lang=en') ? 'en' : 'zh';

mkdirSync(out, { recursive: true });
await rm(userData, { recursive: true, force: true }).catch(() => {});
await mkdir(userData, { recursive: true });
await mkdir(projectDir, { recursive: true });

await writeFile(path.join(userData, 'config.json'), JSON.stringify({
  providers: [{ id: 'p-ui', name: 'Probe', baseUrl: 'http://127.0.0.1:1/v1', apiFormat: 'chat-completions', apiKey: 'k', models: [{ id: 'ui-model' }], enabled: true }],
  activeProviderId: 'p-ui', language: LANG, theme: 'dark', permissionMode: 'ask'
}, null, 2), 'utf8');

const electronExe = (await import(pathToFileURL(path.join(root, 'desktop/node_modules/electron/index.js')).href)).default;
const { ELECTRON_RUN_AS_NODE: _n, ...env } = process.env;
const child = spawn(electronExe, [
  path.join(root, 'desktop'), `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`, '--no-first-run'
], {
  env: {
    ...env, FINALCHECK_UI_SELFCHECK: '1',
    FINALCHECK_CONFIG_FILE: path.join(userData, 'config.json'),
    FINALCHECK_PROJECTS_FILE: path.join(userData, 'projects.json'),
    FINALCHECK_DEFAULT_PROJECT: projectDir
  },
  stdio: 'ignore', windowsHide: false
});

let ws = null; let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
});
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 260)}`);
};

try {
  let page = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools'));
      if (page) break;
    } catch { /* 还没起来 */ }
  }
  if (!page) throw new Error('CDP 30s 内没起来');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res; ws.onerror = () => rej(new Error('ws error'));
    setTimeout(() => rej(new Error('ws timeout')), 15000);
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3200);

  // 在输入框里打一个 `/` 打开菜单（走真实 DOM 事件，不是直接调 React state）
  const opened = await ev(`(async () => {
    const ta = document.querySelector('textarea');
    if (!ta) return { err: 'no textarea' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '/');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    return { ok: true };
  })()`);
  record('M0 菜单能打开', opened?.ok === true, JSON.stringify(opened));

  // 抓菜单项：每行 = { group, name, desc, badge }
  const rows = await ev(`(() => {
    const pop = document.querySelector('.glass-pop');
    if (!pop) return { err: 'no pop' };
    const heads = [], items = [];
    let lastHead = '';
    for (const child of pop.querySelectorAll('div, button')) {
      if (child.tagName === 'DIV' && /uppercase/.test(child.className || '') && child.textContent.trim()) {
        lastHead = child.textContent.trim(); heads.push(lastHead);
      }
    }
    for (const btn of pop.querySelectorAll('button')) {
      // 按**内容特征**取，不按索引：0.32.9 的圆点样式让每行多了一个空 span，
      // 写死 spans[1] 会把圆点/名称当描述（合并时踩到过，4 项假失败）。
      const spans = [...btn.querySelectorAll('span')].map((s) => s.textContent.trim()).filter(Boolean);
      const slashAt = spans.findIndex((t) => t.startsWith('/'));
      const name = slashAt >= 0 ? spans[slashAt].slice(1) : '';
      const rest = spans.filter((_, i) => i !== slashAt);
      const badgeText = rest.find((t) => /^(命令|技能|Command|Skill)$/.test(t)) || '';
      const desc = rest.filter((t) => t !== badgeText).sort((a, b) => b.length - a.length)[0] || '';
      items.push({ head: '', name, desc, badge: badgeText });
    }
    return { heads, items, text: pop.innerText.slice(0, 4000) };
  })()`);

  const items = rows?.items || [];
  record('M1 菜单有内容', items.length > 10, `items=${items.length} heads=${JSON.stringify(rows?.heads)}`);

  // ① 没有孤立 `>` 描述
  const badDesc = items.filter((x) => /^[>|][-+]?$/.test(String(x.desc).trim())).map((x) => x.name);
  record('M2 没有「描述只剩 >」的条目', badDesc.length === 0, JSON.stringify(badDesc));

  // ① 的正面证据：/fc-browser-use 显示完整句子
  const bu = items.find((x) => x.name === 'fc-browser-use');
  record('M3 /fc-browser-use 显示完整描述', !!bu && String(bu.desc).length > 40,
    bu ? JSON.stringify(String(bu.desc).slice(0, 120)) : 'not found');

  // ② 语言：英文界面副标题不含中文
  const cmdRows = items.slice(0, 3);
  if (LANG === 'en') {
    const leaks = cmdRows.filter((x) => /[\u3400-\u9fff]/.test(String(x.desc))).map((x) => `${x.name}:${x.desc}`);
    record('M4 英文界面命令副标题无中文', leaks.length === 0, JSON.stringify(leaks));
    const wake = cmdRows.find((x) => x.name === 'wake');
    record('M5 /wake 显示 Scheduled wake-up', !!wake && /Scheduled wake-up/i.test(wake.desc), wake ? wake.desc : 'not found');
  } else {
    const wake = cmdRows.find((x) => x.name === 'wake');
    record('M4 中文界面 /wake 显示「定时唤醒」', !!wake && /定时唤醒/.test(wake.desc), wake ? wake.desc : 'not found');
  }

  // ③ 分组标题与顺序
  const heads = rows?.heads || [];
  const expected = LANG === 'en'
    ? ['Command', 'Methodology', 'Built-in skills', 'External skills']
    : ['命令', '方法论', '自带技能', '外部技能'];
  record('M6 分组标题按固定顺序出现', expected.every((h, i) => heads[i] === h), JSON.stringify(heads));

  // ③ 方法论按编号 01..40 连续升序（取前 5 个名字对应的顺序）
  // 名字从每行的 `/xxx` span 取（不按固定 span 索引，圆点会移位）
  const ordered = await ev(`(() => {
    const pop = document.querySelector('.glass-pop');
    return [...pop.querySelectorAll('button')].slice(3, 43).map((b) => {
      const t = [...b.querySelectorAll('span')].map((s) => s.textContent.trim()).find((x) => x.startsWith('/'));
      return t || '';
    });
  })()`);
  record('M7 方法论前 5 条是 01-05 顺序', Array.isArray(ordered) && ordered.slice(0, 5).join(',') === '/port-service-scan,/tech-fingerprint,/dir-brute,/js-api-recon,/sql-injection',
    JSON.stringify(ordered?.slice(0, 6)));

  // ③ 自带技能出现在外部技能之前（browser-use 行必须在 fc-browser-use 行之前）
  const ownIdx = items.findIndex((x) => x.name === 'browser-use');
  const extIdx = items.findIndex((x) => x.name === 'fc-browser-use');
  record('M8 自带技能排在外部同名副本之前', ownIdx >= 0 && (extIdx === -1 || ownIdx < extIdx),
    JSON.stringify({ ownIdx, extIdx }));

  const fileZh = await shot(`slash-${LANG}.png`);
  console.log('截图:', fileZh);

  await writeFile(path.join(out, `result-${LANG}.json`), JSON.stringify({ results, heads, items: items.slice(0, 20), lang: LANG }, null, 2), 'utf8');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== slash 菜单真机自检（${LANG}）${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${results.length - failed.length}/${results.length}）===`);
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
