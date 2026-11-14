import { existsSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../run-async.mjs';
import { isSuppressedSecretValue, looksLikeSecret, pemHasBody, hasKnownRealPrefix } from './secrets.mjs';

// S3 历史密钥（ACCEPTANCE §4-A S3 的补充面）：只看 git 历史里“新增过”的行。
// 仅项目根存在 .git 时执行；git log 失败/超时 → coverageGap（不抛错、不冒充通过）。
// 报告绝不回显明文：snippet 只给「键名 + 值已抹除（长度 N）」。
// 文件遍历不手写递归；这里读的是 git 输出，不读工作区文件。

const MAX_OUT = 64 * 1024 * 1024;
const HISTORY_RULES = [
  {
    id: 'S3.history-aws-key',
    label: 'AWS Access Key',
    re: /AKIA[0-9A-Z]{16}/,
    snippet: (m) => `AWS Access Key 值已抹除（长度 ${m[0].length}）`,
  },
  {
    id: 'S3.history-private-key',
    label: 'PEM 私钥块',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    snippet: (m) => `私钥块 值已抹除（长度 ${m[0].length}）`,
  },
  {
    id: 'S3.history-secret-literal',
    label: '密钥/口令字面量',
    re: /(api_key|secret|password|token)\s*[:=]\s*['"]([A-Za-z0-9_\-]{16,})/i,
    snippet: (m) => `${m[1]} 值已抹除（长度 ${m[2].length}）`,
  },
];

function isExcluded(rel, excludes) {
  const r = String(rel || '').replace(/\\/g, '/');
  return (Array.isArray(excludes) ? excludes : []).some((x) => {
    const n = String(x || '').replace(/\\/g, '/');
    return r === n || r.startsWith(n + '/');
  });
}

// git 默认 core.quotepath=true：中文路径会输出成 "playbooks/...\345\211\215..."（C 风格八进制转义）。
// JSON.parse 解不了八进制，直接去引号会把 \345 留在路径里，报告出现乱码目录。
function decodeGitQuotedPath(body) {
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const next = body[i + 1];
    const oct = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(oct)) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
    const esc = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, '\\': 92, '"': 34 }[next];
    if (esc !== undefined) { bytes.push(esc); i += 1; continue; }
    if (next !== undefined) { bytes.push(...Buffer.from(next, 'utf8')); i += 1; }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseGitPath(raw) {
  let p = String(raw).trim();
  if (p.startsWith('"') && p.endsWith('"')) {
    const body = p.slice(1, -1);
    if (/\\[0-7]{3}/.test(body)) p = decodeGitQuotedPath(body);
    else { try { p = JSON.parse(p); } catch { p = body; } }
  }
  if (p === '/dev/null') return null;
  if (p.startsWith('b/') || p.startsWith('a/')) p = p.slice(2);
  return p.replace(/\\/g, '/');
}

// git log -p 输出 → 补丁内的新增/删除/上下文行扫描。
// 只看 hunk 内容（不看 commit message / 文件头），同一密钥按「规则+文件+脱敏片段」去重，
// 避免它在后续每个提交里重复出现。line 对新增/上下文行取新文件行号，对删除行取旧文件行号。
// 值抑制与工作树检查共用（secrets.mjs 的 isSuppressedSecretValue），不按路径跳过。
function scanPatch(stdout, excludes, findings) {
  let currentFile = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let commitHash = '';
  let hunk = [];
  const seen = new Set();

  const emit = (rule, content, lineNo, texts, index) => {
    if (!currentFile || isExcluded(currentFile, excludes)) return;
    const m = rule.re.exec(content);
    if (!m) return;
    if (rule.id === 'S3.history-private-key' && !pemHasBody(texts, index, content)) return;
    if (rule.id === 'S3.history-secret-literal') {
      const value = m[2] || '';
      if (!looksLikeSecret(value)) return;
      if (isSuppressedSecretValue(value, { key: m[1], file: currentFile })) return;
    }
    const snippet = rule.snippet(m);
    const key = `${rule.id}|${currentFile}|${snippet}`;
    if (seen.has(key)) return;
    seen.add(key);
    const hard = rule.id !== 'S3.history-secret-literal' || hasKnownRealPrefix(m[2] || '');
    findings.push({
      checkId: 'S3',
      severity: 'high',
      force: 'card',
      file: currentFile,
      line: lineNo,
      rule: rule.id,
      hard,
      snippet,
      message: `git 历史提交 ${commitHash.slice(0, 8) || '(未知)'} 中出现疑似${rule.label}（值已抹除）——请轮换该密钥并清理历史`,
      source: 'program',
    });
  };

  const flush = () => {
    if (inHunk && hunk.length) {
      const texts = hunk.map((h) => h.text);
      for (let i = 0; i < hunk.length; i++) {
        for (const rule of HISTORY_RULES) emit(rule, hunk[i].text, hunk[i].lineNo, texts, i);
      }
    }
    hunk = [];
  };

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith('commit ')) {
      flush();
      commitHash = line.slice(7).trim();
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      flush();
      inHunk = false;
      continue;
    }
    if (line.startsWith('+++ ')) {
      flush();
      inHunk = false;
      currentFile = parseGitPath(line.slice(4));
      continue;
    }
    if (line.startsWith('--- ')) continue;

    const hunkHead = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkHead) {
      flush();
      oldLine = Number(hunkHead[1]) || 0;
      newLine = Number(hunkHead[2]) || 0;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith('+')) {
      hunk.push({ text: line.slice(1), lineNo: newLine });
      newLine++;
      continue;
    }
    if (line.startsWith('-')) {
      hunk.push({ text: line.slice(1), lineNo: oldLine });
      oldLine++;
      continue;
    }
    if (line.startsWith(' ')) {
      hunk.push({ text: line.slice(1), lineNo: newLine });
      oldLine++;
      newLine++;
      continue;
    }
    flush();
    inHunk = false;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line === '') continue; // 补丁分隔
  }
  flush();
}

