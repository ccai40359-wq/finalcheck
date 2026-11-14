import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles, prunedWarning } from '../walk.mjs';
import { t } from '../../desktop/src/renderer/i18n/core.mjs';
import { extractBlockCommands, inspectCommand, isShellBlock, isTrivialCommand, shortCommand } from '../command-parse.mjs';

// H1 交接检查（L2 静态闸）：接手者不看代码也能把项目跑起来吗？
// 纯静态：不执行项目命令、不读 .env 本体。缺 README / 启动说明 / 环境变量样本时给结论；
// lockfile 缺失只记 warning（S4 已有覆盖缺口，同一事实不重复扣分）。
const CODE_RE = /\.(?:ts|js|mjs|jsx|tsx)$/i;
const ENV_VAR_RE = /(?:process\.env|import\.meta\.env)\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
const README_NAMES = new Set(['readme.md', 'readme.rst']);
const SAMPLE_RE = /^\.env\.(?:example|sample)$/i;
const START_KEYWORD_RE = /\b(?:install|run|start)\b|启动|安装|使用/i;
const LOCK_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-lock.yml']);

// README 五段：只在「标题行 / 代码块标题」里匹配，正文出现 deployment 不算部署段。
const README_SECTIONS = [
  { key: 'install', label: '安装', re: /\binstall(?:ation|ing)?\b|\bsetup\b|\bprerequisites?\b|getting\s+started|build(?:ing)?|compile|安装|准备/i },
  { key: 'run', label: '运行', re: /\b(?:run|running|start|starting|usage|quick\s*start)\b|运行|启动|快速开始|使用/i },
  { key: 'env', label: '环境变量', re: /\b(?:env|environment|configuration|config|settings)\b|环境变量|配置/i },
  { key: 'deploy', label: '部署', re: /\bdeploy(?:ment|ing)?\b|\bcontainer\b|\bdocker\b|\bkubernetes\b|\bk8s\b|\bimage\b|部署|上线/i },
  { key: 'rollback', label: '回滚', re: /\broll[\s-]?back\b|\brevert\b|\bprevious\s+version\b|\bdowngrade\b|回滚|回退/i },
];
const ROLLBACK_RE = README_SECTIONS[4].re;
const ROLLBACK_CLUE_RE = /(?:上一版(?:本)?|回滚到|回退到|恢复到|roll[\s-]?back\s+(?:to|the\s+previous|previous)|revert(?:ing)?\s+to|git\s+revert|helm\s+rollback|kubectl\s+rollout\s+undo|previous\s+version|\bv?\d+\.\d+\.\d+\b)/i;
// 服务型仓库才要求的章节：库/CLI 不该被逼着写 env/deploy/rollback。
const DEPLOY_ROOT_FILE_RE = /^(?:Dockerfile|docker-compose(?:[.-][\w-]+)?\.ya?ml|Procfile|fly\.toml|vercel\.json|netlify\.toml|render\.yaml|app\.yaml|compose\.ya?ml)$/i;
const SERVICE_ENV_RE = /^(?:DATABASE_URL|DB_|REDIS_|MONGO_|AWS_|SMTP_|JWT_|SESSION_|OAUTH_|NEXTAUTH_|.*_SECRET|.*_TOKEN|.*_API_KEY|.*_KEY|.*_PASSWORD)$/i;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// README 先教读者创建文件、再运行它（gin 的 "Save the code above as main.go"）
function readmeCreatesPath(text, target) {
  const base = path.basename(String(target || ''));
  if (!base) return false;
  const b = escapeRegExp(base);
  return new RegExp(`(?:save|create|touch|write|add|新建|创建|写入)[^\\n]{0,120}${b}|${b}[^\\n]{0,40}(?:创建|新建|生成)`, 'i').test(String(text || ''));
}
// README 命令属于生成器/脚手架创建的新项目（express-generator 的 npm start）
function readmeUsesGenerator(text) {
  return /express-generator|express\(1\)|\bnpx\s+[\w@/.-]+\s+(?:new|create|init)|\bnpm\s+init\b|\bcreate-[\w-]+\b|cookiecutter|rails\s+new|django-admin\s+startproject/i.test(String(text || ''));
}

