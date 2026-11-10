// 策略沙箱（A 档）模块层：能力边界的纯函数实现，先不接线。
// 后续接入点：read_file / edit_file / write_file 的路径，run_command 的命令与 cwd。
// 设计原则：
//  - 路径先按目标平台解析/规范化，再做包含判断；不拿原始字符串 startsWith 当唯一判据。
//  - 敏感路径在任何模式（含 off / full access）都拒绝；full access 不是审批豁免。
//  - 拒绝记录只保留 tool / target / reason / at，绝不夹带环境变量值或密钥值。
//  - 命令侧只做黑名单 + 要求 cwd 走路径检查；不从命令文本里猜绝对路径（误报会挡正常审计）。
//  - 环境变量按“名字”判定：命中密钥语义即剥除，removed 只记名字，不记值。

import os from 'node:os';
import path from 'node:path';

export const POLICY_MODES = Object.freeze(['workspace', 'readonly', 'off']);

const DEFAULT_TOOL = 'read';
const TOOL_MAX_LEN = 60;

// 敏感文件名：任何位置出现都拒绝（含 .pub，避免把公钥当安全白名单）
const PRIVATE_KEY_BASENAMES = Object.freeze([
  'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub'
]);

// 环境变量白名单：名字精确匹配；LC_* 按前缀匹配。
// 注意：NODE_OPTIONS 可用 --require 注入代码，刻意不在白名单里（见 DANGEROUS_ENV_NAMES）。
const SAFE_ENV_NAMES = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
  'SYSTEMROOT', 'COMSPEC', 'LANG', 'TERM'
]);
const SAFE_ENV_PREFIXES = Object.freeze(['LC_']);
const DANGEROUS_ENV_NAMES = new Set(['NODE_OPTIONS']);
const SENSITIVE_ENV_NAME_RE = /(key|token|secret|password|passwd|pwd|credential|auth|apikey|access_key)/i;

const isWinPlatform = (platform) => platform === 'win32';
const pathApiFor = (platform) => (isWinPlatform(platform) ? path.win32 : path.posix);

function readEnv(env, name, caseInsensitive) {
  if (!env || typeof env !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(env, name) && env[name] != null) return String(env[name]);
  if (!caseInsensitive) return null;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper && env[key] != null) return String(env[key]);
  }
  return null;
}

// 去掉末尾分隔符；保留盘符根（C:\）与 POSIX 根（/）
function trimTrailingSep(pathApi, value) {
  const sep = pathApi.sep;
  let out = value;
  while (out.length > 1 && out.endsWith(sep)) {
    if (pathApi === path.win32 && out.length <= 3) break;
    out = out.slice(0, -1);
  }
  return out;
}

function expandTilde(value, homeDir, pathApi) {
  if (!homeDir) return value;
  if (value === '~') return homeDir;
  if (/^~[/\\]/.test(value)) {
    const rest = value.slice(2);
    return rest ? pathApi.join(homeDir, rest) : homeDir;
  }
  return value;
}

function normalizeRoot(pathApi, value, base, homeDir) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const expanded = expandTilde(trimmed, homeDir, pathApi);
  let abs;
  if (pathApi.isAbsolute(expanded)) abs = expanded;
  else if (base) abs = pathApi.join(base, expanded);
  else abs = pathApi.resolve(expanded);
  return trimTrailingSep(pathApi, pathApi.normalize(abs));
}

// 目标路径：绝对路径直接规范化；相对路径按项目根解析（tools 传相对路径时行为可预期）
function normalizeTarget(policy, raw) {
  const pathApi = pathApiFor(policy.platform);
  const expanded = expandTilde(raw, policy.homeDir, pathApi);
  let abs;
  if (pathApi.isAbsolute(expanded)) abs = expanded;
  else if (policy.projectPath) abs = pathApi.join(policy.projectPath, expanded);
  else abs = pathApi.resolve(expanded);
  return trimTrailingSep(pathApi, pathApi.normalize(abs));
}

