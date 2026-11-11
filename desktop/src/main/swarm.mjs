// @ts-check
// 对抗验证协议（swarm）：
// 把「侦察 → 取证 → 盲验 → 仲裁 → 报告」落成可被 workflow 引擎调用的纯函数集合。
// 本模块不调度、不调模型，只负责提示词、JSON 解析、claim 状态流转与 lint。
//
// claim 状态机：
//   find 产出            → pending
//   verify confirmed     → confirmed（必须带 verifiedBy/model）
//   verify uncertain     → lead
//   verify rejected      → rejected
//   arbitrate             → 按 decisions.final 落地（uncertain 同样落 lead）
//   lint                  → 缺 evidence 或 confirmed 缺验证者时降 lead

// 双语：错误码人话与 lint 警告是用户可见文案，按当前界面语言输出（zh 原文不变）
import { t } from '../renderer/i18n/core.mjs';

/**
 * 原始 swarm 步骤输入（steps 模式里用户/模型给的字段，全部可缺席）。
 * @typedef {object} SwarmStepInput
 * @property {string} [kind] recon | find | verify | arbitrate | report
 * @property {string} [model]
 * @property {string} [providerId]
 * @property {string} [prompt] 子代理任务文本（原样保留，只 trim）
 * @property {string} [role] 子代理角色
 * @property {boolean|number|string} [blind] 是否屏蔽上游正文；verify/arbitrate 默认 true
 * @property {string} [targetsFrom] 只消费该步骤产出的 claims
 */

/**
 * normalizeSwarmStep 的返回：kind 必填，其余字段缺席即保持旧格式。
 * @typedef {object} SwarmStep
 * @property {string} kind
 * @property {string} [model]
 * @property {string} [providerId]
 * @property {string} [prompt]
 * @property {string} [role]
 * @property {boolean} blind
 * @property {string} [targetsFrom]
 */

/**
 * verify 步骤的一条 verdict 输入（模型 JSON 或测试构造）。
 * @typedef {object} SwarmVerdictInput
 * @property {string} [claimId]
 * @property {string} [id] claimId 的别名
 * @property {string} [verdict] confirmed | rejected | uncertain
 * @property {string} [evidence]
 * @property {string|null} [note]
 */

/**
 * 落进 claim.verdicts 的一条历史裁决记录。
 * @typedef {object} SwarmVerdictRecord
 * @property {string} verdict
 * @property {string} [evidence]
 * @property {string|null} [note]
 * @property {string|null} [stepId]
 * @property {string|null} [model]
 * @property {string|null} [providerId]
 */

/**
 * 复核者标识（verify/arbitrate 落地时写入）。
 * @typedef {object} SwarmVerifier
 * @property {string|null} model
 * @property {string|null} providerId
 * @property {string|null} stepId
 */

/**
 * 一条可复核结论（claim）的完整状态。find 产出 status='pending'，
 * verify/arbitrate 改 confirmed/rejected/lead，lint 可把缺证据/缺复核者的降级。
 * @typedef {object} SwarmClaim
 * @property {string} id
 * @property {string} claim
 * @property {string} evidence
 * @property {string} severity high | medium | low
 * @property {string|null} file
 * @property {number|null} line
 * @property {boolean} reproduced
 * @property {string} status pending | lead | confirmed | rejected
 * @property {string|null} sourceStep
 * @property {SwarmVerifier|null} verifiedBy
 * @property {SwarmVerdictRecord[]} verdicts
 * @property {string|null} note
 * @property {boolean} arbitrated
 * @property {string|null} [verifiedEvidence]
 * @property {SwarmVerifier} [rejectedBy]
 * @property {SwarmVerifier} [reviewedBy]
 * @property {boolean} [conflict]
 * @property {string[]} [lint]
 * @property {string[]} [gate]
 * @property {string} [model]
 * @property {{final:string, quote:string, reason:string, stepId:string, downgraded?:string}} [arbitration]
 */

/**
 * find 步骤的一条原始 finding（模型输出 JSON 的一项）。
 * @typedef {object} SwarmFinding
 * @property {string} [id]
 * @property {string} [claimId]
 * @property {string} [claim]
 * @property {string} [evidence]
 * @property {string} [severity]
 * @property {string|null} [file]
 * @property {number|string|null} [line]
 * @property {boolean} [reproduced]
 */

/**
 * arbitrate 步骤的一条最终决定（模型输出 JSON 的一项）。
 * @typedef {object} SwarmDecision
 * @property {string} [claimId]
 * @property {string} [id]
 * @property {string} [final] confirmed | rejected | uncertain
 * @property {string} [quote]
 * @property {string} [reason]
 */

/**
 * 上游步骤结果里 swarm 会读取的字段（workflow results Map 的一项子集）。
 * @typedef {object} SwarmUpstreamResult
 * @property {string} [id]
 * @property {string} [name]
 * @property {string} [kind]
 * @property {boolean} [ok]
 * @property {string} [error]
 * @property {string} [content]
 * @property {string} [fullOutputPath]
 * @property {any[]} [targets]
 * @property {SwarmClaim[]} [claims]
 * @property {SwarmVerdictInput[]} [verdicts]
 */

/**
 * 报告 lint 的失败节点（洞）：Not covered 必须逐条点名。
 * @typedef {object} ReportHole
 * @property {string} [id]
 * @property {string} [name]
 */

