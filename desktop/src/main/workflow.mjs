// @ts-check
// 多 agent 工作流（对齐 ZCode dynamic-workflows 的最小可用版）：
// 主 agent 自己写 steps（角色/任务/依赖），引擎按 depends_on 拓扑分层、同层并行（并发默认 14，上限 32），
// 上游结果自动注入下游 prompt。每个 step = 一次独立上下文的子代理调用（由调用方注入 callStep）。
//
// 断点恢复：传 journalDir 时每一步结束/整体结束都会落盘；resumeFrom（journal 对象或 runId）里
// hash 未变且依赖链全部可复用的成功步骤直接跳过 callStep，内容照常注入下游 prompt。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { JOURNAL_VERSION, createJournal, isValidRunId, loadJournal, recordStep, runIdOf, saveJournal } from './workflow-journal.mjs';
import { applyVerdicts, buildSwarmPrompt, claimsToJsonl, collectClaims, deriveNodeErrorCode, errorCodeLabel, lintClaims, lintReport, normalizeSwarmStep, parseAgentJson, stepRequiresToolEvidence } from './swarm.mjs';
import { buildHolesPromptSection, collectHoles, isSalvageText, salvageSubagentContent } from './subagent-salvage.mjs';
import { appendVerifyConclusions, buildUpstreamOnlyVerifyPrompt, clipStoredContent, existingNodeOutputPath, withFullOutputHint, writeNodeOutput } from './workflow-outputs.mjs';
// 受限脚本 DSL（script 模式）解释器；它反向引用本文件的纯函数，ESM 函数声明在实例化阶段已可用
import { runScriptWorkflow, SCRIPT_DEFAULT_CONCURRENCY, SCRIPT_MAX_CONCURRENCY } from './workflow-script.mjs';
import { agentTitleFor } from './agent-titles.mjs';
// 双语：失败原因/警告/摘要会显示在聊天与工作流卡里（zh 下 t() 原样返回源串）
import { t } from '../renderer/i18n/core.mjs';

/**
 * 步骤预算（normalizeSteps 校验/clamp 后原样透传给 callStep）。
 * @typedef {object} StepBudget
 * @property {number} [maxTurns] 模型轮次上限
 * @property {number} [maxTools] 工具调用上限
 * @property {number} [maxMs] 单步软预算（毫秒）
 * @property {number} [maxStepMs] 单步墙钟（0 = 不限制）
 */

/**
 * 规范化后的工作流步骤（normalizeSteps 输出；无 kind 的旧步骤保持原行为）。
 * @typedef {object} WorkflowStep
 * @property {string} id 只允许字母数字-_，最长 32
 * @property {string} name 展示名（职位名，如「注入面审查员」；不是「步骤 N」）
 * @property {string} [originalName] 模型给的原始 name（可能为空串）：只参与取证判定，不参与展示
 * @property {string} role 子代理角色
 * @property {string} prompt 交给子代理的具体任务
 * @property {string[]} depends_on 依赖步骤 id（拓扑分层依据）
 * @property {StepBudget} [budget]
 * @property {string} [kind] swarm 协议类型 recon|find|verify|arbitrate|report
 * @property {boolean} [blind]
 * @property {string} [model]
 * @property {string} [providerId]
 * @property {string} [targetsFrom]
 * @property {boolean} [autoInserted] 引擎自动补的对抗复核节点
 * @property {boolean} [program] gate/aggregate 等程序节点
 * @property {string} [scriptOp] 脚本模式原始 op JSON（参与 stepHash）
 */

/**
 * normalizeSteps 的结果：成功带 steps/levels/byId，失败带 error。
 * @typedef {object} NormalizedWorkflow
 * @property {WorkflowStep[]} [steps]
 * @property {string[][]} [levels] 拓扑层级（同层可并行）
 * @property {Map<string, WorkflowStep>} [byId]
 * @property {string} [error]
 */

/**
 * callStep 的入参：每个步骤一次独立上下文的子代理调用。
 * @typedef {object} CallStepContext
 * @property {string} id
 * @property {string} name
 * @property {string|null} [originalName] 模型原始 name（空串=没给）：取证判定只看它
 * @property {string} role
 * @property {string} prompt 已注入上游结果的最终提示词
 * @property {string[]} depends_on
 * @property {StepBudget} [budget] 缺省为 { maxStepMs: 0 }（不设墙钟）
 * @property {string|null} [kind]
 * @property {string|null} [model]
 * @property {string|null} [providerId]
 * @property {boolean|null} [blind]
 * @property {string} [runId] 子代理 transcript 按 run 落盘
 * @property {AbortSignal} [signal] 用户停止/显式墙钟中断信号
 */

/**
 * callStep 的返回（上层执行器的最小契约）。
 * @typedef {object} CallStepResult
 * @property {string} [content]
 * @property {string} [error]
 * @property {string} [errorCode]
 * @property {number} [toolCount]
 * @property {boolean} [truncated]
 * @property {string[]} [warnings]
 * @property {string} [model]
 * @property {string} [providerId]
 * @property {boolean} [cancelled]
 * @property {boolean} [interrupted]
 * @property {boolean} [salvaged]
 * @property {any[]} [transcript]
 * @property {string} [partialContent]
 */

/**
 * @typedef {(ctx: CallStepContext) => Promise<CallStepResult>} CallStepFunction
 */

/**
 * 一个步骤的执行结果（runWorkflow 返回 results 的一项；swarm/script 附加字段可缺席）。
 * @typedef {object} WorkflowStepResult
 * @property {string} id
 * @property {string} name
 * @property {string} role
 * @property {string[]} depends_on
 * @property {boolean} ok
 * @property {string|null} error
 * @property {string|null} errorCode
 * @property {string} content
 * @property {number} ms
 * @property {number} tools
 * @property {boolean} [truncated]
 * @property {string[]} [warnings]
 * @property {boolean} reused
 * @property {string|null} kind
 * @property {string|null} model
 * @property {string|null} providerId
 * @property {string} [fullOutputPath] 完整正文落盘路径
 * @property {boolean} [autoInserted]
 * @property {boolean} [salvaged]
 * @property {string|null} [salvageReason]
 * @property {boolean} [hole]
 * @property {import('./swarm.mjs').SwarmClaim[]} [claims]
 * @property {import('./swarm.mjs').SwarmVerdictInput[]} [verdicts]
 * @property {import('./swarm.mjs').SwarmDecision[]} [decisions]
 * @property {any[]} [targets]
 * @property {string} [parseError]
 * @property {string[]} [unmatchedVerdicts]
 * @property {string[]} [unmatchedDecisions]
 * @property {string[]} [holes]
 * @property {string[]} [reportWarnings]
 * @property {boolean} [reportLintOk]
 * @property {boolean} [delivered]
 * @property {boolean} [claimsEmpty]
 * @property {boolean} [verdictsEmpty]
 */

/**
 * 步骤运行态（快照/收尾补齐用）。
 * @typedef {object} WorkflowStepState
 * @property {string} status pending | running | success | failed | cancelled
 * @property {boolean} reused
 * @property {number|null} startedAt
 * @property {number|null} ms
 * @property {string|null} error
 * @property {string|null} [errorCode]
 * @property {number} tools
 * @property {number} [toolCount]
 * @property {string|null} [finishReason]
 * @property {number|null} [roundsUsed]
 * @property {boolean} [skipped]
 * @property {boolean} [truncated]
 * @property {string[]} [warnings]
 * @property {boolean} [salvaged]
 * @property {string|null} [salvageReason]
 * @property {boolean} [hole]
 */

/**
 * 运行控制台（UI 可改，引擎每轮读取）。
 * @typedef {object} RunControl
 * @property {boolean} [paused]
 * @property {boolean} [aborted]
 * @property {number} [maxConcurrency]
 */

/**
 * journal 里一条步骤记录（断点恢复的复用判定依据）。
 * @typedef {object} WorkflowJournalStep
 * @property {string} name
 * @property {string} role
 * @property {string} hash 步骤指纹（stepHash）
 * @property {string[]} depends_on
 * @property {'success'|'failed'|'cancelled'} status
 * @property {string} content
 * @property {string|null} error
 * @property {string|null} errorCode
 * @property {number} ms
 * @property {number} tools
 * @property {number} startedAt
 * @property {number} finishedAt
 */

/**
 * 一次工作流运行的 journal（<journalDir>/<runId>.json）。
 * @typedef {object} WorkflowJournal
 * @property {number} version
 * @property {string} runId
 * @property {string} goal
 * @property {number} startedAt
 * @property {number|null} finishedAt
 * @property {boolean} stopped
 * @property {Record<string, WorkflowJournalStep>} steps
 */

/**
 * 实时快照（onUpdate 推送，UI 用来展示多 agent 进度）。
 * @typedef {object} WorkflowSnapshot
 * @property {string} kind
 * @property {string} runId
 * @property {string} goal
 * @property {boolean} running
 * @property {boolean} paused
 * @property {number} startedAt
 * @property {number} ms
 * @property {number} concurrency
 * @property {'dag'|'script'} [mode] 本次表示方式（卡片徽标用）
 * @property {string} [modeReason] 一句人话：为什么用这种表示
 * @property {string[][]} phases
 * @property {Array<object>} steps
 */

/**
 * runWorkflow 的最终返回。
 * @typedef {object} WorkflowRunResult
 * @property {string} runId
 * @property {string} goal
 * @property {'dag'|'script'} [mode] 本次表示方式（DAG / 受限脚本 DSL）
 * @property {string} [modeReason] 一句人话：步骤数/层数或 fanout/loop 等依据
 * @property {Array<object>} steps
 * @property {WorkflowStepResult[]} results
 * @property {boolean} ok
 * @property {boolean} stopped
 * @property {number} ms
 * @property {import('./swarm.mjs').SwarmClaim[]} claims
 * @property {string[]} claimWarnings
 * @property {string[]} warnings
 * @property {string|null} claimsFile
 * @property {string} summary
 */

/**
 * 非流式子代理步进执行器（runSubagentStep）的返回。
 * @typedef {object} SubagentStepResult
 * @property {string} [content]
 * @property {string} [error]
 * @property {number} toolCount
 * @property {boolean} truncated
 * @property {string[]} warnings
 * @property {string|null} [finishReason]
 */

export const DEFAULT_MAX_STEPS = 14;
export const MAX_STEPS_CAP = 64;
export const DEFAULT_CONCURRENCY = 14;
export const MAX_CONCURRENCY = 32; // 引擎侧硬上限（旧版 14；index 仍按自己的 UI 上限 clamp）
const MAX_PROMPT = 6000;