export async function checkSecretsHistory(projectDir, { tier, excludes = [] } = {}) {
  void tier; // S3 历史命中固定 high/card（与 S3 现状一致）
  const findings = [];
  const warnings = [];
  const gitDir = path.join(projectDir, '.git');
  if (!existsSync(gitDir)) {
    return { checkId: 'S3', findings, coverageGap: 'S3：无 git 历史，历史密钥未查', warnings };
  }

  // 浅克隆（--depth 1）里 git log -p 的“历史”就是 HEAD 本身，会把当前夹具重复当历史报。
  // 用 rev-parse 判定，而不是 commit 数：普通单 commit 仓不是浅克隆，必须继续扫描。
  const shallow = await runProcess('git', ['-C', projectDir, 'rev-parse', '--is-shallow-repository'], { timeoutMs: 10000 });
  if (shallow.status === 0 && String(shallow.stdout || '').trim() === 'true') {
    warnings.push('浅克隆：历史规则未运行（需完整 clone）');
    return { checkId: 'S3', findings, coverageGap: null, warnings };
  }

  const run = await runProcess(
    'git',
    ['-C', projectDir, 'log', '-p', '--all', '-n', '200', '--no-color'],
    { timeoutMs: 60000, maxOut: MAX_OUT },
  );
  if (run.error) {
    warnings.push(`S3：git log 无法运行（${run.error.code || run.error.message || 'error'}）`);
    return { checkId: 'S3', findings, coverageGap: 'S3：git log 无法运行，历史密钥未查', warnings };
  }
  if (run.status === 124) {
    warnings.push('S3：git log 超过 60 秒被终止');
    return { checkId: 'S3', findings, coverageGap: 'S3：git log 超时（60s），历史密钥未查', warnings };
  }
  if (run.status !== 0) {
    const detail = String(run.stderr || '').trim().split('\n')[0].slice(0, 160);
    warnings.push(`S3：git log 失败（退出码 ${run.status}）${detail ? `：${detail}` : ''}`);
    return { checkId: 'S3', findings, coverageGap: 'S3：git log 执行失败，历史密钥未查', warnings };
  }

  if (run.stdout.length >= MAX_OUT) warnings.push('S3：git 历史输出达到 64MB 上限，结果可能截断');
  scanPatch(run.stdout, excludes, findings);
  return { checkId: 'S3', findings, coverageGap: null, warnings };
}
