// 用户可见文案的人话化：工具错误 → 一句中文；工具入参 → 人类摘要 / 逐行展示；裸 JSON → 摘除。
// 纯函数，不依赖 DOM / React，可直接在 Node 里单测（tests/humanize.test.mjs）。
// 原则：任何返回值里都不出现 `{"`、`":`、`}]`、`\"` 这类 JSON 结构碎片；
// 工具参数默认逐行铺开（formatToolArgs），不再折叠成一句占位文案。
// 英文模式：只翻译固定文案（t() 在 zh 下原样返回，中文输出保持不变）。
import { t, getLanguage } from '../i18n/core.mjs';

/** 去掉 JSON 结构碎片（保留语义文字）：`{"` → `{`，`":` → 空格，`}]` → 空 */
const deFrag = (s) => String(s ?? '')
  .replace(/\{\s*"/g, '{')
  .replace(/"\s*:/g, ' ')
  .replace(/\}\s*\]/g, '');

/** 并列项分隔符：中文顿号 / 英文逗号（只影响展示拼接） */
const listSep = () => (getLanguage() === 'en' ? ', ' : '、');

const oneLine = (s, max = 120) => {
  const text = deFrag(String(s ?? ''))
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,，、.。-]+/, '')
    .replace(/[\s:;,，、.。-]+$/, '')
    .trim();
  if (max <= 0) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** 常见异常前缀（Error: / TypeError: / SyntaxError: ...）不留在用户文案里 */
const stripErrorPrefix = (s) => String(s ?? '')
  .replace(/^\s*(?:Uncaught\s+)?(?:\w+\.)*(?:Error|Exception)\s*:\s*/i, '')
  .replace(/^\s*(?:Error|Exception)\s+/i, '')
  .trim();

const splitFirstLine = (raw) => {
  const text = String(raw ?? '').replace(/\r/g, '');
  // 栈信息（含 "\n    at "）→ 只留第一行
  if (/\n\s+at\s/.test(text)) return text.split('\n')[0];
  return text;
};

/**
 * 工具/工作流错误 → 一句人话。
 * - JSON 解析错误 → 「脚本指令的 JSON 格式有误（第 N 字符附近缺逗号或括号）」
 * - HTTP 4xx/5xx → 「网关返回 4xx：<原始 message 截 60 字>」
 * - timeout / AbortError → 「执行超时（已中断）」
 * - ENOENT → 「文件不存在或已被移动」
 * - 其它 → 去换行/括号，压缩成一行 ≤120 字
 *
 * @param {unknown} raw 原始错误字符串（或 Error 对象）
 * @returns {string} 单行中文提示
 */
export function humanizeToolError(raw) {
  if (raw == null || raw === '') return t('执行失败（原因未记录）');
  let text = String(raw);

  // 有些工具把错误包在 JSON 里：先抽出 message/error 再走同样的映射
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const inner = parsed.message ?? parsed.error ?? parsed.reason;
      if (typeof inner === 'string' && inner.trim()) text = inner;
    }
  } catch { /* 不是 JSON，继续 */ }

  const line = stripErrorPrefix(splitFirstLine(text));

  // 1) JSON 语法错误：模型/脚本产出的指令 JSON 解析失败
  if (/(?:Expected|Unexpected).*(?:','|']'|'}'|token|JSON)|in JSON at position|JSON\.parse|Unterminated string in JSON|Unexpected end of JSON/i.test(line)) {
    const m = line.match(/(?:in JSON at position|at position|position)\s*(\d+)/i);
    return m
      ? t('脚本指令的 JSON 格式有误（第 {pos} 字符附近缺逗号或括号）', { pos: m[1] })
      : t('脚本指令的 JSON 格式有误（缺逗号或括号）');
  }

  // 2) HTTP 网关错误：保留状态码 + 原始 message 片段（截 60 字）
  // 不变量：输入里的 HTTP 状态码必须在输出里存活（「网关返回 429：…」），
  // 时间线/详情面板靠它向用户展示具体错误码；改这条正则时不得把码从返回值里抹掉。
  const httpMatch = line.match(/(?:HTTP(?:\/\d(?:\.\d)?)?\s*|[Ss]tatus(?:Code)?(?:\s*[Cc]ode)?\s*[=:]?\s*|\bstatus\s*)([45]\d\d)\b/i)
    || line.match(/\b([45]\d\d)\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Request Timeout|Conflict|Too Many Requests|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i);
  if (httpMatch) {
    const code = httpMatch[1];
    let detail = line.replace(httpMatch[0], '').replace(/^[\s:;,，、\-–—]+/, '').trim();
    if (!detail || /^HTTP(?:[\/\s]\S*)?$/i.test(detail)) detail = line;
    return t('网关返回 {code}：{detail}', { code, detail: oneLine(detail, 60) }).trim();
  }

  // 3) 超时 / 中断
  if (/\b(?:timeout|timed out|ETIMEDOUT|AbortError|aborted)\b|超时|已中断/i.test(line)) {
    return t('执行超时（已中断）');
  }

  // 4) 文件不存在
  if (/ENOENT|no such file or directory/i.test(line)) {
    return t('文件不存在或已被移动');
  }

  // 5) 其它：去掉换行/括号压缩成一行
  const clean = oneLine(line.replace(/[{}\[\]]/g, ' '), 120);
  return clean || t('执行失败（原因未记录）');
}

