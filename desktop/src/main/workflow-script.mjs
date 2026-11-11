// 受限脚本 DSL 解释器：模型只产出 JSON 指令，本文件只做解释执行。
//
// 安全边界：
//  - 不执行任何模型提供的代码；插值只做 ${name}（当前 fanout/loop/recurse 变量）与 ${nodeId.content}（取节点文本）。
//  - 其他 ${...} 语法一律原样保留，不做表达式求值。
//  - 本文件只使用静态模块引用与固定白名单工具，没有动态代码加载，也没有命令执行入口。
//
// 复用（与 steps 模式保持一致）：
//  - 节点指纹走 workflow.mjs 的 stepHash，脚本节点的原始 JSON 放在 scriptOp 字段里参与 hash；
//  - 可复用判定走 workflow.mjs 的 computeReuse；
//  - 空转/截断判定走 workflow.mjs 的 needsEvidence + judgeSubagentOutcome，不在本文件另写规则。
//
// 脚本语义：
//  - 顶层 op 按数组顺序执行，一个顶层 op = 一个阶段；
//  - depends_on 只影响上游结果注入，不改变执行顺序；
//  - fanout 子节点 id = `${id}#${index}`，if 分支节点 id = `${ifId}.then.${i}` / `.else.${i}`；
//  - loop 每轮 body 节点 id = `${loopId}.r${round}.${i}`；
//  - recurse 每个分支 body 节点 id = `${recurseId}.d${depth}.i${index}.${i}`；
//  - gate / aggregate 是程序节点（不调模型，source='program'，视为 verified）；
//  - report 成功即写入 journal 与 delivered，后续节点失败也不撤销。
import fs from 'node:fs/promises';
import path from 'node:path';
import { recordStep, runIdOf, saveJournal } from './workflow-journal.mjs';
import { ADVERSARIAL_VERIFY_ID, ADVERSARIAL_VERIFY_NAME, ADVERSARIAL_VERIFY_PROMPT, ADVERSARIAL_VERIFY_ROLE, applyAdversarialGate, appendAdversarialReportNote, buildPrompt, computeReuse, judgeSubagentOutcome, needsEvidence, resolveVerifyTimeoutMs, stepHash } from './workflow.mjs';
import { REPORT_ADVERSARIAL_RULE, applyVerdicts, buildSwarmPrompt, claimsToJsonl, collectClaims, deriveNodeErrorCode, errorCodeLabel, lintClaims, lintReport, parseAgentJson } from './swarm.mjs';
import { DELIVERY_DISCIPLINE } from './swarm.mjs';
import { buildHolesPromptSection, collectHoles, isSalvageText, salvageSubagentContent } from './subagent-salvage.mjs';
import { appendVerifyConclusions, buildUpstreamOnlyVerifyPrompt, clipStoredContent, existingNodeOutputPath, withFullOutputHint, writeNodeOutput } from './workflow-outputs.mjs';
import { audit } from '../../../src/audit.mjs';
import { checkQuality } from '../../../src/checks/quality.mjs';
import { reviewDiff } from '../../../src/review-diff.mjs';
import { t } from '../renderer/i18n/core.mjs';

export const SCRIPT_MAX_NODES = 200;
// 硬上限：字面量 / 运行时解析出的扇出列表超过这个数直接报错（脚本写错了，不是规模问题）。
export const SCRIPT_MAX_FANOUT = 50;
// 默认软上限：没写 limit 时只跑前 20 项。实测事故里模型把侦察出的 32 个入口全量铺开，
// 并发 4 跑了 25 分钟、一个字报告都没有；默认截断 + 显式 limit 让「扇出规模」变成
// 可审查的脚本参数，而不是靠模型自觉。
export const SCRIPT_DEFAULT_FANOUT_LIMIT = 20;
// 截断文案里预览多少个未覆盖条目（总数始终写出来，避免文案被长列表撑爆）
export const SCRIPT_FANOUT_SKIP_PREVIEW = 8;
// 自动补的 report prompt 里最多列多少个未覆盖条目（超出写「等共 N 项」，报告仍可点名）
export const SCRIPT_FANOUT_PROMPT_PREVIEW = 40;
// 自动补的 report 节点 id（与 workflow.mjs 的 ADVERSARIAL_VERIFY_ID 同一命名约定）
export const SCRIPT_AUTO_REPORT_ID = '__report__';
// fanout 子节点之间的并发上限：一次 L3 验收会展开十几个独立审查，串行跑等于把每个
// 子代理的 2-6 分钟直接相加（实测 20 个节点要一个多小时）。默认 4 是「够快」与「别把
// 网关打限流」的折中；运行中还能在卡片设置里 1..14 调整。
export const SCRIPT_DEFAULT_CONCURRENCY = 4;
export const SCRIPT_MAX_CONCURRENCY = 14;
export const SCRIPT_MAX_DEPTH = 8;
// if 分支里再套 fanout：最多 2 层 if（含最外层）
export const SCRIPT_MAX_IF_FANOUT_DEPTH = 2;
export const SCRIPT_LOOP_MAX_ROUNDS = 20;
export const SCRIPT_RECURSE_MAX_DEPTH = 4;
export const SCRIPT_AGGREGATE_TOP_MAX = 20;
export const SCRIPT_AGGREGATE_TOP_DEFAULT = 10;

export const SCRIPT_OPS = ['step', 'fanout', 'if', 'gate', 'verify', 'report', 'loop', 'recurse', 'aggregate'];
export const SCRIPT_GATE_TOOLS = ['audit_project', 'quality_gate', 'review_diff'];
export const SCRIPT_AGGREGATE_BY = ['severity', 'rule', 'file', 'status'];

const OP_KINDS = new Set(SCRIPT_OPS);
const GATE_TOOL_NAMES = new Set(SCRIPT_GATE_TOOLS);
const AGGREGATE_KEYS = new Set(SCRIPT_AGGREGATE_BY);
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const NODE_ID_RE = /^[A-Za-z0-9_.#-]{1,96}$/;
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const MAX_PROMPT_CHARS = 6000;
const EMPTY_STATE = { status: 'pending', reused: false, startedAt: null, ms: null, error: null, tools: 0 };

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return String(value ?? '').trim();
}

function refArray(value, field, opId) {
  if (typeof value === 'string' && value.trim()) return { refs: [value.trim()] };
  if (Array.isArray(value) && value.length) {
    const refs = [];
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim()) {
        return { error: t('{opId} 的 {field} 必须是字符串或非空字符串数组', { opId, field }) };
      }
      refs.push(item.trim());
    }
    return { refs };
  }
  return { error: t('{opId} 缺少 {field}（上游节点引用）', { opId, field }) };
}

function validateWhen(value, label) {
  if (!isObj(value)) return { error: t('{label} 必须是对象', { label }) };
  const ref = text(value.ref);
  if (!ref) return { error: t('{label}.ref 不能为空', { label }) };
  if (!isObj(value.test)) return { error: t('{label}.test 必须是对象', { label }) };
  const keys = Object.keys(value.test);
  if (!keys.length) return { error: t('{label}.test 至少要有 contains / equals / notEmpty 之一', { label }) };
  for (const key of keys) {
    if (!['contains', 'equals', 'notEmpty'].includes(key)) return { error: t('{label}.test 含未知字段：{key}', { label, key }) };
    const item = value.test[key];
    if (key === 'notEmpty') {
      if (typeof item !== 'boolean') return { error: t('{label}.test.notEmpty 必须是布尔值', { label }) };
    } else if (!['string', 'number', 'boolean'].includes(typeof item)) {
      return { error: t('{label}.test.{key} 必须是字符串/数字/布尔值', { label, key }) };
    }
  }
  return { when: { ref, test: { ...value.test } } };
}

function knownRef(ref, ctx) {
  if (ctx.scope.has(ref)) return true;
  if (ctx.aliases.has(ref)) return true;
  if (ctx.bodyAliases && ctx.bodyAliases.has(ref)) return true;
  const sharp = String(ref).match(/^(.+)#\d+$/);
  if (sharp && ctx.fanoutBases.has(sharp[1])) return true;
  return false;
}

function checkRefs(refs, ctx, opId, field) {
  for (const ref of refs) {
    if (!knownRef(ref, ctx)) return t('{opId} 的 {field} 指向不存在的节点：{ref}', { opId, field, ref });
  }
  return null;
}

function mapWalkRef(ref, ctx) {
  if (ctx.forceDerived && ctx.bodyAliases && ctx.bodyAliases.has(ref)) return ctx.bodyAliases.get(ref);
  return ref;
}

function noteExternalRefs(refs, ctx) {
  if (!ctx.containerDeps) return;
  for (const ref of Array.isArray(refs) ? refs : [refs]) {
    if (ctx.bodyAliases && ctx.bodyAliases.has(ref)) continue;
    if (ctx.bodyNodeIds && ctx.bodyNodeIds.has(ref)) continue;
    ctx.containerDeps.add(ref);
  }
}

function claimNodeId(ctx, id) {
  if (ctx.allIds.has(id)) return t('节点 id 重复：{id}', { id });
  ctx.allIds.add(id);
  return null;
}

function claimResultId(ctx, id, opId) {
  if (!ctx.forceDerived && id === opId) return null; // 顶层 id 已在 walkOps 入口登记
  return claimNodeId(ctx, id);
}

function countNode(ctx) {
  ctx.nodesCounted.n += 1;
  if (ctx.nodesCounted.n > SCRIPT_MAX_NODES) {
    return t('脚本节点最多 {max} 个（当前 {n}）', { max: SCRIPT_MAX_NODES, n: ctx.nodesCounted.n });
  }
  return null;
}

function setBodyAlias(ctx, opId, nodeId) {
  if (!ctx.forceDerived) return null;
  if (ctx.bodyAliases.has(opId)) return t('循环/递归 body 内 op id 重复：{opId}', { opId });
  ctx.bodyAliases.set(opId, nodeId);
  ctx.bodyNodeIds.add(nodeId);
  return null;
}

function makeFanoutChild(container, item, index) {
  const sub = container.step;
  // 卡片上显示的名字也要插值（否则会看到「审查 ${file} 1」这种原文模板）
  const baseName = sub.name
    ? interpolateScriptText(sub.name, { [container.as]: String(item) })
    : container.name;
  const name = baseName ? `${baseName} ${index + 1}` : `${container.name} #${index + 1}`;
  const rawOp = { op: 'step', id: `${container.id}#${index}`, name: sub.name || null, role: sub.role || null, prompt: sub.prompt };
  return {
    id: `${container.id}#${index}`,
    name: String(name).slice(0, 60),
    role: String(sub.role || '').slice(0, 80),
    prompt: sub.prompt,
    template: sub.prompt,
    depends_on: [],
    kind: null,
    opType: 'step',
    fanoutOf: container.id,
    as: container.as,
    index,
    item,
    scriptOp: `${JSON.stringify(rawOp)}|[]`,
  };
}

function makeSimpleNode({ id, name, role, prompt, depends_on, kind = null, opType, extra = {}, rawOp }) {
  return {
    id,
    name: String(name || `步骤 ${id}`).slice(0, 60),
    role: String(role || '').slice(0, 80),
    prompt: String(prompt || ''),
    depends_on: depends_on.map(String),
    kind,
    opType,
    ...extra,
    rawOp, // 原始 op 引用：自动补验后同步 depends_on 时用来重建 scriptOp
    scriptOp: `${JSON.stringify(rawOp)}|${JSON.stringify(depends_on.map(String))}`,
  };
}

function makeProgramNode({ id, name, role, depends_on, programType, extra = {}, rawOp, prompt = '' }) {
  return {
    id,
    name: String(name || `程序 ${id}`).slice(0, 60),
    role: String(role || '程序检查').slice(0, 80),
    prompt: String(prompt || JSON.stringify(rawOp).slice(0, MAX_PROMPT_CHARS)),
    depends_on: depends_on.map(String),
    kind: null,
    opType: programType,
    program: true,
    programType,
    ...extra,
    rawOp,
    scriptOp: `${JSON.stringify(rawOp)}|${JSON.stringify(depends_on.map(String))}`,
  };
}

/**
 * fanout 的 limit：没写 → 默认 20；写了必须是 1..SCRIPT_MAX_FANOUT 的整数。
 * @returns {{limit:number}|{error:string}}
 */
function parseFanoutLimit(raw, opId) {
  if (raw.limit === undefined || raw.limit === null) return { limit: SCRIPT_DEFAULT_FANOUT_LIMIT };
  const n = Number(raw.limit);
  if (!Number.isInteger(n) || n < 1 || n > SCRIPT_MAX_FANOUT) {
    return { error: t('fanout {id} 的 limit 必须是 1..{max} 的整数', { id: opId, max: SCRIPT_MAX_FANOUT }) };
  }
  return { limit: n };
}

/** 截断记录：让「跑了哪些、没跑哪些」成为可下发到报告的结构化数据 */
function makeFanoutTruncation({ id, total, limit, skippedItems }) {
  const skipped = Array.isArray(skippedItems) ? skippedItems.map(String) : [];
  return { id: String(id), total: Number(total) || 0, limit: Number(limit) || 0, skipped: skipped.length, skippedItems: skipped };
}

function skippedPreview(skippedItems) {
  const list = Array.isArray(skippedItems) ? skippedItems : [];
  const head = list.slice(0, SCRIPT_FANOUT_SKIP_PREVIEW).join('、');
  return list.length > SCRIPT_FANOUT_SKIP_PREVIEW ? t('{head} 等', { head }) : head;
}

function fanoutTruncationWarning(rec) {
  return t('fanout {id}：按 {n} 项扇出，已截断到 {max}；其余 {rest} 项记入 Not covered（{preview}）', {
    id: rec.id,
    n: rec.total,
    max: rec.limit,
    rest: rec.skipped,
    preview: skippedPreview(rec.skippedItems),
  });
}

/**
 * 截断信息进入 report prompt：未执行的条目必须被报告点名，否则「只跑了 20 项」
 * 会被写成「已全面覆盖」。没有截断时返回空串（prompt 不变）。
 */
function buildTruncationPromptSection(truncations) {
  const list = Array.isArray(truncations) ? truncations.filter((rec) => rec && rec.skipped > 0) : [];
  if (!list.length) return '';
  const lines = list.map((rec) => {
    const preview = rec.skippedItems.slice(0, SCRIPT_FANOUT_PROMPT_PREVIEW).join('、');
    const more = rec.skippedItems.length > SCRIPT_FANOUT_PROMPT_PREVIEW
      ? t('……等共 {n} 项', { n: rec.skippedItems.length })
      : '';
    return t('- {id}：共 {total} 项，只执行前 {limit} 项；未覆盖 {rest} 项：{items}', {
      id: rec.id, total: rec.total, limit: rec.limit, rest: rec.skipped, items: `${preview}${more}`,
    });
  });
  return [
    t('扇出截断（硬事实，不得隐瞒）：'),
    ...lines,
    t('上面这些未执行条目必须在 ## Not covered 里逐条点名（写清条目名，不要只写数量）。'),
  ].join('\n');
}

/**
 * 默认强制终局：脚本里有 LLM 取证节点（step/fanout/recurse/loop）却没有 report 时，
 * 在末尾补一个 report，from 指向全部 LLM 节点（含自动补的 verify）。
 * 幂等：已有任何 report（脚本里任何位置）就不动；aggregate 是程序终局，
 * 但不能代替交付报告——有 LLM 节点时仍补 report（验证分支由 hasScriptTerminal 负责）。
 * @returns {object} 同一个 norm（就地追加；节点超限时返回 {error}）
 */
export function injectScriptFinalReport(norm) {
  if (!norm || norm.error || !Array.isArray(norm.items) || !Array.isArray(norm.nodes)) return norm;
  if (hasScriptTerminal(norm.items, { reportOnly: true })) return norm;
  const from = collectScriptEvidenceRefs(norm.items);
  if (!from.length) return norm;
  const taken = new Set(norm.nodes.map((n) => n && n.id).filter(Boolean));
  let id = SCRIPT_AUTO_REPORT_ID;
  if (taken.has(id)) {
    let n = 2;
    while (taken.has(`${SCRIPT_AUTO_REPORT_ID}${n}`)) n += 1;
    id = `${SCRIPT_AUTO_REPORT_ID}${n}`;
  }
  if (norm.nodes.length + 1 > SCRIPT_MAX_NODES) {
    return { error: t('脚本节点最多 {max} 个（自动补 report 后会超限）', { max: SCRIPT_MAX_NODES }) };
  }
  const ask = [
    '把上游所有取证节点的结果汇总成一份最终交付报告，不得新增未经验证的结论。',
    '必须且只能使用五段（标题一字不差）：## Conclusion / ## Findings / ## Verified / ## Not covered / ## Skipped；没有内容的段落写 None。',
    '按 ## Not covered 点名未完成项：凡是失败、被跳过、被截断、未覆盖或未经对抗复核的节点/条目，都要按 id 或条目名逐条写出来，不许只写数量或含糊带过；并写明未覆盖原因（失败/中断/截断/超轮次/未执行）。',
    '## Verified 只写有独立复核证据的条目（claimId + 证据指针）；没有独立复核的一律写「疑似/未复核」。',
  ].join('\n');
  const rawOp = { op: 'report', id, from, ask, auto: true };
  const node = makeSimpleNode({
    id,
    name: t('最终报告'),
    role: t('汇总'),
    prompt: ask,
    depends_on: from,
    kind: 'report',
    opType: 'report',
    extra: { delivered: false, autoInserted: true, fromRefs: from, autoReport: true },
    rawOp,
  });
  norm.items.push({ kind: 'node', node });
  norm.nodes.push(node);
  norm.nodeCount = norm.nodes.length;
  return norm;
}

/** 收集脚本里所有 LLM 取证节点的引用（report 的 from）：step / fanout / recurse / loop / verify */
export function collectScriptEvidenceRefs(items) {
  const refs = [];
  const walk = (list) => {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item) continue;
      if (item.kind === 'node') {
        const node = item.node;
        if (!node) continue;
        const op = String(node.opType || '');
        if (op === 'step' && !node.program) refs.push(node.id);
        else if (op === 'verify') refs.push(node.id);
        else if (op === 'recurse' || node.programType === 'loop') refs.push(node.id);
      } else if (item.kind === 'fanout') {
        refs.push(item.id);
      } else if (item.kind === 'if') {
        walk(item.then);
        walk(item.else);
      }
    }
  };
  walk(items);
  return [...new Set(refs.filter(Boolean))];
}

