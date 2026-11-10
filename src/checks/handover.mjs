import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles, prunedWarning } from '../walk.mjs';

// H1 交接检查（L2 静态闸）：接手者不看代码也能把项目跑起来吗？
// 纯静态：不执行项目命令、不读 .env 本体。缺 README / 启动说明 / 环境变量样本时给结论；
// lockfile 缺失只记 warning（S4 已有覆盖缺口，同一事实不重复扣分）。
const CODE_RE = /\.(?:ts|js|mjs|jsx|tsx)$/i;
const ENV_VAR_RE = /(?:process\.env|import\.meta\.env)\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
const README_NAMES = new Set(['readme.md', 'readme.rst']);
const SAMPLE_RE = /^\.env\.(?:example|sample)$/i;
const START_KEYWORD_RE = /\b(?:install|run|start)\b|启动|安装|使用/i;
const LOCK_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-lock.yml']);

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

export async function checkHandover(projectDir, { tier, excludes = [] } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  // H1 是确定性交接闸：README 缺失等没有启发式歧义，L2/L3 直接卡；L1 只提示。
  const force = t === 'L1' ? 'tip' : 'card';
  const push = (rule, severity, file, line, snippet, message) => findings.push({
    checkId: 'H1', severity, force, file, line, rule,
    snippet: String(snippet).slice(0, 120), message, source: 'program',
  });

  const root = await rootEntries(projectDir);
  const readme = root.find((e) => e.isFile() && README_NAMES.has(e.name.toLowerCase()));
  const sample = root.find((e) => e.isFile() && SAMPLE_RE.test(e.name));
  const hasLock = root.some((e) => e.isFile() && LOCK_NAMES.has(e.name.toLowerCase()));

  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes);
  if (skipped.length) warnings.push(`跳过大文件 ${skipped.length} 个（>512KB 未扫描）：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}`);
  const pw = prunedWarning(pruned);
  if (pw) warnings.push(pw);

  // 连一个文本文件都没有：没有可查的证据，记覆盖缺口而不是编结论
  if (!readme && files.length === 0) {
    return { checkId: 'H1', findings, coverageGap: 'H1：无文本文件可查', warnings };
  }

  // 1) README：缺失 high；过短 medium；无启动/安装关键词 medium
  if (!readme) {
    push('H1.readme-missing', 'high', 'README.md', 0, '未找到 README.md / README.rst', '项目没有 README：接手者不知道项目用途与启动方式');
  } else {
    const text = await readFile(path.join(projectDir, readme.name), 'utf8').catch(() => '');
    const trimmed = text.trim();
    if (trimmed.length < 400) {
      push('H1.readme-short', 'medium', readme.name, 0, `${trimmed.length} 字符 < 400`, `README 过短（${trimmed.length} 字符）：缺少项目用途/启动/配置说明`);
    }
    if (!START_KEYWORD_RE.test(text)) {
      push('H1.readme-no-start-keyword', 'medium', readme.name, 0, '未找到 install/run/start/启动/安装/使用', 'README 没有启动或安装关键词：接手者不知道如何跑起来');
    }
  }

  // 2) package.json：缺失不做结论（可能非 Node 项目）；有但无 start/dev/build/test → medium
  let pkg = null;
  let pkgMissing = false;
  try {
    pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') pkgMissing = true;
    else warnings.push('package.json 解析失败：scripts 检查跳过');
  }
  if (pkgMissing) {
    warnings.push('未找到 package.json（可能不是 Node 项目）：H1 的 scripts 检查跳过');
  } else if (pkg && typeof pkg === 'object') {
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const hasAny = ['start', 'dev', 'build', 'test'].some((k) => typeof scripts[k] === 'string' && scripts[k].trim());
    if (!hasAny) {
      push('H1.no-scripts', 'medium', 'package.json', 0, `scripts: ${Object.keys(scripts).slice(0, 8).join(', ') || '(空)'}`, 'package.json 没有 start/dev/build/test 任一脚本：接手者不知道如何启动/构建/测试');
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

  if (sample) {
    const sampleText = await readFile(path.join(projectDir, sample.name), 'utf8').catch(() => null);
    if (sampleText == null) {
      warnings.push(`无法读取 ${sample.name}：环境变量样本检查跳过`);
    } else {
      const parsed = parseSample(sampleText);
      const sampleKeys = new Set(parsed.map((x) => x.key));
      if (codeNames.length) {
        const missing = codeNames.filter((n) => !sampleKeys.has(n));
        if (missing.length) {
          const first = missing.slice(0, 10);
          push('H1.env-sample-missing-vars', 'medium', sample.name, 0, first.join(', '),
            `代码用到但 ${sample.name} 未列出的环境变量（${missing.length} 个）：${first.join(', ')}${missing.length > 10 ? ` 等 ${missing.length} 个` : ''}`);
        }
      }
      for (const entry of parsed) {
        if (!looksLikeSecretValue(entry.key, entry.value)) continue;
        // 只报变量名：snippet/message 都不出现值本体
        push('H1.env-sample-real-value', 'high', sample.name, entry.line, entry.key,
          `${sample.name} 的 ${entry.key} 值疑似真实密钥：请改为占位符（报告不回显该值）`);
      }
    }
  } else if (codeNames.length) {
    const first = codeNames.slice(0, 10);
    push('H1.env-no-sample', 'medium', '(环境变量)', 0, first.join(', '),
      `代码使用 ${codeNames.length} 个环境变量，但没有 .env.example/.env.sample：${first.join(', ')}${codeNames.length > 10 ? ` 等 ${codeNames.length} 个` : ''}`);
  }

  // 5) lockfile：只记 warning，S4 已按覆盖缺口处理
  if (!pkgMissing && !hasLock) {
    warnings.push('未找到 lockfile（package-lock/yarn.lock/pnpm-lock）：S4 依赖关会记覆盖缺口，H1 只记 warning 不重复扣分');
  }

  // 6) 交接材料：只进 warnings 的 info，不加分不扣分
  if (root.some((e) => e.isFile() && e.name.toLowerCase() === 'agents.md')) {
    warnings.push('info：发现 AGENTS.md（交接/项目记忆材料，不扣分）');
  }
  if (root.some((e) => e.isDirectory() && e.name.toLowerCase() === 'docs')) {
    warnings.push('info：发现 docs/ 目录（交接材料，不扣分）');
  }

  return { checkId: 'H1', findings, coverageGap: null, warnings };
}

// 命名别名：调用方按矩阵编号找入口时可直接用 checkH1
export const checkH1 = checkHandover;