// 部署线索：Dockerfile / compose / CI / 启动脚本（systemd/pm2/Procfile）
const CI_ROOT_FILES = new Set([
  '.gitlab-ci.yml', '.travis.yml', 'jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml',
  'cloudbuild.yaml', 'cloudbuild.yml', 'appveyor.yml', '.drone.yml', '.woodpecker.yml',
  'bitrise.yml', 'codemagic.yaml', 'vercel.json', 'netlify.toml', 'fly.toml', 'railway.json',
  'render.yaml', 'taskfile.yml', 'taskfile.yaml',
]);
const START_SCRIPT_RE = /^(?:start|run|deploy|release|restart|stop)(?:[-._].*)?\.(?:sh|bash|ps1|bat|cmd)$/i;


// 样本值侧判别：只报变量名，永不回显值。占位符/模板/中文文案/填充值不算真实值。
const SECRET_KEY_RE = /(?:api[_-]?key|secret|token|pass(?:word|wd)|pwd|private[_-]?key|credential)/i;
const SECRET_VALUE_PREFIX_RE = /^(?:sk[-_]|pk_(?:live|test)_|gh[pousr]_|xox[baprs]-|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,})/;
const PLACEHOLDER_RE = /^(?:your|change|example|sample|placeholder|dummy|fake|test|dev|local|localhost|todo|tbd|xxx|none|null|undefined|empty|-+|\*+|<|\$\{)/i;
const PLACEHOLDER_WORD_RE = /^(?:password|passwd|pwd|secret|token|key|apikey|admin|root|qwerty|default|demo|development|production|staging|release|master|main|mock|none|null|empty|12345678|123456789|1234567890)$/i;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function looksLikeSecretValue(key, rawValue) {
  let v = String(rawValue ?? '').trim();
  if (!v) return false;
  const quoted = /^(['"])(.*)\1$/.exec(v);
  if (quoted) v = quoted[2].trim();
  else v = v.replace(/\s+#.*$/, '').trim(); // 行尾注释不参与判定
  if (v.length < 8) return false;
  if (PLACEHOLDER_RE.test(v)) return false;
  if (CJK_RE.test(v)) return false; // 中文文案 / 提示
  if (/\$\{/.test(v) || /process\.env|import\.meta\.env/.test(v)) return false; // 模板/引用
  if (SECRET_VALUE_PREFIX_RE.test(v)) return true;
  if (!SECRET_KEY_RE.test(key)) return false;
  if (PLACEHOLDER_WORD_RE.test(v)) return false;
  if (/(.)\1{7,}/.test(v)) return false; // 00000000 这类填充值
  if (/^[a-z]+(?:[-_][a-z]+)+$/i.test(v)) return false; // 占位短语
  return true; // 密钥型 key + 非占位值：宁可提示，也不把真实密钥留在样本里
}

// .env 样本解析：KEY=VALUE；忽略注释/空行；容忍 export 前缀
function parseSample(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^export\s+/i, '');
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out.push({ key: m[1], value: m[2], line: i + 1 });
  }
  return out;
}

async function rootEntries(projectDir) {
  try { return await readdir(projectDir, { withFileTypes: true }); } catch { return []; }
}

// ---------- README 解析（标题 / 代码块 / 章节范围） ----------

function scanReadme(text) {
  const lines = String(text || '').split(/\r?\n/);
  const headings = [];
  const blocks = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence.char && fm[1].length >= fence.len && !fm[2].trim()) {
        blocks.push(fence);
        fence = null;
      } else {
        fence.lines.push({ text: line, line: i + 1 });
      }
      continue;
    }
    if (fm) {
      const info = fm[2].trim();
      const lang = info.split(/\s+/)[0].toLowerCase().replace(/[{}<>]/g, '');
      fence = { char: fm[1][0], len: fm[1].length, info, lang, line: i + 1, lines: [] };
      // 代码块标题：info string 本身也可能是章节名（如 ```deploy 或 ```bash title="Deploy"）
      if (info) {
        headings.push({ text: info, line: i + 1, kind: 'fence', level: 6 });
        const title = /title\s*=\s*["']([^"']+)["']/i.exec(info);
        if (title) headings.push({ text: title[1], line: i + 1, kind: 'fence', level: 6 });
      }
      continue;
    }
    // ATX 标题
    const atx = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      headings.push({ text: atx[2].trim(), line: i + 1, kind: 'heading', level: atx[1].length });
      continue;
    }
    // HTML 标题
    const html = /^\s*<h([1-6])[^>]*>(.+?)<\/h\1>\s*$/i.exec(line);
    if (html) {
      headings.push({ text: html[2].replace(/<[^>]+>/g, '').trim(), line: i + 1, kind: 'heading', level: Number(html[1]) });
      continue;
    }
    // 加粗整行（**Deploy**）也视为标题行，但必须短、不像一句话
    const bold = /^\s*\*\*(.+?)\*\*\s*$/.exec(line);
    if (bold && bold[1].trim().length <= 80 && !/[.!?。！？:：]$/.test(bold[1].trim())) {
      headings.push({ text: bold[1].trim(), line: i + 1, kind: 'heading', level: 6 });
      continue;
    }
    // Setext 标题（下一行 === 或 ---）
    if (line.trim() && !/^\s*[-*+]\s+/.test(line) && i + 1 < lines.length) {
      const under = /^\s{0,3}(=+|-+)\s*$/.exec(lines[i + 1]);
      if (under) {
        const headingText = line.trim();
        const isDash = under[1][0] === '-';
        if (!isDash || (headingText.length <= 80 && !/[.!?。！？:：]$/.test(headingText))) {
          headings.push({ text: headingText, line: i + 1, kind: 'heading', level: isDash ? 2 : 1 });
          i++;
        }
      }
    }
  }
  if (fence) blocks.push(fence);
  return { headings, blocks, lines };
}

