// 诊断包：把环境/配置/路径信息汇总成可导出的 JSON。
// 硬规则：apiKey 一律替换为 '***'，日志/字符串里出现的密钥也要抹掉，绝不把原文写进诊断文件。
import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SECRET_KEY_RE = /^(api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token)$/i;
const MAX_DEPTH = 12;
const MAX_LOG_TAIL_BYTES = 512 * 1024;

const isSecretKey = (key) => SECRET_KEY_RE.test(String(key));

/** 深度遍历配置，把 apiKey 类字段的值替换为 '***'（不修改原对象，循环引用安全）。 */
export function redactConfig(config) {
  const seen = new WeakMap();
  const walk = (value, depth) => {
    if (depth > MAX_DEPTH) return '[truncated]';
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.set(value, true);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) ? '***' : walk(v, depth + 1);
    }
    return out;
  };
  if (!config || typeof config !== 'object') return {};
  return walk(config, 0);
}

/** 收集配置里所有 apiKey 类字段的原文，用于后续全文抹除（日志、错误信息等）。 */
export function collectApiKeys(config) {
  const out = [];
  const seen = new WeakMap();
  const walk = (value, depth) => {
    if (depth > MAX_DEPTH || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.set(value, true);
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k) && v != null && typeof v !== 'object') {
        const s = String(v);
        if (s.trim()) out.push(s);
      } else {
        walk(v, depth + 1);
      }
    }
  };
  walk(config, 0);
  return out;
}

/** 把字符串中的已知密钥 + 常见 sk-/Bearer 令牌替换为 '***'。 */
export function scrubSecrets(text, secrets = []) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    if (out.includes(secret)) out = out.split(secret).join('***');
  }
  return out
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '***');
}

function deepScrub(value, secrets, depth = 0, seen = new WeakMap()) {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, secrets, depth + 1, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.set(value, true);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepScrub(v, secrets, depth + 1, seen);
    return out;
  }
  return value;
}

/** 读取日志末尾 limit 条非空行；文件不存在/不可读返回 []（诊断导出不应因此失败）。 */
export async function readLastErrors(logFile, { limit = 5, secrets = [] } = {}) {
  if (!logFile) return [];
  let text;
  try {
    const st = await stat(logFile);
    if (!st.isFile()) return [];
    const size = Math.min(st.size, MAX_LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size);
    const fh = await open(logFile, 'r');
    try {
      await fh.read(buf, 0, size, st.size - size);
    } finally {
      await fh.close();
    }
    text = buf.toString('utf8');
  } catch {
    return [];
  }
  const max = Math.max(1, Math.floor(Number(limit)) || 5);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-max).map((line) => scrubSecrets(line.slice(0, 500), secrets));
}

/** 与 hooks.mjs 一致的默认 hooks 配置路径（仅用于诊断包展示）。 */
export function hooksFilePath() {
  const envFile = process.env.FINALCHECK_HOOKS_FILE;
  if (envFile && envFile.trim()) return path.resolve(envFile.trim());
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'FinalCheck', 'hooks.json');
  }
  return path.join(os.homedir(), 'FinalCheck', 'hooks.json');
}

const nameOf = (p) => (typeof p === 'string' ? p : String(p?.name ?? '')).trim();

/**
 * 组装诊断包（纯函数，不碰磁盘/electron，便于单测）。
 * 入参：{ appVersion, electron, node, platform, arch, config, providers, activeModel,
 *        sessionCount, lastErrors, files: { usage, hooks, sessionsDir } }
 */
export function buildDiagnostics(input = {}) {
  const config = redactConfig(input.config);
  const secrets = collectApiKeys(input.config);
  const providers = Array.isArray(input.providers)
    ? input.providers.map(nameOf).filter(Boolean)
    : ((config.providers || []).map(nameOf).filter(Boolean));
  const activeModel = input.activeModel != null
    ? String(input.activeModel)
    : String(config.activeModel || '');
  const files = {
    usage: String(input.files?.usage || ''),
    hooks: String(input.files?.hooks || ''),
    sessionsDir: String(input.files?.sessionsDir || '')
  };
  const lastErrors = Array.isArray(input.lastErrors)
    ? input.lastErrors.map((x) => scrubSecrets(String(x), secrets))
    : [];
  const count = Number(input.sessionCount);
  const result = {
    appVersion: String(input.appVersion ?? ''),
    electron: String(input.electron ?? ''),
    node: String(input.node ?? ''),
    platform: String(input.platform ?? ''),
    arch: String(input.arch ?? ''),
    config,
    providers,
    activeModel,
    sessionCount: Number.isFinite(count) ? count : 0,
    lastErrors,
    files
  };
  return deepScrub(result, secrets);
}
