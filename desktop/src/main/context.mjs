// 上下文预算压缩（对齐 deepseek-harness 设计①）：
// 模型可见历史在"发给模型的时刻"派生——压缩只改本次请求的视图，不改存储的历史（审计可回放）。
// replace 语义：被压缩区由一条 [历史摘要] 消息顶替，仅影响发给模型的内容。
import { t } from '../renderer/i18n/core.mjs';

const KEEP_RECENT = 4; // 最近 N 条永远原文保留
const TOOL_INLINE_LIMIT = 1500; // 保留区 tool 消息超过此长度才截
const TOOL_KEEP_CHARS = 1200; // 截后保留头部字符数

const charLen = (m) => String(m?.content ?? '').length;

// 抽取式摘要（LLM 总结不可用/失败时的兜底）：每轮 user 问题前 60 字 + 工具调用名列表
function extractiveSummary(zone) {
  const lines = [];
  for (const m of zone) {
    const text = String(m?.content ?? '');
    if (m?.role === 'user') {
      lines.push('- 用户：' + text.slice(0, 60));
    } else if (m?.role === 'assistant') {
      const names = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((tc) => tc?.function?.name).filter(Boolean);
      if (names.length) lines.push('- 助手调用工具：' + names.join(', '));
      else if (Array.isArray(m.trace) && m.trace.length) lines.push('- 助手调用工具：' + m.trace.map((t) => t?.tool).filter(Boolean).join(', '));
      else if (text) lines.push('- 助手：' + text.slice(0, 60));
    } else if (m?.role === 'tool') {
      // 工具结果不进摘要（调用名已在 assistant 行列出），跳过正文
    } else if (text) {
      lines.push(`- ${m?.role ?? 'unknown'}：` + text.slice(0, 60));
    }
  }
  return lines.join('\n') || '（较早对话无可用摘要）';
}

// 保留区 tool 消息超长截断（不改原对象，替换语义）
function truncateTool(m) {
  const text = String(m?.content ?? '');
  if (m?.role !== 'tool' || text.length <= TOOL_INLINE_LIMIT) return m;
  return { ...m, content: text.slice(0, TOOL_KEEP_CHARS) + `…[截断 ${text.length - TOOL_KEEP_CHARS} 字符]` };
}

// 是否超预算（与 assembleContext 同一口径）。调用方在真正开始压缩前用它决定要不要发
// 「压缩中」状态：assembleContext 里的 LLM 摘要可能要等几秒，不能等压缩完才提示。
export function needsCompaction(messages, { budgetTokens, budgetChars = 80000 } = {}) {
  const { total, limit } = measureContext(messages, { budgetTokens, budgetChars });
  return total > limit;
}

