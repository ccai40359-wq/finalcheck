// 生命周期 Hook 运行时（模块层，尚未接线；主进程后续接入 agent-service/index）
// 对齐 ZCode hooks 契约：7 个事件 / JSON stdin-stdout / 60s 超时 / 32KB 输出上限 / 默认关闭。
// 设计要点：
//  - 只支持 command hook，串行执行；上一 hook 的 context 作为下一个 payload 的 hookContext
//  - stdin 写 JSON（{event, sessionId, cwd, tool?, args?, prompt?, hookContext?}，payload 原样合并）
//  - stdout 期望 JSON；非 JSON 文本当 message（decision 不设）
//  - 失败策略：PreToolUse / UserPromptSubmit fail-closed（deny）；其余事件 fail-open（allow + warning）
//  - 本模块不 import electron，可被 node:test 直测
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from '../renderer/i18n/core.mjs';

// 七个合法事件（与 ZCode 完全一致）
export const HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop'
]);

// 失败时默认拒绝的事件（安全闸）；其余一律 fail-open
const FAIL_CLOSED_EVENTS = new Set(['PreToolUse', 'UserPromptSubmit']);

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_OUTPUT_BYTES = 32768;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;
const MIN_OUTPUT_BYTES = 1024;
const MAX_OUTPUT_BYTES = 1048576;

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function emptyEvents() {
  return Object.fromEntries(HOOK_EVENTS.map((e) => [e, []]));
}

function defaultConfig(warnings = []) {
  return {
    enabled: false,
    events: emptyEvents(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    warnings
  };
}

function allowResult() {
  return { ok: true, decision: 'allow', messages: [], outputs: [], warnings: [], errors: [] };
}

/** 默认配置文件：FINALCHECK_HOOKS_FILE > %APPDATA%/FinalCheck/hooks.json（非 Windows 用 homedir） */
function resolveHooksFile(file) {
  if (typeof file === 'string' && file.trim()) return path.resolve(file.trim());
  const envFile = process.env.FINALCHECK_HOOKS_FILE;
  if (envFile && envFile.trim()) return path.resolve(envFile.trim());
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'FinalCheck', 'hooks.json');
  }
  return path.join(os.homedir(), 'FinalCheck', 'hooks.json');
}

function normalizeHookList(eventName, list, configTimeoutMs, warnings) {
  if (list == null) return [];
  let entries = list;
  if (!Array.isArray(entries)) {
    warnings.push(t('事件 {event} 的 hooks 必须是数组，已按单项处理', { event: eventName }));
    entries = [entries];
  }
  const hooks = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const command = entry.trim();
      if (!command) {
        warnings.push(t('事件 {event} 的 hook 缺少 command，已忽略', { event: eventName }));
        continue;
      }
      hooks.push({ command, timeoutMs: configTimeoutMs, matcher: '' });
      continue;
    }
    if (!isPlainObject(entry)) {
      warnings.push(t('事件 {event} 的 hook 配置无效，已忽略', { event: eventName }));
      continue;
    }
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (!command) {
      warnings.push(t('事件 {event} 的 hook 缺少 command，已忽略', { event: eventName }));
      continue;
    }
    hooks.push({
      command,
      timeoutMs: clampInt(entry.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, configTimeoutMs),
      matcher: typeof entry.matcher === 'string' ? entry.matcher : ''
    });
  }
  return hooks;
}

