// 策略沙箱（A 档）模块层：能力边界的纯函数实现，先不接线。
// 后续接入点：read_file / edit_file / write_file 的路径，run_command 的命令与 cwd。
// 设计原则：
//  - 路径先按目标平台解析/规范化，再做包含判断；不拿原始字符串 startsWith 当唯一判据。
//  - 敏感路径在任何模式（含 off / full access）都拒绝；full access 不是审批豁免。
//  - 拒绝记录只保留 tool / target / reason / at，绝不夹带环境变量值或密钥值。
//  - 命令侧只做黑名单 + 要求 cwd 走路径检查；除「删除/改名类命令带字面绝对路径」这一种
//    高置信情形外，不从命令文本里猜绝对路径（误报会挡正常审计）。
//  - 环境变量按“名字”判定：命中密钥语义即剥除，removed 只记名字，不记值。

import os from 'node:os';
import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { t } from '../renderer/i18n/core.mjs';

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
  let tgt = trimTrailingSep(pathApi, pathApi.normalize(target));
  if (caseInsensitive) {
    r = r.toLowerCase();
    tgt = tgt.toLowerCase();
  }
  if (r === tgt) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return tgt.startsWith(prefix);
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

// 0.33.9：matchedRule 让工具层分得清「可以问用户」（敏感 / 项目外）和「不能问」（只读、路径无效）
function deny(tool, target, reason, matchedRule = undefined) {
  return { ok: false, reason, record: makeRecord(tool, target, reason), ...(matchedRule ? { matchedRule, target } : {}) };
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
    throw new Error(t('未知策略模式：{mode}（允许 {modes}）', { mode, modes: POLICY_MODES.join(' / ') }));
  }
  if (projectPath != null && typeof projectPath !== 'string') {
    throw new TypeError(t('projectPath 必须是字符串'));
  }
  if (!Array.isArray(allowPaths)) throw new TypeError(t('allowPaths 必须是数组'));
  if (platform != null && typeof platform !== 'string') throw new TypeError(t('platform 必须是字符串'));

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
    if (typeof entry !== 'string') throw new TypeError(t('allowPaths 的每一项都必须是字符串'));
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

  // 只读例外：工具超长结果的落盘目录（FINALCHECK_SPILL_DIR）。它在 %APPDATA%FinalCheck 下，
  // 但里面只有本应用写的工具输出——提示里让模型「去落盘文件里查」，读不到等于白给（0.26 模拟客户端测出）。
  // 只放行读，且只放行这一个子目录；config.json / projects.json 等仍按敏感路径拒绝。
  const readableDirs = [];
  const spillValue = readEnv(envSnapshot, 'FINALCHECK_SPILL_DIR', false);
  if (spillValue) {
    const spill = normalizeRoot(pathApi, spillValue, null, homeDir);
    if (spill) readableDirs.push(trimTrailingSep(pathApi, pathApi.normalize(spill)));
  }

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
    readableDirs: Object.freeze(readableDirs),
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
      return t(item.label || '敏感目录');
    }
  }

  const files = Array.isArray(policy.sensitive?.files) ? policy.sensitive.files : [];
  for (const item of files) {
    if (item && typeof item.path === 'string'
      && samePath(policy.platform, item.path, normalized)) {
      return t(item.label || '敏感文件');
    }
  }

  const base = pathApi.basename(normalized);
  const target = caseInsensitive ? base.toLowerCase() : base;
  const keys = Array.isArray(policy.sensitive?.keyBasenames) ? policy.sensitive.keyBasenames : [];
  if (keys.includes(target)) return t('SSH 私钥文件');

  return null;
}

/**
 * 路径能力检查。
 * 返回 { ok:true, path } 或 { ok:false, reason, record:{tool,target,reason,at} }。
 * 判定顺序：策略有效性 → 路径规范化 → 敏感路径 → readonly 写 → 项目边界。
 */
