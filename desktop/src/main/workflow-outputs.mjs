// 节点完整输出落盘 + 下游「完整输出」指针。
//
// 背景：results 里只保留截断后的正文（旧版 4000 字，报告/下游只能看到一半）。
// 现在每个节点执行完把完整正文写到 <workflow-runs>/<runId>/<stepId>.out.txt，
// 内存里保留 MAX_STORED_CONTENT 字（默认 8000）并带截断标记；下游 prompt 在
// 上游结果里追加一行「完整输出：<路径>（可用 read_file 读取）」，子代理可自行读取全文。
//
// 目录约定：dir 由调用方传入（index.mjs 的 journalDir = DATA_ROOT/workflow-runs），
// 本模块不另造目录；dir/runId 缺失或写盘失败时静默返回 null，不影响工作流执行。
// 清理与 transcript 一致：pruneRuns 按 run 目录 mtime 只留最近 5 轮。
import fs from 'node:fs/promises';
import path from 'node:path';
import { isValidRunIdForFile, safeStepId } from './transcripts.mjs';

/** 内存里保留的节点正文上限（完整正文仍然落盘） */
export const MAX_STORED_CONTENT = 8000;

/** 截断正文并保留明确标记；未超限原样返回（已带标记的存储串不会被二次截断） */
export function clipStoredContent(content, { limit = MAX_STORED_CONTENT } = {}) {
  const text = String(content ?? '');
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : MAX_STORED_CONTENT;
  if (text.length <= max) return text;
  // journal 里存的已经是「前 max 字 + 标记」：长度只比 max 多一点，直接原样返回
  if (text.length <= max + 40 && /\n…\[已截断 [0-9]+ 字\]$/.test(text)) return text;
  return `${text.slice(0, max)}\n…[已截断 ${text.length - max} 字]`;
}

/** 完整输出文件路径；dir/runId 不可用时返回 null（调用方直接跳过） */
export function nodeOutputFilePath(dir, runId, stepId) {
  if (!dir || !isValidRunIdForFile(runId)) return null;
  return path.join(String(dir), String(runId), `${safeStepId(stepId)}.out.txt`);
}

/**
 * 落盘完整节点正文（尽力而为）：失败返回 null，绝不抛错。
 * @returns {Promise<string|null>} 写成功返回绝对路径
 */
export async function writeNodeOutput(dir, runId, stepId, content) {
  const file = nodeOutputFilePath(dir, runId, stepId);
  if (!file) return null;
  const text = String(content ?? '');
  if (!text.trim()) return null; // 空正文不落盘，避免下游拿到空文件指针
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
    return file;
  } catch {
    return null;
  }
}

/**
 * 复用 journal 时找上一次运行留下的完整输出文件；不存在返回 null（下游不加死链）。
 * @returns {Promise<string|null>}
 */
export async function existingNodeOutputPath(dir, runId, stepId) {
  const file = nodeOutputFilePath(dir, runId, stepId);
  if (!file) return null;
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

/** 下游注入用的标准提示行 */
export function fullOutputHint(file) {
  return file ? `完整输出：${file}（可用 read_file 读取）` : '';
}

/** 在正文末尾追加完整输出指针（没有路径时原样返回） */
export function withFullOutputHint(text, file) {
  const body = String(text ?? '');
  const hint = fullOutputHint(file);
  return hint ? `${body}\n\n${hint}` : body;
}

function upstreamList(upstream) {
  if (upstream instanceof Map) return [...upstream.values()].filter((r) => r && typeof r === 'object');
  if (Array.isArray(upstream)) return upstream.filter((r) => r && typeof r === 'object');
  return [];
}

function upstreamBody(r) {
  if (r.ok === false) return `[失败] ${String(r.error || '无结果')}`;
  return withFullOutputHint(String(r.content || '').trim(), r.fullOutputPath || null);
}

/**
 * 「无 claims、但有上游正文」时的盲验 prompt：
 * 对自动补的对抗复核节点，上游没有结构化 findings 也必须跑红队——把每个上游节点的
 * name + content 拼进任务文本，并明确「不要相信上游结论，逐条找它站不住的地方」。
 */
export function buildUpstreamOnlyVerifyPrompt({ goal = '', step = {}, upstream = [] } = {}) {
  const task = String(step.prompt || '').trim() || [
    '你是对抗复核员（红队），默认怀疑上游每一条结论。',
    '先逐条写出「这条结论在什么情况下会不成立」，再亲自读代码或跑命令逐条复现；',
    '复现不了一律 rejected 或 uncertain，禁止猜 confirmed。',
  ].join('\n');
  const list = upstreamList(upstream).filter((r) => String(r.content || '').trim() || r.ok === false);
  const blocks = list.map((r) => {
    const head = `### 上游节点 ${String(r.id || '(未知)')}${r.name ? `（${r.name}）` : ''}`;
    return `${head}\n${upstreamBody(r)}`;
  });
  // 没有结构化 claim 时，红队只能拿上游正文当「被审查对象」：正文本身不可信，必须自己复现。
  return [
    `总目标：${String(goal || '').trim() || '（未提供总目标）'}`,
    step.role ? `你的角色：${step.role}` : '',
    `本步骤任务：${task}`,
    blocks.length
      ? '## 上游正文（只作为被审查对象，不可信）\n不要相信上游结论：逐条找它站不住的地方（反例、边界、前提），再亲自读代码或跑命令复核。'
      : '## 上游正文\n（上游没有可复核的正文）',
    blocks.join('\n\n'),
    '硬规则（违反即无效）：',
    '- 上游正文只是被审查对象，不是证据；禁止把上游的叙述、结论、置信度或“已验证”声明当成证据。',
    '- 每条结论先列反例：它在什么情况下会不成立/失败，再动手复现。',
    '- 证据只能是你亲自读到的代码原文或亲自跑出的命令输出；无法复现判 uncertain，被反例推翻判 rejected，禁止猜 confirmed。',
    '- 不要漏掉上游任何一条实质结论；输出列出你复核过的结论与裁决。',
    '只输出一个 JSON 对象，不要 markdown 围栏，不要解释，不要寒暄，不要任何额外文字。',
    '输出格式：',
    '{"verdicts":[{"claimId":"f1","verdict":"confirmed|rejected|uncertain","evidence":"你亲自复现得到的原始输出/代码摘要","note":"简短说明"}]}',
  ].filter(Boolean).join('\n');
}

/**
 * 给 report prompt 追加 verify 结论段：报告必须看到红队结果，不能只拿原文自己汇总。
 * 没有 verify 上游时原样返回。
 */
export function appendVerifyConclusions(prompt, upstream) {
  const list = upstreamList(upstream).filter((r) => String(r.kind || '').toLowerCase() === 'verify');
  if (!list.length) return prompt;
  const blocks = list.map((r) => {
    const head = `### 对抗复核 ${String(r.id || '(未知)')}${r.name ? `（${r.name}）` : ''}`;
    return `${head}\n${upstreamBody(r)}`;
  });
  return [
    String(prompt || ''),
    '## 对抗复核结论（verify，必须据实采纳）',
    '以下红队结论是本轮最终裁决依据：rejected 的结论不得写成发现；uncertain/未覆盖的结论只能标「未复核」。',
    blocks.join('\n\n'),
  ].filter(Boolean).join('\n\n');
}