// 结构标题列表（不含代码块标题），用于切章节正文
function structuralHeadings(model) {
  return model.headings.filter((h) => h.kind === 'heading').sort((a, b) => a.line - b.line);
}

function collectSectionContent(model, headingRe) {
  const structural = structuralHeadings(model);
  const parts = [];
  for (let i = 0; i < structural.length; i++) {
    const h = structural[i];
    if (!headingRe.test(h.text)) continue;
    let endLine = model.lines.length + 1;
    for (let j = i + 1; j < structural.length; j++) {
      if ((structural[j].level || 6) <= (h.level || 6)) { endLine = structural[j].line; break; }
    }
    parts.push(model.lines.slice(h.line, endLine - 1).join('\n'));
  }
  // 回滚/部署段也可能只以代码块标题出现（```deploy）
  for (const b of model.blocks) {
    if (b.info && headingRe.test(b.info)) parts.push(b.lines.map((l) => l.text).join('\n'));
  }
  return parts.join('\n');
}

// README 里声明的环境变量名（只看变量名，绝不出值）
function readmeEnvNames(model) {
  const names = new Set();
  const isEnvName = (n) => /^[A-Z][A-Z0-9_]{2,}$/.test(n) && (n.includes('_') || n.length >= 4);
  for (const b of model.blocks) {
    const lang = b.lang || '';
    const envish = !lang || ['env', 'dotenv', 'sh', 'bash', 'shell', 'zsh', 'fish', 'console', 'terminal', 'ini', 'yaml', 'yml', 'toml'].includes(lang);
    if (!envish) continue;
    for (const line of b.lines) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*(?:=|:)\s*\S/.exec(line.text);
      if (m && isEnvName(m[1])) names.add(m[1]);
    }
  }
  const envSection = collectSectionContent(model, README_SECTIONS[2].re);
  for (const m of envSection.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
    if (isEnvName(m[1])) names.add(m[1]);
  }
  for (const line of envSection.split('\n')) {
    const row = /^\s*\|\s*`?([A-Z][A-Z0-9_]{2,})`?\s*\|/.exec(line);
    if (row && isEnvName(row[1])) names.add(row[1]);
    const bullet = /^\s*[-*+]\s+`?([A-Z][A-Z0-9_]{2,})`?\s*(?:[:：=]|\s)/.exec(line);
    if (bullet && isEnvName(bullet[1])) names.add(bullet[1]);
  }
  return names;
}

