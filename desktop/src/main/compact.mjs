// 上下文压缩的统一核心（0.27，对齐 Claude Code 的 compact）。
//
// 三层（用户定案）：
//   ① 能不摘要就不摘要：平时全量保留、只往后追加（0.25 起），只有逼近窗口才走到这里；
//   ② 真要摘要时一次性写：压缩时让模型对「整段原始过程」写一份交接摘要；
//      不做中间摘要、不分块再合并（旧实现按 3 万字切块 → 块摘要 → 合并，是「摘要的摘要」，交接指令也被当正文切掉了）；
//      压缩一旦发生就**落库成边界**，之后每一轮都是「同一份摘要 + 之后的原文」只追加——
//      旧实现每一轮都从完整历史重新派生、重新摘要：超线之后每轮多一次摘要请求、前缀缓存每轮全断。
//   ③ 确定性事实兜底（摘要再准也是复述）：
//      用户原话逐字保留；最近读过 / 改过的文件压缩时从磁盘重读；git status 重新读仓库；验收单 / 待办原样带上；
//      被压缩的完整过程写成文件，模型需要细节时用 read_file 去读（对应 Claude Code 的 transcript 路径）。
//
// 三个入口共用这里：回合内逼近窗口（agent-service compactNow）、回合开始时历史已超预算（agent-service）、
// 手动 /compact（ipc-workspace）。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { estimateTokens } from './context.mjs';

/** 摘要请求的最后一条 user 消息以它开头（测试台的假网关据此把它归为「摘要」请求）。 */
export const COMPACT_MARK = '[压缩上下文]';
/** 边界消息开头。沿用旧前缀：isRealUserText 等处据此把它排除在「用户原话」之外。 */
export const BOUNDARY_HEAD = '[历史摘要]';
export const USER_BLOCK_HEAD = '【用户原话（原样保留）】';
export const SUMMARY_HEAD = '【交接摘要】';
export const RESTORE_HEAD = '【压缩时的现场（从磁盘 / 仓库重新读取，不是回忆）】';
export const TRANSCRIPT_HEAD = '【完整过程记录】';

const USER_TEXT_MAX_CHARS = 30000;
const RESTORE_MAX_FILES = 5;
const RESTORE_FILE_CHARS = 20000; // 约 5k token / 文件（Claude Code 同口径）
const RESTORE_TOTAL_CHARS = 60000;
const RESTORE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 4000;
const GIT_MAX_LINES = 40;
const FILE_TOOLS = new Set(['read_file', 'edit_file', 'write_file']);

export function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : (p?.type === 'image_url' || p?.type === 'image') ? '[图片]' : '')).join(' ');
  return String(content);
}

/** 用户亲口说的话（排除 [系统] 提醒、边界消息、旧的会话摘要）。 */
export function isRealUserText(m) {
  if (m?.role !== 'user') return false;
  const t = textOf(m.content).trim();
  return !!t && !t.startsWith('[系统]') && !t.startsWith(BOUNDARY_HEAD) && !t.startsWith('[此前对话摘要]') && !t.startsWith(COMPACT_MARK);
}

/** 压缩时原样保留的 system 消息（旧格式的会话摘要除外：它要进压缩区，被新边界取代）。 */
export const isPinnedSystem = (m) => m?.role === 'system' && !textOf(m.content).startsWith('[此前对话摘要]');

export const isBoundaryMessage = (m) => m?.role === 'user' && textOf(m.content).startsWith(BOUNDARY_HEAD);

/**
 * 交给模型的压缩指令（对齐 Claude Code 的 9 段交接摘要；「所有用户消息」一段由程序原样附上，不让模型抄写）。
 * @param {{inTurn?:boolean}} [o]
 */