// 规范化后的包含判断：先解析再比较；Windows 大小写不敏感，POSIX 区分大小写。
function isInside(pathApi, root, target, caseInsensitive) {
  const sep = pathApi.sep;
  let r = trimTrailingSep(pathApi, pathApi.normalize(root));
  let t = trimTrailingSep(pathApi, pathApi.normalize(target));
  if (caseInsensitive) {
    r = r.toLowerCase();
    t = t.toLowerCase();
  }
  if (r === t) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

function samePath(platform, a, b) {
  const pathApi = pathApiFor(platform);
  const x = trimTrailingSep(pathApi, pathApi.normalize(a));
  const y = trimTrailingSep(pathApi, pathApi.normalize(b));
  return x === y || (isWinPlatform(platform) && x.toLowerCase() === y.toLowerCase());
}

function sanitizeTool(tool) {
  const text = String(tool == null || tool === '' ? DEFAULT_TOOL : tool)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, TOOL_MAX_LEN);
  return text || DEFAULT_TOOL;
}

// 拒绝记录固定四字段：tool / target / reason / at（target 只放路径本身）
function makeRecord(tool, target, reason) {
  return {
    tool: sanitizeTool(tool),
    target: String(target == null ? '' : target),
    reason,
    at: new Date().toISOString()
  };
}

function deny(tool, target, reason) {
  return { ok: false, reason, record: makeRecord(tool, target, reason) };
}

/**
 * 创建策略快照。
 * 额外测试接缝（不影响主 API）：
 *   platform —— 模拟 win32 / posix（默认 process.platform）
 *   env      —— 读取 APPDATA / USERPROFILE / HOME 的环境快照（默认 process.env）
 *   home     —— 显式 home 目录（默认从 env 推导）
 */
export function createPolicy({
  projectPath = null,
  mode = 'workspace',
  allowPaths = [],
  platform = process.platform,
  env = process.env,
  home = null
} = {}) {
  if (!POLICY_MODES.includes(mode)) {
    throw new Error(`未知策略模式：${mode}（允许 ${POLICY_MODES.join(' / ')}）`);
  }
  if (projectPath != null && typeof projectPath !== 'string') {
    throw new TypeError('projectPath 必须是字符串');
  }
  if (!Array.isArray(allowPaths)) throw new TypeError('allowPaths 必须是数组');
  if (platform != null && typeof platform !== 'string') throw new TypeError('platform 必须是字符串');

  const effectivePlatform = isWinPlatform(platform) ? 'win32' : 'posix';
  const pathApi = pathApiFor(effectivePlatform);
  const envSnapshot = env && typeof env === 'object' ? env : {};

  let homeDir = typeof home === 'string' && home.trim()
    ? normalizeRoot(pathApi, home, null, null)
    : null;
  if (!homeDir) {
    const homeKey = isWinPlatform(effectivePlatform) ? 'USERPROFILE' : 'HOME';
    const homeValue = readEnv(envSnapshot, homeKey, isWinPlatform(effectivePlatform));
    if (homeValue) homeDir = normalizeRoot(pathApi, homeValue, null, null);
  }
  if (!homeDir) {
    const fallback = os.homedir();
    if (fallback) homeDir = normalizeRoot(pathApi, fallback, null, null);
  }

  const project = projectPath != null ? normalizeRoot(pathApi, projectPath, null, homeDir) : null;
  const allow = [];
  for (const entry of allowPaths) {
    if (typeof entry !== 'string') throw new TypeError('allowPaths 的每一项都必须是字符串');
    const normalized = normalizeRoot(pathApi, entry, project, homeDir);
    if (normalized) allow.push(normalized);
  }

  const roots = [];
  const pushRoot = (value) => {
    if (!value) return;
    if (roots.some((root) => samePath(effectivePlatform, root, value))) return;
    roots.push(value);
  };
  pushRoot(project);
  for (const entry of allow) pushRoot(entry);

  const sensitiveDirs = [];
  const sensitiveFiles = [];

  // %APPDATA%\FinalCheck\**：含 config.json / projects.json / hooks.json
  const appdataValue = readEnv(envSnapshot, 'APPDATA', true);
  if (appdataValue) {
    const appdata = normalizeRoot(pathApi, appdataValue, null, homeDir);
    if (appdata) {
      sensitiveDirs.push({
        path: trimTrailingSep(pathApi, pathApi.normalize(pathApi.join(appdata, 'FinalCheck'))),
        label: 'APPDATA/FinalCheck'
      });
    }
  }

  if (homeDir) {
    const addDir = (name, label) => {
      sensitiveDirs.push({
        path: trimTrailingSep(pathApi, pathApi.normalize(pathApi.join(homeDir, name))),
        label
      });
    };
    addDir('.ssh', 'SSH 密钥目录');
    addDir('.aws', 'AWS 凭据目录');
    addDir('.gnupg', 'GnuPG 密钥目录');
    sensitiveFiles.push({
      path: trimTrailingSep(pathApi, pathApi.normalize(pathApi.join(homeDir, '.git-credentials'))),
      label: 'Git 凭据文件'
    });
  }

  const keyBasenames = isWinPlatform(effectivePlatform)
    ? PRIVATE_KEY_BASENAMES.map((name) => name.toLowerCase())
    : [...PRIVATE_KEY_BASENAMES];

  return Object.freeze({
    mode,
    platform: effectivePlatform,
    projectPath: project,
    allowPaths: Object.freeze(allow),
    roots: Object.freeze(roots),
    homeDir,
    sensitive: Object.freeze({
      dirs: Object.freeze(sensitiveDirs),
      files: Object.freeze(sensitiveFiles),
      keyBasenames: Object.freeze(keyBasenames)
    })
  });
}

