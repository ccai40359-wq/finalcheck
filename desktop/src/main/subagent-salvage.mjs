// 子代理中断/空回复的确定性 salvage：不调模型、不烧 token，只从已有 transcript 拼出一份可审阅的进度正文。
// 纯函数模块：agent-service（runSubagentTurn）、index（callSubagent catch）、
// workflow.mjs（DAG 节点）与 workflow-script.mjs（脚本节点）共用同一套文案与解析，避免四处漂移。
//
// 设计约束：
//  - 只用 transcript / toolCount 等已落盘数据，不发起任何网络请求；
//  - 输出以固定标题开头，调用方据此把节点判为失败但保留 content；
//  - 工具结果只取第一行、最多 200 字，防止把 16KB 的 JSON 整段复制进报告上下文；
//  - 失败节点的 salvage 正文会作为「洞」进入 report prompt 与 ## Not covered 校验。
import { errorCodeLabel } from './swarm.mjs';

export const SALVAGE_ABORTED_HEADER = '【未完成·已中断】';
export const SALVAGE_EMPTY_HEADER = '【未完成·无最终结论】';

const RESULT_LINE_MAX = 200;
const REASONING_MAX = 200;
const PARTIAL_MAX = 600;
const HOLE_SUMMARY_MAX = 600;

function textOf(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** 取多行文本的第一条非空行，并截到约 200 字（先截断再补省略号）。 */
function firstLine(value, max = RESULT_LINE_MAX) {
  const raw = textOf(value).replace(/\r\n/g, '\n').trim();
  if (!raw) return '';
  const line = raw.split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 单个工具结果的可读摘要：首行 + 200 字上限；pending/无输出给明确占位。 */
function toolResultSummary(entry) {
  if (entry?.cancelled) return '（已中断，未拿到结果）';
  if (entry?.pending) return '（中断时仍在运行，无结果）';
  const summary = firstLine(entry?.content);
  return summary || '（无结果输出）';
}

/** 统计真实工具调用：优先 reported toolCount，transcript 行数只作兜底/下限。 */
function countToolCalls(transcript, reported = 0) {
  const list = Array.isArray(transcript) ? transcript : [];
  let transcriptCount = 0;
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool') transcriptCount += 1;
    else if (m.role === 'assistant' && Array.isArray(m.toolCalls)) transcriptCount += m.toolCalls.length;
  }
  return Math.max(0, Math.trunc(Number(reported) || 0), transcriptCount);
}

/** 最后一模型推理（若有）截前 200 字；只取 assistant 的 reasoning 字段。 */
function lastReasoning(transcript) {
  const list = Array.isArray(transcript) ? transcript : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m?.role !== 'assistant') continue;
    const reasoning = String(m.reasoning || '').replace(/\r\n/g, '\n').trim();
    if (reasoning) return reasoning.slice(0, REASONING_MAX);
  }
  return '';
}

/** 中断前最后一段 assistant 正文（只作为已产出进度展示，仍不足以当最终结论）。 */
function lastPartial(transcript, explicit = '') {
  const given = String(explicit || '').replace(/\r\n/g, '\n').trim();
  if (given) return given.slice(0, PARTIAL_MAX);
  const list = Array.isArray(transcript) ? transcript : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m?.role !== 'assistant') continue;
    const content = String(m.content || '').replace(/\r\n/g, '\n').trim();
    if (content) return content.slice(0, PARTIAL_MAX);
  }
  return '';
}

/**
 * 从 transcript 生成确定性 salvage 正文。
 * @param {object} [input]
 * @param {object[]} [input.transcript] 子代理 transcript（system/user/assistant/tool）
 * @param {number} [input.toolCount] 上游已统计的工具调用数
 * @param {'aborted'|'empty'} [input.reason] 中断或空回复
 * @param {string} [input.partialContent] 中断前已拿到的部分正文
 * @param {string} [input.error] 失败原因（可选，写入正文便于审核）
 * @returns {string} 可直接作为节点 content 的 Markdown 文本
 */