// 每步预算（引擎只校验/clamp，原样交给 callStep，由上层执行）
// maxStepMs = 可选的单步墙钟上限；默认 0 = 不限制（不搞墙钟超时），只有显式传正数才生效（留给以后需要的人）
const BUDGET_LIMITS = {
  maxTurns: [1, 50],
  maxTools: [1, 50],
  maxMs: [3000, 600000],
  maxStepMs: [0, 600000],
};

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeBudget(raw, id) {
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: t('步骤 {id} 的 budget 必须是对象', { id }) };
  const out = {};
  for (const [key, [min, max]] of Object.entries(BUDGET_LIMITS)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) return { error: t('步骤 {id} 的 budget.{key} 必须是数字', { id, key }) };
    out[key] = clampInt(n, min, max, min);
  }
  return { budget: Object.keys(out).length ? out : null };
}

// ---- 单步墙钟（默认关闭）与失败文案（steps / script 共用；上层 callStep 通过 ctx.signal 拿中断信号） ----
// 预算语义（用户明确要求：子代理/工作流不设墙钟超时）：
//   maxStepMs  默认 0 = 不限制；显式正数才会在到点 abort（上限 600000，留给以后需要的人）
//   软工具预算已取消：不再按 300s 自动中止；「模型轮次」默认不设上限（长时间自主工作），显式 budget.maxTurns 才生效
//   用户停止 / 父级 abort 仍然立即生效（control.aborted + chatAbort 都走 ctx.signal）
function durationText(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return n >= 1000 ? `${Math.round(n / 1000)}s` : `${Math.round(n)}ms`;
}

/** 显式墙钟到点时的文案（失败步骤必须有可读原因，不能是空字符串）
 * @param {number} [ms]
 * @returns {string}
 */
export function stepTimeoutText(ms) {
  return t('单步超时（{duration}）：已中断，产出可能不完整', { duration: durationText(ms) });
}

/** 历史软预算文案（仅保留给旧调用/测试引用；流式子代理已不再按时间强制收尾）
 * @param {number} [ms]
 * @returns {string}
 */
export function softBudgetText(ms) {
  return t('工具预算用尽（{duration}），已强制收尾', { duration: durationText(ms) });
}

/** 解析单步墙钟上限：budget.maxStepMs 显式正数才生效；缺省/非法/0 = 不限制（返回 0）
 * @param {StepBudget|null} [budget]
 * @returns {number}
 */
export function resolveMaxStepMs(budget) {
  return clampInt(budget?.maxStepMs, 0, 600000, 0);
}

/** 盲验节点的专属墙钟上限：verifyTimeoutMs 显式传才覆盖，缺省/非法 = 60 分钟；显式 0 = 关闭上限。
 * @param {number|null|undefined} [value]
 * @returns {number}
 */
export function resolveVerifyTimeoutMs(value) {
  // 非法/负数一律回落默认（fail-closed：复核上限不能被坏输入悄悄关掉）；只有显式 0 才关闭。
  if (value === null || value === undefined || value === '') return VERIFY_TIMEOUT_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return VERIFY_TIMEOUT_MS;
  if (n === 0) return 0;
  return Math.min(Math.trunc(n), VERIFY_TIMEOUT_MAX_MS);
}

function isVerifyStep(step) {
  return String(step?.kind || '').toLowerCase() === 'verify' || !!step?.autoInserted;
}

/**
 * 解析一次 step 调用的实际墙钟上限（纯函数，供 withStepDeadline 与测试共用）。
 * 这里必须区分「普通步骤」与「盲验节点」：
 *   普通步骤沿用 resolveMaxStepMs（显式 maxStepMs，clamp 上限 10 分钟）；
 *   盲验节点用 resolveVerifyTimeoutMs（默认 60 分钟，上限 4 小时）。
 * 曾经的 bug：盲验把 60 分钟写进 budget.maxStepMs，随后被 resolveMaxStepMs 的
 * 10 分钟 clamp 截成 600s，所有盲验实际 10 分钟就被杀（2026-11-11 实测日志里的
 * 「盲验超过 600s 被强制截止」）。
 * @param {{kind?:string|null, autoInserted?:boolean, budget?:object|null}} [ctx]
 * @returns {number} 毫秒；0 = 不限制
 */
export function resolveStepDeadlineMs(ctx = {}) {
  const raw = ctx?.budget && typeof ctx.budget === 'object' ? ctx.budget.maxStepMs : undefined;
  if (isVerifyStep(ctx)) return resolveVerifyTimeoutMs(raw);
  return resolveMaxStepMs(ctx?.budget);
}

/**
 * 给 callStep 套一层可选中止：
 * - 默认 maxStepMs=0：不设任何墙钟超时，长任务不会被自动 abort；
 * - 显式 budget.maxStepMs>0：到点 abort（ctx.signal），失败原因写成「单步超时」并保留 partial content；
 * - 父级/用户停止（options.signal）永远立即 abort，不等待任何计时器。
 * 正常完成时行为完全不变（timer 清理，结果原样透传）。
 * steps 模式与 script 模式走同一个包装，保证两条链路语义一致。
 * @param {Function} callStep
 * @param {{abortGraceMs?:number, signal?:AbortSignal|null}} [opts]
 * @returns {Function}
 */
export function withStepDeadline(callStep, { abortGraceMs = STEP_ABORT_GRACE_MS, signal: outerSignal = null } = {}) {
  if (typeof callStep !== 'function') return callStep;
  return async (ctx = {}) => {
    const maxMs = resolveStepDeadlineMs(ctx); // 0 = 不限制；盲验走专属上限，不被普通 clamp 截断
    const budget = ctx?.budget && typeof ctx.budget === 'object' && !Array.isArray(ctx.budget)
      ? ctx.budget
      : { maxStepMs: maxMs };
    const ctl = new AbortController();
    let timedOut = false;
    let stopped = false;
    const onOuterAbort = () => {
      stopped = true;
      try { ctl.abort(); } catch { /* 已中断 */ }
    };
    if (outerSignal) {
      if (outerSignal.aborted) onOuterAbort();
      else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    let timer = null;
    let graceTimer = null;
    let finishRace = null;
    const abortedRace = maxMs > 0 ? new Promise((resolve) => { finishRace = resolve; }) : null;
    if (maxMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { ctl.abort(); } catch { /* 已中断 */ }
        graceTimer = setTimeout(() => finishRace(null), Math.max(0, Number(abortGraceMs) || 0));
      }, maxMs);
    }
    let out;
    try {
      out = await Promise.race([
        Promise.resolve()
          .then(() => callStep({ ...ctx, budget, signal: ctl.signal }))
          .catch((e) => ({ error: e?.message || t('子代理调用失败') })),
        abortedRace || new Promise(() => { /* 不限制时永不抢跑 */ }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      outerSignal?.removeEventListener?.('abort', onOuterAbort);
    }
    const base = out && typeof out === 'object' ? out : {};
    const content = String(base.content || base.partialContent || '').trim();
    if (timedOut) {
      // 复核节点的超时必须是「明确状态」，不能只留一句错误：带 VERIFY_TIMEOUT 错误码 →
      // 卡片 chip、结果行、报告 Not covered 都能点名「复核未完成」。
      const verifyTimedOut = isVerifyStep(ctx);
      return {
        ...base,
        ...(content ? { content } : {}),
        timedOut: true,
        ...(verifyTimedOut ? { errorCode: VERIFY_TIMEOUT_CODE } : {}),
        error: verifyTimedOut
          ? t('复核未完成：盲验超过 {duration} 被强制截止（结论按未复核处理）', { duration: durationText(maxMs) })
          : stepTimeoutText(maxMs),
        warnings: [...(Array.isArray(base.warnings) ? base.warnings : []), t('单步超时（{duration}）：已中断', { duration: durationText(maxMs) })],
      };
    }
    if (stopped) {
      // 用户/父级停止：中断即返回，已产出的正文照样保留
      return {
        ...base,
        ...(content ? { content } : {}),
        error: base.error || t('已中断（用户停止）'),
        warnings: [...(Array.isArray(base.warnings) ? base.warnings : []), t('已中断（用户停止）')],
      };
    }
    return out;
  };
}

/**
 * 步骤指纹：goal + id + prompt + role + depends_on 的稳定序列化 sha1。
 * budget / name 刻意不参与（改预算或展示名不应让缓存结果失效）。
 * @param {string} [goal]
 * @param {WorkflowStep} [step]
 * @returns {string}
 */
export function stepHash(goal, step) {
  const payload = {
    goal: String(goal || ''),
    id: String(step?.id || ''),
    prompt: String(step?.prompt || ''),
    role: String(step?.role || ''),
    depends_on: Array.isArray(step?.depends_on) ? step.depends_on.map((d) => String(d)) : [],
  };
  // swarm 字段只在有 kind 时参与，旧步骤的 hash 与之前完全一致
  if (step?.kind) {
    payload.kind = String(step.kind);
    payload.blind = step.blind === undefined ? null : !!step.blind;
    payload.model = String(step.model || '');
    payload.providerId = String(step.providerId || '');
    payload.targetsFrom = String(step.targetsFrom || '');
  }
  // 脚本模式：原始 op JSON + 上游 id 列表（由解释器拼好）参与 hash；旧步骤没有该字段，hash 不变
  if (step?.scriptOp) payload.scriptOp = String(step.scriptOp);
  // 显式固定键顺序 + JSON.stringify，保证同一输入永远得到同一串
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

/** 纯函数：校验并规范化 steps；返回 { steps, levels, byId } 或 { error }
 * @param {any[]} steps
 * @param {{maxSteps?: number, goal?: string}} [opts] goal 只用于展示名关键词推断（不影响校验）
 * @returns {NormalizedWorkflow}
 */
export function normalizeSteps(steps, { maxSteps = DEFAULT_MAX_STEPS, goal = '' } = {}) {
  const stepLimit = clampInt(maxSteps, 1, MAX_STEPS_CAP, DEFAULT_MAX_STEPS);
  if (!Array.isArray(steps) || steps.length === 0) return { error: t('steps 不能为空：至少 1 个步骤') };
  if (steps.length > stepLimit) return { error: t('步骤最多 {limit} 个（当前 {n}）', { limit: stepLimit, n: steps.length }) };
  const list = [];
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i] && typeof steps[i] === 'object' ? steps[i] : {};
    // 模型给的原始 name：合法职位名原样保留；「步骤 1」/泛词/空 → 下面按 kind+关键词生成职位名
    const givenName = String(s.name || s.title || '').trim();
    const item = {
      id: String(s.id || `s${i + 1}`).trim(),
      name: '', // 展示名在 kind 归一化之后再算（关键词推断需要 kind 与 prompt）
      originalName: givenName, // 只有它参与「要不要取证」的判定，展示名不改变执行语义
      role: String(s.role || '').trim().slice(0, 80),
      prompt: String(s.prompt || '').trim(),
      depends_on: Array.isArray(s.depends_on) ? s.depends_on.map((d) => String(d).trim()).filter(Boolean) : [],
      budget: s.budget,
    };
    // 只有显式给了 kind 才进入 swarm 协议；没有 kind 的旧步骤完全保持原行为
    const hasKind = s.kind !== undefined && s.kind !== null && String(s.kind).trim() !== '';
    if (hasKind) {
      try {
        const swarm = normalizeSwarmStep(s);
        item.kind = swarm.kind;
        item.blind = swarm.blind;
        if (swarm.model) item.model = swarm.model;
        if (swarm.providerId) item.providerId = swarm.providerId;
        if (swarm.targetsFrom) item.targetsFrom = swarm.targetsFrom;
      } catch (e) {
        return { error: t('步骤 {id} 协议字段非法：{error}', { id: item.id, error: e?.message || e }) };
      }
    }
    // 卡片上的主标题：职位名（「注入面审查员」），不是「步骤 N」；序号只在不兜底不出来时当后缀
    item.name = agentTitleFor({
      name: givenName, kind: item.kind, prompt: item.prompt, goal, index: i + 1, role: item.role,
    }).slice(0, 60);
    list.push(item);
  }
  const ids = new Set();
  for (const s of list) {
    if (!s.id || !/^[A-Za-z0-9_-]{1,32}$/.test(s.id)) return { error: t('步骤 id 非法（只允许字母数字-_，最长 32）：{id}', { id: s.id || t('(空)') }) };
    if (ids.has(s.id)) return { error: t('步骤 id 重复：{id}', { id: s.id }) };
    ids.add(s.id);
    if (!s.prompt) return { error: t('步骤 {id} 缺少 prompt（要交给子代理的具体任务）', { id: s.id }) };
    if (s.prompt.length > MAX_PROMPT) return { error: t('步骤 {id} 的 prompt 过长（>{max} 字符）', { id: s.id, max: MAX_PROMPT }) };
    if (s.budget !== undefined && s.budget !== null) {
      const b = normalizeBudget(s.budget, s.id);
      if (b.error) return { error: b.error };
      if (b.budget) s.budget = b.budget;
      else delete s.budget;
    } else {
      delete s.budget;
    }
  }
  for (const s of list) {
    for (const d of s.depends_on) {
      if (!ids.has(d)) return { error: t('步骤 {id} 依赖不存在的步骤：{dep}', { id: s.id, dep: d }) };
      if (d === s.id) return { error: t('步骤 {id} 不能依赖自己', { id: s.id }) };
    }
    if (s.targetsFrom) {
      if (s.targetsFrom === s.id) return { error: t('步骤 {id} 的 targetsFrom 不能指向自己', { id: s.id }) };
      if (!ids.has(s.targetsFrom)) return { error: t('步骤 {id} 的 targetsFrom 指向不存在的步骤：{target}', { id: s.id, target: s.targetsFrom }) };
    }
  }
  const topo = topoLevels(list);
  if (topo.error) return { error: topo.error };
  return { steps: list, levels: topo.levels, byId: topo.byId };
}

/** 拓扑分层（顺带检测环）。normalizeSteps 与自动补验共用，保证两处规则不漂移。 */
function topoLevels(list) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const levels = [];
  const done = new Set();
  let remaining = list.length;
  while (remaining > 0) {
    const level = list.filter((s) => !done.has(s.id) && s.depends_on.every((d) => done.has(d)));
    if (!level.length) return { error: t('步骤依赖成环，无法执行（检查 depends_on）') };
    for (const s of level) done.add(s.id);
    levels.push(level.map((s) => s.id));
    remaining -= level.length;
  }
  return { levels, byId };
}

