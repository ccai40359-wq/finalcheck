// 程序账本（2026-11-17 规格 §3.5、§4 步 8）。
//
// **为什么用程序记账不靠 LLM**：
// 规格 §3.5 明确「只有 3 个工具需要记账，都是单一收口点」——edit_file/write_file/
// run_command 的数据本来就在 `part.data_json` 里（args 有 path、result 有
// stdout/stderr/code）。程序在工具执行完后追加一行：**零 LLM 调用、零 token 成本、
// 零幻觉**。LLM 摘要会漂（可能把「第 35 行」写成「第 40 行」），账本不会。
//
// 账本按「轮」分组，写在 `<项目>/.finalcheck/ledger.md`：
//   ## 第 1 轮  "说一下 你能检验什么语言的项目"
//   - 📄 读了 53 个文件（src/ 41 个 + fc-clean/verify 12 个）
//   - ✎ src/scope-policy.mjs:35  NON_JS_EXTS 补 .rs/.kt/.cs
//   - ✗ cmd#5  FIND: 参数格式不正确（已绕过，改用 bash find）
//   - 结论：语言能力来自源码常量表，与当前目录文件无关
//
// 跨项目时（规格 §4.2）：写进**被改文件所属项目**的账本，并在当前项目账本留一行交叉引用。
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export const LEDGER_REL = path.join('.finalcheck', 'ledger.md');

/** 账本行类型（图标与规格 §3.5 一致） */
export const LEDGER_ICONS = {
  read: '📄',
  edit: '✎',
  error: '✗',
  conclusion: '▸',
  crossRef: '↗'
};

export const nowStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 一条账本记录 → 一行文本。
 * 行号必须来自实际工具结果（这里只做格式化，不猜）。
 * @param {{kind:'read'|'edit'|'error'|'conclusion'|'crossRef', text:string}} entry
 */