/** 脚本里是否已有终局（report / aggregate），递归看 if 分支、loop 每轮与 recurse 第一层 */
export function hasScriptTerminal(items, { reportOnly = false } = {}) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    if (item.kind === 'node' && item.node) {
      const node = item.node;
      if (String(node.opType || '') === 'report' || String(node.kind || '').toLowerCase() === 'report') return true;
      if (!reportOnly && node.programType === 'aggregate') return true;
      for (const round of Array.isArray(node.rounds) ? node.rounds : []) {
        if (hasScriptTerminal(round?.items, { reportOnly })) return true;
      }
      for (const branch of Array.isArray(node.level1) ? node.level1 : []) {
        if (hasScriptTerminal(branch?.items, { reportOnly })) return true;
      }
    } else if (item.kind === 'if') {
      if (hasScriptTerminal(item.then, { reportOnly }) || hasScriptTerminal(item.else, { reportOnly })) return true;
    }
  }
  return false;
}

/**
 * 默认强制对抗复核：脚本里有 LLM 取证节点（step/fanout/recurse）且没有 verify 时，
 * 在第一个 report 之前（没有 report 则末尾）补一个盲验节点，from 指向证据节点。
 * 只有 report/aggregate/gate 的脚本不补。幂等：已有任何 verify 节点则不动。
 * @returns {object} 同一个 norm（就地插入；节点超限时返回 {error}）
 */
export function injectScriptAdversarialVerify(norm) {
  if (!norm || norm.error || !Array.isArray(norm.items) || !Array.isArray(norm.nodes)) return norm;
  if (norm.nodes.some((n) => n && String(n.kind || '').toLowerCase() === 'verify')) return norm;
  const evidence = [];
  const collect = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item) continue;
      if (item.kind === 'node') {
        const node = item.node;
        if (!node || node.program) continue;
        if (String(node.opType || '') === 'recurse') evidence.push(node.id);
        else if (String(node.opType || '') === 'step' && needsEvidence(node)) evidence.push(node.id);
      } else if (item.kind === 'fanout') {
        evidence.push(item.id);
      } else if (item.kind === 'if') {
        collect(item.then);
        collect(item.else);
      }
    }
  };
  collect(norm.items);
  const from = [...new Set(evidence.filter(Boolean))];
  if (!from.length) return norm;
  const taken = new Set(norm.nodes.map((n) => n && n.id).filter(Boolean));
  let id = ADVERSARIAL_VERIFY_ID;
  if (taken.has(id)) {
    let n = 2;
    while (taken.has(`${ADVERSARIAL_VERIFY_ID}${n}`)) n += 1;
    id = `${ADVERSARIAL_VERIFY_ID}${n}`;
  }
  if (norm.nodes.length + 1 > SCRIPT_MAX_NODES) {
    return { error: t('脚本节点最多 {max} 个（自动补验后会超限）', { max: SCRIPT_MAX_NODES }) };
  }
  const rawOp = { op: 'verify', id, from, auto: true };
  const node = makeSimpleNode({
    id,
    name: ADVERSARIAL_VERIFY_NAME,
    role: ADVERSARIAL_VERIFY_ROLE,
    prompt: ADVERSARIAL_VERIFY_PROMPT,
    depends_on: from,
    kind: 'verify',
    opType: 'verify',
    extra: { blind: true, autoInserted: true, fromRefs: from },
    rawOp,
  });
  // report 必须把 verify 当作上游：否则红队结论不会进入 report 的 prompt。
  // 同步 node.depends_on 与 rawOp.depends_on，并重建 scriptOp（resume 的步骤指纹保持一致）。
  const reports = [];
  const collectReports = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item) continue;
      if (item.kind === 'node') {
        if (item.node && String(item.node.opType || '') === 'report') reports.push(item.node);
      } else if (item.kind === 'if') {
        collectReports(item.then);
        collectReports(item.else);
      }
    }
  };
  collectReports(norm.items);
  for (const report of reports) {
    if (Array.isArray(report.depends_on) && report.depends_on.includes(id)) continue;
    report.depends_on = [...(Array.isArray(report.depends_on) ? report.depends_on : []), id];
    // 不改调用方传入的原始 script 对象：在副本上同步 rawOp.depends_on
    if (report.rawOp && typeof report.rawOp === 'object') {
      report.rawOp = { ...report.rawOp, depends_on: report.depends_on.slice() };
    }
    report.scriptOp = `${JSON.stringify(report.rawOp || {})}|${JSON.stringify(report.depends_on.map(String))}`;
  }
  const reportIndex = norm.items.findIndex((item) => item?.kind === 'node' && item?.node?.opType === 'report');
  if (reportIndex >= 0) norm.items.splice(reportIndex, 0, { kind: 'node', node });
  else norm.items.push({ kind: 'node', node });
  norm.nodes.push(node);
  norm.nodeCount = norm.nodes.length;
  return norm;
}

/**
 * 校验并展开脚本（不执行）。
 * @returns {{error:string}|{items:Array, nodes:Array, nodeCount:number}}
 */
// 被 fanout/recurse 当 over 消费的节点，必须在 prompt 里就写死输出形状。
// 2026-11-11 实测：recon 交了一段人话 → fanout 按数组解析失败 → 整条 DSL 停机。
// 模板字符串里是真实换行（不是转义），保证提示词里就是两行空行 + 一行硬要求。
const OVER_ARRAY_CONTRACT = `

【输出契约·硬要求】你的正文会被下一步 fanout 当作列表逐项执行。正文最后必须是一个 JSON 字符串数组（例：["a.php","b.js"]），数组外不要写解释，也不要加「共 N 项」之类的收尾句；宁可直接给数组，也不要只写自然语言总结。`;

export function normalizeScript(script) {
  if (!Array.isArray(script) || script.length === 0) {
    return { error: t('script 不能为空：至少 1 条 op') };
  }
  const ctx = {
    topLevel: true,
    forceDerived: false,
    prefix: '',
    depth: 0,
    label: 'script',
    scope: new Set(),
    aliases: new Set(),
    fanoutBases: new Set(),
    allIds: new Set(),
    nodesCounted: { n: 0 },
    bodyAliases: null,
    bodyNodeIds: null,
    containerDeps: null,
  };
  const items = [];
  const nodes = [];
  const error = walkOps(script, ctx, items, nodes);
  if (error) return { error };
  // 先补对抗复核（report 必须把 verify 当上游），再补终局 report（from 会带上 verify）。
  const norm = injectScriptFinalReport(injectScriptAdversarialVerify({ items, nodes, nodeCount: ctx.nodesCounted.n }));
  if (norm.error) return norm;
  // 终局校验：只有 gate / if 这种没有 LLM 节点的边角脚本不会触发自动补 report，
  // 这里明确报错，避免「跑了半天没有任何交付物」再次发生。
  if (!hasScriptTerminal(norm.items)) {
    return { error: t('脚本没有终局（report/aggregate），无法产出交付物；请在末尾加 report') };
  }
  return norm;
}

/**
 * 从已校验的脚本结构生成一句人话（工作流卡「本次用了哪种、为什么」的 why）。
 * 只读结构，不猜任务语义：fanout 字面列表长度 / 引用型扇出、loop 轮次上限、
 * recurse 深度与列表长度、条件分支、纯计算聚合。
 * @param {{items?: any[], nodes?: any[]}|null} norm normalizeScript() 的输出
 * @returns {string}
 */
export function describeScriptMode(norm) {
  const traits = { fanoutItems: 0, fanoutRefs: 0, fanoutTruncatedFrom: 0, recurseItems: 0, loopRounds: 0, recurseDepth: 0, hasIf: false, hasAggregate: false };
  const walk = (items) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item) continue;
      if (item.kind === 'fanout') {
        if (Array.isArray(item.overItems)) traits.fanoutItems += item.overItems.length;
        else if (item.overRef) traits.fanoutRefs += 1;
        if (item.truncation) traits.fanoutTruncatedFrom = Math.max(traits.fanoutTruncatedFrom, item.truncation.total);
      } else if (item.kind === 'if') {
        traits.hasIf = true;
        walk(item.then);
        walk(item.else);
      } else if (item.kind === 'node' && item.node) {
        const node = item.node;
        if (node.programType === 'loop') {
          traits.loopRounds = Math.max(traits.loopRounds, Number(node.maxRounds) || 0);
        } else if (node.programType === 'recurse') {
          traits.recurseDepth = Math.max(traits.recurseDepth, Number(node.maxDepth) || 0);
          if (Array.isArray(node.overItems)) traits.recurseItems += node.overItems.length;
        } else if (node.programType === 'aggregate') {
          traits.hasAggregate = true;
        }
      }
    }
  };
  walk(norm?.items);
  const parts = [];
  if (traits.fanoutItems > 0) {
    parts.push(traits.fanoutTruncatedFrom > traits.fanoutItems
      ? t('按 {n} 项扇出（原 {total} 项，已截断）', { n: traits.fanoutItems, total: traits.fanoutTruncatedFrom })
      : t('按 {n} 项扇出', { n: traits.fanoutItems }));
  } else if (traits.fanoutRefs > 0) parts.push(t('扇出数量由上游结果决定'));
  if (traits.recurseItems > 0) parts.push(t('按 {n} 项递归', { n: traits.recurseItems }));
  if (traits.loopRounds > 0) parts.push(t('最多 {n} 轮循环', { n: traits.loopRounds }));
  if (traits.recurseDepth > 0) parts.push(t('最多 {n} 层递归', { n: traits.recurseDepth }));
  if (traits.hasIf) parts.push(t('含条件分支'));
  if (traits.hasAggregate) parts.push(t('含纯计算汇总'));
  if (!parts.length) parts.push(t('{n} 个脚本节点按指令顺序执行', { n: (norm?.nodes || []).length }));
  return parts.join(' · ');
}

