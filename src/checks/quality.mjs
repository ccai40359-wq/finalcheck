// Q2 质量命令闸（声明式）：项目根放 finalcheck.quality.json，声明 lint / typecheck / test / bench
// 等命令与阈值；引擎按声明顺序执行，记录 exit code / 墙钟 / 超时 / 期望匹配 / 覆盖率，
// 结果作为 findings 进报告。跑不动（没配、未授权、超时）一律记 coverageGap，不冒充「已检查」。
//
// 安全边界：执行的是项目自己的命令 —— 与 Q1 同一开关（audit 的 runTests）；
// 桌面端默认 runTests=false，要跑必须用户逐次授权（quality_gate 工具）。
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const QUALITY_FILE = 'finalcheck.quality.json';
const MAX_TIMEOUT = 600000; // 10 分钟上限，防挂死
const DEFAULT_TIMEOUT = 180000;
const MAX_REPEAT = 5; // 重复跑上限：只为查抖动，不做压测
const DEFAULT_REPEAT = 1;

const clampRepeat = (value, fallback = DEFAULT_REPEAT) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_REPEAT, Math.max(1, Math.trunc(n)));
};

// 报告永不回显密钥/口令本体：命令输出里形如 KEY=xxx / token: "xxx" 的值一律打码
const SECRETY = /([A-Za-z0-9_.-]*(?:key|secret|token|password|passwd|pwd)[A-Za-z0-9_.-]*)\s*[:=]\s*["']?([^\s"',;]{6,})/gi;
const redact = (s) => String(s ?? '').replace(SECRETY, (_m, k) => `${k}=***`).slice(-200);

/** 跑一条声明命令：返回 { code, ms, out, err, timedOut } —— 不抛异常，结果本身就是证据 */
function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      const env = { ...process.env };
      if (process.platform === 'win32') {
        // 与 desktop shell.mjs 同一教训：Git Bash 的 find/sort 会抢 PATH，npm/npx 命令必须走 System32 优先
        const sys = 'C:\\Windows\\System32;C:\\Windows;';
        const old = env.PATH || env.Path || '';
        env.PATH = sys + old;
        env.Path = env.PATH;
      }
      child = spawn(String(command), { shell: true, cwd, windowsHide: true, env });
    } catch (e) {
      return resolve({ code: null, ms: Date.now() - started, out: '', err: String(e?.message || e), timedOut: false, error: true });
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (code, timedOut = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, ms: Date.now() - started, out: out.slice(-4000), err: err.slice(-2000), timedOut });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish(124, true);
    }, timeoutMs);
    child.stdout?.on('data', (d) => { if (out.length < 4000) out += d.toString(); });
    child.stderr?.on('data', (d) => { if (err.length < 2000) err += d.toString(); });
    child.on('close', (c) => finish(c ?? 0));
    child.on('error', (e) => { err += String(e?.message || e); finish(null); });
  });
}

/** 覆盖率解析：istanbul 表格 / text-summary / c8 常见三种形状 */
export function parseCoverage(text) {
  const t = String(text || '');
  const table = /All files\s*\|\s*([\d.]+)/.exec(t); // | All files | 82.5 | ...
  if (table) return Number(table[1]);
  const summary = /Statements\s*:\s*([\d.]+)%/.exec(t); // text-summary
  if (summary) return Number(summary[1]);
  const lines = /Lines\s*:\s*([\d.]+)%/.exec(t);
  if (lines) return Number(lines[1]);
  return null;
}

export async function hasQualityConfig(projectDir) {
  try {
    const st = await stat(path.join(projectDir, QUALITY_FILE));
    return st.isFile();
  } catch { return false; }
}

export async function loadQualityConfig(projectDir) {
  try { return JSON.parse(await readFile(path.join(projectDir, QUALITY_FILE), 'utf8')); } catch { return null; }
}

/** 配置归一化：坏的字段一律收敛到安全值，不因为写错配置把闸门搞崩 */
export function normalizeQualityConfig(cfg) {
  const checks = Array.isArray(cfg?.checks) ? cfg.checks : [];
  const defaultRepeat = clampRepeat(cfg?.repeat, DEFAULT_REPEAT); // 顶层 repeat 可给所有检查项兜底
  return checks.map((c, i) => ({
    id: String(c?.id || `check${i + 1}`).trim().slice(0, 40),
    command: String(c?.command || '').trim(),
    timeoutMs: Math.min(MAX_TIMEOUT, Math.max(3000, Number(c?.timeoutMs) || DEFAULT_TIMEOUT)),
    maxMs: Number(c?.maxMs) > 0 ? Number(c.maxMs) : null,
    expect: typeof c?.expect === 'string' && c.expect ? c.expect : null,
    minPercent: Number(c?.minPercent) > 0 ? Number(c.minPercent) : null,
    severity: ['high', 'medium', 'low', 'tip'].includes(c?.severity) ? c.severity : 'high',
    optional: !!c?.optional,
    repeat: clampRepeat(c?.repeat, defaultRepeat) // 单条优先，其次顶层配置，最后 1
  }));
}

/**
 * Q2：按 finalcheck.quality.json 跑命令并判定。
 * @param {string} projectDir
 * @param {{tier?:string, run?:boolean, runner?:Function, repeat?:number}} opts run=false 时只报 coverageGap（不执行）；
 *        repeat 1–5 覆盖配置里的 repeat，默认 1（此时输出与旧版逐字段一致）
 */