export function compactInstruction({ inTurn = false } = {}) {
  return [
    `${COMPACT_MARK} 上下文快满了。请为上面的全部对话写一份交接摘要：之后较早的过程会被这份摘要替换${inTurn ? '，你会带着它（和最近几步原文）接着把当前任务做完' : ''}。`,
    '用户说过的原话、压缩时的文件内容、git 状态、待办会由程序原样附在摘要旁边，你不用抄写它们；你要写的是「只有读过整个过程才知道的东西」。',
    '这一次只输出文字，不要调用任何工具。',
    '',
    '先在 <analysis> 里按时间顺序过一遍全过程（每条用户要求、你的做法、关键决定、改过的文件和代码、遇到的错误和怎么修的、用户的纠正），确认没有遗漏；',
    '然后在 <summary> 里按下面的小节输出（每节用「## 」开头，只写事实，不要客套）：',
    '## 1. 主要请求与意图：用户要的是什么，逐条列出，并标注每条现在的状态（已完成 / 进行中 / 未开始）',
    '## 2. 关键事实与数据：已经查明的具体事实——数值、配置项、版本号、关键代码行、命令输出里的关键行、你已经告诉用户的结论。必须写出具体值（例如「b.js 第 1 行注释：超时 45 秒」），禁止只写「已读取」「已获得」「成功提取」这类不含内容的描述——压缩后原文就没了，这里没写的值等于丢了',
    '## 3. 关键技术概念：涉及的技术、框架、约定',
    '## 4. 文件与代码：看过、改过、新建的文件（完整路径），每个文件为什么重要、里面有什么、改了什么；关键改动附上代码片段',
    '## 5. 错误与修复：遇到的每个错误和修法；用户纠正过你的地方要特别写明，避免再犯',
    '## 6. 问题解决：已经解决的问题、还在排查的问题和目前的线索',
    '## 7. 待办：用户明确要求但还没做的事',
    '## 8. 当前工作：压缩前最后正在做什么，精确到文件名和代码',
    '## 9. 下一步：紧接着要做的一个具体动作。必须直接服务于用户最近的明确要求；引用最近对话的原句说明做到了哪里。没有明确的下一步就写「无」，不要自己发明新任务',
    '',
    '<analysis> 只用来帮你想清楚，程序会丢掉它；<summary> 才会被保留。'
  ].join('\n');
}

/** 去掉 <analysis>，取 <summary> 内容；模型没按格式写就原样用。 */
export function formatSummary(raw) {
  let s = String(raw ?? '');
  s = s.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
  const m = s.match(/<summary>([\s\S]*?)(<\/summary>|$)/i);
  if (m) s = m[1];
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function argsObj(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { const a = JSON.parse(String(raw)); return a && typeof a === 'object' ? a : {}; } catch { return {}; }
}

/** 完整过程记录（写进文件，不截断单条——这是兜底的原始材料）。 */
export function fullTranscriptOf(zone) {
  const calls = new Map();
  for (const m of zone) for (const tc of (Array.isArray(m?.tool_calls) ? m.tool_calls : [])) if (tc?.id) calls.set(tc.id, tc?.function?.name || '工具');
  const out = [];
  for (const m of zone) {
    if (m?.role === 'user') out.push(`### ${isRealUserText(m) ? '用户' : '系统提示'}\n${textOf(m.content)}`);
    else if (m?.role === 'assistant') {
      const say = textOf(m.content).trim();
      if (say) out.push(`### 助手\n${say}`);
      for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) out.push(`### 调用 ${tc?.function?.name || '工具'}\n${String(tc?.function?.arguments ?? '')}`);
    } else if (m?.role === 'tool') out.push(`### 结果 ${calls.get(m.tool_call_id) || ''}\n${textOf(m.content)}`);
    else if (m?.role === 'system') out.push(`### 系统\n${textOf(m.content)}`);
  }
  return out.join('\n\n');
}

/**
 * 给模型写摘要用的转写（请求本身放不下整段时才用）：按 token 上限保头保尾，中间注明省略、指向完整记录文件。
 */
export function boundedTranscript(zone, maxTokens, transcriptFile = '') {
  const text = fullTranscriptOf(zone);
  const total = estimateTokens(text);
  if (total <= maxTokens) return text;
  const ratio = maxTokens / total;
  const keep = Math.floor(text.length * ratio);
  const head = Math.floor(keep * 0.25);
  const tail = keep - head;
  return `${text.slice(0, head)}\n\n…（中间约 ${total - maxTokens} token 放不进这次请求，已省略${transcriptFile ? `；完整内容在 ${transcriptFile}` : ''}）…\n\n${text.slice(-tail)}`;
}

/** 区段里用户的原话（含上一份边界里带着的原话），按时间顺序。 */
export function collectUserTexts(zone) {
  const out = [];
  for (const m of zone) {
    if (isRealUserText(m)) { out.push(textOf(m.content).trim()); continue; }
    if (!isBoundaryMessage(m)) continue;
    const t = textOf(m.content);
    const start = t.indexOf(USER_BLOCK_HEAD);
    if (start < 0) continue;
    const end = t.indexOf(SUMMARY_HEAD, start);
    const carried = t.slice(start + USER_BLOCK_HEAD.length, end >= 0 ? end : undefined).trim();
    if (carried) out.push(carried);
  }
  return out;
}