export function formatLedgerLine(entry) {
  const icon = LEDGER_ICONS[entry?.kind] || '·';
  const text = String(entry?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return `- ${icon} ${text}`;
}

/**
 * 把一轮的记录渲染成 markdown 段。
 * @param {{round:number, at:string, title?:string, lines:Array}} round
 */
export function renderRoundBlock(round) {
  const head = `## 第 ${round.round} 轮  ${round.at}${round.title ? '  "' + String(round.title).slice(0, 60) + '"' : ''}`;
  const body = (Array.isArray(round.lines) ? round.lines : [])
    .map((l) => (typeof l === 'string' ? l : formatLedgerLine(l)))
    .filter(Boolean);
  return [head, ...body].join('\n');
}

/**
 * 追加一轮到项目账本（幂等：按「标题+首末行」指纹判重，避免回合重试重复写）。
 * round 号由本函数自己数（已有几轮 + 1），调用方不必维护计数器。
 * @param {{projectRoot:string, round:{at?:string,title?:string,lines:Array}}} opts
 * @returns {Promise<{ok:boolean, file:string, skipped?:boolean, round?:number}>}
 */
export async function appendRoundToLedger({ projectRoot, round }) {
  if (!projectRoot) return { ok: false, file: '' };
  const file = path.join(projectRoot, LEDGER_REL);
  const lines = Array.isArray(round?.lines) ? round.lines : [];
  const body = lines.map((l) => (typeof l === 'string' ? l : formatLedgerLine(l))).filter(Boolean);
  if (!body.length) return { ok: true, file, skipped: true };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    let existing = '';
    try { existing = await readFile(file, 'utf8'); } catch { /* 首次 */ }
    // 幂等指纹：标题 + 首行 + 末行（同一轮重试时这三样一致）
    const fingerprint = `"${String(round?.title || '').slice(0, 60)}"|${body[0]}|${body[body.length - 1]}`;
    if (existing.includes(fingerprint)) return { ok: true, file, skipped: true };
    const roundNo = (existing.match(/^## 第 \d+ 轮/gm) || []).length + 1;
    const block = `## 第 ${roundNo} 轮  ${round?.at || nowStamp()}${round?.title ? '  "' + String(round.title).slice(0, 60) + '"' : ''}\n${body.join('\n')}`;
    const prefix = existing
      ? (existing.endsWith('\n\n') ? existing : existing.replace(/\n*$/, '\n\n'))
      : '# 任务账本\n\n';
    await writeFile(file, prefix + block + '\n', 'utf8');
    return { ok: true, file, round: roundNo };
  } catch (e) {
    return { ok: false, file, error: String(e?.message || e) };
  }
}

/**
 * 跨项目交叉引用：在当前项目账本里写一行「我动了别的项目，账本在那边」。
 * 规格 §4.2：改 B 的文件 → 账本写 B；同时在 A 的账本留一行 ↗ 交叉引用。
 */
export async function appendCrossReference({ currentRoot, targetRoot, ledgerPath }) {
  if (!currentRoot) return { ok: false };
  const file = path.join(currentRoot, LEDGER_REL);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    let existing = '';
    try { existing = await readFile(file, 'utf8'); } catch { /* 首次 */ }
    const line = formatLedgerLine({
      kind: 'crossRef',
      text: `跨项目：操作了 ${targetRoot}，本任务账本见 ${ledgerPath}`
    });
    if (existing.includes(targetRoot)) return { ok: true, skipped: true };
    const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : (existing ? existing : '# 任务账本\n\n');
    await writeFile(file, prefix + line + '\n', 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * 生成「账本索引」注入上下文（规格 §3.2 载体②：只注入索引，全文用 read_file）。
 * 索引只带最近 N 轮的标题行，不塞全文——账本可能很长。
 * @param {string} projectRoot
 * @param {{maxRounds?:number}} [opts]
 */
export async function readLedgerIndex(projectRoot, { maxRounds = 8 } = {}) {
  if (!projectRoot) return null;
  const file = path.join(projectRoot, LEDGER_REL);
  try {
    const text = await readFile(file, 'utf8');
    if (!text.trim()) return null;
    const heads = text.split('\n').filter((l) => l.startsWith('## 第 '));
    const kept = heads.slice(-maxRounds);
    return {
      file,
      rounds: heads.length,
      index: kept.join('\n'),
      note: heads.length > kept.length
        ? `（只列最近 ${kept.length} 轮，共 ${heads.length} 轮；全文用 read_file 读 ${file}）`
        : ''
    };
  } catch { return null; }
}

/**
 * 从工具调用构造一条账本记录（规格 §3.5 的 3 个收口点）。
 * 只做确定性映射，不推断、不总结。
 * @param {{tool:string, args:object, result:object, ms?:number}} call
 * @returns {object|null}
 */
export function ledgerEntryOf(call) {
  const tool = String(call?.tool || '');
  const args = call?.args && typeof call.args === 'object' ? call.args : {};
  const result = call?.result && typeof call.result === 'object' ? call.result : {};

  if (tool === 'read_file' || tool === 'grep_code') {
    const target = String(args.path || args.pattern || '').slice(0, 120);
    if (!target) return null;
    if (tool === 'read_file') {
      const lines = Number(result.totalLines);
      const chars = Number(result.totalChars);
      const size = lines > 0 ? `${lines} 行` : (chars > 0 ? `${chars} 字符` : '');
      return { kind: 'read', text: `read ${target}${size ? '（' + size + '）' : ''}` };
    }
    const hits = Array.isArray(result.results) ? result.results.length : (Number(result.total) || 0);
    return { kind: 'read', text: `grep "${target}"（命中 ${hits} 处）` };
  }

  if (tool === 'edit_file' || tool === 'write_file') {
    const target = String(args.path || '');
    if (!target) return null;
    // 行号来自 edit 的实际结果（若有），否则不写行号——绝不估算
    const line = Number(result.line || result.lineNo || 0);
    const where = line > 0 ? `${target}:${line}` : target;
    const what = tool === 'write_file' ? '新建/覆盖' : '改';
    return { kind: 'edit', text: `${where} ${what}` };
  }

  if (tool === 'run_command') {
    const code = Number(result.code);
    const cmd = String(args.command || '').split(/\s+/).slice(0, 2).join(' ');
    if (Number.isFinite(code) && code !== 0) {
      const stderr = String(result.stderr || '').split('\n')[0].slice(0, 160);
      return { kind: 'error', text: `${cmd} 退出码 ${code}${stderr ? '：' + stderr : ''}` };
    }
    return null; // 成功的命令不记账（噪声）
  }

  return null;
}