// ---------- 部署线索 ----------

function isDeployFileName(name) {
  const n = String(name || '').toLowerCase();
  return /^(?:dockerfile|containerfile)(?:\.[a-z0-9._-]+)?$/i.test(n)
    || /^(?:docker-)?compose(?:\.[a-z0-9._-]+)?\.ya?ml$/i.test(n)
    || n === 'procfile'
    || /^ecosystem\.config\.(?:js|cjs|mjs|json|ts|ya?ml)$/i.test(n)
    || /\.(?:service|timer)$/i.test(n)
    || START_SCRIPT_RE.test(n)
    || CI_ROOT_FILES.has(n);
}

async function findDeployClues(projectDir, root) {
  const clues = new Set();
  const rootDirs = new Map(root.filter((e) => e.isDirectory()).map((e) => [e.name.toLowerCase(), e.name]));
  for (const e of root) {
    if (e.isFile() && isDeployFileName(e.name)) clues.add(e.name);
  }
  const scanDir = async (rel, predicate) => {
    try {
      const entries = await readdir(path.join(projectDir, rel), { withFileTypes: true });
      for (const e of entries) if (e.isFile() && predicate(e.name)) clues.add(`${rel}/${e.name}`);
    } catch { /* 目录不存在/不可读：不算部署线索 */ }
  };
  if (rootDirs.has('.github')) await scanDir('.github/workflows', (n) => /\.ya?ml$/i.test(n));
  if (rootDirs.has('.circleci')) await scanDir('.circleci', (n) => /^config\.ya?ml$/i.test(n));
  if (rootDirs.has('.buildkite')) await scanDir('.buildkite', (n) => /\.ya?ml$/i.test(n));
  for (const d of ['deploy', 'deployment', 'ops', 'systemd', 'docker']) {
    if (!rootDirs.has(d)) continue;
    const actual = rootDirs.get(d);
    await scanDir(actual, (n) => isDeployFileName(n));
  }
  for (const d of ['scripts', 'bin']) {
    if (!rootDirs.has(d)) continue;
    const actual = rootDirs.get(d);
    await scanDir(actual, (n) => START_SCRIPT_RE.test(n) || /\.(?:service|timer)$/i.test(n));
  }
  return [...clues].sort();
}