// 兼容旧名字（index.mjs / 既有测试都按 normalizeWorkflow 引用）
export const normalizeWorkflow = normalizeSteps;

/**
 * 复用判定：journal 里 status=success + hash 与当前步骤一致 + content 非空 + 所有传递依赖可复用。
 * 依赖被改/失败会级联失效。
 * @param {any} journal resume journal（旧格式/损坏时按无记录处理）
 * @param {NormalizedWorkflow|null} norm normalizeSteps 的结果
 * @param {string} goal 当前总目标
 * @returns {{reusable: Set<string>, reasons: Record<string,string>}}
 */
export function computeReuse(journal, norm, goal) {
  const reusable = new Set();
  const reasons = {};
  if (!norm || norm.error || !Array.isArray(norm.steps)) return { reusable, reasons };
  const journalSteps = journal && typeof journal === 'object'
    && journal.steps && typeof journal.steps === 'object' && !Array.isArray(journal.steps)
    ? journal.steps
    : null;
  const byId = norm.byId instanceof Map ? norm.byId : new Map(norm.steps.map((s) => [s.id, s]));
  const visiting = new Set();

  const decide = (step) => {
    if (Object.prototype.hasOwnProperty.call(reasons, step.id)) return reusable.has(step.id);
    if (visiting.has(step.id)) {
      reasons[step.id] = t('依赖成环，不可复用');
      return false;
    }
    visiting.add(step.id);
    let ok = false;
    let reason = '';
    if (!journalSteps) {
      reason = t('没有 journal 记录');
    } else {
      const js = journalSteps[step.id];
      if (!js) {
        reason = t('journal 中没有该步骤');
      } else if (js.status !== 'success') {
        reason = t('上次未成功（{status}）', { status: js.status || t('未知') });
      } else if (!String(js.content || '').trim()) {
        reason = t('上次结果为空');
      } else if (String(js.hash || '') !== stepHash(goal, step)) {
        reason = t('步骤内容已变更（hash 不一致）');
      } else {
        ok = true;
        for (const d of step.depends_on) {
          const dep = byId.get(d);
          if (!dep) {
            ok = false;
            reason = t('依赖 {dep} 不在本次步骤中', { dep: d });
            break;
          }
          if (!decide(dep)) {
            ok = false;
            reason = t('依赖 {dep} 不可复用', { dep: d });
            break;
          }
        }
      }
    }
    visiting.delete(step.id);
    reasons[step.id] = ok ? t('可复用') : (reason || t('不可复用'));
    if (ok) reusable.add(step.id);
    return ok;
  };

  for (const s of norm.steps) decide(s);
  return { reusable, reasons };
}

/**
 * steps 模式（非 swarm）的提示词：总目标 + 角色 + 任务 + 上游结果。
 * @param {string} goal
 * @param {WorkflowStep} step
 * @param {Map<string, WorkflowStepResult>} results 已完成步骤的结果
 * @returns {string}
 */
export function buildPrompt(goal, step, results) {
  const upstream = step.depends_on
    .map((d) => {
      const r = results.get(d);
      const body = r?.ok ? String(r.content || '') : `[失败] ${r?.error || '无结果'}`;
      return `### 上游步骤 ${d}${r?.name ? `（${r.name}）` : ''}的结果\n${withFullOutputHint(body, r?.fullOutputPath || null)}`;
    })
    .join('\n\n');
  return [
    `总目标：${goal}`,
    step.role ? `你的角色：${step.role}` : '',
    `本步骤任务：${step.prompt}`,
    upstream ? `\n${upstream}\n\n只输出本步骤的交付物（结论/清单/代码/证据），不要复述总目标，不要寒暄。` : '\n只输出本步骤的交付物（结论/清单/代码/证据），不要复述总目标，不要寒暄。',
  ].filter(Boolean).join('\n');
}

// 子代理单步预算：轮次/工具数/单步时间默认全部不设上限（长时间自主工作，用户定案）；
// 输出 token（8000）是「单次回复的生成上限」，不是工作时长限制，保留防止跑飞；显式 budget.* 仍可设上限
export const SUBAGENT_MAX_OUTPUT_TOKENS = 8000;
export const SUBAGENT_MAX_TURNS = Number.POSITIVE_INFINITY; // 显式 budget.maxTurns 仍可设上限（normalizeBudget clamp [1,50]）
export const SUBAGENT_MAX_TOOLS = Number.POSITIVE_INFINITY;
export const SUBAGENT_STEP_BUDGET_MS = Number.POSITIVE_INFINITY; // 旧 runSubagentStep（非流式）路径也默认不限时
export const SUBAGENT_STEP_TIMEOUT_MS = 0; // 单步墙钟默认值：0 = 不限制（不搞墙钟超时；显式 budget.maxStepMs 才生效）
export const STEP_ABORT_GRACE_MS = 1500; // 显式墙钟到点后等 callStep 自己清理的宽限（保留它已产出的部分）
// 盲验（对抗复核）专属上限：其他步骤默认不限时，但复核节点必须能结束。
// 2026-11-11 实测：DAG 的 __verify__ 跑了 62.8 分钟、225 次工具仍未出结论，
// 把并行取证省下来的时间全部吃掉，报告一直拿不到复核结果。默认 60 分钟，0 = 显式关闭。
export const VERIFY_TIMEOUT_MS = 60 * 60 * 1000;
export const VERIFY_TIMEOUT_MAX_MS = 4 * 60 * 60 * 1000;
export const VERIFY_TIMEOUT_CODE = 'VERIFY_TIMEOUT';
export const SUBAGENT_TOOL_RETRY_REMINDER = '你还没有调用任何工具。现在必须调用工具取证，只回复一句话会被判为失败。';
export const SUBAGENT_TRUNCATED_WARNING = '输出被截断（finish_reason=length）：结果可能不完整';

// 长上下文护栏：工具结果超过 1200 字才裁，保留前 800/后 300 字
export const SUBAGENT_CONTEXT_MAX_CHARS = 120000;
export const SUBAGENT_TOOL_RESULT_HEAD = 800;
export const SUBAGENT_TOOL_RESULT_TAIL = 300;
export const SUBAGENT_TOOL_RESULT_MIN = 1200;

function messageText(msg) {
  return String(msg?.content || msg?.reasoning_content || msg?.reasoning || '').trim();
}

/**
 * 纯函数：请求前压缩上下文里的工具结果。
 * - JSON.stringify(msgs) 未超过 maxChars → 原样返回（同一数组引用，不做任何改动）。
 * - 超限 → 从最老的开始，只裁 role:'tool' 且 content 超过 minChars 的结果，保留头 keepHead / 尾 keepTail；
 *   不动 system/user/assistant 正文。裁到预算内即停（仍超限说明工具结果都太短，保持原样）。
 * 注意：这里只改发给模型的副本，右侧 transcript 由调用方保留原文。
 * @param {any[]} msgs chat/completions 的 messages 数组
 * @param {{maxChars?:number, keepHead?:number, keepTail?:number, minChars?:number}} [opts]
 * @returns {any[]}
 */