function canonicalPath(value, platform) {
  // Tests can model another platform; only the native filesystem can resolve its links.
  if (isWinPlatform(platform) !== (process.platform === 'win32')) return value;
  const api = pathApiFor(platform);
  const tail = [];
  let current = value;
  for (;;) {
    try {
      lstatSync(current); // A broken link must not be mistaken for a new file.
      return api.join(realpathSync.native(current), ...tail.reverse());
    } catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
      try { if (lstatSync(current).isSymbolicLink()) throw new Error('unresolvable link'); }
      catch (linkError) { if (linkError?.message === 'unresolvable link') throw linkError; }
      const parent = api.dirname(current);
      if (parent === current) throw e;
      tail.push(api.basename(current));
      current = parent;
    }
  }
}

/** 是否落在只读例外目录（工具结果落盘目录）里 */
function inReadableDir(policy, normalized, { real = false } = {}) {
  let dirs = Array.isArray(policy?.readableDirs) ? policy.readableDirs : [];
  // 比较真实路径时，例外目录本身也要解析成真实路径（8.3 短文件名 RUNNER~1、目录联接、符号链接都会让两边写法不同）
  if (real) dirs = dirs.map((d) => { try { return canonicalPath(d, policy.platform); } catch { return d; } });
  if (!dirs.length || typeof normalized !== 'string') return false;
  const pathApi = pathApiFor(policy.platform);
  const ci = isWinPlatform(policy.platform);
  return dirs.some((d) => isInside(pathApi, d, normalized, ci));
}

export function assertPathAllowed(policy, absPath, { write = false, tool = DEFAULT_TOOL } = {}) {
  if (!policy || typeof policy !== 'object' || !POLICY_MODES.includes(policy.mode)) {
    return deny(tool, absPath, t('策略对象无效'));
  }
  if (typeof absPath !== 'string' || absPath.trim() === '') {
    return deny(tool, absPath, typeof absPath === 'string' ? t('路径为空') : t('路径无效'));
  }

  let normalized;
  try {
    normalized = normalizeTarget(policy, absPath);
  } catch {
    return deny(tool, absPath, t('路径无效'));
  }
  if (!normalized) return deny(tool, absPath, t('路径无效'));

  // 只读例外（落盘目录）：读放行；真实路径（解析链接后）也必须仍在里面
  if (!write && inReadableDir(policy, normalized)) {
    let real;
    try { real = canonicalPath(normalized, policy.platform); } catch { return deny(tool, normalized, t('路径无法安全解析')); }
    if (inReadableDir(policy, real, { real: true })) return { ok: true, path: real };
  }

  const sensitive = detectSensitive(policy, normalized);
  if (sensitive) return deny(tool, normalized, t('敏感路径禁止访问（{item}）', { item: sensitive }), 'sensitive');

  if (write && policy.mode === 'readonly') {
    return deny(tool, normalized, t('只读模式禁止写入'));
  }

  if (policy.mode !== 'off') {
    const roots = Array.isArray(policy.roots) ? policy.roots : [];
    if (roots.length === 0) return deny(tool, normalized, t('策略未设置项目目录'));
    const pathApi = pathApiFor(policy.platform);
    const caseInsensitive = isWinPlatform(policy.platform);
    const inside = roots.some(
      (root) => typeof root === 'string' && isInside(pathApi, root, normalized, caseInsensitive)
    );
    if (!inside) return deny(tool, normalized, t('路径不在项目边界内'), 'outside');
  }
  let canonical;
  try { canonical = canonicalPath(normalized, policy.platform); }
  catch { return deny(tool, normalized, t('路径无法安全解析')); }
  const realSensitive = detectSensitive(policy, canonical);
  if (realSensitive) return deny(tool, canonical, t('敏感路径禁止访问（{item}）', { item: realSensitive }), 'sensitive');
  if (policy.mode !== 'off') {
    const api = pathApiFor(policy.platform);
    try {
      if (!policy.roots.some((root) => isInside(api, canonicalPath(root, policy.platform), canonical, isWinPlatform(policy.platform)))) {
        return deny(tool, canonical, t('路径不在项目边界内'), 'outside');
      }
    } catch { return deny(tool, normalized, t('路径无法安全解析')); }
  }
  return { ok: true, path: canonical };
}