// 预算口径唯一实现：token 优先，没给 token 预算时沿用旧的字符口径
function measureContext(messages, { budgetTokens, budgetChars = 80000 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const tokenBudget = Number(budgetTokens);
  const useTokens = Number.isFinite(tokenBudget) && tokenBudget > 0;
  const limit = useTokens ? tokenBudget : budgetChars;
  const total = useTokens
    ? estimateMessagesTokens(list)
    : list.reduce((n, m) => n + charLen(m), 0);
  return { total, limit, useTokens };
}

export async function assembleContext(messages, { budgetTokens, budgetChars = 80000, summarize } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  // 传了正数 budgetTokens 就按 token 估（长上下文模型），否则沿用旧的 80k 字符口径
  const { total, limit, useTokens } = measureContext(list, { budgetTokens, budgetChars });
  if (total <= limit) return { messages: list, compacted: false };

  // 保留区预算 = 触发阈值的一部分（默认 37.5%）：压缩后明显低于阈值，
  // 避免「压缩后贴线 → 下一回合又触发 → 反复烧摘要调用」；不足部分由摘要条目承担。
  // KEEP_RECENT 保底不受比例影响：最新的几条永远原文保留。
  const keepLimit = Math.floor(limit * KEEP_BUDGET_RATIO);

  // 从尾部往回累积；最近 KEEP_RECENT 条无条件保留，更早的进"被压缩区"
  const costOf = useTokens ? (m) => estimateMessagesTokens([m]) : charLen;
  let keptChars = 0;
  let keepFrom = list.length;
  for (let i = list.length - 1; i >= 0; i--) {
    const c = costOf(list[i]);
    if (i < list.length - KEEP_RECENT && keptChars + c > keepLimit) break;
    keptChars += c;
    keepFrom = i;
  }
  const zone = list.slice(0, keepFrom);
  const kept = list.slice(keepFrom);

  let summaryText = null;
  if (zone.length) {
    const raw = zone.map((m) => `[${m?.role ?? 'unknown'}] ${String(m?.content ?? '')}`).join('\n');
    if (typeof summarize === 'function') {
      try { summaryText = await summarize(raw); } catch { /* 总结失败静默回退抽取式 */ }
    }
    if (typeof summaryText !== 'string' || !summaryText.trim()) summaryText = extractiveSummary(zone);
  }

  // ==== 硬规则一：最后一条 user 消息永不丢（规格 §3.3 第 3 步 / §4 步 9）====
  // 为什么必须单独兜：按 token 预算从尾部往前累积时，若用户最后那句很长、或中间插件了
  // 一大串 tool 结果，它可能落进 zone 被摘要吃掉 —— 那模型就不知道「用户现在到底要干什么」。
  // 规格 §2.3 的实测还证明：按条数保留（20/50/100 条）会把 user 消息**全部**挤掉（含 0 条）。
  const lastUser = [...list].reverse().find((m) => m?.role === 'user') || null;
  const lastUserInKept = lastUser ? kept.includes(lastUser) : true;

  // 若最后一条 user 已被压进 zone，用原文补回来（放在摘要之后的保留区开头）
  const keptWithUser = (!lastUserInKept && lastUser)
    ? [lastUser, ...kept.map(truncateTool)]
    : kept.map(truncateTool);

  let view = summaryText != null
    ? [{ role: 'user', content: '[历史摘要]\n' + summaryText }, ...keptWithUser]
    : keptWithUser; // 压缩区为空（如仅末尾几条就超预算）也要做保留区截断

  // ==== 硬规则二：当前任务包置底（规格 §3.3 第 3 步）====
  // 单独一条 system 放在**最后**，把「用户最后一句原话」再点一遍，
  // 防止它被 [历史摘要] 与工具结果淹没。只放最后一条（不是全部历史 user 消息）。
  if (lastUser) {
    view = [...view, {
      role: 'system',
      content: t('【当前任务】用户最后一条要求（原文，以此为准）：\n{text}', {
        text: String(lastUser.content ?? '').slice(0, 4000)
      })
    }];
  }
  return { messages: view, compacted: true };
}

// ---------------------------------------------------------------------------
// token 口径估算 + 两级压缩（Wave 2）
// 旧的 budgetChars / CONVO_BUDGET 是"字符"口径，混排中英文时严重低估上下文；
// 这里统一按 token 估算：CJK 字符 1 个≈1 token，其余 4 字符≈1 token。
// 这里只提供纯函数原语，何时触发由调用方（agent-service 的工具循环）决定。
// ---------------------------------------------------------------------------

// CJK 及全角标点/假名/谚文：1 字符≈1 token（按 tokenizer 常见切分近似）。
// 用 charCodeAt 逐字符判断而不是正则 match，避免大历史下分配百万级匹配数组。
const isCjkCode = (c) =>
  (c >= 0x2e80 && c <= 0x303f) || // CJK 部首/符号/全角标点
  (c >= 0x3040 && c <= 0x30ff) || // 平假名/片假名
  (c >= 0x3400 && c <= 0x4dbf) || // CJK 扩展 A
  (c >= 0x4e00 && c <= 0x9fff) || // CJK 基本区
  (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容
  (c >= 0xff00 && c <= 0xffef) || // 全角 ASCII / 半角片假名
  (c >= 0xac00 && c <= 0xd7af);   // 谚文

export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i++) if (isCjkCode(s.charCodeAt(i))) cjk++;
  const other = s.length - cjk;
  return cjk + Math.ceil(other / 4);
}

// content 可能是字符串、多段 parts（图片/文本）或空
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (typeof p?.text === 'string' ? p.text : JSON.stringify(p)))).join('\n');
  }
  return content == null ? '' : String(content);
}

// 单条消息的 token：正文 + tool_calls 的 JSON 长度（工具参数也会占上下文）
export function estimateMessagesTokens(list) {
  return (Array.isArray(list) ? list : []).reduce((n, m) => {
    const calls = Array.isArray(m?.tool_calls) ? JSON.stringify(m.tool_calls) : '';
    return n + estimateTokens(contentText(m?.content)) + estimateTokens(calls);
  }, 0);
}