export function trimToolResults(msgs, {
  maxChars = SUBAGENT_CONTEXT_MAX_CHARS,
  keepHead = SUBAGENT_TOOL_RESULT_HEAD,
  keepTail = SUBAGENT_TOOL_RESULT_TAIL,
  minChars = SUBAGENT_TOOL_RESULT_MIN
} = {}) {
  if (!Array.isArray(msgs)) return msgs;
  let size;
  try { size = JSON.stringify(msgs).length; } catch { return msgs; }
  if (size <= maxChars) return msgs;
  const out = msgs.slice();
  for (let i = 0; i < out.length && size > maxChars; i += 1) {
    const m = out[i];
    if (!m || m.role !== 'tool') continue;
    const content = String(m.content ?? '');
    if (content.length < minChars) continue;
    const omitted = content.length - keepHead - keepTail;
    if (omitted <= 0) continue;
    out[i] = { ...m, content: `${content.slice(0, keepHead)}…[已截断 ${omitted} 字]…${content.slice(-keepTail)}` };
    size = JSON.stringify(out).length;
  }
  return out;
}

// 取证语义关键词：名称/角色/任务文本命中即视为「必须真的跑工具」。
// 英文关键词按词边界匹配（\b...\b），避免 latest / contest 里的 test 误伤。
const EVIDENCE_CN_KEYWORDS = ['审查', '体检', '核验', '取证', '检查', '测试', '扫描', '审计', '验证', '复核', '排查', '定位', '复现', '分析'];
const EVIDENCE_EN_RE = /\b(?:review|audit|scan|check|probe|test|verif)[a-z]*\b/i;

/**
 * 单一判定入口：该步骤是否必须产生真实工具调用（0 次调用即空转）。
 * index.mjs 的 callSubagent、workflow 的兜底闸、runSubagentStep 首轮 tool_choice / 空转重试都只调这一个函数，
 * 不允许再各写一套规则。
 * - report 只做汇总综合、arbitrate 只读 claims 与证据文本 → 明确豁免（即使文本命中关键词）。
 * - find / verify 取证复现步骤 → 必须是。
 * - 名称/角色/任务文本命中取证关键词（审查/审计/扫描/分析…）→ 是。
 * - 保留原逻辑：prompt 点名可用工具或出现盘符路径（D:\ / C:/）→ 是。
 * - 其余（纯汇总、纯格式化、纯翻译）→ 否。
 * - 展示名（name）可能是引擎生成的职位名（「审查员」自带取证关键词），所以有 originalName 时只认它：
 *   生成职位名不许改变执行语义（模型没给 name 的纯文本步骤，不该因为改了个标题就被强制跑工具）。
 * @param {{kind?:string|null,name?:string|null,originalName?:string|null,role?:string|null,prompt?:string|null}} step
 * @returns {boolean}
 */
export function needsEvidence(step = {}) {
  const s = step && typeof step === 'object' ? step : {};
  const kind = String(s.kind || '').trim().toLowerCase();
  // 汇总/仲裁明确豁免：report 只需综合上游，arbitrate 只读 claims 与证据原文，都不要求自己跑工具
  if (kind === 'report' || kind === 'arbitrate') return false;
  if (kind === 'find' || kind === 'verify') return true;
  // 有 originalName（哪怕是空串）时，name 是展示名，不拿来判定
  const nameForEvidence = Object.prototype.hasOwnProperty.call(s, 'originalName') ? s.originalName : s.name;
  const text = [nameForEvidence, s.role, s.prompt].filter(Boolean).map(String).join('\n');
  if (EVIDENCE_CN_KEYWORDS.some((k) => text.includes(k))) return true;
  if (EVIDENCE_EN_RE.test(text)) return true;
  // 原有判定：prompt 里点名工具名或盘符绝对路径（这里同时兜住工具名清单的唯一来源 swarm.mjs）
  return stepRequiresToolEvidence(kind, s.prompt);
}

// ---- 强制对抗复核（红队）----
// 默认强制：只要工作流里有 LLM 取证步骤（kind=find 或 needsEvidence 命中）而没有 verify，
// 就在调度前补一个盲验节点；只有 report/aggregate/gate 这种确定性汇总的工作流不补。
export const ADVERSARIAL_VERIFY_ID = '__verify__';
export const ADVERSARIAL_VERIFY_NAME = '红队复核员（盲验）';
export const ADVERSARIAL_VERIFY_ROLE = '红队复核员';
export const ADVERSARIAL_VERIFY_PROMPT = [
  '你是对抗复核员（红队），默认怀疑上游每一条结论。',
  '先逐条写出「这条 claim 在什么情况下会不成立」，再亲自读代码或跑命令逐条复现；',
  '复现不了的一律 rejected 或 uncertain，禁止猜 confirmed；',
  '不允许把上游描述、推理链、置信度或“已验证”声明当成证据。',
].join('\n');

/** 自动补验节点 id：__verify__，冲突时 __verify__2… */
function nextVerifyId(taken) {
  let id = ADVERSARIAL_VERIFY_ID;
  if (!taken.has(id)) return id;
  let n = 2;
  while (taken.has(`${ADVERSARIAL_VERIFY_ID}${n}`)) n += 1;
  return `${ADVERSARIAL_VERIFY_ID}${n}`;
}

function makeAdversarialVerifyStep(id, evidenceIds) {
  return {
    id,
    name: ADVERSARIAL_VERIFY_NAME,
    role: ADVERSARIAL_VERIFY_ROLE,
    prompt: ADVERSARIAL_VERIFY_PROMPT,
    depends_on: evidenceIds.slice(),
    kind: 'verify',
    blind: true,
    autoInserted: true,
  };
}

/**
 * steps 模式：原地补一个对抗复核节点（幂等；已有任何 kind=verify 时不动）。
 * 插在最后一个证据步骤之后、第一个 report 之前；report 步骤补依赖 __verify__ 保证先复核再汇总。
 * @param {NormalizedWorkflow} norm
 * @returns {{injected:boolean,id:string|null,error?:string}}
 */
export function injectAdversarialVerify(norm) {
  if (!norm || norm.error || !Array.isArray(norm.steps)) return { injected: false, id: null };
  if (norm.steps.some((s) => String(s.kind || '').toLowerCase() === 'verify')) return { injected: false, id: null };
  const evidence = norm.steps.filter((s) => {
    const kind = String(s.kind || '').toLowerCase();
    if (kind === 'report' || kind === 'arbitrate') return false;
    return kind === 'find' || needsEvidence(s);
  }).map((s) => s.id);
  if (!evidence.length) return { injected: false, id: null };

  const taken = new Set(norm.steps.map((s) => s.id));
  const id = nextVerifyId(taken);
  // 在副本上插入并补依赖：若补验会成环（罕见：证据步骤反向依赖 report），直接放弃补验，不破坏原 DAG
  const steps = norm.steps.map((s) => ({ ...s, depends_on: s.depends_on.slice() }));
  const step = makeAdversarialVerifyStep(id, evidence);
  let pos = steps.findIndex((s) => s.id === evidence[evidence.length - 1]) + 1;
  const firstReport = steps.findIndex((s) => String(s.kind || '').toLowerCase() === 'report');
  if (firstReport >= 0 && firstReport <= pos) pos = firstReport;
  steps.splice(pos, 0, step);
  // report 必须先拿到复核结果：否则 DAG 里 report 与 verify 会并行
  for (const s of steps) {
    if (String(s.kind || '').toLowerCase() !== 'report') continue;
    if (!s.depends_on.includes(id)) s.depends_on.push(id);
  }
  const topo = topoLevels(steps);
  if (topo.error) return { injected: false, id: null, error: topo.error };
  norm.steps = steps;
  norm.levels = topo.levels;
  norm.byId = topo.byId;
  return { injected: true, id };
}

function claimHasVerifier(claim) {
  const vb = claim?.verifiedBy;
  if (typeof vb === 'string' && vb.trim()) return true;
  if (vb && typeof vb === 'object' && (String(vb.model || '').trim() || String(vb.stepId || '').trim())) return true;
  return (Array.isArray(claim?.verdicts) ? claim.verdicts : []).some((v) => (
    v && typeof v === 'object'
    && strOrEmpty(v.verdict).toLowerCase() === 'confirmed'
    && (strOrEmpty(v.model).trim() || strOrEmpty(v.stepId).trim())
  ));
}

function strOrEmpty(v) {
  return v === undefined || v === null ? '' : String(v);
}

/**
 * 报告闸（fail-closed）：复核缺失/失败/未覆盖的 claim 不得 confirmed。
 * 只降级 confirmed（pending 保持 pending，报告里按「未复核」标注），返回 warnings 与未复核 claim id。
 * @param {object} [opts]
 * @param {import('./swarm.mjs').SwarmClaim[]} [opts.claims]
 * @param {WorkflowStepResult[]} [opts.results]
 * @param {WorkflowStep[]} [opts.verifySteps]
 * @returns {{claims:Array, warnings:string[], unreviewed:string[]}}
 */
export function applyAdversarialGate({ claims = [], results = [], verifySteps = [] } = {}) {
  const warnings = [];
  const list = Array.isArray(claims) ? claims : [];
  const resultList = Array.isArray(results) ? results : [];
  const verifyResults = resultList.filter((r) => r && String(r.kind || '').toLowerCase() === 'verify');
  const hasVerifyStep = verifyResults.length > 0 || (Array.isArray(verifySteps) && verifySteps.length > 0);
  const effectiveVerify = verifyResults.some((r) => r.ok
    && !r.parseError
    && Array.isArray(r.verdicts)
    && r.verdicts.length > 0);
  if (list.length && hasVerifyStep && !effectiveVerify) {
    warnings.push(t('对抗复核未完成：verify 步骤失败、被跳过或没有给出任何有效 verdict，全部 claim 未经对抗复核'));
  }

  const out = list.map((raw) => {
    const claim = {
      ...raw,
      verdicts: Array.isArray(raw?.verdicts) ? [...raw.verdicts] : [],
    };
    const covered = claim.verdicts.length > 0;
    if (String(claim.status || '').toLowerCase() !== 'confirmed') return claim;
    if (!claimHasVerifier(claim)) {
      warnings.push(t('claim {id} 标为 confirmed 但缺少复核者（model/stepId），已降级为 lead', { id: claim.id }));
      claim.status = 'lead';
      claim.gate = [...(Array.isArray(claim.gate) ? claim.gate : []), 'missing-verifier'];
      return claim;
    }
    if (!covered) {
      warnings.push(t('claim {id} 标为 confirmed 但没有对抗复核覆盖（无 verdict），已降级为 lead', { id: claim.id }));
      claim.status = 'lead';
      claim.gate = [...(Array.isArray(claim.gate) ? claim.gate : []), 'unreviewed'];
    }
    return claim;
  });
  const unreviewed = out
    .filter((c) => !(Array.isArray(c.verdicts) && c.verdicts.length) && String(c.status || '').toLowerCase() !== 'rejected')
    .map((c) => String(c.id || t('(无 id)')));
  return { claims: out, warnings, unreviewed };
}