/**
 * 验收单条目（todo_write）：报告闸只看 status / evidence / id / task。
 * @typedef {object} TodoGateItem
 * @property {string} [id]
 * @property {string} [task]
 * @property {string} [acceptance]
 * @property {'pending'|'running'|'done'|'failed'|'skipped'} [status]
 * @property {string} [evidence]
 */

/**
 * claim lint 的返回。
 * @typedef {object} ClaimLintResult
 * @property {SwarmClaim[]} claims
 * @property {string[]} warnings
 */

/**
 * deriveNodeErrorCode 的输入：一次失败节点执行的摘要。
 * @typedef {object} NodeErrorInput
 * @property {boolean} [program] gate/aggregate 等程序节点
 * @property {string} [errorText] callStep 返回的 error 文本
 * @property {string} [content] 子代理正文
 * @property {number} [toolCount]
 * @property {boolean} [toolCountKnown]
 * @property {boolean} [truncated]
 * @property {boolean} [requiresTools]
 */

export const STEP_KINDS = ['recon', 'find', 'verify', 'arbitrate', 'report'];

/**
 * 子代理交付纪律（所有 swarm/脚本节点共用）。
 * 目的：即使最后被用户中断或网关断流，transcript 里也要留下可复核的阶段性结论，
 * 不能出现「跑了 74 次工具、20 分钟，最后一句正文都没有」的空白交付。
 */
export const DELIVERY_DISCIPLINE = [
  '交付纪律（每个工具批次结束后都必须执行，违反即视为交付不完整）：',
  '- 每完成一批工具调用，先把本批已确认的阶段性结论/清单/证据指针写进回复正文，再继续下一批；不要把所有内容攒到最后一条消息。',
  '- 收尾必须给出可交付物：「结论 / 清单 / 证据」三者至少有一项，并注明证据来源（文件路径、命令输出或 claimId）。',
  '- 若任务尚未完成，最后一条消息也要写清「已完成什么、还缺什么、下一步准备做什么」，不得只写「继续中」或空回复。',
  '- 即使即将被中断，也要先把当前进度写成正文；transcript 里已有的工具结果和推理会被系统保留为中断存档。',
].join('\n');

// 工作流子代理可用工具（与 index.mjs 共用同一份清单，避免两处漂移）。
// 放开除 run_workflow（禁止嵌套工作流，防指数放大）与 remember_project（记忆只由主 agent 写）之外的全部工具。
// edit_file / write_file 仍走现有 permissions 审批，子代理能改但改不了「静默改」。
export const SUBAGENT_TOOL_NAMES = [
  'audit_project', 'quality_gate', 'download_gate', 'probe_target', 'stress_target',
  'get_report', 'list_playbooks', 'read_playbook', 'read_file', 'edit_file',
  'write_file', 'present_artifact', 'run_command', 'review_diff'
];
export const SUBAGENT_TOOL_DENIED = ['run_workflow', 'remember_project'];

/**
 * 该步骤是否必须产生真实工具调用（0 次调用即判空转）。
 * - find / verify：取证/复现步骤，没有工具结果就没有证据。
 * - 其余步骤：prompt 里点名了可用工具，或出现盘符绝对路径（D:\ / C:/）。
 * - report 汇总步骤明确允许 0 次工具调用（由调用方传 requiresTools=false）。
 * 注意 Windows 路径必须同时匹配反斜杠：旧正则只匹配 `D:/`，漏掉了 `D:\`。
 * @param {string|null} [kind]
 * @param {string|null} [prompt]
 * @param {string[]} [toolNames]
 * @returns {boolean}
 */
export function stepRequiresToolEvidence(kind, prompt, toolNames = SUBAGENT_TOOL_NAMES) {
  const k = String(kind || '').trim().toLowerCase();
  if (k === 'report') return false;
  if (k === 'find' || k === 'verify') return true;
  const text = String(prompt || '');
  const names = Array.isArray(toolNames) ? toolNames : SUBAGENT_TOOL_NAMES;
  if (names.some((n) => n && text.includes(n))) return true;
  return /[A-Za-z]:[\\/]/.test(text);
}

const SEVERITIES = ['high', 'medium', 'low'];
const VERDICTS = ['confirmed', 'rejected', 'uncertain'];
const REPORT_SECTIONS = ['Conclusion', 'Findings', 'Verified', 'Not covered', 'Skipped'];
// 报告硬规则：没有对抗复核者的 claim 不得写成「已确认」。steps 模式写进 buildSwarmPrompt，
// script 模式的 report 由 workflow-script 追加到 ask 里（两处共用同一句，避免措辞漂移）。
export const REPORT_ADVERSARIAL_RULE = '只有带复核者（verifiedBy.model 或 verifiedBy.stepId）的 claim 才能写「已确认」；其余 claim 一律写「疑似/未复核」，不得使用「已确认」「已验证」等字样。';

const MAX_PROMPT_BLOCK = 3600;

