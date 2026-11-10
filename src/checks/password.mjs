import { listTextFiles, readRel } from '../walk.mjs';

// S8 密码与会话（ACCEPTANCE §4-A）。
// 1. 黑名单哈希只在“含 password/密码 上下文”的文件里判（避免把无关校验和当口令哈希）
// 2. 会话 cookie：res.cookie 调用行缺 httpOnly 即命中；缺 secure/sameSite 并入同一条
//    message 提示。检查窗口 = 调用行 + 后续 2 行（降低多行 options 写法的误报）
// 3. 明文口令比较：password 与 req.body/query/params 或 user.password 直接 ==/===
// 文档(.md/.txt)命中降为提醒级线索；行内 `finalcheck:allow` 豁免。

const RE_PW_CONTEXT = /\bpassword\b|\bpasswd\b|\bpwd\b|密码/i;
const RE_CREATEHASH = /createHash\s*\(\s*['"](md5|sha1)['"]\s*\)/i;
const RE_WEAK_CALL = /\b(?:md5|sha1)\s*\(/i;
const RE_COOKIE_CALL = /\b(?:res|response)\s*\.\s*cookie\s*\(/i;
const RE_PLAIN_CMP = /\b(?:password|passwd|pwd)\b\s*['"]?\s*(?:===?|!==?)\s*['"]?\s*(?:req\s*\.\s*(?:body|query|params)\b|(?:user|account|row|doc)\w*\s*\.\s*\w*(?:password|passwd|pwd))|\breq\s*\.\s*(?:body|query|params)\s*\.\s*\w*(?:password|passwd|pwd)\w*\s*(?:===?|!==?)/i;

// 报告永不回显口令本体（与 secrets.mjs 同一脱敏链）
function sanitize(raw) {
  return raw
    .replace(/(['"])[^'"]{6,}\1/g, '$1***$1')
    .replace(/(=\s*)[^\s'"]{8,}/g, '$1***')
    .replace(/[A-Z0-9]{16,}/g, '***');
}

export async function checkPassword(projectDir, { tier, excludes = [] } = {}) {
  const findings = [];
  const warnings = [];
  const t = String(tier || 'L2').toUpperCase();
  const force = t === 'L3' ? 'card' : 'check'; // 矩阵：L2 查 / L3 卡（L1 不调用）
  const { files, skipped } = await listTextFiles(projectDir, excludes);
  if (skipped.length) warnings.push(`跳过大文件 ${skipped.length} 个（>512KB 未扫描）：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '…' : ''}`);
  for (const f of files) {
    const { file, text } = await readRel(projectDir, f);
    if (/\.env($|\.)/i.test(file)) continue; // 口令就该住在这里，不判代码模式
    if (/package-lock|yarn\.lock|pnpm-lock/.test(file)) continue;
    const isDoc = /\.(md|txt)$/i.test(file);
    const lines = text.split('\n');
    const minified = lines.filter((l) => l.length > 1000).length;
    if (minified) warnings.push(`疑似压缩/第三方代码跳过 ${minified} 行：${file}`);
    const pwContext = RE_PW_CONTEXT.test(text);
    const push = (rule, msg, i) => findings.push({
      checkId: 'S8',
      severity: isDoc ? 'medium' : 'high',
      force: isDoc ? 'tip' : force,
      file,
      line: i + 1,
      rule,
      snippet: sanitize(lines[i].trim().slice(0, 120)),
      message: isDoc ? `${msg}（出现在文档中，可能是示例）` : msg,
      source: 'program',
    });
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 1000) continue;
      if (line.includes('finalcheck:allow')) continue;
      if (pwContext && (RE_CREATEHASH.test(line) || RE_WEAK_CALL.test(line))) {
        push('S8.weak-hash', '使用黑名单哈希算法（MD5/SHA1）处理口令——改用 bcrypt/argon2 加盐哈希', i);
      }
      if (RE_COOKIE_CALL.test(line)) {
        const windowText = lines.slice(i, i + 3).join('\n');
        if (!/httpOnly/i.test(windowText)) {
          const miss = [];
          if (!/secure/i.test(windowText)) miss.push('缺 secure');
          if (!/sameSite/i.test(windowText)) miss.push('缺 sameSite');
          push('S8.cookie-no-httponly', `会话 cookie 未设置 httpOnly${miss.length ? `（${miss.join('、')}）` : ''}——会话 cookie 应含 httpOnly/secure/sameSite`, i);
        }
      }
      if (RE_PLAIN_CMP.test(line)) {
        push('S8.plaintext-compare', '疑似明文口令比较/存储——先以 bcrypt/argon2 哈希再比对', i);
      }
    }
  }
  return { checkId: 'S8', findings, coverageGap: null, warnings };
}
