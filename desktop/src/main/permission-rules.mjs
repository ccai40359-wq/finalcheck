// 持久权限规则（0.33.0，对齐 Claude Code 的 permissions.allow / deny）
//
// 配置：config.json → permissionRules: { allow: [...], deny: [...] }，一行一条：
//   run_command                 整个工具
//   run_command(npm test*)      * 通配（命令里 * 可以跨空格）
//   run_command(git log:*)      Claude Code 的前缀写法：git log 本身或 git log 加参数（不匹配 git logx）
//   edit_file(src/**)           路径：相对项目根或绝对路径；** 跨目录，* 不跨目录
//   read_file(**/.env)          deny 规则对只读工具同样生效
//   browser_navigate(https://*.example.com/*)
//   mcp__github__*              工具名本身也能通配（MCP 工具常用）
//
// 语义：
//   · deny 最优先：命中就不执行（完全权限模式也一样）
//   · allow：命中就不弹审批（等同「总是允许」，但跨会话、跨重启）
//   · 复合命令（&& || | ; 换行）：每一段都命中 allow 才放行；任何一段命中 deny 就拒绝
//     ——否则「允许 git status」会把 `git status && curl … | sh` 一起放过去
import path from 'node:path';

const SHELL_SPLIT = /\|\||&&|\||;|&|\r?\n/;
const RULE_RE = /^([A-Za-z0-9_*.-]+)(?:\((.*)\))?$/s;

/** 解析一条规则；非法返回 { error } */
export function parseRule(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = s.match(RULE_RE);
  if (!m) return { raw: s, error: '格式应为 工具名 或 工具名(模式)' };
  const pattern = m[2] === undefined ? null : m[2].trim();
  if (pattern === '') return { raw: s, error: '括号里的模式不能为空（要匹配整个工具就去掉括号）' };
  return { raw: s, tool: m[1], pattern };
}