// 预算公式（2026-11-17 重构，规格 §4 步 2：**双阈值合并为一个**）。
//
// 旧的 micro/full 双阈值（min(0.9*eff, eff-2000) 与 eff-13000）有两个问题：
//   ① 在 1M 窗口上是 881k / 966k —— 单轮要 850-930 次工具调用才够触发，
//      正常会话整轮才 70k，等于**死代码**（规格 D6）。
//   ② 小窗口下算成负数（contextWindow=1000 → -1001 / -12001），
//      负阈值 = 永远超预算 = 每次请求都清空上下文（实测 5 个请求每个只剩 2 条消息）。
//
// 新口径：只有一个阈值 `compactThreshold = effective`（= 窗口减输出预留）。
// 到这条线才压，且压的方式统一（工具结果压索引行 + 轮摘要滚动），不再分两档。
// 保留 effective 的 5% 下限（至少 256）：极小窗口下防止阈值塌到 0 导致每轮都压。
export function contextBudget(config = {}) {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const contextWindow = num(config?.contextWindow, 200000);
  const maxOutputTokens = num(config?.maxOutputTokens, 32000);
  const effective = Math.max(1, contextWindow - Math.min(maxOutputTokens, 21000));
  // 一个阈值：effective 本身就是阈值（已扣掉输出预留）。
  // 极小窗口（effective < 256 时）不额外抬高——那样反而会永远超预算；
  // 这里保持 effective 原值，由调用方用「至少留 256 余量」的策略配合。
  const compactThreshold = effective;

  return {
    contextWindow,
    maxOutputTokens,
    effective,
    compactThreshold,
    // 兼容字段：还有代码/测试在读旧名字。它们与 compactThreshold 同值，
    // 语义上「到这条线就压」，不再有 micro/full 两级。（步 2 完成后可删）
    microThreshold: compactThreshold,
    fullThreshold: compactThreshold
  };
}

const CLEANED_TOOL_PREFIX = '[旧工具结果已清理：';

// 保留区预算占触发阈值的比例：0.375 × 400k ≈ 150k（2026-11-14 用户拍板的精修）。
// 压缩后总占用 ≈ 保留区 + 摘要条目，明显低于触发阈值——不会「压缩完贴线、下一回合又触发」。
const KEEP_BUDGET_RATIO = 0.375;

// microcompact：最近 5 条 tool 结果保留原文，更早的正文换成固定占位说明。
// 只改 tool 消息的 content，保留 tool_call_id（不破坏 assistant tool_calls ↔ tool 配对）。
//
// 2026-11-17（规格 §4 步 3）：被清理的旧工具结果不再写成一个**零信息量**的占位符
// （旧文案 `[旧工具结果已清理：read_file；…]` 只告诉模型"这边被清了"，
//  却不说读过什么文件、结果多大 —— 规格缺陷 D7），
// 而是压成**索引行**：保留「工具名 + 目标 + 结果大小」，让模型仍然知道"我读过哪些东西"。
//   📄 read_file src/audit.mjs (~1520 tok)
//   ⌕ grep_code "NON_JS_EXTS"（命中 3 处）
//   ✗ run_command 退出码 1
// 目标从 assistant 的 tool_calls.arguments 里取（path / command / pattern / dir / target）。
// 同时保留旧前缀常量，避免已有测试/日志识别逻辑失效。
const INDEX_MARK = '[索引]';

const TOOL_ICON = {
  read_file: '📄',
  grep_code: '⌕',
  run_command: '▸',
  audit_project: '⚖',
  download_gate: '⛨',
  probe_target: '◇',
  stress_target: '≋',
  get_report: '▤',
  todo_write: '☑',
  ask_user: '❓',
  edit_file: '✎',
  write_file: '✎',
  list_playbooks: '▦',
  read_playbook: '▭',
  remember_project: '★',
  present_artifact: '▣',
  review_diff: '≠',
  quality_gate: '⚙'
};

