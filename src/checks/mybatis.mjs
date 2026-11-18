// MyBatis `${}` SQL 注入（2026-11-18，真实模型 E2E 在 java-sec-code 上实测漏报后补）。
// `#{}` 走预编译占位符是安全的；`${}` 是字符串直接拼进 SQL——国内 Java 项目最常见的注入写法
// （模糊查询 like '%${x}%'、order by ${col}、in (${ids})）。
// 纯文本规则，不依赖 Semgrep：mapper XML 里的 SQL 语句块 + Java 注解 @Select/@Update/@Insert/@Delete。
import { listTextFiles, readRel } from '../walk.mjs';

const STMT_TAGS = /<(select|update|insert|delete|sql)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const ANNOT_RE = /@(Select|Update|Insert|Delete)\s*\(\s*(\{[\s\S]*?\}|"(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*)\s*\)/g;
const DOLLAR_RE = /\$\{\s*([\w.]+)\s*\}/g;

function lineAt(text, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function hint(sql, name) {
  const s = sql.toLowerCase();
  if (/order\s+by[^;]*\$\{/.test(s)) return `排序字段 ${name} 用 \${} 拼接：改为在代码里按白名单映射列名（order by 不能用 #{}）`;
  if (/like[^;]*\$\{/.test(s)) return `模糊查询用 \${${name}} 拼接：改为 like concat('%', #{${name}}, '%')`;
  if (/\bin\s*\([^)]*\$\{/.test(s)) return `IN 列表用 \${${name}} 拼接：改为 <foreach> + #{}`;
  return `参数 ${name} 用 \${} 直接拼进 SQL：改为 #{${name}} 预编译占位符`;
}

export async function checkMybatis(projectDir, { excludes = [], includeFixtures = false } = {}) {
  const findings = [];
  const { files } = await listTextFiles(projectDir, excludes, { includeFixtures, extraExts: ['.xml'] });
  let scanned = 0;
  for (const f of files) {
    const isXml = /\.xml$/i.test(f);
    const isJava = /\.(java|kt)$/i.test(f);
    if (!isXml && !isJava) continue;
    const { file, text: raw } = await readRel(projectDir, f);
    if (isXml && !/<mapper\b/i.test(raw)) continue;
    if (isJava && !/@(Select|Update|Insert|Delete)\s*\(/.test(raw)) continue;
    scanned++;
    // XML 注释里的 ${} 不是 SQL（用等长空白替换，行号不变）
    const text = isXml ? raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')) : raw;
    const lines = raw.split(/\r?\n/);
    const blocks = [];
    if (isXml) for (const m of text.matchAll(STMT_TAGS)) blocks.push({ body: m[2], start: m.index + m[0].indexOf(m[2]) });
    else for (const m of text.matchAll(ANNOT_RE)) blocks.push({ body: m[2], start: m.index + m[0].indexOf(m[2]) });
    for (const b of blocks) {
      for (const d of b.body.matchAll(DOLLAR_RE)) {
        const line = lineAt(text, b.start + d.index);
        const code = lines[line - 1] || '';
        if (/finalcheck:allow/.test(code)) continue;
        findings.push({
          checkId: 'S2', severity: 'high', force: 'card', file, line,
          rule: 'S2.mybatis-dollar',
          snippet: code.trim().slice(0, 120),
          message: `MyBatis \${} 拼接 SQL（注入）——${hint(b.body, d[1])}`,
          source: 'program',
        });
      }
    }
  }
  return { findings, scannedFiles: scanned };
}