/**
 * 报告正文兜底：只要还有未复核 claim，就在报告尾部追加一条确定性脚注（含「未经对抗复核」字样）。
 * 只追加，不改模型正文；没有未复核 claim 时原样返回。
 * @param {string} [content]
 * @param {string[]} [unreviewed]
 * @returns {string}
 */
export function appendAdversarialReportNote(content, unreviewed = []) {
  const text = String(content || '');
  const ids = Array.isArray(unreviewed) ? unreviewed.filter(Boolean) : [];
  if (!text.trim() || !ids.length) return text;
  return `${text}\n\n> ${t('复核状态：claim {ids} 未经对抗复核（没有 verifier verdict），只能按「疑似/未复核」处理。', { ids: ids.join('、') })}`;
}

function applyReportNotes(results, unreviewed) {
  for (const r of Array.isArray(results) ? results : []) {
    const kind = String(r?.kind || r?.op || '').toLowerCase();
    if (kind !== 'report' || !r?.ok || !r.content) continue;
    r.content = appendAdversarialReportNote(r.content, unreviewed);
  }
}

/**
 * 纯函数：判定一步子代理结果是否可当成功。
 * - 需要取证的步骤（needsEvidence 为真）0 次工具调用 → 空转，失败。
 *   toolCountKnown=false 时（调用方没有测过工具次数，如旧测试的 mock）不做该项硬闸。
 * - report 允许 0 次工具调用，但正文至少 80 字，否则「汇总为空」。
 * - find/verify 的输出被 finish_reason=length 截断且 JSON 无法解析 → 取证不完整，失败。
 * @param {object} [opts]
 * @param {string|null} [opts.kind]
 * @param {string} [opts.content]
 * @param {number} [opts.toolCount]
 * @param {boolean} [opts.toolCountKnown]
 * @param {boolean} [opts.truncated]
 * @param {boolean} [opts.requiresTools]
 * @returns {{ok:boolean, error:string|null}}
 */
export function judgeSubagentOutcome({ kind = null, content = '', toolCount = 0, toolCountKnown = true, truncated = false, requiresTools = false } = {}) {
  const text = String(content || '').trim();
  const k = String(kind || '').trim().toLowerCase();
  if (requiresTools && toolCountKnown && Math.max(0, Math.trunc(Number(toolCount) || 0)) === 0) {
    return { ok: false, error: t('未产生任何工具调用：该步没有取证（疑似空转）') };
  }
  if (k === 'report' && text.length < 80) {
    return { ok: false, error: t('汇总为空：report 步骤内容不足 80 字（{n}）', { n: text.length }) };
  }
  if (truncated && (k === 'find' || k === 'verify')) {
    const parsed = parseAgentJson(text);
    if (parsed?.error) return { ok: false, error: t('输出被截断，取证不完整') };
  }
  return { ok: true, error: null };
}

/**
 * 可单测的子代理步进执行器（非流式 chat/completions）。
 * 与 index.mjs 的 callSubagent 等价：多轮工具调用、首轮强制 tool_choice、空转重试、收尾请求。
 * 依赖注入：fetchImpl / executeTool / 事件回调，测试可用本地 fake provider。
 *
 * 空转硬闸：需要取证的步骤第一轮纯文本（0 tool_calls）→ 追加 system 提醒重试 1 次；
 * 仍无工具调用 → 返回 error（「未产生任何工具调用…」），不让步骤变绿。
 * 网关兼容：tool_choice 触发 400/422 → 去掉该字段重试一次并记 warning。
 * 截断：finish_reason=length → truncated=true + warning；find/verify 且 JSON 解析失败 → failed。
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] chat/completions 的 base URL
 * @param {string} [opts.apiKey]
 * @param {string} [opts.model]
 * @param {string} [opts.name] 步骤展示名（needsEvidence 判定用）
 * @param {string} [opts.role]
 * @param {string} [opts.systemPrompt]
 * @param {string} [opts.prompt]
 * @param {string|null} [opts.kind] swarm 步骤类型（report/find/verify…）
 * @param {any[]} [opts.tools] OpenAI tools 定义
 * @param {((name:string, args:any)=>Promise<any>)|null} [opts.executeTool]
 * @param {boolean|null} [opts.requiresTools] 不传时走 needsEvidence
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.maxTools]
 * @param {number} [opts.stepBudgetMs]
 * @param {number} [opts.maxOutputTokens]
 * @param {number} [opts.temperature]
 * @param {AbortSignal|null} [opts.signal]
 * @param {typeof fetch} [opts.fetchImpl] 测试可注入 fake provider
 * @param {()=>number} [opts.now]
 * @param {Function|null} [opts.onSystem] system 提醒事件
 * @param {Function|null} [opts.onAssistant] assistant 文本/工具调用事件
 * @param {Function|null} [opts.onToolStart]
 * @param {Function|null} [opts.onToolEnd]
 * @returns {Promise<SubagentStepResult>}
 */
export async function runSubagentStep({
  baseUrl,
  apiKey,
  model,
  name = '',
  role = '',
  systemPrompt = '',
  prompt = '',
  kind = null,
  tools = [],
  executeTool = null,
  requiresTools = null,
  maxTurns = SUBAGENT_MAX_TURNS,
  maxTools = SUBAGENT_MAX_TOOLS,
  stepBudgetMs = SUBAGENT_STEP_BUDGET_MS,
  maxOutputTokens = SUBAGENT_MAX_OUTPUT_TOKENS,
  temperature = 0.3,
  signal = null,
  fetchImpl = fetch,
  now = Date.now,
  onSystem = null,
  onAssistant = null,
  onToolStart = null,
  onToolEnd = null,
} = {}) {
  const warnings = [];
  let toolCount = 0;
  let truncated = false;
  let truncationWarned = false;
  let finishReason = null;
  // 调用方没显式给 requiresTools 时走同一份 needsEvidence（名称/角色/任务语义 + kind + 工具名/路径）
  const requires = requiresTools === null || requiresTools === undefined
    ? needsEvidence({ kind, name, role, prompt })
    : !!requiresTools;
  const endpoint = String(baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}) };
  let messages = [
    { role: 'system', content: String(systemPrompt || '') },
    { role: 'user', content: String(prompt || '') }
  ];
  let toolChoiceUnsupported = false;

  const noteTruncation = (reason) => {
    if (reason !== 'length') return;
    truncated = true;
    if (!truncationWarned) {
      truncationWarned = true;
      warnings.push(SUBAGENT_TRUNCATED_WARNING);
    }
  };
  // 一次模型请求；tool_choice 被网关拒绝（400/422）时自动去掉该字段重试一次
  const chat = async (msgs, toolChoice, { withTools = true } = {}) => {
    /** @type {any} */
    const body = {
      model,
      messages: msgs,
      ...(withTools ? { tools } : {}),
      temperature,
      max_tokens: maxOutputTokens,
      stream: false
    };
    if (toolChoice && !toolChoiceUnsupported) body.tool_choice = toolChoice;
    let res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
    let text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!res.ok && (res.status === 400 || res.status === 422) && body.tool_choice) {
      delete body.tool_choice;
      toolChoiceUnsupported = true;
      warnings.push(t('网关不支持 tool_choice（HTTP {status}），已去掉该字段重试', { status: res.status }));
      res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
      text = await res.text();
      json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    }
    if (!res.ok) return { error: `HTTP ${res.status} ${String(json?.error?.message || text).slice(0, 160)}` };
    return { json };
  };

  const stepStart = now();
  let retriedForTools = false;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (now() - stepStart > stepBudgetMs || toolCount >= maxTools) break;
    const turnStartedAt = now();
    // 首轮（以及空转重试轮）强制必须调用工具；网关不支持时 chat() 会自动降级
    const forceRequired = requires && (turn === 0 || retriedForTools);
    messages = trimToolResults(messages); // 每次请求前压一遍上下文（transcript 里仍是原文）
    const r = await chat(messages, forceRequired ? 'required' : null);
    if (r.error) return { error: r.error, toolCount, truncated, warnings };
    const choice = r.json?.choices?.[0];
    const msg = choice?.message;
    finishReason = choice?.finish_reason ?? null;
    noteTruncation(finishReason);
    const calls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    const text = messageText(msg);
    if (!calls.length) {
      if (!text) {
        const judged = judgeSubagentOutcome({ kind, content: '', toolCount, requiresTools: requires });
        return { error: judged.error || '子代理没有返回内容', toolCount, truncated, warnings, finishReason };
      }
      // 需要取证却只回了一句话：追加 system 提醒再请求一次（最多 1 次）
      if (requires && toolCount === 0 && !retriedForTools) {
        retriedForTools = true;
        messages.push({ role: 'system', content: SUBAGENT_TOOL_RETRY_REMINDER });
        if (typeof onSystem === 'function') onSystem(SUBAGENT_TOOL_RETRY_REMINDER);
        continue;
      }
      const judged = judgeSubagentOutcome({ kind, content: text, toolCount, truncated, requiresTools: requires });
      if (!judged.ok) return { error: judged.error, toolCount, truncated, warnings, finishReason };
      if (typeof onAssistant === 'function') {
        onAssistant({
          content: text,
          toolCalls: [],
          reasoning: String(msg?.reasoning_content || msg?.reasoning || ''),
          ms: now() - turnStartedAt,
          final: true
        });
      }
      return { content: text, toolCount, truncated, warnings, finishReason };
    }
    messages.push({ role: 'assistant', content: msg?.content || '', tool_calls: calls });
    if (typeof onAssistant === 'function') {
      onAssistant({
        content: String(msg?.content || ''),
        toolCalls: calls.map((c) => ({ name: c?.function?.name, args: c?.function?.arguments })),
        reasoning: String(msg?.reasoning_content || msg?.reasoning || ''),
        ms: now() - turnStartedAt,
        final: false
      });
    }
    for (const call of calls) {
      const toolName = call?.function?.name;
      let args = {};
      try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { /* 参数坏了按空对象 */ }
      const toolStartedAt = now();
      const argsRaw = call?.function?.arguments || '';
      if (typeof onToolStart === 'function') onToolStart({ name: toolName, argsRaw });
      let out;
      try {
        out = typeof executeTool === 'function' ? await executeTool(toolName, args) : { error: '子代理不允许调用工具：' + toolName };
      } catch (e) {
        out = { error: e?.message || t('工具执行失败') };
      }
      toolCount += 1;
      const toolText = JSON.stringify(out ?? null).slice(0, 16000);
      messages.push({ role: 'tool', tool_call_id: call.id, content: toolText });
      if (typeof onToolEnd === 'function') {
        onToolEnd({ name: toolName, argsRaw, out, toolText, ms: now() - toolStartedAt });
      }
    }
  }

  // 工具轮次/时间用完：收掉工具，让子代理基于已有证据给结论
  messages.push({ role: 'user', content: '工具调用预算已用完（轮次或时间到上限）。请基于目前已经拿到的工具结果，直接输出本步骤的交付物（结论 + 证据），不要再请求工具；还没查完的部分如实标「未覆盖」。' });
  messages = trimToolResults(messages);
  const fin = await chat(messages, null, { withTools: false });
  if (fin.error) return { error: t('子代理收尾请求失败 {error}', { error: fin.error }), toolCount, truncated, warnings };
  const finChoice = fin.json?.choices?.[0];
  const finMsg = finChoice?.message;
  const finReason = finChoice?.finish_reason ?? null;
  noteTruncation(finReason);
  const finContent = messageText(finMsg);
  if (finContent) {
    const judged = judgeSubagentOutcome({ kind, content: finContent, toolCount, truncated, requiresTools: requires });
    if (!judged.ok) return { error: judged.error, toolCount, truncated, warnings, finishReason: finReason };
    if (typeof onAssistant === 'function') {
      onAssistant({
        content: finContent,
        toolCalls: [],
        reasoning: String(finMsg?.content ? (finMsg?.reasoning_content || '') : ''),
        ms: null,
        final: true
      });
    }
    return { content: finContent, toolCount, truncated, warnings, finishReason: finReason };
  }
  // 收尾没拿到正文：把最后一次 assistant 文本当部分结果带回，别让整步白跑
  const lastText = [...messages].reverse().find((m) => m.role === 'assistant' && String(m.content || '').trim())?.content;
  if (lastText) {
    const partial = String(lastText).trim();
    const judged = judgeSubagentOutcome({ kind, content: partial, toolCount, truncated, requiresTools: requires });
    if (!judged.ok) return { error: judged.error, toolCount, truncated, warnings, finishReason };
    if (typeof onAssistant === 'function') onAssistant({ content: partial, toolCalls: [], reasoning: '', ms: null, final: true });
    return { content: partial, toolCount, truncated, warnings, finishReason };
  }
  return { error: t('子代理用完工具轮次仍没有给出结论'), toolCount, truncated, warnings };
}

