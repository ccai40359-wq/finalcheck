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
import { ADVERSARIAL_VERIFY_ID, ADVERSARIAL_VERIFY_NAME, ADVERSARIAL_VERIFY_PROMPT, ADVERSARIAL_VERIFY_ROLE, applyAdversarialGate, appendAdversarialReportNote, buildPrompt, computeReuse, judgeSubagentOutcome, needsEvidence, stepHash } from './workflow.mjs';
import { REPORT_ADVERSARIAL_RULE, applyVerdicts, buildSwarmPrompt, claimsToJsonl, collectClaims, deriveNodeErrorCode, errorCodeLabel, lintClaims, lintReport, parseAgentJson } from './swarm.mjs';
import { DELIVERY_DISCIPLINE } from './swarm.mjs';
import { buildHolesPromptSection, collectHoles, isSalvageText, salvageSubagentContent } from './subagent-salvage.mjs';
import { appendVerifyConclusions, buildUpstreamOnlyVerifyPrompt, clipStoredContent, existingNodeOutputPath, withFullOutputHint, writeNodeOutput } from './workflow-outputs.mjs';
import { audit } from '../../../src/audit.mjs';
import { checkQuality } from '../../../src/checks/quality.mjs';
import { reviewDiff } from '../../../src/review-diff.mjs';

export const SCRIPT_MAX_NODES = 200;
export const SCRIPT_MAX_FANOUT = 50;
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
        return { error: `${opId} 的 ${field} 必须是字符串或非空字符串数组` };
      }
      refs.push(item.trim());
    }
    return { refs };
  }
  return { error: `${opId} 缺少 ${field}（上游节点引用）` };
}