export async function checkHandover(projectDir, { tier, excludes = [], includeFixtures = false } = {}) {
  const findings = [];
  const warnings = [];
  const tierId = String(tier || 'L2').toUpperCase();
  // H1 是确定性交接闸：README 缺失等没有启发式歧义，L2/L3 直接卡；L1 只提示。
  const force = tierId === 'L1' ? 'tip' : 'card';
  const push = (rule, severity, file, line, snippet, message, forceOverride) => findings.push({
    checkId: 'H1', severity, force: forceOverride || force, file, line, rule,
    snippet: String(snippet).slice(0, 120), message, source: 'program',
  });

  const root = await rootEntries(projectDir);
  const readme = root.find((e) => e.isFile() && README_NAMES.has(e.name.toLowerCase()));
  const sample = root.find((e) => e.isFile() && SAMPLE_RE.test(e.name));
  const hasLock = root.some((e) => e.isFile() && LOCK_NAMES.has(e.name.toLowerCase()));
  const hasPkgFile = root.some((e) => e.isFile() && e.name === 'package.json');

  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes, { includeFixtures });
  if (skipped.length) warnings.push(t('跳过大文件 {n} 个（>512KB 未扫描）：{files}', { n: skipped.length, files: `${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}` }));
  const pw = prunedWarning(pruned);
  if (pw) warnings.push(pw);

  // 连一个文本文件都没有：没有可查的证据，记覆盖缺口而不是编结论
  if (!readme && files.length === 0) {
    return { checkId: 'H1', findings, coverageGap: 'H1：无文本文件可查', warnings };
  }

  // 服务型 vs 库/CLI：只有服务型仓库才强制要求 env/deploy/rollback 章节。
  // gin/ripgrep/express/svelte 这类库不该因为没有部署章节被扣分。
  let pkgForType = null;
  if (hasPkgFile) {
    try { pkgForType = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8')); } catch { pkgForType = null; }
  }
  const deployArtifact = root.some((e) => DEPLOY_ROOT_FILE_RE.test(e.name)
    || (e.isDirectory() && /^(?:k8s|kubernetes|deploy|charts)$/i.test(e.name)));
  const rootDeps = { ...(pkgForType?.dependencies || {}), ...(pkgForType?.peerDependencies || {}) };
  let serviceLike = Boolean(deployArtifact || (typeof pkgForType?.scripts?.start === 'string' && pkgForType.scripts.start.trim()));
  if (!serviceLike && ['express', 'fastify', 'koa', 'hono', '@nestjs/core', 'next', 'socket.io', '@trpc/server'].some((k) => rootDeps[k])) {
    serviceLike = true;
  }
  if (!serviceLike) {
    const readMaybe = async (p) => readFile(p, 'utf8').catch(() => '');
    const pom = files.find((f) => /pom\.xml$/i.test(f));
    if (pom && /spring-boot-starter-(?:web|actuator)/i.test(await readMaybe(pom))) serviceLike = true;
    const railsRoutes = files.find((f) => /config\/routes\.rb$/i.test(f));
    if (railsRoutes) serviceLike = true;
    const goMain = files.find((f) => /(?:^|\/)main\.go$/i.test(f));
    if (goMain && /http\.(?:ListenAndServe|ServeMux)|gin\.(?:Default|New)|echo\.New|fiber\.New/i.test(await readMaybe(goMain))) serviceLike = true;
    const gemfile = files.find((f) => /(?:^|\/)Gemfile$/i.test(f));
    if (gemfile && /\brails\b/i.test(await readMaybe(gemfile))) serviceLike = true;
  }

  // 1) README：缺失 high；过短 medium；无启动/安装关键词 medium
  let readmeText = null;
  if (!readme) {
    push('H1.readme-missing', 'high', 'README.md', 0, '未找到 README.md / README.rst', t('项目没有 README：接手者不知道项目用途与启动方式'));
  } else {
    try {
      readmeText = await readFile(path.join(projectDir, readme.name), 'utf8');
    } catch {
      warnings.push(t('无法读取 {file}：README 内容检查跳过', { file: readme.name }));
      readmeText = null;
    }
    const textForBasic = readmeText == null ? '' : readmeText;
    const trimmed = textForBasic.trim();
    if (trimmed.length < 400) {
      push('H1.readme-short', 'medium', readme.name, 0, `${trimmed.length} 字符 < 400`, t('README 过短（{n} 字符）：缺少项目用途/启动/配置说明', { n: trimmed.length }));
    }
    if (!START_KEYWORD_RE.test(textForBasic)) {
      push('H1.readme-no-start-keyword', 'medium', readme.name, 0, '未找到 install/run/start/启动/安装/使用', t('README 没有启动或安装关键词：接手者不知道如何跑起来'));
    }
  }

  // README 内容解析：五段 / 回滚可操作性 / 代码块命令 / README 里的环境变量声明
  let readmeModel = null;
  if (readmeText != null) {
    readmeModel = scanReadme(readmeText);

    // 1a) 五段：安装 / 运行 / 环境变量 / 部署 / 回滚；服务型仓库缺哪段报哪段。
    // 库/CLI 只要求安装/运行；强行要求 env/deploy/rollback 是 round2 实测的主要 H1 误报。
    const sectionDefs = serviceLike
      ? README_SECTIONS
      : README_SECTIONS.filter((d) => d.key === 'install' || d.key === 'run');
    const sectionHits = sectionDefs.map((def) => ({ def, hit: readmeModel.headings.find((h) => def.re.test(h.text)) }));
    const missing = sectionHits.filter((x) => !x.hit);
    const sectionSeverity = missing.length >= 3 ? 'medium' : 'low';
    // 缺段分级：L1 提示、L2 只报（force:'check'，不进卡闸）、L3 才卡。
    // 理由：L2 是"有用户"不必然"要交接"，老项目没写回滚段不该一律判死；L3 是公司交付，必须能接手。
    const sectionForce = missing.length >= 3 ? (tierId === 'L3' ? undefined : 'check') : 'tip';
    for (const { def } of missing) {
      const label = t(def.label);
      push(`H1.readme-section-${def.key}`, sectionSeverity, readme.name, 0, label,
        t('README 缺少「{section}」章节：接手者无法按文档完成该步骤', { section: label }),
        sectionForce);
    }

    // 1b) 回滚段只有标题、没有可执行线索（只对服务型仓库）
    const rollbackHit = serviceLike ? sectionHits.find((x) => x.def.key === 'rollback').hit : null;
    if (rollbackHit) {
      const content = collectSectionContent(readmeModel, ROLLBACK_RE).replace(/<!--[\s\S]*?-->/g, '').trim();
      if (!ROLLBACK_CLUE_RE.test(content)) {
        push('H1.readme-rollback-vague', 'low', readme.name, rollbackHit.line, rollbackHit.text,
          t('README 回滚章节只有标题、没有可执行线索（如「回滚到上一版本」/rollback to/vX.Y.Z）：接手者不知道如何回滚'), 'tip');
      }
    }
  }

  // 2) package.json：缺失不做结论（可能非 Node 项目）；有但无 start/dev/build/test → medium
  let pkg = null;
  let pkgMissing = false;
  let pkgParseFailed = false;
  try {
    pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') pkgMissing = true;
    else { pkgParseFailed = true; warnings.push(t('package.json 解析失败：scripts 检查跳过')); }
  }
  let pkgScripts = null;
  if (!pkgMissing && !pkgParseFailed && pkg && typeof pkg === 'object') {
    pkgScripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
    const hasAny = ['start', 'dev', 'build', 'test'].some((k) => typeof pkgScripts[k] === 'string' && pkgScripts[k].trim());
    if (!hasAny) {
      push('H1.no-scripts', 'medium', 'package.json', 0, `scripts: ${Object.keys(pkgScripts).slice(0, 8).join(', ') || '(空)'}`, t('package.json 没有 start/dev/build/test 任一脚本：接手者不知道如何启动/构建/测试'));
    }
  }
  if (pkgMissing) {
    warnings.push(t('未找到 package.json（可能不是 Node 项目）：H1 的 scripts 检查跳过'));
  }

  // 2b) README 代码块命令：只做静态校验，绝不执行
  if (readmeModel) {
    const commands = [];
    for (const block of readmeModel.blocks) {
      if (!isShellBlock(block)) continue;
      commands.push(...extractBlockCommands(block));
    }
    const seenCmd = new Set();
    const uniqueCommands = [];
    for (const item of commands) {
      if (seenCmd.has(item.cmd)) continue;
      seenCmd.add(item.cmd);
      uniqueCommands.push(item);
    }
    const missingFiles = new Map();
    const missingScripts = new Map();
    const manual = [];
    const pkgCache = new Map();
    const rootPkg = { scripts: pkgScripts, hasPkg: hasPkgFile };
    for (const item of uniqueCommands) {
      const problems = await inspectCommand(item.cmd, { projectDir, rootPkg, pkgCache });
      if (!problems.length) {
        if (!isTrivialCommand(item.cmd)) manual.push(item);
        continue;
      }
      for (const p of problems) {
        if (p.kind === 'script' && !missingScripts.has(p.script)) missingScripts.set(p.script, item);
        if (p.kind === 'file' && !missingFiles.has(p.path)) missingFiles.set(p.path, item);
      }
    }
    for (const [missingPath, item] of missingFiles) {
      // 包管理器安装/下载/URL 里的名字不是本地文件（npm i ollama、curl https://...）
      if (/^(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|i|install)|yarn\s+add|brew\s+install|apt(?:-get)?\s+install|docker\s+pull|go\s+(?:install|get)|pip3?\s+install|cargo\s+install|gem\s+install)\b/i.test(item.cmd)) continue;
      if (/^(?:https?:\/\/|<|\.\.\.|…)/.test(String(missingPath || '')) || /https?:\/\//i.test(item.cmd)) continue;
      // README 先教读者创建/保存这个文件（gin: "Save the code above as main.go"），
      // 再运行它 —— 不是命令引用了缺失文件。
      if (readmeText && readmeCreatesPath(readmeText, missingPath)) continue;
      push('H1.command-missing-file', 'medium', readme.name, item.line, item.cmd,
        t('README 命令引用的本地路径不存在：{paths}（命令见证据）', { paths: missingPath }));
    }
    for (const [script, item] of missingScripts) {
      // express-generator / npm init / create-* 生成的新应用里的 npm start 不属于本仓
      const before = readmeText
        ? readmeText.split('\n').slice(0, Math.max(0, Number(item.line) - 1)).join('\n')
        : '';
      if (readmeUsesGenerator(before || readmeText || '')) continue;
      push('H1.command-missing-script', 'medium', readme.name, item.line, item.cmd,
        t('README 命令引用的 npm script 不存在：{script}（命令见证据）', { script }));
    }
    const shown = manual.slice(0, 10);
    for (const item of shown) {
      // finding 契约里没有单独的 level 字段：level:'check' 对应 force:'check'（提醒级，不卡闸）
      push('H1.command-manual-check', 'low', readme.name, item.line, item.cmd,
        t('命令「{cmd}」无法静态验证，需人工执行验证（本检查不会代替你运行）', { cmd: shortCommand(item.cmd) }), 'check');
    }
    if (manual.length > shown.length) {
      push('H1.command-manual-check-more', 'low', readme.name, 0, `${manual.length - shown.length} 条`,
        t('另有 {n} 条命令无法静态验证，需人工执行验证', { n: manual.length - shown.length }), 'check');
    }
  }

  // 3/4) 环境变量：代码里 process.env.X / import.meta.env.X 与 .env.example/.env.sample 对账
  const envVars = new Map(); // NAME -> {file, line}
  for (const f of files) {
    if (!CODE_RE.test(f)) continue;
    let text;
    try { text = await readFile(f, 'utf8'); } catch { continue; }
    const rel = path.relative(projectDir, f).replace(/\\/g, '/');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(ENV_VAR_RE)) {
        if (!envVars.has(m[1])) envVars.set(m[1], { file: rel, line: i + 1 });
      }
    }
  }
  const codeNames = [...envVars.keys()].sort();
  const codeSet = new Set(codeNames);

  let sampleKeys = null;
  // 根目录之外（examples/*/.env.example）有样本也算有证据；H1 只认根目录会误报 trpc 这类 monorepo。
  const envTemplateAnywhere = sample || files.find((f) => /\.env\.(?:example|sample|template|dist|default)(?:\.|$)/i.test(path.basename(f)));
  if (sample) {
    const sampleText = await readFile(path.join(projectDir, sample.name), 'utf8').catch(() => null);
    if (sampleText == null) {
      warnings.push(t('无法读取 {file}：环境变量样本检查跳过', { file: sample.name }));
    } else {
      const parsed = parseSample(sampleText);
      sampleKeys = new Set(parsed.map((x) => x.key));
      if (codeNames.length) {
        const missing = codeNames.filter((n) => !sampleKeys.has(n));
        if (missing.length) {
          const first = missing.slice(0, 10);
          push('H1.env-sample-missing-vars', 'medium', sample.name, 0, first.join(', '),
            t('代码用到但 {file} 未列出的环境变量（{n} 个）：{names}', { file: sample.name, n: missing.length, names: `${first.join(', ')}${missing.length > 10 ? ` 等 ${missing.length} 个` : ''}` }));
        }
      }
      for (const entry of parsed) {
        if (!looksLikeSecretValue(entry.key, entry.value)) continue;
        // 只报变量名：snippet/message 都不出现值本体
        push('H1.env-sample-real-value', 'high', sample.name, entry.line, entry.key,
          t('{file} 的 {key} 值疑似真实密钥：请改为占位符（报告不回显该值）', { file: sample.name, key: entry.key }));
      }
    }
  } else if (!envTemplateAnywhere && codeNames.length) {
    // 库/CLI 的环境变量多是构建/测试开关（NODE_ENV/CI/NO_DEPRECATION），不是部署配置；
    // 只保留像凭据/连接串的变量再报，避免把库的构建变量当部署缺口。
    const relevant = serviceLike ? codeNames : codeNames.filter((n) => SERVICE_ENV_RE.test(n));
    if (relevant.length) {
      const first = relevant.slice(0, 10);
      push('H1.env-no-sample', 'medium', '(环境变量)', 0, first.join(', '),
        t('代码使用 {n} 个环境变量，但没有 .env.example/.env.sample：{names}', { n: relevant.length, names: `${first.join(', ')}${relevant.length > 10 ? ` 等 ${relevant.length} 个` : ''}` }));
    }
  }

  // 4b) 反向 diff：README / 样本声明了、但代码没用到的变量（可能过期）；只比对变量名
  if (codeNames.length && (sampleKeys || readmeModel)) {
    const declared = new Set(sampleKeys || []);
    if (readmeModel) for (const n of readmeEnvNames(readmeModel)) declared.add(n);
    const unused = [...declared].filter((n) => !codeSet.has(n)).sort();
    if (unused.length) {
      const first = unused.slice(0, 10);
      const source = [readme?.name, sample?.name].filter(Boolean).join(' / ') || '(环境变量)';
      push('H1.env-declared-unused-vars', 'low', sample?.name || readme?.name || '(环境变量)', 0, first.join(', '),
        t('{source} 声明的环境变量在代码中未使用（可能已过期）：{names}', { source, names: `${first.join(', ')}${unused.length > 10 ? ` 等 ${unused.length} 个` : ''}` }), 'tip');
    }
  }

  // 5) lockfile：只记 warning，S4 已按覆盖缺口处理
  if (!pkgMissing && !hasLock) {
    warnings.push(t('未找到 lockfile（package-lock/yarn.lock/pnpm-lock）：S4 依赖关会记覆盖缺口，H1 只记 warning 不重复扣分'));
  }

  // 5b) 部署线索：Dockerfile / compose / CI / 启动脚本
  const deployClues = await findDeployClues(projectDir, root);
  if (!deployClues.length) {
    push('H1.no-deploy-clue', 'low', '(仓库根)', 0, '未发现 Dockerfile / compose / CI / 启动脚本',
      t('未发现 Dockerfile/compose/CI/启动脚本（systemd/pm2/Procfile）：接手者不知道怎么上线'), 'tip');
  } else {
    warnings.push(t('info：发现部署线索：{clues}', { clues: deployClues.slice(0, 5).join('、') + (deployClues.length > 5 ? '…' : '') }));
  }

  // 6) 交接材料：只进 warnings 的 info，不加分不扣分
  if (root.some((e) => e.isFile() && e.name.toLowerCase() === 'agents.md')) {
    warnings.push(t('info：发现 AGENTS.md（交接/项目记忆材料，不扣分）'));
  }
  if (root.some((e) => e.isDirectory() && e.name.toLowerCase() === 'docs')) {
    warnings.push(t('info：发现 docs/ 目录（交接材料，不扣分）'));
  }

  return { checkId: 'H1', findings, coverageGap: null, warnings };
}

// 命名别名：调用方按矩阵编号找入口时可直接用 checkH1
export const checkH1 = checkHandover;