function str(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function clip(text, max = MAX_PROMPT_BLOCK) {
  const s = str(text);
  return s.length > max ? `${s.slice(0, max)}\n…[已截断]` : s;
}

function safeJson(value, max = MAX_PROMPT_BLOCK) {
  let s;
  try {
    s = JSON.stringify(value);
  } catch {
    s = 'null';
  }
  if (s === undefined) s = 'null';
  return s.length > max ? `${s.slice(0, max)}…[已截断]` : s;
}

function normalizeBool(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw new Error(`${name} 必须是布尔值`);
}

/**
 * 校验并规范化一个 swarm 步骤。
 * 未知 kind / 类型不对直接抛错（由 normalizeSteps 转成 { error }）。
 * prompt / role 是子代理的任务文本与角色，必须原样保留（只 trim），否则 buildSwarmPrompt 只剩空任务。
 * blind：verify / arbitrate 默认 true，其余默认 false。
 * @param {SwarmStepInput} [step]
 * @returns {SwarmStep}
 */
export function normalizeSwarmStep(step = {}) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('步骤必须是对象');
  const rawKind = step.kind === undefined || step.kind === null ? '' : String(step.kind).trim().toLowerCase();
  const kind = rawKind || 'find';
  if (!STEP_KINDS.includes(kind)) throw new Error(`未知步骤 kind：${rawKind || '(空)'}（可选 ${STEP_KINDS.join(' / ')}）`);

  const out = { kind };
  for (const key of ['model', 'providerId']) {
    const value = step[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new Error(`步骤 ${key} 必须是字符串`);
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }

  // 任务文本与角色必须原样保留：buildSwarmPrompt 的「本步骤任务」靠它们拼接。
  // 这里只做 trim，不用空串兜底覆盖，缺席的旧步骤保持无字段（输出维持旧格式）。
  for (const key of ['prompt', 'role']) {
    const value = step[key];
    if (value === undefined || value === null) continue;
    const trimmed = str(value).trim();
    if (trimmed) out[key] = trimmed;
  }

  const defaultBlind = kind === 'verify' || kind === 'arbitrate';
  out.blind = normalizeBool(step.blind, defaultBlind, 'blind');

  if (step.targetsFrom !== undefined && step.targetsFrom !== null) {
    if (typeof step.targetsFrom !== 'string') throw new Error('targetsFrom 必须是步骤 id 字符串');
    const trimmed = step.targetsFrom.trim();
    if (trimmed) out.targetsFrom = trimmed;
  }
  return /** @type {SwarmStep} */ (out);
}

function upstreamList(upstream) {
  if (upstream instanceof Map) return [...upstream.values()].filter((r) => r && typeof r === 'object');
  if (Array.isArray(upstream)) return upstream.filter((r) => r && typeof r === 'object');
  return [];
}

function renderUpstream(upstream) {
  const list = upstreamList(upstream);
  if (!list.length) return '';
  return list.map((r) => {
    const head = `### 上游步骤 ${str(r.id, '(未知)')}${r.name ? `（${r.name}）` : ''}${r.kind ? ` [${r.kind}]` : ''}的结果`;
    const body = r.ok === false ? `[失败] ${str(r.error, '无结果')}` : str(r.content).trim();
    const outputHint = r.fullOutputPath ? `\n\n完整输出：${r.fullOutputPath}（可用 read_file 读取）` : '';
    return `${head}\n${body}${outputHint}`;
  }).join('\n\n');
}

function targetsOf(upstream) {
  const out = [];
  for (const r of upstreamList(upstream)) {
    if (Array.isArray(r.targets)) {
      out.push(...r.targets);
      continue;
    }
    if (!r.content) continue;
    const parsed = parseAgentJson(r.content);
    if (!parsed.error && Array.isArray(parsed.targets)) out.push(...parsed.targets);
  }
  return out;
}

function claimsAsInput(claims, { withEvidence = true } = {}) {
  const list = Array.isArray(claims) ? claims : [];
  return list.map((c) => {
    const item = {
      id: str(c.id),
      claim: str(c.claim),
      severity: c.severity || 'medium',
      file: c.file ?? null,
      line: c.line ?? null,
      reproduced: !!c.reproduced,
    };
    if (withEvidence) item.evidence = str(c.evidence);
    return item;
  });
}

function evidencePointers(claims) {
  const list = Array.isArray(claims) ? claims : [];
  if (!list.length) return '（无 claim，无需验证）';
  return list.map((c) => {
    const file = c.file ? str(c.file) : '(未注明文件)';
    const line = c.line ? `:${c.line}` : '';
    const extra = c.evidence ? `；证据：${clip(c.evidence, 240)}` : '；证据：缺失';
    return `- ${str(c.id, '(无 id)')} → ${file}${line}${extra}`;
  }).join('\n');
}

function conflictsOf(claims) {
  const list = Array.isArray(claims) ? claims : [];
  const out = [];
  for (const c of list) {
    let history = Array.isArray(c.verdicts) ? c.verdicts : [];
    if (!history.length && c.verdict) history = [c.verdict];
    const normalized = history.map((v) => {
      if (typeof v === 'string') return { verdict: v };
      const verdict = str(v?.verdict).trim();
      return { ...v, verdict };
    }).filter((v) => v.verdict);
    const distinct = new Set(normalized.map((v) => v.verdict));
    if (distinct.size < 2) continue;
    out.push({
      claimId: str(c.id),
      claim: str(c.claim),
      positions: normalized.map((v) => ({
        source: str(v.stepId || v.model || 'verify'),
        verdict: v.verdict,
        evidence: clip(v.evidence, 900),
        note: clip(v.note, 400),
      })),
    });
  }
  return out;
}

function claimsSummary(claims) {
  const list = Array.isArray(claims) ? claims : [];
  if (!list.length) return '（本轮没有任何 claim）';
  return list.map((c) => {
    const where = c.file ? ` @ ${str(c.file)}${c.line ? `:${c.line}` : ''}` : '';
    const verifier = c.verifiedBy && c.verifiedBy.model ? ` verifiedBy=${c.verifiedBy.model}` : '';
    return `- ${str(c.id, '(无 id)')} [${str(c.status, 'pending')}] ${clip(c.claim, 500)}${where}${verifier}`;
  }).join('\n');
}

function header(goal, step) {
  return [
    `总目标：${goal}`,
    step.role ? `你的角色：${step.role}` : '',
    `本步骤任务：${step.prompt || ''}`,
  ].filter(Boolean).join('\n');
}

const OUTPUT_RULE = '只输出一个 JSON 对象，不要 markdown 围栏，不要解释，不要寒暄，不要任何额外文字。';

/**
 * 按 kind 生成对抗验证提示词。
 * verify / arbitrate 默认 blind=true：上游 content 一律不注入，只给 claims JSON 与证据指针。
 * @param {object} [opts]
 * @param {string} [opts.goal] 整个工作流的总目标
 * @param {SwarmStepInput|SwarmStep} [opts.step] 本步骤（内部会再 normalize 一次）
 * @param {Iterable<SwarmUpstreamResult>|SwarmUpstreamResult[]} [opts.upstream] 上游步骤结果
 * @param {SwarmClaim[]} [opts.claims] 待验证/待汇总的 claim 池
 * @returns {string}
 */
export function buildSwarmPrompt({ goal, step, upstream = [], claims = [] } = {}) {
  const s = normalizeSwarmStep(step || {});
  const goalText = str(goal).trim() || '（未提供总目标）';
  const upstreamBlock = s.blind ? '' : renderUpstream(upstream);
  const task = header(goalText, s);
  const parts = [task];

  if (s.kind === 'recon') {
    if (upstreamBlock) parts.push(upstreamBlock);
    parts.push([
      '你是侦察步骤（recon）。先列出值得检查的攻击面/风险点，不做结论。',
      OUTPUT_RULE,
      '输出格式：',
      '{"targets":[{"id":"t1","path":"仓库相对路径","risk":"high|medium|low","reason":"为什么值得查"}]}',
      '硬规则：',
      '- path 必须是你在仓库里实际看到过的路径，猜的路径不要写。',
      '- 每个 target 必须同时有 path、risk、reason；没有理由的目标不要写。',
      '- 目标控制在 3-15 个，按 risk 从高到低排序。',
      '- id 用 t1、t2… 稳定编号，后续步骤会引用。',
    ].join('\n'));
  } else if (s.kind === 'find') {
    const targets = targetsOf(upstream);
    if (!s.blind && targets.length) parts.push(`侦察目标（只作为线索，不能当成结论）：\n${safeJson(targets, 2000)}`);
    if (upstreamBlock) parts.push(upstreamBlock);
    parts.push([
      '你是取证步骤（find）。针对目标逐条取证，只写能在仓库里复现的结论。',
      OUTPUT_RULE,
      '输出格式：',
      '{"findings":[{"id":"f1","claim":"一句话结论","evidence":"可复现的原始证据（命令+关键输出，或代码原文+文件:行）","severity":"high|medium|low","file":"仓库相对路径","line":42,"reproduced":true}]}',
      '硬规则（违反即无效）：',
      '- 没有证据就不要写。每条 finding 都必须附原始证据，不能只写“我检查过了”“应该是”。',
      '- evidence 必须是原始命令/输出或代码原文；不允许改写、概括或编造输出。',
      '- claim 必须是你亲自读代码或亲自运行命令确认过的；没确认就写 reproduced: false 并降级，或干脆不写。',
      '- file 用仓库相对路径；line 写实际行号，无法确定写 null。',
      '- 不猜测、不写没有验证过的结论，也不要把 recon 的线索直接抄成 finding。',
      '- 除 JSON 外不要输出任何文字。',
    ].join('\n'));
  } else if (s.kind === 'verify') {
    const input = { claims: claimsAsInput(claims) };
    parts.push('你是对抗复核步骤（verify / 红队）。默认怀疑上游每一条结论：先问「这条 claim 会在什么情况下不成立」，再逐条亲自复现。你在核实别人的结论，必须独立复现，不能相信发现者的描述。');
    if (upstreamBlock) parts.push(upstreamBlock);
    parts.push([
      '输入只有下面这份 claims JSON 和证据指针；除此之外的任何叙述、结论、置信度都不可信。',
      `待验证 claims：\n${safeJson(input)}`,
      `证据指针：\n${evidencePointers(claims)}`,
      '硬规则（违反即无效）：',
      '- 第一步：对每条 claim 先列出它在什么情况下会不成立/失败（反例、边界、前提），再动手复现；',
      '- 禁止引用发现者的叙述、结论、置信度或“已验证”声明；只能依据证据指针自己读代码/跑命令。',
      '- 禁止拿上游的描述或推理当证据：证据只能是你亲自读到的代码原文，或你亲自跑出的命令输出。',
      '- 必须独立复现：对每条 claim 亲自执行命令或读对应文件:行，不能靠推断、常识或“看起来合理”。',
      '- 无法复现的 claim 一律判 uncertain；确实被反例推翻的判 rejected（rejected 是允许且必要的结论）；禁止猜 confirmed。',
      '- confirmed 必须给出你亲自复现得到的原始输出/代码摘要；rejected 必须指出与 claim 冲突的具体证据。',
      '- 不要遗漏任何 claimId；每个输入 claim 都要有一条 verdict。',
      OUTPUT_RULE,
      '输出格式：',
      '{"verdicts":[{"claimId":"f1","verdict":"confirmed|rejected|uncertain","evidence":"你亲自复现得到的原始输出/代码摘要","note":"简短说明"}]}',
    ].join('\n'));
  } else if (s.kind === 'arbitrate') {
    const conflicts = conflictsOf(claims);
    parts.push('你是仲裁步骤（arbitrate）。存在互相冲突的结论，你要以原文证据裁决，禁止多数票。');
    if (upstreamBlock) parts.push(upstreamBlock);
    parts.push([
      '冲突清单（只依据这里的 verdict 与证据裁决）：',
      `{"conflicts":${safeJson(conflicts)}}`,
      '硬规则（违反即无效）：',
      '- 每条决定必须逐字引用原文或命令输出；quote 必须是可在仓库/命令输出里精确找到的原文片段，不许改写或概括。',
      '- 禁止多数票：票数、模型数量、发现者人数都不构成证据。',
      '- 只依据可复核的原文/输出；无法复核的冲突一律判 uncertain。',
      '- 同一个 claimId 只给一条最终决定；不得遗漏冲突清单里的 claimId。',
      '- 没有冲突时输出 {"decisions":[]}，不要虚构冲突。',
      OUTPUT_RULE,
      '输出格式：',
      '{"decisions":[{"claimId":"f1","final":"confirmed|rejected|uncertain","quote":"逐字原文/命令输出","reason":"为什么这样裁决"}]}',
    ].join('\n'));
  } else if (s.kind === 'report') {
    if (upstreamBlock) parts.push(upstreamBlock);
    parts.push([
      '你是报告步骤（report）。把本轮全部 claims 与裁决汇总成最终报告，不得新增未经验证的结论。',
      `claims 清单：\n${claimsSummary(claims)}`,
      '必须且只能使用以下五段（标题一字不差，顺序固定，不得增删章节）：',
      '## Conclusion',
      '## Findings',
      '## Verified',
      '## Not covered',
      '## Skipped',
      '硬规则：',
      '- 五段必须全部出现；没有任何内容的段落写 None，不能留空。',
      '- Findings 只列 confirmed 与 lead/pending，并标注未验证状态；rejected 不得写成发现。',
      '- Verified 只列有独立复现证据的条目：claimId + 证据指针。',
      `- ${REPORT_ADVERSARIAL_RULE}`,
      '- Not covered 写本轮明确没覆盖的范围或残留风险。',
      '- Skipped 必须写明跳过项和原因（为什么跳过）；没有跳过写 None。',
      '- 引用 claim 一律用 claimId，不要编造证据、不要改写数字。',
      '- 除这五段报告外不要输出任何额外内容。',
    ].join('\n'));
  }

  // 交付纪律对所有步骤生效：哪怕最后一条消息不是最终报告，也必须留下可复核的进度。
  parts.push(DELIVERY_DISCIPLINE);
  return parts.filter(Boolean).join('\n\n');
}

/** 找到文本里第一个完整、可解析的 JSON（对象或数组）；忽略围栏与前后叙述。 */
function firstJsonValue(text) {
  scan: for (let start = 0; start < text.length; start += 1) {
    const ch = text[start];
    if (ch !== '{' && ch !== '[') continue;
    const close = ch === '{' ? '}' : ']';
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
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') {
        depth -= 1;
        if (depth === 0) {
          if (c !== close) continue scan; // 括号类型不匹配：换下一个起点
          const raw = text.slice(start, i + 1);
          try {
            return { ok: true, value: JSON.parse(raw) };
          } catch {
            continue scan; // 这一段不是合法 JSON：继续找后面的起点
          }
        }
        if (depth < 0) continue scan;
      }
    }
  }
  return { ok: false };
}

