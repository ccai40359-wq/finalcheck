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

export async function rememberProject(projectPath, fact, { section = '记忆' } = {}) {
  const text = String(fact || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('要记住的内容为空');
  if (!projectPath) throw new Error('当前没有项目，无法写入项目记忆');
  const file = fileOf(projectPath);
  let raw = '';
  try { raw = await readFile(file, 'utf8'); } catch { /* 首条记忆：新建 AGENTS.md */ }
  if (raw.includes(text.slice(0, 80))) return { file, added: false, reason: 'AGENTS.md 里已有相同内容，未重复写入' };
  const line = `- ${new Date().toISOString().slice(0, 10)} ${text.slice(0, 600)}`;
  const next = insertUnderSection(raw, section, line);
  await writeFile(file, next, 'utf8');
  return { file, added: true, line };
}
