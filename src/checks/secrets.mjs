import { listTextFiles, readRel, prunedWarning } from '../walk.mjs';
import { runProcess } from '../run-async.mjs';
import { resolveGitleaks, runGitleaks } from './gitleaks.mjs';

// S3 密钥与弱默认（ACCEPTANCE §4-A）。判定程序 = Gitleaks（可选增强）+ 自研规则
// 自食教训：文档(.md/.txt)里的教学示例不算实锤 → 降为提醒级线索
//
// 自食教训（2026-11-08 真仓自查）：原正则 `\b(key)\b\s*[:=]\s*['"]` 有两处系统性漏报：
//   1) JSON 的键名带引号（`"apiKey": "sk-…"`）——键名后的 `"` 卡住了 `\s*[:=]`，最常见的配置形态反而不命中；
//   2) `\b` 在 `_` 两边不成立 → `client_secret` / `access_token` / `DB_PASSWORD` 全漏。
// 键名允许「前缀 + 后缀」：snake（client_secret / DB_PASSWORD）、kebab、camel（clientSecret / accessToken）；
// 用 \b 卡住词尾，避免 passwordless / tokenizer / secretary 误报。
const SECRET_KEY = '(?:(?:[A-Za-z0-9]+[_-])|(?:[a-z][a-z0-9]*(?=[A-Z])))?(?:api[_-]?key|secret|token|pass(?:word|wd)|pwd)(?:[_-][A-Za-z0-9]+)?';
// 无引号值的常见密钥前缀：覆盖 .env / shell / docker-compose / CI 的写法
const SECRET_VALUE = '(?:sk[-_][A-Za-z0-9_-]{8,}|pk_(?:live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{8,})';
const ALLOW_HINT = /process\.env|your[-_]|example|placeholder|changeme|dummy|xxx|<[^>]*>|\$\{/i;
const ALLOW_VALUE = /process\.env|your[-_]|example|placeholder|changeme|dummy|xxx|<[^>]*>|\$\{|application\/json|text\/html|utf-8|\bundefined\b|\bBearer\b/i;
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

// 值侧判别（自食教训 2026-11-08）：放宽键名后，'new-password' : 'current-password'、
// 'bad-sync-token': '令牌不對'、const SECRET_KEY = '(?:...' 这类都会被当成密钥。
// 真正的密钥值有熵：不能是中文文案、不能是 kebab 单词、不能是纯字母，也不能是正则源码。
function looksLikeSecret(v) {
  if (!v || v.length < 8) return false;
  if (CJK_RE.test(v)) return false; // 中文文案 / 错误提示
  if (/\(\?:|\[A-Za-z|\\[bsdDwW]/.test(v)) return false; // 正则/模式源码（常量定义）
  if (/^[a-z]+(?:-[a-z]+)+$/.test(v)) return false; // current-password 这类 kebab 单词
  if (/^[a-z]+$/.test(v)) return false; // 纯小写单词
  if (/^[A-Z][a-z]+$/.test(v)) return false; // 单个首字母大写单词（多半是词/类型名）
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
  return classes >= 2; // 至少两类字符：数字+字母 / 大小写混合 / 含符号
}

const RULES = [
  { id: 'S3.aws-key', re: /AKIA[0-9A-Z]{16}/, msg: '疑似 AWS Access Key 硬编码' },
  { id: 'S3.private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, msg: '私钥内容硬编码' },
  { id: 'S3.secret-literal', re: new RegExp(`\\b${SECRET_KEY}["']?\\s*[:=]\\s*['"]([^'"\\s]{8,})['"]`, 'i'), msg: '疑似密钥/口令字面量', allow: ALLOW_VALUE, verify: looksLikeSecret },
  { id: 'S3.secret-value', re: new RegExp(`\\b${SECRET_KEY}["']?\\s*[:=]\\s*(${SECRET_VALUE})`, 'i'), msg: '疑似密钥值（未加引号的常见密钥前缀）', allow: ALLOW_HINT, verify: (v) => v.length >= 8 },
  { id: 'S3.weak-default', re: new RegExp(`(?:${SECRET_KEY})["']?\\s*[:=]\\s*['"](admin|admin123|123456|12345678|password|root|qwerty)['"]`, 'i'), msg: '弱默认口令' },
];

// exclude 对 S3 只允许用于夹具/构建产物；真实配置文件（desktop/config.json 等）永远不能排除。
// 白名单按路径段判定，避免 `tests` / `playbooks` / 运行时目录把真实密钥一起藏起来。
const S3_SAFE_EXCLUDE_SEG_RE = /^(?:fixtures|node_modules|coverage|dist|build|out|release|release-[A-Za-z0-9._-]+|dist-[A-Za-z0-9._-]+|[A-Za-z0-9._-]+-unpacked)$/i;

export function sanitizeS3Excludes(excludes = []) {
  const list = Array.isArray(excludes) ? excludes : [];
  return list.filter((x) => String(x).replace(/\\/g, '/').split('/').filter(Boolean)
    .some((seg) => S3_SAFE_EXCLUDE_SEG_RE.test(seg)));
}

// 真实配置文件的形状：config/settings/secrets/credentials/keys/providers + 配置扩展名。
// 只对命中了密钥规则的这类文件做「未入库但落盘」提示；普通测试源码不在此列。
const CONFIG_CANDIDATE_RE = /(?:^|[./])(?:config|settings|secrets?|credentials?|keys?|providers?)\.(?:json|json5|ya?ml|toml|ini|conf|cfg|js|mjs|cjs|ts|tsx)$/i;

// S3.env-tracked 的排除口径：示例/模板文件即使被提交，也只是供人复制的样板，不是密钥。
// 只按文件名后缀认（.env.example / .env.sample / .env.template / .env.dist /
// .env.example.local / .env.production.example …）；真正的 .env / .env.local /
// .env.production 不在此列，避免把真实配置一起放过。
const ENV_TEMPLATE_NAME_RE = /\.(?:example|sample|template|tmpl|dist)(?:\.[^/\\]+)*$/i;

function isEnvTemplatePath(file) {
  const name = String(file || '').replace(/\\/g, '/').split('/').pop() || '';
  return ENV_TEMPLATE_NAME_RE.test(name);
}

// 被 git 跟踪的 .env 类文件是否算「已提交密钥」：
//   1) 示例/模板名 → 不算；
//   2) 用 `git check-ignore -v --no-index` 复核忽略规则（tracked 路径默认不参与 check-ignore，
//      必须 --no-index 才按 .gitignore 判定）：命中普通规则 = 本应被忽略（多为 -f 误加）→ 跳过；
//      命中以 `!` 开头的否定规则 = 明确不忽略 → 仍按事故处理。
// git 异常 / 未命中任何规则 → 保守按已提交处理。
async function isCommittedEnvSecret(projectDir, file) {
  if (isEnvTemplatePath(file)) return false;
  const ci = await runProcess('git', ['-C', projectDir, 'check-ignore', '-v', '--no-index', '--', file], { timeoutMs: 10000 });
  if (ci.status !== 0) return true;
  const first = String(ci.stdout || '').split('\t')[0];
  const m = first.match(/^(.*?):(\d+):(.*)$/s);
  if (m && m[3].startsWith('!')) return true; // 否定规则：不忽略
  return false; // 普通忽略规则命中：本机文件，不算已提交密钥
}

async function applyUntrackedConfigHints(projectDir, findings, warnings) {
  const configFiles = [...new Set(findings.map((f) => f.file).filter((f) => CONFIG_CANDIDATE_RE.test(String(f || ''))))];
  if (!configFiles.length) return findings;
  let gitUsable = true;
  for (const file of configFiles) {
    const tracked = await runProcess('git', ['-C', projectDir, 'ls-files', '--', file], { timeoutMs: 10000 });
    if (tracked.status === null || tracked.status !== 0) { gitUsable = false; continue; }
    if (String(tracked.stdout || '').trim()) continue; // 已入库：保持正常 high/card 判定
    const ignored = await runProcess('git', ['-C', projectDir, 'check-ignore', '--', file], { timeoutMs: 10000 });
    if (ignored.status === null) { gitUsable = false; continue; }
    if (ignored.status !== 0) continue; // 未入库但也未被 gitignore：保持原判定
    // 本机明文密钥文件：只报 check 级提示，报告不回显任何值/行内容。
    const lines = findings.filter((f) => f.file === file).map((f) => Number(f.line)).filter((n) => Number.isFinite(n) && n > 0);
    findings = findings.filter((f) => f.file !== file);
    findings.push({
      checkId: 'S3',
      severity: 'medium',
      force: 'check',
      file,
      line: lines.length ? Math.min(...lines) : 0,
      rule: 'S3.untracked-secret-file',
      snippet: `${file}（本机文件，未入库）`,
      message: '本机存在明文密钥文件，未入库但落盘——请改用环境变量或系统密钥存储；报告不回显密钥值',
      source: 'program',
    });
    warnings.push(`S3：${file} 是本机未入库的明文密钥文件，已按 check 级提示（不回显值）`);
  }
  if (!gitUsable) warnings.push('git 不可用或不在仓库内，未入库密钥文件判定未跑');
  return findings;
}

export async function checkSecrets(projectDir, { excludes = [], includeFixtures = false, gitleaks = {} } = {}) {
  const findings = [];
  const warnings = [];
  const effectiveExcludes = sanitizeS3Excludes(excludes);
  const { files, skipped, pruned } = await listTextFiles(projectDir, effectiveExcludes, { includeFixtures });
  if (skipped.length) warnings.push(`跳过大文件 ${skipped.length} 个（>512KB 未扫描）：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}`);
  const pw = prunedWarning(pruned);
  if (pw) warnings.push(pw);
  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    if (/\.env($|\.)/i.test(file)) continue; // 密钥就该住在这里，不扫
    if (/package-lock|yarn\.lock|pnpm-lock/.test(file)) continue;
    const isDoc = /\.(md|txt)$/i.test(file);
    const lines = text.split('\n');
    const minified = lines.filter((l) => l.length > 1000).length;
    if (minified) warnings.push(`疑似压缩/第三方代码跳过 ${minified} 行：${file}`);
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 1000) continue; // 自食教训#5：minified 第三方代码不是用户的锅
        const m = rule.re.exec(line);
        if (!m) continue;
        if (rule.verify && !rule.verify(m[1] || '')) continue; // 值侧判别：低熵/文案/正则源码不算
        if (rule.allow && rule.allow.test(line)) continue;
        if (/finalcheck:allow/.test(line)) continue;
        const raw = line.trim().slice(0, 120);
        const snippet = raw
          .replace(/(['"])[^'"]{6,}\1/g, '$1***$1') // 密钥值脱敏：报告永不回显密钥本体
          .replace(/(=\s*)[^\s'"]{8,}/g, '$1***')
          .replace(/[A-Z0-9]{16,}/g, '***');
        findings.push({
          checkId: 'S3',
          severity: isDoc ? 'medium' : 'high',
          force: isDoc ? 'tip' : 'card',
          file, line: i + 1, rule: rule.id,
          snippet,
          message: isDoc ? `${rule.msg}（出现在文档中，可能是示例）` : rule.msg,
          source: 'program',
        });
      }
    }
  }
  // .env 类文件被 git 追踪 = 事故（P2#12：覆盖 *.env*，git 缺失要上报）
  // 示例/模板（.env.example 等）和被忽略的文件不算已提交密钥，只影响 S3.env-tracked。
  const git = await runProcess('git', ['-C', projectDir, 'ls-files', '-z', '*.env*'], { timeoutMs: 10000 });
  if (git.status === 0) {
    const trackedEnv = String(git.stdout || '').split('\0').map((x) => x.trim()).filter(Boolean);
    const committed = [];
    for (const f of trackedEnv) {
      if (await isCommittedEnvSecret(projectDir, f)) committed.push(f);
    }
    for (const f of committed.slice(0, 5)) {
      findings.push({ checkId: 'S3', severity: 'high', force: 'card', file: f, line: 0, rule: 'S3.env-tracked', snippet: `${f} 在 git 追踪列表中`, message: '.env 类文件已提交进仓库', source: 'program' });
    }
  } else if (git.status === null) {
    warnings.push('git 不可用，.env 追踪检查未跑');
  }
  // Gitleaks 增强（§7）：适配层负责定位/临时报告/解析；缺失仅 warning（自研规则仍覆盖），
  // 配置或探测到但跑不起来（失败/超时/坏报告）才记 coverageGap。
  const glConfig = gitleaks && typeof gitleaks === 'object' && !Array.isArray(gitleaks) ? gitleaks : {};
  const glBinary = resolveGitleaks({ config: glConfig, env: process.env });
  const gl = await runGitleaks(projectDir, {
    binaryPath: glBinary,
    timeoutMs: glConfig.timeoutMs,
    scanHistory: glConfig.scanHistory === true,
    excludes: effectiveExcludes,
  });
  warnings.push(...gl.warnings);
  let coverageGap = null;
  if (gl.gapKind === 'unavailable') coverageGap = gl.gapReason || 'gitleaks 不可用';
  // 与自研 findings 同 file+line 去重：保留自研判定，gitleaks 规则名只进 warnings。
  const selfByLocation = new Map();
  for (const f of findings) {
    if (Number(f.line) > 0) selfByLocation.set(`${f.file}:${f.line}`, f);
  }
  for (const gf of gl.findings) {
    const self = Number(gf.line) > 0 ? selfByLocation.get(`${gf.file}:${gf.line}`) : null;
    if (self) {
      warnings.push(`gitleaks 规则 ${gf.rule.slice('S3.gitleaks:'.length)} 与自研规则 ${self.rule} 同位置（${gf.file}:${gf.line}），保留自研判定`);
      continue;
    }
    findings.push(gf);
  }
  const finalized = await applyUntrackedConfigHints(projectDir, findings, warnings);
  return { checkId: 'S3', findings: finalized, coverageGap, warnings };
}