function normalizeConfig(raw, warnings) {
  if (!isPlainObject(raw)) {
    if (raw !== undefined) warnings.push(t('hooks 配置必须是 JSON 对象，已按默认关闭处理'));
    return defaultConfig(warnings);
  }
  let enabled = false;
  if (raw.enabled === true) enabled = true;
  else if (raw.enabled !== undefined && raw.enabled !== false) {
    warnings.push(t('hooks.enabled 必须是布尔值，已按关闭处理'));
  }

  const timeoutMs = clampInt(raw.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = clampInt(raw.maxOutputBytes, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);
  const events = emptyEvents();

  if (raw.events !== undefined) {
    if (!isPlainObject(raw.events)) {
      warnings.push(t('hooks.events 必须是对象，已忽略'));
    } else {
      for (const [name, list] of Object.entries(raw.events)) {
        if (!HOOK_EVENTS.includes(name)) {
          warnings.push(t('未知 hook 事件 "{event}" 已忽略（仅支持 {events}）', { event: name, events: HOOK_EVENTS.join(' / ') }));
          continue;
        }
        events[name] = normalizeHookList(name, list, timeoutMs, warnings);
      }
    }
  }

  return { enabled, events, timeoutMs, maxOutputBytes, warnings };
}

/**
 * 读取 hooks 配置（同步；主进程启动时读一次即可）。
 * 文件不存在 / 解析失败 / 形状非法：默认关闭并附 warnings。
 * @param {string} [file] 显式文件路径；不传则用 FINALCHECK_HOOKS_FILE 或默认路径
 */
export function loadHooksConfig(file) {
  const warnings = [];
  const target = resolveHooksFile(file);
  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (e) {
    warnings.push(e && e.code === 'ENOENT'
      ? t('hooks 配置不存在（{path}），已按默认关闭', { path: target })
      : t('hooks 配置读取失败（{path}）：{error}', { path: target, error: (e && e.message) || e }));
    return defaultConfig(warnings);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    warnings.push(t('hooks 配置 JSON 解析失败（{path}）：{error}', { path: target, error: (e && e.message) || e }));
    return defaultConfig(warnings);
  }
  return normalizeConfig(raw, warnings);
}

/** 事件对应的 matcher 匹配值（对齐 ZCode：SessionStart=source、工具事件=tool 名、提示词/回复文本） */
function matcherValue(event, payload) {
  switch (event) {
    case 'SessionStart': return payload.source;
    case 'UserPromptSubmit': return payload.prompt;
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest': return payload.tool;
    case 'Stop': return payload.response ?? payload.preview;
    default: return '';
  }
}

/** matcher 是大小写敏感正则；省略 = 匹配全部；非法正则 = 静默不匹配（对齐 ZCode） */
function matchesMatcher(hook, event, payload) {
  if (!hook.matcher) return true;
  let re;
  try {
    re = new RegExp(hook.matcher);
  } catch {
    return false;
  }
  return re.test(String(matcherValue(event, payload) ?? ''));
}

/** 解析 stdout：JSON 对象按契约取字段；非 JSON 文本整体当 message（decision 不设） */
function parseHookStdout(stdout, warnings) {
  const text = String(stdout || '').trim();
  if (!text) return {};
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { message: text };
  }
  if (!isPlainObject(obj)) return { message: text };

  const out = {};
  if (obj.decision !== undefined) {
    if (obj.decision === 'allow' || obj.decision === 'deny' || obj.decision === 'ask') {
      out.decision = obj.decision;
    } else {
      warnings.push(t('Hook 返回非法 decision {value}，已忽略', { value: JSON.stringify(obj.decision) }));
    }
  }
  if (typeof obj.message === 'string' && obj.message.trim()) out.message = obj.message;
  if (typeof obj.context === 'string' && obj.context.trim()) out.context = obj.context;
  if (obj.args !== undefined) {
    if (isPlainObject(obj.args)) out.args = obj.args;
    else warnings.push(t('Hook 返回的 args 不是对象，已忽略'));
  }
  return out;
}

/** 按字节上限收集流输出；超出部分丢弃并标记 truncated（继续消费管道，避免子进程阻塞） */
function createByteCapture(limit) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (bytes >= limit) {
        truncated = true;
        return;
      }
      const remain = limit - bytes;
      if (buf.length > remain) {
        chunks.push(buf.subarray(0, remain));
        bytes = limit;
        truncated = true;
      } else {
        chunks.push(buf);
        bytes += buf.length;
      }
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    get truncated() {
      return truncated;
    }
  };
}