/** 之前几次压缩留下的完整记录文件（新边界接着列出来，最早的需求也查得到原文）。 */
export function collectTranscriptFiles(zone) {
  const out = [];
  for (const m of zone) {
    if (!isBoundaryMessage(m)) continue;
    const t = textOf(m.content);
    const i = t.indexOf(TRANSCRIPT_HEAD);
    if (i < 0) continue;
    for (const f of t.slice(i).match(/\S+compact-[\w.-]+\.md/g) || []) if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** 区段里最近碰过的文件（read/edit/write），新的在前；保留区里已经有原文的不重复带。 */
export function recentFilePaths(zone, kept = []) {
  const inKept = new Set();
  for (const m of kept) for (const tc of (Array.isArray(m?.tool_calls) ? m.tool_calls : [])) {
    if (tc?.function?.name === 'read_file') { const p = argsObj(tc.function.arguments).path; if (p) inKept.add(path.resolve(String(p))); }
  }
  const seen = new Set();
  const out = [];
  for (let i = zone.length - 1; i >= 0; i--) {
    const m = zone[i];
    const calls = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
    for (let k = calls.length - 1; k >= 0; k--) {
      const tc = calls[k];
      if (!FILE_TOOLS.has(tc?.function?.name)) continue;
      const p = argsObj(tc.function.arguments).path;
      if (!p) continue;
      const abs = path.resolve(String(p));
      if (seen.has(abs) || inKept.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

const insideDir = (dir, p) => {
  if (!dir) return false;
  const rel = path.relative(path.resolve(dir), p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

async function readFileForRestore(abs) {
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile() || st.size > RESTORE_FILE_MAX_BYTES) return null;
    const buf = await fsp.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return null; // 二进制不带
    return buf.toString('utf8');
  } catch { return null; }
}

function gitStatus(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'status', '--short', '--branch'], { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve('');
      const lines = String(stdout || '').trimEnd().split(/\r?\n/);
      resolve(lines.length > GIT_MAX_LINES ? [...lines.slice(0, GIT_MAX_LINES), `…（另有 ${lines.length - GIT_MAX_LINES} 行）`].join('\n') : lines.join('\n'));
    });
  });
}

function renderTodos(todos) {
  const list = Array.isArray(todos) ? todos : [];
  return list.map((it) => {
    if (typeof it === 'string') return `- ${it}`;
    const title = it?.content ?? it?.text ?? it?.title ?? it?.name ?? '';
    return `- [${it?.status || 'pending'}] ${title}`;
  }).filter((l) => l.trim() !== '-').join('\n');
}

/**
 * 确定性现场：最近碰过的文件（磁盘上的当前内容）、git status、验收单 / 待办。
 * 只读项目目录里的文件（不把项目外、被策略单独放行过的文件内容自动带进上下文）。
 */
export async function restoreSnapshot({ projectPath = '', zone = [], kept = [], todos = null, totalChars = RESTORE_TOTAL_CHARS } = {}) {
  const parts = [];
  const files = [];
  if (projectPath) {
    let used = 0;
    for (const abs of recentFilePaths(zone, kept)) {
      if (files.length >= RESTORE_MAX_FILES || used >= totalChars) break;
      if (!insideDir(projectPath, abs)) continue;
      const text = await readFileForRestore(abs);
      if (text == null) continue;
      const room = Math.min(RESTORE_FILE_CHARS, totalChars - used);
      const lines = text.split('\n').length;
      const body = text.length > room ? `${text.slice(0, room)}\n…（文件共 ${lines} 行 / ${text.length} 字符，这里只带了开头；其余用 read_file 按 offset 读）` : text;
      used += body.length;
      files.push(abs);
      parts.push(`### 文件 ${abs.replaceAll('\\', '/')}（共 ${lines} 行，压缩时的磁盘内容）\n\`\`\`\n${body}\n\`\`\``);
    }
    try {
      await fsp.access(path.join(projectPath, '.git'));
      const st = await gitStatus(projectPath);
      if (st) parts.push(`### git status\n\`\`\`\n${st}\n\`\`\``);
    } catch { /* 不是 git 仓库 */ }
  }
  const td = renderTodos(todos);
  if (td) parts.push(`### 当前验收单 / 待办\n${td}`);
  return { text: parts.join('\n\n'), files };
}

function capUserTexts(texts) {
  const joined = texts.join('\n---\n');
  if (joined.length <= USER_TEXT_MAX_CHARS) return joined;
  const head = Math.floor(USER_TEXT_MAX_CHARS / 3);
  return `${joined.slice(0, head)}\n…（中间的原话太长，已省略 ${joined.length - USER_TEXT_MAX_CHARS} 字；完整原文在下面的过程记录文件里）…\n${joined.slice(-(USER_TEXT_MAX_CHARS - head))}`;
}

/** 拼出边界消息（role=user）。之后每一轮都原样发这一条，前缀缓存从它之后接着命中。 */
export function renderBoundary({ summary, userTexts = [], restore = '', transcriptFiles = [], inTurn = false }) {
  const userBlock = capUserTexts(userTexts.filter(Boolean));
  const files = transcriptFiles.filter(Boolean).map((f) => String(f).replaceAll('\\', '/'));
  return [
    `${BOUNDARY_HEAD} 这个会话从之前的对话继续：较早的过程已压缩成下面的交接摘要。用户原话是原文；「现场」部分是压缩时从磁盘 / 仓库重新读取的，比摘要可靠。已确认的结论不要重复验证。`,
    userBlock ? `\n${USER_BLOCK_HEAD}\n${userBlock}` : '',
    `\n${SUMMARY_HEAD}\n${summary}`,
    restore ? `\n${RESTORE_HEAD}\n${restore}` : '',
    files.length ? `\n${TRANSCRIPT_HEAD}\n需要更早的原始细节（完整命令输出、完整对话）时用 read_file 读（可配合 offset/limit 或 grep），不要凭摘要猜行号：\n${files.map((f) => `- ${f}`).join('\n')}` : '',
    inTurn ? '\n接着「当前工作 / 下一步」继续把任务做完，不要向用户重复确认已经确认过的事。' : ''
  ].filter(Boolean).join('\n');
}

/** 本地兜底摘要（模型摘要请求失败时）：用户原话已原样保留，这里列出做过的动作。 */
export function localSummary(zone) {
  const lines = [];
  for (const m of zone) {
    if (m?.role !== 'assistant') continue;
    const say = textOf(m.content).replace(/\s+/g, ' ').trim();
    if (say) lines.push('- 助手：' + say.slice(0, 200));
    for (const tc of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
      const a = argsObj(tc?.function?.arguments);
      const target = String(a.path || a.command || a.pattern || a.target || '').replace(/\s+/g, ' ').slice(0, 120);
      lines.push(`- 调用 ${tc?.function?.name || '工具'}${target ? ' ' + target : ''}`);
    }
  }
  return `（模型摘要失败，这是本地整理的动作清单；细节请读完整过程记录）\n${lines.slice(-200).join('\n') || '（无）'}`;
}

async function writeTranscript(zone, dir) {
  if (!dir) return '';
  try {
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
    await fsp.writeFile(file, `# 压缩前的完整过程记录（${new Date().toISOString()}）\n\n${fullTranscriptOf(zone)}\n`, 'utf8');
    return file;
  } catch { return ''; }
}

/**
 * 一次压缩：写完整记录 → 模型写摘要（优先复用对话前缀，失败退到转写，再失败本地兜底）→ 重读现场 → 拼边界。
 * @param {object} o
 * @param {Array} o.zone 被压缩的消息（不含 system 提示词）
 * @param {Array} [o.kept] 原样保留的消息（用来避免重复带文件）
 * @param {(instruction:string) => Promise<string>} [o.summarizeConvo] 「对话前缀 + 指令」直接发给模型（前缀缓存命中）
 * @param {(prompt:string) => Promise<string>} [o.summarizeText] 「转写 + 指令」一条消息发出去
 * @param {number} [o.transcriptTokens] 转写模式下转写的 token 上限
 * @returns {Promise<{content:string, summary:string, via:'convo'|'transcript'|'local', error?:string, transcriptFile:string, restoredFiles:string[]}>}
 */
export async function compactZone({ zone, kept = [], summarizeConvo = null, summarizeText = null, projectPath = '', todos = null, spillDir = '', transcriptTokens = 60000, inTurn = false, restoreChars = RESTORE_TOTAL_CHARS }) {
  const transcriptFile = await writeTranscript(zone, spillDir);
  const instruction = compactInstruction({ inTurn });
  let summary = '';
  let via = /** @type {'convo'|'transcript'|'local'} */ ('local');
  const errors = [];
  if (typeof summarizeConvo === 'function') {
    try { summary = formatSummary(await summarizeConvo(instruction)); via = 'convo'; } catch (e) { errors.push(e?.message || String(e)); }
  }
  if (!summary && typeof summarizeText === 'function') {
    try {
      const prompt = `${instruction}\n\n--- 对话过程 ---\n${boundedTranscript(zone, transcriptTokens, transcriptFile)}`;
      summary = formatSummary(await summarizeText(prompt));
      via = 'transcript';
    } catch (e) { errors.push(e?.message || String(e)); }
  }
  if (!summary) { summary = localSummary(zone); via = 'local'; }
  const restore = await restoreSnapshot({ projectPath, zone, kept, todos, totalChars: restoreChars });
  const content = renderBoundary({
    summary,
    userTexts: collectUserTexts(zone),
    restore: restore.text,
    transcriptFiles: [...collectTranscriptFiles(zone), transcriptFile],
    inTurn
  });
  return { content, summary, via, ...(errors.length ? { error: errors.join('；') } : {}), transcriptFile, restoredFiles: restore.files };
}

/**
 * 回合开始时历史已超预算：按「整轮」切。最近几轮（合计不超过 keepTokens）原样保留，更早的进压缩区。
 * 压缩区里的 system 消息（项目记忆、工作区、Hook 上下文等）不压，放在边界之后——下一轮从库里重建时它们也在这个位置。
 * @returns {{pinned:Array, zone:Array, kept:Array, keptUserTurns:number}}
 */
export function splitByTurns(messages, { keepTokens, costOf }) {
  const list = Array.isArray(messages) ? messages : [];
  const starts = [];
  list.forEach((m, i) => { if (isRealUserText(m)) starts.push(i); });
  if (!starts.length) return { pinned: [], zone: [], kept: list, keptUserTurns: 0 };
  let keepFrom = starts[starts.length - 1]; // 本轮用户消息永远保留
  let used = list.slice(keepFrom).reduce((n, m) => n + costOf(m), 0);
  for (let k = starts.length - 2; k >= 0; k--) {
    const c = list.slice(starts[k], keepFrom).reduce((n, m) => n + costOf(m), 0);
    if (used + c > keepTokens) break;
    used += c;
    keepFrom = starts[k];
  }
  const region = list.slice(0, keepFrom);
  const kept = list.slice(keepFrom);
  return {
    pinned: region.filter(isPinnedSystem),
    zone: region.filter((m) => !isPinnedSystem(m)),
    kept,
    keptUserTurns: kept.filter(isRealUserText).length
  };
}

/**
 * 回合内压缩：本轮已经进了摘要的最后一个工具调用 id（落库用：下一轮从库里重建这一轮时，裁到它为止）。
 * 压缩区里没有本轮的工具步骤时返回 ''（本轮步骤全部原样保留，不用裁）。
 */
export function lastCoveredCallIdOf(turnZone) {
  let id = '';
  for (const m of Array.isArray(turnZone) ? turnZone : []) {
    for (const tc of (Array.isArray(m?.tool_calls) ? m.tool_calls : [])) if (tc?.id) id = String(tc.id);
  }
  return id;
}

const hasCall = (m, id) => m?.role === 'assistant' && Array.isArray(m.tool_calls)
  && m.tool_calls.some((tc) => String(tc?.id) === id || String(tc?.id).startsWith(id + '_'));

/**
 * 下一轮从库里重建历史后，按回合内边界裁掉「已经进了摘要」的那段工具过程：
 * 边界消息之后、直到含 throughCallId 的那一步（连同它的工具结果）为止的对话消息全部去掉（system 消息不动）。
 * 找不到对应步骤时原样返回（宁可重复，不丢）。
 */
export function trimAfterBoundary(messages, throughCallId) {
  const list = Array.isArray(messages) ? messages : [];
  if (!throughCallId) return { messages: list, trimmed: 0 };
  const b = list.findIndex(isBoundaryMessage);
  if (b < 0) return { messages: list, trimmed: 0 };
  let target = -1;
  for (let i = b + 1; i < list.length; i++) if (hasCall(list[i], throughCallId)) { target = i; break; }
  if (target < 0) return { messages: list, trimmed: 0 };
  let end = target + 1;
  while (end < list.length && list[end]?.role === 'tool') end++;
  const out = [];
  let trimmed = 0;
  list.forEach((m, i) => {
    if (i > b && i < end && m?.role !== 'system') { trimmed++; return; }
    out.push(m);
  });
  return { messages: out, trimmed };
}