/** 转义还原一次：`\"` → `"`、`\\` → `\`、`\n` → 换行（只认 JSON 允许的转义，避免误伤普通文本） */
function unescapeOnce(text) {
  return String(text ?? '').replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (raw, esc) => {
    switch (esc[0]) {
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'u': {
        const code = Number.parseInt(esc.slice(1), 16);
        return Number.isFinite(code) ? String.fromCharCode(code) : raw;
      }
      default: return raw;
    }
  });
}

/** 宽容解析：对象 / JSON 字符串 / 双重转义字符串 / 二次编码字符串，最多剥三层 */
function parseArgsValue(args) {
  let cur = args;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (cur && typeof cur === 'object') return cur;
    if (typeof cur !== 'string') return null;
    const raw = cur.trim();
    if (!raw) return null;
    let next = null;
    try { next = JSON.parse(raw); } catch {
      try {
        const restored = unescapeOnce(raw).trim();
        next = restored ? JSON.parse(restored) : null;
      } catch { next = null; }
    }
    if (next == null) return null;
    cur = next;
  }
  return cur && typeof cur === 'object' ? cur : null;
}

/** 只接受普通对象（数组走纯文本兜底） */
function asObject(args) {
  const v = parseArgsValue(args);
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

// 展示用清洗：统一换行、抹掉残留的转义引号、去空字符；不压平换行（命令要保留多行）
const cleanValue = (v) => String(v ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/\\+"/g, '"')
  .replace(/\u0000/g, '')
  .replace(/[ \t]+\n/g, '\n')
  .trim();

/** 展示用文本：清洗 + 去 JSON 碎片 + 压成一行（max > 0 时） */
const displayText = (v, max = 0) => {
  const s = deFrag(cleanValue(v)).replace(/\n{3,}/g, '\n\n').trim();
  if (!s) return '';
  return max > 0 ? oneLine(s, max) : s;
};

/** 解析失败时的纯文本兜底（还原转义 + 去 JSON 碎片），绝不返回「参数已折叠」 */
function plainArgsText(args) {
  if (args == null) return '';
  let text;
  if (typeof args === 'string') text = args;
  else if (typeof args === 'object') {
    try { text = JSON.stringify(args); } catch { text = String(args); }
  } else text = String(args);
  return displayText(unescapeOnce(text), 0) || '';
}

const isScalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const scalarText = (v) => {
  if (typeof v === 'boolean') return v ? t('是') : t('否');
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return displayText(v, 200);
};

/** 通用兜底：每个标量一行 `key: value`；嵌套对象只取一层，数组只列标量，绝不铺 JSON */
function genericArgLines(obj, lines) {
  for (const [key, v] of Object.entries(obj)) {
    if (isScalar(v)) {
      const text = scalarText(v);
      if (text) lines.push({ label: key, value: text });
      continue;
    }
    if (Array.isArray(v)) {
      const scalars = v.filter(isScalar).map(scalarText).filter(Boolean);
      if (v.length && scalars.length === v.length) lines.push({ label: key, value: oneLine(scalars.join(listSep()), 240) });
      else if (v.length) lines.push({ label: key, value: t('{n} 项', { n: v.length }) });
      continue;
    }
    if (v && typeof v === 'object') {
      const inner = Object.entries(v).filter(([, x]) => isScalar(x));
      if (inner.length) {
        for (const [k2, v2] of inner) {
          const text = scalarText(v2);
          if (text) lines.push({ label: `${key}.${k2}`, value: text });
        }
      } else if (Object.keys(v).length) {
        lines.push({ label: key, value: t('{n} 个字段', { n: Object.keys(v).length }) });
      }
    }
  }
  return lines;
}

/**
 * 工具入参 → 逐行展示（详情面板直接铺开，不折叠）。
 * 返回 Array<{ label, value }>：label 是字段名（可空，空则该行只有 value），
 * value 保留换行（run_command 的完整命令不压成一行）。
 * @param {string} name 工具名
 * @param {unknown} args trace.args（对象 / JSON 字符串 / 双重转义字符串都兼容）
 * @returns {Array<{ label: string, value: string }>}
 */
export function formatToolArgs(name, args) {
  const parsed = parseArgsValue(args);
  if (parsed == null) {
    const text = plainArgsText(args);
    return text ? [{ label: t('原文'), value: text }] : [];
  }
  if (Array.isArray(parsed)) {
    const list = parsed.map((v, i) => (isScalar(v) ? `- ${scalarText(v)}` : t('- 第 {i} 项：{n} 个字段', { i: i + 1, n: Object.keys(v || {}).length })));
    return list.length ? [{ label: '', value: list.join('\n') }] : [];
  }

  const obj = parsed;
  if (!Object.keys(obj).length) return [];
  const lines = [];
  const push = (label, value) => {
    const text = typeof value === 'string' ? displayText(value) : scalarText(value);
    if (text) lines.push({ label, value: text });
  };

  switch (name) {
    case 'run_command': {
      const cmd = cleanValue(obj.command);
      if (cmd) lines.push({ label: 'command', value: cmd });
      push('cwd', obj.cwd ?? obj.workdir);
      const timeout = obj.timeoutMs ?? obj.timeout_ms ?? obj.timeout;
      if (Number.isFinite(Number(timeout)) && Number(timeout) > 0) push('timeout', `${Number(timeout)}ms`);
      break;
    }
    case 'read_file':
    case 'write_file':
    case 'edit_file': {
      push('path', obj.path ?? obj.file);
      for (const key of ['offset', 'limit']) {
        if (obj[key] !== undefined && Number.isFinite(Number(obj[key]))) push(key, String(Number(obj[key])));
      }
      break;
    }
    case 'probe_target': {
      push('url', obj.url ?? obj.target);
      const n = obj.requests ?? obj.count;
      if (Number.isFinite(Number(n)) && Number(n) > 0) push('requests', t('{n} 次', { n: Number(n) }));
      const timeout = obj.timeoutMs ?? obj.timeout;
      if (Number.isFinite(Number(timeout)) && Number(timeout) > 0) push('timeout', `${Number(timeout)}ms`);
      break;
    }
    case 'stress_target': {
      push('url', obj.url ?? obj.target);
      const duration = obj.duration ?? obj.seconds;
      if (Number.isFinite(Number(duration)) && Number(duration) > 0) push('duration', `${Number(duration)}s`);
      const connections = obj.connections;
      if (Number.isFinite(Number(connections)) && Number(connections) > 0) push('connections', `${Number(connections)}`);
      break;
    }
    case 'run_workflow': {
      push('goal', obj.goal ?? obj.name);
      const steps = Array.isArray(obj.steps) ? obj.steps : [];
      if (steps.length) {
        const list = steps.map((s, i) => {
          const step = s && typeof s === 'object' ? s : {};
          const title = displayText(step.name || step.title || step.id || t('步骤 {n}', { n: i + 1 }), 80);
          const deps = Array.isArray(step.depends_on) ? step.depends_on.map(String).filter(Boolean) : [];
          return `- ${title}${deps.length ? t('（依赖 {deps}）', { deps: deps.join(listSep()) }) : ''}`;
        });
        lines.push({ label: 'steps', value: list.join('\n') });
      }
      const script = Array.isArray(obj.script) ? obj.script : [];
      if (script.length) {
        const list = script.map((n, i) => {
          const node = n && typeof n === 'object' ? n : {};
          const op = displayText(node.op || 'step', 20);
          const title = displayText(node.name || node.id || t('节点 {n}', { n: i + 1 }), 80);
          return t('- {title}（{op}）', { title, op });
        });
        lines.push({ label: 'script', value: list.join('\n') });
      }
      break;
    }
    default:
      genericArgLines(obj, lines);
  }
  return lines;
}

const readStr = (obj, keys) => {
  for (const key of keys) {
    const v = obj?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
};

const withCounts = (base, obj) => {
  const added = obj?.added ?? obj?.additions ?? obj?.stats?.added;
  const removed = obj?.removed ?? obj?.deletions ?? obj?.stats?.removed;
  if (Number.isFinite(Number(added)) && Number.isFinite(Number(removed))) {
    return `${base} +${Number(added)}/-${Number(removed)}`;
  }
  return base;
};

const firstScalar = (obj) => {
  const preferred = ['command', 'path', 'dir', 'url', 'goal', 'query', 'pattern', 'fact', 'file', 'name', 'target', 'base', 'prompt', 'text'];
  for (const key of preferred) {
    const v = obj?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  for (const v of Object.values(obj || {})) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
};

/**
 * 工具入参 → 一行人类摘要（用于时间线工具行，不铺原始 JSON）。
 * read_file → 路径；edit/write → 路径（可算 +N/-M 时附带）；
 * run_command → 命令首行 ≤80 字；audit_project → 目录 + 档位；
 * quality_gate → 目录；probe_target → URL + 次数；stress_target → URL + 时长/连接；
 * review_diff → 目录 + base；其它 → 首个有意义的标量。
 * @returns {string} 不含 `{"`、`":`、`}]` 的单行摘要
 */
export function summarizeToolArgs(name, args) {
  const obj = asObject(args);
  if (!obj) {
    return oneLine(stripErrorPrefix(plainArgsText(args)), 160);
  }

  let out = '';
  if (!Object.keys(obj).length) return t('无参数');
  switch (name) {
    case 'read_file':
    case 'present_artifact':
      out = readStr(obj, ['path', 'file']);
      break;
    case 'edit_file':
    case 'write_file':
      out = withCounts(readStr(obj, ['path', 'file']), obj);
      break;
    case 'run_command': {
      const cmd = readStr(obj, ['command']);
      out = cmd ? oneLine(cmd.split(/\r?\n/)[0].trim(), 80) : '';
      break;
    }
    case 'audit_project': {
      const dir = readStr(obj, ['dir', 'path']);
      const tier = readStr(obj, ['tier', 'level']);
      out = dir ? t('{dir} · {tier}', { dir, tier: tier || t('默认档位') }) : (tier ? t('默认目录 · {tier}', { tier }) : '');
      break;
    }
    case 'quality_gate': {
      const dir = readStr(obj, ['dir', 'path']);
      const repeat = obj.repeat ?? obj.repeats;
      out = dir
        ? (Number(repeat) > 1 ? t('{dir} · 重复 {n} 次', { dir, n: Number(repeat) }) : dir)
        : '';
      break;
    }
    case 'probe_target': {
      const url = readStr(obj, ['url', 'target']);
      const n = obj.requests ?? obj.count;
      const count = Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 10;
      out = url ? t('{url} · {n} 次', { url, n: count }) : '';
      break;
    }
    case 'stress_target': {
      const url = readStr(obj, ['url', 'target']);
      const duration = obj.duration ?? obj.seconds;
      const connections = obj.connections;
      const parts = [url];
      if (Number.isFinite(Number(duration)) && Number(duration) > 0) parts.push(`${Number(duration)}s`);
      if (Number.isFinite(Number(connections)) && Number(connections) > 0) parts.push(t('{n} 连接', { n: Number(connections) }));
      out = parts.filter(Boolean).join(' · ');
      break;
    }
    case 'review_diff': {
      const dir = readStr(obj, ['dir', 'path']);
      const base = readStr(obj, ['base', 'ref']);
      out = dir ? t('{dir} · 对比 {base}', { dir, base: base || 'HEAD' }) : '';
      break;
    }
    case 'download_gate': {
      const dir = readStr(obj, ['dir', 'path']);
      out = dir ? t('{dir} · 下载闸', { dir }) : '';
      break;
    }
    case 'read_playbook': {
      out = readStr(obj, ['dir', 'name', 'id']);
      break;
    }
    case 'list_playbooks':
      out = readStr(obj, ['category', 'dir']);
      break;
    case 'remember_project':
      out = readStr(obj, ['fact', 'text', 'note']);
      break;
    case 'run_workflow':
      out = readStr(obj, ['goal', 'name']);
      break;
    case 'get_report':
      out = readStr(obj, ['dir', 'path', 'reportId', 'id']);
      break;
    default:
      out = firstScalar(obj);
  }

  out = oneLine(out, 160);
  if (out) return out;
  // 对象里有字段但没命中任何专用摘要：取逐行展示的第一行（label: value），绝不返回「参数已折叠」
  const first = formatToolArgs(name, obj)[0];
  if (first) {
    out = oneLine(first.label ? `${first.label}: ${first.value}` : first.value, 160);
  }
  return out || t('无参数');
}

/** 该位置是否落在 ``` 围栏里（围栏内的 JSON 是正常代码块，不算裸 JSON 倾倒） */
function insideFence(text, index) {
  return (text.slice(0, index).match(/```/g) || []).length % 2 === 1;
}

/** 该位置是否落在单反引号行内代码里（`{...}` 是刻意展示，不摘） */
function insideInlineCode(text, index) {
  // 先剥掉已闭合的 ``` 围栏，只数剩下的单反引号
  const before = text.slice(0, index).replace(/```[\s\S]*?```/g, '');
  return ((before.match(/`/g) || []).length % 2) === 1;
}

/** 从 start 开始找第一段完整 JSON 的结束下标（跳过字符串里的括号） */
function findJsonEnd(text, start) {
  if (text[start] !== '{' && text[start] !== '[') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 找下一个可能的 JSON 起点：`{`/`[` 后面紧跟（空白后）`"`、`{`、`[` */
function findJsonStart(text, from) {
  for (let i = from; i < text.length; i += 1) {
    const c = text[i];
    if (c !== '{' && c !== '[') continue;
    let j = i + 1;
    while (j < text.length && /[\s]/.test(text[j])) j += 1;
    if (text[j] === '"' || text[j] === '{' || text[j] === '[') return i;
  }
  return -1;
}

const countKeys = (block) => (block.match(/"[A-Za-z_][\w-]*"\s*:/g) || []).length;

/**
 * 从可见文本里摘掉裸 JSON 片段（≥120 字符且 ≥3 个 key，围栏/行内代码里的不算）。
 * 返回 { text: 剩余正文, removed: [被摘走的 JSON 原文...] }，供 Markdown 正文 +
 * 「查看原始输出」折叠区使用。
 * @param {unknown} text
 * @returns {{ text: string, removed: string[] }}
 */
export function stripBareJson(text) {
  const src = String(text ?? '');
  if (!src) return { text: '', removed: [] };
  const removed = [];
  let out = '';
  let i = 0;
  while (i < src.length) {
    const start = findJsonStart(src, i);
    if (start < 0) {
      out += src.slice(i);
      break;
    }
    const end = findJsonEnd(src, start);
    const block = end > start ? src.slice(start, end + 1) : '';
    if (
      block
      && block.length >= 120
      && countKeys(block) >= 3
      && !insideFence(src, start)
      && !insideInlineCode(src, start)
    ) {
      out += src.slice(i, start);
      if (out && !out.endsWith('\n')) out += '\n\n';
      removed.push(block);
      i = end + 1;
      while (i < src.length && /[ \t\r\n]/.test(src[i])) i += 1;
      continue;
    }
    out += src.slice(i, start + 1);
    i = start + 1;
  }
  return {
    text: out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim(),
    removed
  };
}