/**
 * 解析子代理输出里的 JSON：先去 ```json / ``` 围栏，再取第一个完整 JSON。
 * 失败返回 { error }，绝不抛错。
 * @param {string} text 子代理原始输出
 * @returns {any} 解析出的 JSON 对象/数组，或 { error: string }
 */
export function parseAgentJson(text) {
  if (typeof text !== 'string') return { error: '内容不是字符串' };
  const raw = text.replace(/^\uFEFF/, '');
  const trimmed = raw.trim();
  if (!trimmed) return { error: '内容为空' };

  const fenced = [];
  const re = /```(?:json|JSON|js|javascript)?\s*([\s\S]*?)```/g;
  for (const m of trimmed.matchAll(re)) {
    const body = m[1].trim();
    if (body) fenced.push(body);
  }
  const candidates = [...fenced, trimmed];
  for (const candidate of candidates) {
    const found = firstJsonValue(candidate);
    if (found.ok) return found.value;
  }
  return { error: '没有找到合法 JSON' };
}

function normalizeFinding(raw, { sourceStep = null, index = 0 } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawId = str(r.id ?? r.claimId).trim();
  const id = rawId || `c${index + 1}`;
  const severity = SEVERITIES.includes(r.severity) ? r.severity : 'medium';
  const lineNum = Number(r.line);
  return {
    id,
    claim: str(r.claim).trim(),
    evidence: str(r.evidence).trim(),
    severity,
    file: r.file === undefined || r.file === null || !str(r.file).trim() ? null : str(r.file).trim(),
    line: Number.isFinite(lineNum) && lineNum > 0 ? Math.trunc(lineNum) : null,
    reproduced: !!r.reproduced,
    status: 'pending', // find 产出永远是 pending，只有 verify/arbitrate 能改
    sourceStep: sourceStep === null ? null : str(sourceStep),
    verifiedBy: null,
    verdicts: [],
    note: null,
    arbitrated: false,
  };
}

