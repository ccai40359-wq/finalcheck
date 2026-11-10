import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { listTextFiles, readRel, prunedWarning } from '../walk.mjs';
import { findBinary } from '../which.mjs';
import { runProcess } from '../run-async.mjs';

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

export async function checkSecrets(projectDir, { excludes = [] } = {}) {
  const findings = [];
  const warnings = [];
  const { files, skipped, pruned } = await listTextFiles(projectDir, excludes);
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
  const git = await runProcess('git', ['-C', projectDir, 'ls-files', '*.env*'], { timeoutMs: 10000 });
  if (git.status === 0 && git.stdout && git.stdout.trim()) {
    for (const f of git.stdout.trim().split('\n').slice(0, 5)) {
      findings.push({ checkId: 'S3', severity: 'high', force: 'card', file: f.trim(), line: 0, rule: 'S3.env-tracked', snippet: `${f.trim()} 在 git 追踪列表中`, message: '.env 类文件已提交进仓库', source: 'program' });
    }
  } else if (git.status === null) {
    warnings.push('git 不可用，.env 追踪检查未跑');
  }
  // Gitleaks 增强（§7 必装；缺失或运行失败 → 覆盖不足按 §5 封顶）
  const glPath = findBinary('gitleaks');
  if (glPath) {
    const rep = path.join(projectDir, '.finalcheck-gitleaks.tmp.json');
    const run = await runProcess(glPath, ['detect', '--source', projectDir, '--report-format', 'json', '--report-path', rep, '--no-git', '--exit-code', '0', '--no-banner', '--redact'], { timeoutMs: 120000 });
    if (run.error) return { checkId: 'S3', findings, coverageGap: 'gitleaks 运行失败', warnings };
    let leaks = null;
    try { leaks = JSON.parse(await readFile(rep, 'utf8')); } catch { /* 报告缺失 */ }
    await rm(rep, { force: true }).catch(() => {});
    if (run.status !== 0 || !Array.isArray(leaks)) {
      // P1#4：跑挂了绝不能计为"已执行"
      return { checkId: 'S3', findings, coverageGap: 'gitleaks 报告缺失或异常', warnings };
    }
    for (const l of leaks) {
      const relFile = String(l.File || '').replace(/\\/g, '/');
      if (excludes.some((x) => { const n = String(x).replace(/\\/g, '/'); return relFile === n || relFile.startsWith(n + '/'); })) continue; // P1#5：夹具排除对 gitleaks 同样生效
      const isDoc = /\.(md|txt)$/i.test(relFile);
      findings.push({ checkId: 'S3', severity: isDoc ? 'medium' : 'high', force: isDoc ? 'tip' : 'card', file: relFile, line: l.StartLine || 0, rule: 'S3.gitleaks', snippet: `gitleaks 规则 ${l.RuleID} 命中`, message: 'gitleaks 检出疑似密钥', source: 'program' });
    }
    return { checkId: 'S3', findings, coverageGap: null, warnings };
  }
  return { checkId: 'S3', findings, coverageGap: null, warnings: [...warnings, 'gitleaks 未安装：自研 4 规则覆盖（广度有限，装 gitleaks 可增强至 600+ 规则）'] };
}