function walkOps(ops, ctx, outItems, outNodes) {
  if (!Array.isArray(ops)) return t('{label} 必须是 op 数组', { label: ctx.label });
  for (let i = 0; i < ops.length; i += 1) {
    const raw = ops[i];
    if (!isObj(raw)) return t('{label}[{i}] 必须是对象', { label: ctx.label, i });
    const op = text(raw.op);
    if (!OP_KINDS.has(op)) {
      return t('未知脚本 op：{op}（只支持 {kinds}）', { op: op || t('(空)'), kinds: SCRIPT_OPS.join('/') });
    }
    const opId = text(raw.id);
    if (!opId) return t('{label}[{i}] 缺少 id', { label: ctx.label, i });
    if (!ID_RE.test(opId)) return t('脚本 id 非法（只允许字母数字-_，最长 32）：{opId}', { opId });
    if (ctx.forceDerived) {
      if (ctx.bodyAliases.has(opId)) return t('循环/递归 body 内 op id 重复：{opId}', { opId });
    } else {
      if (ctx.allIds.has(opId)) return t('脚本 id 重复：{opId}', { opId });
      ctx.allIds.add(opId);
    }
    // 分支/循环体节点 id 按规格派生；顶层节点用显式 id
    const baseId = ctx.topLevel && !ctx.forceDerived ? opId : `${ctx.prefix}.${i}`;
    const name = text(raw.name) || `${op === 'report' ? '汇总' : op === 'verify' ? '验证' : op === 'gate' || op === 'aggregate' ? '程序' : op === 'loop' ? '循环' : op === 'recurse' ? '递归' : '步骤'} ${baseId}`;
    const role = text(raw.role);

    if (op === 'step') {
      const prompt = text(raw.prompt);
      if (!prompt) return t('节点 {id} 缺少 prompt', { id: baseId });
      if (prompt.length > MAX_PROMPT_CHARS) return t('节点 {id} 的 prompt 过长（>{max} 字符）', { id: baseId, max: MAX_PROMPT_CHARS });
      if (raw.depends_on !== undefined && raw.depends_on !== null && !Array.isArray(raw.depends_on)) {
        return t('节点 {id} 的 depends_on 必须是数组', { id: baseId });
      }
      const originalDeps = Array.isArray(raw.depends_on) ? raw.depends_on.map((d) => text(d)).filter(Boolean) : [];
      const refError = checkRefs(originalDeps, ctx, baseId, 'depends_on');
      if (refError) return refError;
      noteExternalRefs(originalDeps, ctx);
      const dependsOn = originalDeps.map((d) => mapWalkRef(d, ctx));
      if (dependsOn.includes(baseId)) return t('节点 {id} 不能依赖自己', { id: baseId });
      const node = makeSimpleNode({
        id: baseId, name, role, prompt, depends_on: dependsOn, opType: 'step', rawOp: raw,
      });
      const claimError = claimResultId(ctx, baseId, opId);
      if (claimError) return claimError;
      const countError = countNode(ctx);
      if (countError) return countError;
      const aliasError = setBodyAlias(ctx, opId, baseId);
      if (aliasError) return aliasError;
      outNodes.push(node);
      outItems.push({ kind: 'node', node });
      ctx.scope.add(baseId);
      continue;
    }

    if (op === 'fanout') {
      const over = raw.over;
      const limitSpec = parseFanoutLimit(raw, baseId);
      if (limitSpec.error) return limitSpec.error;
      const limit = limitSpec.limit;
      let overItems = null;
      let originalOverRef = null;
      let truncation = null;
      if (Array.isArray(over)) {
        if (over.length > SCRIPT_MAX_FANOUT) {
          return t('fanout {id} 的 over 最多 {max} 项（当前 {n}）', { id: baseId, max: SCRIPT_MAX_FANOUT, n: over.length });
        }
        for (const entry of over) {
          if (typeof entry !== 'string') return t('fanout {id} 的 over 里每项必须是字符串', { id: baseId });
        }
        overItems = over.map((entry) => String(entry));
        // 字面列表在静态展开阶段就截断：节点数、阶段轨道、实际调用都以 limit 为准。
        const kept = Math.min(limit, overItems.length);
        if (overItems.length > kept) {
          truncation = makeFanoutTruncation({ id: baseId, total: overItems.length, limit: kept, skippedItems: overItems.slice(kept) });
          overItems = overItems.slice(0, kept);
        }
      } else if (typeof over === 'string' && over.trim()) {
        originalOverRef = over.trim();
        if (!originalOverRef.startsWith('${') && !knownRef(originalOverRef, ctx)) {
          return t('fanout {id} 的 over 指向不存在的节点：{ref}', { id: baseId, ref: originalOverRef });
        }
      } else if (isObj(over) && typeof over.ref === 'string' && over.ref.trim()) {
        originalOverRef = over.ref.trim();
        if (!knownRef(originalOverRef, ctx)) return t('fanout {id} 的 over 指向不存在的节点：{ref}', { id: baseId, ref: originalOverRef });
      } else {
        return t('fanout {id} 缺少 over（字符串数组或节点引用）', { id: baseId });
      }
      const asName = text(raw.as);
      if (!VAR_RE.test(asName)) return t('fanout {id} 的 as 非法（只允许字母数字_，且不能以数字开头）：{as}', { id: baseId, as: asName || t('(空)') });
      if (!isObj(raw.step)) return t('fanout {id} 缺少 step 对象', { id: baseId });
      const subPrompt = text(raw.step.prompt);
      if (!subPrompt) return t('fanout {id} 的子步骤缺少 prompt', { id: baseId });
      if (subPrompt.length > MAX_PROMPT_CHARS) return t('fanout {id} 的子步骤 prompt 过长（>{max} 字符）', { id: baseId, max: MAX_PROMPT_CHARS });
      if (ctx.depth > SCRIPT_MAX_IF_FANOUT_DEPTH) {
        return t('if 分支内套 fanout 最多 {max} 层（{id}）', { max: SCRIPT_MAX_IF_FANOUT_DEPTH, id: baseId });
      }
      const overRef = originalOverRef ? mapWalkRef(originalOverRef, ctx) : null;
      if (originalOverRef) noteExternalRefs([originalOverRef], ctx);
      const container = {
        kind: 'fanout',
        id: baseId,
        name: String(name).slice(0, 60),
        as: asName,
        overItems,
        overRef,
        limit,
        truncation,
        step: {
          name: text(raw.step.name).slice(0, 60),
          role: text(raw.step.role).slice(0, 80),
          prompt: subPrompt,
        },
        children: [],
      };
      const claimError = claimResultId(ctx, baseId, opId);
      if (claimError) return claimError;
      if (overItems) {
        for (let j = 0; j < overItems.length; j += 1) {
          const child = makeFanoutChild(container, overItems[j], j);
          const childClaim = claimNodeId(ctx, child.id);
          if (childClaim) return childClaim;
          const childCount = countNode(ctx);
          if (childCount) return childCount;
          if (ctx.forceDerived) ctx.bodyNodeIds.add(child.id);
          container.children.push(child);
          outNodes.push(child);
          ctx.scope.add(child.id);
        }
      }
      const aliasError = setBodyAlias(ctx, opId, baseId);
      if (aliasError) return aliasError;
      ctx.fanoutBases.add(baseId);
      ctx.aliases.add(baseId);
      ctx.scope.add(baseId);
      outItems.push(container);
      continue;
    }

    if (op === 'if') {
      const validated = validateWhen(raw.when, t('if {opId} 的 when', { opId }));
      if (validated.error) return validated.error;
      const originalRef = validated.when.ref;
      if (!knownRef(originalRef, ctx)) return t('if {opId} 的 when.ref 指向不存在的节点：{ref}', { opId, ref: originalRef });
      noteExternalRefs([originalRef], ctx);
      if (!Array.isArray(raw.then) || raw.then.length === 0) return t('if {opId} 的 then 必须是非空 op 数组', { opId });
      if (raw.else !== undefined && raw.else !== null && !Array.isArray(raw.else)) return t('if {opId} 的 else 必须是 op 数组', { opId });
      if (ctx.depth + 1 > SCRIPT_MAX_DEPTH) return t('if 嵌套超过 {max} 层（{id}）', { max: SCRIPT_MAX_DEPTH, id: opId });
      // 普通 if 分支沿用显式 ifId；循环/递归 body 里的 if 用派生 id 以隔离每一轮
      const containerId = ctx.forceDerived ? baseId : opId;
      if (ctx.forceDerived) {
        const claimError = claimNodeId(ctx, containerId);
        if (claimError) return claimError;
      }
      const container = {
        kind: 'if',
        id: containerId,
        name: String(name).slice(0, 60),
        when: { ref: mapWalkRef(originalRef, ctx), test: { ...validated.when.test } },
        then: [],
        else: [],
      };
      const thenCtx = {
        ...ctx,
        topLevel: false,
        prefix: `${containerId}.then`,
        depth: ctx.depth + 1,
        label: `${containerId}.then`,
        scope: new Set(ctx.scope),
      };
      const thenError = walkOps(raw.then, thenCtx, container.then, outNodes);
      if (thenError) return thenError;
      if (Array.isArray(raw.else)) {
        const elseCtx = {
          ...ctx,
          topLevel: false,
          prefix: `${containerId}.else`,
          depth: ctx.depth + 1,
          label: `${containerId}.else`,
          scope: new Set(ctx.scope),
        };
        const elseError = walkOps(raw.else, elseCtx, container.else, outNodes);
        if (elseError) return elseError;
      }
      const aliasError = setBodyAlias(ctx, opId, containerId);
      if (aliasError) return aliasError;
      ctx.aliases.add(containerId);
      ctx.scope.add(containerId);
      if (ctx.forceDerived) ctx.bodyNodeIds.add(containerId);
      outItems.push(container);
      continue;
    }

    if (op === 'gate') {
      const tool = text(raw.tool);
      if (!GATE_TOOL_NAMES.has(tool)) {
        return t('gate {id} 的 tool 不支持：{tool}（只支持 {tools}）', { id: baseId, tool: tool || t('(空)'), tools: SCRIPT_GATE_TOOLS.join('/') });
      }
      let args = {};
      if (raw.args !== undefined && raw.args !== null) {
        if (!isObj(raw.args)) return t('gate {id} 的 args 必须是对象', { id: baseId });
        args = { ...raw.args };
      }
      const serialized = JSON.stringify(args).slice(0, MAX_PROMPT_CHARS);
      const node = makeSimpleNode({
        id: baseId, name, role: role || '程序检查', prompt: serialized, depends_on: [], opType: 'gate',
        extra: { program: true, programType: 'gate', tool, args }, rawOp: raw,
      });
      const claimError = claimResultId(ctx, baseId, opId);
      if (claimError) return claimError;
      const countError = countNode(ctx);
      if (countError) return countError;
      const aliasError = setBodyAlias(ctx, opId, baseId);
      if (aliasError) return aliasError;
      outNodes.push(node);
      outItems.push({ kind: 'node', node });
      ctx.scope.add(baseId);
      continue;
    }

    if (op === 'verify') {
      const from = refArray(raw.from, 'from', baseId);
      if (from.error) return from.error;
      const refError = checkRefs(from.refs, ctx, baseId, 'from');
      if (refError) return refError;
      noteExternalRefs(from.refs, ctx);
      const dependsOn = from.refs.map((d) => mapWalkRef(d, ctx));
      const node = makeSimpleNode({
        id: baseId,
        name,
        role,
        prompt: text(raw.prompt) || `独立验证 ${baseId}`,
        depends_on: dependsOn,
        kind: 'verify',
        opType: 'verify',
        extra: { blind: true },
        rawOp: raw,
      });
      const claimError = claimResultId(ctx, baseId, opId);
      if (claimError) return claimError;
      const countError = countNode(ctx);
      if (countError) return countError;
      const aliasError = setBodyAlias(ctx, opId, baseId);
      if (aliasError) return aliasError;
      outNodes.push(node);
      outItems.push({ kind: 'node', node });
      ctx.scope.add(baseId);
      continue;
    }

    if (op === 'report') {
      const from = refArray(raw.from, 'from', baseId);
      if (from.error) return from.error;
      const refError = checkRefs(from.refs, ctx, baseId, 'from');
      if (refError) return refError;
      noteExternalRefs(from.refs, ctx);
      const dependsOn = from.refs.map((d) => mapWalkRef(d, ctx));
      const ask = text(raw.ask) || '把上游结果汇总成一份最终交付报告（结论 / 发现 / 未验证 / 未覆盖）。';
      if (ask.length > MAX_PROMPT_CHARS) return t('report {id} 的 ask 过长（>{max} 字符）', { id: baseId, max: MAX_PROMPT_CHARS });
      const node = makeSimpleNode({
        id: baseId,
        name,
        role,
        prompt: ask,
        depends_on: dependsOn,
        kind: 'report',
        opType: 'report',
        extra: { delivered: false },
        rawOp: raw,
      });
      const claimError = claimResultId(ctx, baseId, opId);
      if (claimError) return claimError;
      const countError = countNode(ctx);
      if (countError) return countError;
      const aliasError = setBodyAlias(ctx, opId, baseId);
      if (aliasError) return aliasError;
      outNodes.push(node);
      outItems.push({ kind: 'node', node });
      ctx.scope.add(baseId);
      continue;
    }

    if (op === 'loop') {
      const maxRounds = Number(raw.maxRounds);
      if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > SCRIPT_LOOP_MAX_ROUNDS) {
        return t('loop {id} 的 maxRounds 必须是 1..{max} 的整数', { id: baseId, max: SCRIPT_LOOP_MAX_ROUNDS });
      }
      if (!Array.isArray(raw.body) || raw.body.length === 0) return t('loop {id} 的 body 必须是非空 op 数组', { id: baseId });
      const until = validateWhen(raw.until, t('loop {id} 的 until', { id: baseId }));
      if (until.error) return until.error;
      if (ctx.depth + 1 > SCRIPT_MAX_DEPTH) return t('嵌套超过 {max} 层（{id}）', { max: SCRIPT_MAX_DEPTH, id: baseId });
      const claimError = claimResultId(ctx, baseId, opId);
      if (claimError) return claimError;
      const countError = countNode(ctx);
      if (countError) return countError;
      const containerDeps = new Set();
      const rounds = [];
      for (let round = 1; round <= maxRounds; round += 1) {
        const roundCtx = {
          ...ctx,
          topLevel: false,
          forceDerived: true,
          prefix: `${baseId}.r${round}`,
          depth: ctx.depth + 1,
          label: `${baseId}.r${round}`,
          scope: new Set(ctx.scope),
          bodyAliases: new Map(),
          bodyNodeIds: new Set(),
          containerDeps,
        };
        const roundItems = [];
        const roundError = walkOps(raw.body, roundCtx, roundItems, outNodes);
        if (roundError) return roundError;
        const untilRef = until.when.ref;
        if (!roundCtx.bodyAliases.has(untilRef) && !knownRef(untilRef, roundCtx)) {
          return t('loop {id} 的 until.ref 指向不存在的节点：{ref}', { id: baseId, ref: untilRef });
        }
        noteExternalRefs([untilRef], roundCtx);
        rounds.push({ round, items: roundItems, aliases: roundCtx.bodyAliases });
      }
      const node = makeProgramNode({
        id: baseId,
        name,
        role,
        depends_on: [...containerDeps],
        programType: 'loop',
        extra: { maxRounds, rounds, bodyOp: raw.body, until: until.when },
        rawOp: raw,
        prompt: JSON.stringify({ maxRounds, until: until.when }),
      });
      const aliasError = setBodyAlias(ctx, opId, baseId);
      if (aliasError) return aliasError;
      noteExternalRefs(node.depends_on, ctx);
      ctx.aliases.add(baseId);
      ctx.scope.add(baseId);
      outNodes.push(node);
      outItems.push({ kind: 'node', node });
      continue;
    }

    if (op === 'recurse') {
      const maxDepth = Number(raw.maxDepth);
      if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > SCRIPT_RECURSE_MAX_DEPTH) {
        return t('recurse {id} 的 maxDepth 必须是 1..{max} 的整数', { id: baseId, max: SCRIPT_RECURSE_MAX_DEPTH });
      }
      if (!Array.isArray(raw.body) || raw.body.length === 0) return t('recurse {id} 的 body 必须是非空 op 数组', { id: baseId });
      const over = raw.over;
      let overItems = null;
      let originalOverRef = null;
      if (Array.isArray(over)) {
        for (const entry of over) {
          if (typeof entry !== 'string') return t('recurse {id} 的 over 里每项必须是字符串', { id: baseId });
        }
        overItems = over.map((entry) => String(entry));
      } else if (typeof over === 'string' && over.trim()) {
        originalOverRef = over.trim();
        if (!originalOverRef.startsWith('${') && !knownRef(originalOverRef, ctx)) {
          return t('recurse {id} 的 over 指向不存在的节点：{ref}', { id: baseId, ref: originalOverRef });
        }
      } else if (isObj(over) && typeof over.ref === 'string' && over.ref.trim()) {
        originalOverRef = over.ref.trim();
        if (!knownRef(originalOverRef, ctx)) return t('recurse {id} 的 over 指向不存在的节点：{ref}', { id: baseId, ref: originalOverRef });
      } else {
        return t('recurse {id} 缺少 over（字符串数组或节点引用）', { id: baseId });
      }
      const asName = text(raw.as);
      if (!VAR_RE.test(asName)) return t('recurse {id} 的 as 非法（只允许字母数字_，且不能以数字开头）：{as}', { id: baseId, as: asName || t('(空)') });
      if (ctx.depth + 1 > SCRIPT_MAX_DEPTH) return t('嵌套超过 {max} 层（{id}）', { max: SCRIPT_MAX_DEPTH, id: baseId });
      const claimError = claimResultId(ctx, baseId, opId);
      if (claimError) return claimError;
      const countError = countNode(ctx);
      if (countError) return countError;
      const containerDeps = new Set();
      if (originalOverRef) noteExternalRefs([originalOverRef], ctx);
      if (originalOverRef) containerDeps.add(mapWalkRef(originalOverRef, ctx));
      // 先用探针编译一遍 body：校验引用、收集外部依赖（节点不进全局列表）
      const probeCtx = {
        ...ctx,
        topLevel: false,
        forceDerived: true,
        prefix: `${baseId}.probe`,
        depth: ctx.depth + 1,
        label: `${baseId}.probe`,
        scope: new Set(ctx.scope),
        aliases: new Set(ctx.aliases),
        fanoutBases: new Set(ctx.fanoutBases),
        allIds: new Set(ctx.allIds),
        nodesCounted: { n: 0 },
        bodyAliases: new Map(),
        bodyNodeIds: new Set(),
        containerDeps,
      };
      const probeItems = [];
      const probeNodes = [];
      const probeError = walkOps(raw.body, probeCtx, probeItems, probeNodes);
      if (probeError) return probeError;
      let stopWhen = null;
      if (raw.stopWhen !== undefined && raw.stopWhen !== null) {
        const validatedStop = validateWhen(raw.stopWhen, t('recurse {id} 的 stopWhen', { id: baseId }));
        if (validatedStop.error) return validatedStop.error;
        const stopRef = validatedStop.when.ref;
        if (!probeCtx.bodyAliases.has(stopRef) && !knownRef(stopRef, probeCtx)) {
          return t('recurse {id} 的 stopWhen.ref 指向不存在的节点：{ref}', { id: baseId, ref: stopRef });
        }
        noteExternalRefs([stopRef], probeCtx);
        stopWhen = { ref: stopRef, test: { ...validatedStop.when.test } };
      }
      const level1 = [];
      if (overItems) {
        for (let index = 0; index < overItems.length; index += 1) {
          const branchCtx = {
            ...ctx,
            topLevel: false,
            forceDerived: true,
            prefix: `${baseId}.d1.i${index}`,
            depth: ctx.depth + 1,
            label: `${baseId}.d1.i${index}`,
            scope: new Set(ctx.scope),
            bodyAliases: new Map(),
            bodyNodeIds: new Set(),
            containerDeps,
          };
          const branchItems = [];
          const branchError = walkOps(raw.body, branchCtx, branchItems, outNodes);
          if (branchError) return branchError;
          level1.push({ item: overItems[index], index, items: branchItems, aliases: branchCtx.bodyAliases });
        }
      }
      const node = makeProgramNode({
        id: baseId,
        name,
        role,
        depends_on: [...containerDeps],
        programType: 'recurse',
        extra: {
          overItems,
          overRef: originalOverRef ? mapWalkRef(originalOverRef, ctx) : null,
          as: asName,
          maxDepth,
          stopWhen,
          bodyOp: raw.body,
          level1,
          baseDepth: ctx.depth + 1,
          outerScope: new Set(ctx.scope),
          outerAliases: new Set(ctx.aliases),
          outerFanoutBases: new Set(ctx.fanoutBases),
        },
        rawOp: raw,
        prompt: JSON.stringify({ maxDepth, as: asName, over: overItems, ref: originalOverRef }),
      });
      const aliasError = setBodyAlias(ctx, opId, baseId);
      if (aliasError) return aliasError;
      noteExternalRefs(node.depends_on, ctx);
      ctx.aliases.add(baseId);
      ctx.scope.add(baseId);
      outNodes.push(node);
      outItems.push({ kind: 'node', node });
      continue;
    }

    if (op === 'aggregate') {
      const from = refArray(raw.from, 'from', baseId);
      if (from.error) return from.error;
      const refError = checkRefs(from.refs, ctx, baseId, 'from');
      if (refError) return refError;
      noteExternalRefs(from.refs, ctx);
      const by = text(raw.by);
      if (!AGGREGATE_KEYS.has(by)) {
        return t('aggregate {id} 的 by 不支持：{by}（只支持 {keys}）', { id: baseId, by: by || t('(空)'), keys: SCRIPT_AGGREGATE_BY.join('/') });
      }
      let top = SCRIPT_AGGREGATE_TOP_DEFAULT;
      if (raw.top !== undefined && raw.top !== null) {
        const n = Number(raw.top);
        if (!Number.isInteger(n) || n < 1 || n > SCRIPT_AGGREGATE_TOP_MAX) {
          return t('aggregate {id} 的 top 必须是 1..{max} 的整数', { id: baseId, max: SCRIPT_AGGREGATE_TOP_MAX });
        }
        top = n;
      }
      const dependsOn = from.refs.map((d) => mapWalkRef(d, ctx));
      const node = makeProgramNode({
        id: baseId,
        name,
        role,
        depends_on: dependsOn,
        programType: 'aggregate',
        extra: { by, top, fromRefs: dependsOn },
        rawOp: raw,
        prompt: JSON.stringify({ by, top, from: dependsOn }),
      });
      const claimError = claimResultId(ctx, baseId, opId);
      if (claimError) return claimError;
      const countError = countNode(ctx);
      if (countError) return countError;
      const aliasError = setBodyAlias(ctx, opId, baseId);
      if (aliasError) return aliasError;
      ctx.scope.add(baseId);
      outNodes.push(node);
      outItems.push({ kind: 'node', node });
      continue;
    }

    return t('未知脚本 op：{op}', { op });
  }
  return null;
}

