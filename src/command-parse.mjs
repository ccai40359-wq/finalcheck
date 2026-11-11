import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// H1 交接检查的命令静态解析（从 checks/handover.mjs 抽出）：只解析 README 文本，
// 仅做静态 stat / 读 package.json 校验，绝不执行命令；无闭包状态，可单独测试。

const SHELL_FENCE_LANGS = new Set([
  'sh', 'bash', 'shell', 'zsh', 'fish', 'console', 'terminal', 'shell-session', 'bash-session',
  'cmd', 'cmd.exe', 'bat', 'batch', 'powershell', 'ps', 'ps1', 'pwsh',
]);
const COMMAND_WORDS = new Set([
  'npm', 'npx', 'yarn', 'pnpm', 'bun', 'corepack', 'node', 'nodejs', 'deno', 'python', 'python3', 'py',
  'pip', 'pip3', 'uv', 'poetry', 'pipenv', 'go', 'cargo', 'rustc', 'java', 'javac', 'mvn', 'mvnw',
  'gradle', 'gradlew', 'make', 'cmake', 'docker', 'docker-compose', 'podman', 'git', 'curl', 'wget',
  'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd', 'systemctl', 'service', 'pm2', 'supervisorctl',
  'supervisord', 'heroku', 'flyctl', 'vercel', 'netlify', 'aws', 'gcloud', 'az', 'terraform',
  'kubectl', 'helm', 'ansible', 'ansible-playbook', 'bundle', 'rails', 'rake', 'php', 'composer',
  'dotnet', 'psql', 'mysql', 'redis-cli', 'nginx', 'gunicorn', 'uvicorn', 'flask', 'celery', 'honcho',
  'foreman', 'source', '.', 'export', 'set', 'setx', 'sudo', 'cd', 'pushd', 'popd', 'cp', 'copy', 'mv', 'move', 'ln', 'rm',
  'del', 'mkdir', 'md', 'touch', 'tee', 'chmod', 'chown', 'cat', 'type', 'echo', 'printf', 'pwd',
  'ls', 'dir', 'where', 'which', 'apt', 'apt-get', 'brew', 'choco', 'scoop', 'snap', 'yum', 'dnf',
  'apk', 'ssh', 'scp', 'rsync', 'tar', 'unzip', 'zip', 'ps', 'kill', 'sleep', 'wait', 'true', 'false',
  'venv', 'virtualenv', 'conda', 'micromamba', 'pnpx', 'nvm', 'fnm', 'volta', 'asdf',
]);
const TRIVIAL_COMMANDS = new Set([
  'cd', 'echo', 'printf', 'export', 'set', 'setx', 'unset', 'source', '.', 'pwd', 'ls', 'dir', 'cat',
  'type', 'true', 'false', 'sleep', 'wait', 'clear', 'whoami', 'which', 'where', 'kill',
]);
const ENV_SAMPLE_BASENAMES = new Set(['.env.example', '.env.sample', '.env.dist', '.env.template', '.env.defaults']);
const KNOWN_FILE_NAMES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-lock.yml', 'yarn.lock',
  'dockerfile', 'containerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  '.env.example', '.env.sample', '.env.dist', '.env.template', '.env.defaults',
  'requirements.txt', 'pyproject.toml', 'pipfile', 'poetry.lock', 'setup.py', 'setup.cfg',
  'makefile', 'justfile', 'procfile', 'gemfile', 'gemfile.lock', 'composer.json', 'composer.lock',
  'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'tsconfig.json', 'tsconfig.build.json',
  'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'next.config.js', 'next.config.mjs',
  'nuxt.config.ts', 'nuxt.config.js', 'ecosystem.config.js', 'ecosystem.config.cjs',
  'ecosystem.config.mjs', 'ecosystem.config.json', 'nginx.conf', 'traefik.yml', 'caddyfile',
  '.nvmrc', '.node-version', '.python-version', 'finalcheck.config.json', 'tsconfig.check.json',
]);
const FILE_EXT_RE = /\.(?:js|mjs|cjs|jsx|tsx|ts|json|ya?ml|toml|ini|cfg|conf|sh|bash|ps1|bat|cmd|py|rb|go|rs|java|kt|php|cs|sql|md|txt|lock|service|timer)$/i;
const BUILD_OUTPUT_PREFIX_RE = /^(?:\.\/)?(?:dist|build|out|release|coverage|\.next|target|vendor|tmp|temp|\.cache)\//i;
const FLAG_VALUE_INPUT = new Set([
  '-f', '--file', '--config', '--env-file', '--prefix', '-c', '--dir', '--cwd', '--project-directory',
  '-r', '--requirement', '--requirements', '--toml', '-s', '--source',
]);
const DIR_VALUE_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd', '--project-directory', '--workspace', '-w', '--filter']);
const FLAG_VALUE_OUTPUT = new Set([
  '-o', '--output', '--out', '--outdir', '--out-dir', '-O', '--target', '--dest', '--destination',
  '--dest-dir', '--output-dir', '--output-file',
]);
const FLAG_VALUE_IGNORE = new Set([
  '-e', '--eval', '-m', '--module', '--node-options', '--loader', '--require', '--import',
  '--title', '--description', '--name',
]);
const WRITE_ONLY_COMMANDS = new Set(['mkdir', 'md', 'rmdir', 'touch', 'tee', 'rimraf']);
const COPY_LIKE_COMMANDS = new Set(['cp', 'copy', 'mv', 'move', 'ln', 'install', 'rsync', 'scp', 'xcopy', 'robocopy']);

