// Agent 工具实现（从 index.mjs 抽出：可单测、可替换权限台账）
// 只负责「工具做什么」；工具名/参数的模型可见 schema 在 agent-service.mjs（SSOT）
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadSkills, readPlaybook, catalogSummary } from '../../../src/playbooks.mjs';
import { readFileTool, editFileTool, writeFileTool } from '../../../src/fs-tools.mjs';
import { assertPathAllowed, assertCwd, checkCommand, checkDestructiveTargets, scrubEnv } from './policy.mjs';
import { runHookEvent } from './hooks.mjs';
import { isBlocked } from './shell.mjs';
import { dynamicRuntime, recordProbe, recordStress } from './dynamic-evidence.mjs';
import { assertArtifactPath } from './artifact-gate.mjs';
import { createSandboxedRun, sandboxAvailability, sandboxCompatible } from './sandbox.mjs';
// 工作流兜底提示走双语词典（zh 原样返回，en 查表）
import { t } from '../renderer/i18n/core.mjs';

const PREVIEW_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.html', '.htm', '.pdf', '.txt', '.md', '.json', '.js', '.mjs', '.css', '.csv', '.log', '.xml', '.yml', '.yaml']);

// hook 说 ask 时可以接上现有审批通道的工具（其余工具没有审批通道 → 明确报错，不静默执行）
const APPROVAL_TOOLS = new Set(['edit_file', 'write_file', 'run_command', 'quality_gate']);