function detectSensitive(policy, normalized) {
  const pathApi = pathApiFor(policy.platform);
  const caseInsensitive = isWinPlatform(policy.platform);

  const dirs = Array.isArray(policy.sensitive?.dirs) ? policy.sensitive.dirs : [];
  for (const item of dirs) {
    if (item && typeof item.path === 'string'
      && isInside(pathApi, item.path, normalized, caseInsensitive)) {
      return item.label || '敏感目录';
    }
  }

  const files = Array.isArray(policy.sensitive?.files) ? policy.sensitive.files : [];
  for (const item of files) {
    if (item && typeof item.path === 'string'
      && samePath(policy.platform, item.path, normalized)) {
      return item.label || '敏感文件';
    }
  }

  const base = pathApi.basename(normalized);
  const target = caseInsensitive ? base.toLowerCase() : base;
  const keys = Array.isArray(policy.sensitive?.keyBasenames) ? policy.sensitive.keyBasenames : [];
  if (keys.includes(target)) return 'SSH 私钥文件';

  return null;
}

/**
 * 路径能力检查。
 * 返回 { ok:true, path } 或 { ok:false, reason, record:{tool,target,reason,at} }。
 * 判定顺序：策略有效性 → 路径规范化 → 敏感路径 → readonly 写 → 项目边界。
 */
