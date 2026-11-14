// 回合上下文快照（④，pi 显式会话口径）：每个回合把「当时的配置事实」追加落盘成 JSONL——
// roleMode / 模型 / 工具清单 / 技能目录 / 时间。复盘「当时为什么这么判」时有账可查；
// JSONL 追加写（不重写整文件），损坏一行不影响其余。
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_LINES = 200; // 每会话保留最近 200 个回合快照

export function turnContextDir(projectDir) {
  return path.join(String(projectDir || ''), '.finalcheck', 'turn-context');
}

/**
 * 追加一条回合上下文快照。
 * @param {string} projectDir 项目根
 * @param {string} sessionId 会话 id（文件按会话分）
 * @param {object} entry { at, roleMode, provider, model, tools, skillsBuiltin, skillsExtra, agentsMd }
 * @returns {Promise<{ok: true, file: string}>}
 */
export async function appendTurnContext(projectDir, sessionId, entry) {
  const dir = turnContextDir(projectDir);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${String(sessionId || 'draft').replace(/[^\w.-]/g, '_')}.jsonl`);
  await appendFile(file, JSON.stringify({ at: Date.now(), ...(entry || {}) }) + '\n', 'utf8');
  // 追加后裁剪：超过 MAX_LINES 只留最后 MAX_LINES 行（读-重写，低频可接受）
  try {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      await writeFileSafe(file, lines.slice(-MAX_LINES).join('\n') + '\n');
    }
  } catch { /* 裁剪失败不影响本次快照 */ }
  return { ok: true, file };
}

async function writeFileSafe(file, content) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, content, 'utf8');
}

/** 读取某会话的回合上下文（旧→新）。文件损坏行跳过。 */
export async function readTurnContext(projectDir, sessionId) {
  const file = path.join(turnContextDir(projectDir), `${String(sessionId || 'draft').replace(/[^\w.-]/g, '_')}.jsonl`);
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 损坏行跳过 */ }
  }
  return out;
}