function policyDenyResult(check) {
  return {
    error: '被沙箱拒绝：' + check.reason,
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
// Node 在所有 Windows 版本上按 32 位有符号数报退出码，两种写法都收。
const DLL_INIT_FAILED_CODES = new Set([3221225794, -1073741502]);
function isDllInitFailure(result) {
  if (!result || result.blocked || result.error) return false;
  return DLL_INIT_FAILED_CODES.has(Number(result.code));
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

export function runCommandWithSignal(command, {
  cwd, timeoutMs, idleMs = DEFAULT_COMMAND_IDLE_MS, background = false, env: envInput, signal = null,
  sandbox = null, forceVisibleConsole = false,
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
      // 与 shell.mjs 相同：避免 Git Bash 的 find/sort/more 抢先命中 PATH
      const sys = 'C:\\Windows\\System32;C:\\Windows;';
      const old = env.PATH || env.Path || '';
      env.PATH = sys + old;
      env.Path = env.PATH;
    }
    if (sandbox?.env && typeof sandbox.env === 'object') Object.assign(env, sandbox.env);
    let out = '', err = '', settled = false, proc = null, timer = null, idleTimer = null, pingTimer = null;
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
      resolve({ ...value, sandbox: sandbox ? sandbox.mode : 'none', stdout: String(value.stdout ?? out).slice(0, 8000), stderr: String(value.stderr ?? err).slice(0, 4000) });
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
        // 屏显：沙箱默认给 runner 一个不可见控制台（CREATE_NO_WINDOW），受限子进程继承它，
        // 因此不会弹黑窗；若某个系统上受限子进程在 DLL 初始化阶段死亡（0xC0000142，命令未执行），
        // 由调用方用 forceVisibleConsole 重试一次（见 run_command）。
        windowsHide: sandbox ? !forceVisibleConsole : isWin,
        env,
        // 后台启动：新进程组 + 不接管道，父进程退出也不连带结束
        ...(wantsBackground ? { detached: true, stdio: 'ignore' } : {})
      };
      proc = sandbox
        ? spawn(sandbox.file, sandbox.args, { ...spawnOptions, shell: false })
        : spawn(cmd, { ...spawnOptions, shell: true });
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
      if (out.length < 200000) out += d.toString();
      armIdle(); // 有输出就重新计时：只要 stdout/stderr 还在滚，就永远不因空闲转后台
    });
    proc.stderr?.on('data', (d) => {
      if (err.length < 100000) err += d.toString();
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

export function createAgentTools({ repoRoot, permissions, recordAudit = async () => {}, playbookRoot, runWorkflow = null, projectPath = null, policy = null, hooksConfig = null, hooksRunner = null, sessionId = null, cwd = null, signal = null, commandIdleMs = DEFAULT_COMMAND_IDLE_MS, askUser = null, todoWrite = null, onActivity = null, requireAuditIntent = null } = {}) {
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
      if (askBeforeAudit && !explicitTier && !hasProfile) {
        const { CORE_DIMENSION_NAMES } = await import(engineUrl('src/profile.mjs'));
        return {
          error: t('先确认档位与维度：请用 ask_user 问清 L1/L2/L3 与要覆盖的维度，再调用 audit_project'),
          needAsk: true,
          dimensions: [...CORE_DIMENSION_NAMES],
          levels: ['L1', 'L2', 'L3']
        };
      }
      const { audit } = await import(engineUrl('src/audit.mjs'));
      const r = await audit(dir, { tier: explicitTier, interactive: true, runTests: false, profile, runtime });
      if (policy?.mode !== 'readonly') recordAudit(dir, r).catch(() => {});
      return {
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
        const sbPref = String(process.env.FINALCHECK_SANDBOX || '').trim().toLowerCase();
        // 质量闸的命令基本是 npm/node/tsc/vitest：受限令牌下它们会 EPERM（捕获不了孙进程输出），
        // 按兼容清单改在宿主机执行；路径策略、命令黑名单与审批照旧生效。
        const compat = sandboxCompatible(command);
        if (!compat.compatible && sbPref === 'required') {
          return { code: 1, ms: 0, out: '', err: `沙箱不支持这条质量命令（${compat.reason}）；FINALCHECK_SANDBOX=required 已拒绝在宿主机执行`, timedOut: false };
        }
        const sb = sbPref === 'off' || !compat.compatible ? null : createSandboxedRun({
          workspaceRoot: projectDir,
          policyMode: policy?.mode || 'off',
          command,
          cwd: projectDir
        });
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
      const a = args || {};
      if (!a.path || typeof a.path !== 'string') return { error: 'path 必填' };
      if (policy) {
        const check = assertPathAllowed(policy, a.path, { write: true, tool: 'repair_rollback' });
        if (!check.ok) return policyDenyResult(check);
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

    edit_file: async (args) => {
      let a = args || {};
      if (policy) {
        const check = assertPathAllowed(policy, a.path, { write: true, tool: 'edit_file' });
        if (!check.ok) return policyDenyResult(check);
        a = { ...a, path: check.path };
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

    remember_project: async (args) => {
      if (policy) {
        const check = assertPathAllowed(policy, path.join(projectPath || '', 'AGENTS.md'), { write: true, tool: 'remember_project' });
        if (!check.ok) return policyDenyResult(check);
      }
      const { rememberProject } = await import('./project-memory.mjs');
      try {
        return await rememberProject(projectPath, args?.fact);
      } catch (e) {
        return { error: e.message };
      }
    },

    run_workflow: async (args) => {
      if (typeof runWorkflow !== 'function') return { error: '当前通道不支持工作流（需要在桌面端运行）' };
      // 确定性兜底：模型没给 steps 也没给 script 时，不退化成「steps 不能为空」，
      // 而是把「先判断任务形状再选表示」的判定口径原样回给模型，让它带着参数重试。
      const filledSteps = Array.isArray(args?.steps) && args.steps.length > 0;
      const rawScript = args?.script;
      const hasScript = rawScript != null
        && !(Array.isArray(rawScript) && rawScript.length === 0)
        && !(typeof rawScript === 'string' && !rawScript.trim());
      if (!filledSteps && !hasScript) {
        return {
          error: t('你没有给 steps，也没有给 script。先判断任务形状：步骤数量固定、只是并行/串行 → 用 steps；数量由上游结果决定（按列表扇出、循环、条件分支、递归、纯计算汇总）→ 用 script；判断不了 → 用 steps。判断完带上 steps 或 script 重新调用 run_workflow，不要问用户用哪种。')
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
        // cwd 走路径边界检查（未传时默认落到项目根）；命令文本只做黑名单，不从字符串里猜路径
        const cwdCheck = assertCwd(policy, runCwd);
        if (!cwdCheck.ok) return policyDenyResult(cwdCheck);
        if (cwdCheck.path) runCwd = cwdCheck.path;
        const cmdCheck = checkCommand(policy, cmd);
        if (!cmdCheck.ok) return policyDenyResult(cmdCheck);
        // 沙箱的 WRITE_RESTRICTED 令牌不过滤 DELETE（实测 del 能删项目外文件），这条在应用层兜。
        const deleteCheck = checkDestructiveTargets(policy, cmd, runCwd);
        if (!deleteCheck.ok) return policyDenyResult(deleteCheck);
      }
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
      const idleMs = args?.idle_ms ?? args?.idleMs ?? commandIdleMs ?? DEFAULT_COMMAND_IDLE_MS;
      const sandboxMode = policy?.mode || 'off';
      const sandboxPref = String(process.env.FINALCHECK_SANDBOX || '').trim().toLowerCase();
      const compat = sandboxCompatible(cmd);
      const sandbox = sandboxPref === 'off' || !compat.compatible ? null : createSandboxedRun({
        workspaceRoot: projectPath || runCwd,
        policyMode: sandboxMode,
        command: cmd,
        cwd: runCwd
      });
      let result = await runCommandWithSignal(cmd, {
        cwd: runCwd,
        timeoutMs: args?.timeout_ms,
        idleMs,
        background: args?.background === true,
        env,
        signal: toolSignal,
        sandbox,
        onActivity
      });
      // 隐藏控制台下受限子进程初始化失败（命令未执行）→ 用可见控制台重试一次；
      // 这样默认不弹黑窗，个别系统上退化为「有个窗但能跑」，而不是整条命令失败。
      if (sandbox && isDllInitFailure(result)) {
        // 重试用新的沙箱实例：上一次的私有 temp（含 run.cmd）已经在收尾时被清理。
        const retrySandbox = createSandboxedRun({
          workspaceRoot: projectPath || runCwd,
          policyMode: sandboxMode,
          command: cmd,
          cwd: runCwd
        });
        if (retrySandbox) {
          const retried = await runCommandWithSignal(cmd, {
            cwd: runCwd,
            timeoutMs: args?.timeout_ms,
            idleMs,
            background: args?.background === true,
            env,
            signal: toolSignal,
            sandbox: retrySandbox,
            forceVisibleConsole: true,
            onActivity
          });
          retried.sandboxConsole = 'visible';
          retried.stderr = `[控制台隔离不可用：受限子进程在隐藏控制台下初始化失败，已改用可见控制台重试]\n${retried.stderr || ''}`;
          result = retried;
        }
      }
      if (sandboxMode !== 'off' && !sandbox && sandboxPref !== 'off') {
        if (!compat.compatible) {
          // 刻意跳过沙箱：受限令牌下这条命令必然失败，宿主机执行 + 如实标注。
          // required 模式下仍然 fail-closed：宁可不跑，也不在宿主机跑。
          if (sandboxPref === 'required') {
            return {
              error: `沙箱不支持这条命令（${compat.reason}）；FINALCHECK_SANDBOX=required 已拒绝在宿主机执行`,
              deniedBy: 'policy'
            };
          }
          result.sandboxSkip = compat.reason;
        } else {
          const required = sandboxPref === 'required';
          if (required) {
            return {
              error: `沙箱不可用（${sandboxAvailability().error || '平台不支持'}），FINALCHECK_SANDBOX=required 已拒绝在宿主机执行`,
              deniedBy: 'policy'
            };
          }
          result.sandboxWarning = `写/删沙箱不可用（${sandboxAvailability().error || '平台不支持'}）；本条命令在宿主机执行`;
        }
      }
      return result;
    }
  };

  // 回合中途提问：只有主 agent 的 createAgentTools 会传 askUser（子代理/工作流 gate 不传），
  // 工具表与 schema 两层都不给子代理，避免并行子代理同时弹多张卡。
  if (typeof askUser === 'function') {
    tools.ask_user = async (args, ctx) => askUser(args || {}, ctx);
  }

  // 验收单：同样只给主 agent（todoWrite 由 ipc-agent 注入，子代理 schema 不含该工具）。
  // 实现只做校验 + 记账；卡片由渲染层从 tool part 还原，报告闸在回合结束时读同一份台账。
  if (typeof todoWrite === 'function') {
    tools.todo_write = async (args) => todoWrite(args || {}, { sessionId });
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
