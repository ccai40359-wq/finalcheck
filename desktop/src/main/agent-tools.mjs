// Agent 工具实现（从 index.mjs 抽出：可单测、可替换权限台账）
// 只负责「工具做什么」；工具名/参数的模型可见 schema 在 agent-service.mjs（SSOT）
import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadSkills, readPlaybook, catalogSummary } from '../../../src/playbooks.mjs';
import { readFileTool, editFileTool, writeFileTool } from '../../../src/fs-tools.mjs';
import { assertPathAllowed, checkFileName, assertCwd, checkCommand, checkDestructiveTargets, checkCommandPaths, scrubEnv } from './policy.mjs';
import { runHookEvent } from './hooks.mjs';
import { isBlocked } from './shell.mjs';
import { shellReadRedirect } from './shell-route.mjs';
import { auditNextSteps } from './next-steps.mjs';
import { resolveShell } from './shell-resolver.mjs';
import { dynamicRuntime, recordProbe, recordStress } from './dynamic-evidence.mjs';
import { assertArtifactPath } from './artifact-gate.mjs';
import { createSandboxedRun, sandboxAvailability, sandboxCompatible } from './sandbox.mjs';
// 工作流兜底提示走双语词典（zh 原样返回，en 查表）
import { t } from '../renderer/i18n/core.mjs';
import { checkProbeBudget, checkScreenshotBudget, isProbeCommand, workflowBudgetFromEnv, WORKFLOW_BUDGET_INITIAL } from './cu-workflow-budget.mjs';
// 0.31.1：浏览器三模式「先问用户」的纯逻辑（选项文案 / 回答解析 / 决策 / CU 重定向）
import { decideBrowserChoice, buildChoicePrompt, parseBrowserChoice, parseRealConsent, buildRealConsentPrompt, choiceNote, realEdgeRedirect, NO_CHANNEL_REAL_DENY } from './browser-choice.mjs';
// 用户选了模式后要按它重建窗口，所以这里也要用到 partition 纯函数（该模块不 import electron）
import { resolvePartition } from './browser-session.mjs';

/** 提问卡里给用户看的主机名（非法 URL 就退回截断原文，绝不把整条 URL 塞进问题里） */
function safeHost(url) {
  try { return new URL(String(url)).host || String(url).slice(0, 60); } catch { return String(url || '').slice(0, 60); }
}

const PREVIEW_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.html', '.htm', '.pdf', '.mp4', '.m4v', '.webm', '.mov', '.ogv', '.pptx', '.ppt', '.pps', '.ppsx', '.odp', '.key', '.docx', '.doc', '.odt', '.rtf', '.txt', '.md', '.json', '.js', '.mjs', '.css', '.csv', '.log', '.xml', '.yml', '.yaml']);

// hook 说 ask 时可以接上现有审批通道的工具（其余工具没有审批通道 → 明确报错，不静默执行）
const APPROVAL_TOOLS = new Set(['edit_file', 'write_file', 'run_command', 'quality_gate']);

function policyDenyResult(check) {
  // 2026-11-17：沙箱默认关闭后这层是**应用层策略闸**（正则/路径白名单/黑名单），
  // 不是沙箱拒绝。旧文案写「被沙箱拒绝」会让人以为有 OS 级隔离，属误导，已改。
  return {
    error: '被策略闸拒绝：' + check.reason,
    deniedBy: 'policy',
    reason: check.reason,
    ...(check.matchedRule ? { matchedRule: check.matchedRule } : {})
  };
}

// ---- run_command 可中断执行：signal 触发 → Windows 杀整棵进程树并立即 resolve cancelled ----
// 与 shell.mjs 的护栏保持一致（灾难命令 / 超时 clamp / 输出截断 / System32 PATH），
// 额外把 pid 留在手里，用于中断时 taskkill /PID <pid> /T /F。
const CANCELLED_RESULT = () => ({ error: '已中断', cancelled: true, code: null, stdout: '', stderr: '' });

// STATUS_DLL_INIT_FAILED（0xC0000142）：进程在初始化阶段就死了，命令本身一行都没执行。
// Accept both signed and unsigned representations of the 32-bit exit code.
const DLL_INIT_FAILED_CODES = new Set([3221225794, -1073741502]);
function isDllInitFailure(result) {
  if (!result || result.blocked || result.error) return false;
  return DLL_INIT_FAILED_CODES.has(Number(result.code));
}

/**
 * ACL 写保护开关（2026-11-17 用户决策：**默认关闭**，统一走宿主机 Git Bash）。
 *
 * ⚠️ 这是**独立开关**，不是 policy.mode（规格 §1.2 的教训）：
 *   把 policy.mode 改 'off' 会同时关掉【项目边界闸】和【删除目标检查】——
 *   因为 checkCommandPaths 里 `strictBoundary = mode !== 'off'`，
 *   而 checkDestructiveTargets 里有 `mode === 'off'` 短路。
 *   用户要关的只是「ACL 写保护」，不是「允许删项目外文件」。所以拆成两个维度。
 *
 * 决策依据（实测，不是推测）：
 *   · ACL 受限令牌沙箱只拦写、不拦读（沙箱包 README 原文 "Writes are restricted;
 *     reads, network, and process visibility are not"；实测 `type 项目外文件` 能读出内容）
 *   · 它只覆盖 cmd 那一半命令；真正能写盘的 ls/rm/node/npm 一直走宿主机
 *   · 受限令牌下 Git Bash 起不来（signal pipe / CreateFileMapping → Win32 error 5），
 *     加回用户 SID 能让 bash 跑但沙箱被击穿；AppContainer 同样不行（微软 mxc#1061 open）
 *   · Claude Code 原生 Windows 无沙箱；Codex 的选择是「保沙箱、砍 bash」（默认 PowerShell）
 *     —— 我们反过来：保 bash、关 ACL 写保护，靠应用层三道闸。
 *
 * 优先级：显式传入的 opts.aclSandbox > 环境变量 FINALCHECK_ACL_SANDBOX=on > 默认 false。
 * @param {{aclSandbox?: boolean}} [opts]
 */
export function sandboxEnabled(opts = {}) {
  if (typeof opts?.aclSandbox === 'boolean') return opts.aclSandbox;
  return String(process.env.FINALCHECK_ACL_SANDBOX || '').trim().toLowerCase() === 'on';
}

// 空闲输出看门狗：不设「工作时长上限」（长任务可以跑 1 小时），只在「连续 N 毫秒没有任何输出
// 且进程还活着」时认为命令卡住（常驻服务 / 静默网络请求），结束本轮等待、转入后台，但绝不杀进程。
export const DEFAULT_COMMAND_IDLE_MS = 120000;
export const RUN_COMMAND_BACKGROUND_HINT = '启动常驻服务请直接用 background:true，不要在命令里用 Start-Process / start /b 然后等它返回。';

function idleLabel(ms) {
  if (ms < 1000) return `${ms} 毫秒`;
  const sec = ms / 1000;
  return `${Number.isInteger(sec) ? sec : sec.toFixed(1)} 秒`;
}

function backgroundNote(pid) {
  return `已在后台启动（PID=${pid}）。不会等待输出；需要停止时用 taskkill /PID ${pid} /T /F。${RUN_COMMAND_BACKGROUND_HINT}`;
}

function idleNote(pid, idleMs) {
  return `命令仍在运行，但已 ${idleLabel(idleMs)}无输出，已转入后台（PID=${pid}）。进程没有被终止；需要停止时用 taskkill /PID ${pid} /T /F。${RUN_COMMAND_BACKGROUND_HINT}`;
}

function terminateTree(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      proc.kill('SIGKILL');
    }
  } catch { /* 已退出 */ }
  try { proc.unref?.(); } catch { /* 忽略 */ }
}

// 长命令可见性（F7）：不设默认硬超时（用户明确要求），但「还在跑」必须看得见。
// idle_ms:0 = 关掉空闲转后台兜底 → 命令可能长时间无输出；从 60s 起每 30s 推一条活动提示，
// 只带「仍在运行 Ns」，不带任何输出内容（不把大对象塞进 IPC）。
export const RUNNING_PING_START_MS = 60000;
export const RUNNING_PING_EVERY_MS = 30000;

/** 第 n 次活动提示应该在什么时刻（相对命令开始，毫秒）；不在提示点上时返回下一个提示点 */
export function planRunningPings(elapsedMs, startMs = RUNNING_PING_START_MS, everyMs = RUNNING_PING_EVERY_MS) {
  const el = Math.max(0, Number(elapsedMs) || 0);
  const start = Math.max(0, Number(startMs) || 0);
  const every = Math.max(1, Number(everyMs) || 1);
  if (el < start) return { due: null, nextAt: start };
  const due = start + Math.floor((el - start) / every) * every;
  return { due, nextAt: due + every };
}

// 命令输出的收集上限：超过就保留头尾、省略中间（报错/测试汇总往往在末尾，不能只留开头）。
// 给模型时由 agent-service 统一处理：≤2 万字符原样给；更长的全文落盘、上下文里放头 + 尾 + 落盘路径。
// 0.26 以前这里是 slice(0, 8000)：只留前 8000 字符、末尾整段丢掉、也不提示被截（模拟客户端工具层测试抓到的）。
export const COMMAND_STDOUT_CAP = 400000;
export const COMMAND_STDERR_CAP = 100000;

/** 头尾保留的增量拼接：返回新串与累计省略字符数 */
export function appendKeepEnds(cur, chunk, cap, dropped = 0) {
  const next = cur + chunk;
  if (next.length <= cap) return { text: next, dropped };
  const half = Math.floor(cap / 2);
  return { text: next.slice(0, half) + next.slice(next.length - (cap - half)), dropped: dropped + (next.length - cap) };
}

/** 有省略时在头尾交界处标注省略了多少 */
export function markOmitted(text, dropped, cap) {
  if (!dropped) return text;
  const half = Math.floor(cap / 2);
  return text.slice(0, half) + `\n…[输出过长，中间省略 ${dropped} 字符]…\n` + text.slice(half);
}