export function salvageSubagentContent({
  transcript = [],
  toolCount = 0,
  reason = 'empty',
  partialContent = '',
  error = '',
} = {}) {
  const aborted = reason === 'aborted';
  const header = aborted ? SALVAGE_ABORTED_HEADER : SALVAGE_EMPTY_HEADER;
  const reasonText = aborted
    ? '运行被中断（用户停止或父级中止），未走到最终交付'
    : '模型结束但没有返回最终结论（空回复/收尾为空）';
  const count = countToolCalls(transcript, toolCount);
  const tools = (Array.isArray(transcript) ? transcript : []).filter((m) => m?.role === 'tool');
  const partial = lastPartial(transcript, partialContent);
  const reasoning = lastReasoning(transcript);

  const lines = [
    header,
    `原因：${reasonText}。`,
    `已调用工具：${count} 次。`,
  ];
  if (error) lines.push(`失败原因：${firstLine(error, 300)}`);
  if (tools.length) {
    lines.push('最后 5 次工具（名称 → 结果首行，最多 200 字）：');
    for (const t of tools.slice(-5)) {
      lines.push(`- ${String(t.name || 'tool').trim() || 'tool'} → ${toolResultSummary(t)}`);
    }
  } else {
    lines.push('最后 5 次工具：无（中断前尚未产生工具调用）。');
  }
  if (reasoning) lines.push(`最后一段模型推理（前 200 字）：${reasoning}`);
  if (partial) {
    lines.push(`中断前已有正文（前 600 字，未完成、不能当最终结论）：`);
    lines.push(partial);
  }
  lines.push('交付状态：未完成。缺少最终结论/证据总表；本步按「洞」处理，下游报告必须在 ## Not covered 点名本步并说明未覆盖范围。');
  return lines.join('\n');
}

/**
 * 把结果行（数组或 Map）里的失败节点整理成 holes。
 * 只收 ok === false 的节点；成功节点即使带 warning 也不是洞。
 * @param {Array|Map} results
 * @returns {Array<{id,name,error,errorCode,label,salvaged,salvageReason,summary}>}
 */
export function collectHoles(results = []) {
  const list = results instanceof Map ? [...results.values()] : (Array.isArray(results) ? results : []);
  return list
    .filter((r) => r && r.ok === false)
    .map((r) => {
      const id = String(r.id ?? '').trim();
      const name = String(r.name ?? '').trim();
      const errorCode = String(r.errorCode || '').trim() || null;
      const content = String(r.content || '').trim();
      const summary = content
        ? content.split('\n').slice(0, 6).join(' ').slice(0, HOLE_SUMMARY_MAX)
        : '';
      return {
        id,
        name: name || id,
        error: String(r.error || '').trim(),
        errorCode,
        label: errorCode ? errorCodeLabel(errorCode) : '',
        salvaged: !!r.salvaged,
        salvageReason: r.salvageReason || null,
        summary,
      };
    })
    .filter((h) => h.id || h.name);
}

/**
 * 生成 report 节点要用的「未完成/洞清单」。
 * 没有失败节点时返回空串（报告 prompt 不额外膨胀）；有洞时必须逐条点名。
 * @param {ReturnType<typeof collectHoles>} [holes]
 * @returns {string}
 */
export function buildHolesPromptSection(holes = []) {
  const list = Array.isArray(holes) ? holes.filter(Boolean) : [];
  if (!list.length) return '';
  const lines = [
    `未完成/洞清单（本轮有 ${list.length} 个节点失败或被中断；报告必须在 ## Not covered 逐条点名下列节点，写清各自缺少的范围/证据，不得省略、不得只写 None）：`,
  ];
  for (const h of list) {
    const code = h.errorCode ? `（${h.errorCode} · ${h.label || errorCodeLabel(h.errorCode)}）` : '';
    const reason = h.error || '没有可交付结论';
    lines.push(`- [${h.id || h.name}] ${h.name || h.id}${code}：${firstLine(reason, 300)}`);
    if (h.summary) lines.push(`  进度摘要：${firstLine(h.summary, HOLE_SUMMARY_MAX)}`);
  }
  lines.push(`点名要求：## Not covered 段必须出现以上 ${list.length} 个节点的 id 或 name（缺一个即 lint 失败）。`);
  return lines.join('\n');
}

/** 文本是否已经是 salvage 正文（避免 workflow 层重复包装）。 */
export function isSalvageText(content) {
  const head = String(content || '').trimStart();
  return head.startsWith(SALVAGE_ABORTED_HEADER) || head.startsWith(SALVAGE_EMPTY_HEADER);
}
