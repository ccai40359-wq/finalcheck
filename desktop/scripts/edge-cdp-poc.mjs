// 0.31.0 阶段 0 PoC（可重复执行）：验证 playwright-core 能否连接「非 Playwright 启动的隔离 Edge」。
// 四项验证：① connectOverCDP 连上 ② evaluate ③ 新页截图 ④ 断开后 Edge 仍存活。
//
// 纪律（与任务书一致）：
//   - 端口 9224（datacrawler 占 9223，互不干扰）
//   - 独立 profile（默认放系统临时目录，绝不碰用户日常 Edge 与 datacrawler 的 edge-profile）
//   - 只引 playwright-core，不引 playwright 完整包
//
// 用法：node scripts/edge-cdp-poc.mjs [--port 9224] [--out D:/fc-bench-0291/edge-poc]
//       [--keep-edge]  // 结束时保留 Edge（默认也保留——人工启动的浏览器不该被杀）

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(opt('--port', 9224));
const OUT = resolve(opt('--out', 'D:/fc-bench-0291/edge-poc'));
const PROFILE = resolve(opt('--profile', resolve(tmpdir(), 'fc-edge-poc-9224')));
if (PORT === 9223) {
  console.error('拒绝使用 9223：那是 datacrawler 的端口。');
  process.exit(2);
}

function edgeCandidates() {
  const roots = [];
  const pf = process.env['ProgramFiles(x86)'];
  const pf2 = process.env.ProgramFiles;
  if (pf) roots.push(pf);
  if (pf2) roots.push(pf2);
  roots.push('C:/Program Files (x86)', 'C:/Program Files');
  const out = [];
  for (const r of roots) out.push(resolve(r, 'Microsoft/Edge/Application/msedge.exe'));
  return out;
}

function resolveEdgePath() {
  for (const p of edgeCandidates()) if (existsSync(p)) return p;
  const fromPath = process.env.PATH ? String(process.env.PATH).split(';') : [];
  for (const dir of fromPath) {
    if (!dir) continue;
    try { const c = resolve(dir, 'msedge.exe'); if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  throw new Error('msedge.exe not found');
}

// 本机 loopback 偶发丢包（实测 1.01s 抖动）：探 3 次，任一次 200 且有 body 就算在。
async function isCdpUp(port, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return false;
      const body = await res.text();
      return typeof body === 'string' && body.length > 0;
    } catch {
      if (attempt < attempts - 1) await sleep(500 * (attempt + 1));
    }
  }
  return false;
}

async function startIsolatedEdge() {
  if (await isCdpUp(PORT)) return { started: false, profile: PROFILE };
  mkdirSync(PROFILE, { recursive: true });
  const exe = resolveEdgePath();
  const argv = [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--no-service-autorun',
    '--use-mock-keychain',
    '--disable-component-update',
    '--disable-features=msEdgeNotifications,msImplicitSignin,EdgeSyncPromo,msEdgeIdentityFeatureOptimization',
    'about:blank'
  ];
  spawn(exe, argv, { stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if (await isCdpUp(PORT, 1)) return { started: true, profile: PROFILE, exe };
  }
  throw new Error('CDP 30s 内未就绪：' + PORT);
}

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail: String(detail ?? '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 200)}`);
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const started = await startIsolatedEdge();
  record('0.启动隔离 Edge（非 Playwright 启动）', true, `port=${PORT} profile=${started.profile} spawned=${started.started}`);

  // ① connectOverCDP
  let browser = null;
  let connectMs = 0;
  try {
    const t0 = Date.now();
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT, {
      headers: { 'User-Agent': 'finalcheck' }
    });
    connectMs = Date.now() - t0;
    record('1.connectOverCDP 连上', true, `${connectMs}ms contexts=${browser.contexts().length}`);
  } catch (e) {
    record('1.connectOverCDP 连上', false, e.message);
    return finish();
  }

  const ctx = browser.contexts()[0] || await browser.newContext();

  // ② evaluate
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    const v = await page.evaluate(() => 1 + 1);
    record('2.evaluate("1+1")', v === 2, `value=${JSON.stringify(v)}`);
  } catch (e) {
    record('2.evaluate("1+1")', false, e.message);
  }

  // ③ 新页导航 + 截图
  let shotPath = '';
  try {
    const page = await ctx.newPage();
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    shotPath = resolve(OUT, 'poc-screenshot.png');
    await page.screenshot({ path: shotPath, fullPage: false });
    const title = await page.title();
    record('3.新页导航 + 截图', existsSync(shotPath), `${shotPath} title=${title}`);
    await page.close().catch(() => {});
  } catch (e) {
    record('3.新页导航 + 截图', false, e.message);
  }

  // ④ 断开后 Edge 仍存活（人工启动的浏览器不应被 CDP 断开杀掉）
  const beforePages = ctx.pages().length;
  await browser.close().catch(() => {});
  browser = null;
  await sleep(1200);
  const stillUp = await isCdpUp(PORT);
  const stillServing = stillUp ? await fetch('http://127.0.0.1:' + PORT + '/json/list', { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json()).then((l) => Array.isArray(l) && l.length > 0).catch(() => false) : false;
  record('4.断开后 Edge 仍存活', stillUp && stillServing, `cdpUp=${stillUp} pagesBeforeClose=${beforePages} targetsAlive=${stillServing}`);

  finish();
}

function finish() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  mkdirSync(OUT, { recursive: true });
  const summaryPath = resolve(OUT, 'poc-result.json');
  writeFileSync(summaryPath, JSON.stringify({ port: PORT, profile: PROFILE, results, passed, total: results.length, at: new Date().toISOString() }, null, 2));
  console.log(`\n=== PoC ${failed.length === 0 ? '全过' : failed.length + ' 项失败'} (${passed}/${results.length}) ===`);
  console.log('证据: ' + OUT);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  record('异常', false, e.message);
  finish();
});