export function runCommandWithSignal(command, {
  cwd, timeoutMs, idleMs = DEFAULT_COMMAND_IDLE_MS, background = false, env: envInput, signal = null,
  sandbox = null, shellAppRoot = null,
  onActivity = null, pingStartMs = RUNNING_PING_START_MS, pingEveryMs = RUNNING_PING_EVERY_MS
} = {}) {
  return new Promise((resolve) => {
    const cmd = String(command || '').trim();
    if (!cmd) return resolve({ blocked: false, code: 1, stdout: '', stderr: '命令为空' });
    if (isBlocked(cmd)) return resolve({ blocked: true, code: null, stdout: '', stderr: '命令被安全策略拦截（灾难性操作）' });
    if (signal?.aborted) return resolve(CANCELLED_RESULT());
    // 长命令（npm test / 构建）不被掐死：默认不设超时，跑到结束；显式 timeoutMs 才生效。
    // 显式 timeoutMs 是硬上限：此时关闭空闲看门狗，保持「到点终止」的旧语义。
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
    const idleMsNum = Number(idleMs);
    const idle = timeout > 0 ? 0 : (Number.isFinite(idleMsNum) && idleMsNum > 0 ? idleMsNum : 0);
    const wantsBackground = background === true;
    const isWin = process.platform === 'win32';
    const env = envInput && typeof envInput === 'object' ? { ...envInput } : { ...process.env };
    if (isWin) {
      // 2026-11-17（规格 §1.3 点名的「最容易漏、后果最坏」一条）：
      // 这段前置原本是为了让**沙箱里的 cmd.exe** 拿到 cmd 自带的 find/sort/more。
      // 只在开 ACL 沙箱时（sandbox != null，此时 shell 必定是 cmd）才需要。
      // 关沙箱后命令走 Git Bash，这个前置会把 Git Bash 的 find/sort 换成
      // C:\Windows\System32\find.exe（Windows 的文本查找，语义完全不同）。
      // 所以：沙箱在场才前置；走 Git Bash 时保留用户原 PATH（bash 自己排在最前）。
      const sys = 'C:\\Windows\\System32;C:\\Windows;';
      const old = env.PATH || env.Path || '';
      if (sandbox) {
        env.PATH = sys + old;
        env.Path = env.PATH;
      } else {
        env.PATH = old;
        env.Path = old;
      }
    }
    if (sandbox?.env && typeof sandbox.env === 'object') Object.assign(env, sandbox.env);
    let out = '', err = '', settled = false, proc = null, timer = null, idleTimer = null, pingTimer = null;
    let outDropped = 0, errDropped = 0;
    const t0 = Date.now();
    let nextPingAt = Math.max(0, Number(pingStartMs) || 0); // 下一次活动提示的「已运行毫秒」
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (pingTimer) clearTimeout(pingTimer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      // 前台命令结束时释放沙箱私有 temp；后台进程仍在跑，留给后续手动清理
      if (sandbox && !value?.background) {
        try { setTimeout(() => sandbox.cleanup?.(), 300).unref?.(); } catch { /* ignore */ }
      }
      const so = value.stdout ?? out;
      const se = value.stderr ?? err;
      resolve({
        ...value,
        sandbox: sandbox ? sandbox.mode : 'none',
        stdout: so === out ? markOmitted(out, outDropped, COMMAND_STDOUT_CAP) : String(so),
        stderr: se === err ? markOmitted(err, errDropped, COMMAND_STDERR_CAP) : String(se)
      });
    };
    // 「仍在运行 Ns」活动提示：只报耗时，不带 stdout/stderr。
    // 目的：idle_ms:0 或超长命令时，UI 上看得见它在动，而不是像卡死。
    const armPing = () => {
      if (settled || wantsBackground || typeof onActivity !== 'function') return;
      if (pingTimer) clearTimeout(pingTimer);
      const elapsed = Date.now() - t0;
      const delay = Math.max(20, nextPingAt - elapsed);
      pingTimer = setTimeout(() => {
        if (settled) return;
        const now = Date.now() - t0;
        if (now < nextPingAt) { armPing(); return; } // 定时器早醒：等真正的提示点
        const plan = planRunningPings(now, pingStartMs, pingEveryMs);
        const at = plan.due == null ? now : plan.due;
        nextPingAt = at + Math.max(1, Number(pingEveryMs) || RUNNING_PING_EVERY_MS);
        try {
          onActivity({ kind: 'activity', tool: 'run_command', tone: 'activity', label: t('仍在运行 {n}s', { n: Math.max(1, Math.round(at / 1000)) }) });
        } catch { /* 提示失败不影响命令 */ }
        armPing();
      }, delay);
      pingTimer.unref?.(); // 提示计时器不自己撑住事件循环
    };
    const onAbort = () => {
      if (settled) return;
      err += '\n[已中断]';
      terminateTree(proc);
      finish({ error: '已中断', cancelled: true, code: null, stdout: out, stderr: err });
    };
    // 转入后台：解绑本轮监听器、继续排空管道（否则子进程写满缓冲区会卡住）、进程 unref，不杀进程。
    const releaseProcess = () => {
      if (!proc) return;
      try {
        proc.stdout?.removeAllListeners('data');
        proc.stderr?.removeAllListeners('data');
        if (proc.stdout && !proc.stdout.destroyed) proc.stdout.on('data', () => {});
        if (proc.stderr && !proc.stderr.destroyed) proc.stderr.on('data', () => {});
        proc.removeAllListeners('close');
        proc.removeAllListeners('exit');
        proc.removeAllListeners('error');
        proc.on('error', () => {}); // 保留吞错监听，避免后台进程的迟到 error 冒成未捕获事件
        if (sandbox) proc.once('close', () => sandbox.cleanup?.());
        proc.unref?.();
      } catch { /* 忽略 */ }
    };
    const onIdle = () => {
      if (settled) return;
      // 已退出（close 事件尚未派发）就不算「活着」：交给 close 正常收尾
      if (!proc || proc.exitCode !== null || proc.killed) return;
      const pid = proc.pid;
      releaseProcess();
      finish({ blocked: false, background: true, code: null, pid, note: idleNote(pid, idle), stdout: out, stderr: err });
    };
    const armIdle = () => {
      if (!idle || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, idle);
      idleTimer.unref?.(); // 看门狗不自己撑住事件循环
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const spawnOptions = {
        cwd: (sandbox ? sandbox.cwd : cwd) && existsSync(String(sandbox ? sandbox.cwd : cwd)) ? String(sandbox ? sandbox.cwd : cwd) : undefined,
        // Every launcher stays hidden. The sandbox wrapper creates its console
        // with SW_HIDE before the restricted child starts; never use detached or
        // visible-window fallbacks, including after DLL initialization failures.
        windowsHide: isWin,
        env,
        // Background commands inherit the same hidden-console setup. Ignore
        // stdio and unref the child instead of changing process creation modes.
        ...(wantsBackground ? { stdio: 'ignore' } : {})
      };
      // 决策 1（2026-11-16）：非沙箱路径统一走 Git Bash（用户已装 → 内置 → cmd 回落）。
      // shell:true 会让 Node 用 cmd.exe 套壳，模型写 bash 语法（cat/2>/dev/null/&& $?）就全错。
      const shellSpec = sandbox ? null : resolveShell({ appRoot: shellAppRoot });
      proc = sandbox
        ? spawn(sandbox.file, sandbox.args, { ...spawnOptions, shell: false })
        : spawn(shellSpec.file, shellSpec.args(cmd), {
            ...spawnOptions,
            env: { ...spawnOptions.env, ...(shellSpec.env || {}) },
            shell: false
          });
    } catch (e) {
      return finish({ blocked: false, code: 1, stdout: '', stderr: e?.message || String(e) });
    }
    if (signal?.aborted) return onAbort(); // spawn 与监听之间被中断
    if (timeout > 0) {
      timer = setTimeout(() => {
        err += '\n[超时已终止]';
        terminateTree(proc);
        finish({ blocked: false, code: 124, stdout: out, stderr: err }); // 不等子树 close，避免孙进程占管道悬挂
      }, timeout);
    }
    proc.stdout?.on('data', (d) => {
      ({ text: out, dropped: outDropped } = appendKeepEnds(out, d.toString(), COMMAND_STDOUT_CAP, outDropped));
      armIdle(); // 有输出就重新计时：只要 stdout/stderr 还在滚，就永远不因空闲转后台
    });
    proc.stderr?.on('data', (d) => {
      ({ text: err, dropped: errDropped } = appendKeepEnds(err, d.toString(), COMMAND_STDERR_CAP, errDropped));
      armIdle();
    });
    proc.on('close', (c) => finish({ blocked: false, code: c ?? 0, stdout: out, stderr: err }));
    proc.on('error', (e) => finish({ blocked: false, code: 1, stdout: out, stderr: err + e.message }));
    if (wantsBackground) {
      const pid = proc.pid;
      releaseProcess();
      return finish({ blocked: false, background: true, code: null, pid, note: backgroundNote(pid), stdout: out, stderr: err });
    }
    armIdle();
    armPing(); // 前 60s 静默；之后每 30s 一条「仍在运行 Ns」（不含输出内容）
  });
}

// ---- grep_code：专用代码搜索（ripgrep 优先，找不到自动回退 findstr 字面量，不报错） ----
export const GREP_DEFAULT_MAX_RESULTS = 50;
// stdout 收集上限（字符）：超大仓库全库命中时防止刷爆内存；截断后 total 可能偏小，返回里会注明
export const GREP_OUTPUT_CAP = 2000000;

/**
 * rg.exe 检测（独立导出，打包 extraResources 与启动诊断复用）。检测顺序：
 *   1) 环境变量 FINALCHECK_RG_PATH 显式指定（测试 / 用户自定义）；
 *   2) 打包捆绑：Electron extraResources → <process.resourcesPath>/rg/rg.exe；
 *   3) 开发态捆绑：<repoRoot>/vendor/rg/rg.exe（下载的 rg.exe 放这里即被检测到）；
 *   4) PATH 上的 rg（Windows 只认 rg.exe，避免命中同名包装脚本）。
 * 都找不到返回 null —— grep_code 会自动回退 findstr，不报错。
 */
export function resolveRipgrepPath({ repoRoot = null } = {}) {
  const bin = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const envPath = String(process.env.FINALCHECK_RG_PATH || '').trim();
  if (envPath) {
    try { if (existsSync(envPath)) return path.resolve(envPath); } catch { /* 忽略坏路径 */ }
  }
  const bundled = [
    process.resourcesPath ? path.join(process.resourcesPath, 'rg', bin) : null,
    repoRoot ? path.join(repoRoot, 'vendor', 'rg', bin) : null
  ].filter(Boolean);
  for (const candidate of bundled) {
    try { if (existsSync(candidate)) return candidate; } catch { /* 忽略 */ }
  }
  const dirs = String(process.env.PATH || process.env.Path || '')
    .split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch { /* 忽略无权限 / 断链 */ }
  }
  return null;
}

/** 不经 shell 的进程捕获：argv 数组直传（杜绝命令注入），stdout 有收集上限 */
function spawnCapture(file, argv, { cwd = null, stdoutCap = GREP_OUTPUT_CAP } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', settled = false;
    let proc;
    try {
      proc = spawn(file, argv, { cwd: cwd && existsSync(cwd) ? cwd : undefined, windowsHide: true, shell: false });
    } catch (e) {
      return resolve({ code: null, stdout: '', stderr: e?.message || String(e), spawnFailed: true });
    }
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      resolve({ code: null, stdout: out, stderr: String(e?.message || e), spawnFailed: true });
    });
    proc.stdout?.on('data', (d) => { if (out.length < stdoutCap) out += d.toString(); });
    proc.stderr?.on('data', (d) => { if (err.length < 20000) err += d.toString(); });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout: out, stderr: err, outTruncated: out.length >= stdoutCap });
    });
  });
}

/**
 * rg / findstr 行输出解析：`<path>:<line>:<text>`。
 * 非贪婪切第一个 `:数字:`：路径盘符冒号（C:\）与匹配行里的 URL 冒号（localhost:3000）不误切。
 */
function parseGrepRow(row) {
  const m = /^(.+?):(\d+):(.*)$/.exec(row);
  if (!m) return null;
  const line = Number(m[2]);
  if (!Number.isFinite(line) || line <= 0) return null;
  return { file: m[1], line, text: m[3] };
}

/** 结构化结果收口：{file,line,text} 前 max 条 + total 计数；超限截断并提示缩小范围 */
function finishGrepResult(rows, { max, target, glob, pattern, engine, truncatedOut = false }) {
  const total = rows.length;
  const truncated = total > max;
  const notes = [];
  if (engine.startsWith('findstr')) notes.push('findstr 回退仅支持字面量匹配（literal-only），正则语法请安装 ripgrep');
  if (truncatedOut) notes.push('输出超过收集上限已截断，total 可能偏小');
  if (truncated) notes.push(`匹配 ${total} 条，超过 maxResults=${max}，只返回前 ${max} 条；请加 glob 或缩小 path 范围`);
  return {
    engine,
    pattern,
    path: target,
    ...(glob ? { glob } : {}),
    results: rows.slice(0, max),
    total,
    ...(truncated ? { truncated: true } : {}),
    ...(truncatedOut ? { outputTruncated: true } : {}),
    ...(notes.length ? { note: notes.join('；') } : {})
  };
}

/**
 * findstr 回退（仅 Windows）：/L /C: 字面量匹配（返回里注明 literal-only）。
 * findstr 跟随系统代码页（不认 UTF-8），中文内容匹配不可靠 —— rg 缺失时才有此限制。
 */
async function grepCodeFindstr({ target, glob, pattern, max }) {
  let st = null;
  try { st = statSync(target); } catch { /* 目标不存在时让 findstr 自己报错 */ }
  const isFile = !!st && st.isFile();
  const cwd = isFile ? path.dirname(target) : target;
  const spec = isFile ? path.basename(target) : (glob || '*');
  const argv = ['/N', '/L', '/P'];
  if (!isFile) argv.push('/S');
  argv.push(`/C:${pattern}`, spec);
  const r = await spawnCapture('findstr', argv, { cwd });
  if (r.spawnFailed || (r.code !== 0 && r.code !== 1)) {
    return {
      error: `findstr 回退失败（退出码 ${r.code}）：${(r.stderr || '未知错误').slice(0, 500)}`,
      engine: 'findstr (literal-only)',
      pattern,
      path: target
    };
  }
  const rows = [];
  for (const row of r.stdout.split(/\r?\n/).filter(Boolean)) {
    // /S 多文件输出带路径（`path:line:text`）；单文件无路径（`line:text`，实测 findstr 行为）
    const withFile = parseGrepRow(row);
    if (withFile) rows.push({ ...withFile, file: path.resolve(target, withFile.file) });
    else {
      const onlyLine = /^(\d+):(.*)$/.exec(row);
      if (onlyLine) rows.push({ file: path.resolve(target), line: Number(onlyLine[1]), text: onlyLine[2] });
    }
  }
  return finishGrepResult(rows, { max, target, glob, pattern, engine: 'findstr (literal-only)', truncatedOut: !!r.outTruncated });
}

// 模型可见 schema 条目（SSOT 在 agent-service.mjs 的 TOOLS_SCHEMA；本文件导出待并轨条目，
// 由主会话 append 进 SSOT —— 避免与其他 worker 对 agent-service.mjs 的并行改动冲突）。
export const GREP_CODE_SCHEMA = {
  type: 'function',
  function: {
    name: 'grep_code',
    description: '跨文件搜索代码：内置 ripgrep（找不到才回退 findstr 字面量），返回结构化匹配 [{file,line,text}]（file 绝对路径）+ total 计数，性能远高于手写 findstr。⚠️ 找代码/找报错文本/找函数调用一律用它，不要用 run_command 的 grep/findstr 搜内容（那个会返回无行号的纯文本，且可能被沙箱拒绝）。pattern 必填（ripgrep 正则语法）；path 可选（绝对路径用正斜杠，默认应用根目录；搜用户项目请显式传项目路径）；glob 可选按文件名过滤（如 *.js）；maxResults 默认 50，超出只返回前 N 条并提示缩小范围',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜的关键词/函数名/报错文本（必填）' },
        path: { type: 'string', description: '可选：搜索目录或文件的绝对路径（用正斜杠），默认应用根目录' },
        glob: { type: 'string', description: '可选：文件名过滤（ripgrep glob 语法，如 *.js、**/*.mjs）' },
        maxResults: { type: 'number', description: '可选：最多返回多少条匹配（默认 50）' }
      },
      required: ['pattern']
    }
  }
};

// todo_write 的 CC 式三条规则（并轨时追加到 AGENT_ONLY_TOOLS_SCHEMA 里 todo_write 的 description 末尾）
export const TODO_CC_RULES_TEXT = 'CC 式规则：① 同一时间恰好一个 in_progress（工具层会自动把多余的 running 降回 pending 并提示）；② 测试失败/实现不全/有未解决错误时禁止标 done——保持 running，并新建一条写清「需要解决什么」；③ 做完一条立刻调用 todo_write 更新状态，不要攒批';