function uniqueId(taken, base, sourceStep) {
  let id = base;
  if (!taken.has(id)) return id;
  const scoped = sourceStep ? `${base}~${sourceStep}` : `${base}~2`;
  if (!taken.has(scoped)) return scoped;
  let n = 2;
  while (taken.has(`${scoped}~${n}`)) n += 1;
  return `${scoped}~${n}`;
}

/**
 * 汇总多步产出里的 findings。
 * results 可以是 workflow 的 results Map，也可以是数组；优先用 result.claims，没有则从 content 解析。
 * 返回的 claim 全部 status='pending'，并带 sourceStep。
 * @param {Iterable<SwarmUpstreamResult>|Map<string, SwarmUpstreamResult>|SwarmUpstreamResult[]} [results]
 * @returns {SwarmClaim[]}
 */
export function collectClaims(results) {
  const list = results instanceof Map
    ? [...results.values()]
    : (Array.isArray(results) ? results : []);
  const out = [];
  const taken = new Set();
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    let findings = Array.isArray(r.claims) ? r.claims : null;
    if (!findings && typeof r.content === 'string' && r.content.trim()) {
      const parsed = parseAgentJson(r.content);
      if (!parsed.error && Array.isArray(parsed.findings)) findings = parsed.findings;
    }
    if (!findings) continue;
    const sourceStep = r.id === undefined || r.id === null ? null : str(r.id);
    for (const [i, raw] of findings.entries()) {
      const claim = normalizeFinding(raw, { sourceStep, index: i });
      claim.id = uniqueId(taken, claim.id, sourceStep);
      taken.add(claim.id);
      out.push(claim);
    }
  }
  return out;
}