export function tokenizeCommand(text) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { cur += text[++i]; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (/\s/.test(next) || next === '"' || next === "'") { cur += next; i++; continue; }
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export function splitSegments(text) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i];
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ';') { out.push(cur); cur = ''; continue; }
    if (ch === '&' && text[i + 1] === '&') { out.push(cur); cur = ''; i++; continue; }
    if (ch === '|' && text[i + 1] === '|') { out.push(cur); cur = ''; i++; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function stripCommandPrefix(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (tokens[i] === 'sudo') {
    i++;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      const flag = tokens[i];
      i++;
      if (['-u', '-g', '-p', '-h', '-C'].includes(flag) && i < tokens.length) i++;
    }
  }
  if (tokens[i] === 'env') {
    i++;
    while (i < tokens.length && (tokens[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
  }
  if (tokens[i] === 'command') i++;
  return tokens.slice(i);
}

export function baseName(token) {
  const s = String(token || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

function looksLikeCommand(text, strict = false) {
  const tokens = stripCommandPrefix(tokenizeCommand(text));
  const first = tokens[0];
  if (!first) return false;
  const name = first.replace(/\\/g, '/');
  if (COMMAND_WORDS.has(name.toLowerCase())) return true;
  if (/^(?:\.{1,2}\/|~\/)/.test(name)) return true;
  if (/^(?:[A-Za-z]:)?\/[A-Za-z0-9._/-]+$/.test(name)) return true;
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(name)) return true;
  // 无语言标记的代码块可能是正文/配置：不允许“小写词 + 参数”兜底，避免把说明句当命令
  if (!strict && /^[a-z0-9._-]+$/.test(name) && tokens.slice(1).some((x) => /^--?[A-Za-z]/.test(x))) return true;
  return false;
}

export function isShellBlock(block) {
  if (!block.lang) return true; // 无语言标记：由 looksLikeCommand 过滤正文
  return SHELL_FENCE_LANGS.has(block.lang);
}

export function extractBlockCommands(block) {
  const raw = [];
  let pending = null;
  for (const line of block.lines) {
    let text = line.text;
    if (pending) { text = pending.text.trimEnd() + ' ' + text.trimStart(); pending = null; }
    if (/(?:\\|`|\^)\s*$/.test(text) && !/^\s*#/.test(text)) {
      pending = { text: text.replace(/(?:\\|`|\^)\s*$/, ''), line: line.line };
      continue;
    }
    raw.push({ text, line: line.line });
  }
  if (pending) raw.push(pending);

  const promptRe = /^\s*(?:\$\s+|PS[^>]*>\s*|>\s+)/i;
  const hasPrompt = raw.some((l) => promptRe.test(l.text));
  const out = [];
  for (const l of raw) {
    let text = l.text;
    if (hasPrompt) {
      if (!promptRe.test(text)) continue; // 有提示符时，非提示符行是输出/说明
      text = text.replace(promptRe, '');
    }
    text = text.trim();
    if (!text) continue;
    if (/^(?:#|\/\/|REM\b|::)/i.test(text)) continue;
    if (!looksLikeCommand(text, !block.lang)) continue;
    out.push({ cmd: text, line: l.line });
  }
  return out;
}

function firstPositional(args, valueFlags) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (valueFlags.has(args[i])) i++;
      continue;
    }
    return args[i];
  }
  return null;
}

const NPM_IMPLICIT_SCRIPTS = new Set(['start', 'test', 'stop', 'restart']);
const PNPM_BUILTINS = new Set([
  'install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'run', 'run-script',
  'exec', 'dlx', 'create', 'init', 'import', 'link', 'unlink', 'publish', 'pack', 'prune', 'outdated',
  'list', 'ls', 'why', 'audit', 'rebuild', 'config', 'store', 'root', 'bin', 'env', 'deploy',
  'licenses', 'patch', 'patch-commit', 'doctor', 'setup', 'fetch', 'server', 'help',
]);
const YARN_BUILTINS = new Set([
  'install', 'add', 'remove', 'upgrade', 'up', 'run', 'create', 'init', 'publish', 'pack', 'cache',
  'config', 'info', 'link', 'unlink', 'why', 'workspace', 'workspaces', 'audit', 'licenses', 'node',
  'exec', 'dlx', 'help', 'version', 'set', 'global', 'import', 'constraints', 'dedupe', 'explain',
]);

export function detectNpmScript(tokens) {
  const name = baseName(tokens[0]);
  const args = tokens.slice(1);
  const scriptValueFlags = new Set(['--prefix', '-C', '--dir', '--workspace', '-w', '--filter', '--cwd']);
  if (name === 'npm' || name === 'pnpm') {
    const runIdx = args.findIndex((a) => a === 'run' || a === 'run-script');
    if (runIdx >= 0) return firstPositional(args.slice(runIdx + 1), scriptValueFlags);
    const first = firstPositional(args, scriptValueFlags);
    if (!first) return null;
    if (name === 'npm') return NPM_IMPLICIT_SCRIPTS.has(first) ? first : null;
    return PNPM_BUILTINS.has(first) ? null : first;
  }
  if (name === 'yarn') {
    if (args[0] === 'run') return firstPositional(args.slice(1), scriptValueFlags);
    const first = firstPositional(args, scriptValueFlags);
    if (!first) return null;
    return YARN_BUILTINS.has(first) ? null : first;
  }
  if (name === 'bun') {
    if (args[0] === 'run') return firstPositional(args.slice(1), scriptValueFlags);
    return null;
  }
  return null;
}

export function needsPackageJson(tokens) {
  const name = baseName(tokens[0]);
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return false;
  const first = firstPositional(tokens.slice(1), new Set(['--prefix', '-C', '--dir', '--workspace', '-w', '--filter', '--cwd']));
  if (!first) return true;
  return ['install', 'i', 'ci', 'run', 'run-script', 'start', 'test', 'stop', 'restart', 'add', 'remove', 'update', 'upgrade'].includes(first);
}

function lastPositionalIndex(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) if (!tokens[i].startsWith('-')) return i;
  return -1;
}

