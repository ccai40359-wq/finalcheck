// 项目记忆：以项目根的 AGENTS.md 为唯一载体（对齐 ZCode/Claude Code 的约定）
// - 读：每轮对话开始时整篇注入 system 上下文（截断保护），模型据此遵守项目约定
// - 写：用户明确说「记住…」时由 remember_project 追加到「## 记忆」小节（去重、带日期）
// 文件属于用户的项目（可提交、可 review、可手改），FinalCheck 不另建黑盒记忆库
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MEMORY_FILE = 'AGENTS.md';
const MAX_CHARS = 8000;

const fileOf = (projectPath) => path.join(projectPath, MEMORY_FILE);

// 读项目记忆；没有/为空 → null
export async function readProjectMemory(projectPath) {
  if (!projectPath) return null;
  try {
    const raw = await readFile(fileOf(projectPath), 'utf8');
    const text = raw.trim();
    if (!text) return null;
    const truncated = text.length > MAX_CHARS;
    return {
      file: fileOf(projectPath),
      text: truncated ? text.slice(0, MAX_CHARS) + `\n…[AGENTS.md 已截断，原文 ${text.length} 字符；需要时用 read_file 读全文]` : text,
      chars: text.length,
      truncated
    };
  } catch {
    return null; // 不存在 = 没有项目记忆，不报错
  }
}

// 把一条事实插到「## 记忆」小节末尾；没有该小节就在文件末尾新建
function insertUnderSection(raw, section, line) {
  const lines = raw.split('\n');
  const head = new RegExp(`^##\\s*${section}\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (head.test(lines[i].trim())) start = i;
  if (start === -1) {
    const body = raw.replace(/\s+$/, '');
    return (body ? body + '\n\n' : '') + `## ${section}\n\n${line}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) { end = i; break; } // 下一个同级/更高级标题
  }
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === '') at--; // 插到本节最后一条非空之后
  return [...lines.slice(0, at), line, ...lines.slice(at)].join('\n');
}

// AGENTS.md 是项目「宪法」：下次任何人/任何 agent 打开项目都该成立的事实，不是任务日志。
// 2026-11-18 用户实测：模型把一次 PPT 任务的产物清单（13 页、6 个质检脚本名…）整段写成一条记忆，
// PPT 一改这条就变成错误信息。所以：按类别分节 + 写入前校验 + 支持就地更新旧条目。
export const MEMORY_KINDS = {
  overview: '项目概况',   // 用途、技术栈、部署形态
  commands: '常用命令',   // 怎么启动 / 构建 / 测试 / 重新生成产物
  layout: '目录约定',     // 什么东西放哪（源码 vs 产物、生成目录不要手改）
  rules: '规范与禁忌',    // 代码风格、不许做的事、用户的长期偏好
  acceptance: '验收口径', // 默认档位、必须过的闸、交付标准
};

/**
 * 写入前校验：返回不合格原因（数组为空 = 合格）。只拦「下次读到会误导人」的写法。
 * @param {string} text
 */
export function lintMemoryFact(text) {
  const why = [];
  if (text.length > 220) why.push(`太长（${text.length} 字）：一条只写一个事实（≤220 字），清单类内容拆成「目录约定 + 常用命令」两三条`);
  if (/第\s*\d+\s*行|\bline\s+\d+\b|\.[a-z]{1,5}:\d+\b/i.test(text)) why.push('含行号：行号会漂，下次会把模型带到错误位置——写函数名/配置键名');
  if (/已修好|已修复|已完成|修好了|搞定|刚刚|刚才|这次|本次|本轮|今天|正在|下一步|待办|TODO|进行中/i.test(text)) why.push('是进度/一次性信息：下次读到会以为还没做或已经做完——只记长期成立的事实');
  if (/\d+\s*(?:页|个文件|个脚本|条|处|张|个用例|个测试|行代码)/.test(text)) why.push('含会变的数量（如「13 页」「6 个脚本」）：内容一改就过时——写「在哪、怎么生成」，不写数量');
  const paths = text.match(/[\w.-]+\/[\w./*-]+|[\w-]+\.(?:py|js|ts|mjs|html|css|pptx|pdf|png|json|md|sh)\b/g) || [];
  if (paths.length > 4) why.push(`像产物清单（列了 ${paths.length} 个文件）：只写目录和入口命令（如「源文件在 deck/src/，用 build_deck.py 重建」），具体文件名会变`);
  return why;
}

/**
 * 记一条项目事实（或就地更新旧事实）。
 * @param {string} projectPath
 * @param {string} fact
 * @param {{kind?: keyof MEMORY_KINDS, replace?: string, force?: boolean}} [opts]
 *   kind：分节（默认 rules）；replace：要被替换的旧条目里的一段原文（找不到就报错，不会静默追加）
 */
export async function rememberProject(projectPath, fact, { kind = 'rules', replace = '', section = null } = {}) {
  const text = String(fact || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('要记住的内容为空');
  if (!projectPath) throw new Error('当前没有项目，无法写入项目记忆');
  const problems = lintMemoryFact(text);
  if (problems.length) {
    return { added: false, rejected: true, error: `没写入 AGENTS.md：${problems.join('；')}。改写后再调用 remember_project。` };
  }
  const heading = section || MEMORY_KINDS[kind] || MEMORY_KINDS.rules;
  const file = fileOf(projectPath);
  let raw = '';
  try { raw = await readFile(file, 'utf8'); } catch { /* 首条记忆：新建 AGENTS.md */ }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const line = `- ${text} <!-- ${new Date().toISOString().slice(0, 10)} -->`;
  const old = String(replace || '').trim();
  if (old) {
    const lines = raw.split(/\r?\n/);
    const idx = lines.findIndex((l) => /^\s*-\s/.test(l) && l.includes(old));
    if (idx < 0) return { added: false, error: `没找到要替换的旧条目（「${old.slice(0, 40)}」）：先 read_file 看 AGENTS.md 原文，复制旧条目里的一段文字再传 replace` };
    const before = lines[idx];
    lines[idx] = line;
    await writeFile(file, lines.join(eol), 'utf8');
    return { file, added: false, replaced: true, before: before.trim(), line };
  }
  if (raw.includes(text.slice(0, 80))) return { file, added: false, reason: 'AGENTS.md 里已有相同内容，未重复写入' };
  const next = insertUnderSection(raw.replace(/\r\n/g, '\n'), heading, line);
  await writeFile(file, eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next, 'utf8');
  return { file, added: true, section: heading, line };
}