/**
 * 把 verify 的 verdict 应用到 claims。
 * confirmed → status='confirmed'（记录 verifiedBy）；
 * uncertain → status='lead'；rejected → status='rejected'。
 * 没有 verdict 覆盖的 claim 保持原状（find 默认 pending）。
 * @param {SwarmClaim[]} claims
 * @param {SwarmVerdictInput[]} verdicts
 * @param {{model?: string|null, providerId?: string|null, stepId?: string|null}} [opts]
 * @returns {SwarmClaim[]}
 */
export function applyVerdicts(claims, verdicts, { model = null, providerId = null, stepId = null } = {}) {
  const list = Array.isArray(claims) ? claims : [];
  const incoming = Array.isArray(verdicts) ? verdicts : [];
  const byId = new Map();
  for (const v of incoming) {
    if (!v || typeof v !== 'object') continue;
    const claimId = str(v.claimId ?? v.id).trim();
    if (!claimId) continue;
    const verdict = VERDICTS.includes(str(v.verdict).trim().toLowerCase()) ? str(v.verdict).trim().toLowerCase() : 'uncertain';
    byId.set(claimId, {
      claimId,
      verdict,
      evidence: str(v.evidence).trim(),
      note: v.note === undefined || v.note === null ? null : str(v.note),
    });
  }

  return list.map((raw) => {
    const claim = raw && typeof raw === 'object' ? { ...raw } : normalizeFinding({}, {});
    claim.verdicts = Array.isArray(raw?.verdicts) ? raw.verdicts.map((x) => (typeof x === 'object' ? { ...x } : x)) : [];
    const v = byId.get(str(claim.id));
    if (!v) {
      if (!claim.status) claim.status = 'pending';
      return claim;
    }
    const verifiedBy = {
      model: model === null || model === undefined || !str(model).trim() ? null : str(model).trim(),
      providerId: providerId === null || providerId === undefined || !str(providerId).trim() ? null : str(providerId).trim(),
      stepId: stepId === null || stepId === undefined ? null : str(stepId),
    };
    const record = {
      verdict: v.verdict,
      evidence: v.evidence,
      note: v.note,
      stepId: verifiedBy.stepId,
      model: verifiedBy.model,
      providerId: verifiedBy.providerId,
    };
    claim.verdicts.push(record);
    claim.verifiedEvidence = v.evidence || claim.verifiedEvidence || null;
    claim.note = v.note ?? claim.note ?? null;
    if (v.verdict === 'confirmed') {
      claim.status = 'confirmed';
      claim.verifiedBy = claim.verifiedBy && claim.verifiedBy.model ? claim.verifiedBy : verifiedBy;
    } else if (v.verdict === 'rejected') {
      claim.status = 'rejected';
      claim.rejectedBy = verifiedBy;
    } else {
      claim.status = 'lead';
      claim.reviewedBy = verifiedBy;
    }
    const distinct = new Set(claim.verdicts.map((x) => x.verdict));
    claim.conflict = distinct.size > 1;
    return claim;
  });
}

/**
 * claim lint：缺 evidence → 降 lead；confirmed 但没有 verifiedBy/model → 降 lead。
 * 返回 { claims, warnings }，不抛错。
 * @param {SwarmClaim[]} claims
 * @returns {ClaimLintResult}
 */
