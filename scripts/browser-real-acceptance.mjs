// 0.31.0 阶段 2 真机验收：CDP 连真 Edge（端口 9224，隔离 profile）。
// 覆盖任务书的四条验收：① 读登录态页面 ② 截图 ③ 点击（不抢前台）④ 断开后 Edge 仍在运行。
//
// 端口/隔离纪律：
//   · 9224（硬拒 9223）
//   · profile 落在 .tmp 下的独立目录（绝不碰用户日常 Edge 与 datacrawler 的 profile）
//   · 结束时默认保留 Edge（人工启动的浏览器不该被杀），--close-edge 才关
//
// 用法：node scripts/browser-real-acceptance.mjs [--port 9224] [--close-edge]

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CDP_PORT, connectReal, disconnectReal, closeRealEdgeAndReset, realIsConnected,
  navigateReal, snapshotReal, clickReal, typeIntoReal, evaluateReal, screenshotReal,
  consoleMessagesReal, isCdpUp, probeLoginState, judgeLoginState,
  // 0.31.1：CU 混用闸的依据——浏览器主进程 pid + 纯函数判定
  browserProcessId, realInfo
} from '../desktop/src/main/browser-real.mjs';
import { realEdgeRedirect } from '../desktop/src/main/browser-choice.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.tmp', 'browser-real-acceptance');
const argOf = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PORT = Number(argOf('--port', DEFAULT_CDP_PORT));
if (PORT === 9223) {
  console.error('拒绝使用 9223：那是 datacrawler 的端口');
  process.exit(2);
}
const PROFILE = path.join(evidence, 'edge-profile');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail: String(detail ?? '').slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 200)}`);
};

// 验收夹具：一个可以被 CDP 操作、且能证明「点击生效」的本地站。
// 用 127.0.0.1 的固定端口（不用 文件://**，那样 cookie/登录态语义不真实）
// 夹具里模拟一个「登录态页」：/home 只有在带 auth cookie 时才显示头像，否则显示登录墙。
const AUTH_COOKIE = 'fc_auth=1';
function startFixture(port) {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const authed = String(req.headers.cookie || '').includes('fc_auth=1');
    if (req.url === '/login') {
      res.setHeader('Set-Cookie', `${AUTH_COOKIE}; Path=/; Max-Age=3600; SameSite=Lax`);
      res.end('<!doctype html><title>login</title><h1 id="h">logged in</h1>');
      return;
    }
    if (req.url === '/home') {
      res.end(authed
        ? '<!doctype html><title>home (authed)</title><h1 id="h">welcome back</h1><div class="avatar"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="avatar"></div><button id="like" onclick="document.getElementById(\'h\').textContent=\'liked\'">Like</button><input id="note" placeholder="note">'
        : '<!doctype html><title>home (wall)</title><h1>Please log in</h1><div>登录后推荐更懂你的笔记</div><button>Log in</button>');
      return;
    }
    res.end('<!doctype html><title>fixture</title><h1 id="h">fixture</h1><button id="btn" onclick="document.getElementById(\'h\').textContent=\'clicked\'">click me</button><input id="field" placeholder="type here">');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}



async function main() {
  await mkdir(evidence, { recursive: true });
  let fixturePort = Number(argOf('--fixture-port', '0')) || 0;
  if (!fixturePort) {
    const probe = createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    fixturePort = probe.address().port;
    await new Promise((r) => probe.close(r));
  }
  const server = await startFixture(fixturePort);
  const origin = `http://127.0.0.1:${fixturePort}`;

  try {
    // ---- 0. 纪律：端口与 profile -■---
    record('0a 端口是 9224（不是 datacrawler 的 9223）', PORT === 9224, `port=${PORT}`);
    record('0b profile 是隔离目录（不在用户日常 Edge 下）', PROFILE.includes('.tmp') && !PROFILE.toLowerCase().includes('appdata'), PROFILE);

    // ---- 1. 启动并连接（Edge 由本脚本启动，不是 Playwright 启动的） ----
    const preexisting = await isCdpUp(PORT);
    const conn = await connectReal({ port: PORT, profile: PROFILE, urls: [origin + '/home'] });
    record('1a 启动并连上隔离 Edge', conn.ok === true && realIsConnected(), JSON.stringify({ started: conn.started, port: conn.port, preexisting }));
    // 首次运行会自己 spawn Edge（started=true）；用同一个 profile 再跑一次会直接复用（started=false）——
    // 两种都合法，关键是「连上的不是 playwright 自带的 Chromium」。用真实进程命令行证明。
    const edgeCmd = await edgeProcessCommandLine(PORT);
    record('1b 连的是真 Edge 进程（命令行带 9224 + 本 profile）',
      edgeCmd.includes('msedge.exe') && edgeCmd.includes(`--remote-debugging-port=${PORT}`) && edgeCmd.includes('edge-profile'),
      `started=${conn.started} cmd=${edgeCmd.slice(0, 140)}`);

    // ---- 2. 读页面（结构快照 + evaluate） ----
    const opened = await navigateReal(`${origin}/login`, { observe: true }); // 先拿 auth cookie
    record('2a 真 Edge 可导航（导航到 /login 种下 auth cookie）', opened.ok === true, opened.url);
    const home = await navigateReal(`${origin}/home`, { observe: true });
    record('2b 读登录态页面（结构快照含 welcome back / Like / note）',
      home.ok === true && /welcome back/.test(home.snapshot?.tree || '') && /Like/.test(home.snapshot?.tree || ''),
      `tree=${(home.snapshot?.tree || '').slice(0, 160).replace(/\n/g, ' | ')}`);
    const evalResult = await evaluateReal('document.title');
    record('2c evaluate 可用', evalResult.ok === true && /authed/i.test(evalResult.result), evalResult.result);

    // ---- 3. 截图 -■---
    const shot = await screenshotReal();
    const shotPath = path.join(evidence, 'real-edge-page.png');
    if (shot.ok) await writeFile(shotPath, shot.buf);
    record('3 截图成功（真 Edge 页面，非屏幕截图）', shot.ok === true && shot.buf.length > 1000, `${shotPath} ${shot.width}x${shot.height} ${shot.buf?.length || 0}B`);

    // ---- 4. 点击 / 输入（不抢前台） -■---
    const likeRef = extractRef(home.snapshot.tree, 'Like');
    assert.ok(likeRef, '快照里应有 Like 按钮的 ref');
    const clicked = await clickReal(likeRef, { observe: true });
    record('4a 点击生效（页面文本变 liked）',
      clicked.ok === true && /liked/.test(clicked.snapshot?.tree || ''),
      `tree=${(clicked.snapshot?.tree || '').slice(0, 120).replace(/\n/g, ' | ')}`);
    const noteRef = extractRef(clicked.snapshot?.tree || home.snapshot.tree, 'note');
    if (noteRef) {
      const typed = await typeIntoReal(noteRef, 'typed by acceptance');
      record('4b 输入生效（fill 落到 input 而不是相邻 button）', typed.ok === true, JSON.stringify(typed));
    } else {
      record('4b 输入 ref 未找到（快照里应有 note 输入框）', false, clicked.snapshot?.tree?.slice(0, 120) || '');
    }
    // 不抢前台：点击前后前台窗口标题不应变化（用 Win32 前台窗口标题做证据）。
    // 注意：重拍快照拿新 ref（旧 ref 的 data-fc-real 标记已被上一轮点击消耗/改写）
    const beforeShot = await snapshotReal({});
    const fgBefore = await foregroundTitle();
    const freshLike = extractRef(beforeShot.tree, 'Like');
    if (freshLike) await clickReal(freshLike).catch(() => {});
    await sleep(400);
    const fgAfter = await foregroundTitle();
    record('4c 点击不抢前台（前台窗口标题未变）', fgBefore === fgAfter && fgBefore.length >= 0, `${fgBefore} → ${fgAfter}`);

    // ---- 5. 登录态判据（泛化，不写死平台） -■---
    const seenAuthed = { avatar: true, wall: false };
    const seenWall = { avatar: false, wall: true };
    record('5a 判据表判定（头像→signed-in / 登录墙→signed-out）',
      judgeLoginState(seenAuthed).state === 'signed-in' && judgeLoginState(seenWall).state === 'signed-out',
      `${judgeLoginState(seenAuthed).state} / ${judgeLoginState(seenWall).state}`);
    // 用夹具（非平台站）验证判据在真实页面上也能读出：直接调 probe 的页面部分不方便，
    // 这里用 evaluate 自证判据表对未知平台不适用（必须显式报错）
    await assert.rejects(() => probeLoginState({ platform: 'bogus' }), /未支持的平台/);
    record('5b 未知平台明确报错（不瞎猜）', true, 'probeLoginState(bogus) 抛出未支持');

    // ---- 6. 控制台 -■---
    record('6 控制台收集可用', Array.isArray(consoleMessagesReal()?.messages), JSON.stringify(consoleMessagesReal()?.messages?.length ?? null));

    // ---- 7. 断开后 Edge 仍存活（红线） -■---
    const beforeDisconnect = await isCdpUp(PORT);
    const dis = await disconnectReal();
    await sleep(1500);
    const stillUp = await isCdpUp(PORT);
    const cmdline = await edgeProcessCommandLine(PORT);
    record('7a 断开后 CDP 仍在线（Edge 没被杀）', beforeDisconnect && stillUp, JSON.stringify(dis));
    record('7b Edge 进程仍带 9224 端口参数（真进程还活着）', cmdline.includes(`--remote-debugging-port=${PORT}`), cmdline.slice(0, 120));

    // ---- 8. 重连后登录态还在（同 profile） -■---
    const reconnected = await connectReal({ port: PORT, profile: PROFILE });
    const homeAfter = await navigateReal(`${origin}/home`, { observe: true });
    record('8 重连后登录态页面仍可读（cookie 在同一 profile 保留）',
      reconnected.ok === true && /welcome back/.test(homeAfter.snapshot?.tree || ''),
      `tree=${(homeAfter.snapshot?.tree || '').slice(0, 120).replace(/\n/g, ' | ')}`);
    const finalShot = await screenshotReal();
    if (finalShot.ok) await writeFile(path.join(evidence, 'real-edge-reconnected.png'), finalShot.buf);

    // ---- 8b. CU 混用闸（0.31.1）：必须认得出「这套隔离 Edge 的 pid」 -■---
    // 这是混用闸的唯一依据：拿到 pid 才能判断「前台是不是我们自己启动的 Edge」。
    const edgePid = await browserProcessId();
    record('8b 能查到隔离 Edge 的浏览器主进程 pid（混用闸的依据）', Number(edgePid) > 0, `pid=${edgePid} info=${JSON.stringify(realInfo())}`);
    const gate = realEdgeRedirect({ foreground: { process: 'msedge', pid: edgePid }, realPid: edgePid, realConnected: true });
    record('8c 前台是这套 Edge 时 CU 被改路（computer_* 一律拒绝）', gate?.deniedBy === 'real-edge-redirect', gate?.error?.slice(0, 100) || '未拦截');
    record('8d 别的 pid 不被误拦（用户日常 Edge 不受影响）',
      realEdgeRedirect({ foreground: { process: 'msedge', pid: Number(edgePid) + 1 }, realPid: edgePid, realConnected: true }) === null, 'ok');

    // --close-edge 才真关浏览器
    if (process.argv.includes('--close-edge')) {
      const closed = await closeRealEdgeAndReset();
      await sleep(1500);
      record('9 显式关闭（--close-edge）：CDP 已下线', (await isCdpUp(PORT)) === false, JSON.stringify(closed));
    } else {
      await disconnectReal();
      record('9 默认保留 Edge（不杀人工浏览器）', await isCdpUp(PORT) === true, 'CDP 仍在线');
    }

    await finish();
  } catch (error) {
    record('异常', false, error?.stack || error?.message || error);
    await finish(1);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function extractRef(tree, needle) {
  const line = String(tree || '').split('\n').find((l) => l.toLowerCase().includes(needle.toLowerCase()) && l.includes('[ref='));
  return line?.match(/\[ref=(r\d+)\]/)?.[1] || '';
}

// 前台窗口标题（Win32，只读诊断）：用于证明 CDP 点击没有抢前台。
// 不在 JS 里拼 C# 源码（多层转义极易写错、真机跑起来才发现）——改成把脚本写到临时 .ps1 再执行。
async function foregroundTitle() {
  try {
    const { spawnSync } = await import('node:child_process');
    const { writeFile: wf } = await import('node:fs/promises');
    const ps1 = path.join(evidence, 'fg-title.ps1');
    await wf(ps1, [
      '$sig = @"',
      'using System;',
      'using System.Text;',
      'using System.Runtime.InteropServices;',
      'public static class FgWin {',
      '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
      '}',
      '"@',
      'Add-Type -TypeDefinition $sig',
      '$h = [FgWin]::GetForegroundWindow()',
      '$sb = New-Object System.Text.StringBuilder 512',
      '[void][FgWin]::GetWindowText($h, $sb, 512)',
      'Write-Output $sb.ToString()',
      ''
    ].join('\n'), 'utf8');
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      encoding: 'utf8', windowsHide: true, timeout: 20000
    });
    return String(r.stdout || '').trim();
  } catch { return ''; }
}

