// Agent 工具实现（从 index.mjs 抽出：可单测、可替换权限台账）
// 只负责「工具做什么」；工具名/参数的模型可见 schema 在 agent-service.mjs（SSOT）
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadCatalog, readPlaybook, catalogSummary } from '../../../src/playbooks.mjs';
import { readFileTool, editFileTool, writeFileTool } from '../../../src/fs-tools.mjs';
import { assertPathAllowed, assertCwd, checkCommand, scrubEnv } from './policy.mjs';
import { runHookEvent } from './hooks.mjs';
import { isBlocked } from './shell.mjs';
import { dynamicRuntime, recordProbe, recordStress } from './dynamic-evidence.mjs';
import { assertArtifactPath } from './artifact-gate.mjs';
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
      resolve({ ...value, stdout: String(value.stdout ?? out).slice(0, 8000), stderr: String(value.stderr ?? err).slice(0, 4000) });
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
      proc = spawn(cmd, {
        shell: true,
        cwd: cwd && existsSync(String(cwd)) ? String(cwd) : undefined,
        windowsHide: isWin,
        env,
        // 后台启动：新进程组 + 不接管道，父进程退出也不连带结束
        ...(wantsBackground ? { detached: true, stdio: 'ignore' } : {})
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

export function createAgentTools({ repoRoot, permissions, recordAudit = async () => {}, playbookRoot, runWorkflow = null, projectPath = null, policy = null, hooksConfig = null, hooksRunner = null, sessionId = null, cwd = null, signal = null, commandIdleMs = DEFAULT_COMMAND_IDLE_MS, askUser = null, todoWrite = null, onActivity = null } = {}) {
  if (!repoRoot) throw new Error('createAgentTools 需要 repoRoot');
  const engineUrl = (rel) => pathToFileURL(path.join(repoRoot, rel)).href;
  const note = (url) => permissions?.noteTarget?.(url);
  const hooksOn = !!(hooksConfig && hooksConfig.enabled === true);
  const hookCwd = cwd || projectPath || undefined;
  const runHook = (event, payload) => runHookEvent(event, payload, {
    cwd: hookCwd,
    config: hooksConfig,
    runner: hooksRunner || undefined
  });

  // hook ask 批准后下发的一次性免审券：target 必须与工具内部 requestApproval 前的免批键一致
  const approvalTarget = (name, args) => {
    if (name === 'edit_file' || name === 'write_file') return path.resolve(String(args?.path || ''));
    if (name === 'quality_gate') return path.resolve(String(args?.dir || projectPath || ''));
    if (name === 'run_command') {
      const cmd = String(args?.command ?? '');
      return typeof permissions?.commandPrefix === 'function' ? permissions.commandPrefix(cmd) : cmd;
    }
    return String(args?.path ?? '');
  };
  const preApproved = (tool, target) => !!permissions?.consumeGrant?.(tool, target);

  // 11 维计划解析（App 侧统一入口）：
  //   1) 项目根有 finalcheck.profile.json → 用它（每维档位 + sources）
  //   2) 没有 → 按请求档位合成 11 维同档（DIMENSIONS 的并集与老 GATES 一致，检查计划不变）
  //   3) 工具参数 sources 覆盖文件里的 sources（agent 明确说了「有源码/给 URL/已授权」时以它为准）
  // runtime 只取本轮真的跑过的 probe/stress（最近 2 小时、host 与声明 URL 一致）——声明不等于实测。
  const resolveAuditPlan = async (dir, args = {}) => {
    const { loadProfile, CORE_DIMENSION_NAMES, PROFILE_FILE } = await import(engineUrl('src/profile.mjs'));
    const file = await loadProfile(dir).catch(() => null);
    const tierArg = String(args?.tier || '').toUpperCase();
    const level = ['L1', 'L2', 'L3'].includes(tierArg) ? tierArg : 'L2';
    const base = file && file.source === PROFILE_FILE
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
    const runtime = dynamicRuntime({ sinceMs: Date.now() - 2 * 60 * 60 * 1000, url });
    return { profile, runtime, profileSource: base.source };
  };

  const tools = {
    audit_project: async (args) => {
      const { audit } = await import(engineUrl('src/audit.mjs'));
      const dir = path.resolve(String(args?.dir || projectPath || ''));
      const { profile, runtime, profileSource } = await resolveAuditPlan(dir, args);
      const r = await audit(dir, { tier: args.tier ?? null, interactive: true, runTests: false, profile, runtime });
      recordAudit(dir, r).catch(() => {}); // 体检成功落项目档案；失败不影响工具结果
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
      };
    },

    // 质量命令闸：按项目根 finalcheck.quality.json 跑 lint / typecheck / test / bench，
    // 执行前一次性授权（和 run_command 同一套审批），避免「体检时偷偷执行项目代码」
    quality_gate: async (args) => {
      const { checkQuality, hasQualityConfig, loadQualityConfig, normalizeQualityConfig, QUALITY_FILE } = await import(engineUrl('src/checks/quality.mjs'));
      const dir = path.resolve(String(args?.dir || projectPath || ''));
      if (!(await hasQualityConfig(dir))) {
        return { error: `项目根没有 ${QUALITY_FILE}：先声明要跑的命令与阈值（checks: [{id,command,maxMs,expect,minPercent}]）` };
      }
      const cfg = await loadQualityConfig(dir);
      const checks = normalizeQualityConfig(cfg);
      if (!checks.length) return { error: `${QUALITY_FILE} 里没有可执行的 checks` };
      const summary = checks.map((c) => `· ${c.id}: ${c.command}${c.maxMs ? `（≤${c.maxMs}ms）` : ''}`).join('\n');
      if (!preApproved('quality_gate', dir) && !permissions?.sessionAllowed?.('quality_gate', dir)) {
        const decision = await permissions?.requestApproval?.({ tool: 'run_command', summary: `质量命令闸（${dir}）：\n${summary}`, sessionId });
        if (decision !== 'allowed-once' && decision !== 'always-session') return { error: '用户拒绝了质量闸执行' };
      }
      const r = await checkQuality(dir, { tier: args?.tier || 'L2', run: true, repeat: args?.repeat });
      return { dir, runs: r.runs, findings: r.findings.slice(0, 30), warnings: r.warnings, coverageGap: r.coverageGap };
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
      const { scanDownload } = await import(engineUrl('src/download-gate.mjs'));
      return scanDownload(args.dir, { excludes: [] });
    },

    probe_target: async (args) => {
      note(args.url); // 口头确认语义：记账不拦（用户定案 2026-11-07）
      const { probeTarget } = await import(engineUrl('src/dynamic/probe.mjs'));
      const t0 = Date.now();
      const out = await probeTarget(args.url, { requests: args?.requests });
      try { recordProbe(args.url, { ms: Date.now() - t0, ok: !out?.error, samples: 1 }); } catch { /* 记账失败不影响探测 */ }
      return out;
    },

    stress_target: async (args) => {
      note(args.url);
      if ((args.duration ?? 10) > 60 || (args.connections ?? 10) > 50) throw new Error('超过温和上限');
      const { stressTarget } = await import(engineUrl('src/dynamic/stress.mjs'));
      const t0 = Date.now();
      const out = await stressTarget(args.url, { duration: args.duration ?? 10, connections: args.connections ?? 10 });
      try { recordStress(args.url, { ms: Date.now() - t0, ok: !out?.error, samples: Number(out?.requests) || Number(out?.samples) || 0 }); } catch { /* 记账失败不影响压测 */ }
      return out;
    },

    get_report: async (args) => {
      const { renderReport } = await import(engineUrl('src/report.mjs'));
      const { audit } = await import(engineUrl('src/audit.mjs'));
      const dir = path.resolve(String(args?.dir || projectPath || ''));
      const { profile, runtime } = await resolveAuditPlan(dir, args);
      const r = await audit(dir, { tier: args.tier ?? null, interactive: true, runTests: false, profile, runtime });
      recordAudit(dir, r).catch(() => {}); // 同 audit_project 落档案
      return renderReport(r);
    },

    list_playbooks: async () => {
      const catalog = await loadCatalog(playbookRoot);
      return { total: catalog.length, categories: catalogSummary(catalog) };
    },

    read_playbook: async (args) => readPlaybook({
      topic: args?.topic,
      file: args?.file,
      offset: args?.offset,
      limit: args?.limit,
      root: playbookRoot
    }),

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
      if (!preApproved('edit_file', abs) && !permissions?.sessionAllowed?.('edit_file', abs)) {
        const decision = await permissions?.requestApproval?.({ tool: 'edit_file', summary: abs, sessionId });
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
      if (!preApproved('write_file', abs) && !permissions?.sessionAllowed?.('write_file', abs)) {
        const decision = await permissions?.requestApproval?.({ tool: 'write_file', summary: abs, sessionId });
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
      }
      const pattern = typeof permissions?.commandPrefix === 'function' ? permissions.commandPrefix(cmd) : cmd;
      if (!preApproved('run_command', pattern) && !permissions?.sessionAllowed?.('run_command', pattern)) {
        if (toolSignal?.aborted) return CANCELLED_RESULT();
        const decision = await permissions?.requestApproval?.({ tool: 'run_command', summary: cmd.slice(0, 300), sessionId });
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
      return runCommandWithSignal(cmd, {
        cwd: runCwd,
        timeoutMs: args?.timeout_ms,
        idleMs,
        background: args?.background === true,
        env,
        signal: toolSignal,
        onActivity
      });
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
        const decision = await permissions.requestApproval({ tool: name, summary: `Hook 要求确认（${name}）：${reason}`, sessionId });
        if (decision !== 'allowed-once' && decision !== 'always-session') {
          return { error: '用户拒绝了 hook 要求的人工确认', deniedBy: 'hook', reason };
        }
        // 人工已批准：给工具内部审批检查发一张一次性免审券，避免同一个调用弹第二次条
        permissions?.grantOnce?.(name, approvalTarget(name, callArgs));
      }

      let result;
      try {
        result = await fn(callArgs, ctx);
      } catch (e) {
        result = { error: e?.message || String(e) };
      }
      // 兜底回收：工具内部没消费掉的一次性免审券不能跨调用遗留
      if (APPROVAL_TOOLS.has(name)) {
        try { permissions?.consumeGrant?.(name, approvalTarget(name, callArgs)); } catch { /* 忽略 */ }
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