export function lintClaims(claims) {
  const warnings = [];
  const out = [];
  const list = Array.isArray(claims) ? claims : [];
  list.forEach((raw, i) => {
    const claim = raw && typeof raw === 'object'
      ? { ...raw, verdicts: Array.isArray(raw.verdicts) ? [...raw.verdicts] : [] }
      : normalizeFinding({}, { index: i });
    if (!str(claim.id).trim()) claim.id = `c${i + 1}`;
    if (!claim.status) claim.status = 'pending';

    const evidence = str(claim.evidence).trim();
    if (!evidence) {
      warnings.push(t('claim {id} 缺少 evidence，已降级为 lead', { id: claim.id }));
      claim.status = 'lead';
      claim.lint = [...(Array.isArray(claim.lint) ? claim.lint : []), 'missing-evidence'];
    }

    if (claim.status === 'confirmed') {
      const vb = claim.verifiedBy;
      const hasVerifier = (typeof vb === 'string' && vb.trim())
        || (vb && typeof vb === 'object' && str(vb.model).trim())
        || str(claim.model).trim();
      if (!hasVerifier) {
        warnings.push(t('claim {id} 标为 confirmed 但缺少 verifiedBy/model，已降级为 lead', { id: claim.id }));
        claim.status = 'lead';
        claim.lint = [...(Array.isArray(claim.lint) ? claim.lint : []), 'missing-verifier'];
      }
    }
    out.push(claim);
  });
  return { claims: out, warnings };
}

function parseReportSections(md) {
  const text = str(md).replace(/\r\n/g, '\n');
  const sections = new Map();
  const order = [];
  const lines = text.split('\n');
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current === null) return;
    sections.set(current, buffer.join('\n').trim());
    buffer = [];
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.*?)\s*$/);
    if (m) {
      flush();
      current = m[1].trim();
      order.push(current);
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return { sections, order };
}

function isNoneBody(body) {
  return /^none\.?$/i.test(str(body).trim());
}

/**
 * 报告 lint：五段齐全、空段必须写 None、Skipped 要写原因；顺序不对也给 warning。
 * 有失败节点（holes）时，## Not covered 必须逐条点名；缺一个即 lint 失败（写入 warnings，
 * 调用方据此把 reportLintOk 置 false，不能靠放宽本函数让测试过）。
 * 返回 warnings 数组，不抛错。
 * @param {string} md 报告 Markdown
 * @param {{holes?: ReportHole[]}} [opts] 失败/中断节点（洞）清单
 * @returns {string[]}
 */
export function lintReport(md, { holes = [] } = {}) {
  const warnings = [];
  const { sections, order } = parseReportSections(md);
  if (!sections.size) warnings.push(t('报告为空：缺少全部五个段落'));
  for (const name of REPORT_SECTIONS) {
    if (!sections.has(name)) {
      warnings.push(t('缺少段落 ## {name}', { name }));
      continue;
    }
    const body = sections.get(name).trim();
    if (!body) {
      warnings.push(t('段落 ## {name} 为空（空段必须写 None）', { name }));
      continue;
    }
    if (name === 'Skipped' && !isNoneBody(body)) {
      const hasReason = /原因|因为|由于|reason|because|：|:|—|-/.test(body);
      if (!hasReason) warnings.push(t('段落 ## Skipped 未写明跳过原因'));
    }
  }
  // 失败/中断节点必须在 Not covered 点名：这是「没找到」与「根本没看」的分界线。
  const holeList = Array.isArray(holes) ? holes.filter(Boolean) : [];
  const notCovered = sections.get('Not covered') || '';
  const missing = holeList.filter((h) => {
    const id = String(h?.id || '').trim();
    const name = String(h?.name || '').trim();
    if (!id && !name) return false;
    return !(id && notCovered.includes(id)) && !(name && notCovered.includes(name));
  });
  if (missing.length) {
    const labels = missing.map((h) => {
      const id = String(h?.id || '').trim();
      const name = String(h?.name || '').trim();
      if (id && name && id !== name) return `${name}（${id}）`;
      return name || id;
    });
    warnings.push(t('段落 ## Not covered 未点名失败节点：{labels}（有失败节点时缺一个即 lint 失败）', { labels: labels.join('、') }));
  }
  const present = order.filter((name) => REPORT_SECTIONS.includes(name));
  const expected = REPORT_SECTIONS.filter((name) => present.includes(name));
  if (present.length === expected.length && present.some((name, i) => name !== expected[i])) {
    warnings.push(t('段落顺序不对，应为 {order}', { order: REPORT_SECTIONS.map((n) => `## ${n}`).join(' → ') }));
  }
  return warnings;
}

/**
 * 验收单（todo_write）→ 报告闸。与 lintReport 并列：非空 warnings 即「报告不合格」。
 * 两条硬规则：
 * - status=done 的条目必须带 evidence（没有证据的「做完了」不算数）；
 * - status=failed / skipped 的条目必须在 ## Not covered 里点名（id 或 task），
 *   否则读者会把「没做」误当「没发现」。
 * 返回 warnings 数组，不抛错；没有验收单（items 为空）时恒为空。
 * @param {string} md 最终回答 / 报告 Markdown
 * @param {{items?: TodoGateItem[]}} [opts] 本回合的验收单台账
 * @returns {string[]}
 */
export function lintTodoReport(md, { items = [] } = {}) {
  const warnings = [];
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) return warnings;
  const { sections } = parseReportSections(md);
  const notCovered = sections.get('Not covered') || '';
  const label = (/** @type {TodoGateItem} */ it) => {
    const id = String(it?.id || '').trim();
    const task = String(it?.task || '').trim();
    if (id && task) return `${task}（${id}）`;
    return task || id;
  };

  const doneNoEvidence = list.filter((it) => it.status === 'done' && !String(it.evidence || '').trim());
  if (doneNoEvidence.length) {
    warnings.push(t('验收单里有 {n} 条标为 done 但没有证据：{labels}（先补 evidence 再交报告）', {
      n: doneNoEvidence.length,
      labels: doneNoEvidence.map(label).join('、')
    }));
  }

  const unfinished = list.filter((it) => it.status === 'failed' || it.status === 'skipped');
  const missing = unfinished.filter((it) => {
    const id = String(it?.id || '').trim();
    const task = String(it?.task || '').trim();
    return !(id && notCovered.includes(id)) && !(task && notCovered.includes(task));
  });
  if (missing.length) {
    warnings.push(t('验收单里失败/跳过的任务未在 ## Not covered 点名：{labels}（缺一个即判不合格）', {
      labels: missing.map(label).join('、')
    }));
  }
  return warnings;
}