/**
 * 只做两种字符串插值：
 *  - ${name}：当前 fanout / loop / recurse 变量（vars[name]）
 *  - ${nodeId.content}：已执行节点的正文（失败节点给 [失败] 文本）
 * 其他语法原样保留；只替换一遍，替换出来的内容不会再次插值。
 */
export function interpolateScriptText(template, vars = {}, results = new Map()) {
  const input = String(template ?? '');
  return input.replace(/\$\{([^{}]+)\}/g, (raw, expr) => {
    const name = String(expr).trim();
    if (VAR_RE.test(name) && Object.prototype.hasOwnProperty.call(vars, name)) {
      return String(vars[name]);
    }
    const contentMatch = name.match(/^([A-Za-z0-9_.#-]{1,96})\.content$/);
    if (contentMatch && NODE_ID_RE.test(contentMatch[1])) {
      const found = results instanceof Map ? results.get(contentMatch[1]) : results?.[contentMatch[1]];
      if (found) {
        const body = found.ok ? String(found.content || '') : `[失败] ${found.error || '无结果'}`;
        // 正文被截断时下沉「完整输出」路径，子代理可以用 read_file 读全文
        return withFullOutputHint(body, found.fullOutputPath || null);
      }
    }
    return raw;
  });
}

/**
 * 条件判定：contains / equals / notEmpty 全部满足才算命中（AND）。
 * @returns {boolean}
 */
export function matchScriptCondition(when, target) {
  const content = String(target?.content ?? '');
  const test = when && isObj(when.test) ? when.test : {};
  let ok = true;
  if (test.contains !== undefined) ok = ok && content.includes(String(test.contains));
  if (test.equals !== undefined) ok = ok && content.trim() === String(test.equals).trim();
  if (test.notEmpty !== undefined) {
    const nonEmpty = content.trim().length > 0;
    ok = ok && (test.notEmpty ? nonEmpty : !nonEmpty);
  }
  return ok;
}

/**
 * 默认 gate 执行器：直接走现有引擎。
 * - audit_project → src/audit.mjs（runTests=false，不执行项目测试命令）
 * - review_diff  → src/review-diff.mjs（只读 git diff）
 * - quality_gate → src/checks/quality.mjs（默认 run=false，只读配置与覆盖缺口；
 *   真正执行项目命令要走 quality_gate 工具的用户审批通道）
 */
export async function runGateDefault(tool, args = {}, { projectPath = null } = {}) {
  const dir = path.resolve(String(args?.dir || projectPath || process.cwd()));
  if (tool === 'audit_project') {
    const result = await audit(dir, { tier: args?.tier ?? null, interactive: true, runTests: false });
    return {
      verdict: result?.conclusion?.verdict ?? null,
      reason: result?.conclusion?.reason ?? null,
      gates: result?.gates ?? null,
      findings: Array.isArray(result?.findings) ? result.findings.slice(0, 30) : [],
      dir,
    };
  }
  if (tool === 'quality_gate') {
    const result = await checkQuality(dir, { tier: args?.tier || 'L2', run: false });
    return {
      dir,
      executed: false,
      runs: result?.runs || [],
      findings: Array.isArray(result?.findings) ? result.findings.slice(0, 30) : [],
      warnings: result?.warnings || [],
      coverageGap: result?.coverageGap || null,
    };
  }
  if (tool === 'review_diff') {
    const result = await reviewDiff(dir, { base: args?.base });
    return { dir, ...result };
  }
  return { error: t('不支持的程序闸工具：{tool}', { tool }) };
}

function abortScript(message) {
  const e = new Error(message);
  e.scriptAbort = true;
  return e;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseStringList(content) {
  const parsed = parseAgentJson(String(content || ''));
  if (parsed?.error) return null;
  if (!Array.isArray(parsed)) return null;
  for (const item of parsed) {
    if (typeof item !== 'string') return null;
  }
  return parsed;
}

/* ---------- over 引用：JSON 之外的「文本列表」兜底解析 ----------
   子代理经常不按 JSON 输出：它写成「- 入口 /api/a.php」「1. 登录」「| 文件 | 说明 |」。
   引擎以前只认 JSON 字符串数组，直接中止整条工作流；现在按以下顺序解析：
   ① JSON（数组或 { items: [...] }）；② 代码块里的 JSON（parseAgentJson 已覆盖围栏）；
   ③ 逐行文本提取（项目符号 / 编号 / 表格首列 / 独立成行的 URL·路径）；④ 仍为空才报错。
   文本提取是启发式，必然有误提取风险：命中时带 overParsedFrom='text' 并写 warning。 */

const OVER_TEXT_EXTS = 'jsx|tsx|mjs|cjs|php|js|ts|py|rb|go|java|cs|html|json|md|yml|yaml|toml|sql|sh|vue|svelte|astro|css|scss|txt|xml';
const OVER_LEAD_TOKEN_RE = new RegExp(
  `^(?:\`([^\`\\n]+)\`|((?:https?:\\/\\/|\\.{0,2}\\/)?[^\\s\`，。；、：:（）()]+?\\.(?:${OVER_TEXT_EXTS})(?::\\d+)?))(?=$|[\\s，。；、：:（）(),*_~—–\\-])`,
  'i'
);
const OVER_TABLE_SEP_RE = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?$/;

/** 严格模式：只认 JSON 字符串数组（或 {items:[...]}）。用来决定「要不要为 fanout.over 纠正重试一次」。 */
export function isStrictOverArray(content) {
  const parsed = parseAgentJson(String(content || ''));
  const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
  if (!Array.isArray(arr) || !arr.length) return false;
  return arr.every((x) => typeof x === 'string' && x.trim());
}

/** 清理单个文本条目：去 markdown 强调/反引号/复选框，行首是路径或行内代码时只取那个 token。 */
function cleanOverTextItem(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  s = s.replace(/^\[[ xX]\]\s+/, '');
  s = s.replace(/^[*_~]+|[*_~]+$/g, '').trim();
  const lead = s.match(OVER_LEAD_TOKEN_RE);
  if (lead) s = String(lead[1] || lead[2] || '').trim();
  s = s.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim();
  s = s.replace(/[：:]+$/, '').trim();
  return s;
}

/** 文本里「明说的数量」（共 8 个 / 8 项 / total: 8）——用于判断提取数是否偏离意图。 */
function declaredOverCount(source) {
  const src = String(source || '');
  const patterns = [
    /(?:共|总计|合计|一共|共计|总共)\s*[:：]?\s*(\d{1,4})/,
    /(\d{1,4})\s*(?:个|项|条|处|只|份)\s*(?:入口|文件|页面|接口|路由|端点|参数|漏洞|问题|目标|项)/,
    /\b(?:total|count)\b\s*[:：]?\s*(\d{1,4})/i,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * 从人话正文里提取列表项：项目符号、编号、表格首列、独立成行的 URL/路径。
 * @returns {{items:string[], declaredCount:number|null}} items 已 trim/去重/丢弃 <2 字符
 */
function extractOverItemsFromText(content) {
  const source = String(content == null ? '' : content).replace(/\r\n?/g, '\n');
  const found = [];
  let lastLineWasTableRow = false;
  let hasNumbered = false;
  let maxNumbered = 0;
  const pushRaw = (raw) => {
    const item = cleanOverTextItem(raw);
    if (item) found.push(item);
  };
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('```')) {
      lastLineWasTableRow = false;
      continue;
    }
    // 表格：首列才是条目；分隔行说明上一行是表头，丢掉那条
    if (trimmed.startsWith('|')) {
      if (OVER_TABLE_SEP_RE.test(trimmed)) {
        if (lastLineWasTableRow && found.length) found.pop();
        lastLineWasTableRow = false;
        continue;
      }
      const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
      pushRaw(cells[0] || '');
      lastLineWasTableRow = true;
      continue;
    }
    lastLineWasTableRow = false;
    const bullet = trimmed.match(/^[-*+•·]\s+(.+)$/);
    if (bullet) {
      pushRaw(bullet[1]);
      continue;
    }
    const numbered = trimmed.match(/^(\d{1,3})[.)、]\s+(.+)$/);
    if (numbered) {
      hasNumbered = true;
      maxNumbered = Math.max(maxNumbered, Number(numbered[1]) || 0);
      pushRaw(numbered[2]);
      continue;
    }
    // 独立成行（整行没有空白）的 URL / 路径 / 带扩展名的文件
    if (!/\s/.test(trimmed)) {
      const bare = trimmed.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '');
      const looksPath = /^https?:\/\//i.test(bare)
        || /^\/[^\s]*$/.test(bare)
        || /^\.{1,2}\//.test(bare)
        || new RegExp(`\\.(?:${OVER_TEXT_EXTS})$`, 'i').test(bare);
      if (looksPath) pushRaw(bare);
    }
  }
  const items = [];
  const seen = new Set();
  for (const item of found) {
    const s = item.trim();
    if (s.length < 2 || seen.has(s)) continue;
    seen.add(s);
    items.push(s);
  }
  let declared = declaredOverCount(source);
  // 编号列表本身就是「意图数量」：1..N 编了号却只提取到更少条目，说明有行没吃进来
  if (declared == null && hasNumbered && maxNumbered > items.length) declared = maxNumbered;
  return { items, declaredCount: declared };
}

/** ① JSON（数组 / {items:[...]}）② 代码块 JSON 统一走 parseAgentJson；返回 null 表示不是 JSON 列表。 */
function parseOverJsonItems(value, label) {
  const parsed = parseAgentJson(String(value || ''));
  if (parsed?.error) return null;
  let list = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (isObj(parsed) && Array.isArray(parsed.items)) list = parsed.items;
  if (!list) return null;
  for (const item of list) {
    if (typeof item !== 'string') {
      throw abortScript(t('{label} 的 over 里每项必须是字符串', { label }));
    }
  }
  return list;
}

/** 从上游结果里抽 findings / claims / results 数组（也识别 JSON 正文） */
function aggregateItemsOf(result) {
  if (!result || typeof result !== 'object') return [];
  if (Array.isArray(result.claims) && result.claims.length) return result.claims;
  if (Array.isArray(result.findings) && result.findings.length) return result.findings;
  if (Array.isArray(result.results) && result.results.length) return result.results;
  if (typeof result.content === 'string' && result.content.trim()) {
    const parsed = parseAgentJson(result.content);
    if (!parsed?.error) {
      if (Array.isArray(parsed)) return parsed;
      if (isObj(parsed)) {
        for (const key of ['claims', 'findings', 'results']) {
          if (Array.isArray(parsed[key]) && parsed[key].length) return parsed[key];
        }
      }
    }
  }
  return [];
}

function aggregateGroups(items, by) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const raw = item && typeof item === 'object' ? text(item[by]) : '';
    const key = raw || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * 执行脚本模式工作流。
 * @param {object} opts
 * @param {string} opts.goal
 * @param {Array} opts.script 原始 script 数组
 * @param {Function} opts.callStep 子代理调用（与 steps 模式同一注入点）
 * @param {Function} [opts.runGate] 程序闸执行器 (tool,args,{projectPath}) => result
 * @param {object|null} [opts.journal] 已创建的 journal（不落盘时为 null）
 * @param {object|null} [opts.resumeJournal] 断点 journal（复用判定用）
 * @param {string|null} [opts.dir] journal 落盘目录
 * @param {object} [opts.control] {paused,aborted,maxConcurrency}
 * @param {number} [opts.concurrency] fanout 子节点并发上限（默认 4，clamp 1..14）
 * @param {Function} [opts.onUpdate] 快照推送
 * @returns {Promise<object>} 与 runWorkflow 相同的结果形状（额外带 phases/delivered）
 */
export async function runScriptWorkflow({
  goal = '',
  script,
  callStep,
  runGate = null,
  projectPath = null,
  journal = null,
  resumeJournal = null,
  dir = null,
  control = null,
  concurrency = SCRIPT_DEFAULT_CONCURRENCY,
  onUpdate = null,
  runId = null,
  startedAt = Date.now(),
  verifyTimeoutMs = null,
} = {}) {
  const goalText = text(goal);
  if (!goalText) return { error: t('goal 不能为空（整个工作流要达成的目标）') };
  const norm = normalizeScript(script);
  if (norm.error) return { error: norm.error };
  const modeReason = describeScriptMode(norm);

  const ctl = control && typeof control === 'object' ? control : {};
  // 盲验节点的硬截止（默认 60 分钟；0 = 显式关闭）。其他节点仍不限时。
  const verifyCapMs = resolveVerifyTimeoutMs(verifyTimeoutMs);
  // 并发上限：运行中可改（卡片设置写 ctl.maxConcurrency），否则用传入的 concurrency。
  // 每次 fanout 开始时重新算一次，所以「跑着的时候把并发调高」对后面的 fanout 也生效。
  const limitOf = () => {
    const live = Number(ctl.maxConcurrency);
    const base = Number.isFinite(live) && live > 0 ? live : Number(concurrency);
    const n = Number.isFinite(base) && base > 0 ? Math.trunc(base) : SCRIPT_DEFAULT_CONCURRENCY;
    return Math.min(SCRIPT_MAX_CONCURRENCY, Math.max(1, n));
  };
  const allNodes = norm.nodes.slice();
  // 哪些节点的输出会被后面的 fanout/recurse 当 over 列表消费：这些节点的 prompt 要写清
  // 「必须只输出 JSON 字符串数组」，没做到时为它纠正重试一次（2026-11-11 实测的停机根因）。
  const overRefIds = new Set();
  // fanout/recurse 容器不在 norm.nodes 里（静态字面列表才展开成节点），所以整棵树递归找 overRef
  const collectOverRefs = (v, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 12) return;
    if (Array.isArray(v)) { for (const x of v) collectOverRefs(x, depth + 1); return; }
    const ref = String(v.overRef || '').trim();
    if (ref) overRefIds.add(ref);
    for (const k of Object.keys(v)) collectOverRefs(v[k], depth + 1);
  };
  collectOverRefs(norm);
  const results = new Map();
  const state = new Map();
  const aliasNodes = new Map();
  const phases = [];
  const delivered = [];
  const claimsStore = [];
  const executionOrder = [];
  // 扇出截断：静态展开阶段（字面列表）与运行时（over 引用解析后）都记到这里。
  // 它是「报告必须点名未覆盖项」的数据源，随 out.fanoutTruncations 暴露给 UI/主 agent。
  const truncations = [];
  const truncationWarnings = [];
  // 运行期降级产生的洞（节点/扇出跑到一半出错，被记为 failed 后 run 继续）：
  // 这些必须在 out.warnings 里出现一次，不能只躺在结果行里。
  const runtimeHoleWarnings = [];
  // over 引用不是 JSON、靠文本逐行提取出来的：这是启发式，必须让用户看到「解析出几项」。
  const overWarnings = [];
  const noteOverParsedFromText = (label, resolution) => {
    if (!resolution || resolution.parsedFrom !== 'text') return null;
    const n = resolution.items.length;
    const declared = Number(resolution.declaredCount);
    const mismatch = Number.isFinite(declared) && declared > 0 && declared !== n
      ? t('；文本里写到 {declared} 项，数量对不上', { declared })
      : '';
    const warning = t('从 {ref} 的文本里解析出 {n} 项（{label} 的 over 不是 JSON 字符串数组，按项目符号/编号/表格首列提取，可能含误提取{extra}）', {
      ref: resolution.ref || '?', n, label, extra: mismatch,
    });
    if (!overWarnings.includes(warning)) overWarnings.push(warning);
    return warning;
  };
  const recordTruncation = (rec) => {
    if (!rec || !(rec.skipped > 0)) return;
    if (!truncations.some((x) => x.id === rec.id)) truncations.push(rec);
    const warning = fanoutTruncationWarning(rec);
    if (!truncationWarnings.includes(warning)) truncationWarnings.push(warning);
  };
  const fanoutTruncationsOut = () => truncations.map((rec) => ({ ...rec, skippedItems: rec.skippedItems.slice() }));
  let stopped = false;
  let finalized = false;
  let saveChain = Promise.resolve();
  const gate = typeof runGate === 'function' ? runGate : runGateDefault;
  const effectiveRunId = runId || (journal && journal.runId) || runIdOf();

  const warnJournal = (e) => {
    try { console.warn('[workflow-script] journal 写入失败：' + (e?.message || e)); } catch { /* 忽略 */ }
  };
  const queueJournalSave = () => {
    if (!journal || !dir) return;
    saveChain = saveChain.then(() => saveJournal(journal, { dir })).catch(warnJournal);
  };
  const setState = (id, patch) => {
    state.set(id, { ...(state.get(id) || EMPTY_STATE), ...patch });
  };
  const nodeState = (id) => state.get(id) || EMPTY_STATE;

  const snapshot = (running) => ({
    kind: 'workflow',
    script: true,
    mode: 'script',
    modeReason,
    runId: effectiveRunId,
    goal: goalText,
    running,
    paused: !!ctl.paused,
    startedAt,
    ms: Date.now() - startedAt,
    concurrency: limitOf(),
    phases: phases.map((phase) => phase.slice()),
    steps: allNodes.map((node) => {
      const mine = claimsStore.filter((c) => c.sourceStep === node.id);
      return {
        id: node.id,
        name: node.name,
        role: node.role,
        depends_on: node.depends_on,
        ...nodeState(node.id),
        kind: node.kind || null,
        op: node.opType,
        source: node.program ? 'program' : null,
        claims: mine.length,
        confirmed: mine.filter((c) => c.status === 'confirmed').length,
      };
    }),
  });
  const notify = (running) => { try { onUpdate?.(snapshot(running)); } catch { /* UI 推送失败不影响执行 */ } };

  const waitIfPaused = async () => {
    while (ctl.paused && !ctl.aborted) {
      notify(true);
      await sleep(200);
    }
  };

  const resolveRef = (ref) => {
    if (results.has(ref)) return [ref];
    if (aliasNodes.has(ref)) return aliasNodes.get(ref).filter((id) => results.has(id));
    return [];
  };
  const resolveRefs = (refs) => {
    const out = [];
    for (const ref of Array.isArray(refs) ? refs : [refs]) {
      for (const id of resolveRef(ref)) {
        if (!out.includes(id)) out.push(id);
      }
    }
    return out;
  };
  const resolveSingle = (ref) => {
    const ids = resolveRef(ref);
    return ids.length ? results.get(ids[0]) : null;
  };
  const upstreamOf = (refs) => resolveRefs(refs).map((id) => results.get(id)).filter(Boolean);

  const mergeClaims = (list) => {
    for (const claim of Array.isArray(list) ? list : []) {
      const idx = claimsStore.findIndex((x) => x.id === claim.id);
      if (idx >= 0) claimsStore[idx] = claim;
      else claimsStore.push(claim);
    }
  };

  const ingestVerify = (node, result, content, claimsInput) => {
    const claims = Array.isArray(claimsInput) ? claimsInput : collectClaims(upstreamOf(node.depends_on));
    const parsed = parseAgentJson(content);
    if (parsed?.error) {
      result.parseError = parsed.error;
      return;
    }
    const verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
    result.verdicts = verdicts;
    const updated = applyVerdicts(claims, verdicts, {
      model: result.model || 'default',
      providerId: result.providerId || null,
      stepId: node.id,
    });
    mergeClaims(updated);
    result.claims = updated.map((c) => ({ ...c, verdicts: [...(c.verdicts || [])] }));
    if (!verdicts.length) result.verdictsEmpty = true;
  };

  const buildScriptPrompt = (node, vars) => {
    if (node.kind === 'verify') {
      const upstream = upstreamOf(node.depends_on);
      const claims = collectClaims(upstream);
      // 没有结构化 claims 但有上游正文：也必须盲验，把上游 name+content 拼进任务文本
      const prompt = claims.length
        ? buildSwarmPrompt({
          goal: goalText,
          step: {
            id: node.id,
            name: node.name,
            role: node.role,
            kind: 'verify',
            blind: true,
            prompt: node.prompt,
          },
          upstream,
          claims,
        })
        : buildUpstreamOnlyVerifyPrompt({
          goal: goalText,
          step: { id: node.id, name: node.name, role: node.role, prompt: node.prompt },
          upstream,
        });
      return { prompt, dependsOn: resolveRefs(node.depends_on), claims, upstream };
    }
    if (node.kind === 'report') {
      const dependsOn = resolveRefs(node.depends_on);
      // 自动补的 report 要汇总「本轮所有已执行的 LLM 节点」：loop/recurse 动态展开的子节点
      // 没有可静态引用的 id，但 executionOrder 里有结果，直接补进上游。
      if (node.autoInserted) {
        for (const id of executionOrder) {
          if (dependsOn.includes(id)) continue;
          const row = results.get(id);
          if (!row || row.program || id === node.id) continue;
          dependsOn.push(id);
        }
      }
      const ask = `${interpolateScriptText(node.prompt, vars, results)}\n\n硬规则：${REPORT_ADVERSARIAL_RULE}`;
      const upstream = dependsOn.map((id) => results.get(id)).filter(Boolean);
      let prompt = buildPrompt(
        goalText,
        { id: node.id, name: node.name, role: node.role, prompt: ask, depends_on: dependsOn },
        results
      );
      prompt = appendVerifyConclusions(prompt, upstream);
      // 失败/中断节点的洞清单必须进 report prompt：报告不能只汇总成功分支。
      const holesSection = buildHolesPromptSection(collectHoles(results));
      if (holesSection) prompt = `${prompt}\n\n${holesSection}`;
      // 扇出截断的未覆盖项也必须进 prompt：否则报告会把「只跑了 20 项」写成「全部覆盖」。
      const truncationSection = buildTruncationPromptSection(truncations);
      if (truncationSection) prompt = `${prompt}\n\n${truncationSection}`;
      prompt = `${prompt}\n\n${DELIVERY_DISCIPLINE}`;
      return { prompt, dependsOn };
    }
    const dependsOn = resolveRefs(node.depends_on);
    const promptText = interpolateScriptText(node.prompt, vars, results);
    // 输出契约：下游要按数组扇出，必须提前说清，不能让模型「交一段人话」再让引擎去猜
    const contract = overRefIds.has(node.id) ? OVER_ARRAY_CONTRACT : '';
    const prompt = `${buildPrompt(
      goalText,
      { id: node.id, name: node.name, role: node.role, prompt: promptText, depends_on: dependsOn },
      results
    )}\n\n${DELIVERY_DISCIPLINE}${contract}`;
    return { prompt, dependsOn };
  };

  const tryReuse = (node) => {
    if (!resumeJournal || !resumeJournal.steps || typeof resumeJournal.steps !== 'object') return null;
    const entry = resumeJournal.steps[node.id];
    if (!entry || entry.status !== 'success' || !String(entry.content || '').trim()) return null;
    // report 复用前必须按本次运行的洞重跑 lint：旧报告漏点本次失败节点时禁止复用，
    // 交给 executeNode 重跑（prompt 会带上完整洞清单），否则 resume 会绕过 report 闸。
    const accept = (candidate) => {
      if (node.kind !== 'report') return candidate;
      const holeList = collectHoles(results);
      const warnings = lintReport(clipStoredContent(String(candidate.content || '')), { holes: holeList });
      return warnings.length ? null : candidate;
    };
    // 依赖必须是本次运行已经执行/复用的节点；分支没走时旧记录不能拿来复用
    for (const dep of node.depends_on) {
      if (results.has(dep)) continue;
      if (aliasNodes.has(dep) && aliasNodes.get(dep).every((id) => results.has(id))) continue;
      return null;
    }
    const steps = allNodes.some((x) => x.id === node.id) ? allNodes.slice() : [...allNodes, node];
    const byId = new Map(steps.map((x) => [x.id, x]));
    // 别名依赖（fanout/if 的非节点 id）不在 byId 里：先按 hash + 展开后的子节点状态判定
    if (node.depends_on.some((dep) => !byId.has(dep))) {
      if (String(entry.hash || '') !== stepHash(goalText, node)) return null;
      for (const dep of node.depends_on) {
        if (results.get(dep)?.ok) continue;
        if (aliasNodes.has(dep) && aliasNodes.get(dep).every((id) => results.get(id)?.ok)) continue;
        return null;
      }
      return accept(entry);
    }
    const reuseInfo = computeReuse(resumeJournal, { steps, byId }, goalText);
    if (!reuseInfo.reusable.has(node.id)) return null;
    return accept(entry);
  };

  const restoreNode = async (node, entry) => {
    const content = clipStoredContent(String(entry.content || ''));
    const fullOutputPath = await existingNodeOutputPath(dir, effectiveRunId, node.id);
    const ms = Number.isFinite(Number(entry.ms)) ? Number(entry.ms) : 0;
    const tools = Number.isFinite(Number(entry.tools)) ? Number(entry.tools) : 0;
    const stepStartedAt = Number.isFinite(Number(entry.startedAt)) ? Number(entry.startedAt) : null;
    setState(node.id, { status: 'success', reused: true, startedAt: stepStartedAt, ms, error: null, tools });
    const result = {
      id: node.id,
      name: node.name,
      role: node.role,
      depends_on: node.depends_on,
      ok: true,
      error: null,
      content,
      ms,
      tools,
      truncated: false,
      warnings: [],
      reused: true,
      kind: node.kind || null,
      model: null,
      providerId: null,
      op: node.opType,
      ...(fullOutputPath ? { fullOutputPath } : {}),
      ...(node.program ? { source: 'program', verified: true, ...(node.tool ? { gate: node.tool } : {}) } : {}),
      ...(node.autoInserted ? { autoInserted: true } : {}),
    };
    if (node.kind === 'report') {
      // 复用也要重跑本次洞清单的 lint：不能靠旧 journal 把漏点的报告直接算交付。
      const holeList = collectHoles(results);
      result.holes = holeList.map((h) => h.id);
      result.reportWarnings = lintReport(content, { holes: holeList });
      result.reportLintOk = result.reportWarnings.length === 0;
      result.delivered = result.ok && result.reportLintOk;
    }
    if (node.programType === 'aggregate') {
      const parsed = parseAgentJson(content);
      if (!parsed?.error && isObj(parsed)) {
        result.groups = parsed.groups || [];
        result.top = parsed.top || [];
      }
    }
    if (node.programType === 'loop') {
      const parsed = parseAgentJson(content);
      if (!parsed?.error && isObj(parsed)) {
        result.rounds = parsed.rounds;
        result.matched = parsed.matched;
      }
    }
    if (node.programType === 'recurse') {
      const parsed = parseAgentJson(content);
      if (!parsed?.error && isObj(parsed)) Object.assign(result, parsed);
    }
    results.set(node.id, result);
    executionOrder.push(node.id);
    if (node.kind === 'verify') ingestVerify(node, result, content);
    if (node.kind === 'report' && result.delivered) delivered.push(node.id);
    notify(true);
    return result;
  };

  const recordNode = (node, result, startedAtMs) => {
    if (!journal || !dir || finalized) return;
    const status = result.ok ? 'success' : 'failed';
    recordStep(journal, node, {
      hash: stepHash(goalText, node),
      status,
      content: String(result.content || ''),
      error: result.error || null,
      errorCode: result.errorCode || null,
      ms: result.ms || 0,
      tools: result.tools || 0,
      startedAt: startedAtMs,
      finishedAt: Date.now(),
      depends_on: node.depends_on,
    });
    queueJournalSave();
  };

  // 运行期降级：某个节点/扇出出错时记成「洞」（failed + hole），让 run 继续跑完其余节点。
  // 之前的行为是 throw abortScript → 整条 run 立刻结束，用户只看到一句错误、前面的结果全白跑。
  // 洞会被 collectHoles 收进 report prompt，报告闸要求在 ## Not covered 点名，不会静默跳过。
  const degradeToHole = (node, { error, errorCode = 'STEP_FAIL', phaseIds = null } = {}) => {
    const id = String(node?.id || '').trim();
    if (!id) return null;
    const message = String(error || t('节点执行失败'));
    const known = allNodes.find((x) => x.id === id);
    if (!known) {
      // 容器（fanout/if）本身不是节点：补一条可见的失败条目，快照/报告里才看得到
      allNodes.push({
        id,
        name: node?.name || id,
        role: node?.role || '',
        prompt: '',
        depends_on: Array.isArray(node?.depends_on) ? node.depends_on.slice() : [],
        program: true, // 引擎降级：不再交给模型判定
        opType: node?.opType || node?.kind || null,
        programType: node?.programType || null,
      });
    }
    const startedAtMs = Date.now();
    const result = {
      id,
      name: (known || node)?.name || id,
      role: (known || node)?.role || '',
      depends_on: Array.isArray(node?.depends_on) ? node.depends_on.slice() : [],
      ok: false,
      error: message,
      errorCode,
      content: '',
      ms: 0,
      tools: 0,
      toolCount: 0,
      truncated: false,
      warnings: [message],
      reused: false,
      kind: (known || node)?.kind || null,
      model: null,
      providerId: null,
      op: (known || node)?.opType || node?.opType || null,
      hole: true,
      degraded: true, // 引擎侧降级（不是模型失败）：UI 可据此区分
    };
    results.set(id, result);
    if (!executionOrder.includes(id)) executionOrder.push(id);
    setState(id, {
      status: 'failed',
      reused: false,
      startedAt: startedAtMs,
      ms: 0,
      error: message,
      errorCode,
      tools: 0,
      toolCount: 0,
      warnings: [message],
      hole: true,
      degraded: true,
    });
    if (Array.isArray(phaseIds) && !phaseIds.includes(id)) phaseIds.push(id);
    if (!runtimeHoleWarnings.includes(message)) runtimeHoleWarnings.push(message);
    try { recordNode(known || node, result, startedAtMs); } catch { /* journal 记录失败不影响继续跑 */ }
    notify(true);
    return result;
  };

  const executeNode = async (node, { vars = {}, phaseIds = [], deferOrder = false } = {}) => {
    if (ctl.aborted) {
      stopped = true;
      return null;
    }
    const reused = tryReuse(node);
    if (reused) return restoreNode(node, reused);
    await waitIfPaused();
    if (ctl.aborted) {
      stopped = true;
      return null;
    }
    // 自动补验：没有结构化 claim 时，只要上游还有非空正文就必须跑盲验红队；
    // 只有「上游全空 + 无 claims」才允许跳过（不浪费一次调用）。
    if (node.autoInserted && String(node.kind || '').toLowerCase() === 'verify') {
      const sourceIds = resolveRefs(node.depends_on);
      const upstream = sourceIds.map((id) => results.get(id)).filter(Boolean);
      const claims = collectClaims(upstream);
      const swarmAware = sourceIds.some((id) => /#\d+$/.test(id) || /\.d\d+\.i\d+\./.test(id));
      // 旧式 step 虽然没走 verify，但产出了 findings：也要进 claim 池，让报告闸按「未复核」处理
      if (claims.length && !swarmAware) mergeClaims(claims);
      const hasUpstreamText = upstream.some((r) => String(r.content || '').trim() && !r.salvaged);
      if (!claims.length && !hasUpstreamText) {
        setState(node.id, { status: 'success', reused: false, skipped: true, startedAt: null, ms: 0, error: null, tools: 0 });
        notify(true);
        return { id: node.id, ok: true, skipped: true };
      }
    }

    const startedAtMs = Date.now();
    setState(node.id, { status: 'running', reused: false, startedAt: startedAtMs, ms: null, error: null, tools: 0 });
    notify(true);

    let out;
    let built = null;
    if (node.program) {
      try {
        if (node.programType === 'gate') {
          out = await gate(node.tool, node.args || {}, { projectPath });
        } else {
          out = await runProgramNode(node, { phaseIds, vars });
        }
      } catch (e) {
        if (e?.scriptAbort) throw e;
        out = { error: e?.message || t('程序节点执行失败') };
      }
    } else {
      built = buildScriptPrompt(node, vars);
      if (typeof callStep !== 'function') {
        out = { error: t('当前通道不支持子代理调用') };
      } else {
        try {
          out = await callStep({
            id: node.id,
            name: node.name,
            role: node.role,
            prompt: built.prompt,
            depends_on: built.dependsOn || node.depends_on,
            runId: effectiveRunId, // 子代理 transcript 按 run 落盘
            // 盲验节点默认 60 分钟硬截止（可配）；其余节点 budget=null → 不设墙钟
            budget: node.kind === 'verify' ? { maxStepMs: verifyCapMs } : null,
            kind: node.kind || null,
            model: null,
            providerId: null,
            blind: node.kind === 'verify' ? true : null,
          });
        } catch (e) {
          out = { error: e?.message || t('子代理调用失败') };
        }
      }
    }

    // over 引用节点的输出形状不对（交的是人话）→ 给一次「只输出 JSON 数组」的纠正重试。
    // 仍然不对时不动 content：下游 resolveOverList 会先尝试文本提取，再不行才降级成洞。
    if (!node.program && overRefIds.has(node.id) && typeof callStep === 'function') {
      const first = String(out?.content || '').trim();
      if (first && !isStrictOverArray(first)) {
        try {
          const retry = await callStep({
            id: node.id,
            name: node.name,
            role: node.role,
            prompt: `${built.prompt}

【上一次输出不合格】你的正文不是 JSON 字符串数组，下游无法扇出。现在只输出一个 JSON 字符串数组，不要任何解释或标题。`,
            depends_on: built.dependsOn || node.depends_on,
            runId: effectiveRunId,
            budget: null,
            kind: node.kind || null,
            model: null,
            providerId: null,
            blind: node.kind === 'verify' ? true : null,
          });
          const retryText = String(retry?.content || '').trim();
          if (isStrictOverArray(retryText)) {
            overWarnings.push(t('{id}：首次输出不是 JSON 数组，已用一次纠正重试拿到列表（{n} 项）', { id: node.id, n: retryText ? (JSON.parse(retryText).length || 0) : 0 }));
            out = {
              ...retry,
              toolCount: (Number(out?.toolCount) || 0) + (Number(retry?.toolCount) || 0),
              warnings: [
                ...(Array.isArray(out?.warnings) ? out.warnings : []),
                t('{id}：首次输出不是 JSON 数组，已用一次纠正重试拿到列表', { id: node.id }),
              ],
            };
          }
        } catch (e) {
          out = { ...(out || {}), warnings: [...(Array.isArray(out?.warnings) ? out.warnings : []), t('{id}：JSON 数组纠正重试失败（{error}）', { id: node.id, error: e?.message || e })] };
        }
      }
    }

    const rawContent = node.program
      ? (typeof out === 'string' ? out : JSON.stringify(out ?? null))
      : String(out?.content || '').trim();
    let content = String(rawContent || '').trim();
    const originalEmpty = !content;
    const ms = Date.now() - startedAtMs;
    const toolCountKnown = typeof out?.toolCount === 'number' && Number.isFinite(out.toolCount);
    const toolCount = toolCountKnown ? Math.max(0, Math.trunc(out.toolCount)) : 0;
    const warnings = Array.isArray(out?.warnings) ? out.warnings.map(String) : [];
    const truncated = !!out?.truncated;
    const aborted = !node.program && (!!out?.cancelled || !!out?.interrupted || String(out?.errorCode || '').trim() === 'INTERRUPTED');
    let salvaged = false;
    let salvageReason = null;
    // 失败节点不能只剩一个 error：中断/空回复用 transcript 做确定性 salvage（不调模型）。
    if (!node.program && (!content || isSalvageText(content) || out?.salvaged)) {
      const alreadySalvaged = isSalvageText(content);
      if (!alreadySalvaged) {
        content = salvageSubagentContent({
          transcript: out?.transcript,
          toolCount,
          reason: aborted ? 'aborted' : 'empty',
          partialContent: content,
          error: out?.error || '',
        });
      }
      salvaged = true;
      salvageReason = aborted ? 'aborted' : 'empty';
    }
    let ok;
    let error;
    let requiresTools = false;
    if (node.program) {
      ok = !out?.error && !!content;
      error = out?.error || (content ? null : t('程序节点没有返回结果'));
    } else {
      requiresTools = needsEvidence({
        kind: node.kind || null,
        name: node.name,
        role: node.role,
        prompt: node.template || node.prompt,
      });
      const judged = judgeSubagentOutcome({
        kind: node.kind,
        content,
        toolCount,
        toolCountKnown,
        truncated,
        requiresTools,
      });
      // 中断/空回复即使 salvage 出了正文，也必须失败（ok 不能翻绿）
      ok = !out?.error && !originalEmpty && judged.ok && !aborted;
      error = out?.error || judged.error || (originalEmpty ? t('子代理没有返回内容') : null);
      if (aborted) error = out?.error || t('子代理被中断');
    }
    // 结构化错误码：只在失败节点上产出（成功节点为 null），随快照/结果行/报告透传给 UI 与主 agent
    const errorCode = ok ? null : (
      aborted
        ? 'INTERRUPTED'
        : (String(out?.errorCode || '').trim() || deriveNodeErrorCode({
          program: !!node.program,
          errorText: out?.error || '',
          // 用原始正文判定：salvage 正文不能让 EMPTY_CONTENT 变成 STEP_FAIL
          content: rawContent,
          toolCount,
          toolCountKnown,
          truncated,
          requiresTools,
        }))
    );
    // 完整正文先落盘（dir = workflow-runs 根；拿不到 runId/写盘失败静默跳过），
    // 内存只留 MAX_STORED_CONTENT 字并带截断标记；下游按 fullOutputPath 读全文。
    const fullOutputPath = await writeNodeOutput(dir, effectiveRunId, node.id, content);
    const storedContent = clipStoredContent(content);

    setState(node.id, {
      status: ok ? 'success' : 'failed',
      reused: false,
      startedAt: startedAtMs,
      ms,
      error,
      errorCode,
      tools: toolCount,
      toolCount,
      finishReason: out?.finishReason || null,
      roundsUsed: Number.isFinite(out?.roundsUsed) ? out.roundsUsed : null,
      truncated,
      warnings,
      ...(salvaged ? { salvaged: true, salvageReason } : {}),
      ...(ok ? {} : { hole: true }),
    });

    const result = {
      id: node.id,
      name: node.name,
      role: node.role,
      depends_on: node.depends_on,
      ok,
      error,
      errorCode,
      content: storedContent,
      ms,
      tools: toolCount,
      toolCount,
      finishReason: out?.finishReason || null,
      roundsUsed: Number.isFinite(out?.roundsUsed) ? out.roundsUsed : null,
      truncated: !!out?.truncated,
      warnings,
      reused: false,
      kind: node.kind || null,
      model: String(out?.model || '') || null,
      providerId: String(out?.providerId || '') || null,
      op: node.opType,
      ...(fullOutputPath ? { fullOutputPath } : {}),
      ...(salvaged ? { salvaged: true, salvageReason } : {}),
      ...(ok ? {} : { hole: true }),
      ...(node.program ? { source: 'program', verified: true, ...(node.tool ? { gate: node.tool } : {}) } : {}),
      ...(node.autoInserted ? { autoInserted: true } : {}),
    };
    if (node.programType === 'aggregate' && isObj(out)) {
      result.groups = out.groups || [];
      result.top = out.top || [];
      result.total = Number(out.total) || 0;
    }
    if (node.programType === 'loop' && isObj(out)) {
      result.rounds = out.rounds;
      result.matched = !!out.matched;
    }
    if (node.programType === 'recurse' && isObj(out)) {
      result.branches = out.branches;
      result.stopWhenMatched = out.stopWhenMatched;
      result.depthLimited = out.depthLimited;
    }
    if (node.kind === 'report') {
      const holeList = collectHoles(results);
      result.holes = holeList.map((h) => h.id);
      result.reportWarnings = lintReport(content, { holes: holeList });
      result.reportLintOk = result.reportWarnings.length === 0;
      // 报告正文即使 lint 不通过也保留（始终可读）；但 lint 失败不算交付成功。
      result.delivered = ok && result.reportLintOk;
    }
    if (node.kind === 'verify' && ok) ingestVerify(node, result, content, built?.claims);
    results.set(node.id, result);
    if (!deferOrder) executionOrder.push(node.id);
    if (node.kind === 'report' && result.delivered) delivered.push(node.id);
    recordNode(node, result, startedAtMs);
    notify(true);
    return result;
  };

  const knownNode = (node) => {
    if (!allNodes.some((x) => x.id === node.id)) allNodes.push(node);
    return node;
  };

  const resolveOverList = (label, rawRef) => {
    const resolveFromContent = (content) => {
      const json = parseOverJsonItems(content, label);
      if (json) return { items: json, parsedFrom: 'json' };
      const extracted = extractOverItemsFromText(content);
      if (extracted.items.length) {
        return { items: extracted.items, parsedFrom: 'text', declaredCount: extracted.declaredCount };
      }
      return null;
    };
    const raw = String(rawRef ?? '');
    let target = resolveSingle(raw);
    if (!target && raw.includes('${')) {
      const interpolated = interpolateScriptText(raw, {}, results);
      const direct = resolveFromContent(interpolated);
      if (direct) return { ...direct, ref: raw };
      target = resolveSingle(interpolated);
      if (!target) throw abortScript(t('{label} 的 over 引用不存在：{ref}', { label, ref: interpolated }));
    }
    if (!target) throw abortScript(t('{label} 的 over 引用不存在：{ref}', { label, ref: raw }));
    const resolved = resolveFromContent(target.content);
    if (!resolved) {
      const op = String(label).trim().split(/\s+/)[0] || 'fanout';
      throw abortScript(t('over 引用 {ref} 没有解析出列表：让 {ref} 输出 JSON 字符串数组（或每行一项），或在 {op} 里直接写 over:[...]', {
        ref: raw, op,
      }));
    }
    return { ...resolved, ref: raw };
  };

  const runFanout = async (container, phaseIds, vars) => {
    if (ctl.aborted) {
      stopped = true;
      return;
    }
    const overResolution = container.overRef
      ? resolveOverList(`fanout ${container.id}`, container.overRef)
      : { items: container.overItems || [], parsedFrom: 'script' };
    const allItems = overResolution.items;
    const overTextWarning = noteOverParsedFromText(`fanout ${container.id}`, overResolution);
    const overParsedFrom = overResolution.parsedFrom === 'text' ? 'text' : null;
    if (allItems.length > SCRIPT_MAX_FANOUT) {
      throw abortScript(t('fanout {id} 的 over 最多 {max} 项（当前 {n}）', { id: container.id, max: SCRIPT_MAX_FANOUT, n: allItems.length }));
    }
    // 字面列表已在静态展开阶段截断；over 引用只能在运行时知道长度，这里同样按 limit 截断。
    const limit = Number.isInteger(container.limit) && container.limit > 0 ? container.limit : SCRIPT_DEFAULT_FANOUT_LIMIT;
    const items = allItems.slice(0, Math.min(limit, allItems.length));
    let truncation = container.truncation || null;
    if (!truncation && allItems.length > items.length) {
      truncation = makeFanoutTruncation({
        id: container.id,
        total: allItems.length,
        limit: items.length,
        skippedItems: allItems.slice(items.length),
      });
    }
    recordTruncation(truncation);
    let children;
    if (container.overItems) {
      children = container.children;
    } else {
      const existingIds = new Set(allNodes.map((x) => x.id));
      children = items.map((item, index) => {
        const child = makeFanoutChild(container, item, index);
        if (existingIds.has(child.id)) throw abortScript(t('节点 id 重复：{id}', { id: child.id }));
        existingIds.add(child.id);
        knownNode(child);
        return child;
      });
    }
    if (allNodes.length > SCRIPT_MAX_NODES) {
      throw abortScript(t('脚本节点最多 {max} 个（当前 {n}）', { max: SCRIPT_MAX_NODES, n: allNodes.length }));
    }
    // 子节点之间互不依赖：并发跑（秒级池），别把每个子代理的 2-6 分钟串行相加。
    // phaseIds 在「起跑时」按 index 顺序占位，所以阶段轨道顺序稳定、alias 仍取最后一个子节点；
    // 单个子节点失败不影响兄弟节点（和原来串行语义一致：只有停止/中断才不再起新的）。
    const childIds = [];
    const childVars = (child) => ({ ...vars, [container.as]: child.item });
    const parallelism = Math.min(children.length, limitOf());
    if (parallelism <= 1) {
      for (const child of children) {
        const ran = await executeNode(child, { vars: childVars(child), phaseIds });
        if (!ran) break;
        childIds.push(child.id);
        phaseIds.push(child.id);
      }
    } else {
      const slots = new Array(children.length);
      let cursor = 0;
      const worker = async () => {
        while (!stopped && !ctl.aborted) {
          const index = cursor;
          cursor += 1;
          if (index >= children.length) return;
          const child = children[index];
          phaseIds.push(child.id);
          const ran = await executeNode(child, { vars: childVars(child), phaseIds, deferOrder: true });
          if (!ran) return;
          slots[index] = child.id;
        }
      };
      await Promise.all(Array.from({ length: parallelism }, () => worker()));
      // 并发完成的先后不确定：结果序按 index 落回 executionOrder（嵌套分支节点保持原位）
      for (const id of slots) {
        if (!id) continue;
        childIds.push(id);
        if (!executionOrder.includes(id)) executionOrder.push(id);
      }
    }
    aliasNodes.set(container.id, childIds);
    // over 是文本解析出来的：每个子节点结果/快照都带 overParsedFrom，UI/主 agent 能看出
    // 「这些条目不是上游给的 JSON」，同时把「解析出 N 项」的 warning 挂到子节点上。
    if (overParsedFrom) {
      for (const id of childIds) {
        const row = results.get(id);
        if (row && !row.overParsedFrom) row.overParsedFrom = overParsedFrom;
        const st = state.get(id) || EMPTY_STATE;
        const list = Array.isArray(st.warnings) ? st.warnings : [];
        setState(id, {
          overParsedFrom,
          ...(overTextWarning && !list.includes(overTextWarning) ? { warnings: [...list, overTextWarning] } : {}),
        });
      }
    }
    // 截断事实同时挂到每个子节点结果与快照上：UI 卡片就能看到「共 32、只跑 20」，
    // 不必等整轮结束去翻 out.warnings。
    if (truncation) {
      const compact = { id: truncation.id, total: truncation.total, limit: truncation.limit, skipped: truncation.skipped };
      const warning = fanoutTruncationWarning(truncation);
      for (const id of childIds) {
        const row = results.get(id);
        if (row && !row.fanoutTruncated) row.fanoutTruncated = { ...compact };
        const st = state.get(id) || EMPTY_STATE;
        const list = Array.isArray(st.warnings) ? st.warnings : [];
        if (!list.includes(warning)) setState(id, { warnings: [...list, warning] });
      }
    }
  };

  const resolveBranchTarget = (ref, aliases, branchPhase) => {
    const mapped = aliases && aliases.has(ref) ? aliases.get(ref) : ref;
    const direct = resolveSingle(mapped);
    if (direct) return direct;
    return branchPhase.length ? results.get(branchPhase[branchPhase.length - 1]) : null;
  };

  const compileRecurseBody = (node, depth, index) => {
    const prefix = `${node.id}.d${depth}.i${index}`;
    const ctx = {
      topLevel: false,
      forceDerived: true,
      prefix,
      depth: node.baseDepth,
      label: prefix,
      scope: new Set(node.outerScope),
      aliases: new Set(node.outerAliases),
      fanoutBases: new Set(node.outerFanoutBases),
      allIds: new Set(allNodes.map((x) => x.id)),
      nodesCounted: { n: allNodes.length },
      bodyAliases: new Map(),
      bodyNodeIds: new Set(),
      containerDeps: new Set(),
    };
    const items = [];
    const nodes = [];
    const error = walkOps(node.bodyOp, ctx, items, nodes);
    if (error) throw abortScript(error);
    if (ctx.nodesCounted.n > SCRIPT_MAX_NODES) {
      throw abortScript(t('脚本节点最多 {max} 个（当前 {n}）', { max: SCRIPT_MAX_NODES, n: ctx.nodesCounted.n }));
    }
    for (const child of nodes) allNodes.push(child);
    return { items, aliases: ctx.bodyAliases };
  };

  const runRecurseBranch = async (node, depth, index, item, phaseIds, vars, summary, seqOfDepth) => {
    if (stopped || ctl.aborted) {
      stopped = true;
      return;
    }
    summary.branches += 1;
    let spec = null;
    if (depth === 1 && node.level1 && node.level1[index]) {
      spec = node.level1[index];
    } else {
      spec = compileRecurseBody(node, depth, index);
    }
    const branchVars = { ...vars, [node.as]: item };
    const start = phaseIds.length;
    for (const bodyItem of spec.items) {
      await runItem(bodyItem, phaseIds, branchVars);
      if (stopped || ctl.aborted) break;
    }
    if (stopped || ctl.aborted) return;
    const branchPhase = phaseIds.slice(start);
    const last = branchPhase.length ? results.get(branchPhase[branchPhase.length - 1]) : null;
    if (node.stopWhen) {
      const target = resolveBranchTarget(node.stopWhen.ref, spec.aliases, branchPhase);
      if (matchScriptCondition(node.stopWhen, target)) {
        summary.stopWhenMatched += 1;
        return;
      }
    }
    if (!last || !last.ok) return;
    const next = parseStringList(last.content);
    if (!next || !next.length) return;
    if (depth >= node.maxDepth) {
      summary.depthLimited += 1;
      return;
    }
    for (const nextItem of next) {
      const childIndex = seqOfDepth(depth + 1);
      await runRecurseBranch(node, depth + 1, childIndex, nextItem, phaseIds, vars, summary, seqOfDepth);
      if (stopped || ctl.aborted) break;
    }
  };

  const runRecurseNode = async (node, phaseIds, vars) => {
    const summary = { branches: 0, stopWhenMatched: 0, depthLimited: 0, maxDepth: node.maxDepth };
    const overResolution = node.overRef
      ? resolveOverList(`recurse ${node.id}`, node.overRef)
      : { items: node.overItems || [], parsedFrom: 'script' };
    noteOverParsedFromText(`recurse ${node.id}`, overResolution);
    const items = overResolution.items;
    const seq = new Map();
    seq.set(1, items.length);
    const seqOfDepth = (depth) => {
      const n = seq.get(depth) || 0;
      seq.set(depth, n + 1);
      return n;
    };
    for (let index = 0; index < items.length; index += 1) {
      await runRecurseBranch(node, 1, index, items[index], phaseIds, vars, summary, seqOfDepth);
      if (stopped || ctl.aborted) break;
    }
    return summary;
  };

  const runLoopNode = async (node, phaseIds, vars) => {
    let roundsRun = 0;
    let matched = false;
    for (const spec of node.rounds) {
      if (stopped || ctl.aborted) {
        stopped = true;
        break;
      }
      roundsRun += 1;
      const start = phaseIds.length;
      for (const bodyItem of spec.items) {
        await runItem(bodyItem, phaseIds, vars);
        if (stopped || ctl.aborted) break;
      }
      if (stopped || ctl.aborted) break;
      const target = resolveBranchTarget(node.until.ref, spec.aliases, phaseIds.slice(start));
      if (matchScriptCondition(node.until, target)) {
        matched = true;
        break;
      }
    }
    if (stopped || ctl.aborted) {
      return { error: t('工作流已停止'), rounds: roundsRun, matched: false, maxRounds: node.maxRounds };
    }
    if (!matched) {
      return { error: t('循环达到上限仍不满足条件'), rounds: roundsRun, matched: false, maxRounds: node.maxRounds };
    }
    return { rounds: roundsRun, matched: true, maxRounds: node.maxRounds };
  };

  const runProgramNode = async (node, { phaseIds = [], vars = {} } = {}) => {
    if (node.programType === 'aggregate') {
      const items = [];
      for (const result of upstreamOf(node.depends_on)) items.push(...aggregateItemsOf(result));
      const groups = aggregateGroups(items, node.by);
      const top = groups.slice(0, node.top || SCRIPT_AGGREGATE_TOP_DEFAULT);
      return { groups, top, total: items.length };
    }
    if (node.programType === 'loop') return runLoopNode(node, phaseIds, vars);
    if (node.programType === 'recurse') return runRecurseNode(node, phaseIds, vars);
    return { error: t('未知程序节点类型：{type}', { type: node.programType }) };
  };

  const runItem = async (item, phaseIds, vars = {}) => {
    if (stopped || ctl.aborted) {
      stopped = true;
      return;
    }
    if (item.kind === 'node') {
      if (ctl.aborted) {
        stopped = true;
        return;
      }
      const autoVerify = item.node.autoInserted && String(item.node.kind || '').toLowerCase() === 'verify';
      // 自动补验被跳过（无可复核 claim）时不占用阶段轨道
      if (!autoVerify) phaseIds.push(item.node.id);
      const ran = await executeNode(item.node, { phaseIds, vars });
      if (autoVerify && ran && !ran.skipped) phaseIds.push(item.node.id);
      return;
    }
    if (item.kind === 'fanout') {
      await runFanout(item, phaseIds, vars);
      return;
    }
    if (item.kind === 'if') {
      const target = resolveSingle(item.when.ref);
      const matched = matchScriptCondition(item.when, target);
      const branch = matched ? item.then : item.else;
      const branchIds = [];
      for (const branchItem of Array.isArray(branch) ? branch : []) {
        await runItem(branchItem, branchIds, vars);
        if (stopped || ctl.aborted) break;
      }
      aliasNodes.set(item.id, branchIds);
      phaseIds.push(...branchIds);
      notify(true);
    }
  };

  let fatal = null;
  notify(true);
  try {
    for (const item of norm.items) {
      if (ctl.aborted) {
        stopped = true;
        break;
      }
      const phaseIds = [];
      phases.push(phaseIds);
      try {
        await runItem(item, phaseIds, {});
      } catch (e) {
        // 结构性校验（未知 op / 缺 id / 终局缺失 / 字面列表超限）在 normalizeScript 阶段已拦；
        // 跑到这里的错误都是「运行期」的（上游数据形状不对、动态递归体、节点上限…），
        // 一律降级为洞并继续跑后面的 op —— 一条分支出问题不该让整条 run 白跑。
        const target = item.kind === 'node' ? item.node : item;
        degradeToHole(target, {
          error: e?.message || t('节点执行失败'),
          errorCode: 'STEP_FAIL',
          phaseIds,
        });
      }
      if (!phaseIds.length) phases.pop(); // 自动补验被跳过时不留下空阶段
      if (stopped) break;
    }
  } catch (e) {
    fatal = e?.scriptAbort ? String(e.message || e) : t('脚本执行失败：{message}', { message: e?.message || e });
    if (ctl.aborted) stopped = true;
  }
  // 用户点了停止就算「已停止」：即使中断发生在单个节点跑到一半（那一步会记 failed/已中断）
  if (ctl.aborted) stopped = true;

  // journal 收尾：即使后面有节点失败/脚本中止，已写记录的 report 也保留
  const finishedAt = Date.now();
  if (journal && dir) {
    finalized = true;
    journal.finishedAt = finishedAt;
    journal.stopped = !!stopped;
    await saveChain;
  }

  const linted = lintClaims(claimsStore);
  const adversarialGate = applyAdversarialGate({
    claims: linted.claims,
    results: executionOrder.map((id) => results.get(id)).filter(Boolean),
    verifySteps: allNodes.filter((node) => String(node.kind || '').toLowerCase() === 'verify'),
  });
  claimsStore.length = 0;
  claimsStore.push(...adversarialGate.claims);
  const claimWarnings = linted.warnings;
  const warnings = [...truncationWarnings, ...overWarnings, ...runtimeHoleWarnings, ...claimWarnings, ...adversarialGate.warnings];
  let claimsFile = null;
  if (dir && claimsStore.length) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const target = path.join(dir, `${effectiveRunId}.claims.jsonl`);
      await fs.writeFile(target, claimsToJsonl(claimsStore), 'utf8');
      claimsFile = target;
    } catch (e) {
      warnJournal(e);
    }
  }

  notify(false);
  if (fatal) {
    return { error: fatal, runId: effectiveRunId, goal: goalText, stopped, warnings, fanoutTruncations: fanoutTruncationsOut() };
  }

  const ordered = executionOrder.map((id) => results.get(id)).filter(Boolean);
  for (const row of ordered) {
    if (String(row?.kind || row?.op || '').toLowerCase() !== 'report' || !row.ok || !row.content) continue;
    row.content = appendAdversarialReportNote(row.content, adversarialGate.unreviewed);
  }
  return {
    runId: effectiveRunId,
    goal: goalText,
    script: true,
    mode: 'script',
    modeReason,
    steps: allNodes.map((node) => ({
      id: node.id,
      name: node.name,
      role: node.role,
      depends_on: node.depends_on,
      op: node.opType,
      ...(node.kind ? { kind: node.kind } : {}),
      ...(node.program ? { source: 'program' } : {}),
      ...(node.autoInserted ? { autoInserted: true, ...(node.fromRefs ? { from: node.fromRefs.slice() } : {}) } : {}),
    })),
    results: ordered,
    ok: ordered.every((r) => r.ok),
    stopped,
    ms: Date.now() - startedAt,
    phases: phases.map((phase) => phase.slice()),
    claims: claimsStore.map((c) => ({ ...c, verdicts: [...(c.verdicts || [])] })),
    claimWarnings,
    warnings,
    fanoutTruncations: fanoutTruncationsOut(),
    claimsFile,
    delivered: delivered.slice(),
    summary: ordered.map((r) => {
      if (r.ok) return t('{id} {name}: 完成', { id: r.id, name: r.name });
      // 失败行带结构化错误码 + 一句人话（HTTP 429 · 网关限流…）；旧结果没有 errorCode 时回落到原始 error
      return r.errorCode
        ? t('{id} {name}: 失败（{code} · {label}）', { id: r.id, name: r.name, code: r.errorCode, label: errorCodeLabel(r.errorCode) })
        : t('{id} {name}: 失败（{error}）', { id: r.id, name: r.name, error: r.error });
    }).join('\n'),
  };
}