export async function checkQuality(projectDir, { tier, run = true, runner = runShell, repeat, config } = {}) {
  const findings = [];
  const warnings = [];
  const raw = config === undefined ? await loadQualityConfig(projectDir) : config;
  if (!raw) return { checkId: 'Q2', findings, coverageGap: `未找到 ${QUALITY_FILE}（质量命令闸未启用）`, warnings };
  const checks = normalizeQualityConfig(raw);
  if (!checks.length) return { checkId: 'Q2', findings, coverageGap: `${QUALITY_FILE} 里没有可执行的 checks`, warnings };
  if (!run) return { checkId: 'Q2', findings, coverageGap: '质量闸要执行项目自己的命令（本轮未授权 runTests）', warnings };

  const force = String(tier || 'L2').toUpperCase() === 'L3' ? 'card' : 'check';
  const push = (rule, severity, snippet, message) => findings.push({
    checkId: 'Q2', severity, force, file: QUALITY_FILE, line: 0, rule, snippet, message, source: 'program'
  });
  const runs = []; // 逐条命令的可复现记录（exit / 耗时 / 超阈值 / 覆盖率），给 agent 与报告用
  const repeatOverride = Number.isFinite(Number(repeat)) ? clampRepeat(repeat) : null;

  for (const c of checks) {
    if (!c.command) {
      push(`Q2.${c.id}-empty`, 'medium', c.id, '质量检查项没有 command');
      continue;
    }
    const times = repeatOverride ?? c.repeat ?? DEFAULT_REPEAT;
    const attempts = [];
    for (let i = 0; i < times; i++) {
      attempts.push(await runner(c.command, projectDir, c.timeoutMs));
    }
    const r = attempts[attempts.length - 1]; // 以最后一次为代表性结果（repeat=1 时就是唯一一次）
    const runRecord = { id: c.id, command: c.command, code: r.code, ms: r.ms, timedOut: !!r.timedOut, maxMs: c.maxMs };
    if (times > 1) {
      // 只有重复跑才加字段：repeat=1 的输出必须与旧版逐字节一致
      const failures = attempts.filter((a) => a.timedOut || a.code !== 0).length;
      runRecord.attempts = attempts.map((a) => ({ code: a.code, ms: a.ms, timedOut: !!a.timedOut }));
      runRecord.flaky = { failures, total: times };
      runRecord.isFlaky = failures > 0 && failures < times; // 有失败但非全失败 = 抖动
    }
    runs.push(runRecord);
    if (runRecord.isFlaky) {
      const f = runRecord.flaky;
      if (c.optional) {
        warnings.push(`${c.id} 抖动（可选，不计入结论）：${f.failures}/${f.total} 次非 0`);
      } else {
        push(`Q2.${c.id}-flaky`, 'medium', `${f.failures}/${f.total} 次失败`, `${c.id} 抖动：重复 ${f.total} 次有 ${f.failures} 次非 0（${c.command}）`);
      }
      continue;
    }
    if (r.timedOut) {
      // 超时不是「没过」而是「没结论」：可选项降为提示，必检项按高危
      push(`Q2.${c.id}-timeout`, c.optional ? 'tip' : c.severity, `timeout ${Math.round(c.timeoutMs / 1000)}s`, `质量命令超时：${c.command}`);
      continue;
    }
    if (r.code !== 0) {
      if (c.optional) { warnings.push(`${c.id} 未通过（可选，不计入结论）：exit ${r.code}`); continue; }
      push(`Q2.${c.id}-failed`, c.severity, `exit ${r.code}`, `${c.id} 未通过（${c.command}）：${redact(r.err || r.out)}`);
      continue;
    }
    if (c.maxMs && r.ms > c.maxMs) {
      runRecord.slow = true;
      if (c.optional) warnings.push(`${c.id} 超过耗时阈值（可选）：${r.ms}ms > ${c.maxMs}ms`);
      else push(`Q2.${c.id}-slow`, 'medium', `${r.ms}ms > ${c.maxMs}ms`, `${c.id} 超过耗时阈值：实测 ${r.ms}ms，阈值 ${c.maxMs}ms`);
    }
    if (c.expect) {
      let re = null;
      try { re = new RegExp(c.expect); } catch {
        if (c.optional) warnings.push(`${c.id} 的 expect 不是合法正则：${c.expect}`);
        else push(`Q2.${c.id}-expect-invalid`, 'high', c.expect, '必需质量检查的 expect 正则无效');
      }
      if (re && !re.test(`${r.out}\n${r.err}`)) {
        runRecord.expectOk = false;
        if (c.optional) warnings.push(`${c.id} 输出未匹配期望（可选）：/${c.expect}/`);
        else push(`Q2.${c.id}-expect`, 'medium', c.expect.slice(0, 60), `${c.id} 输出里没有匹配 /${c.expect}/（命令成功但没看到期望的指标）`);
      } else if (re) runRecord.expectOk = true;
    }
    if (c.minPercent) {
      const pct = parseCoverage(`${r.out}\n${r.err}`);
      runRecord.coverage = pct;
      if (pct == null || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        const message = `${c.id} 没能从输出解析出覆盖率（期望 minPercent=${c.minPercent}，要求 0–100 的有效指标）`;
        warnings.push(message);
        if (!c.optional) push(`Q2.${c.id}-coverage-missing`, 'high', 'metric unavailable', message);
      } else if (pct < c.minPercent) {
        if (c.optional) warnings.push(`${c.id} 覆盖率未达标（可选）：${pct}%`);
        else push(`Q2.${c.id}-coverage`, 'high', `${pct}% < ${c.minPercent}%`, `${c.id} 覆盖率不达标：${pct}%，要求 ≥ ${c.minPercent}%`);
      }
    }
  }
  return { checkId: 'Q2', findings, runs, coverageGap: null, warnings };
}