export function assertPathAllowed(policy, absPath, { write = false, tool = DEFAULT_TOOL } = {}) {
  if (!policy || typeof policy !== 'object' || !POLICY_MODES.includes(policy.mode)) {
    return deny(tool, absPath, '策略对象无效');
  }
  if (typeof absPath !== 'string' || absPath.trim() === '') {
    return deny(tool, absPath, typeof absPath === 'string' ? '路径为空' : '路径无效');
  }

  let normalized;
  try {
    normalized = normalizeTarget(policy, absPath);
  } catch {
    return deny(tool, absPath, '路径无效');
  }
  if (!normalized) return deny(tool, absPath, '路径无效');

  const sensitive = detectSensitive(policy, normalized);
  if (sensitive) return deny(tool, normalized, `敏感路径禁止访问（${sensitive}）`);

  if (write && policy.mode === 'readonly') {
    return deny(tool, normalized, '只读模式禁止写入');
  }

  if (policy.mode !== 'off') {
    const roots = Array.isArray(policy.roots) ? policy.roots : [];
    if (roots.length === 0) return deny(tool, normalized, '策略未设置项目目录');
    const pathApi = pathApiFor(policy.platform);
    const caseInsensitive = isWinPlatform(policy.platform);
    const inside = roots.some(
      (root) => typeof root === 'string' && isInside(pathApi, root, normalized, caseInsensitive)
    );
    if (!inside) return deny(tool, normalized, '路径不在项目边界内');
  }

  return { ok: true, path: normalized };
}

/**
 * cwd 检查：workspace / readonly 下必须在 projectPath 或 allowPaths 内；off 只关项目边界。
 * 未传 cwd 时默认落到 projectPath（无项目根则 off 放行、受限模式拒绝）。
 * 返回结构与 assertPathAllowed 一致。
 */
export function assertCwd(policy, cwd) {
  const tool = 'cwd';
  if (!policy || typeof policy !== 'object' || !POLICY_MODES.includes(policy.mode)) {
    return deny(tool, cwd, '策略对象无效');
  }
  if (cwd == null || (typeof cwd === 'string' && cwd.trim() === '')) {
    if (policy.mode === 'off') return { ok: true, path: null };
    if (policy.projectPath) return { ok: true, path: policy.projectPath };
    return deny(tool, cwd, '策略未设置项目目录');
  }
  return assertPathAllowed(policy, cwd, { write: false, tool });
}