/**
 * 执行工作流（steps 模式或受限脚本 DSL 模式，二者互斥）。
 * @param {object} [opts]
 * @param {string} [opts.goal] 总目标
 * @param {any[]} [opts.steps] 步骤（与 script 互斥）
 * @param {any[]} [opts.script] 受限脚本 DSL（与 steps 互斥）：step/fanout/if/gate/verify/report/loop/recurse/aggregate
 * @param {CallStepFunction|null} [opts.callStep] 子代理调用
 * @param {number|null} [opts.concurrency] 并发上限（默认 14，clamp 1..32）
 * @param {number} [opts.maxSteps] 步骤上限（默认 14，clamp 1..64）
 * @param {RunControl|null} [opts.control] 运行中控制台 {paused, aborted, maxConcurrency}
 * @param {(snapshot: WorkflowSnapshot)=>void} [opts.onUpdate] 每次状态变化推一份快照
 * @param {object|string|null} [opts.resumeFrom] 断点 journal 对象，或 journalDir 下的 runId
 * @param {string|null} [opts.journalDir] journal 落盘目录；不传则不落盘（旧行为）
 * @param {Function|null} [opts.runGate] 程序闸执行器（gate/aggregate 用）
 * @param {string|null} [opts.projectPath] 程序闸未显式给 dir 时的默认项目目录
 * @returns {Promise<WorkflowRunResult|{error:string}>}
 */