/**
 * 默认 runner：shell 执行 hook 命令，stdin 写 JSON，按 timeout 杀进程树。
 * Windows 下 PATH 前置 C:\Windows\System32;C:\Windows;（与 shell.mjs 同教训，避免 Git Bash 工具抢占）。
 * 返回 { code, stdout, stderr, ms, timedOut?, stdoutTruncated?, stderrTruncated?, error? }
 */
function defaultRunner(command, { input, cwd, timeoutMs, maxOutputBytes } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const cmd = String(command || '');
    const limit = clampInt(maxOutputBytes, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);
    const timeout = clampInt(timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    if (!cmd.trim()) {
      resolve({ code: 1, stdout: '', stderr: '', error: t('命令为空'), ms: 0 });
      return;
    }

    const isWin = process.platform === 'win32';
    const env = { ...process.env };
    if (isWin) {
      const sys = 'C:\\Windows\\System32;C:\\Windows;';
      const old = env.PATH || env.Path || '';
      env.PATH = sys + old;
      env.Path = env.PATH;
    }

    const outCap = createByteCapture(limit);
    const errCap = createByteCapture(limit);
    let proc;
    try {
      proc = spawn(cmd, {
        shell: true,
        cwd: cwd && existsSync(String(cwd)) ? String(cwd) : undefined,
        windowsHide: isWin,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) {
      resolve({
        code: 1, stdout: '', stderr: String((e && e.message) || e),
        error: String((e && e.message) || e), ms: Date.now() - started
      });
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: extra.code,
        stdout: outCap.text(),
        stderr: errCap.text(),
        ms: Date.now() - started,
        stdoutTruncated: outCap.truncated,
        stderrTruncated: errCap.truncated,
        ...extra
      });
    };

    proc.stdout?.on('data', (d) => outCap.push(d));
    proc.stderr?.on('data', (d) => errCap.push(d));
    proc.on('error', (e) => finish({ code: 1, error: String((e && e.message) || e) }));
    proc.on('close', (code) => finish({ code: code == null ? 1 : code }));

    timer = setTimeout(() => {
      try {
        if (isWin && proc.pid) {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      } catch { /* 已退出 */ }
      // 不等子树 close，避免孙进程占住管道导致 hook 调用悬挂（同 shell.mjs 的教训）
      finish({ code: 124, timedOut: true, error: t('超时 {ms}ms', { ms: timeout }) });
    }, timeout);

    try {
      proc.stdin?.on('error', () => { /* 子进程提前退出：忽略 EPIPE */ });
      proc.stdin?.end(JSON.stringify(input ?? {}));
    } catch { /* stdin 不可用 */ }
  });
}

/**
 * 执行一次生命周期事件。
 * @param {string} event HOOK_EVENTS 之一
 * @param {object} payload 已合并的会话上下文（sessionId/cwd/tool/args/prompt ...）
 * @param {{cwd?:string, config?:object, runner?:Function}} [options]
 *   runner 可注入：async (command, {input, event, cwd, timeoutMs, maxOutputBytes}) => {code,stdout,stderr,...}
 * @returns {Promise<{ok:boolean, decision:'allow'|'deny'|'ask', messages:string[], context?:string,
 *   args?:object, outputs:Array<{event:string,command:string,code:number,ms:number,stdout:string,stderr:string}>,
 *   warnings:string[], errors:string[]}>}
 */