function validateWhen(value, label) {
  if (!isObj(value)) return { error: `${label} 必须是对象` };
  const ref = text(value.ref);
  if (!ref) return { error: `${label}.ref 不能为空` };
  if (!isObj(value.test)) return { error: `${label}.test 必须是对象` };
  const keys = Object.keys(value.test);
  if (!keys.length) return { error: `${label}.test 至少要有 contains / equals / notEmpty 之一` };
  for (const key of keys) {
    if (!['contains', 'equals', 'notEmpty'].includes(key)) return { error: `${label}.test 含未知字段：${key}` };
    const item = value.test[key];
    if (key === 'notEmpty') {
      if (typeof item !== 'boolean') return { error: `${label}.test.notEmpty 必须是布尔值` };
    } else if (!['string', 'number', 'boolean'].includes(typeof item)) {
      return { error: `${label}.test.${key} 必须是字符串/数字/布尔值` };
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
    if (!knownRef(ref, ctx)) return `${opId} 的 ${field} 指向不存在的节点：${ref}`;
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
  if (ctx.allIds.has(id)) return `节点 id 重复：${id}`;
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
    return `脚本节点最多 ${SCRIPT_MAX_NODES} 个（当前 ${ctx.nodesCounted.n}）`;
  }
  return null;
}

function setBodyAlias(ctx, opId, nodeId) {
  if (!ctx.forceDerived) return null;
  if (ctx.bodyAliases.has(opId)) return `循环/递归 body 内 op id 重复：${opId}`;
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
    return { error: `脚本节点最多 ${SCRIPT_MAX_NODES} 个（自动补验后会超限）` };
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
export function normalizeScript(script) {
  if (!Array.isArray(script) || script.length === 0) {
    return { error: 'script 不能为空：至少 1 条 op' };
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
  return injectScriptAdversarialVerify({ items, nodes, nodeCount: ctx.nodesCounted.n });
}

function walkOps(ops, ctx, outItems, outNodes) {
  if (!Array.isArray(ops)) return `${ctx.label} 必须是 op 数组`;
  for (let i = 0; i < ops.length; i += 1) {
    const raw = ops[i];
    if (!isObj(raw)) return `${ctx.label}[${i}] 必须是对象`;
    const op = text(raw.op);
    if (!OP_KINDS.has(op)) {
      return `未知脚本 op：${op || '(空)'}（只支持 ${SCRIPT_OPS.join('/')}）`;
    }
    const opId = text(raw.id);
    if (!opId) return `${ctx.label}[${i}] 缺少 id`;
    if (!ID_RE.test(opId)) return `脚本 id 非法（只允许字母数字-_，最长 32）：${opId}`;
    if (ctx.forceDerived) {
      if (ctx.bodyAliases.has(opId)) return `循环/递归 body 内 op id 重复：${opId}`;
    } else {
      if (ctx.allIds.has(opId)) return `脚本 id 重复：${opId}`;
      ctx.allIds.add(opId);
    }
    // 分支/循环体节点 id 按规格派生；顶层节点用显式 id
    const baseId = ctx.topLevel && !ctx.forceDerived ? opId : `${ctx.prefix}.${i}`;
    const name = text(raw.name) || `${op === 'report' ? '汇总' : op === 'verify' ? '验证' : op === 'gate' || op === 'aggregate' ? '程序' : op === 'loop' ? '循环' : op === 'recurse' ? '递归' : '步骤'} ${baseId}`;
    const role = text(raw.role);

    if (op === 'step') {
      const prompt = text(raw.prompt);
      if (!prompt) return `节点 ${baseId} 缺少 prompt`;
      if (prompt.length > MAX_PROMPT_CHARS) return `节点 ${baseId} 的 prompt 过长（>${MAX_PROMPT_CHARS} 字符）`;
      if (raw.depends_on !== undefined && raw.depends_on !== null && !Array.isArray(raw.depends_on)) {
        return `节点 ${baseId} 的 depends_on 必须是数组`;
      }
      const originalDeps = Array.isArray(raw.depends_on) ? raw.depends_on.map((d) => text(d)).filter(Boolean) : [];
      const refError = checkRefs(originalDeps, ctx, baseId, 'depends_on');
      if (refError) return refError;
      noteExternalRefs(originalDeps, ctx);
      const dependsOn = originalDeps.map((d) => mapWalkRef(d, ctx));
      if (dependsOn.includes(baseId)) return `节点 ${baseId} 不能依赖自己`;
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
      let overItems = null;
      let originalOverRef = null;
      if (Array.isArray(over)) {
        if (over.length > SCRIPT_MAX_FANOUT) {
          return `fanout ${baseId} 的 over 最多 ${SCRIPT_MAX_FANOUT} 项（当前 ${over.length}）`;
        }
        for (const entry of over) {
          if (typeof entry !== 'string') return `fanout ${baseId} 的 over 里每项必须是字符串`;
        }
        overItems = over.map((entry) => String(entry));
      } else if (typeof over === 'string' && over.trim()) {
        originalOverRef = over.trim();
        if (!originalOverRef.startsWith('${') && !knownRef(originalOverRef, ctx)) {
          return `fanout ${baseId} 的 over 指向不存在的节点：${originalOverRef}`;
        }
      } else if (isObj(over) && typeof over.ref === 'string' && over.ref.trim()) {
        originalOverRef = over.ref.trim();
        if (!knownRef(originalOverRef, ctx)) return `fanout ${baseId} 的 over 指向不存在的节点：${originalOverRef}`;
      } else {
        return `fanout ${baseId} 缺少 over（字符串数组或节点引用）`;
      }
      const asName = text(raw.as);
      if (!VAR_RE.test(asName)) return `fanout ${baseId} 的 as 非法（只允许字母数字_，且不能以数字开头）：${asName || '(空)'}`;
      if (!isObj(raw.step)) return `fanout ${baseId} 缺少 step 对象`;
      const subPrompt = text(raw.step.prompt);
      if (!subPrompt) return `fanout ${baseId} 的子步骤缺少 prompt`;
      if (subPrompt.length > MAX_PROMPT_CHARS) return `fanout ${baseId} 的子步骤 prompt 过长（>${MAX_PROMPT_CHARS} 字符）`;
      if (ctx.depth > SCRIPT_MAX_IF_FANOUT_DEPTH) {
        return `if 分支内套 fanout 最多 ${SCRIPT_MAX_IF_FANOUT_DEPTH} 层（${baseId}）`;
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
      const validated = validateWhen(raw.when, `if ${opId} 的 when`);
      if (validated.error) return validated.error;
      const originalRef = validated.when.ref;
      if (!knownRef(originalRef, ctx)) return `if ${opId} 的 when.ref 指向不存在的节点：${originalRef}`;
      noteExternalRefs([originalRef], ctx);
      if (!Array.isArray(raw.then) || raw.then.length === 0) return `if ${opId} 的 then 必须是非空 op 数组`;
      if (raw.else !== undefined && raw.else !== null && !Array.isArray(raw.else)) return `if ${opId} 的 else 必须是 op 数组`;
      if (ctx.depth + 1 > SCRIPT_MAX_DEPTH) return `if 嵌套超过 ${SCRIPT_MAX_DEPTH} 层（${opId}）`;
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
        return `gate ${baseId} 的 tool 不支持：${tool || '(空)'}（只支持 ${SCRIPT_GATE_TOOLS.join('/')}）`;
      }
      let args = {};
      if (raw.args !== undefined && raw.args !== null) {
        if (!isObj(raw.args)) return `gate ${baseId} 的 args 必须是对象`;
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
      if (ask.length > MAX_PROMPT_CHARS) return `report ${baseId} 的 ask 过长（>${MAX_PROMPT_CHARS} 字符）`;
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
        return `loop ${baseId} 的 maxRounds 必须是 1..${SCRIPT_LOOP_MAX_ROUNDS} 的整数`;
      }
      if (!Array.isArray(raw.body) || raw.body.length === 0) return `loop ${baseId} 的 body 必须是非空 op 数组`;
      const until = validateWhen(raw.until, `loop ${baseId} 的 until`);
      if (until.error) return until.error;
      if (ctx.depth + 1 > SCRIPT_MAX_DEPTH) return `嵌套超过 ${SCRIPT_MAX_DEPTH} 层（${baseId}）`;
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
          return `loop ${baseId} 的 until.ref 指向不存在的节点：${untilRef}`;
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
        return `recurse ${baseId} 的 maxDepth 必须是 1..${SCRIPT_RECURSE_MAX_DEPTH} 的整数`;
      }
      if (!Array.isArray(raw.body) || raw.body.length === 0) return `recurse ${baseId} 的 body 必须是非空 op 数组`;
      const over = raw.over;
      let overItems = null;
      let originalOverRef = null;
      if (Array.isArray(over)) {
        for (const entry of over) {
          if (typeof entry !== 'string') return `recurse ${baseId} 的 over 里每项必须是字符串`;
        }
        overItems = over.map((entry) => String(entry));
      } else if (typeof over === 'string' && over.trim()) {
        originalOverRef = over.trim();
        if (!originalOverRef.startsWith('${') && !knownRef(originalOverRef, ctx)) {
          return `recurse ${baseId} 的 over 指向不存在的节点：${originalOverRef}`;
        }
      } else if (isObj(over) && typeof over.ref === 'string' && over.ref.trim()) {
        originalOverRef = over.ref.trim();
        if (!knownRef(originalOverRef, ctx)) return `recurse ${baseId} 的 over 指向不存在的节点：${originalOverRef}`;
      } else {
        return `recurse ${baseId} 缺少 over（字符串数组或节点引用）`;
      }
      const asName = text(raw.as);
      if (!VAR_RE.test(asName)) return `recurse ${baseId} 的 as 非法（只允许字母数字_，且不能以数字开头）：${asName || '(空)'}`;
      if (ctx.depth + 1 > SCRIPT_MAX_DEPTH) return `嵌套超过 ${SCRIPT_MAX_DEPTH} 层（${baseId}）`;
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
        const validatedStop = validateWhen(raw.stopWhen, `recurse ${baseId} 的 stopWhen`);
        if (validatedStop.error) return validatedStop.error;
        const stopRef = validatedStop.when.ref;
        if (!probeCtx.bodyAliases.has(stopRef) && !knownRef(stopRef, probeCtx)) {
          return `recurse ${baseId} 的 stopWhen.ref 指向不存在的节点：${stopRef}`;
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
        return `aggregate ${baseId} 的 by 不支持：${by || '(空)'}（只支持 ${SCRIPT_AGGREGATE_BY.join('/')}）`;
      }
      let top = SCRIPT_AGGREGATE_TOP_DEFAULT;
      if (raw.top !== undefined && raw.top !== null) {
        const n = Number(raw.top);
        if (!Number.isInteger(n) || n < 1 || n > SCRIPT_AGGREGATE_TOP_MAX) {
          return `aggregate ${baseId} 的 top 必须是 1..${SCRIPT_AGGREGATE_TOP_MAX} 的整数`;
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

    return `未知脚本 op：${op}`;
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
  return { error: `不支持的程序闸工具：${tool}` };
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
} = {}) {
  const goalText = text(goal);
  if (!goalText) return { error: 'goal 不能为空（整个工作流要达成的目标）' };
  const norm = normalizeScript(script);
  if (norm.error) return { error: norm.error };

  const ctl = control && typeof control === 'object' ? control : {};
  // 并发上限：运行中可改（卡片设置写 ctl.maxConcurrency），否则用传入的 concurrency。
  // 每次 fanout 开始时重新算一次，所以「跑着的时候把并发调高」对后面的 fanout 也生效。
  const limitOf = () => {
    const live = Number(ctl.maxConcurrency);
    const base = Number.isFinite(live) && live > 0 ? live : Number(concurrency);
    const n = Number.isFinite(base) && base > 0 ? Math.trunc(base) : SCRIPT_DEFAULT_CONCURRENCY;
    return Math.min(SCRIPT_MAX_CONCURRENCY, Math.max(1, n));
  };
  const allNodes = norm.nodes.slice();
  const results = new Map();
  const state = new Map();
  const aliasNodes = new Map();
  const phases = [];
  const delivered = [];
  const claimsStore = [];
  const executionOrder = [];
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
      prompt = `${prompt}\n\n${DELIVERY_DISCIPLINE}`;
      return { prompt, dependsOn };
    }
    const dependsOn = resolveRefs(node.depends_on);
    const promptText = interpolateScriptText(node.prompt, vars, results);
    const prompt = `${buildPrompt(
      goalText,
      { id: node.id, name: node.name, role: node.role, prompt: promptText, depends_on: dependsOn },
      results
    )}\n\n${DELIVERY_DISCIPLINE}`;
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
        out = { error: e?.message || '程序节点执行失败' };
      }
    } else {
      built = buildScriptPrompt(node, vars);
      if (typeof callStep !== 'function') {
        out = { error: '当前通道不支持子代理调用' };
      } else {
        try {
          out = await callStep({
            id: node.id,
            name: node.name,
            role: node.role,
            prompt: built.prompt,
            depends_on: built.dependsOn || node.depends_on,
            runId: effectiveRunId, // 子代理 transcript 按 run 落盘
            budget: null,
            kind: node.kind || null,
            model: null,
            providerId: null,
            blind: node.kind === 'verify' ? true : null,
          });
        } catch (e) {
          out = { error: e?.message || '子代理调用失败' };
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
      error = out?.error || (content ? null : '程序节点没有返回结果');
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
      error = out?.error || judged.error || (originalEmpty ? '子代理没有返回内容' : null);
      if (aborted) error = out?.error || '子代理被中断';
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
    const parseItems = (value) => {
      const parsed = parseAgentJson(String(value || ''));
      if (parsed?.error || !Array.isArray(parsed)) return null;
      for (const item of parsed) {
        if (typeof item !== 'string') throw abortScript(`${label} 的 over 里每项必须是字符串`);
      }
      return parsed;
    };
    let target = resolveSingle(rawRef);
    if (!target && rawRef.includes('${')) {
      const interpolated = interpolateScriptText(rawRef, {}, results);
      const direct = parseItems(interpolated);
      if (direct) return direct;
      target = resolveSingle(interpolated);
      if (!target) throw abortScript(`${label} 的 over 引用不存在：${interpolated}`);
    }
    if (!target) throw abortScript(`${label} 的 over 引用不存在：${rawRef}`);
    const parsed = parseItems(target.content);
    if (!parsed) throw abortScript(`${label} 的 over 引用 ${rawRef} 未解析出 JSON 字符串数组`);
    return parsed;
  };

  const runFanout = async (container, phaseIds, vars) => {
    if (ctl.aborted) {
      stopped = true;
      return;
    }
    const items = container.overRef ? resolveOverList(`fanout ${container.id}`, container.overRef) : (container.overItems || []);
    if (items.length > SCRIPT_MAX_FANOUT) {
      throw abortScript(`fanout ${container.id} 的 over 最多 ${SCRIPT_MAX_FANOUT} 项（当前 ${items.length}）`);
    }
    let children;
    if (container.overItems) {
      children = container.children;
    } else {
      const existingIds = new Set(allNodes.map((x) => x.id));
      children = items.map((item, index) => {
        const child = makeFanoutChild(container, item, index);
        if (existingIds.has(child.id)) throw abortScript(`节点 id 重复：${child.id}`);
        existingIds.add(child.id);
        knownNode(child);
        return child;
      });
    }
    if (allNodes.length > SCRIPT_MAX_NODES) {
      throw abortScript(`脚本节点最多 ${SCRIPT_MAX_NODES} 个（当前 ${allNodes.length}）`);
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
      throw abortScript(`脚本节点最多 ${SCRIPT_MAX_NODES} 个（当前 ${ctx.nodesCounted.n}）`);
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
    const items = node.overRef
      ? resolveOverList(`recurse ${node.id}`, node.overRef)
      : (node.overItems || []);
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
      const last = phaseIds.length > start ? results.get(phaseIds[phaseIds.length - 1]) : null;
      const target = resolveBranchTarget(node.until.ref, spec.aliases, phaseIds.slice(start));
      if (matchScriptCondition(node.until, target)) {
        matched = true;
        break;
      }
    }
    if (stopped || ctl.aborted) {
      return { error: '工作流已停止', rounds: roundsRun, matched: false, maxRounds: node.maxRounds };
    }
    if (!matched) {
      return { error: '循环达到上限仍不满足条件', rounds: roundsRun, matched: false, maxRounds: node.maxRounds };
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
    return { error: `未知程序节点类型：${node.programType}` };
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
      await runItem(item, phaseIds, {});
      if (!phaseIds.length) phases.pop(); // 自动补验被跳过时不留下空阶段
      if (stopped) break;
    }
  } catch (e) {
    fatal = e?.scriptAbort ? String(e.message || e) : `脚本执行失败：${e?.message || e}`;
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
  const warnings = [...claimWarnings, ...adversarialGate.warnings];
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
    return { error: fatal, runId: effectiveRunId, goal: goalText, stopped, warnings };
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
    claimsFile,
    delivered: delivered.slice(),
    summary: ordered.map((r) => {
      if (r.ok) return `${r.id} ${r.name}: 完成`;
      // 失败行带结构化错误码 + 一句人话（HTTP 429 · 网关限流…）；旧结果没有 errorCode 时回落到原始 error
      return r.errorCode
        ? `${r.id} ${r.name}: 失败（${r.errorCode} · ${errorCodeLabel(r.errorCode)}）`
        : `${r.id} ${r.name}: 失败（${r.error}）`;
    }).join('\n'),
  };
}
