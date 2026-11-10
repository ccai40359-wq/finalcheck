// 子代理最终回答的结构化呈现。
// swarm 步骤（recon/find/verify/arbitrate）只输出 JSON：targets / findings / verdicts / decisions。
// 这里按形状换成墨黑金边卡片（和主会话的交付物卡同一套观感），识别不了就回退普通 markdown；
// 原始 JSON 一律收进卡片底部「原始输出」折叠区，默认收起——任何情况下都不让裸 JSON 铺满面板。
//
// 三类输入三种表现：
//   1) 完整 JSON          → 结构化卡片
//   2) 被截断/不完整 JSON → 黄色提示 + 逐条抽出的部分卡片 + 原始输出折叠
//   3) 普通文字回答       → 和主对话同一套 renderMarkdown；只有明显夹带 JSON 时才附原始输出折叠
import React, { useMemo, useState } from 'react';
import { renderMarkdown } from './md.jsx';
import { stripBareJson } from '../lib/humanize.js';

// 只有「{ 后面跟 " 或 {」/「[ 后面跟 " 或 {」才当 JSON 起点；
// 避免 markdown 的 `[链接](...)`、任务列表 `[ ]` 被误判成 JSON。
const JSON_START = /^[{[][\s]*["{[]/;

const str = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

const stringifyJson = (v) => {
  try { return JSON.stringify(v, null, 2); } catch { return str(v); }
};

/** 风险/严重度徽标：high 红 / medium 金 / low 灰（不用 neon 色） */
const SEV_CLS = {
  high: 'bg-red-500/15 text-red-400 border border-red-500/30',
  medium: 'bg-gold/15 text-goldSoft border border-gold/30',
  low: 'bg-white/[0.06] text-mute/70 border border-white/[0.12]'
};

/** 裁决徽标：confirmed 玉色 / rejected 红 / uncertain 琥珀 */
const VERDICT_CLS = {
  confirmed: 'bg-jade/15 text-jade border border-jade/40',
  rejected: 'bg-red-500/15 text-red-400 border border-red-500/30',
  uncertain: 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
};

const SECTION_META = {
  targets: { key: 'targets', label: '侦察目标', icon: '◎', unit: '个目标', Row: TargetRow },
  findings: { key: 'findings', label: '取证发现', icon: '▣', unit: '条发现', Row: FindingRow },
  verdicts: { key: 'verdicts', label: '验证裁决', icon: '⚖', unit: '条裁决', Row: VerdictRow },
  decisions: { key: 'decisions', label: '仲裁决定', icon: '◈', unit: '条决定', Row: DecisionRow }
};

/** 去掉整段输出外面的 ``` 围栏（带或不带 json 标签、单行或多行） */
export function stripFences(text) {
  const raw = String(text ?? '').trim();
  if (!raw || !raw.startsWith('```')) return raw;
  const nl = raw.indexOf('\n');
  const end = raw.lastIndexOf('```');
  if (nl >= 0 && end > nl) return raw.slice(nl + 1, end).trim();
  // 单行围栏：```json {"targets":[]} ```
  const inline = raw.match(/^```[a-zA-Z0-9_-]*[ \t]*([\s\S]*?)```$/);
  return inline ? inline[1].trim() : raw;
}

/** 找到从 start 开始的第一段完整 JSON 的结束下标（跳过字符串里的括号） */
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

/** 先直接 parse；模型偶尔在 JSON 后多写一句说明，就截取第一段完整 JSON 再 parse */
function parseJsonLoose(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { /* 继续 */ }
  const end = findJsonEnd(text, 0);
  if (end >= 0) {
    try { return { ok: true, value: JSON.parse(text.slice(0, end + 1)) }; } catch { /* 继续 */ }
  }
  return { ok: false };
}

/** 识别四种 swarm 形状；数组形状（顶层直接给数组）按首条对象的字段推断 */
export function detectSwarmSections(value) {
  if (Array.isArray(value)) {
    const first = value.find((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (!first) return null;
    let key = '';
    if ('final' in first && 'claimId' in first) key = 'decisions';
    else if ('verdict' in first && 'claimId' in first) key = 'verdicts';
    else if ('claim' in first) key = 'findings';
    else if ('path' in first) key = 'targets';
    return key ? { [key]: value } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const out = {};
  let any = false;
  for (const key of Object.keys(SECTION_META)) {
    if (Array.isArray(value[key])) { out[key] = value[key]; any = true; }
  }
  if (any) return out;
  // 有些模型会多包一层 result/data/output；只透一层，形状仍然照上面的规则认
  for (const wrap of ['result', 'data', 'output']) {
    const inner = value[wrap];
    if (inner && typeof inner === 'object') {
      const nested = detectSwarmSections(inner);
      if (nested) return nested;
    }
  }
  return null;
}

/** 单条对象属于哪一类（截断恢复时逐条归类用） */
function classifyItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  if ('final' in item && 'claimId' in item) return 'decisions';
  if ('verdict' in item && 'claimId' in item) return 'verdicts';
  if ('claim' in item && ('severity' in item || 'evidence' in item || 'file' in item || 'reproduced' in item || 'id' in item)) return 'findings';
  if ('path' in item && ('reason' in item || 'risk' in item || 'id' in item)) return 'targets';
  return '';
}

/**
 * 从（可能被截断的）原始文本里逐条抽出「已经闭合且能 parse」的对象。
 * 外层容器断了不影响：扫描器会进到它内部，拿到前面完整的那些条目。
 */
function extractCompleteObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    const end = findJsonEnd(text, i);
    if (end < 0) continue; // 这个对象本身没闭合：继续往里扫
    let value = null;
    try { value = JSON.parse(text.slice(i, end + 1)); } catch { value = null; }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const key = classifyItem(value);
      if (key) {
        out.push(value);
        i = end; // 已是完整条目，跳过内部嵌套
      }
    }
    // 认不出的闭合对象不跳，继续扫它里面（可能是多包一层的容器）
  }
  return out;
}

// 截断兜底：按 spec 的 finding 形状做一次正则抽取（对象行内写成一行时更稳）
const FINDING_PROBE_RE = /\{\s*"id"\s*:\s*"[^"]*"[\s\S]*?"reproduced"\s*:\s*(?:true|false)\s*\}/g;
const CLAIM_PROBE_RE = /\{\s*"claim"\s*:\s*"[^"]*"[\s\S]*?"(?:severity|reproduced)"\s*:[\s\S]*?\}/g;

/** 截断 JSON → 能抽出的部分 sections + 条数 */
export function extractPartialSections(text) {
  const sections = {};
  const seen = new Set();
  let count = 0;
  const add = (key, item) => {
    let sig = '';
    try { sig = `${key}:${JSON.stringify(item)}`; } catch { sig = `${key}:${String(item)}`; }
    if (seen.has(sig)) return;
    seen.add(sig);
    (sections[key] || (sections[key] = [])).push(item);
    count += 1;
  };
  for (const item of extractCompleteObjects(text)) {
    const key = classifyItem(item);
    if (key) add(key, item);
  }
  if (!sections.findings) {
    for (const re of [FINDING_PROBE_RE, CLAIM_PROBE_RE]) {
      for (const match of text.match(re) || []) {
        try {
          const value = JSON.parse(match);
          if (classifyItem(value) === 'findings') add('findings', value);
        } catch { /* 不是合法 JSON，跳过 */ }
      }
      if (sections.findings) break;
    }
  }
  return { sections, count };
}

/** 普通回答里是否夹着明显的一段裸 JSON（用来决定要不要附原始输出折叠区） */
export function hasObviousJson(text) {
  const t = String(text ?? '');
  if (t.length < 240) return false;
  if (!/(?:^|\n)\s*[\[{]\s*"/.test(t)) return false;
  const keys = t.match(/"[A-Za-z_][\w-]*"\s*:/g) || [];
  return keys.length >= 3;
}

/** 最终回答 → empty / json / json-unknown / json-truncated / markdown */
export function parseSwarmAnswer(answer) {
  const text = String(answer ?? '').trim();
  if (!text) return { kind: 'empty' };
  const candidate = stripFences(text);
  if (JSON_START.test(candidate)) {
    const parsed = parseJsonLoose(candidate);
    if (parsed.ok) {
      const sections = detectSwarmSections(parsed.value);
      if (sections) return { kind: 'json', data: parsed.value, sections, text };
      return { kind: 'json-unknown', data: parsed.value, text };
    }
    // parse 不了：先尝试逐条恢复，恢复不出来也把 raw 收进折叠区
    const partial = extractPartialSections(candidate);
    return { kind: 'json-truncated', sections: partial.sections, count: partial.count, text };
  }
  return { kind: 'markdown', text, hasJson: hasObviousJson(text) };
}

function Chevron({ open }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round"
      className={`shrink-0 text-mute/45 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function TargetRow({ item }) {
  const risk = str(item?.risk).toLowerCase() || 'low';
  const path = str(item?.path);
  const reason = str(item?.reason);
  const id = str(item?.id);
  return (
    <div className="flex items-start gap-2 px-3.5 py-2.5">
      <span className={`badge shrink-0 mt-px text-[10px] ${SEV_CLS[risk] || SEV_CLS.low}`}>{risk}</span>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[12px] leading-relaxed text-goldSoft break-all">{path || '(缺少路径)'}</div>
        {reason ? <div className="mt-0.5 text-[11px] leading-relaxed text-mute/65 break-words">{reason}</div> : null}
      </div>
      {id ? <span className="shrink-0 font-mono text-[10px] text-mute/40">{id}</span> : null}
    </div>
  );
}

function FindingRow({ item }) {
  const [open, setOpen] = useState(false);
  const sev = str(item?.severity).toLowerCase() || 'medium';
  const claim = str(item?.claim);
  const evidence = str(item?.evidence);
  const file = str(item?.file);
  const line = item?.line;
  const where = file ? `${file}${line != null ? ':' + line : ''}` : '';
  const canOpen = !!evidence;
  return (
    <div>
      <button type="button" disabled={!canOpen} aria-expanded={canOpen ? open : undefined}
        onClick={() => { if (canOpen) setOpen((v) => !v); }}
        className={`w-full text-left px-3.5 py-2.5 flex items-start gap-2 transition-colors ${canOpen ? 'hover:bg-white/[0.03]' : 'cursor-default'}`}>
        <span className={`badge shrink-0 mt-px text-[10px] ${SEV_CLS[sev] || SEV_CLS.low}`}>{sev}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs leading-relaxed text-ink/90 break-words">{claim || '(无结论)'}</span>
          {where ? (
            <span className="mt-0.5 block font-mono text-[10.5px] text-mute/50 truncate" title={where}>{where}</span>
          ) : null}
        </span>
        {str(item?.id) ? <span className="shrink-0 font-mono text-[10px] text-mute/40">{str(item.id)}</span> : null}
        {canOpen ? <span className="mt-0.5 shrink-0"><Chevron open={open} /></span> : null}
      </button>
      {open && canOpen ? (
        <pre className="border-t border-white/[0.06] bg-black/20 px-3.5 py-2 text-[11px] font-mono leading-relaxed text-mute/75 whitespace-pre-wrap break-words max-h-56 overflow-y-auto">{evidence}</pre>
      ) : null}
    </div>
  );
}

function VerdictRow({ item }) {
  const verdict = str(item?.verdict).toLowerCase() || 'uncertain';
  const claimId = str(item?.claimId);
  const evidence = str(item?.evidence);
  const note = str(item?.note);
  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`badge shrink-0 text-[10px] ${VERDICT_CLS[verdict] || VERDICT_CLS.uncertain}`}>{verdict}</span>
        <span className="font-mono text-[11px] text-goldSoft/80 truncate">{claimId || '(缺少条目编号)'}</span>
      </div>
      {evidence ? (
        <pre className="mt-1.5 rounded-lg bg-black/20 border border-white/[0.05] px-2.5 py-1.5 text-[10.5px] font-mono leading-relaxed text-mute/70 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{evidence}</pre>
      ) : null}
      {note ? <div className="mt-1 text-[10.5px] leading-relaxed text-mute/45 break-words">{note}</div> : null}
    </div>
  );
}

function DecisionRow({ item }) {
  const final = str(item?.final).toLowerCase() || 'uncertain';
  const claimId = str(item?.claimId);
  const quote = str(item?.quote);
  const reason = str(item?.reason);
  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`badge shrink-0 text-[10px] ${VERDICT_CLS[final] || VERDICT_CLS.uncertain}`}>{final}</span>
        <span className="font-mono text-[11px] text-goldSoft/80 truncate">{claimId || '(缺少条目编号)'}</span>
      </div>
      {quote ? (
        <blockquote className="mt-1.5 border-l-2 border-gold/30 pl-2.5 font-mono text-[10.5px] leading-relaxed text-ink/75 whitespace-pre-wrap break-words">{quote}</blockquote>
      ) : null}
      {reason ? <div className="mt-1 text-[10.5px] leading-relaxed text-mute/45 break-words">{reason}</div> : null}
    </div>
  );
}

/** 原始输出折叠区：默认收起，展开后限高 + 内部滚动（裸 JSON 永远不进面板主干） */
function RawOutput({ text, label = '查看原始输出' }) {
  const [open, setOpen] = useState(false);
  const body = useMemo(() => (typeof text === 'string' ? text : stringifyJson(text)), [text]);
  return (
    <div className="border-t border-white/[0.06] px-3.5 py-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] text-mute/50 hover:text-goldSoft transition-colors duration-150">
        <span>{label}</span>
        <Chevron open={open} />
      </button>
      {open ? (
        <pre className="mt-1.5 rounded-lg bg-black/25 border border-white/[0.06] px-3 py-2 text-[11px] font-mono leading-relaxed text-mute/70 whitespace-pre-wrap break-all max-h-72 overflow-y-auto animate-[fadeIn_.18s_ease]">{body}</pre>
      ) : null}
    </div>
  );
}

function SwarmCards({ sections, rawText }) {
  const keys = Object.keys(SECTION_META).filter((key) => Array.isArray(sections[key]));
  return (
    <div className="mt-2.5 rounded-xl border border-gold/30 bg-[#0d0d10] overflow-hidden animate-[fadeIn_.2s_ease]">
      {keys.map((key, si) => {
        const meta = SECTION_META[key];
        const list = sections[key];
        const Row = meta.Row;
        return (
          <section key={key} className={si ? 'border-t border-white/[0.06]' : ''}>
            <div className="px-3.5 pt-2.5 pb-1.5 flex items-center gap-2 min-w-0">
              <span className="badge shrink-0 bg-gold/15 text-goldSoft border border-gold/35 text-[11px]">{meta.icon} {meta.label}</span>
              <span className="text-[11px] tabular-nums text-mute/55">{list.length} {meta.unit}</span>
            </div>
            {list.length ? (
              <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
                {list.map((item, i) => <Row key={i} item={item} />)}
              </div>
            ) : (
              <div className="px-3.5 pb-2.5 text-[11px] text-mute/45">没有条目</div>
            )}
          </section>
        );
      })}
      {rawText ? <RawOutput text={rawText} /> : null}
    </div>
  );
}

/** 截断/不完整 JSON：黄色提示 + 能恢复的条目 + 折叠原始输出 */
function TruncatedAnswer({ sections, count, text }) {
  const hasRows = Object.keys(SECTION_META).some((key) => Array.isArray(sections[key]) && sections[key].length);
  return (
    <div className="mt-2.5">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11.5px] leading-relaxed text-amber-300/90">
        {count > 0
          ? `子代理输出被截断，以下 ${count} 条可能不完整`
          : '子代理输出不是完整 JSON，已收进原始输出'}
      </div>
      {hasRows ? (
        <SwarmCards sections={sections} rawText={text} />
      ) : (
        <div className="mt-2 rounded-xl border border-white/[0.09] bg-[#0d0d10] overflow-hidden">
          <RawOutput text={text} />
        </div>
      )}
    </div>
  );
}

/** 能 parse 但认不出 swarm 形状的 JSON：只留折叠原始输出，不铺开 */
function UnknownJson({ text }) {
  return (
    <div className="mt-2.5 rounded-xl border border-white/[0.09] bg-[#0d0d10] overflow-hidden">
      <div className="px-3.5 pt-2 pb-1 text-[11px] text-mute/50">JSON 输出（结构未识别）</div>
      <RawOutput text={text} />
    </div>
  );
}

function MarkdownAnswer({ text, hasJson = false }) {
  // 裸 JSON（≥120 字符、≥3 个 key、非围栏/行内代码）从正文摘走，原文收进「查看原始输出」
  const stripped = useMemo(() => stripBareJson(text), [text]);
  const visible = stripped.text;
  const removed = stripped.removed;
  const showRaw = hasJson || removed.length > 0;
  const rawText = removed.length ? removed.join('\n\n') : text;
  const html = useMemo(() => renderMarkdown(visible), [visible]);
  return (
    <div className="mt-2">
      {visible ? (
        <div className="md text-sm" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="text-[11px] text-mute/50">（正文只有 JSON，已收进原始输出）</div>
      )}
      {showRaw ? (
        <div className="mt-2 rounded-xl border border-white/[0.09] bg-[#0d0d10] overflow-hidden">
          <RawOutput text={rawText} />
        </div>
      ) : null}
    </div>
  );
}

export function SwarmResult({ answer, streaming = false }) {
  const parsed = useMemo(() => parseSwarmAnswer(answer), [answer]);
  if (parsed.kind === 'empty') return null;
  if (parsed.kind === 'json') {
    return <SwarmCards sections={parsed.sections} rawText={stringifyJson(parsed.data)} />;
  }
  // 运行中还没拿到最终回答：半截 JSON / 认不出的 JSON 先不铺出来，保留 Working 计时
  if (streaming && (parsed.kind === 'json-truncated' || parsed.kind === 'json-unknown')) return null;
  if (parsed.kind === 'json-truncated') {
    return <TruncatedAnswer sections={parsed.sections} count={parsed.count} text={parsed.text} />;
  }
  if (parsed.kind === 'json-unknown') return <UnknownJson text={parsed.text} />;
  // 普通回答：和主对话同一套 markdown 渲染；明显夹带 JSON 时 raw 才进折叠区
  return <MarkdownAnswer text={parsed.text} hasJson={parsed.hasJson} />;
}