/**
 * cwd 检查：workspace / readonly 下必须在 projectPath 或 allowPaths 内；off 只关项目边界。
 * 未传 cwd 时默认落到 projectPath（无项目根则 off 放行、受限模式拒绝）。
 * 返回结构与 assertPathAllowed 一致。
 */
export function assertCwd(policy, cwd) {
  const tool = 'cwd';
  if (!policy || typeof policy !== 'object' || !POLICY_MODES.includes(policy.mode)) {
    return deny(tool, cwd, t('策略对象无效'));
  }
  if (cwd == null || (typeof cwd === 'string' && cwd.trim() === '')) {
    if (policy.mode === 'off') return { ok: true, path: null };
    if (policy.projectPath) return { ok: true, path: policy.projectPath };
    return deny(tool, cwd, t('策略未设置项目目录'));
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
    // rm 递归+强制：拦「绝对路径目标」，放行「相对路径目标」。
    // 2026-11-17 两次修正：
    //   ① 原来只认小写 -rf，`rm -Rf /`、`rm -r -f /` 会漏网（-R 是 GNU rm 合法写法）；
    //   ② 但原来拦所有 rm -rf 会误伤 `rm -rf ./node_modules`（正常开发操作）。
    // 现在口径：递归 + 强制 **且** 目标是绝对路径（/、盘符、~、$HOME、%USERPROFILE%）→ 拦；
    // 相对路径（./dist、node_modules、src/old）→ 放行。相对路径只能删项目内的东西，风险有限。
    name: 'rm-recursive',
    test: (seg) => {
      if (!/\brm\b/.test(seg)) return false;
      // 拆出 rm 之后的所有 token，分清「选项」和「目标」
      const parts = seg.slice(seg.search(/\brm\b/)).split(/\s+/).slice(1);
      let recursive = false;
      let force = false;
      let target = '';
      for (const raw of parts) {
        const token = raw.replace(/^["']|["']$/g, '');
        if (!token) continue;
        if (token.startsWith('-')) {
          if (token === '--recursive') recursive = true;
          else if (token === '--force') force = true;
          else {
            // 短选项簇：-rf / -Rf / -fr / -r / -f
            if (/^-[a-zA-Z]+$/.test(token)) {
              if (token.includes('r') || token.includes('R')) recursive = true;
              if (token.includes('f')) force = true;
            }
          }
          continue;
        }
        if (!target) target = token; // 第一个非选项 = 目标
      }
      if (!recursive || !force || !target) return false;
      return /^(?:\/|~|[A-Za-z]:[\\/]|%USERPROFILE%|\$HOME)/.test(target);
    }
  },
  {
    // dd 写设备/整盘：`dd if=... of=/dev/sda`、`of=\\.\PhysicalDrive0`
    // 2026-11-17 补：之前完全没有 dd 规则，`dd if=/dev/zero of=/dev/sda` 被放行（实测漏网）。
    name: 'dd-device',
    test: (seg) => /\bdd\b[^\n]*\bof=(?:\/dev\/|\/proc\/|\\\\.\\|\/dev|sd[a-z]|hd[a-z]|nvme)/i.test(seg)
      || /\bdd\b[^\n]*\bof=[^\s]*(?:PhysicalDrive|physicaldrive)/i.test(seg)
  },
  {
    // 建文件系统：mkfs.* / mke2fs / mkdosfs / newfs
    name: 'mkfs',
    test: (seg) => /\b(?:mkfs(?:\.[a-z0-9]+)?|mke2fs|mkdosfs|newfs|mkswap)\b/i.test(seg)
  },
  {
    // 直接写块设备（cat > /dev/sda、tee /dev/sda 这类）：只认字面设备路径
    name: 'write-block-device',
    test: (seg) => /(?:>|\btee\b)[^\n]*\/(?:dev\/sd[a-z]|dev\/hd[a-z]|dev\/nvme\d|dev\/disk)/i.test(seg)
  }
]);

/**
 * 命令黑名单检查（所有模式都生效；readonly 的写类拦截由工具层 write:true 负责）。
 * 返回 { ok:true } 或 { ok:false, reason, matchedRule }。
 * 不把命令文本放进 reason/record，避免命令行里的 token 落到日志。
 */
export function checkCommand(policy, command) {
  if (policy?.mode === 'readonly') return { ok: false, reason: t('只读模式禁止执行命令'), matchedRule: 'readonly' };
  if (typeof command !== 'string') {
    return { ok: false, reason: t('命令必须是字符串'), matchedRule: 'invalid-command' };
  }
  const cmd = command.trim();
  if (!cmd) return { ok: true };

  const segments = commandSegments(cmd);
  for (const rule of COMMAND_RULES) {
    if (segments.some((seg) => rule.test(seg))) {
      return { ok: false, reason: t('命令命中安全黑名单：{rule}', { rule: rule.name }), matchedRule: rule.name };
    }
  }
  return { ok: true };
}

// 删除/改名类命令的目标检查（只认字面绝对路径，不猜变量/通配符）。
// 为什么需要：WRITE_RESTRICTED 令牌只过滤写权限位，DELETE 不在其中——实测沙箱里
// `del "项目外文件"` 能删成功（`del /f`、PowerShell Remove-Item 反而被拒），
// 所以这条必须在应用层兜住：目标解析到项目外，整条命令拒绝。
//
// 2026-11-17（关沙箱后补）：head 里**加了 rm**。原来只认 cmd 的 del/erase/rd 与
// PowerShell 的 remove-item，bash 的 `rm`、GNU 系的 `unlink` 完全不在检查范围——
// 而沙箱默认关闭后 `rm` 就是主要删除手段。这是真缺口，不只是配置问题。
const DESTRUCTIVE_HEAD = /^["']?(del|erase|rd|rmdir|remove-item|ri|move-item|mv|ren|rename|rm|unlink|shred)(?:\.exe)?["']?(?:\s|$)/i;
const POWERSHELL_INNER = /(?:-command|-c)\s+"(.+)"$/i;

/**
 * 从命令文本里抽出「可能的文件路径」，用于过敏感/边界闸。
 *
 * 认三种写法：
 *   ① 引号内的整段（`"C:\x\y"`、`'~/a'`）
 *   ② Windows 盘符绝对路径（`C:\x`、`D:/y`）
 *   ③ **波浪号与家目录变量**（`~/x`、`~/.ssh`、`$HOME/x`、`${HOME}/x`、`%USERPROFILE%\x`）
 *
 * ③ 是 2026-11-16 补的，直接原因是这一天宿主机 shell 从 cmd 换成了 Git Bash：
 * cmd 里 `~` 不展开（无害），bash 里 `~` 会真展开成 `/c/Users/x`。于是
 * `rm -rf ~/.ssh`、`cat ~/.ssh/id_rsa` 这类命令以前拦不住——实测全部放行。
 * 这条闸必须先把 `~` 展开成绝对路径，才能命中 policy.sensitive.dirs。
 *
 * 仍然不猜：含通配符 `*` / `?`、以及无法静态展开的 `$VAR` 一律跳过，
 * 留给黑名单与审批兜底（运行时拼路径静态拦不住，这条上限写在模块注释里）。
 */
function literalPathsIn(text) {
  const found = [];
  // ③ 家目录写法：必须是**词首**的 ~ / $HOME / ${HOME} / %USERPROFILE%。
  //
  // 边界很重要：2026-11-16 第一版用的是无边界正则 /~|.../，结果把 Windows 的
  // 8.3 短名当成了家目录——CI 的临时目录是 `C:\Users\RUNNER~1\AppData\Local\Temp`，
  // 里面那个 `~` 被单独抽出来展开成家目录，于是 `del "C:\Users\RUNNER~1\...\v1.txt"`
  // 被误判成「引用了项目外的路径：~」而拒绝，两条沙箱测试直接红。
  // 修法是要求前面是「文本开头 / 空白 / 引号 / 分隔符」，即 ~ 只能作为一个参数的第一个字符。
  const homeRe = /(?:^|[\s"'(=;&|])((?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?:[\\/][^\s"'|;&<>)]*)?)/gi;
  let hm;
  while ((hm = homeRe.exec(text)) !== null) {
    const value = (hm[1] || '').trim();
    if (value) found.push(value);
  }
  const re = /"([^"]+)"|'([^']+)'|([A-Za-z]:[\\/][^\s"'|;&<>)]*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = (m[1] || m[2] || m[3] || '').trim();
    // 纯转义序列（"\r\n"、'\t'、"\x41"）不是路径：Windows 上 `\r\n` 会被 path.isAbsolute
    // 当成「当前盘根目录下的路径」→ 误判项目外而拒绝（2026-11-17 桌面实测：python 脚本里
    // 写 "\r\n" 换行被拦，模型只好改写成 chr(13)+chr(10)）。
    if (/^(?:\\(?:[nrtvfab0e'"\\]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}))+$/.test(value)) continue;
    // 0.33.9：以 \x1b / \u001b 这类转义开头的字符串（终端颜色码 `'\x1b[32mVITE\x1b[0m ready'`）也不是路径
    //   ——0.33.7 实测 node -e 打彩色输出被当成「项目外路径」整条拒绝
    if (/^\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/.test(value) || /\\(?:x1b|u001b|033)\[/i.test(value)) continue;
    // 含 %VAR% / 通配符 / 管道符号的不猜，交给黑名单与审批
    if (value && !value.includes('%') && !value.includes('*') && !value.includes('?')) found.push(value);
  }
  return found;
}

/**
 * 把命令里抽出的路径片段还原成绝对路径（用于过闸判定）。
 *
 * `~` / `$HOME` / `${HOME}` / `%USERPROFILE%` 用 policy.homeDir 展开；
 * 其余按「绝对路径直接用，相对路径基于 cwd 解析」处理。
 * 展开不了（没有 homeDir）就返回 null，由调用方决定怎么处理。
 */
function resolveCommandPath(policy, raw, base) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim().replace(/^["']|["']$/g, '');
  const home = policy && typeof policy.homeDir === 'string' ? policy.homeDir : null;

  // 家目录写法 → 绝对路径（统一成 Windows 风格，便于与 policy.sensitive.dirs 比对）
  const homeMatch = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)((?:[\\/].*)?)$/i.exec(text);
  if (homeMatch) {
    if (!home) return null;
    const rest = String(homeMatch[2] || '').replace(/^[\\/]/, '');
    return rest ? path.join(home, ...rest.split(/[\\/]+/).filter(Boolean)) : home;
  }

  if (path.isAbsolute(text)) return text;
  return base ? path.resolve(base, text) : null;
}

/**
 * 删除/改名命令是否指向项目外（只覆盖字面绝对路径与父目录相对路径）。
 * @returns {{ok:boolean, reason?:string, matchedRule?:string}}
 */
export function checkDestructiveTargets(policy, command, cwd) {
  if (typeof command !== 'string' || !command) return { ok: true };
  if (!policy) return { ok: true };
  // 2026-11-17（规格 §2.3 抓到的缺口）：删掉 `policy.mode === 'off'` 这个短路，
  // 并且**不依赖 assertPathAllowed 的 mode 分支**——它在 mode='off' 时跳过边界，
  // 会导致「关了写保护就顺手允许删项目外文件」。这条闸与敏感路径同口径：无条件生效。
  // 背景：沙箱的 WRITE_RESTRICTED 令牌不过滤 DELETE（实测 `del "项目外文件"` 能删成功），
  // 所以应用层这道检查是删除动作的最后一道闸。
  const base = cwd || (Array.isArray(policy.roots) ? policy.roots[0] : null);
  const roots = Array.isArray(policy.roots) ? policy.roots : [];
  const pathApi = pathApiFor(policy.platform);
  const ci = isWinPlatform(policy.platform);
  for (const seg of commandSegments(command)) {
    const inner = POWERSHELL_INNER.exec(seg);
    const target = inner ? inner[1] : seg;
    if (!DESTRUCTIVE_HEAD.test(target)) continue;
    for (const raw of literalPathsIn(target)) {
      const abs = resolveCommandPath(policy, raw, base);
      if (!abs) continue;
      // ① 敏感路径无条件拒（不管 mode、不管在不在项目内）
      const sens = isSensitivePath(policy, abs);
      if (sens) {
        return {
          ok: false,
          reason: t('删除/改名目标是敏感路径，已拒绝（{item}）：{path}', { item: sens, path: raw.slice(0, 100) }),
          matchedRule: 'destructive-sensitive'
        };
      }
      // ② 项目边界：无条件检查（不看 mode）
      if (roots.length) {
        const inside = roots.some((r) => typeof r === 'string' && isInside(pathApi, r, abs, ci));
        if (!inside) {
          return {
            ok: false,
            reason: t('删除/改名目标在项目外，已拒绝：{path}', { path: raw.slice(0, 120) }),
            matchedRule: 'destructive-outside'
          };
        }
      }
      // ③ 仍走一遍完整策略（readonly 等模式在这里兜住）
      const verdict = assertPathAllowed(policy, abs, { write: true, tool: 'run_command' });
      if (verdict && verdict.ok === false) {
        return {
          ok: false,
          reason: t('删除/改名目标在项目外，已拒绝：{path}', { path: raw.slice(0, 120) }),
          matchedRule: 'destructive-outside'
        };
      }
    }
  }
  return { ok: true };
}

// ---- 路径闸（决策 3，2026-11-16）----
// 背景：run_command 早先只验 cwd 与灾难命令黑名单，命令**文本里**的路径完全不检查。
// 于是 `type C:\Users\x\.ssh\id_rsa` 或 `cd /d D:\其他项目 && type config.json`
// 都能绕过项目边界与敏感路径判定。这两条闸补上这个洞：
//   第 1 层 敏感路径（~/.ssh、私钥名、*.pem…）——无条件拒绝，不看 mode、不看是否项目内
//   第 2 层 项目边界——命令里出现的任何字面路径，只要不在项目内就整条拒绝
// 已知上限（诚实记下，不假装能防）：运行时拼路径（$env:USERPROFILE、~、python open()）
// 静态拦不住，唯一根治是 OS 级读隔离（当前 ACL 沙箱只做写保护）。

/** 敏感路径判定（不依赖 assertPathAllowed 的模式分支）：命中即返回原因，否则 null。 */
export function isSensitivePath(policy, absPath) {
  if (!policy || typeof policy !== 'object') return null;
  if (typeof absPath !== 'string' || !absPath.trim()) return null;
  try {
    const normalized = normalizeTarget(policy, absPath);
    if (!normalized) return null;
    return detectSensitive(policy, normalized);
  } catch {
    return null;
  }
}

const BASH_C_INNER = /(?:-lc|-c)\s+"(.+)"$/i;

/**
 * 命令里字面路径的边界闸。mode==='off' 时仍检查敏感路径（那是无条件拒绝的）。
 * @returns {{ok:boolean, reason?:string, matchedRule?:string}}
 */
export function checkCommandPaths(policy, command, cwd) {
  if (typeof command !== 'string' || !command) return { ok: true };
  if (!policy || typeof policy !== 'object' || !POLICY_MODES.includes(policy.mode)) return { ok: true };
  const base = cwd || (Array.isArray(policy.roots) ? policy.roots[0] : null);
  const strictBoundary = policy.mode !== 'off'; // off 只放边界，不放敏感路径

  for (const seg of commandSegments(command)) {
    // 剥一层嵌套壳（powershell -command "..." / bash -c "..."）：真正的路径在里面
    const inner = POWERSHELL_INNER.exec(seg) || BASH_C_INNER.exec(seg);
    const target = inner ? inner[1] : seg;
    for (const raw of literalPathsIn(target)) {
      // 跳过纯命令名/参数（不含分隔符也不是盘符开头，例如 `foo --bar`）
      // 家目录写法（`~`、`$HOME`、`%USERPROFILE%`）没有分隔符也可能就是家目录本身，放行给下面解析
      const isHomeForm = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)$/i.test(raw)
        || /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)[\\/]/i.test(raw);
      if (!isHomeForm && !/[\\/]/.test(raw) && !/^[A-Za-z]:/.test(raw)) continue;
      // 跳过 URL：`http://127.0.0.1:8787/healthz` 这种带分隔符但不是文件路径，
      // 早先被误判成「项目外路径」把整条 curl 拦掉（单测抓到的真 bug）。
      // 也跳过带协议头的其他形态（ws://、file://）与单纯的斜杠参数（`/b`、`/s`）。
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || /^\/[a-zA-Z]$/.test(raw)) continue;
      // ~ / $HOME / %USERPROFILE% 必须**先展开**再判定，否则 bash 下
      // `rm -rf ~/.ssh` 会因为字面量不是绝对路径而被静默跳过（2026-11-16 实测漏洞）。
      const abs = resolveCommandPath(policy, raw, base);
      if (!abs) continue;
      // 落盘目录（只读例外）：允许命令引用（grep / tail / sed -n 查超长结果全文）
      try { if (inReadableDir(policy, normalizeTarget(policy, abs))) continue; } catch { /* 解析失败按普通路径处理 */ }

      // 第 1 层：敏感路径无条件拒绝（不看 mode）
      const sens = isSensitivePath(policy, abs);
      if (sens) {
        return {
          ok: false,
          reason: t('敏感路径禁止访问（{item}）：{path}', { item: sens, path: raw.slice(0, 100) }),
          matchedRule: 'sensitive-path'
        };
      }

      // 第 2 层：项目边界（off 模式跳过）
      if (strictBoundary) {
        const verdict = assertPathAllowed(policy, abs, { write: false, tool: 'run_command' });
        if (verdict && verdict.ok === false) {
          return {
            ok: false,
            reason: t('命令引用了项目外的路径，已拒绝：{path}', { path: raw.slice(0, 120) }),
            matchedRule: 'path-outside'
          };
        }
      }
    }
  }
  return { ok: true };
}

// ---- 文件名合法性（2026-11-17 规格 §3.3）----
// 背景：实测 D:\finalcheck 根目录里出现了名为 `ids.indexOf(v)!`、`x[1])` 的 0 字节文件——
// 是模型把代码片段当 path 参数传进 write_file，真的在磁盘上创建出来了。
// 根因：write_file / edit_file 只调 assertPathAllowed（边界 + 敏感），不校验文件名本身。
//
// 这是**启发式**，会误杀少数合法文件名（如 `a(1).txt`）。代价可接受：
// 返回的是「拒绝原因」，模型看到会重试正确路径，不是静默失败。
const WIN_ILLEGAL_NAME = /[<>:"|?*\x00-\x1f]/;
// 代码片段特征：括号/分号/感叹号/反引号/成员访问/下标/方法调用
const CODE_FRAGMENT_NAME = /[()[\]{};!$`]|\.\w+\(|indexOf|\.slice\(|\[[0-9]+\]/;
const WIN_RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * 校验文件名是否合法（只看 basename，不查路径边界——那是 assertPathAllowed 的事）。
 * @returns {{ok:true}|{ok:false, reason:string, matchedRule:string}}
 */
export function checkFileName(absPath) {
  const base = path.basename(String(absPath || ''));
  if (!base) return { ok: false, reason: t('文件名为空'), matchedRule: 'filename-empty' };
  if (WIN_ILLEGAL_NAME.test(base)) {
    return { ok: false, reason: t('文件名含非法字符：{name}', { name: base.slice(0, 40) }), matchedRule: 'filename-illegal' };
  }
  if (WIN_RESERVED_NAME.test(base)) {
    return { ok: false, reason: t('Windows 保留文件名：{name}', { name: base }), matchedRule: 'filename-reserved' };
  }
  if (base.length > 255) {
    return { ok: false, reason: t('文件名过长（>255 字符）'), matchedRule: 'filename-too-long' };
  }
  if (CODE_FRAGMENT_NAME.test(base)) {
    return {
      ok: false,
      reason: t('文件名看起来是代码片段而不是文件名：{name}。请检查 path 参数是否拼错（应该是一个真实的文件名，例如 src/foo.ts）', { name: base.slice(0, 40) }),
      matchedRule: 'filename-code-fragment'
    };
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