// ---- 0.29.7 注入闸脚本文件扫描 ----
// 真机实证的缺口：模型写 final_send.ps1 后 `powershell -NoProfile -File D:/CUBUtesting/final_send.ps1`
// ——关键词全在脚本文件里、命令行只有 powershell，闸扫不到。修法：命令行命中编译/执行上下文时，
// 把 -File/-f 引用的本地脚本与内联 heredoc 正文一并纳入同一对 INJECTION_KEYWORDS×INJECTION_COMPILER
// 判定。文件不存在/读不到 → 放行（保持现状，不新增失败模式）。
const INJECTED_SCRIPT_MAX_BYTES = 512 * 1024; // 注入脚本不会更长；避免把大文件整个读进来
const INJECTION_COMPILER_TOKEN = /(?:^|[\s"'&(])(?:powershell|pwsh|python3?|cscript(?:\.exe)?)\b/i;

function readScriptBody(rawPath, cwd) {
  try {
    const p = String(rawPath || '').trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
    if (!p || /^https?:/i.test(p) || p.includes('\u0000')) return null;
    const abs = path.isAbsolute(p) ? p : path.join(cwd || process.cwd(), p);
    const st = statSync(abs);
    if (!st.isFile() || st.size > INJECTED_SCRIPT_MAX_BYTES) return null;
    return { abs, body: readFileSync(abs, 'utf8') };
  } catch { return null; } // 文件不存在/读不到 → 放行
}

/**
 * 收集命令引用的脚本正文（-File/-f 指向的本地文件 + 内联 heredoc 代码块）。
 * -f 只认编译/执行器（powershell/pwsh/python/cscript）所在命令段内的出现，避免 `grep -f` 之类误伤。
 * @param {string} cmd 完整命令串
 * @param {string|null} [cwd] 相对路径的解析基准（run_command 的 cwd）
 * @returns {{files:string[], bodies:string[]}} files 仅为可读文件（body 非空才计入）
 */
export function collectInjectedScriptBodies(cmd, cwd = null) {
  const files = [];
  const bodies = [];
  const text = String(cmd || '');
  if (!text) return { files, bodies };
  // ① -File/-f 引用的本地脚本（按 && || ; | 换行切段，段内必须出现编译/执行器才抽 -f*）
  for (const seg of text.split(/&&|\|\||;|\||\r?\n/)) {
    const s = seg.trim();
    if (!s || !INJECTION_COMPILER_TOKEN.test(s)) continue;
    const flagRe = /(?:^|[\s"'&(])-f(?:ile)?\s+(?:"([^"]+)"|'([^']+)'|([^\s'"&|;<>]+))/gi;
    let m;
    while ((m = flagRe.exec(s))) {
      const found = readScriptBody(m[1] || m[2] || m[3], cwd);
      if (found?.body) { files.push(found.abs); bodies.push(found.body); }
    }
  }
  // ② 内联 heredoc 正文（<<[-]TAG … TAG）：python - <<'PY' 这类把脚本贴在命令里的写法
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const h = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/.exec(lines[i]);
    if (!h) continue;
    const body = [];
    let closed = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === h[1]) { closed = true; i = j; break; }
      body.push(lines[j]);
    }
    if (closed && body.length) bodies.push(body.join('\n'));
  }
  return { files, bodies };
}

export function createAgentTools({ repoRoot, permissions, recordAudit = async () => {}, playbookRoot, runWorkflow = null, projectPath = null, policy = null, hooksConfig = null, hooksRunner = null, sessionId = null, cwd = null, signal = null, commandIdleMs = DEFAULT_COMMAND_IDLE_MS, askUser = null, todoWrite = null, spawnAgent = null, onActivity = null, requireAuditIntent = null, shellAppRoot = null, aclSandbox = undefined, userStatedTier = null, getDesktopToolsAsync = null, browserSessionPolicy = null, onBrowserFirstUse = null, getBrowserRealAsync = null, browserUserDataDir = null, browserChoice = null } = {}) {
  let askedThisTurn = false; // 本回合已经通过 ask_user 问过用户（验收前置闸据此放行）
  // 0.31.1：本会话内用户已经选过的浏览器模式（主进程按 sessionId 存，跨回合有效）。
  // createAgentTools 每个回合重建一次——把记忆放在这里会让「同一任务里连续导航」每轮都弹卡。
  const choiceStore = browserChoice && typeof browserChoice === 'object'
    ? browserChoice
    : { get: () => '', set: () => {} };
  // 0.30.4 CU 工作流配额（引擎侧硬约束）：按一次 createAgentTools 实例（≈一个回合）计数。
  // 每秒 2 次全屏 / 2 次 region / 1 次窗口探测，超出直接拒绝并给替代动作——真机实证
  // 换模型后（flash 类）对长上下文里的软提示不敏感，一次任务曾拍 33 张图、21 次 run_command 查窗口。
  const cuWorkflowBudget = workflowBudgetFromEnv();
  const cuWorkflowUsed = { ...WORKFLOW_BUDGET_INITIAL };
  if (!repoRoot) throw new Error('createAgentTools 需要 repoRoot');
  const engineUrl = (rel) => pathToFileURL(path.join(repoRoot, rel)).href;
  // 验收前置闸：只有「能向用户提问」的主 agent 才强制先问档位/维度。
  // 子代理与工作流 gate 走同一份 createAgentTools 但不传 askUser（见 ipc-agent.mjs），
  // 它们的 audit_project 必须保持原行为（gate 里没有交互通道，兜底成 L2 继续跑）。
  const askBeforeAudit = requireAuditIntent === null ? typeof askUser === 'function' : !!requireAuditIntent;
  const note = (url) => permissions?.noteTarget?.(url);
  const hooksOn = !!(hooksConfig && hooksConfig.enabled === true);
  const hookCwd = cwd || projectPath || undefined;
  const runHook = (event, payload) => runHookEvent(event, payload, {
    cwd: hookCwd,
    config: hooksConfig,
    runner: hooksRunner || undefined
  });

  // hook ask 批准后下发的一次性免审券：target 必须与工具内部 requestApproval 前的免批键一致。
  // 文件类工具内部用的是 assertPathAllowed 返回的规范化真实路径，这里必须同样规范化；
  // 否则 Windows 8.3 短路径（C:\Users\RUNNER~1\...）会与真实路径不匹配，导致重复弹审批。
  const canonicalApprovalTarget = (raw, write, tool) => {
    const abs = path.resolve(String(raw || ''));
    if (!policy) return abs;
    const check = assertPathAllowed(policy, abs, { write, tool });
    return check.ok ? check.path : abs;
  };
  const approvalTarget = (name, args) => {
    if (name === 'edit_file' || name === 'write_file') return canonicalApprovalTarget(args?.path, true, name);
    if (name === 'quality_gate') return canonicalApprovalTarget(args?.dir || projectPath, false, name);
    if (name === 'run_command') {
      const cmd = String(args?.command ?? '');
      return typeof permissions?.commandPrefix === 'function' ? permissions.commandPrefix(cmd) : cmd;
    }
    return String(args?.path ?? '');
  };
  const approvalScope = { sessionId, projectPath };
  const evidenceSince = Date.now();
  const preApproved = (tool, target) => !!permissions?.consumeGrant?.(tool, target, approvalScope);
  const checkedDir = (raw, tool) => policy
    ? assertPathAllowed(policy, path.resolve(String(raw || projectPath || '')), { tool })
    : { ok: true, path: path.resolve(String(raw || projectPath || '')) };

  // 11 维计划解析（App 侧统一入口）：
  //   1) 项目根有 finalcheck.profile.json → 用它（每维档位 + sources）
  //   2) 没有 → 按请求档位合成 11 维同档（DIMENSIONS 的并集与老 GATES 一致，检查计划不变）
  //   3) 工具参数 sources 覆盖文件里的 sources（agent 明确说了「有源码/给 URL/已授权」时以它为准）
  // runtime 只取本轮真的跑过的 probe/stress（最近 2 小时、host 与声明 URL 一致）——声明不等于实测。
  const resolveAuditPlan = async (dir, args = {}) => {
    const { loadProfile, CORE_DIMENSION_NAMES, PROFILE_FILE } = await import(engineUrl('src/profile.mjs'));
    const file = await loadProfile(dir).catch(() => null);
    const tierArg = String(args?.tier || '').toUpperCase();
    const explicitTier = ['L1', 'L2', 'L3'].includes(tierArg) ? tierArg : null;
    const level = explicitTier || 'L2';
    // 项目根有 finalcheck.profile.json → 视为用户已声明档位与维度（不弹提问）
    const hasProfile = !!(file && file.source === PROFILE_FILE);
    const base = hasProfile
      ? file
      : {
        source: 'tier',
        dimensions: Object.fromEntries(CORE_DIMENSION_NAMES.map((n) => [n, level])),
        sources: { code: true },
        warnings: [],
      };
    const rawSources = args?.sources && typeof args.sources === 'object' && !Array.isArray(args.sources) ? args.sources : null;
    // sources.code 在工具参数里是布尔（有源码吗），profile 里要求非空字符串（声明的源码入口）→ 归一成 '.'
    const explicit = rawSources ? { ...rawSources, ...(rawSources.code === true ? { code: '.' } : {}) } : null;
    const profile = explicit ? { ...base, sources: { ...(base.sources || {}), ...explicit } } : base;
    const url = profile?.sources?.url || null;
    const runtime = dynamicRuntime({ sinceMs: evidenceSince, url, ...approvalScope });
    return { profile, runtime, profileSource: base.source, explicitTier, hasProfile };
  };

  const tools = {
    audit_project: async (args) => {
      const gate = checkedDir(args?.dir, 'audit_project');
      if (!gate.ok) return policyDenyResult(gate);
      const dir = gate.path;
      const { profile, runtime, profileSource, explicitTier, hasProfile } = await resolveAuditPlan(dir, args);
      // fail-closed：主 agent 没拿到显式档位、项目里也没有 profile → 不猜，退回让模型先问用户。
      // 返回结构化错误（而非抛异常），模型能直接看到 needAsk/dimensions/levels 去组织提问。
      // 2026-11-19 用户实测：模型自己往参数里填 tier:"L2" 就绕过了这道闸，一句没问直接跑。
      // 主 agent 场景（ipc 传了 userStatedTier）改为看「用户在对话里说没说档位」，模型自填的不算；
      // 本回合已经通过 ask_user 问过也放行。没传 userStatedTier 的调用方（测试 / 旧接口）保持原口径。
      const tierDecided = userStatedTier === null || userStatedTier === undefined
        ? !!explicitTier
        : (userStatedTier || askedThisTurn);
      if (askBeforeAudit && !tierDecided && !hasProfile) {
        const { CORE_DIMENSION_NAMES } = await import(engineUrl('src/profile.mjs'));
        return {
          error: explicitTier
            ? t('用户还没说要按哪个档位验收：你在参数里自己填的 tier 不算。先用 ask_user 问清 L1/L2/L3 与要覆盖的维度，再调用 audit_project')
            : t('先确认档位与维度：请用 ask_user 问清 L1/L2/L3 与要覆盖的维度，再调用 audit_project'),
          needAsk: true,
          dimensions: [...CORE_DIMENSION_NAMES],
          levels: ['L1', 'L2', 'L3']
        };
      }
      const { audit } = await import(engineUrl('src/audit.mjs'));
      const r = await audit(dir, { tier: explicitTier, interactive: true, runTests: false, profile, runtime });
      if (policy?.mode !== 'readonly') recordAudit(dir, r).catch(() => {});
      // 下一步建议写进结果本身（模型对工具结果的服从远高于系统提示；E2E 实测方法论库/工作流 0 次调用）
      let nextSteps = [];
      try {
        const { listTextFiles } = await import(engineUrl('src/walk.mjs'));
        const { hasQualityConfig } = await import(engineUrl('src/checks/quality.mjs'));
        const { files } = await listTextFiles(dir, [], { maxFiles: 8000 });
        const codeFiles = files.filter((f) => /\.(?:[cm]?[jt]sx?|py|go|java|kt|php|rb|rs|cs|vue|svelte|swift|c|cc|cpp|h)$/i.test(f)).length;
        nextSteps = auditNextSteps(r, { dir, codeFiles, hasQualityConfig: await hasQualityConfig(dir) });
      } catch { /* 建议生成失败不影响审计结果 */ }
      return {
        nextSteps,
        verdict: r.conclusion.verdict,
        reason: r.conclusion.reason,
        gates: r.gates,
        // 11 维结论 + 证据矩阵（每维：结论 / 证据等级 / 覆盖的检查项），与报告层同源
        dimensions: r.tier?.dimensions || null,
        evidence: r.evidence || null,
        planSource: profileSource, // finalcheck.profile.json / tier
        measured: { probe: runtime.probe.length, stress: runtime.stress.length },
        findings: r.findings.slice(0, 30),
        warnings: r.warnings,
        findingsTotal: r.findings.length,
        findingsTruncated: r.findings.length > 30,
      };
    },

    // 质量命令闸：按项目根 finalcheck.quality.json 跑 lint / typecheck / test / bench，
    // 执行前一次性授权（和 run_command 同一套审批），避免「体检时偷偷执行项目代码」
    quality_gate: async (args) => {
      const gate = checkedDir(args?.dir, 'quality_gate');
      if (!gate.ok) return policyDenyResult(gate);
      if (policy?.mode === 'readonly') return policyDenyResult({ reason: '只读模式禁止执行质量命令' });
      const { checkQuality, hasQualityConfig, loadQualityConfig, normalizeQualityConfig, QUALITY_FILE } = await import(engineUrl('src/checks/quality.mjs'));
      const dir = gate.path;
      if (!(await hasQualityConfig(dir))) {
        return { error: `项目根没有 ${QUALITY_FILE}：先声明要跑的命令与阈值（checks: [{id,command,maxMs,expect,minPercent}]）` };
      }
      const cfg = await loadQualityConfig(dir);
      const checks = normalizeQualityConfig(cfg);
      if (!checks.length) return { error: `${QUALITY_FILE} 里没有可执行的 checks` };
      if (policy) for (const check of checks) {
        const commandGate = checkCommand(policy, check.command);
        if (!commandGate.ok) return policyDenyResult(commandGate);
      }
      const summary = checks.map((c) => `· ${c.id}: ${c.command}${c.maxMs ? `（≤${c.maxMs}ms）` : ''}`).join('\n');
      if (summary.length + dir.length > 19000) return { error: '质量命令过长，无法完整展示审批内容，请减少单次检查项' };
      const target = `${dir}#${createHash('sha256').update(JSON.stringify(checks)).digest('hex')}`;
      if (!preApproved('quality_gate', target) && !permissions?.sessionAllowed?.('quality_gate', target, approvalScope)) {
        const decision = await permissions?.requestApproval?.({ tool: 'quality_gate', target, summary: `质量命令闸（${dir}）：\n${summary}`, ...approvalScope });
        if (decision !== 'allowed-once' && decision !== 'always-session') return { error: '用户拒绝了质量闸执行' };
      }
      const sandboxQualityRunner = async (command, projectDir, timeoutMs) => {
        // 沙箱默认关闭（见 sandboxEnabled 的注释）；显式 required 时才启用。
        const compat = sandboxCompatible(command);
        if (!compat.compatible && sandboxEnabled({ aclSandbox })) {
          return { code: 1, ms: 0, out: '', err: `沙箱不支持这条质量命令（${compat.reason}）；FINALCHECK_ACL_SANDBOX=on（或 config aclSandbox:true） 已拒绝在宿主机执行`, timedOut: false };
        }
        const sb = !sandboxEnabled({ aclSandbox }) || !compat.compatible ? null : createSandboxedRun({
          workspaceRoot: projectDir,
          policyMode: policy?.mode || 'off',
          command,
          cwd: projectDir,
          sandboxAppRoot: shellAppRoot
        });
        if (!sb && sandboxEnabled({ aclSandbox })) {
          return { code: 1, ms: 0, out: '', err: '沙箱不可用；FINALCHECK_ACL_SANDBOX=on（或 config aclSandbox:true） 已拒绝在宿主机执行', timedOut: false };
        }
        const t0 = Date.now();
        const run = await runCommandWithSignal(String(command), {
          cwd: projectDir,
          timeoutMs,
          sandbox: sb
        });
        return {
          code: run.code == null ? 1 : run.code,
          ms: Date.now() - t0,
          out: run.stdout || '',
          err: run.stderr || '',
          timedOut: run.code === 124
        };
      };
      const r = await checkQuality(dir, {
        tier: args?.tier || 'L2',
        run: true,
        repeat: args?.repeat,
        config: cfg,
        runner: sandboxQualityRunner
      });
      const qualitySandbox = policy?.mode === 'off' || !sandboxAvailability().available
        ? (policy?.mode === 'off' ? 'none' : 'unavailable')
        : 'per-command';
      return { dir, runs: r.runs, findings: r.findings.slice(0, 30), warnings: r.warnings, coverageGap: r.coverageGap, sandbox: qualitySandbox };
    },

    // 只读 git 改动审查：路径走策略边界；不弹审批（不执行、不写盘）
    review_diff: async (args) => {
      const rawDir = String(args?.dir || projectPath || '').trim();
      if (!rawDir) return { error: '缺少 dir（项目绝对路径）' };
      let dir = path.resolve(rawDir);
      if (policy) {
        const check = assertPathAllowed(policy, dir, { write: false, tool: 'review_diff' });
        if (!check.ok) return policyDenyResult(check);
        dir = check.path;
      }
      const { reviewDiff } = await import(engineUrl('src/review-diff.mjs'));
      return reviewDiff(dir, { base: args?.base });
    },

    download_gate: async (args) => {
      const gate = checkedDir(args?.dir, 'download_gate');
      if (!gate.ok) return policyDenyResult(gate);
      const { scanDownload } = await import(engineUrl('src/download-gate.mjs'));
      return scanDownload(gate.path, { excludes: [] });
    },

    probe_target: async (args) => {
      // 执行前授权闸：localhost 直放；已确认 host 直放；外部 host 必须过审批卡
      if (typeof permissions?.ensureHostAuthorized === 'function') {
        const auth = await permissions.ensureHostAuthorized(args?.url, {
          approvalFn: permissions?.requestApproval,
          scope: approvalScope,
          tool: 'probe_target'
        });
        if (!auth.ok) return { error: auth.error, deniedBy: 'policy' };
      }
      note(args.url); // 记账：证据等级要能区分「声明了授权」和「本轮真的跑过」
      const { probeTarget } = await import(engineUrl('src/dynamic/probe.mjs'));
      const t0 = Date.now();
      const out = await probeTarget(args.url, { requests: args?.requests });
      try { recordProbe(args.url, { ...approvalScope, ms: Date.now() - t0, ok: Number(out?.samples) > 0, samples: Number(out?.samples) || 0 }); } catch { /* 记账失败不影响探测 */ }
      return out;
    },

    stress_target: async (args) => {
      if (typeof permissions?.ensureHostAuthorized === 'function') {
        const auth = await permissions.ensureHostAuthorized(args?.url, {
          approvalFn: permissions?.requestApproval,
          scope: approvalScope,
          tool: 'stress_target'
        });
        if (!auth.ok) return { error: auth.error, deniedBy: 'policy' };
      }
      note(args.url);
      if ((args.duration ?? 10) > 60 || (args.connections ?? 10) > 50) throw new Error('超过温和上限');
      const { stressTarget } = await import(engineUrl('src/dynamic/stress.mjs'));
      const t0 = Date.now();
      const out = await stressTarget(args.url, { duration: args.duration ?? 10, connections: args.connections ?? 10 });
      try { recordStress(args.url, { ...approvalScope, ms: Date.now() - t0, ok: Number(out?.samples) > 0 && !out?.errors, samples: Number(out?.samples) || 0 }); } catch { /* 记账失败不影响压测 */ }
      return out;
    },

    get_report: async (args) => {
      const gate = checkedDir(args?.dir, 'get_report');
      if (!gate.ok) return policyDenyResult(gate);
      const { renderReport } = await import(engineUrl('src/report.mjs'));
      const { audit } = await import(engineUrl('src/audit.mjs'));
      const dir = gate.path;
      const { profile, runtime } = await resolveAuditPlan(dir, args);
      const r = await audit(dir, { tier: args.tier ?? null, interactive: true, runTests: false, profile, runtime });
      if (policy?.mode !== 'readonly') recordAudit(dir, r).catch(() => {});
      return renderReport(r);
    },

    list_playbooks: async () => {
      const catalog = await loadSkills({ projectDir: projectPath });
      return { total: catalog.length, categories: catalogSummary(catalog) };
    },

    read_playbook: async (args) => readPlaybook({
      topic: args?.topic,
      file: args?.file,
      offset: args?.offset,
      limit: args?.limit,
      root: playbookRoot,
      // 三级合并目录：内置 + 用户级 + 项目级（project > user > builtin），条目自带 __root
      catalog: await loadSkills({ projectDir: projectPath })
    }),

    // 修复回路（③）：回滚到 edit/write 前的快照（主 agent 专属；快照由 fs-tools 写盘前自动留）
    repair_rollback: async (args) => {
      let a = args || {};
      if (!a.path || typeof a.path !== 'string') return { error: 'path 必填' };
      if (policy) {
        const check = assertPathAllowed(policy, a.path, { write: true, tool: 'repair_rollback' });
        if (!check.ok) return policyDenyResult(check);
        // 和 edit_file / write_file 留快照时同一个真实路径：模型给的写法（8.3 短文件名、目录联接）不同也能找到快照
        a = { ...a, path: check.path };
      }
      const { rollbackFile, listSnapshots } = await import('../../../src/repair-loop.mjs');
      if (a.list) return { snapshots: await listSnapshots(path.resolve(a.path)) };
      return rollbackFile(a.path, a.snapshotId || null);
    },

    read_file: async (args) => {
      let a = args || {};
      if (policy) {
        const check = assertPathAllowed(policy, a.path, { write: false, tool: 'read_file' });
        if (!check.ok) return policyDenyResult(check);
        a = { ...a, path: check.path };
      }
      return readFileTool({ path: a?.path, offset: a?.offset, limit: a?.limit });
    },

    // 专用代码搜索：只读工具，与 read_file 同级（不进 APPROVAL_TOOLS、不弹审批）。
    // ripgrep 优先（捆绑路径 → PATH），找不到 rg 自动回退 findstr 字面量，不报错。
    // 路径闸与 read_file 同一道 assertPathAllowed；默认 repoRoot（搜本应用源码），搜用户项目显式传 path。
    grep_code: async (args) => {
      const pattern = args?.pattern == null ? '' : String(args.pattern);
      if (!pattern.trim()) return { error: 'pattern 必填：要搜的关键词/函数名/报错文本' };
      const max = Math.max(1, Math.min(500, Math.floor(Number(args?.maxResults) || GREP_DEFAULT_MAX_RESULTS)));
      const glob = String(args?.glob || '').trim();
      let target = path.resolve(String(args?.path || '').trim() || repoRoot);
      if (policy) {
        const check = assertPathAllowed(policy, target, { write: false, tool: 'grep_code' });
        if (!check.ok) return policyDenyResult(check);
        target = check.path;
      }
      const rg = resolveRipgrepPath({ repoRoot });
      if (rg) {
        // 模式参数原样传 rg（-- 分隔符防 pattern 以 - 开头被当 flag）；argv 数组直传不经 shell
        // -H（--with-filename）必须带：rg 搜**单个文件**时默认不输出文件名，行变成
        // `12:text`，parseGrepRow 解析不出 → 命中全被丢掉，模型看到「0 处命中」（2026-11-17 修复）。
        const argv = ['-n', '-H', '--no-heading', '--max-count', String(max)];
        if (glob) argv.push('-g', glob);
        argv.push('--', pattern, target);
        const r = await spawnCapture(rg, argv);
        if (r.spawnFailed) {
          // 检测到的 rg 启动失败（坏二进制/权限）：按「找不到 rg」处理，回退 findstr 不报错
          return grepCodeFindstr({ target, glob, pattern, max });
        }
        if (r.code !== 0 && r.code !== 1) {
          // rg 退出码 2 = 用法/正则错误：语义不同，不静默降级成 findstr 字面量
          return { error: `ripgrep 退出码 ${r.code}：${(r.stderr || '未知错误').slice(0, 500)}`, engine: 'ripgrep', pattern, path: target };
        }
        const rows = r.stdout.split(/\r?\n/).filter(Boolean).map(parseGrepRow).filter(Boolean)
          .map((m) => ({ ...m, file: path.resolve(target, m.file) }));
        return finishGrepResult(rows, { max, target, glob, pattern, engine: 'ripgrep', truncatedOut: !!r.outTruncated });
      }
      if (process.platform === 'win32') return grepCodeFindstr({ target, glob, pattern, max });
      return { error: '未找到 ripgrep（rg）：当前平台没有 findstr 兜底，请安装 ripgrep 后重试', pattern, path: target };
    },

    edit_file: async (args) => {
      let a = args || {};
      if (policy) {
        const check = assertPathAllowed(policy, a.path, { write: true, tool: 'edit_file' });
        if (!check.ok) return policyDenyResult(check);
        a = { ...a, path: check.path };
        // 2026-11-17（规格 §3.3）：文件名合法性。D:inalcheck 里出现过名叫
        // `ids.indexOf(v)!` 的 0 字节文件——模型把代码片段当 path 传进来的结果。
        const nameCheck = checkFileName(a.path);
        if (!nameCheck.ok) return policyDenyResult(nameCheck);
      }
      const abs = path.resolve(String(a?.path || ''));
      if (!preApproved('edit_file', abs) && !permissions?.sessionAllowed?.('edit_file', abs, approvalScope)) {
        const decision = await permissions?.requestApproval?.({ tool: 'edit_file', summary: abs, ...approvalScope });
        if (decision !== 'allowed-once' && decision !== 'always-session') return { error: '用户拒绝了本次文件修改' };
      }
      return editFileTool(a);
    },

    write_file: async (args) => {
      let a = args || {};
      if (policy) {
        const check = assertPathAllowed(policy, a.path, { write: true, tool: 'write_file' });
        if (!check.ok) return policyDenyResult(check);
        a = { ...a, path: check.path };
        const nameCheck = checkFileName(a.path);
        if (!nameCheck.ok) return policyDenyResult(nameCheck);
      }
      const abs = path.resolve(String(a?.path || ''));
      if (!preApproved('write_file', abs) && !permissions?.sessionAllowed?.('write_file', abs, approvalScope)) {
        const decision = await permissions?.requestApproval?.({ tool: 'write_file', summary: abs, ...approvalScope });
        if (decision !== 'allowed-once' && decision !== 'always-session') return { error: '用户拒绝了本次文件写入' };
      }
      return writeFileTool(a);
    },

    present_artifact: async (args) => {
      // 唯一没做路径校验的文件类工具（lane A 实测：可把 config.json / ~/.ssh/id_rsa 登记成产物，
      // 用户点开就经 artifact:read 读出来）→ 与读文件工具同一道敏感路径闸
      const gate = assertArtifactPath(args?.path, { policy });
      if (!gate.ok) return { error: gate.reason, path: gate.path };
      const abs = gate.path;
      let st;
      try { st = await stat(abs); } catch { return { error: '文件不存在：' + abs }; }
      if (!st.isFile()) return { error: '不是文件' };
      const ext = path.extname(abs).toLowerCase();
      if (!PREVIEW_EXTS.has(ext)) return { error: '不支持预览的类型：' + ext };
      return { path: abs, name: path.basename(abs), title: String(args?.title || path.basename(abs)).slice(0, 120), size: st.size };
    },

    // ---- AI 的眼睛（2026-11-18）：看图 / 截图。图片经 __images 带出，由 agent-service 作为多模态消息发给模型 ----
    view_image: async (args) => {
      const list = (Array.isArray(args?.paths) ? args.paths : [args?.path]).filter(Boolean).slice(0, 4);
      if (!list.length) return { error: '缺少 path（要看的图片绝对路径；最多 4 张可用 paths 数组）' };
      const { loadImageForModel } = await import('./capture.mjs');
      const images = [];
      const meta = [];
      for (const p of list) {
        const gate = assertArtifactPath(p, { policy });
        if (!gate.ok) return { error: gate.reason, path: gate.path };
        const ext = path.extname(gate.path).toLowerCase();
        if (ext === '.svg') return { error: 'SVG 是矢量文本：用 capture_screenshot(target=该 svg 路径) 渲染成图再看' };
        try {
          const im = await loadImageForModel(gate.path);
          images.push({ mime: im.mime, base64: im.buf.toString('base64'), label: path.basename(gate.path) });
          meta.push({ path: gate.path, width: im.width, height: im.height, ...(im.original && im.original.width !== im.width ? { scaledFrom: im.original } : {}) });
        } catch (e) {
          return { error: `读不了图片 ${gate.path}：${e.message}` };
        }
      }
      return { ok: true, images: meta, note: '图片已附在下一条消息里，请直接看图下结论', __images: images };
    },

    capture_screenshot: async (args) => {
      const target = String(args?.target || args?.path || args?.url || '').trim();
      if (!target) return { error: '缺少 target：本地文件路径（html/svg/pdf/pptx/docx/mp4/图片）或 http(s) 网址' };
      const cap = await import('./capture.mjs');
      const headless = await import('./capture-headless.mjs');
      // 可用性判定（2026-11-20 改）：以前只认 Electron 主进程，纯 Node（sim / CLI / CI）下模型被告知
      // 「截图只在桌面端可用」→ 它在盲写 UI，页面 JS 崩了、无障碍文本没隐藏都看不见。
      // 现在桌面端用 BrowserWindow，其余环境自动起一个独立渲染子进程（electron 二进制 / 系统 Chrome）。
      const desktopOk = await cap.captureAvailable();
      if (!desktopOk) {
        const hn = await headless.probeCaptureBackend();
        if (!hn.ok) return { error: await headless.captureUnavailableReason() };
      }
      const width = Math.max(320, Math.min(2400, Number(args?.width) || 1280));
      const height = Math.max(240, Math.min(4000, Number(args?.height) || 800));
      // 截图存进项目的 .finalcheck/captures（%APPDATA%\FinalCheck 下的 spill 目录会被产物闸拒绝，用户点不开）
      const outDir = projectPath ? path.join(projectPath, '.finalcheck', 'captures') : path.join(os.tmpdir(), 'fc-captures');
      const captureWeb = async (target2, opts) => {
        // 桌面端优先（隐藏 BrowserWindow，快且能等 fullPage）；否则起独立渲染子进程
        if (desktopOk) return cap.captureUrl(target2, opts);
        return headless.captureBySubprocess(target2, { width: opts.width, height: opts.height, waitMs: opts.waitMs, outDir: opts.outDir });
      };
      let shot;
      let what;
      try {
        if (/^https?:\/\//i.test(target)) {
          shot = await captureWeb(target, { width, height, waitMs: Number(args?.wait_ms) || 1200, fullPage: !!args?.full_page, outDir });
          what = target;
        } else {
          const gate = assertArtifactPath(target, { policy });
          if (!gate.ok) return { error: gate.reason, path: gate.path };
          const abs = gate.path;
          const ext = path.extname(abs).toLowerCase();
          const { OFFICE_EXTS, VIDEO_EXTS, officeToPdf } = await import('./preview-convert.mjs');
          const { allowPreviewFile } = await import('./preview-allow.mjs');
          if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
            return tools.view_image({ path: abs });
          } else if (['.html', '.htm', '.svg'].includes(ext)) {
            shot = await captureWeb(abs, { width, height, waitMs: Number(args?.wait_ms) || 800, fullPage: !!args?.full_page, outDir });
            what = path.basename(abs);
          } else if (ext === '.pdf' || OFFICE_EXTS.has(ext)) {
            if (!desktopOk) return { error: '截 PDF / PPT / Word 需要 FinalCheck 桌面端（无界面模式没有 pdf.js 渲染层）。网页和 html/svg 截图可用，图片可以用 view_image 直接看' };
            let pdf = abs;
            if (ext !== '.pdf') {
              const cacheDir = path.join(path.dirname(process.env.FINALCHECK_CONFIG_FILE || path.join(os.tmpdir(), 'x')), 'preview-cache');
              const r = await officeToPdf(abs, { cacheDir });
              if (!r.ok) return { error: r.reason === 'no-libreoffice' ? '截 PPT/Word 需要本机安装 LibreOffice（免费）；也可以先导出成 PDF 再截' : `转换失败：${r.reason}` };
              pdf = r.pdfPath;
            }
            shot = await cap.captureSnapshot({ kind: 'pdf', pdfPath: allowPreviewFile(pdf), page: String(Number(args?.page) || 1), width: String(width) }, { outDir });
            const [n, total] = String(shot.info).split('/');
            what = `${path.basename(abs)} 第 ${n}/${total} 页`;
          } else if (VIDEO_EXTS.has(ext)) {
            const url = `fc-media://local/${encodeURIComponent(abs)}`;
            shot = await cap.captureSnapshot({ kind: 'video', url, time: String(Number(args?.time) || 0), width: String(width) }, { outDir });
            const [t0, dur] = String(shot.info).split('/');
            what = `${path.basename(abs)} @ ${t0}s / 共 ${dur}s`;
          } else {
            return { error: `不支持截图的类型：${ext}（支持 html/svg/pdf/pptx/docx/mp4/webm/mov/图片 与 http(s) 网址）` };
          }
        }
      } catch (e) {
        return { error: `截图失败：${e.message}` };
      }
      return {
        ok: true, path: shot.file, title: `截图：${what}`, width: shot.width, height: shot.height,
        note: '截图已附在下一条消息里，请直接看图检查（文字溢出/重叠、对齐、配色、内容是否正确）',
        __images: [{ mime: shot.mime, base64: shot.buf.toString('base64'), label: what }],
      };
    },

    remember_project: async (args) => {
      // 2026-11-17 决策 2：记忆跟**目录**走，不跟会话走。
      // 你在这个项目里顺手改了另一个项目的代码时，那条记忆应该写进**被改的那个项目**，
      // 否则下次审那个项目时它看不到，而当前项目的记忆里多了一条无关内容。
      // args.dir 可选：不传 = 当前会话绑定的项目（旧行为不变）。
      const targetDir = String(args?.dir || '').trim() || projectPath || '';
      if (!targetDir) return { error: '缺少目标目录：请传 dir（要记住的那个项目根）或先绑定项目' };
      const resolvedDir = path.resolve(targetDir);
      if (policy) {
        const check = assertPathAllowed(policy, path.join(resolvedDir, 'AGENTS.md'), { write: true, tool: 'remember_project' });
        if (!check.ok) return policyDenyResult(check);
      }
      const { rememberProject } = await import('./project-memory.mjs');
      try {
        const r = await rememberProject(resolvedDir, args?.fact, { kind: args?.kind, replace: args?.replace });
        return { ...r, dir: resolvedDir };
      } catch (e) {
        return { error: e.message };
      }
    },

    run_workflow: async (args) => {
      if (typeof runWorkflow !== 'function') return { error: '当前通道不支持工作流（需要在桌面端运行）' };
      // 确定性兜底：模型没给 steps 也没给 script 时，不退化成「steps 不能为空」，
      // 而是把「先判断任务形状再选表示」的判定口径原样回给模型，让它带着参数重试。
      // 0.26 统一写法：nodes（一张流程图，depends_on 决定先后，互不依赖的一起跑）。
      // 编译后交给原引擎：全是普通节点 → DAG 引擎；含扇出/闸/循环等 → DSL 引擎按依赖图并行。
      const rawNodes = args?.nodes;
      const hasNodes = rawNodes != null && !(Array.isArray(rawNodes) && rawNodes.length === 0) && !(typeof rawNodes === 'string' && !rawNodes.trim());
      if (hasNodes) {
        const { compileNodes } = await import('./workflow-nodes.mjs');
        const c = compileNodes(rawNodes);
        if ('error' in c) return { error: t('工作流节点有问题：{error}。改好 nodes 后重新调用 run_workflow。', { error: c.error }) };
        const payload = c.mode === 'steps'
          ? { goal: args?.goal, steps: c.steps }
          : { goal: args?.goal, script: c.script, dag: c.dag };
        if (args?.concurrency != null) payload.concurrency = args.concurrency;
        const r = await runWorkflow(payload);
        if (!r || r.error || !Array.isArray(r.results)) return r;
        const per = Math.max(800, Math.min(3000, Math.floor(14000 / Math.max(1, r.results.length))));
        return {
          ...r,
          results: r.results.map((x) => ({
            ...x,
            content: String(x.content || '').slice(0, per),
            ...(String(x.content || '').length > per ? { contentTruncated: true } : {})
          }))
        };
      }
      // 旧写法（steps / script）照常可用：老会话、老提示词里写的都还能跑
      const filledSteps = Array.isArray(args?.steps) && args.steps.length > 0;
      const rawScript = args?.script;
      const hasScript = rawScript != null
        && !(Array.isArray(rawScript) && rawScript.length === 0)
        && !(typeof rawScript === 'string' && !rawScript.trim());
      if (!filledSteps && !hasScript) {
        return {
          error: t('没有给 nodes。用 nodes 画一张流程图再调用 run_workflow：每个节点 {id, name, prompt, depends_on}，互不依赖的写 depends_on: [] 会一起跑；要按上游清单分身用 type:"fanout"（over 写上游节点 id）。')
        };
      }
      // steps / script 互斥透传：以前这里把 steps 强制成 [] 并丢掉 script，导致 script 模式永远走 steps 分支
      const payload = { goal: args?.goal };
      if (filledSteps) {
        payload.steps = args.steps;
      } else if (args?.script != null) {
        let script = args.script;
        if (typeof script === 'string') {
          try { script = JSON.parse(script); } catch { return { error: 'script 必须是数组：JSON 解析失败' }; }
        }
        if (!Array.isArray(script)) return { error: 'script 必须是数组（受限脚本指令列表）' };
        payload.script = script;
      }
      const r = await runWorkflow(payload);
      // 子代理产出可能很长：压到 14k 内联回给主 agent（否则会被「头+尾」截断，后面几步的结果主 agent 根本看不到）
      if (!r || r.error || !Array.isArray(r.results)) return r;
      const per = Math.max(800, Math.min(3000, Math.floor(14000 / Math.max(1, r.results.length))));
      return {
        ...r,
        results: r.results.map((x) => ({
          ...x,
          content: String(x.content || '').slice(0, per),
          ...(String(x.content || '').length > per ? { contentTruncated: true } : {})
        }))
      };
    },

    run_command: async (args, ctx) => {
      // 每次执行前审批（deepseek-harness 语义）：会话内已 always-session 同一命令前缀的免批；
      // rejected/超时/非法值 → denied，给人话错误。灾难命令拦截仍在 shell.mjs 兜底。
      // signal（可选）：由 agent-service 经工具 ctx 注入，用户点「停止」后 1s 内真正杀掉命令进程树。
      const toolSignal = ctx?.signal || signal || null;
      const cmd = String(args?.command ?? '');
      if (toolSignal?.aborted) return CANCELLED_RESULT();
      let runCwd = args?.cwd;
      if (policy) {
        // 第 1+2 层（决策 3，2026-11-16）：命令正文里的字面路径——敏感路径无条件拒绝，
        // 项目外路径整条拒绝。必须在最前：早先只验 cwd，命令里写 `type C:\Users\x\.ssh\key`
        // 或 `cd /d D:\other && type config.json` 都能过。
        const pathsCheck = checkCommandPaths(policy, cmd, runCwd);
        if (!pathsCheck.ok) return policyDenyResult(pathsCheck);
        // 第 3 层：cwd 走路径边界检查（未传时默认落到项目根）
        const cwdCheck = assertCwd(policy, runCwd);
        if (!cwdCheck.ok) return policyDenyResult(cwdCheck);
        if (cwdCheck.path) runCwd = cwdCheck.path;
        const cmdCheck = checkCommand(policy, cmd);
        if (!cmdCheck.ok) return policyDenyResult(cmdCheck);
        // 沙箱的 WRITE_RESTRICTED 令牌不过滤 DELETE（实测 del 能删项目外文件），这条在应用层兜。
        const deleteCheck = checkDestructiveTargets(policy, cmd, runCwd);
        if (!deleteCheck.ok) return policyDenyResult(deleteCheck);
      }
      // 读源码 / 搜代码改道到 read_file / grep_code（工具描述早就写了「违反会被应用层拒绝」，这里才真正落实）。
      // 放在路径闸之后：越界/敏感路径必须先按安全原因拒绝，而不是被说成「换个工具就行」
      const reroute = shellReadRedirect(cmd);
      if (reroute) return { error: reroute.message, redirect: reroute.kind === 'read' ? 'read_file' : 'grep_code' };
      // 审批参数模式：单段命令看前两个 token；含 && || | ; & 换行的复合命令看整条，
      // 避免「本会话允许 git status」把 `git status && curl … | sh` 一起放行。
      const pattern = typeof permissions?.approvalPatternFor === 'function'
        ? permissions.approvalPatternFor(cmd)
        : (typeof permissions?.commandPrefix === 'function' ? permissions.commandPrefix(cmd) : cmd);
      if (!preApproved('run_command', pattern) && !permissions?.sessionAllowed?.('run_command', pattern, approvalScope)) {
        if (toolSignal?.aborted) return CANCELLED_RESULT();
        const decision = await permissions?.requestApproval?.({ tool: 'run_command', summary: cmd.slice(0, 300), target: pattern, ...approvalScope });
        if (toolSignal?.aborted) return CANCELLED_RESULT(); // 审批期间被停止：命令不执行
        if (decision !== 'allowed-once' && decision !== 'always-session') {
          return { error: '用户拒绝了本次命令执行' };
        }
      }
      // 子进程只拿脱敏后的环境变量快照：密钥类变量按名字剥除（removed 只记名字，不记值）
      const { env } = scrubEnv(process.env);
      // background:true = 起常驻服务后立刻返回（不让父命令等子进程退出）；
      // 其余命令走空闲输出看门狗：连续 idle 毫秒无输出才转后台，长任务只要还在输出就不设上限。
      // 0.29.3：模拟键鼠/前台类命令纳入 CU 权限——否则一条 run_command 就能绕过 computer_* 的
      // 三层防线（tier/授权/前台复核；基准 r5/r6 实测会话用它自写注入脚本绕空了安全层，还把
      // 微信搞锁死）。AttachThreadInput/SetWindowsHookEx 无条件拒绝：输入队列纠缠会把目标
      // 应用锁到无法点击。误伤防护：仅在命令处于「编译/执行」上下文（Add-Type/csc/powershell/
      // python/ctypes/rundll32/cscript）且注入关键词同时出现时拦截——纯 grep/检索这些词不拦。
      // 0.29.7：关键词可能不在命令行而在被引用的脚本文件里（真机实证：powershell -File
      // final_send.ps1，命令行干净、文件里全是 SendInput）。命令行命中编译/执行上下文时，把
      // -File/-f 引用的本地脚本与内联 heredoc 正文一并纳入同一对判定；文件读不到 → 放行（保持现状）。
      const INJECTION_KEYWORDS = /keybd_event|SendInput|mouse_event|SetForegroundWindow|AttachThreadInput|SetWindowsHookEx|System\.Windows\.Forms\.SendKeys|SetCursorPos/i;
      // 0.30.0（追加项 5，用户拍板）：窗口状态变更组 = **无条件拒绝**（不看 CU 授权）。
      // 它要解决的是「模型反复写 .ps1 刷屏做窗口激活/置顶」的绕路（真实会话日志：write_file .tmp_*.ps1
      // → powershell -File → taskkill 循环），授权放行等于给一条绕过口。只禁「改变窗口状态」的调用；
      // 只读诊断（GetWindowText/EnumWindows/GetWindowRect/GetWindowLong/Get-Process/IsWindowVisible）
      // 一律放行——排查窗口问题必须还能用 run_command。
      const WINDOW_STATE_KEYWORDS = /SetWindowPos|ShowWindow|AppActivate|SwitchToThisWindow|SetWindowPlacement|MoveWindow|SetForegroundWindow/i;
      const INJECTION_COMPILER = /Add-Type|csc(\.exe)?[\s"']|cscript(\.exe)?[\s"']|powershell|pwsh|python\s|ctypes|rundll32/i;
      const injected = collectInjectedScriptBodies(cmd, runCwd);
      const injectionPayload = [cmd, ...injected.bodies].join('\n');
      const windowStateHit = INJECTION_COMPILER.test(cmd) && WINDOW_STATE_KEYWORDS.test(injectionPayload)
        ? (injectionPayload.match(WINDOW_STATE_KEYWORDS) || [])[0]
        : null;
      if (windowStateHit) {
        return {
          error: `命令在改变窗口状态（命中 ${windowStateHit}）。窗口激活/置顶/移动/查找必须用 computer_* 工具：computer_action focus（传 hwnd）激活窗口，computer_screenshot target:"window" 找窗口（可传 window_title/hwnd），点进窗口内部用 computer_action click。run_command + 脚本路不允许做窗口操作——真实会话里写 .ps1 反复刷新窗口把界面卡到一顿一顿、几十轮都没完成一次窗口切换；有 CU 授权也一样拒绝。只读诊断（GetWindowText/EnumWindows/GetWindowRect/Get-Process）不受此限。`,
          deniedBy: 'policy',
          redirect: 'computer_focus_or_window_screenshot'
        };
      }
      if (INJECTION_COMPILER.test(cmd) && INJECTION_KEYWORDS.test(injectionPayload)) {
        if (/AttachThreadInput|SetWindowsHookEx/i.test(injectionPayload)) {
          return { error: '命令包含 AttachThreadInput / SetWindowsHookEx——会把目标应用的输入队列与脚本线程纠缠（实测曾把微信锁死到无法点击），无条件拒绝。键鼠注入请走 computer_* 工具。', deniedBy: 'policy' };
        }
        let injectionGranted = [];
        if (typeof getDesktopToolsAsync === 'function') {
          try { injectionGranted = (await getDesktopToolsAsync())?.computerUse?.grantedApps?.() ?? []; } catch { /* ignore */ }
        }
        if (!injectionGranted.length) {
          return { error: '命令在模拟键鼠/前台操作（keybd_event/SendInput/SetForegroundWindow 等）。这会绕过桌面操作的三层安全防线——必须先 computer_request_access 获得桌面操作授权（CU 会话内放行），或改用 computer_* 工具。', deniedBy: 'policy' };
        }
      }
      const idleMs = args?.idle_ms ?? args?.idleMs ?? commandIdleMs ?? DEFAULT_COMMAND_IDLE_MS;
      // 0.30.4：窗口探测配额——computer_screenshot target:"window" 已返回 hwnd/rect，
      // 再单独 Get-Process/tasklist/Add-Type 查窗口是纯浪费（真机实测一轮跑了 21 次 run_command）。
      if (isProbeCommand(cmd)) {
        const probeVerdict = checkProbeBudget({ used: cuWorkflowUsed, budget: cuWorkflowBudget, command: cmd });
        if (!probeVerdict.allowed) {
          return { error: probeVerdict.error, deniedBy: probeVerdict.deniedBy, hint: probeVerdict.hint };
        }
        cuWorkflowUsed.probes += 1;
      }
      const sandboxMode = policy?.mode || 'off';
      // 沙箱默认关闭（2026-11-17 决策，理由见 sandboxEnabled 注释）：
      // 命令统一走宿主机 Git Bash，一种 shell、一套语法。
      const sandboxOn = sandboxEnabled({ aclSandbox });
      const compat = sandboxCompatible(cmd);
      const sandbox = !sandboxOn || !compat.compatible ? null : createSandboxedRun({
        workspaceRoot: projectPath || runCwd,
        policyMode: sandboxMode,
        command: cmd,
        cwd: runCwd,
        sandboxAppRoot: shellAppRoot
      });
      if (!sandbox && sandboxOn) {
        return {
          error: !compat.compatible
            ? `沙箱不支持这条命令（${compat.reason}）；FINALCHECK_ACL_SANDBOX=on（或 config aclSandbox:true） 已拒绝在宿主机执行`
            : `沙箱不可用（${sandboxAvailability().error || '平台不支持'}），FINALCHECK_ACL_SANDBOX=on（或 config aclSandbox:true） 已拒绝在宿主机执行`,
          deniedBy: 'policy'
        };
      }
      const result = await runCommandWithSignal(cmd, {
        cwd: runCwd,
        timeoutMs: args?.timeout_ms,
        idleMs,
        background: args?.background === true,
        env,
        signal: toolSignal,
        sandbox,
        shellAppRoot,
        onActivity
      });
      // Do not retry with DETACHED_PROCESS or a visible console. A failed
      // restricted child stays a failure instead of opening a window or rerunning
      // a command after cancellation/timeout.
      if (sandbox && isDllInitFailure(result)) {
        result.sandboxFailure = 'dll-init';
        result.stderr = `[沙箱受限进程初始化失败；已停止，未切换到可见控制台]\n${result.stderr || ''}`;
      }
      // 只有「用户显式要求沙箱」时才提示跳过/不可用（默认关闭时不打扰，也不冒充有保护）
      if (sandboxOn && sandboxMode !== 'off' && !sandbox) {
        if (!compat.compatible) result.sandboxSkip = compat.reason;
        else result.sandboxWarning = `写/删沙箱不可用（${sandboxAvailability().error || '平台不支持'}）；本条命令在宿主机执行`;
      }
      return result;
    }
  };

  // ---- 桌面操作 + 浏览器操作（2026-11-21）：只给主 agent（子代理没有这两个模块的引用）----
  // 桌面操作的每一步都要过 tier/授权闸（在 computer-use.mjs 里），这里只做参数整理与结果包装。
  //
  // 为什么 handler 无条件注册、内部 await 懒加载：
  //   AGENT_TOOLS_SCHEMA 是静态常量，模型**始终**能看到这 11 个工具的名字和描述。
  //   如果这里因为「模块还没加载完」就不注册 handler，模型第一轮调用会撞「unknown tool」，
  //   而第一轮恰恰是最常见的场景（用户说「帮我操作 Word」）。
  //   所以：工具表里有 = 一定能调，加载失败时 handler 返回可读原因。
  if (getDesktopToolsAsync) {
    const withDesktopTool = (key, handler) => async (args, ctx) => {
      let dt;
      try { dt = await getDesktopToolsAsync(); } catch { /* 模块加载失败 */ }
      const engine = dt?.[key];
      if (!engine) {
        return {
          error: '桌面操作/浏览器操作在当前环境不可用（需要 FinalCheck 桌面端；'
            + '测试台与纯 Node 环境没有 Electron 的 desktopCapturer / BrowserWindow）'
        };
      }
      return handler(engine, args, ctx);
    };

    // 0.31.1 混用闸：真 Edge（CDP）已连上时，禁止再用 computer_* 去动那个浏览器窗口。
    // 真机实测（2026-11-23）：模型为了给隔离 Edge 聚焦，调了 computer_request_access +
    // computer_screenshot + CU focus，绕 5 步还把窗口抢到前台。CDP 本身能截图能点击且不抢前台。
    // 判据＝前台窗口 pid 与 CDP 里的浏览器进程 id 一致（只拦我们自己那套隔离 Edge，不误伤别的应用）。
    const blockedByRealEdge = async (label) => {
      const real = await (async () => {
        if (typeof getBrowserRealAsync !== 'function') return null;
        try { return await getBrowserRealAsync(); } catch { return null; }
      })();
      if (!real?.realIsConnected?.()) return null;
      let pid = 0;
      try { pid = Number(real.realInfo?.()?.pid) || 0; } catch { pid = 0; }
      let fg = null;
      try { fg = await engineForegroundPid(); } catch { fg = null; }
      if (!fg) return null;
      const verdict = realEdgeRedirect({ foreground: fg, realPid: pid, realConnected: true });
      if (!verdict) return null;
      return { ...verdict, error: verdict.error.replace('{label}', String(label || '')) };
    };
    const engineForegroundPid = async () => {
      let dt;
      try { dt = await getDesktopToolsAsync(); } catch { return null; }
      const cu = dt?.computerUse;
      if (!cu?.foregroundContext) return null;
      try {
        const fg = await cu.foregroundContext();
        return fg?.ok ? { pid: fg.pid, process: fg.process, hwnd: fg.hwnd, title: fg.title } : null;
      } catch { return null; }
    };

    const captureComputerScreenshot = async (computerUse, args) => {
      // 0.31.1：真 Edge 已连接 → 不许用 CU 截图，redirect 到 browser_screenshot
      const redirect = await blockedByRealEdge('computer_screenshot');
      if (redirect) return redirect;
      // 0.30.4 工作流硬配额（引擎侧，不靠提示词）：真机实证改提示词后模型仍会先拍全屏、
      // 反复 region 逐字验尸。按「效率优先」原则在工具层拒绝浪费型用法，并给出替代动作。
      const kind = args?.region != null ? 'region' : (args?.target === 'window' ? 'window' : 'screen');
      const verdict = checkScreenshotBudget({ kind, used: cuWorkflowUsed, budget: cuWorkflowBudget, reason: args?.reason });
      if (!verdict.allowed) {
        return { ok: false, error: verdict.error, deniedBy: verdict.deniedBy, hint: verdict.hint };
      }
      // region/hwnd 只在传了的时候才进 options：不带参数的调用保持与 0.29.3 一致的转发形状。
      const options = {
        target: args?.target === 'window' ? 'window' : 'screen',
        windowTitle: String(args?.window_title || '')
      };
      if (args?.region != null) options.region = args.region;
      if (args?.hwnd != null) options.hwnd = args.hwnd;
      const r = await computerUse.captureScreen(options);
      if (!r.ok) return { ...r, error: r.error || '截图失败' };
      // 配额只在成功截图后计数（失败不占额度，允许重试）
      if (kind === 'region') cuWorkflowUsed.regions += 1;
      else if (kind === 'screen') cuWorkflowUsed.screenShots += 1;
      const fg = r.foreground
        ? `当前前台：${r.foreground.process}「${r.foreground.title}」· 权限 ${r.foreground.tierLabel}` +
          (r.foreground.granted ? '（已授权）' : '（未授权，动手前先 computer_request_access）')
        : '读不到前台应用（可能被系统保护）';
      const canAct = r.canAct === true && typeof r.screenshotId === 'string' && r.screenshotId.length > 0;
      const guidance = canAct
        ? (r.region
          ? `这是 region 区域截图（原生分辨率 ${r.region.width}x${r.region.height}，无缩放）。动手时传这张图的 screenshot_id，坐标直接用图上的像素（1:1 映射回屏幕）。`
          : r.windowRect
            ? `这是窗口自身捕获（来源 ${r.windowSource}，窗口物理 rect x=${r.windowRect.x} y=${r.windowRect.y} ${r.windowRect.width}x${r.windowRect.height}）。动手时传这张图的 screenshot_id，坐标直接用图上的像素（按窗口原点映射回屏幕）。`
            : '动手时传这张全屏图的 screenshot_id，坐标直接用图上的像素。')
        : '这张图仅供观察。动手前让目标应用处于前台，并获取可操作的截图。';
      const notes = [r.note, `${fg}。${guidance}`].filter(Boolean).join(' ');
      return {
        ok: true,
        width: r.width,
        height: r.height,
        region: r.region ?? null,
        windowRect: r.windowRect ?? null,
        windowSource: r.windowSource ?? null,
        screenshot_id: canAct ? r.screenshotId : null,
        canAct,
        observationOnlyReason: r.observationOnlyReason,
        foreground: r.foreground,
        note: notes,
        __images: [{ mime: r.mime, base64: r.buf.toString('base64'), label: `桌面截图 ${r.source?.name || ''}`.trim() }]
      };
    };
    tools.computer_screenshot = withDesktopTool('computerUse', captureComputerScreenshot);

    tools.computer_request_access = withDesktopTool('computerUse', async (computerUse, args, ctx) => {
      const apps = Array.isArray(args?.apps) ? args.apps.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
      if (!apps.length) return { error: '缺少 apps：写下你要操作的应用名（进程名或窗口标题片段）' };
      // 0.31.1：真 Edge（CDP）已连接时不走 CU 这条路——CDP 不需要前台授权，
      // 拿 CU 去「授权浏览器」纯属绕路（真机实测模型就这么绕了 3 步）。
      const redirect = await blockedByRealEdge('computer_request_access');
      if (redirect) return redirect;
      const reason = String(args?.reason || '').trim();
      // 用已有的 ask_user 通道向用户确认（有 human-in-the-loop 就不另造一套 UI）
      if (typeof askUser === 'function') {
        const r = await askUser({
          question: `AI 请求操作这些应用：${apps.join('、')}${reason ? `\n原因：${reason}` : ''}\n同意后本进程内一直有效（重启要重新授权）。`,
          options: [
            { label: '同意', description: '允许操作这些应用（仍受权限级别限制）' },
            { label: '拒绝', description: '不允许操作' }
          ]
        }, ctx || {});
        if (r?.error) return r;
        const answer = typeof r?.answer === 'string' ? r.answer.trim() : '';
        const agreed = /^(同意|允许|yes|ok|可以)$/i.test(answer);
        if (!agreed) return { ok: false, granted: [], note: `用户未同意（回答：${answer || '空'}）。不要自己绕过授权，如实说明需要用户先授权。` };
        const granted = computerUse.grantApps(apps);
        return { ok: true, granted, note: `已授权：${granted.join('、')}。让目标应用处于前台，再获取可操作的全屏截图。` };
      }
      return { error: '当前会话没有可用的用户确认通道，无法授权' };
    });

    tools.computer_action = withDesktopTool('computerUse', async (computerUse, args) => {
      // 0.31.1：真 Edge 已连接 → 不许用 CU 点/输入那个浏览器（会抢前台、动用户键鼠）
      const redirect = await blockedByRealEdge('computer_action');
      if (redirect) return redirect;
      const { action: rawAction, screenshot_id: screenshotId, scale: _scale, observe, wait_for: waitFor, ...params } = args || {};
      const action = String(rawAction || '').trim();
      if (!action) return { error: '缺少 action' };
      // 0.30.0（特性 3）：wait_for 参数先校验（校验失败=参数错，不动手）
      if (waitFor != null) {
        const { validateWaitFor } = await import('./wait-for.mjs');
        const bad = validateWaitFor(waitFor);
        if (bad) return { error: bad };
      }
      const r = await computerUse.performAction(action, { ...params, screenshotId });
      if (!r.ok) return { ...r, error: r.error || '桌面动作失败' };
      const result = { ...r, foreground: r.foregroundAtAction };
      // 0.30.0（特性 3，R7）：动作已执行 → wait_for 单独求值。超时返回 ok:true/matched:false/timedOut:true
      // 并与动作结果合并（绝不因为超时把整体判成 ok:false——那会 stopAutomation 杀掉后续动作）。
      if (waitFor != null && typeof computerUse.waitFor === 'function') {
        try {
          const waited = await computerUse.waitFor(waitFor);
          result.wait = waited;
          if (waited?.timedOut) {
            result.note = `${String(result.note || '').trim()} 等待界面变化超时（${waited.elapsedMs}ms）：动作是否生效请重新截图确认。`.trim();
          } else if (waited?.matched) {
            result.note = `${String(result.note || '').trim()} 已等到界面变化。`.trim();
          }
        } catch (e) {
          result.waitError = { error: e?.message || String(e) };
        }
      } else if (waitFor != null) {
        result.waitError = { error: '当前环境不支持等待条件' };
      }
      if (observe !== true) return result;

      try {
        const { __images, ...observation } = await captureComputerScreenshot(computerUse);
        if (observation.ok) {
          return { ...result, note: '动作已执行，已附上操作后的全屏截图。', observation, __images };
        }
        return { ...result, note: '动作已执行，操作后截图失败。', observationError: observation };
      } catch (e) {
        return { ...result, note: '动作已执行，操作后截图失败。', observationError: { error: e?.message || String(e) } };
      }
    });

    // 0.30.5 实验 1（复合动作）：一次调用执行有序多动作，省掉「每动作一次模型往返」。
    // 依据：Anthropic batch action / OpenAI computer_call actions 数组 / cua run_steps 同形态。
    // 我们的真机数据：工具执行只占 7%，93% 是模型往返——所以这是唯一有效杠杆。
    // 安全边界：首错即停 + 每步重新校验 + 不跨窗口（同一 screenshot_id）+ 上限 8 步。
    tools.computer_sequence = withDesktopTool('computerUse', async (computerUse, args) => {
      const { screenshot_id: screenshotId, steps: rawSteps, observe: observeArg, observe_after_each: observeEach, observe_after_all: observeAll } = args || {};
      const { validateSequence, planSequence, summarizeSequenceResult } = await import('./cu-sequence.mjs');
      const bad = validateSequence(rawSteps);
      if (bad) return { error: bad, deniedBy: 'invalid-argument' };
      // 0.31.1：真 Edge 已连接 → 序列同样不给走 CU（整段都在动那个浏览器窗口）
      const redirect = await blockedByRealEdge('computer_sequence');
      if (redirect) return redirect;
      const steps = rawSteps || [];
      const plan = planSequence(steps, { observeAfterEach: observeEach === true });

      const completedResults = [];
      let failed = null;
      let idx = 0;
      for (const step of steps) {
        const { action, observe: _o, observe: _obs, ...params } = step || {};
        // 每一步都走与 computer_action 完全相同的入口（tier/授权/前台/坐标/遮挡/UIA 全部照旧）——
        // 序列不是「快路径」，只是把多次往返合成一次，安全检查一步不少。
        const r = await computerUse.performAction(String(action), { ...params, screenshotId });
        if (!r.ok) {
          failed = { index: idx, action: String(action), error: r.error || '动作失败', deniedBy: r.deniedBy, detail: r };
          break;
        }
        completedResults.push({ step: idx + 1, action: String(action), ok: true, foregroundAtAction: r.foregroundAtAction });
        idx += 1;
      }

      const wantObserve = observeArg === true || observeAll === true || plan.finalObserve;
      const base = {
        ok: failed == null,
        mode: 'sequence',
        total: steps.length,
        completed: completedResults.length,
        steps: completedResults,
        failed: failed ? { step: failed.index + 1, action: failed.action, error: failed.error, deniedBy: failed.deniedBy } : null
      };
      if (failed) {
        // 首错即停：把"已生效的步数"和"界面可能已变化"如实告诉模型（防重复执行前面的动作）
        return { ...base, error: `第 ${failed.index + 1} 步（${failed.action}）失败：${failed.error}`, ...(failed.deniedBy ? { deniedBy: failed.deniedBy } : {}),
          note: summarizeSequenceResult({ steps, completed: completedResults.length, failed, lastObservation: null }) };
      }
      if (!wantObserve) {
        return { ...base, note: summarizeSequenceResult({ steps, completed: completedResults.length, failed: null, lastObservation: null }) };
      }
      try {
        const { __images, ...observation } = await captureComputerScreenshot(computerUse);
        const canAct = observation.ok && observation.canAct === true;
        const lastObservation = {
          canAct,
          screenshotId: canAct ? observation.screenshot_id : null,
          reason: canAct ? null : (observation.observationOnlyReason || '目标不在前台')
        };
        return {
          ...base,
          note: summarizeSequenceResult({ steps, completed: completedResults.length, failed: null, lastObservation }),
          observation: canAct ? observation : null,
          observationOnly: canAct ? null : observation,
          ...(canAct ? { screenshot_id: observation.screenshot_id, __images } : { __images })
        };
      } catch (e) {
        return { ...base, note: summarizeSequenceResult({ steps, completed: completedResults.length, failed: null, lastObservation: null }),
          observationError: { error: e?.message || String(e) } };
      }
    });

    // 真 Edge 引擎（0.31.0）：与离屏引擎同一套接口形状，按 mode 派发。
    // 用独立的 loader：browser-real.mjs 依赖 playwright-core，纯 Node 测试台里也能加载，
    // 但没有 Electron 时（sim 环境）仍然只返回 null，工具表照旧不出现。
    let browserRealPromise;
    const loadBrowserReal = () => browserRealPromise ??= (async () => {
      if (typeof getBrowserRealAsync !== 'function') return null;
      try { return await getBrowserRealAsync(); } catch { return null; }
    })();
    const realOrError = async () => {
      const real = await loadBrowserReal();
      if (!real) return { error: '真 Edge 通道在当前环境不可用（需要 FinalCheck 桌面端）' };
      return { real };
    };

    tools.browser_navigate = withDesktopTool('browserUse', async (browserUse, args) => {
      const url = String(args?.url || '').trim();
      if (!url) return { error: '缺少 url' };
      // 0.31.1：模式由**用户**选，不让模型自己拍板。用户真机实测：只说「打开浏览器，我要登录我的小红书」，
      // 模型自己挑了真 Edge，还拿 computer_* 去聚焦/截图那个窗口，绕了 5 步。
      // 现在第一次涉及浏览器时先 ask_user 三选一（一次性无痕 / 长期保留 / 接我自己的 Edge），
      // 会话内答过一次就不再问；设置页选过（chosen=true）也直接按设置跑。
      const explicit = String(args?.mode || '').toLowerCase();
      const realMod = await loadBrowserReal();
      const realAvailable = Boolean(realMod);
      let sessionMode = '';
      try { sessionMode = choiceStore.get?.() || ''; } catch { /* 记忆读失败按未选择 */ }
      let sessPolicy = null;
      if (typeof browserSessionPolicy === 'function') {
        try { sessPolicy = await browserSessionPolicy(); } catch { sessPolicy = null; }
      }
      // 0.31.0 的「首次使用提示条」只在**不需要提问**的时候推：0.31.1 起首次使用已经用
      // ask_user 三选一卡把「一次性/长期保留」问清楚了，再推一条提示条就是同一件事问两遍
      // （用户会以为流程坏了）。没有提问通道（子代理/测试台）时仍保留提示条，那条 UI 提示是唯一出口。
      const willAsk = typeof askUser === 'function' && !!sessPolicy && sessPolicy.chosen === false
        && String(choiceStore.get?.() || '') === '';
      if (!willAsk && sessPolicy && sessPolicy.chosen === false && typeof onBrowserFirstUse === 'function') {
        try { onBrowserFirstUse(sessPolicy); } catch { /* 提示失败不影响导航 */ }
      }
      const decision = decideBrowserChoice({
        explicitMode: explicit,
        sessionMode,
        configChosen: Boolean(sessPolicy?.chosen),
        hasAskChannel: typeof askUser === 'function',
        realAvailable
      });
      let chosenMode = decision.mode;
      let askedNow = false;
      if (decision.ask && typeof askUser === 'function') {
        const card = buildChoicePrompt({ url, realAvailable });
        const r = await askUser(card, {});
        if (r?.error) return { ...r, note: '浏览器模式没问成（用户未回答或界面不可用）。没有擅自接真 Edge；本次按最保守的离屏无痕继续。' };
        const parsed = parseBrowserChoice(r?.answer);
        askedNow = true;
        if (!parsed) {
          return {
            ok: false, deniedBy: 'browser-mode-unclear',
            error: t('用户的回答没能识别成三种模式之一（原文：{answer}）。不要猜：再问一次，或按用户话里最明确的一个选项执行。', { answer: String(r?.answer || '').slice(0, 200) })
          };
        }
        chosenMode = parsed;
        try { choiceStore.set?.(parsed); } catch { /* 记忆写失败不影响本次导航 */ }
      }

      // 「接真 Edge」这一步额外要用户同意：连真 Edge 会用他的真实登录态，不是能默认开的东西。
      // 但如果用户刚刚在**三选一卡片里亲手选了**「接我自己的 Edge」，那就是同意——别再弹第二张卡
      // （真机教训：两张卡连着弹，用户会以为流程出问题）。
      if (chosenMode === 'real') {
        if (!realAvailable) return { error: '真 Edge 通道在当前环境不可用（需要 FinalCheck 桌面端）' };
        if (!realMod.realIsConnected?.()) {
          const got = await realOrError();
          if (got.error) return { error: got.error };
          const consentGiven = askedNow === true; // 三选一里选了 real
          if (!consentGiven) {
            if (typeof askUser !== 'function') {
              // 没有提问通道（子代理/测试台）：不能默认碰用户的真实账号。
              // 旧调用形状里的「先 browser_connect_real」提示保留，同时说明还有一道授权闸。
              return { ok: false, deniedBy: 'real-edge-needs-consent', error: `真 Edge 未连接，先调用 browser_connect_real（该工具会先问用户是否同意接真 Edge）。${NO_CHANNEL_REAL_DENY}` };
            }
            const consent = await askUser(buildRealConsentPrompt({ purpose: safeHost(url) }), {});
            if (consent?.error) return { ...consent, note: '没拿到用户对「接真 Edge」的答复，不擅自连接。' };
            const agreed = parseRealConsent(consent?.answer);
            if (agreed !== true) {
              // 用户不愿接真 Edge：退回离屏（无痕/持久按设置），并把原因说清楚
              const fallback = await runLocalNavigate();
              return { ...fallback, note: `用户不同意接真 Edge（回答：${String(consent?.answer || '').slice(0, 120)}），已退回离屏浏览器。需要登录才有的内容可能看不到。` };
            }
          }
          try {
            const userDataDir = typeof browserUserDataDir === 'function' ? await browserUserDataDir() : '';
            const conn = await realMod.connectReal({ userDataDir, start: true });
            const nav = await realMod.navigateReal(url, { waitMs: Number(args?.wait_ms) || 0, observe: args?.observe !== false });
            return { ...nav, connect: conn, note: choiceNote('real', { asked: true, realStarted: conn?.started === true }) };
          } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
          }
        }
        try {
          const nav = await realMod.navigateReal(url, { waitMs: Number(args?.wait_ms) || 0, observe: args?.observe !== false });
          return { ...nav, note: choiceNote('real', { asked: askedNow }) };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      }

      async function runLocalNavigate() {
        // 用户选了模式就按它跑（覆盖设置页的默认）；没选过就用主进程解析出的设置策略。
        const wantPolicy = chosenMode
          ? { mode: chosenMode, chosen: true, persistent: chosenMode === 'persistent', partition: resolvePartition(chosenMode === 'persistent') }
          : sessPolicy;
        const r = await browserUse.navigate(url, {
          show: args?.show === true,
          width: args?.width,
          height: args?.height,
          waitMs: Number(args?.wait_ms) || 0,
          observe: args?.observe !== false,
          ...(wantPolicy ? { policy: wantPolicy } : {})
        });
        const mode = wantPolicy?.mode || 'oneshot';
        // 只有「用户刚刚答过卡」才加附注：设置页决定/测试台缺省这些情况返回值形状保持不变，
        // 免得每多一个字段就把下游的 deepEqual 契约测试全打红（0.31.1 实测踩过）。
        return { ...r, ...(r?.ok && askedNow ? { note: choiceNote(mode, { asked: true }) } : {}) };
      }

      return runLocalNavigate();
    });

    // 「ref 来自哪个模式」这件事不靠模型自觉：真 Edge 连接过就优先走真 Edge（ref 前缀 r），
    // 否则走离屏（ref 前缀 e）。两侧 ref 前缀不同，误用会被引擎明确拒绝，不会被静默当成本地 ref。
    const realConnected = async () => {
      const real = await loadBrowserReal();
      try { return real?.realIsConnected?.() === true ? real : null; } catch { return null; }
    };
    const isRealRef = (ref) => /^r\d+$/.test(String(ref || ''));

    tools.browser_snapshot = async (args) => {
      // 真 Edge 已连接时，snapshot 观测的就是它（与上一次 navigate/click 的宿主一致）
      const real = await realConnected();
      if (real) {
        try {
          return await real.snapshotReal({
            maxNodes: Number(args?.max_nodes) || 220,
            includeText: args?.include_text !== false,
            query: typeof args?.query === 'string' ? args.query : undefined
          });
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }
      const local = withDesktopTool('browserUse', (browserUse, a) => browserUse.snapshot({
        maxNodes: Number(a?.max_nodes) || 220,
        includeText: a?.include_text !== false,
        query: typeof a?.query === 'string' ? a.query : undefined
      }));
      return local(args, {});
    };

    tools.browser_click = async (args) => {
      const ref = String(args?.ref || '').trim();
      if (!ref) return { error: '缺少 ref（用最近一次页面结构中的引用）' };
      if (isRealRef(ref)) {
        const real = await realConnected();
        if (!real) return { ok: false, error: '这个 ref 来自真 Edge，但连接已断开；重连后重新 browser_snapshot', };
        try { return await real.clickReal(ref, { observe: args?.observe === true }); }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }
      const local = withDesktopTool('browserUse', (browserUse, a) => browserUse.click(String(a?.ref || '').trim(), { observe: a?.observe === true }));
      return local(args, {});
    };

    tools.browser_type = async (args) => {
      const ref = String(args?.ref || '').trim();
      if (!ref) return { error: '缺少 ref' };
      if (typeof args?.text !== 'string') return { error: 'text 必须是字符串。若要清空字段，请明确传入空字符串。' };
      if (isRealRef(ref)) {
        const real = await realConnected();
        if (!real) return { ok: false, error: '这个 ref 来自真 Edge，但连接已断开；重连后重新 browser_snapshot' };
        try { return await real.typeIntoReal(ref, args.text); }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }
      const local = withDesktopTool('browserUse', async (browserUse, a) => {
        const r = await browserUse.typeInto(String(a?.ref || '').trim(), a.text);
        return r.ok ? { ok: true, note: '已输入。提交表单前建议 browser_snapshot 确认填对了' } : r;
      });
      return local(args, {});
    };

    tools.browser_evaluate = async (args) => {
      const expr = String(args?.expression || '').trim();
      if (!expr) return { error: '缺少 expression' };
      const real = await realConnected();
      if (real) {
        try { return await real.evaluateReal(expr); }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }
      const local = withDesktopTool('browserUse', (browserUse, a) => browserUse.evaluate(String(a?.expression || '').trim()));
      return local(args, {});
    };

    tools.browser_console = async () => {
      const real = await realConnected();
      if (real) {
        try { return real.consoleMessagesReal(); }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }
      const local = withDesktopTool('browserUse', (browserUse) => browserUse.consoleMessages());
      return local({}, {});
    };

    tools.browser_screenshot = async () => {
      const real = await realConnected();
      if (real) {
        try {
          const r = await real.screenshotReal();
          if (!r.ok) return r;
          return {
            ok: true, width: r.width, height: r.height,
            note: '这是真 Edge 的页面截图。（不抢前台；不影响用户窗口）',
            __images: [{ mime: r.mime, base64: r.buf.toString('base64'), label: '真 Edge 截图' }]
          };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      }
      const local = withDesktopTool('browserUse', async (browserUse) => {
        const r = await browserUse.screenshot();
        if (!r.ok) return r;
        return {
          ok: true, width: r.width, height: r.height,
          note: '这是浏览器页面截图。判断结构对不对优先用 browser_snapshot。',
          __images: [{ mime: r.mime, base64: r.buf.toString('base64'), label: '浏览器截图' }]
        };
      });
      const r = await local({}, {});
      // 离屏引擎不可用（纯 Node / 测试台）：如实报错，不要静默返回 undefined
      return r || { error: '浏览器截图需要 FinalCheck 桌面端（当前环境没有离屏浏览器）' };
    };

    tools.browser_close = withDesktopTool('browserUse', (browserUse) => {
      browserUse.close();
      return { ok: true, note: '浏览器已关闭' };
    });

    // ---- 真 Edge（CDP 9224）：连接 / 登录态 / 断开 ----
    // 红线：断开不杀 Edge（人工启动、用户登录过的浏览器要继续活着）。
    tools.browser_connect_real = async (args) => {
      const real = await loadBrowserReal();
      if (!real) return { error: '真 Edge 通道在当前环境不可用（需要 FinalCheck 桌面端）' };
      // 0.31.1：接真 Edge 会用到用户的真实登录态，必须先问一次（本会话同意过就不再问）。
      // 没有提问通道（子代理/测试台）→ 明确拒绝，绝不因为「问不了」就默认连上。
      const realAlready = Boolean(real.realIsConnected?.());
      if (!realAlready) {
        let sessionMode = '';
        try { sessionMode = choiceStore.get?.() || ''; } catch { /* 按未选择 */ }
        if (String(sessionMode).toLowerCase() !== 'real') {
          if (typeof askUser !== 'function') {
            return { ok: false, deniedBy: 'real-edge-needs-consent', error: NO_CHANNEL_REAL_DENY };
          }
          const purpose = Array.isArray(args?.platforms) ? args.platforms.map(String).filter(Boolean).slice(0, 3).join('、') : '';
          const consent = await askUser(buildRealConsentPrompt({ purpose }), {});
          if (consent?.error) return { ...consent, note: '没拿到用户对「接真 Edge」的答复，不擅自连接。' };
          if (parseRealConsent(consent?.answer) !== true) {
            return { ok: false, deniedBy: 'user-declined', note: `用户不同意接真 Edge（回答：${String(consent?.answer || '').slice(0, 120)}）。不要重试；改用离屏 browser_navigate，并如实说明登录态内容看不到。` };
          }
          try { choiceStore.set?.('real'); } catch { /* 记忆写失败不影响连接 */ }
        }
      }
      try {
        // PLATFORM_PLAYBOOKS 是「平台键 → 判据表」的对象，不是数组：
        // 过滤要按 hasOwnProperty 判，别用 includes（那是数组方法，永远 false，会把所有平台悄悄丢掉）
        const books = real.PLATFORM_PLAYBOOKS || {};
        const platforms = Array.isArray(args?.platforms)
          ? args.platforms.map((p) => String(p).trim()).filter((p) => Object.prototype.hasOwnProperty.call(books, p)).slice(0, 6)
          : [];
        const urls = platforms.map((p) => books[p].home);
        // profile 位置：主进程注入的 userData 目录（绝不碰用户日常 Edge / datacrawler 的 profile）
        const userDataDir = typeof browserUserDataDir === 'function' ? await browserUserDataDir() : '';
        const r = await real.connectReal({
          userDataDir,
          urls,
          start: args?.start !== false
        });
        return {
          ok: true, ...r,
          note: r.started
            ? '已启动隔离 Edge 并在前台打开（首次请在其中人工登录）；后续 CDP 操作不抢前台。'
            : '已连接正在运行的隔离 Edge（未新开窗口）。'
        };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    };

    tools.browser_login_state = async (args) => {
      const real = await loadBrowserReal();
      if (!real) return { error: '真 Edge 通道在当前环境不可用（需要 FinalCheck 桌面端）' };
      const platform = String(args?.platform || '').trim();
      if (!platform) return { error: '缺少 platform' };
      try { return await real.probeLoginState({ platform }); }
      catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    };

    tools.browser_disconnect_real = async (args) => {
      const real = await loadBrowserReal();
      if (!real) return { error: '真 Edge 通道在当前环境不可用（需要 FinalCheck 桌面端）' };
      try {
        return args?.close_browser === true
          ? await real.closeRealEdgeAndReset()
          : await real.disconnectReal();
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    };
  }
  // 回合中途提问：只有主 agent 的 createAgentTools 会传 askUser（子代理/工作流 gate 不传），
  // 工具表与 schema 两层都不给子代理，避免并行子代理同时弹多张卡。
  if (typeof askUser === 'function') {
    tools.ask_user = async (args, ctx) => {
      const r = await askUser(args || {}, ctx);
      if (r && !r.error) askedThisTurn = true;
      return r;
    };
  }

  // 轻量子代理（0.26，对齐 Claude Code 的 Agent 工具）：只给主 agent（spawnAgent 由 ipc-agent 注入，
  // 子代理 schema 不含该工具，不会套娃）。这里只做参数校验，派活与 transcript 由 ipc-agent 负责。
  if (typeof spawnAgent === 'function') {
    tools.spawn_agent = async (args, ctx) => {
      const a = args || {};
      const prompt = String(a.prompt ?? '').trim();
      if (!prompt) return { error: t('spawn_agent 缺少 prompt：写清子代理要做什么、范围、交回什么') };
      const type = ['explore', 'general', 'verify'].includes(a.type) ? a.type : 'explore';
      const description = String(a.description ?? '').trim().slice(0, 40) || prompt.replace(/\s+/g, ' ').slice(0, 16);
      return spawnAgent({ description, prompt, type }, ctx || {});
    };
  }

  // 验收单：同样只给主 agent（todoWrite 由 ipc-agent 注入，子代理 schema 不含该工具）。
  // 实现只做校验 + 记账；卡片由渲染层从 tool part 还原，报告闸在回合结束时读同一份台账。
  // CC 式规则①（同一时间恰好一个 in_progress）：写台账前就归一 —— 多个 running 时保留第一个，
  // 其余自动降回 pending；台账、返回清单、进度计数三处一致，并在返回里附提示让模型知道被降了哪些条。
  // ②③（禁带病标 done / 不许攒批）是给模型的纪律，落在 TODO_CC_RULES_TEXT（并轨进 schema description）。
  if (typeof todoWrite === 'function') {
    tools.todo_write = async (args) => {
      const a = args || {};
      const items = Array.isArray(a.items) ? a.items : null;
      if (items) {
        let firstRunning = false;
        const downgraded = [];
        const normalized = items.map((it) => {
          if (it && typeof it === 'object' && it.status === 'running') {
            if (firstRunning) {
              downgraded.push(String(it.id ?? ''));
              return { ...it, status: 'pending' };
            }
            firstRunning = true;
          }
          return it;
        });
        if (downgraded.length) {
          const r = await todoWrite({ ...a, items: normalized }, { sessionId });
          if (r?.ok) {
            return { ...r, note: `同一时间只保留一个进行中：${downgraded.filter(Boolean).join('、')} 已自动降回 pending（规则②：测试失败/实现不全时保持 running 并新建「需要解决什么」条目，禁止直接标 done）` };
          }
          return r;
        }
      }
      return todoWrite(a, { sessionId });
    };
  }

  if (!hooksOn) return tools;

  // ---- Hooks 接线：所有工具调用统一经过 PreToolUse / PostToolUse(Failure) ----
  // PreToolUse fail-closed（deny 不执行；ask 走既有审批通道或明确报无通道）；
  // Post 事件 fail-open（失败只记录，不影响工具结果）。
  const wrapped = {};
  for (const [name, fn] of Object.entries(tools)) {
    wrapped[name] = async (args, ctx) => {
      let callArgs = args && typeof args === 'object' ? args : {};
      const payload = (extra) => ({ tool: name, args: callArgs, sessionId, cwd: hookCwd, ...extra });

      let pre;
      try {
        pre = await runHook('PreToolUse', payload());
      } catch (e) {
        const reason = e?.message || String(e);
        return { error: '被 hook 拦截：' + reason, deniedBy: 'hook', reason };
      }
      if (pre.decision === 'deny') {
        const reason = pre.messages.join('；') || 'PreToolUse hook 拒绝该工具调用';
        return { error: '被 hook 拦截：' + reason, deniedBy: 'hook', reason };
      }
      if (pre.args && typeof pre.args === 'object') callArgs = { ...callArgs, ...pre.args };
      if (pre.decision === 'ask') {
        const reason = pre.messages.join('；') || 'PreToolUse hook 要求人工确认';
        if (!APPROVAL_TOOLS.has(name) || typeof permissions?.requestApproval !== 'function') {
          return { error: 'hook 要求人工确认，但当前工具无审批通道', deniedBy: 'hook', reason };
        }
        const decision = await permissions.requestApproval({ tool: name, summary: `Hook 要求确认（${name}）：${reason}`, ...approvalScope });
        if (decision !== 'allowed-once' && decision !== 'always-session') {
          return { error: '用户拒绝了 hook 要求的人工确认', deniedBy: 'hook', reason };
        }
        // 人工已批准：给工具内部审批检查发一张一次性免审券，避免同一个调用弹第二次条
        permissions?.grantOnce?.(name, approvalTarget(name, callArgs), approvalScope);
      }

      let result;
      try {
        result = await fn(callArgs, ctx);
      } catch (e) {
        result = { error: e?.message || String(e) };
      }
      // 兜底回收：工具内部没消费掉的一次性免审券不能跨调用遗留
      if (APPROVAL_TOOLS.has(name)) {
        try { permissions?.consumeGrant?.(name, approvalTarget(name, callArgs), approvalScope); } catch { /* 忽略 */ }
      }
      try {
        const failed = !!result?.error;
        const post = await runHook(failed ? 'PostToolUseFailure' : 'PostToolUse', payload(
          failed ? { error: String(result.error).slice(0, 2000) } : {}
        ));
        for (const w of [...(post.warnings || []), ...(post.errors || [])]) console.warn('[hooks] ' + w);
      } catch (e) {
        console.warn('[hooks] PostToolUse 事件异常（已放行）：' + (e?.message || e));
      }
      return result;
    };
  }
  return wrapped;
}