export async function runHookEvent(event, payload = {}, { cwd, config, runner } = {}) {
  const eventName = String(event || '');
  if (!HOOK_EVENTS.includes(eventName)) {
    return {
      ok: true, decision: 'allow', messages: [], outputs: [],
      warnings: [t('未知 hook 事件 "{event}"，已忽略', { event: eventName })], errors: []
    };
  }

  const cfg = normalizeConfig(config ?? loadHooksConfig(), []);
  if (!cfg.enabled) return allowResult();
  const hooks = cfg.events[eventName] || [];
  if (!hooks.length) return allowResult();

  const payloadObj = isPlainObject(payload) ? payload : {};
  const spawnCwd = cwd || payloadObj.cwd || null;
  // payload 原样合并；event/sessionId/cwd 有缺省值（payload 显式值优先，event 固定）
  const baseInput = {
    ...payloadObj,
    event: eventName,
    sessionId: payloadObj.sessionId ?? null,
    cwd: payloadObj.cwd ?? cwd ?? process.cwd()
  };

  const outputs = [];
  const messages = [];
  const warnings = [];
  const errors = [];
  let decision = 'allow';
  let carry = null;   // 上一个 hook 的 context
  let argsOut = null; // 各 hook 返回的 args 浅合并

  for (const hook of hooks) {
    if (!matchesMatcher(hook, eventName, payloadObj)) continue;

    const command = hook.command;
    const timeoutMs = clampInt(hook.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, cfg.timeoutMs);
    const input = carry === null ? { ...baseInput } : { ...baseInput, hookContext: carry };
    const started = Date.now();

    let res;
    try {
      const run = typeof runner === 'function' ? runner : defaultRunner;
      res = await run(command, {
        input,
        event: eventName,
        cwd: spawnCwd,
        timeoutMs,
        maxOutputBytes: cfg.maxOutputBytes
      });
    } catch (e) {
      res = { code: 1, stdout: '', stderr: '', error: String((e && e.message) || e), ms: Date.now() - started };
    }
    if (!isPlainObject(res)) {
      res = { code: 1, stdout: '', stderr: '', error: t('runner 未返回结果'), ms: Date.now() - started };
    }

    const rawCode = res.code;
    const code = rawCode == null || !Number.isFinite(Number(rawCode)) ? 1 : Number(rawCode);
    const ms = Number.isFinite(Number(res.ms)) ? Number(res.ms) : Date.now() - started;
    const stdout = String(res.stdout ?? '');
    const stderr = String(res.stderr ?? '');
    outputs.push({ event: eventName, command, code, ms, stdout, stderr });

    if (res.error || res.timedOut || code !== 0) {
      const reason = res.timedOut
        ? t('超时（{ms}ms）已终止', { ms: timeoutMs })
        : res.error
          ? t('执行错误：{error}', { error: res.error })
          : t('退出码 {code}', { code });
      errors.push(t('[{event}] {command}：{reason}', { event: eventName, command, reason }));
      if (FAIL_CLOSED_EVENTS.has(eventName)) {
        messages.push(t('Hook 执行失败（fail-closed）：{reason}', { reason }));
        decision = 'deny';
        break; // 安全闸失败：不再运行后续 hook
      }
      warnings.push(t('Hook 执行失败（fail-open，已放行）：{reason}', { reason }));
      continue;
    }

    if (res.stdoutTruncated) {
      warnings.push(t('Hook 输出超过上限 {limit} bytes，已截断', { limit: cfg.maxOutputBytes }));
    }
    if (res.stderrTruncated) {
      warnings.push(t('Hook stderr 超过上限 {limit} bytes，已截断', { limit: cfg.maxOutputBytes }));
    }

    const parsed = parseHookStdout(stdout, warnings);
    if (parsed.message) messages.push(parsed.message);
    if (parsed.context !== undefined) carry = parsed.context;
    if (parsed.args) argsOut = { ...(argsOut || {}), ...parsed.args };
    if (parsed.decision === 'deny') {
      decision = 'deny';
      break; // deny 已定局，后续 hook 不再需要执行
    }
    if (parsed.decision === 'ask') decision = 'ask';
  }

  const result = {
    ok: errors.length === 0,
    decision,
    messages,
    outputs,
    warnings,
    errors
  };
  if (carry !== null) result.context = carry;
  if (argsOut) result.args = argsOut;
  return result;
}