/** 从工具参数里挑一个「模型看得懂的目标」：路径优先，其次命令，再次模式串。 */
function toolTargetOf(argsRaw, toolName) {
  if (argsRaw == null) return '';
  let a;
  try {
    a = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
  } catch { return ''; }
  if (!a || typeof a !== 'object') return '';
  // grep_code 的 pattern 比 path 有用（"搜了什么" > "在哪个目录搜"）；
  // 其余工具路径优先，其次命令/URL。
  const pick = toolName === 'grep_code'
    ? (a.pattern || a.path || '')
    : (a.path || a.dir || a.target || a.file || a.url || a.pattern || a.command || '');
  let t = String(pick || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // 路径太长时保留尾部（文件名比目录前缀有用）
  if (t.length > 60) t = '…' + t.slice(-58);
  // 命令里的敏感值不落索引：只留命令名（参数可能含 token/key）
  if (toolName === 'run_command') {
    return t.split(/\s+/)[0];
  }
  return t;
}

function estimateTok(text) {
  return Math.max(1, Math.round(String(text ?? '').length / 4));
}

export function microcompact(list, { keepRecentTool = 5 } = {}) {
  if (!Array.isArray(list)) return false;
  const toolIdx = [];
  list.forEach((m, i) => { if (m?.role === 'tool') toolIdx.push(i); });
  const keep = new Set(toolIdx.slice(-Math.max(0, keepRecentTool)));
  if (toolIdx.length <= keep.size) return false;
  // tool_call_id → { name, args }（索引行要点名工具和它的目标）
  const calls = new Map();
  for (const m of list) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.id) calls.set(tc.id, { name: tc?.function?.name || '工具', args: tc?.function?.arguments });
      }
    }
  }
  let changed = false;
  for (const i of toolIdx) {
    if (keep.has(i)) continue;
    const old = contentText(list[i]?.content);
    // 幂等：已经是索引行或旧占位符就跳过（旧占位符留着，不重复改写）
    if (old.startsWith(INDEX_MARK) || old.startsWith(CLEANED_TOOL_PREFIX)) continue;
    const call = calls.get(list[i]?.tool_call_id) || { name: '工具', args: null };
    const icon = TOOL_ICON[call.name] || '·';
    const target = toolTargetOf(call.args, call.name);
    const tok = estimateTok(old);
    const line = `${INDEX_MARK} ${icon} ${call.name}${target ? ' ' + target : ''} (~${tok} tok)`;
    list[i] = { ...list[i], content: line };
    changed = true;
  }
  return changed;
}

// 统计 microcompact 将会清理的条数（保留区之外、且还没被压成索引行的 tool 消息）。
// 与 microcompact 同一套判定口径，供调用方在折叠实际发生时发「已清理 N 条」通知。
export function countToolsToClean(list, { keepRecentTool = 5 } = {}) {
  if (!Array.isArray(list)) return 0;
  const toolIdx = [];
  list.forEach((m, i) => { if (m?.role === 'tool') toolIdx.push(i); });
  const keepCount = Math.min(toolIdx.length, Math.max(0, keepRecentTool));
  let n = 0;
  for (let k = 0; k < toolIdx.length - keepCount; k++) {
    const text = contentText(list[toolIdx[k]]?.content);
    if (!text.startsWith(INDEX_MARK) && !text.startsWith(CLEANED_TOOL_PREFIX)) n++;
  }
  return n;
}

// full compact 的本地抽取式摘要：用户问题前 60 字 + 助手调用的工具名列表 + 结论前 80 字。
// 纯本地，不额外调用模型（避免压缩本身又烧一次上下文）。
function summarizeZone(zone) {
  const lines = [];
  for (const m of zone) {
    if (m?.role === 'user') {
      const t = contentText(m.content).replace(/\s+/g, ' ').trim();
      if (t) lines.push('- 用户：' + t.slice(0, 60));
    } else if (m?.role === 'assistant') {
      const names = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((tc) => tc?.function?.name).filter(Boolean);
      if (names.length) lines.push('- 助手调用工具：' + names.join(', '));
      const t = contentText(m.content).replace(/\s+/g, ' ').trim();
      if (t) lines.push('- 结论：' + t.slice(0, 80));
    }
  }
  return lines.join('\n') || '（较早对话无可用摘要）';
}

// full compact：把最老的 user/assistant 正文区压成一条 [历史摘要]（tool 消息随区删除，配对不留孤儿）。
// 保留最近 6 条消息；若保留区第一条是 tool，则连同它的 assistant tool_calls 一起回退保留，
// 否则 API 会因孤立 tool 消息返回 400。
export function fullCompact(list) {
  if (!Array.isArray(list)) return false;
  const KEEP_RECENT_FULL = 6;
  if (list.length <= 1 + KEEP_RECENT_FULL) return false; // 除 system 外不足 6 条，没东西可压
  let keepFrom = list.length - KEEP_RECENT_FULL;
  while (keepFrom > 1 && list[keepFrom]?.role === 'tool') keepFrom--;
  if (keepFrom <= 1) return false;
  const zone = list.slice(1, keepFrom);
  if (!zone.length) return false;
  const summary = summarizeZone(zone);
  list.splice(1, keepFrom - 1, { role: 'user', content: '[历史摘要]\n' + summary });
  return true;
}