function isRedirectionTarget(tokens, index) {
  const prev = tokens[index - 1] || '';
  return /^(?:[12]?>>?|&>|>\|)$/.test(prev);
}

function shouldSkipDestination(tokens, index, lastPos, cmdName) {
  if (cmdName === 'git' && tokens[1] === 'clone' && index === lastPos) return true;
  return COPY_LIKE_COMMANDS.has(cmdName) && index === lastPos;
}

function isPathCandidate(raw) {
  let s = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  if (!s) return false;
  if (s === '.' || s === '..' || s === './' || s === '../') return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('~')) return false;
  if (/^[-@+]/.test(s)) return false;
  if (/[<>|*?$%{}`=]/.test(s)) return false;
  if (s.includes(':')) return false; // URL / 远程路径 / host:port
  const norm = s.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm) return false;
  const base = norm.split('/').pop().toLowerCase();
  if (base === '.env') return false;
  if (base.startsWith('.env.') && !ENV_SAMPLE_BASENAMES.has(base)) return false;
  if (KNOWN_FILE_NAMES.has(base)) return true;
  if (/^(?:dockerfile|containerfile)(?:\..+)?$/.test(base)) return true;
  if (/^(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/.test(base)) return true;
  if (/^\.{1,2}\//.test(s)) return true;
  const hasSlash = s.includes('/') || s.includes('\\');
  if (hasSlash && (s.endsWith('/') || s.endsWith('\\'))) return true;
  if (FILE_EXT_RE.test(base)) return true;
  return false;
}

export function normalizeRef(cwd, raw) {
  let s = String(raw || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
  if (/^[A-Za-z]:\//.test(s) || s.startsWith('/') || s.startsWith('~')) return null;
  if (/[<>|*?$%{}`=]/.test(s)) return null;
  if (s.includes(':')) return null;
  s = s.replace(/^\.\//, '');
  const joined = path.posix.normalize(cwd === '.' ? s : path.posix.join(cwd, s));
  if (joined === '.') return null;
  return joined;
}