export async function runWorkflow({
  goal,
  steps,
  script,
  callStep,
  concurrency = null,
  maxSteps,
  control = null,
  onUpdate,
  resumeFrom = null,
  journalDir = null,
  runGate = null,
  projectPath = null,
  verifyTimeoutMs = null,
} = {}) {
  const goalText = String(goal || '').trim();
  if (!goalText) return { error: t('goal 不能为空（整个工作流要达成的目标）') };
  if (steps !== undefined && steps !== null && script !== undefined && script !== null) {
    return { error: t('steps 与 script 互斥：一次只能给一个（steps 模式或受限脚本模式）') };
  }
  const scriptMode = script !== undefined && script !== null;
  const norm = scriptMode ? null : normalizeSteps(steps, { maxSteps, goal: goalText });
  if (!scriptMode && norm.error) return { error: norm.error };
  if (!scriptMode && typeof callStep !== 'function') return { error: t('当前通道不支持子代理调用') };
  // 默认强制对抗复核：有取证步骤且没有 verify 时，调度前自动补一个盲验节点
  if (!scriptMode) injectAdversarialVerify(norm);

  // ---- 断点 journal 准备（先于调度，避免跑到一半才发现 resumeFrom 不可用） ----
  const dir = journalDir == null ? null : String(journalDir).trim();
  let resumeJournal = null;
  if (typeof resumeFrom === 'string' && resumeFrom.trim()) {
    if (!dir) return { error: t('resumeFrom 传 runId 时必须同时提供 journalDir') };
    try {
      resumeJournal = await loadJournal(resumeFrom.trim(), { dir });
    } catch (e) {
      return { error: t('读取 journal 失败：{error}', { error: e?.message || e }) };
    }
    if (!resumeJournal) return { error: t('找不到 journal：{runId}', { runId: resumeFrom.trim() }) };
  } else if (resumeFrom && typeof resumeFrom === 'object') {
    try {
      resumeJournal = JSON.parse(JSON.stringify(resumeFrom));
    } catch {
      return { error: t('resumeFrom journal 无法序列化（需为纯 JSON 对象）') };
    }
    if (!resumeJournal || typeof resumeJournal !== 'object') resumeJournal = null;
    else if (!resumeJournal.steps || typeof resumeJournal.steps !== 'object' || Array.isArray(resumeJournal.steps)) resumeJournal.steps = {};
  }

  const startedAt = Date.now();
  const runId = resumeJournal && isValidRunId(resumeJournal.runId) ? resumeJournal.runId : runIdOf();
  /** @type {WorkflowJournal|null} */
  let journal = null;
  if (dir) {
    if (resumeJournal) {
      const jStarted = Number(resumeJournal.startedAt);
      journal = {
        version: JOURNAL_VERSION,
        runId,
        goal: goalText,
        startedAt: Number.isFinite(jStarted) ? jStarted : startedAt,
        finishedAt: null, // 恢复后先标「未完成」，真正结束再写 finishedAt
        stopped: false,
        steps: { ...resumeJournal.steps },
      };
    } else {
      journal = createJournal({ runId, goal: goalText, startedAt });
    }
  }

  /** @type {RunControl} */
  const ctl = control && typeof control === 'object' ? control : {};
  // 父级停止信号：control.aborted（用户点「停止」）时立即中断所有在跑的子代理；
  // 不设任何墙钟超时，signal 只用于用户停止 / 显式 budget.maxStepMs。
  const runAbort = new AbortController();
  // 并发步骤各自挂一个 stop 监听；放宽监听上限，避免默认 14 路并发时刷 MaxListenersExceeded 警告
  try { setMaxListeners(MAX_CONCURRENCY + 4, runAbort.signal); } catch { /* 环境不支持就保持默认 */ }
  const stepCall = typeof callStep === 'function' ? withStepDeadline(callStep, { signal: runAbort.signal }) : callStep;

  // 「停止工作流」按钮只把 ctl.aborted 置位；DSL 模式没有逐步检查 aborted 的机会，
  // 所以这里用轻量轮询把信号接到 runAbort，才能真正打断正在跑的子代理 HTTP 流。
  const stopWatch = setInterval(() => {
    if (ctl.aborted) { try { runAbort.abort(); } catch { /* 已中断 */ } }
  }, 200);
  stopWatch.unref?.();

  // ---- script 模式：交给受限脚本解释器（fanout 子节点并发跑；journal/stepHash/复用/claims 都沿用同一套） ----
  if (scriptMode) {
    const startLimit = clampInt(ctl.maxConcurrency, 1, SCRIPT_MAX_CONCURRENCY,
      clampInt(concurrency, 1, SCRIPT_MAX_CONCURRENCY, SCRIPT_DEFAULT_CONCURRENCY));
    try {
      return await (/** @type {any} */ (runScriptWorkflow))({
        goal: goalText,
        script,
        callStep: stepCall,
        runGate: typeof runGate === 'function' ? runGate : null,
        projectPath,
        journal,
        resumeJournal,
        dir,
        runId,
        startedAt,
        control: ctl,
        concurrency: startLimit,
        onUpdate,
        verifyTimeoutMs: resolveVerifyTimeoutMs(verifyTimeoutMs),
      });
    } finally {
      clearInterval(stopWatch);
    }
  }

  const fallbackLimit = clampInt(concurrency, 1, MAX_CONCURRENCY, DEFAULT_CONCURRENCY);
  const limitOf = () => clampInt(ctl.maxConcurrency, 1, MAX_CONCURRENCY, fallbackLimit); // 运行中可改（clamp 1-32）
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 可复用步骤：直接置 success，不调用 callStep ----
  const reuseInfo = resumeJournal ? computeReuse(resumeJournal, norm, goalText) : { reusable: new Set(), reasons: {} };
  /** @type {Map<string, WorkflowStepResult>} */
  const results = new Map();
  /** @type {Map<string, WorkflowStepState>} */
  const state = new Map(norm.steps.map((s) => [s.id, { status: 'pending', reused: false, startedAt: null, ms: null, error: null, tools: 0 }]));
  const finished = new Set();
  const journalDone = new Set(); // 本次 run 已经写进 journal（或复用了旧且 hash 匹配记录）的步骤

  // ---- swarm claim 池：find 产出，verify/arbitrate 改状态 ----
  /** @type {import('./swarm.mjs').SwarmClaim[]} */
  const claimsStore = [];
  /** @param {WorkflowStep} step @returns {import('./swarm.mjs').SwarmClaim[]} */
  const claimsForStep = (step) => {
    if (!step?.kind) return [];
    if (step.targetsFrom) return claimsStore.filter((c) => c.sourceStep === step.targetsFrom);
    if (step.kind === 'verify') {
      const direct = new Set(step.depends_on);
      const scoped = claimsStore.filter((c) => c.sourceStep && direct.has(c.sourceStep));
      return scoped.length ? scoped : claimsStore.slice();
    }
    return claimsStore.slice();
  };
  /** @param {import('./swarm.mjs').SwarmClaim[]} updated */
  const mergeClaimUpdates = (updated) => {
    for (const c of updated) {
      const idx = claimsStore.findIndex((x) => x.id === c.id);
      if (idx >= 0) claimsStore[idx] = c;
    }
  };
  // 解析并落地一个 swarm 步骤的输出；解析失败不判步骤失败，只记 parseError
  /** @param {WorkflowStep} step @param {WorkflowStepResult} result @param {string} content */
  const ingestStep = (step, result, content) => {
    if (!step?.kind || !content) return;
    if (step.kind === 'report') {
      const holeList = collectHoles(results);
      result.holes = holeList.map((h) => h.id);
      result.reportWarnings = lintReport(content, { holes: holeList }); // 报告是 Markdown，不走 JSON 解析
      result.reportLintOk = result.reportWarnings.length === 0;
      result.delivered = result.ok && result.reportLintOk;
      return;
    }
    const parsed = parseAgentJson(content);
    if (parsed?.error) {
      result.parseError = parsed.error;
      return;
    }
    const data = parsed;
    if (step.kind === 'recon') {
      const targets = Array.isArray(data?.targets) ? data.targets : [];
      result.targets = targets.map((tg, i) => ({
        id: String(tg?.id || `t${i + 1}`),
        path: String(tg?.path || ''),
        risk: ['high', 'medium', 'low'].includes(tg?.risk) ? tg.risk : 'medium',
        reason: String(tg?.reason || ''),
      }));
      return;
    }
    if (step.kind === 'find') {
      const findings = Array.isArray(data?.findings) ? data.findings : [];
      const produced = collectClaims([{ id: step.id, claims: findings }]);
      for (const c of produced) {
        if (claimsStore.some((x) => x.id === c.id)) {
          const base = `${c.id}~${step.id}`;
          let id = base;
          let n = 2;
          while (claimsStore.some((x) => x.id === id)) { id = `${base}~${n}`; n += 1; }
          c.id = id;
        }
        claimsStore.push(c);
      }
      result.claims = produced.map((c) => ({ ...c, verdicts: [...c.verdicts] }));
      if (!findings.length) result.claimsEmpty = true;
      return;
    }
    if (step.kind === 'verify') {
      const verdicts = Array.isArray(data?.verdicts) ? data.verdicts : [];
      result.verdicts = verdicts;
      const scope = claimsForStep(step);
      const updated = applyVerdicts(scope, verdicts, {
        model: result.model || step.model || 'default',
        providerId: result.providerId || step.providerId || null,
        stepId: step.id,
      });
      mergeClaimUpdates(updated);
      const known = new Set(scope.map((c) => c.id));
      const unmatched = verdicts
        .map((v) => String(v?.claimId ?? v?.id ?? '').trim())
        .filter((id) => id && !known.has(id));
      if (unmatched.length) result.unmatchedVerdicts = unmatched;
      if (!verdicts.length) result.verdictsEmpty = true;
      return;
    }
    if (step.kind === 'arbitrate') {
      const decisions = Array.isArray(data?.decisions) ? data.decisions : [];
      result.decisions = decisions;
      const unmatched = [];
      for (const d of decisions) {
        const claimId = String(d?.claimId ?? d?.id ?? '').trim();
        const finalRaw = String(d?.final ?? '').trim().toLowerCase();
        const final = ['confirmed', 'rejected', 'uncertain'].includes(finalRaw) ? finalRaw : 'uncertain';
        const idx = claimId ? claimsStore.findIndex((c) => c.id === claimId) : -1;
        if (idx < 0) {
          unmatched.push(claimId || t('(空 claimId)'));
          continue;
        }
        const current = { ...claimsStore[idx], verdicts: [...(claimsStore[idx].verdicts || [])] };
        // 没有 verify 覆盖（没有任何 verdict）时仲裁不能把 claim 抬成 confirmed
        const hasCoverage = current.verdicts.length > 0;
        const effective = final === 'confirmed' && !hasCoverage ? 'uncertain' : final;
        current.status = effective === 'confirmed' ? 'confirmed' : (effective === 'rejected' ? 'rejected' : 'lead');
        current.arbitrated = true;
        current.arbitration = {
          final,
          quote: String(d?.quote ?? ''),
          reason: String(d?.reason ?? ''),
          stepId: step.id,
          ...(effective !== final ? { downgraded: t('没有 verify 覆盖，confirmed 降为 lead') } : {}),
        };
        if (effective === 'confirmed' && (!current.verifiedBy || !current.verifiedBy.model)) {
          current.verifiedBy = {
            model: result.model || step.model || 'default',
            providerId: result.providerId || step.providerId || null,
            stepId: step.id,
          };
        }
        claimsStore[idx] = current;
      }
      if (unmatched.length) result.unmatchedDecisions = unmatched;
      return;
    }
  };

  for (const s of norm.steps) {
    if (!reuseInfo.reusable.has(s.id)) continue;
    const js = resumeJournal.steps[s.id] || {};
    const content = clipStoredContent(String(js.content || '').trim());
    const fullOutputPath = await existingNodeOutputPath(dir, runId, s.id);
    const ms = Number.isFinite(Number(js.ms)) ? Number(js.ms) : 0;
    const tools = Number.isFinite(Number(js.tools)) ? Number(js.tools) : 0;
    const stepStartedAt = Number.isFinite(Number(js.startedAt)) ? Number(js.startedAt) : null;
    state.set(s.id, { status: 'success', reused: true, startedAt: stepStartedAt, ms, error: null, errorCode: null, tools });
    results.set(s.id, {
      id: s.id,
      name: s.name,
      role: s.role,
      depends_on: s.depends_on,
      ok: true,
      error: null,
      errorCode: null,
      content,
      ms,
      tools,
      reused: true,
      kind: s.kind || null,
      model: s.model || null,
      providerId: s.providerId || null,
      ...(fullOutputPath ? { fullOutputPath } : {}),
      ...(s.autoInserted ? { autoInserted: true } : {}),
    });
    finished.add(s.id);
    if (journal) journalDone.add(s.id); // 旧记录 hash 与当前一致，保留即可
  }
  // 复用步骤的输出也要重建 claim 状态：先 find（产出），再 verify/arbitrate/report（消费）
  const reusedKindSteps = [];
  for (const level of norm.levels) {
    for (const id of level) {
      const step = norm.byId.get(id);
      const r = results.get(id);
      if (step?.kind && r?.reused) reusedKindSteps.push(step);
    }
  }
  for (const step of reusedKindSteps) {
    if (step.kind === 'find') ingestStep(step, results.get(step.id), results.get(step.id).content);
  }
  for (const step of reusedKindSteps) {
    if (step.kind !== 'find') ingestStep(step, results.get(step.id), results.get(step.id).content);
  }

  // 本次表示方式（卡片徽标 + 一句人话）：DAG 的步骤数 / 拓扑层数
  const dagModeReason = norm.levels.length <= 1
    ? t('{n} 个步骤，互不依赖并行执行', { n: norm.steps.length })
    : t('{n} 个步骤，按依赖分 {levels} 层并行', { n: norm.steps.length, levels: norm.levels.length });

  /** @param {boolean} running @returns {WorkflowSnapshot} */
  const snapshot = (running) => ({
    kind: 'workflow',
    runId,
    goal: goalText,
    running,
    paused: !!ctl.paused,
    startedAt,
    ms: Date.now() - startedAt,
    concurrency: limitOf(),
    mode: 'dag',
    modeReason: dagModeReason,
    phases: norm.levels, // 拓扑层级：UI 按「阶段」横向排布
    steps: norm.steps.map((s) => {
      const mine = claimsStore.filter((c) => c.sourceStep === s.id);
      return {
        id: s.id,
        name: s.name,
        role: s.role,
        depends_on: s.depends_on,
        ...state.get(s.id),
        kind: s.kind || null,
        claims: mine.length,
        confirmed: mine.filter((c) => c.status === 'confirmed').length,
      };
    }),
  });
  const notify = (running) => { try { onUpdate?.(snapshot(running)); } catch { /* UI 推送失败不影响执行 */ } };
  notify(true);

  // ---- journal 调度外写盘：串行化写入，失败只 warning，绝不影响调度 ----
  let finalized = false;
  /** @type {Promise<any>} */
  let saveChain = Promise.resolve();
  const warnJournal = (e) => {
    try { console.warn('[workflow] journal 写入失败：' + (e?.message || e)); } catch { /* 忽略 */ }
  };
  const queueJournalSave = () => {
    if (!journal || !dir) return saveChain;
    saveChain = saveChain.then(() => saveJournal(journal, { dir })).catch(warnJournal);
    return saveChain;
  };

  const runningMap = new Map(); // id → promise
  let stopped = false;

  /** @param {string} id */
  const runOne = async (id) => {
    const step = norm.byId.get(id);
    if (step.autoInserted && String(step.kind || '').toLowerCase() === 'verify') {
      // 自动补验：先把无 kind 证据步骤产出的 findings 收进 claim 池（旧步骤也能被复核）
      const synthetic = collectClaims(step.depends_on
        .map((d) => results.get(d))
        .filter((r) => r && !['find', 'verify', 'report'].includes(String(r.kind || '').toLowerCase())));
      for (const c of synthetic) {
        if (claimsStore.some((x) => x.id === c.id)) {
          let base = `${c.id}~${c.sourceStep || 'synthetic'}`;
          let n = 2;
          while (claimsStore.some((x) => x.id === base)) { base = `${base}~${n}`; n += 1; }
          c.id = base;
        }
        claimsStore.push(c);
      }
      // 只有「上游全空 + 无 claims」才允许跳过；上游有正文时即使没有结构化 claim 也跑盲验红队
      const upstream = step.depends_on.map((d) => results.get(d)).filter(Boolean);
      const hasUpstreamText = upstream.some((r) => String(r.content || '').trim() && !r.salvaged);
      if (!claimsForStep(step).length && !hasUpstreamText) {
        state.set(id, { status: 'success', reused: false, skipped: true, startedAt: null, ms: 0, error: null, tools: 0 });
        finished.add(id);
        notify(true);
        return;
      }
    }
    const t0 = Date.now();
    state.set(id, { status: 'running', reused: false, startedAt: t0, ms: null, error: null, tools: 0 });
    notify(true);
    // 有 kind 走对抗验证提示词（blind 时只给 claims + 证据指针），否则保持旧 prompt 完全不变
    let prompt;
    let upstream = [];
    if (step.kind) {
      const upstreamIds = new Set(step.depends_on);
      if (step.targetsFrom) upstreamIds.add(step.targetsFrom);
      upstream = [...upstreamIds].map((d) => results.get(d)).filter(Boolean);
      const claims = claimsForStep(step);
      // 自动补验且没有结构化 claim：上游正文就是被审查对象，必须注入（不能因 blind 被裁掉）
      prompt = String(step.kind || '').toLowerCase() === 'verify' && !claims.length
        ? buildUpstreamOnlyVerifyPrompt({ goal: goalText, step, upstream })
        : buildSwarmPrompt({ goal: goalText, step, upstream, claims });
      if (String(step.kind || '').toLowerCase() === 'report') {
        prompt = appendVerifyConclusions(prompt, upstream);
        // 失败/中断节点的洞清单必须进 report prompt：报告不能只汇总成功分支。
        const holesSection = buildHolesPromptSection(collectHoles(results));
        if (holesSection) prompt = `${prompt}\n\n${holesSection}`;
      }
    } else {
      prompt = buildPrompt(goalText, step, results);
    }
    let out;
    try {
      out = await stepCall({
        id: step.id,
        name: step.name,
        role: step.role,
        prompt,
        // 原始 name（可能为空）：下游 callSubagent 用它判定「要不要取证」，展示名不参与执行语义
        originalName: step.originalName === undefined ? null : step.originalName,
        depends_on: step.depends_on,
        runId, // 子代理 transcript 按 run 落盘（重开 App 后还能回看）
        // 预算透传：maxStepMs 缺省为 0（不设墙钟上限）；盲验节点例外，默认 60 分钟硬截止
        budget: step.budget && typeof step.budget === 'object'
          ? step.budget
          : { maxStepMs: isVerifyStep(step) ? resolveVerifyTimeoutMs(verifyTimeoutMs) : SUBAGENT_STEP_TIMEOUT_MS },
        kind: step.kind || null,
        model: step.model || null,
        providerId: step.providerId || null,
        blind: step.kind ? !!step.blind : null,
      });
    } catch (e) {
      out = { error: e?.message || t('子代理调用失败') };
    }
    let content = String(out?.content || '').trim();
    const originalEmpty = !content;
    const ms = Date.now() - t0;
    const toolCountKnown = typeof out?.toolCount === 'number' && Number.isFinite(out.toolCount);
    const toolCount = toolCountKnown ? Math.max(0, Math.trunc(out.toolCount)) : 0;
    // 工作流层兜底闸：callStep 明确报告了 0 次工具调用时，取证步骤不能算成功（UI 不准变绿）
    // 与子代理内部（tool_choice / 空转重试 / judgeSubagentOutcome）共用同一份 needsEvidence，避免两套规则漂移
    const requiresTools = needsEvidence(step);
    const stepWarnings = Array.isArray(out?.warnings) ? out.warnings.map(String) : [];
    const truncated = !!out?.truncated;
    const aborted = !!out?.cancelled || !!out?.interrupted || String(out?.errorCode || '').trim() === 'INTERRUPTED';
    let salvaged = false;
    let salvageReason = null;
    // 失败节点不能只剩一个 error：中断/空回复用 transcript 做确定性 salvage（不调模型）。
    if (!step.program && (!content || isSalvageText(content) || out?.salvaged)) {
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
    const judged = judgeSubagentOutcome({
      kind: step.kind,
      content,
      toolCount,
      toolCountKnown,
      truncated,
      requiresTools
    });
    // 中断/空回复即使 salvage 出了正文，也必须失败（ok 不能翻绿）
    const ok = !out?.error && !originalEmpty && judged.ok && !aborted;
    let error = out?.error || judged.error || (originalEmpty ? t('子代理没有返回内容') : null);
    if (aborted) error = out?.error || t('子代理被中断');
    // 结构化错误码：与 script 模式同一套口径（复用 swarm.mjs 的纯函数，不在此另写映射）；
    // 成功步骤为 null，失败步骤随快照/结果行/journal 透传给卡片 chip
    const errorCode = ok ? null : (
      aborted
        ? 'INTERRUPTED'
        : (String(out?.errorCode || '').trim() || deriveNodeErrorCode({
          program: !!step.program,
          errorText: out?.error || '',
          // 用原始正文判定：salvage 正文不能让 EMPTY_CONTENT 变成 STEP_FAIL
          content: out?.content || '',
          toolCount,
          toolCountKnown,
          truncated,
          requiresTools,
        }))
    );
    // 完整正文先落盘（dir=workflow-runs 根目录；拿不到 dir/runId 或写盘失败时静默跳过），
    // 内存里只留 MAX_STORED_CONTENT 字并带截断标记；下游按 fullOutputPath 读取全文。
    const fullOutputPath = await writeNodeOutput(dir, runId, step.id, content);
    const storedContent = clipStoredContent(content);
    state.set(id, {
      status: ok ? 'success' : 'failed',
      reused: false,
      startedAt: t0,
      ms,
      error,
      errorCode,
      tools: toolCount,
      toolCount,
      finishReason: out?.finishReason || null,
      roundsUsed: Number.isFinite(out?.roundsUsed) ? out.roundsUsed : null,
      truncated: !!out?.truncated,
      warnings: stepWarnings,
      ...(salvaged ? { salvaged: true, salvageReason } : {}),
      ...(ok ? {} : { hole: true })
    });
    const result = {
      id: step.id,
      name: step.name,
      role: step.role,
      depends_on: step.depends_on,
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
      warnings: stepWarnings,
      reused: false,
      kind: step.kind || null,
      model: String(out?.model || step.model || '') || null,
      providerId: String(out?.providerId || step.providerId || '') || null,
      ...(fullOutputPath ? { fullOutputPath } : {}),
      ...(step.autoInserted ? { autoInserted: true } : {}),
      ...(salvaged ? { salvaged: true, salvageReason } : {}),
      ...(ok ? {} : { hole: true }),
    };
    results.set(id, result);
    if (step.kind && ok) ingestStep(step, result, content);
    if (journal && !finalized) {
      recordStep(journal, step, {
        hash: stepHash(goalText, step),
        status: ok ? 'success' : 'failed',
        content: storedContent, // 失败节点也留正文：重开 App/续跑时可审阅
        error,
        errorCode,
        ms,
        tools: toolCount,
        startedAt: t0,
        finishedAt: Date.now(),
      });
      journalDone.add(id);
      queueJournalSave(); // 不 await：写盘慢/失败都不阻塞调度
    }
    finished.add(id);
    notify(true);
  };

  // 调度器：依赖就绪 + 有空位就起；暂停时不再起新子代理（已在跑的继续跑完），恢复后接着起
  while (true) {
    if (ctl.aborted) { stopped = true; try { runAbort.abort(); } catch { /* 已中断 */ } break; }
    if (!ctl.paused) {
      const ready = norm.steps.filter((s) => !finished.has(s.id) && !runningMap.has(s.id) && s.depends_on.every((d) => finished.has(d)));
      const slots = limitOf() - runningMap.size;
      for (const s of ready.slice(0, Math.max(0, slots))) {
        const p = runOne(s.id).catch(() => { finished.add(s.id); }).finally(() => { runningMap.delete(s.id); });
        runningMap.set(s.id, p);
      }
    }
    const left = norm.steps.filter((s) => !finished.has(s.id));
    if (!left.length) break;
    if (!runningMap.size) {
      const readyLeft = left.filter((s) => s.depends_on.every((d) => finished.has(d)));
      if (!readyLeft.length) break; // 上游全失败导致依赖无法满足
      if (ctl.paused) { notify(true); await sleep(200); continue; }
    }
    await Promise.race([...runningMap.values(), sleep(150)]);
  }
  if (stopped) {
    for (const s of norm.steps) {
      if (state.get(s.id)?.status === 'pending') state.set(s.id, { ...state.get(s.id), status: 'cancelled' });
    }
  }

  // ---- 整体结束/停止：补齐未执行步骤、写 finishedAt/stopped ----
  const finishedAt = Date.now();
  if (journal) {
    finalized = true; // 之后仍在飞的 runOne 不再改 journal（本次 run 已经返回）
    for (const s of norm.steps) {
      if (journalDone.has(s.id)) continue;
      const st = /** @type {WorkflowStepState} */ (state.get(s.id) || {});
      const status = st.status === 'success' ? 'success' : (st.status === 'failed' ? 'failed' : 'cancelled');
      recordStep(journal, s, {
        hash: stepHash(goalText, s),
        status,
        content: status === 'success' ? String(results.get(s.id)?.content || '') : '',
        error: status === 'success' ? null : (st.error || (stopped ? t('工作流已停止') : t('未执行（上游失败或依赖不可达）'))),
        errorCode: status === 'success' ? null : (st.errorCode || null),
        ms: st.ms || 0,
        tools: st.tools || 0,
        startedAt: st.startedAt || 0,
        finishedAt: st.startedAt && st.ms ? st.startedAt + st.ms : finishedAt,
      });
    }
    journal.finishedAt = finishedAt;
    journal.stopped = !!stopped;
    await queueJournalSave(); // 等所有排队写入结束（内部已 catch，失败不影响返回）
  }

  // ---- claim lint + 对抗复核报告闸（fail-closed）+ claims 落盘 ----
  const linted = lintClaims(claimsStore);
  const gate = applyAdversarialGate({
    claims: linted.claims,
    results: [...results.values()],
    verifySteps: norm.steps.filter((s) => String(s.kind || '').toLowerCase() === 'verify'),
  });
  claimsStore.length = 0;
  claimsStore.push(...gate.claims);
  const claimWarnings = linted.warnings;
  const warnings = [...claimWarnings, ...gate.warnings];
  let claimsFile = null;
  if (dir && claimsStore.length) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const target = path.join(dir, `${runId}.claims.jsonl`);
      await fs.writeFile(target, claimsToJsonl(claimsStore), 'utf8');
      claimsFile = target;
    } catch (e) {
      warnJournal(e);
    }
  }

  // 按原始顺序输出（便于模型和 UI 阅读），不按完成顺序
  const ordered = norm.steps.map((s) => results.get(s.id)).filter(Boolean);
  applyReportNotes(ordered, gate.unreviewed);
  notify(false);
  clearInterval(stopWatch);
  return {
    runId,
    goal: goalText,
    mode: 'dag',
    modeReason: dagModeReason,
    steps: norm.steps.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      depends_on: s.depends_on,
      ...(s.kind ? { kind: s.kind } : {}),
      ...(s.autoInserted ? { autoInserted: true } : {}),
    })),
    results: ordered,
    ok: ordered.every((r) => r.ok),
    stopped,
    ms: Date.now() - startedAt,
    claims: claimsStore.map((c) => ({ ...c, verdicts: [...(c.verdicts || [])] })),
    claimWarnings,
    warnings,
    claimsFile,
    summary: ordered.map((r) => `${r.id} ${r.name}: ${r.ok
      ? t('完成')
      : (r.errorCode
        ? t('失败（{code} · {label}）', { code: r.errorCode, label: errorCodeLabel(r.errorCode) })
        : t('失败（{error}）', { error: r.error }))}`).join('\n'),
  };
}