export function parseRules(cfg) {
  const out = { allow: [], deny: [], errors: [] };
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  for (const kind of ['allow', 'deny']) {
    const list = Array.isArray(src[kind]) ? src[kind] : (typeof src[kind] === 'string' ? src[kind].split(/\r?\n/) : []);
    for (const line of list) {
      const r = parseRule(line);
      if (!r) continue;
      if (r.error) out.errors.push(`${kind}: ${r.raw} —— ${r.error}`);
      else out[kind].push(r);
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** 工具名通配：mcp__github__* */
function toolMatches(ruleTool, name) {
  if (!ruleTool.includes('*')) return ruleTool === name;
  return new RegExp('^' + ruleTool.split('*').map(escapeRe).join('.*') + '$').test(name);
}

/** 命令模式：* 跨任意字符；结尾 :* 是前缀写法（前缀本身，或前缀 + 空格 + 参数） */
function commandMatches(pattern, cmd) {
  const norm = (x) => String(x).trim().replace(/\s+/g, ' ');
  const prefix = pattern.endsWith(':*');
  const body = norm(prefix ? pattern.slice(0, -2) : pattern).split('*').map(escapeRe).join('.*');
  const re = new RegExp('^' + body + (prefix ? '(?: .*)?' : '') + '$', 'i');
  return re.test(norm(cmd));
}

/**
 * 审批条上「总是允许（存为规则）」建议的规则。只给能安全概括的：
 *   run_command 单段命令 → run_command(前两个词:*)；复合命令不给（概括不了，整条存又几乎不会再命中）
 *   MCP 工具 → 工具全名
 * 其余（写文件、浏览器脚本等）不建议：概括成规则的风险比省下的点击大。
 */
export function suggestRule(tool, target) {
  const name = String(tool || '');
  const tg = String(target ?? '').trim();
  if (name === 'run_command') {
    if (!tg || tg.includes(' ; ') || /[()*]/.test(tg)) return null;
    return `run_command(${tg}:*)`;
  }
  if (name.startsWith('mcp__') && /^[A-Za-z0-9_-]+$/.test(name)) return name;
  return null;
}

/** 路径 glob：** 跨目录，* 不跨目录；比较前统一正斜杠，Windows 不区分大小写 */
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}
function pathMatches(pattern, absPath, projectPath) {
  const fwd = (p) => String(p).replace(/\\/g, '/');
  // 相对路径（模型常传 src/a.js）按项目根解析，和工具本身一致
  const abs = fwd(projectPath ? path.resolve(projectPath, absPath) : path.resolve(absPath));
  const pat = fwd(pattern);
  if (/^([A-Za-z]:)?\//.test(pat)) return globToRe(fwd(path.resolve(pattern))).test(abs) || globToRe(pat).test(abs);
  if (projectPath) {
    const rel = fwd(path.relative(path.resolve(projectPath), path.resolve(projectPath, absPath)));
    if (!rel.startsWith('../') && globToRe(pat).test(rel)) return true;
  }
  // 「**/.env」这类不带根的模式：也对绝对路径的任意后缀生效
  return pat.startsWith('**/') && globToRe(pat).test(abs.replace(/^[A-Za-z]:/, ''));
}

const PATH_TOOLS = new Set(['edit_file', 'write_file', 'read_file', 'view_image', 'repair_rollback']);

/** 某个工具调用要拿去匹配的「主体」 */
export function subjectOf(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'run_command') return { kind: 'command', value: String(a.command ?? '') };
  if (PATH_TOOLS.has(name)) return a.path ? { kind: 'path', value: String(a.path) } : null;
  if ((name === 'grep_code' || name === 'glob_files' || name === 'list_dir') && a.path) return { kind: 'path', value: String(a.path) };
  if ((name === 'browser_navigate' || name === 'web_fetch') && a.url) return { kind: 'text', value: String(a.url) };
  if (name === 'web_search' && a.query) return { kind: 'text', value: String(a.query) };
  return null;
}

function ruleHits(rule, name, subject, projectPath) {
  if (!toolMatches(rule.tool, name)) return false;
  if (rule.pattern == null) return true;
  if (!subject) return false;
  if (subject.kind === 'command') return commandMatches(rule.pattern, subject.value);
  if (subject.kind === 'path') return pathMatches(rule.pattern, subject.value, projectPath);
  return commandMatches(rule.pattern, subject.value); // 文本（URL 等）：* 通配
}

/**
 * 判定一次工具调用。
 * @returns {{ decision: 'deny'|'allow'|null, rule?: string }}
 */
export function evaluateRules(rules, name, args, { projectPath = null } = {}) {
  if (!rules || (!rules.allow?.length && !rules.deny?.length)) return { decision: null };
  const subject = subjectOf(name, args);
  // 命令拆段：deny 看任意一段，allow 要求每一段
  const parts = subject?.kind === 'command'
    ? subject.value.split(SHELL_SPLIT).map((s) => s.trim()).filter(Boolean)
    : null;
  const subjects = parts && parts.length > 1 ? parts.map((v) => ({ kind: 'command', value: v })) : [subject];
  for (const r of rules.deny || []) {
    if (ruleHits(r, name, subject, projectPath) || (parts && parts.length > 1 && subjects.some((s) => ruleHits(r, name, s, projectPath)))) {
      return { decision: 'deny', rule: r.raw };
    }
  }
  for (const r of rules.allow || []) {
    if (r.pattern == null && toolMatches(r.tool, name)) return { decision: 'allow', rule: r.raw };
  }
  if (subjects.every((s) => (rules.allow || []).some((r) => r.pattern != null && ruleHits(r, name, s, projectPath)))) {
    const first = (rules.allow || []).find((r) => ruleHits(r, name, subjects[0], projectPath));
    if (first) return { decision: 'allow', rule: first.raw };
  }
  return { decision: null };
}