/**
 * claim 数组 → JSONL（每行一个 claim，末行带换行）。
 * @param {SwarmClaim[]} [claims]
 * @returns {string}
 */
export function claimsToJsonl(claims) {
  const list = Array.isArray(claims) ? claims : [];
  if (!list.length) return '';
  return `${list.map((c) => JSON.stringify(c)).join('\n')}\n`;
}

// ---------- 结构化错误码（工作流失败节点的机器可读分类，随 result 行/快照/报告透传） ----------
// 纯函数：workflow-script 的 executeNode 失败路径调用 deriveNodeErrorCode，
// renderer 的 TraceCards 调 errorCodeLabel 做展示；两处共用这一份映射，避免文案漂移。

/** 从错误文本里提取 HTTP 状态码 → "HTTP 429"；没有返回 null。兼容 "HTTP/1.1 502" 与无空格写法。
 * @param {string} [text]
 * @returns {string|null}
 */
export function extractHttpErrorCode(text) {
  const m = String(text || '').match(/HTTP(?:\/\d(?:\.\d)?)?\s*(\d{3})\b/i);
  return m ? `HTTP ${m[1]}` : null;
}

/**
 * 纯函数：从一次失败节点执行里推导结构化错误码。
 * 优先级（与 executeNode 的失败原因一一对应）：
 *   1. out.error 里带 HTTP 状态码      → "HTTP 429"（网关类错误，最具体）
 *   2. 程序节点（gate/aggregate）失败   → "GATE_FAIL"（程序节点没有工具计数，不参与空转判定）
 *   3. 调用本身没报错、判定器判失败时：
 *      - 需要取证但 0 次工具调用        → "NO_TOOLS"（与 judgeSubagentOutcome 的空转硬闸同条件）
 *      - content 为空                  → "EMPTY_CONTENT"
 *      - out.truncated                 → "TRUNCATED"
 *   4. 其余（out.error 有内容但没有码、判定器没给原因等）→ "STEP_FAIL"
 * 说明：out.error 一旦有内容，judgeSubagentOutcome 就不会被执行（executeNode 里
 * ok = !out?.error && …），所以此时不能拿空转/空内容当失败原因，只能兜底 STEP_FAIL。
 * 成功节点不调用本函数（调用方直接给 null）。
 * @param {NodeErrorInput} [opts]
 * @returns {string}
 */
export function deriveNodeErrorCode({
  program = false,
  errorText = '',
  content = '',
  toolCount = 0,
  toolCountKnown = true,
  truncated = false,
  requiresTools = false,
} = {}) {
  const http = extractHttpErrorCode(errorText);
  if (http) return http;
  // 网关静默（连续 N 秒零字节，重试用尽）：比通用 STEP_FAIL 更具体，DAG/DSL 失败节点直接带出
  if (String(errorText || '').includes('静默')) return 'STALL';
  if (program) return 'GATE_FAIL';
  // 用户停止/父级 abort：与「连接被重置」等普通失败区分开（后者仍走 STEP_FAIL）
  if (/子代理被中断|子代理超时\/被中断|已中断（用户停止）|运行被中断/.test(String(errorText || ''))) return 'INTERRUPTED';
  if (!String(errorText || '').trim()) {
    if (requiresTools && toolCountKnown && Math.max(0, Math.trunc(Number(toolCount) || 0)) === 0) return 'NO_TOOLS';
    if (!String(content || '').trim()) return 'EMPTY_CONTENT';
    if (truncated) return 'TRUNCATED';
  }
  return 'STEP_FAIL';
}

const ERROR_CODE_LABELS = new Map([
  ['HTTP 429', '网关限流（稍后自动重试）'],
  ['HTTP 502', '网关过载'],
  ['HTTP 503', '网关过载'],
  ['HTTP 504', '网关超时'],
  ['HTTP 408', '网关超时'],
  ['HTTP 402', '余额/套餐不足'],
  ['HTTP 401', 'Key 无效或无权限'],
  ['HTTP 403', 'Key 无效或无权限'],
  ['STALL', '网关无响应（静默超时）'],
  ['NO_TOOLS', '子代理空转（0 次工具）'],
  ['EMPTY_CONTENT', '没有返回内容'],
  ['INTERRUPTED', '已中断（用户停止）'],
  ['TRUNCATED', '输出被截断'],
  ['GATE_FAIL', '程序闸失败'],
  ['VERIFY_TIMEOUT', '复核超时未完成'],
]);

/** 错误码 → 一句人话；没有映射的码（含未知 HTTP 码）一律「步骤失败」。
 * @param {string|null} [code]
 * @returns {string}
 */
export function errorCodeLabel(code) {
  const key = String(code || '').trim();
  if (!key) return t('步骤失败');
  return t(ERROR_CODE_LABELS.get(key) || '步骤失败');
}
