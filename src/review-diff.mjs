// 只读 git 改动审查（agent 工具 review_diff 的引擎侧实现）
// 边界：
//  - 只跑 git diff（禁用外部 diff / textconv，避免配置里藏命令执行），绝不 add/commit/checkout；
//  - 不执行被审项目里的任何代码；风险只做确定性的文本规则，不做启发式猜测；
//  - 超时 60s，输出封顶，超限即 truncated=true。
import { spawn } from 'node:child_process';
import path from 'node:path';

export const REVIEW_DIFF_TIMEOUT_MS = 60000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // diff 文本封顶：只需要开头部分做规律标记
const MAX_RISKS = 200;
const SNIPPET_MAX = 120;

const SAFE_BASE_RE = /^[A-Za-z0-9._\/~^@{}+\-]+$/;

export function safeBase(value) {
  const s = String(value ?? 'HEAD').trim();
  if (!s) return 'HEAD';
  if (s.startsWith('-')) return null; // 防止把 base 当 git 选项
  if (!SAFE_BASE_RE.test(s)) return null;
  return s;
}

function gitEnv() {
  return {
    ...process.env,
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0' // 只读：连 index 的时间戳刷新锁都不要
  };
}

/** 跑 git 子进程并收集输出；不抛异常，超时/超量都通过返回值表达 */
function runGit(args, cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, windowsHide: true, env: gitEnv() });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e?.message || e), truncated: false, timedOut: false, spawnError: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (prev, chunk, limit) => {
      if (prev.length >= limit) return prev;
      return prev + chunk.slice(0, limit - prev.length);
    };
    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, truncated, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish(124);
    }, REVIEW_DIFF_TIMEOUT_MS);
    child.stdout?.on('data', (d) => {
      const s = d.toString();
      if (stdout.length + s.length > MAX_OUTPUT_BYTES) truncated = true;
      stdout = append(stdout, s, MAX_OUTPUT_BYTES);
    });
    child.stderr?.on('data', (d) => {
      stderr = append(stderr, d.toString(), 4000);
    });
    child.on('close', (code) => finish(code ?? 0));
    child.on('error', (e) => {
      stderr += String(e?.message || e);
      finish(null);
    });
  });
}

function gitArgs(cwd, diffArgs) {
  // --no-ext-diff / --no-textconv：不执行项目 .gitattributes 或 git 配置里的外部程序
  return ['-C', cwd, '-c', 'color.ui=false', '-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', ...diffArgs];
}

export function parseNameStatus(text) {
  const files = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const parts = line.split('\t');
    const status = parts[0] || '';
    if (!status) continue;
    if ((status.startsWith('R') || status.startsWith('C')) && parts.length >= 3) {
      files.push({ status, path: parts[2], from: parts[1] });
    } else if (parts.length >= 2) {
      files.push({ status, path: parts[1] });
    }
  }
  return files;
}

function headerPath(line) {
  const idx = line.lastIndexOf(' b/');
  if (idx >= 0) return line.slice(idx + 3);
  return null;
}

function prefixedPath(line, prefix) {
  const rest = line.slice(4).trim();
  if (!rest || rest === '/dev/null') return null;
  return rest.startsWith(prefix) ? rest.slice(prefix.length) : rest;
}