export function collectPathRefs(tokens, cmdName) {
  const refs = [];
  const lastPos = lastPositionalIndex(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const lower = tok.toLowerCase();
    if (FLAG_VALUE_OUTPUT.has(lower) || FLAG_VALUE_IGNORE.has(lower)) { i++; continue; }
    if (DIR_VALUE_FLAGS.has(lower)) {
      const next = tokens[i + 1];
      if (next && !next.startsWith('-')) { refs.push(next); i++; }
      continue;
    }
    if (FLAG_VALUE_INPUT.has(lower)) {
      const next = tokens[i + 1];
      if (next && !next.startsWith('-') && isPathCandidate(next)) { refs.push(next); i++; }
      continue;
    }
    const eq = /^--([A-Za-z0-9_-]+)=(.*)$/.exec(tok);
    if (eq) {
      const flag = `--${eq[1]}`.toLowerCase();
      if (DIR_VALUE_FLAGS.has(flag)) refs.push(eq[2]);
      else if (FLAG_VALUE_INPUT.has(flag) && isPathCandidate(eq[2])) refs.push(eq[2]);
      continue;
    }
    if (tok.startsWith('-')) continue;
    if (isRedirectionTarget(tokens, i)) continue;
    if (shouldSkipDestination(tokens, i, lastPos, cmdName)) continue;
    if (WRITE_ONLY_COMMANDS.has(cmdName)) continue;
    if (isPathCandidate(tok)) refs.push(tok);
  }
  return [...new Set(refs)];
}

async function pathExists(projectDir, rel) {
  if (!rel) return false;
  try {
    await stat(path.resolve(projectDir, rel));
    return true;
  } catch {
    return false;
  }
}

// monorepo：cd 到子目录后，npm script 应查子目录的 package.json；子目录没清单时按仓库根宽松处理
async function resolvePackageFor(projectDir, cwd, rootPkg, cache) {
  if (!cwd || cwd === '.' || cwd === '..' || cwd.startsWith('../')) return rootPkg;
  if (cache.has(cwd)) return cache.get(cwd);
  let result = rootPkg;
  try {
    const parsed = JSON.parse(await readFile(path.join(projectDir, cwd, 'package.json'), 'utf8'));
    const scripts = parsed && typeof parsed === 'object' && parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
      ? parsed.scripts : {};
    result = { scripts, hasPkg: true };
  } catch { /* 子目录没有 package.json：回退到仓库根，避免把 monorepo 当坏交接 */ }
  cache.set(cwd, result);
  return result;
}

export async function inspectCommand(cmd, ctx) {
  const problems = [];
  let cwd = '.';
  for (const segment of splitSegments(cmd)) {
    const tokens = stripCommandPrefix(tokenizeCommand(segment));
    if (!tokens.length) continue;
    const name = baseName(tokens[0]);
    if (name === 'cd' || name === 'pushd') {
      const target = tokens.slice(1).find((x) => !x.startsWith('-'));
      if (!target) continue;
      const normalized = normalizeRef(cwd, target);
      if (!normalized) continue;
      // README 的 git clone 流程：`cd <仓库目录>` 在静态检查时还不存在（clone 才会创建）。
      // 目录名等于项目根本身时按“已在此根目录”处理，既不放行真正的缺失子目录，也不误报 clone 目标。
      const isCloneRoot = cwd === '.' && normalized === path.basename(path.resolve(ctx.projectDir));
      if (!await pathExists(ctx.projectDir, normalized)) {
        if (!isCloneRoot) problems.push({ kind: 'file', path: normalized });
      } else if (!isCloneRoot) {
        cwd = normalized;
      }
      continue;
    }
    const pkg = await resolvePackageFor(ctx.projectDir, cwd, ctx.rootPkg, ctx.pkgCache);
    const script = detectNpmScript(tokens);
    if (script) {
      if (pkg.scripts) {
        const body = pkg.scripts[script];
        if (typeof body !== 'string' || !body.trim()) problems.push({ kind: 'script', script });
      } else if (!pkg.hasPkg) {
        problems.push({ kind: 'file', path: 'package.json' });
      }
    } else if (needsPackageJson(tokens) && !pkg.hasPkg) {
      problems.push({ kind: 'file', path: 'package.json' });
    }
    for (const ref of collectPathRefs(tokens, name)) {
      const normalized = normalizeRef(cwd, ref);
      if (!normalized) continue;
      if (BUILD_OUTPUT_PREFIX_RE.test(normalized)) continue; // 构建产物：先构建才有，不判缺失
      if (!await pathExists(ctx.projectDir, normalized)) problems.push({ kind: 'file', path: normalized });
    }
  }
  const seen = new Set();
  return problems.filter((p) => {
    const key = `${p.kind}:${p.path || p.script}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isTrivialCommand(cmd) {
  const tokens = stripCommandPrefix(tokenizeCommand(cmd));
  if (!tokens.length) return true;
  return TRIVIAL_COMMANDS.has(baseName(tokens[0]));
}

export function shortCommand(cmd) {
  const s = String(cmd || '').replace(/\s+/g, ' ').trim();
  return s.length > 100 ? `${s.slice(0, 97)}…` : s;
}