// ---- 命令黑名单 ----
// 只拒绝灾难级命令；不做“从命令里抽绝对路径”的启发式（误报会挡正常审计）。
// 路径安全靠 assertCwd + 工具层 write:true。
function stripCommandWrapper(segment) {
  let out = segment.trim();
  for (let i = 0; i < 5; i++) {
    const before = out;
    out = out.replace(/^(?:sudo|doas|command)\s+/i, '');
    out = out.replace(/^env\s+/i, '');
    out = out.replace(/^(?:cmd(?:\.exe)?\s+\/[ck]\s+|call\s+)/i, '');
    out = out.replace(/^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-[a-z]+\s+)+/i, '');
    out = out.replace(/^(?:bash|sh|zsh|dash|ksh)(?:\.exe)?\s+-c\s+/i, '');
    out = out.replace(/^["']+/, '');
    out = out.trim();
    if (out === before) break;
  }
  return out;
}

function commandSegments(command) {
  return command
    .split(/&&|\|\||[;|&\n\r]/)
    .map(stripCommandWrapper)
    .filter(Boolean);
}

const COMMAND_RULES = Object.freeze([
  {
    name: 'format-disk',
    test: (seg) => /\bformat(?:\.com)?(?:\s+\/[^\s]+)*\s+[a-z]:/i.test(seg)
      || /^["']?format(?:\.com)?["']?(?:\s+\/[^\s]+)*\s*$/i.test(seg)
  },
  { name: 'format-volume', test: (seg) => /\bformat-volume\b/i.test(seg) },
  {
    name: 'del-recursive',
    test: (seg) => /^(?:del|erase)(?:\.exe)?(?:\s|$)/i.test(seg)
      && /(?:^|\s)\/s(?:\s|$)/i.test(seg)
  },
  {
    name: 'del-force',
    test: (seg) => /^(?:del|erase)(?:\.exe)?(?:\s|$)/i.test(seg)
      && /(?:^|\s)\/q(?:\s|$)/i.test(seg)
  },
  {
    name: 'rd-recursive',
    test: (seg) => /^(?:rd|rmdir)(?:\.exe)?(?:\s|$)/i.test(seg)
      && /(?:^|\s)\/s(?:\s|$)/i.test(seg)
  },
  { name: 'remove-item-recurse', test: (seg) => /\bremove-item\b[^\n]*\s-recurse\b/i.test(seg) },
  { name: 'reg-delete', test: (seg) => /\breg(?:\.exe)?\s+delete\b/i.test(seg) },
  { name: 'bcdedit', test: (seg) => /\bbcdedit(?:\.exe)?\b/i.test(seg) },
  { name: 'diskpart', test: (seg) => /\bdiskpart(?:\.exe)?\b/i.test(seg) },
  { name: 'netsh-firewall', test: (seg) => /\bnetsh(?:\.exe)?\s+(?:adv)?firewall\b/i.test(seg) },
  { name: 'shutdown', test: (seg) => /^(?:shutdown|shutdown\.exe)(?:\s|$)/i.test(seg) },
  { name: 'logoff', test: (seg) => /^(?:logoff|logoff\.exe)(?:\s|$)/i.test(seg) },
  { name: 'cipher-wipe', test: (seg) => /\bcipher(?:\.exe)?\s+\/w(?:\s|$)/i.test(seg) },
  { name: 'takeown-force', test: (seg) => /\btakeown(?:\.exe)?\s+\/f(?:\s|$)/i.test(seg) },
  { name: 'icacls-grant', test: (seg) => /\bicacls(?:\.exe)?\b[^\n]*\/grant\b/i.test(seg) },
  {
    name: 'rm-recursive',
    test: (seg) => /\brm\s+(?:-[a-zA-Z]+\s+)*(?:-rf|-fr|-[rf]\s+-[rf])\b/i.test(seg)
  }
]);

/**
 * 命令黑名单检查（所有模式都生效；readonly 的写类拦截由工具层 write:true 负责）。
 * 返回 { ok:true } 或 { ok:false, reason, matchedRule }。
 * 不把命令文本放进 reason/record，避免命令行里的 token 落到日志。
 */
export function checkCommand(policy, command) {
  void policy; // 命令规则与模式无关；保留参数位以便后续按模式扩展
  if (typeof command !== 'string') {
    return { ok: false, reason: '命令必须是字符串', matchedRule: 'invalid-command' };
  }
  const cmd = command.trim();
  if (!cmd) return { ok: true };

  const segments = commandSegments(cmd);
  for (const rule of COMMAND_RULES) {
    if (segments.some((seg) => rule.test(seg))) {
      return { ok: false, reason: `命令命中安全黑名单：${rule.name}`, matchedRule: rule.name };
    }
  }
  return { ok: true };
}

// ---- 环境变量 ----
/** 名字是否属于“必须剥除”的变量（只判名字，不碰值）。 */
export function checkEnvVarName(name) {
  if (typeof name !== 'string' || !name) return false;
  const upper = name.toUpperCase();
  if (SAFE_ENV_NAMES.has(upper)) return false;
  if (SAFE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) return false;
  if (DANGEROUS_ENV_NAMES.has(upper)) return true;
  return SENSITIVE_ENV_NAME_RE.test(name);
}

/**
 * 剥除敏感环境变量：返回 { env, removed }，removed 只放变量名，绝不放值。
 * 不修改入参。
 */
export function scrubEnv(env = process.env) {
  const removed = [];
  const clean = {};
  if (!env || typeof env !== 'object') return { env: clean, removed };

  for (const [name, value] of Object.entries(env)) {
    if (checkEnvVarName(name)) {
      removed.push(name);
      continue;
    }
    if (name === '__proto__') {
      Object.defineProperty(clean, name, {
        value, enumerable: true, configurable: true, writable: true
      });
    } else {
      clean[name] = value;
    }
  }
  return { env: clean, removed };
}