const SQL_START_RE = /(?:^|[^A-Za-z])(?:select\s+.*\bfrom\b|insert\s+into\b|update\s+\S+\s+set\b|delete\s+from\b|where\b|values\s*\()/i;
function isSqlConcat(s) {
  if (!SQL_START_RE.test(s)) return false;
  return /\+\s*(?:[A-Za-z_$]|["'`])/.test(s) || /\$\{/.test(s) || /\.\s*\$[A-Za-z_]/.test(s);
}

const COMMAND_EXEC_RE = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|popen|system|eval)\s*\(|\bchild_process\b|\bRuntime\.getRuntime\(\)\.exec\b|\bsubprocess\./i;

const SECRET_ASSIGN_RE = /(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token)\b\s*[:=]\s*["'`][^"'`\s]{8,}/i;
const SECRET_LITERAL_RE = /\bAKIA[0-9A-Z]{16}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

const AUTH_DELETED_RE = /(?:\.use\s*\(\s*(?:auth|authenticate|jwt|passport|requireAuth|requireLogin|isAuthenticated)|\brequireAuth\b|\brequireLogin\b|\bisAuthenticated\b|\bensureLoggedIn\b|\bensureAuthenticated\b|\bauthenticate\s*\(|\bpassport\.authenticate\b|@PreAuthorize|\bUseGuards\s*\(|\blogin_required\b|\bauth_required\b|\bauthMiddleware\b|\bverifyToken\b|\bcheckAuth\b)/i;

const isSensitiveConfigPath = (p) => {
  const base = String(p || '').split(/[\\/]/).pop() || '';
  return /^\.env(?:\.|$)/.test(base) || /\.gitignore$/.test(base);
};

const snippetOf = (line) => String(line || '').replace(/^[+\- ]/, '').trim().slice(0, SNIPPET_MAX);

/**
 * 纯函数：从统一 diff 文本抽取每个文件的 +N/-M，并按确定性规则标风险。
 * 风险只看「新增行」（密钥/SQL/命令执行）与「删除行」（鉴权中间件）。
 */
export function analyzeUnifiedDiff(diffText, nameStatusText = '') {
  const filesFromStatus = parseNameStatus(nameStatusText);
  const counts = new Map();
  const risks = [];
  const diffs = String(diffText || '').split(/\r?\n/);
  let file = null;
  let oldLine = 0;
  let newLine = 0;

  const ensureCount = (f) => {
    if (!counts.has(f)) counts.set(f, { added: 0, removed: 0 });
    return counts.get(f);
  };
  const pushRisk = (rule, message, snippet, line) => {
    if (!file) return;
    risks.push({ rule, file, line, message, snippet: snippetOf(snippet) });
  };

  for (const raw of diffs) {
    if (raw.startsWith('diff --git ')) {
      file = headerPath(raw);
      oldLine = 0;
      newLine = 0;
      if (file) ensureCount(file);
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = prefixedPath(raw, 'b/');
      if (p) file = p;
      if (file) ensureCount(file);
      continue;
    }
    if (raw.startsWith('--- ')) {
      const p = prefixedPath(raw, 'a/');
      if (p && !file) file = p;
      if (file) ensureCount(file);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
      }
      continue;
    }
    if (!file || !raw) continue;

    const ch = raw[0];
    if (ch === '+') {
      const c = ensureCount(file);
      c.added += 1;
      const body = raw.slice(1);
      if (isSqlConcat(body)) pushRisk('sql-concat', '改动新增 SQL 字符串拼接（疑似注入面）', body, newLine);
      if (COMMAND_EXEC_RE.test(body)) pushRisk('command-exec', '改动新增命令执行调用', body, newLine);
      if (SECRET_ASSIGN_RE.test(body) || SECRET_LITERAL_RE.test(body)) pushRisk('secret-literal', '改动新增疑似密钥/口令字面量', body, newLine);
      newLine += 1;
    } else if (ch === '-') {
      const c = ensureCount(file);
      c.removed += 1;
      const body = raw.slice(1);
      if (AUTH_DELETED_RE.test(body)) pushRisk('auth-removed', '删除了鉴权中间件/守卫', body, oldLine);
      oldLine += 1;
    } else if (ch === ' ') {
      oldLine += 1;
      newLine += 1;
    }
  }

  for (const f of filesFromStatus) {
    if (isSensitiveConfigPath(f.path)) {
      risks.push({
        rule: 'sensitive-config-changed',
        file: f.path,
        line: 0,
        message: '敏感配置文件被修改（.env / .gitignore）',
        snippet: String(f.path).slice(0, SNIPPET_MAX)
      });
    }
  }

  const truncated = risks.length > MAX_RISKS;
  const cappedRisks = risks.slice(0, MAX_RISKS);
  const files = filesFromStatus.map((f) => {
    const c = counts.get(f.path) || { added: 0, removed: 0 };
    return { status: f.status, path: f.path, added: c.added, removed: c.removed };
  });
  return { files, risks: cappedRisks, truncated };
}

/**
 * 只读审查：git diff <base>（含工作区未提交改动）。
 * @param {string} dir 项目绝对路径
 * @param {{base?:string}} opts base 默认 HEAD（也可 HEAD~1 / 分支名）
 */
export async function reviewDiff(dir, { base = 'HEAD' } = {}) {
  const cwd = path.resolve(String(dir || ''));
  const safe = safeBase(base);
  if (!safe) {
    return { base: String(base ?? ''), error: `base 不合法：${String(base ?? '')}（只接受 HEAD / HEAD~1 / 分支名等 ref）`, files: [], risks: [], truncated: false };
  }

  const ns = await runGit(gitArgs(cwd, ['--name-status', safe]), cwd);
  if (ns.code !== 0) {
    return { base: safe, error: gitErrorText(ns, cwd, safe), files: [], risks: [], truncated: ns.truncated || ns.timedOut };
  }
  if (ns.timedOut) {
    return { base: safe, error: `git diff 超时（${REVIEW_DIFF_TIMEOUT_MS / 1000}s）：${cwd}`, files: [], risks: [], truncated: true };
  }

  const df = await runGit(gitArgs(cwd, [safe]), cwd);
  if (df.code !== 0) {
    return { base: safe, error: gitErrorText(df, cwd, safe), files: parseNameStatus(ns.stdout), risks: [], truncated: ns.truncated || df.truncated || df.timedOut };
  }

  const analysis = analyzeUnifiedDiff(df.stdout, ns.stdout);
  return {
    base: safe,
    files: analysis.files,
    risks: analysis.risks,
    truncated: !!(ns.truncated || df.truncated || df.timedOut || analysis.truncated)
  };
}

function gitErrorText(r, cwd, base) {
  const err = String(r.stderr || '').trim();
  if (r.spawnError || /ENOENT|not found/i.test(err)) return '无法执行 git（未安装或不在 PATH）';
  if (r.timedOut) return `git diff 超时（${REVIEW_DIFF_TIMEOUT_MS / 1000}s）：${cwd}`;
  if (/not a git repository|不是.*git.*仓库/i.test(err)) return `不是 git 仓库（或不在工作区内）：${cwd}`;
  return `git diff ${base} 失败：${err || `exit ${r.code}`}`;
}