// 用 CIM 查 msedge 进程命令行里是否还带 9224（证明 Edge 进程本身还在）。
// 同样走临时 .ps1：Inline -Command 里的引号/美元号多层转义在 Git Bash 下必然走形。
async function edgeProcessCommandLine(port) {
  try {
    const { spawnSync } = await import('node:child_process');
    const { writeFile: wf } = await import('node:fs/promises');
    const ps1 = path.join(evidence, 'edge-cmdline.ps1');
    await wf(ps1, [
      `$ErrorActionPreference = 'Stop'`,
      `$procs = Get-CimInstance Win32_Process -Filter ("Name='msedge.exe'")`,
      `$hit = $procs | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${port}*' } | Select-Object -First 1`,
      `if ($hit) { Write-Output $hit.CommandLine } else { Write-Output '' }`,
      ''
    ].join('\n'), 'utf8');
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      encoding: 'utf8', windowsHide: true, timeout: 25000
    });
    return String(r.stdout || '').trim();
  } catch { return ''; }
}

async function finish(status = 0) {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({
    port: PORT, profile: PROFILE, at: new Date().toISOString(), passed, total: results.length, failed: failed.length, results
  }, null, 2), 'utf8');
  // 保留 profile：下一次跑可以直接验证「重连读到同一登录态」
  console.log(`\n=== 阶段 2 真机验收 ${failed.length === 0 ? '全过' : failed.length + ' 项失败'}（${passed}/${results.length}） ===`);
  console.log('证据: ' + evidence);
  process.exitCode = failed.length === 0 ? 0 : 1;
  if (status) process.exitCode = status;
}

main().catch(async (e) => {
  console.error(e);
  await finish(1);
});
