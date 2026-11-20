// Agent 服务：OpenAI 兼容 /chat/completions + tools 循环（DESKTOP-ACCEPTANCE §5）
// 安全边界由主进程 assertAllowedTarget 把守，这里只管协议与循环
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assembleContext, estimateTokens, estimateMessagesTokens, microcompact, planFold, fullCompact, contextBudget, needsCompaction } from './context.mjs';
import { KEEP_RECENT_MODEL_COMPACT } from './in-turn-compact.mjs';
import { readChatText } from './summarize-core.mjs';
export { readChatText };
import { compactZone, splitByTurns, lastCoveredCallIdOf, isRealUserText, isPinnedSystem } from './compact.mjs';
import { crossTurnBudgetTokens } from './model-config.mjs';
import { GREP_CODE_SCHEMA, TODO_CC_RULES_TEXT } from './agent-tools.mjs';
// token 估算/两级压缩原语实现放在 context.mjs（与上下文视图同源）；这里重新导出，单测可直接从 agent-service 取
export { estimateTokens, estimateMessagesTokens, microcompact, fullCompact, contextBudget } from './context.mjs';
import { loadCatalog, loadSkills, renderCatalog } from '../../../src/playbooks.mjs';
import { runHookEvent } from './hooks.mjs';
import { SUBAGENT_TOOL_NAMES, deriveNodeErrorCode } from './swarm.mjs';
// 中断/空回复的确定性 salvage：与 workflow 层共用同一份文案（不调模型、不烧 token）
import { salvageSubagentContent } from './subagent-salvage.mjs';
import { extractUsage } from './usage.mjs';
import { t } from '../renderer/i18n/core.mjs';

/**
 * 供应商可调字段透传（C 档）：只保留有效值，缺省不写进配置对象。
 * 调用方（runAgentTurn / index 的 context:stats）各自回落默认值，不受影响。
 */
export function normalizeProviderLimits(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  const positiveInt = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
  };
  const contextWindow = positiveInt(input.contextWindow);
  if (contextWindow != null) out.contextWindow = Math.min(Math.max(contextWindow, 8000), 2000000);
  const maxOutputTokens = positiveInt(input.maxOutputTokens);
  if (maxOutputTokens != null) out.maxOutputTokens = maxOutputTokens;
  const toolConcurrency = positiveInt(input.toolConcurrency);
  if (toolConcurrency != null) out.toolConcurrency = Math.min(Math.max(toolConcurrency, 1), 16);
  return out;
}

/* ---------- 工作流 per-step 模型解析 / 跨家族复核（纯函数，供 index 的 run_workflow 包装层使用） ---------- */

/** provider 家族：family > name > baseUrl 的 host（都缺失时为空串） */
export function providerFamily(provider) {
  if (!provider || typeof provider !== 'object') return '';
  const family = typeof provider.family === 'string' ? provider.family.trim() : '';
  if (family) return family;
  const name = typeof provider.name === 'string' ? provider.name.trim() : '';
  if (name) return name;
  const baseUrl = String(provider.baseUrl || '').trim();
  if (!baseUrl) return '';
  try { return new URL(baseUrl).hostname || ''; } catch { return ''; }
}

function providerUsable(p) {
  return !!p
    && p.enabled !== false
    && !!String(p.baseUrl || '').trim()
    && !!String(p.apiKey || '')
    && Array.isArray(p.models)
    && p.models.length > 0;
}

/**
 * 解析工作流单步指定的 provider/model（workflow.mjs 已把 ctx.providerId / ctx.model 透传给 callStep）。
 * 返回 { override, warning }：
 *  - 命中：override = {baseUrl, apiKey, model, providerId}，调用方原样传给 callSubagent
 *  - provider 不存在/被禁用/模型不在 provider.models → override 用 fallback（全局子代理模型），并给 warning
 *  - 未指定 provider/model → override: null（沿用全局）
 */
export function resolveWorkflowStepModel({ step = {}, providers = [], fallback = null } = {}) {
  const providerId = typeof step?.providerId === 'string' ? step.providerId.trim() : '';
  const wantedModel = typeof step?.model === 'string' ? step.model.trim() : '';
  if (!providerId && !wantedModel) return { override: null, warning: null };
  const list = Array.isArray(providers) ? providers : [];
  const label = String(step?.id || t('(未知)'));
  const fallbackOverride = fallback
    && String(fallback.baseUrl || '').trim()
    && String(fallback.model || '').trim()
    ? { baseUrl: fallback.baseUrl, apiKey: fallback.apiKey, model: fallback.model, providerId: fallback.providerId || null }
    : null;
  const fail = (reason) => ({
    override: fallbackOverride,
    warning: t('步骤 {label} {reason}，已回退全局子代理模型', { label, reason })
  });
  const fallbackProvider = fallback?.providerId
    ? list.find((p) => p && p.id === fallback.providerId)
    : null;
  const target = providerId ? list.find((p) => p && p.id === providerId) : fallbackProvider;
  if (providerId && !target) return fail(t('指定的 provider {id} 不存在', { id: providerId }));
  if (!providerUsable(target)) {
    return fail(providerId
      ? t('指定的 provider {id} 不可用（被禁用或缺 baseUrl/apiKey/models）', { id: providerId })
      : t('无法确定可用供应商'));
  }
  // models 现在可能是字符串，也可能是 {id, contextWindow,...} 对象（model-config 迁移后）
  const models = target.models.map((m) => typeof m === 'string' ? m : String(m?.id || '')).filter(Boolean);
  const chosen = wantedModel || models[0];
  if (wantedModel && !models.includes(wantedModel)) {
    return fail(t('指定的 model {model} 不在 provider {id} 的模型列表', { model: wantedModel, id: target.id }));
  }
  if (!chosen) return fail(t('provider {id} 没有可用模型', { id: target.id }));
  return {
    override: { baseUrl: target.baseUrl, apiKey: target.apiKey, model: chosen, providerId: target.id },
    warning: null
  };
}

/**
 * 跨家族复核检查（只告警不失败）：任一 verify/arbitrate 与任一 find 的 provider family 相同 → warning。
 * results 里的 providerId 是 index 的 callStep 回填的「实际使用」供应商；查不到时用 fallbackProvider。
 */
export function computeCrossFamilyWarnings({ results = [], providers = [], fallbackProvider = null } = {}) {
  const list = Array.isArray(results) ? results : [];
  const byId = new Map((Array.isArray(providers) ? providers : []).map((p) => [String(p?.id ?? ''), p]));
  const familyOf = (r) => {
    const p = r?.providerId ? byId.get(String(r.providerId)) : null;
    return providerFamily(p || fallbackProvider || null);
  };
  const finds = list.filter((r) => r && r.kind === 'find' && familyOf(r));
  const warnings = [];
  for (const r of list) {
    if (!r || (r.kind !== 'verify' && r.kind !== 'arbitrate')) continue;
    const fam = familyOf(r);
    if (!fam) continue;
    const same = finds.find((f) => familyOf(f) === fam);
    if (same) warnings.push(t('跨家族复核未满足：{kind}({id})={fam} 与 find({sameId})={fam} 相同', { kind: r.kind, id: String(r.id), fam, sameId: String(same.id) }));
  }
  return warnings;
}

/* ---------- SessionStart hook（项目切换 / 会话打开·新建时运行一次；fail-open） ---------- */

/**
 * 运行一次 SessionStart。deny / hook 崩溃都不抛错、不阻断会话打开：
 * 返回 { decision, messages, context, warnings } 由调用方记内存。
 */
export async function runSessionStartHook({ sessionId = null, cwd = null, projectPath = null, hooksConfig = null, hooksRunner = null } = {}) {
  const out = { decision: 'allow', messages: [], context: '', warnings: [] };
  if (!(hooksConfig && hooksConfig.enabled === true)) return out;
  const list = hooksConfig?.events?.SessionStart;
  if (!Array.isArray(list) || !list.length) return out;
  try {
    const hook = await runHookEvent('SessionStart', { sessionId, cwd, projectPath }, {
      cwd: cwd || undefined,
      config: hooksConfig,
      runner: hooksRunner || undefined
    });
    out.decision = hook.decision;
    out.messages = Array.isArray(hook.messages) ? hook.messages : [];
    out.context = typeof hook.context === 'string' ? hook.context : '';
    out.warnings = [...(hook.warnings || []), ...(hook.errors || [])];
    return out;
  } catch (e) {
    out.warnings.push(t('SessionStart hook 异常（已忽略）：{error}', { error: e?.message || e }));
    return out;
  }
}

/**
 * 把 SessionStart context 作为一条 system 消息注入，位置紧跟项目记忆（没有则放最前）。
 * 返回新数组，不改原 messages。
 */
export function injectSessionHookContext(messages, context) {
  const text = typeof context === 'string' ? context.trim() : '';
  if (!text) return messages;
  const list = Array.isArray(messages) ? messages : [];
  const entry = { role: 'system', content: `【会话启动上下文（SessionStart hook）】\n${text}` };
  const memoryIdx = list.findIndex((m) => m?.role === 'system' && String(m.content ?? '').startsWith('【项目记忆'));
  if (memoryIdx >= 0) return [...list.slice(0, memoryIdx + 1), entry, ...list.slice(memoryIdx + 1)];
  return [entry, ...list];
}

// UserPromptSubmit / Stop 的 payload 需要提示词与最终回答的纯文本
function lastUserPromptText(messages) {
  const last = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m?.role === 'user');
  const content = last?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p?.type === 'text').map((p) => String(p.text ?? '')).join('\n');
  }
  return '';
}

// 轮数默认不设上限（长时间自主工作）；显式 FINALCHECK_MAX_TURNS 环境变量仍可作为上限生效（5..100）
const DEFAULT_MAX_TURNS = (() => {
  const n = Number(process.env.FINALCHECK_MAX_TURNS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.trunc(n), 5), 100) : Number.POSITIVE_INFINITY;
})();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_INLINE_RESULT = 20000; // 对齐 dsh 工具结果策略：超长不整块喂模型
const CONVO_BUDGET = 120000; // 旧字符口径预算：仅在没有 contextWindow 配置时作为 pruneConvo 的兜底
const TOOL_KEEP_RECENT = 4; // 旧 pruneConvo 口径：最近 4 条工具结果始终原文保留（新逻辑用 5，见 microcompact）
// 回合内 microcompact 的保留条数（2026-11-16）：原先固定 5 条，实测导致「读完就忘」——
// 同一文件两次读的步距中位数 9 > 5，所以每次想引用上次读的内容时它都已被清成占位符，
// 模型只能反复重读（一个回合 808 次调用、594 次读 20 个文件）。放宽到 12 条，
// 覆盖真实会话的步距分布；同时保留「只有踩到 token 阈值才折叠」的硬约束，不会无限膨胀。
const MICRO_KEEP_RECENT_IN_TURN = 12;
const STREAM_USAGE = process.env.FINALCHECK_STREAM_USAGE !== '0'; // 请求流式 usage；个别网关不认该字段时按 4xx 降级
// 0.27 压缩：摘要请求的超时（几十万 token 的历史 + 思考，给足时间）；回合开始压缩时最近几轮原样保留的预算占比
const COMPACT_SUMMARY_TIMEOUT_MS = 240000;
const CROSS_TURN_KEEP_RATIO = 0.3;

const spillDir = () => process.env.FINALCHECK_SPILL_DIR || path.resolve(__dirname, '..', '..', 'spill');

/* ---------- Windows 路径的 JSON 转义（第二道防线，不是并行调用粘连的根因） ----------
 * 模型也常把 `{"dir":"D:\Projects\demo"}` 写成单反斜杠：`\r` 会被 JSON 当成回车，
 * `\g`/`\y` 不是合法转义 → 整个参数 ARGS_INVALID_JSON，audit_project/download_gate 不执行。
 * 根因（并行 tool_calls 被拼成一个 name/arguments）已在 mergeStreamingToolCall 修复；
 * 这里保留三段防线：① schema/系统提示预防；② 参数闸自动修复能确定语义的反斜杠路径与尾逗号；
 * ③ 修不了才回模型重发，仍失败才按原因码收尾。文案集中在这里，避免多处漂移。 */
export const PATH_JSON_HINT = 'Windows 路径请用正斜杠（D:/Projects/demo），或把反斜杠写成双反斜杠（D:\\\\Projects\\\\demo）；JSON 字符串里不要写单反斜杠。';

export const TOOLS_SCHEMA = [
  { type: 'function', function: { name: 'audit_project', description: '对项目目录跑全方位验收：返回 11 维结论（每维结论/证据等级/覆盖了哪些检查项）+ 发现。计划来自项目根 finalcheck.profile.json（有就用），没有就按 tier 合成 11 维同档。sources 说明输入面：只给代码=code；用户给了可访问地址就加 url；用户明确授权对该地址做动态探测/压测才加 dynamicAuth（仍以本轮真的跑过 probe/stress 才算 full）。缺工具/配置会记 coverageGap', parameters: { type: 'object', properties: { dir: { type: 'string', description: '项目绝对路径。' + PATH_JSON_HINT }, tier: { type: 'string', enum: ['L1', 'L2', 'L3'] }, sources: { type: 'object', description: '可选：输入面。不给默认 {code:true}；给了 url 才会尝试动态维度；dynamicAuth 只是授权声明，实测记录由 probe_target/stress_target 产生', properties: { code: { type: 'boolean', description: '有源码可读（默认 true）' }, url: { type: 'string', description: '可访问的目标地址（http/https 或 localhost）' }, dynamicAuth: { type: 'boolean', description: '用户已授权对该 url 做动态探测/压测' }, loadLimit: { type: 'object', description: '可选：压测上限 {seconds, connections}，默认 10s/10', properties: { seconds: { type: 'number' }, connections: { type: 'number' } } } } } }, required: ['dir'] } } },
  { type: 'function', function: { name: 'quality_gate', description: '按项目根 finalcheck.quality.json 跑质量命令闸（lint / typecheck / test / bench 与阈值），返回每条命令的 exit/耗时/是否超阈值/覆盖率；repeat 可重复跑 1–5 次查抖动；执行前需用户授权', parameters: { type: 'object', properties: { dir: { type: 'string', description: '项目绝对路径。' + PATH_JSON_HINT }, tier: { type: 'string', enum: ['L2', 'L3'] }, repeat: { type: 'number', description: '可选：每条命令重复执行次数 1–5（默认 1；>1 时返回 flaky/attempts）', minimum: 1, maximum: 5 } }, required: ['dir'] } } },
  { type: 'function', function: { name: 'download_gate', description: '对项目目录跑下载闸体检（安装脚本/投毒/外呼/README 注入）', parameters: { type: 'object', properties: { dir: { type: 'string', description: '项目绝对路径。' + PATH_JSON_HINT } }, required: ['dir'] } } },
  { type: 'function', function: { name: 'probe_target', description: '对目标应用做渗透探测（无认证访问复现/CORS 反射/安全头），并采样返回延迟百分位 p50/p95/min/max/firstByteMs。仅限用户确认的本机应用', parameters: { type: 'object', properties: { url: { type: 'string' }, requests: { type: 'number', description: '可选：延迟采样次数 3–20，默认 10', minimum: 3, maximum: 20 } }, required: ['url'] } } },
  { type: 'function', function: { name: 'stress_target', description: '对目标应用做压力测试（温和上限 60s/50 连接）。仅限用户确认的本机应用', parameters: { type: 'object', properties: { url: { type: 'string' }, duration: { type: 'number', default: 10 }, connections: { type: 'number', default: 10 } }, required: ['url'] } } },
  { type: 'function', function: { name: 'get_report', description: '跑体检并返回人话报告全文（有 profile 或传 sources 时是 11 维表：结论/证据等级/覆盖检查项）', parameters: { type: 'object', properties: { dir: { type: 'string', description: '项目绝对路径。' + PATH_JSON_HINT }, tier: { type: 'string', enum: ['L1', 'L2', 'L3'] }, sources: { type: 'object', description: '可选：输入面 {code,url,dynamicAuth,loadLimit}，同 audit_project' } }, required: ['dir'] } } },
  { type: 'function', function: { name: 'list_playbooks', description: '列出方法论库的全部类目（编号/中文名/英文名/触发词/文件数）。两类内容都有：01-40 漏洞复核手法（渗透测试/越权/注入/SSRF/反序列化等），41-50 修复技能（密钥轮换/注入修复/依赖升级/提示注入防护/沙箱限额/数据脱敏等）。什么时候该调用它：① 不确定该用哪类手法时；② 按 audit_project 报告的 nextSteps 拿到 topic 编号但不确定对应哪一类时；③ 交付验收（L2/L3）里要判某个高危「到底能不能被真利用」、或要动手修某个审计发现时。**别凭规则名或凭感觉判真假——先看一眼目录**', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_playbook', description: '读方法论库的一类技能包。topic 传类目编号或英文名（如 11 / ssrf / sql-injection）；01-40 是漏洞复核手法，41-50 是修复技能（dev 轨修审计发现时用）。默认返回 SKILL.md 入口（含文件路由）；附属手册用 file 指定、大文件用 offset/limit 续读', parameters: { type: 'object', properties: { topic: { type: 'string', description: '类目编号或英文名，如 11 / ssrf / idor / jwt / wafbypass / vuln-report-generate' }, file: { type: 'string', description: '可选：该类目目录下的具体文件名（可先用 topic 读入口看 files 列表）' }, offset: { type: 'number', description: '可选：从第几个字符开始读，默认 0' }, limit: { type: 'number', description: '可选：本次最多读多少字符，默认 14000，上限 30000' } }, required: ['topic'] } } },
  { type: 'function', function: { name: 'read_file', description: '读取单个文本文件，自动带行号，大文件用 offset/limit 续读。⚠️ 这是读文件的唯一正确方式：不要用 run_command 的 cat/type/head/tail 读文件（shell 读不到项目外的文件，也不会给你行号）。要找某个字符串/函数/报错出在哪 → 用 grep_code，不要用它逐个文件翻。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径。' + PATH_JSON_HINT }, offset: { type: 'number', description: '可选：从第几个字符开始，默认 0' }, limit: { type: 'number', description: '可选：本次最多读多少字符，默认 20000，上限 40000' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'edit_file', description: '精确修改文件：把 old_string 替换成 new_string（old_string 必须在文件中唯一，否则拒绝）。改前先 read_file；改后返回 +N/-M 与 diff。需要用户审批', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径。' + PATH_JSON_HINT }, old_string: { type: 'string', description: '要替换的原文本（含缩进，必须唯一）' }, new_string: { type: 'string', description: '替换后的文本（可为空字符串=删除）' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'write_file', description: '新建或整体覆盖文本文件（≤2MB），返回 +N/-M 与 diff。父目录必须已存在；需要用户审批', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径。' + PATH_JSON_HINT }, content: { type: 'string', description: '完整文件内容' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'present_artifact', description: '把生成/修改好的 png / html / pdf / 视频（mp4/webm/mov）/ PPT·Word（pptx/docx，右侧一页一页展示）/ 文本文件登记为右侧可预览产物（用户点一下就在右侧打开）。生成了网页/图片/视频/幻灯片后调用它', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径。' + PATH_JSON_HINT }, title: { type: 'string', description: '可选：展示标题' } }, required: ['path'] } } },
  {
    type: 'function',
    function: {
      name: 'run_workflow',
      description: '多 agent 工作流：画一张流程图（nodes），每个节点默认是一个独立上下文的子代理。只有一条规则：depends_on 决定谁等谁——互不依赖的节点写 depends_on: [] 会同时跑；写了依赖就等上游跑完，上游结果自动附进它的 prompt。不要为了「看起来有顺序」串成链，也不要自己串行假装并行。'
        + '特殊节点用 type：fanout 按清单分身（over 写字符串数组，或写上游节点 id = 用它输出的清单；每项一个子代理，step.prompt 里用 ${as 的变量名}）；gate 程序闸（tool: audit_project / quality_gate / review_diff，不调模型）；verify 盲验复核（from: 要复核的节点）；report 交付报告（from）；aggregate 纯计算汇总（from, by）；loop 循环（body 是节点数组，until 结束条件，maxRounds 必填）；if 条件分支（when: {ref, test}，then / else 是节点数组）。分支和循环体内部按顺序执行。'
        + '每个节点 name 写职位名（4-10 字，如「SQL 注入审查员」「交付报告主编」），不许写「步骤 1」「分析」这种序号名或泛词。'
        + '例 1（几路并行再汇总）：[{id:"sql",name:"SQL 注入审查员",prompt:"只看 includes/ 的 SQL 拼接…",depends_on:[]},{id:"auth",name:"鉴权审查员",prompt:"…",depends_on:[]},{id:"sum",name:"交付报告主编",prompt:"汇总两路发现",depends_on:["sql","auth"]}]。'
        + '例 2（先侦察出清单，再每项派一个）：[{id:"list",name:"接口侦察员",prompt:"列出所有 API 路由，只输出 JSON 字符串数组",depends_on:[]},{id:"each",type:"fanout",name:"接口审查员",over:"list",as:"route",step:{prompt:"审查 ${route} 的鉴权与越权"}},{id:"rep",type:"report",from:["each"]}]',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '整个工作流要达成的总目标（一句话）' },
          nodes: {
            type: 'array',
            description: '流程图的节点（1-14 个普通节点；含 fanout 时总数可更多）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '节点 id（字母数字-_，唯一）' },
                type: { type: 'string', enum: ['agent', 'fanout', 'gate', 'verify', 'report', 'aggregate', 'loop', 'if'], description: '默认 agent（一个子代理）；其余见工具说明' },
                name: { type: 'string', description: '职位名（展示用，必填）：4-10 字，如「SQL 注入审查员」' },
                role: { type: 'string', description: '子代理角色，如「SQL 注入专家」' },
                prompt: { type: 'string', description: '交给子代理的具体任务；要自包含（输入、要产出什么），上游结果会自动附上' },
                depends_on: { type: 'array', items: { type: 'string' }, description: '要等哪些节点跑完（并拿到它们的结果）；不需要就写 [] = 立刻并行' },
                kind: { type: 'string', enum: ['recon', 'find', 'verify', 'arbitrate', 'report'], description: '可选：对抗验证协议角色（find 取证、verify/arbitrate 复核）' },
                blind: { type: 'boolean', description: '可选：verify/arbitrate 默认盲验（只给 claim 与证据指针）' },
                model: { type: 'string', description: '可选：本节点用的模型（必须在该供应商的模型列表里）' },
                providerId: { type: 'string', description: '可选：本节点用的供应商 id；复核建议换不同家族' },
                over: { description: 'fanout：字符串数组，或上游节点 id（用它输出的 JSON 字符串数组）', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
                as: { type: 'string', description: 'fanout：当前项的变量名，step.prompt 里用 ${名}' },
                limit: { type: 'number', description: 'fanout：最多跑前几项（默认 20，上限 50）' },
                step: { type: 'object', description: 'fanout 每一项的子代理 {name?, role?, prompt}', properties: { name: { type: 'string' }, role: { type: 'string' }, prompt: { type: 'string' } }, required: ['prompt'] },
                tool: { type: 'string', enum: ['audit_project', 'quality_gate', 'review_diff'], description: 'gate：直接执行的程序工具（不调模型）' },
                args: { type: 'object', description: 'gate：工具参数（如 {dir, tier, base}）' },
                from: { description: 'verify / report / aggregate：上游节点（字符串或数组）', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
                ask: { type: 'string', description: 'report：汇总要求' },
                by: { type: 'string', enum: ['severity', 'rule', 'file', 'status'], description: 'aggregate：聚合键' },
                top: { type: 'number', description: 'aggregate：返回前 N 组（1-20）' },
                when: { type: 'object', description: 'if：条件 {ref: 节点 id, test: {contains? | equals? | notEmpty?}}' },
                then: { type: 'array', items: { type: 'object' }, description: 'if：命中时执行的节点数组' },
                else: { type: 'array', items: { type: 'object' }, description: 'if：不命中时执行的节点数组' },
                body: { type: 'array', items: { type: 'object' }, description: 'loop：每轮执行的节点数组' },
                until: { type: 'object', description: 'loop：结束条件 {ref, test}' },
                maxRounds: { type: 'number', description: 'loop：最多几轮（1-20，必填）' }
              },
              required: ['id']
            }
          }
        },
        required: ['goal', 'nodes']
      }
    }
  },
  {type: 'function',function: {name: 'view_image',description: '看图：把本地图片（png/jpg/gif/webp/bmp）直接给你看。用于检查自己生成的图、用户/项目里的截图与设计稿。大图会自动缩到 1600px 宽。最多一次 4 张（paths）。',parameters: {type: 'object',properties: {path: {type: 'string',description: '图片绝对路径'},paths: {type: 'array',items: {type: 'string'},description: '可选：一次看多张（≤4）'}}}}},
  {type: 'function',function: {name: 'capture_screenshot',description: '截图并直接给你看：本地 html/svg（渲染后的真实效果）、pdf / pptx / docx 的某一页、mp4/webm/mov 的某一帧、http(s) 网页。做 PPT / 网页 / 视频 / 海报等视觉产物时，生成后必须用它逐页/关键帧看效果，发现文字溢出、重叠、错位、配色问题就改，改完再截一次确认——不要只凭代码判断「应该没问题」。**写完 HTML/CSS/JS 一定要先截图看一遍再交**，尤其是自己起的服务（传 http://127.0.0.1:端口）。',parameters: {type: 'object',properties: {target: {type: 'string',description: '本地文件绝对路径或 http(s) 网址'},page: {type: 'number',description: 'pdf / pptx / docx 的页码（从 1 开始）'},time: {type: 'number',description: '视频的时间点（秒）'},width: {type: 'number',description: '视口/输出宽度，默认 1280（PPT 16:9 建议 1600）'},height: {type: 'number',description: '网页视口高度，默认 800'},full_page: {type: 'boolean',description: '网页截整页（长页面）'},wait_ms: {type: 'number',description: '网页加载后再等多少毫秒再截（动画/字体），默认 800-1200'}},required: ['target']}}},
  {type: 'function',function: {name: 'remember_project',description: '把「下次任何人打开这个项目都成立」的事实写进项目根 AGENTS.md（项目宪法，不是任务日志）。按 kind 分节：overview 项目概况（用途/技术栈/部署）、commands 常用命令（启动/构建/测试/重新生成产物）、layout 目录约定（源码与产物各在哪、哪些是生成的不要手改）、rules 规范与禁忌（长期偏好、不许做的事）、acceptance 验收口径（默认档位、必须过的闸）。会被直接拒绝的写法：行号、进度（已修好/这次/下一步）、会变的数量（13 页/6 个脚本）、产物文件清单、超过 220 字。例：✅「宣传 PPT 源文件在 deck/src/（HTML+CSS），产物输出到 deck/out/，不要手改产物」（layout）✅「重建 PPT：python deck/tools/build_deck.py，改完跑 deck/tools/qa_*.py」（commands）❌「产物 deck/out/finalcheck-deck.pptx（13 页）、finalcheck-deck.pdf、slides/*.png；质检脚本 qa_layout.py、qa_contrast.py…」。已有条目过时了就传 replace（旧条目里的一段原文）就地更新，不要再追加一条。跨目录改别的项目时传 dir 写进那个项目。',parameters: {type: 'object',properties: {fact: {type: 'string',description: '一个长期成立的事实，一句话（≤220 字），带可核对的目录/命令/配置名'},kind: {type: 'string',enum: ['overview','commands','layout','rules','acceptance'],description: '写进哪一节（默认 rules）'},replace: {type: 'string',description: '可选：要更新的旧条目里的一段原文（从 AGENTS.md 复制）；传了就替换那一条而不是追加'},dir: {type: 'string',description: '要记住的项目根绝对路径（可选）。跨目录场景必传：用户让你改 A 项目、但当前会话绑的是 B，就传 A 的路径，记忆写进 A 的 AGENTS.md'}},required: ['fact']}}},
  { type: 'function', function: { name: 'run_command', description: '在本机执行 shell 命令。**统一是 Git Bash 一种语法**（2026-11-17 决策：ACL 沙箱默认关闭，不再有 cmd 这条路径；bash 语法在这里全部可用）。\n可用写法：`ls -la`、`grep -rn`、`cat`、`head -n`、`tail -n`、`wc -l`、`sed`、`awk`、`find . -name "*.py"`、`sort`、`uniq`、`diff`、`tr`、`cut`、`rm -rf`、`mv`、`cp`、`mkdir -p`、`for f in ...; do ...; done`、`$(...)`、`2>/dev/null`、`| head`、`&&`、`||`、`~`（会展开成家目录）。\n⚠️ 不要写 cmd 语法，这些在 bash 里都不对：`dir /b`（用 `ls -la`）、`type`（用 `cat` 或 read_file）、`findstr`（用 `grep -rn` 或 grep_code）、`2>nul`（用 `2>/dev/null`）、`if exist`（用 `test -e`）、`cd /d`（用 `cd`）。\n⚠️ 硬性分工（违反会被应用层拒绝）：① 读文件必须用 read_file（自带行号+分页），禁止 cat/head/tail 读文件；② 搜代码必须用 grep_code（返回 file:line:内容），禁止 grep 搜代码内容；③ 敏感路径（~/.ssh、~/.aws、~/.gnupg、私钥文件）无条件拒绝；项目目录之外的路径默认拒绝（需要跨目录改别的项目时，让用户显式授权该目录）。\n灾难性命令（rm -rf /、format、dd 等）会被黑名单拦截。起常驻服务（node server.mjs / 端口监听 / uvicorn）必须用 background:true 立刻拿 PID，不要用 nohup & 再等它返回；连续 120s 无输出的命令会自动转后台并返回 PID（进程不杀）。', parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令（Git Bash 语法）' }, cwd: { type: 'string', description: '工作目录（可选）。' + PATH_JSON_HINT }, timeout_ms: { type: 'number', description: '超时毫秒（可选）；不传则不限时跑到命令结束（连续 120s 无输出会转后台返回 PID），传了按该毫秒数到点终止' }, background: { type: 'boolean', description: 'true=立刻在后台启动并返回 PID（起常驻服务用），不等待输出' }, idle_ms: { type: 'number', description: '可选：多久无输出算卡住并转后台，默认 120000；0=关闭该兜底' } }, required: ['command'] } } }
];

// review_diff：只读 git 改动审查。单列一份而不是塞进 TOOLS_SCHEMA：
// TOOLS_SCHEMA 同时是 MCP 通道的 SSOT（src/mcp/server.mjs 照抄并精确断言工具表），
// MCP 通道没有 review_diff 的实现，放进去会让 tools/list 暴露一个调不通的工具。
// 轻量子代理（0.26，对齐 Claude Code 的 Agent 工具）：派一个空白上下文的子代理去做一件独立的事，
// 只把最终报告交回来。和 run_workflow 的分工：这个是随手派一个（或同一回复里并行派几个）；
// 要多路分工 + 依赖 + 盲验复核的确定性任务才画工作流。
export const SPAWN_AGENT_SCHEMA = {
  type: 'function',
  function: {
    name: 'spawn_agent',
    description: '派一个子代理去做一件独立的事：它从空白上下文开始，有自己的工具，做完只把最终报告交回给你——它中间读了多少文件、试了多少命令都不会占你的上下文。'
      + '适合：① 大范围搜索 / 通读很多文件只为得到一个结论（例如「找出所有调用 X 的地方并说明用法」「这个仓库的鉴权是怎么做的」）；② 和你手头的事互不依赖、可以同时进行的调查——同一次回复里调用多次 = 多个子代理并行。'
      + '不适合：一两次 read_file / grep_code 就能搞定的事（自己做更快）；需要和用户来回确认的事；要多路分工 + 依赖 + 复核的大任务（用 run_workflow）。'
      + '子代理看不到对话历史：prompt 要自包含，写清目标、范围（目录 / 文件）、要交回什么（结论 + 证据 文件:行）。'
      + 'type：explore 只读调查（默认）；general 可以改文件；verify 独立复核——把要核实的结论和证据写进 prompt，它不看你的推理、自己重新取证，给出 confirmed / rejected / uncertain。',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '3-12 字的任务标题（界面显示），如「查鉴权实现」' },
        prompt: { type: 'string', description: '交给子代理的完整任务（自包含：目标、范围、交付物）' },
        type: { type: 'string', enum: ['explore', 'general', 'verify'], description: 'explore=只读调查（默认）；general=可改文件；verify=独立复核结论' }
      },
      required: ['description', 'prompt']
    }
  }
};

export const AGENT_ONLY_TOOLS_SCHEMA = [
  SPAWN_AGENT_SCHEMA,
  // ---- 桌面操作（computer use，2026-11-21）：对标 Claude Code 的 computer-use MCP ----
  // 设计要点：① 逐应用授权 ② 三层 tier 由「前台应用」强制 ③ 浏览器类只给 read（不许点）
  { type: 'function', function: { name: 'computer_screenshot', description: '截取整个屏幕或指定窗口（给你看当前桌面长什么样）。返回图 + 当前前台应用及其权限级别。做非浏览器类桌面操作时，第一步和每一步之后都要用它确认结果', parameters: { type: 'object', properties: { target: { type: 'string', enum: ['screen', 'window'], description: '默认 screen（整个屏幕）；window 只截一个窗口' }, window_title: { type: 'string', description: 'target=window 时按窗口标题片段匹配' } } } } },
  { type: 'function', function: { name: 'computer_request_access', description: '请求操作指定应用（必须先授权才能动手，对标 Claude Code 的 request_access）。传你要用的应用进程名或标题片段，例如 ["WINWORD"]、["EXCEL"]。会弹确认给用户；用户同意后本进程内一直有效', parameters: { type: 'object', properties: { apps: { type: 'array', items: { type: 'string' }, description: '要操作的应用（进程名或窗口标题片段），如 ["WINWORD","EXCEL"]' }, reason: { type: 'string', description: '为什么要操作这些应用（一句话，给用户看）' } }, required: ['apps'] } } },
  { type: 'function', function: { name: 'computer_action', description: '在桌面上执行一个动作（点击/输入/按键/滚动/拖拽）。执行前会自动检查：① 当前前台应用的权限级别（浏览器=只读、终端与编辑器=只能左键、其它=全放）② 该应用是否已被授权。坐标用 computer_screenshot 返回的图上的像素（x,y），scale 参数传截图返回的 scale 值会自动换算回真实屏幕坐标。**每步之后重新截图确认，不要假设点对了**', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'move', 'drag', 'scroll', 'type', 'key', 'focus'], description: '要执行的动作' }, x: { type: 'number', description: '坐标 x（截图像素）' }, y: { type: 'number', description: '坐标 y（截图像素）' }, x2: { type: 'number', description: 'drag 的终点 x' }, y2: { type: 'number', description: 'drag 的终点 y' }, scale: { type: 'number', description: 'computer_screenshot 返回的 scale（截图缩放比），给了会自动换算坐标' }, text: { type: 'string', description: 'type 动作要输入的文字' }, keys: { type: 'string', description: 'key 动作的按键，如 "Return" / "^s" / "%{F4}"（SendKeys 语法）' }, repeat: { type: 'number', description: 'key 重复次数，默认 1' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll 方向' }, amount: { type: 'number', description: 'scroll 格数，默认 3' }, hwnd: { type: 'number', description: 'focus 动作的目标窗口句柄' } }, required: ['action'] } } },
  // ---- 浏览器操作（browser use，2026-11-21）：对标 Playwright MCP，但复用 FC 自带 Chromium ----
  // 关键差异：snapshot 返回 accessibility tree（带 ref），不是截图；点按 ref 走 DOM，不猜坐标。
  { type: 'function', function: { name: 'browser_navigate', description: '打开一个网页（独立窗口，不加载你的登录态）。**所有浏览器类任务都必须走 browser_* 系列，不要用 computer_action 去点网页**（浏览器的桌面权限是只读，点了也会被拒）', parameters: { type: 'object', properties: { url: { type: 'string', description: 'http/https 网址或本地 html 路径' }, show: { type: 'boolean', description: '是否显示窗口让用户看着操作，默认 false' }, wait_ms: { type: 'number', description: '加载后再等多少毫秒，默认 600' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_snapshot', description: '返回当前页面的可操作结构（accessibility tree）：每个可点/可输入的元素都带 [ref=eN] 与角色、名称。这是你在浏览器里「看」页面的正确方式——比截图准确（截图要点坐标，这个直接给 ref）', parameters: { type: 'object', properties: { max_nodes: { type: 'number', description: '最多返回多少个节点，默认 220' } } } } },
  { type: 'function', function: { name: 'browser_click', description: '按 ref 点一个元素（走 DOM click，不是模拟鼠标）。ref 来自最近一次 browser_snapshot；页面变了要重新 snapshot', parameters: { type: 'object', properties: { ref: { type: 'string', description: '元素引用号，如 e5（来自 browser_snapshot）' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'browser_type', description: '往 input/textarea 里输入文字（用原生 value setter + input 事件，React/Vue 受控组件也能收到）', parameters: { type: 'object', properties: { ref: { type: 'string', description: '元素引用号' }, text: { type: 'string', description: '要输入的文字' } }, required: ['ref', 'text'] } } },
  { type: 'function', function: { name: 'browser_evaluate', description: '在当前页面执行一段 JS 并返回结果（读 DOM 细节、算数值、取元素属性）。只读用途优先；改页面状态要谨慎', parameters: { type: 'object', properties: { expression: { type: 'string', description: '要执行的 JS 表达式（会自动包成 async 函数，可 await）' } }, required: ['expression'] } } },
  { type: 'function', function: { name: 'browser_console', description: '读当前页面的控制台错误（最多最近 50 条）。页面表现不对时先查这里', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_screenshot', description: '截当前浏览器页面（需要像素判断或要给用户看时用）。一般判断「页面结构对不对」用 browser_snapshot 就够', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_close', description: '关闭浏览器窗口', parameters: { type: 'object', properties: {} } } },
  // 修复回路（③）：回滚到 edit_file/write_file 改动前的快照（主 agent 专属，子代理不给）
  { type: 'function', function: { name: 'repair_rollback', description: '把文件回滚到本次编辑前的快照（edit_file/write_file 每次覆盖已存在文件都会自动留一份快照）。改坏了就用它恢复，不要手工拼回原文', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径（与 edit 时一致）。' + PATH_JSON_HINT }, snapshotId: { type: 'string', description: '可选：edit_file 结果里返回的 snapshotId；不给就恢复到最新一次改动前' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'review_diff', description: '只读审查 git 改动（默认对比 HEAD，也可 HEAD~1 / 分支名）：返回改动文件与 +/- 行数，并标出新增 SQL 拼接 / 命令执行 / 密钥字面量、删除的鉴权中间件、被改的 .env/.gitignore。不执行被审项目代码，不做 add/commit/checkout', parameters: { type: 'object', properties: { dir: { type: 'string', description: '项目绝对路径。' + PATH_JSON_HINT }, base: { type: 'string', description: '可选：对比基线，默认 HEAD（也可 HEAD~1 或分支名）' } }, required: ['dir'] } } },
  // 回合中途向用户提问：只在主 agent 的工具表；子代理不注册（避免并行子代理同时弹多个问题）。
  // 卡片 UI 用 callId 关联；回答经 finalcheck:ask-user-answer 回填，工具返回 { answer }。
  { type: 'function', function: { name: 'ask_user', description: '回合中途向用户提问并等待回答（同一回合最多 3 次）。只在真有分叉且影响结论时使用（例如「按 L2 还是 L3」「动态探测要不要授权」「两个方向只能选一个」），信息足够时不要打扰用户。最多给 6 个选项；纯开放式提问可以不给 options，由用户自己输入。调用后本回合暂停，直到用户回答或点击停止', parameters: { type: 'object', properties: { question: { type: 'string', description: '要问用户的问题，一句话说清分叉点与影响' }, options: { type: 'array', maxItems: 6, description: '可选：2-6 个候选答案；不给则纯开放式提问', items: { type: 'object', properties: { label: { type: 'string', description: '选项短标签' }, description: { type: 'string', description: '可选的补充说明（影响/代价）' } }, required: ['label'] } }, multiSelect: { type: 'boolean', description: '可选：是否允许多选，默认 false' } }, required: ['question'] } } },
  // 验收单（ZCode todo 式）：用户可见的勾选清单，2-8 条，每条必须写清验收标准。
  // （2026-11-20 下限从 3 放宽到 2：模型对单一目标的任务写 2 条很合理，以前被拒后还得改写重发一轮）
  // 可多次调用更新状态；done 必须带 evidence，failed/skipped 会被报告闸要求写进 ## Not covered。
  { type: 'function', function: { name: 'todo_write', description: '维护本轮任务的验收单（勾选清单）：2-8 条，每条必须给 acceptance（怎么算做完）；可多次调用按 id 更新 status。开工时先写一遍，做完一条就把 status 改成 done 并补 evidence（文件:行 / 命令输出 / HTTP 复现）。不能做或跳过的条目标 failed/skipped，最终回答的 ## Not covered 必须点名它们。' + TODO_CC_RULES_TEXT, parameters: { type: 'object', properties: { items: { type: 'array', minItems: 2, maxItems: 8, description: '2-8 条任务（只有一两个目标时写 2 条也行，不要硬凑）；id 稳定（更新状态时按 id 合并）', items: { type: 'object', properties: { id: { type: 'string', description: '稳定标识（如 s1 / step-1）' }, task: { type: 'string', description: '这一步要做什么（一句话）' }, acceptance: { type: 'string', description: '验收标准（必填）：怎么算这一步完成，可检查的条件' }, status: { type: 'string', enum: ['pending', 'running', 'done', 'failed', 'skipped'], description: '状态，默认 pending' }, evidence: { type: 'string', description: '证据（done 时必填）：文件:行 / 命令输出摘要 / HTTP 复现' } }, required: ['id', 'task', 'acceptance'] } } }, required: ['items'] } } }
];
export const AGENT_TOOLS_SCHEMA = [...TOOLS_SCHEMA, GREP_CODE_SCHEMA, ...AGENT_ONLY_TOOLS_SCHEMA];

// 工作流子代理工具集：与主 agent 同一份 schema，按 swarm.mjs 的清单过滤。
// 共 14 个：含 review_diff（review_diff 只在 AGENT_ONLY_TOOLS_SCHEMA），
// 排除 run_workflow（禁止嵌套工作流）与 remember_project（记忆只由主 agent 写）。
export const SUBAGENT_TOOLS_SCHEMA = AGENT_TOOLS_SCHEMA.filter((tool) => SUBAGENT_TOOL_NAMES.includes(tool?.function?.name));

const SYSTEM_BASE = [
  '你是 FinalCheck（终检）安全验收助手，连接用户与安全测试工具。',
  '职责：帮用户跑体检/下载闸/渗透探测/压测，并用大白话解释结果；发现必须带证据（文件:行或 HTTP 复现）说话，不编造。',
  // 验收前置硬规则：放在所有工具说明之前（优先于下面的执行节奏与「信息足够就别打扰」）
  '验收前置（硬规则，优先于下面所有工具说明）：用户提出「验收 / 体检 / 审计 / 帮我看看这个项目」时，必须先问清两件事再动手——(a) 档位 L1/L2/L3；(b) 要覆盖哪些维度。用户没有同时说清这两项 → 必须先调 ask_user，先问清楚，不许猜；不许先跑 audit_project，也不许用 dir / 文件列表猜目标代替提问。',
  '问法（一次只问一件事，最多两次 ask_user）：① 档位单选——L1 底线（个人发布：查基础安全与依赖有没有硬伤）、L2 真实用户（再加交接 H1、可维护 Q3、动态探测）、L3 公司交付（再加许可证 C1、运维 O1、对抗性复核），每个选项带一句「查什么」；② 维度多选——列出 11 维（安全性 (Security) / 数据与隐私 (Data & privacy) / 供应链与许可证 (Supply chain & license) / 可维护性 (Maintainability) / 代码可读性 (Readability) / 可测试性 (Testability) / 鲁棒性 (Robustness) / 运行稳定性 (Runtime stability) / 性能 (Performance) / 可观测性与可运维 (Observability & ops) / 可移交性 (Handover)），并标注「全选 = 完整验收」。',
  'ask_user 语言规则：If the UI/user language is English, write the ask_user question, option labels, and descriptions in English.',
  '不要重复问：用户已经说清的部分不再问（例如说了「跑 L3」就不问档位，说了「只看安全性和可维护性」就不问维度，只补问缺的那一项）；档位与维度都说清 → 直接带 tier 和维度跑。项目根已有 finalcheck.profile.json → 视为档位与维度已声明，按它跑，不再问。',
  '多候选不许猜：目标目录本身有歧义（工作区里有多个候选项目，用户说的是「我的 AI 助手」这类泛称）→ 必须先问是哪一个，不许用 dir / 猜路径代替提问；猜错目标等于答错题。',
  '你还有 run_command：像 coding agent 一样自由执行命令（**Git Bash 语法，不是 cmd**：ls -la、grep -rn、cat、find、sed、awk、2>/dev/null、$(...)、&&、|| 都可用；不要写 dir /b、type、findstr、2>nul 这些 cmd 写法）。用户让你"看看某目录/某个盘"就用它探查后再回答，不要拒绝；灾难性命令会被系统拦截，不必自己判断。',
  '做安全验证时必先查方法论库——不只是渗透测试：验收里报出的高危/可疑项（SQL 注入、命令注入、SSRF、越权、反序列化…）要判断「是否真能被利用」时也算。先 list_playbooks 看 40 类目录（audit_project 结果的 nextSteps 已给出对应 topic 编号），read_playbook(topic=编号或英文名) 读入口 SKILL.md，再按其「文件路由」用 file+offset 下钻附属手册；按手册的方法论复核，不要凭规则名或凭感觉判真假。',
  '测试纪律：侦察（端口/指纹/目录/JS/API）→ 选类目 → 读方法论 → 用 probe_target / run_command 构造请求验证 → 只把已复现的写进结论，未复现的标「线索」。',
  '工具可用性：不假设 nmap/sqlmap/dirsearch 等外部工具已安装；先用 run_command 的 `which` 探测，没有就用 curl/node 做等价的手工验证，不要卡在装工具上。',
  '执行节奏：每个类目先跑手册里的最小验证集（3-5 个请求），有证据就停；大字典爆破、压测、登录尝试只在用户明确要求时做。',
  '只验收不改代码时，被验收的项目目录保持原样：需要临时脚本（验证哈希、跑个小复现）就写到系统临时目录（/tmp 或 %TEMP%），不要在项目里建文件——哪怕用完就删，交付物的 git 状态也不能被你动过（E2E 实测 go-admin 里建过 tmp_bcrypt_check.py）。',
  '构建/装依赖有时间预算：静态验收不需要编译通过；只有用户要求「能否构建/跑测试」时才执行 mvn/gradle/npm install/pip install/go build 这类命令，且必须带 timeout_ms（≤ 300000）。超时或依赖下载太慢 → 立刻记为「构建未验证（原因：依赖下载超时）」写进 ## Not covered，继续别的验收项；禁止用 sleep 反复轮询等它（E2E 实测：spring-petclinic 等 Maven 下载 17 分钟直到整轮超时，最终一个字的结论都没交出来）。',
  '边界：动态目标以用户在对话中的口头确认为准——用户给出目标 URL 或表示同意，即为授权，直接执行（压测默认温和参数）；结论引用工具返回的 verdict；覆盖不足要明说"没查到"。',
  '工具结果超长时会被截断为「头+尾」并完整落盘，按提示的 spill 路径用 run_command 检索，不要猜中间内容。',
  '长任务提速（2026-11-19 实测：做一个宣传片 529 步、109 分钟，其中 99 分钟在等模型、353 次回复只调了 1 个工具）：① 互不依赖的读文件 / 查看 / 命令放在同一次回复里一起发（读文件 / 搜索 / 看图 / 截图会并发执行；多条互不依赖的命令可以合并进一次 run_command），不要一次只调一个；② 视觉迭代要成批——一条命令里循环渲染或截取多帧（或用脚本拼成一张总览图），一次 view_image 看完（每次最多 4 张），把看到的问题列全、一次改完，再整体验证一次；不要「改一处 → 渲染一帧 → 裁图 → 看一眼」反复循环；③ 已经确认没问题的部分不要重复检查。',
  '看图与截图：做 PPT / 网页 / 视频 / 海报 / 图表这类视觉产物时，生成后必须用 capture_screenshot 逐页（或关键帧）看实际效果，文字溢出、重叠、错位、配色不对就改，改完再截一次确认；不要只看代码就说「应该没问题」。用户或项目里的图片用 view_image 直接看。写完页面一定要先 capture_screenshot 看一遍再交，不要凭代码猜。',
  '操作电脑或网页时的选路顺序（硬规则，照 Claude Code 的优先级）：① 能用专用工具就用专用工具（读写文件、跑命令、audit_project 等）；② **网页相关的活一律走 browser_* 系列**（browser_navigate → browser_snapshot 拿 ref → browser_click / browser_type），不要用 computer_action 去点网页——浏览器在桌面权限里是「只读」，点了会被拒，而且像素点选本来就不准；③ 只有「非浏览器的桌面软件」（Word / Excel / Photoshop / 系统设置 / 本地 GUI 工具）才用 computer_*：先 computer_request_access 请求授权（列明要操作哪个应用），同意后用 computer_screenshot 看屏幕 → computer_action 执行 → **每一步之后重新 computer_screenshot 确认**，不要假设点对了。终端和编辑器在桌面权限里是「只能左键」，输入文字会被拒——那类活应该用 run_command / write_file，不是去点界面。',
  '修代码：先 read_file 看清原文，再用 edit_file 做最小替换（old_string 必须唯一）；新建文件用 write_file。改完明确告诉用户「改了哪个文件、+几行/-几行、为什么」。',
  '路径参数转义（硬规则）：JSON 参数里的 Windows 路径一律优先写正斜杠（D:/Projects/demo）；必须用反斜杠时一律双写（D:\\\\Projects\\\\demo）；写成单反斜杠会让参数不是合法 JSON，工具不会执行。',
  '产出可预览文件（html / png / pdf / mp4 / pptx / md 等）后，调用 present_artifact(path) 登记；用户在聊天里点一下就出现在右侧预览面板（视频可直接播放，PDF/PPT/Word 分页展示）。',
  '多 agent 工作流（run_workflow）：画一张流程图 nodes，每个节点默认是一个独立上下文的子代理（角色 + 自包含任务 + depends_on），引擎按依赖并行，拿到各节点结果后你再汇总成一份结论。数量要等上游结果才知道时（按清单逐个处理、循环到满足条件、条件分支、纯计算汇总），用特殊节点 type=fanout / loop / if / aggregate，同一张图里混着用，不需要另选一种写法。不要用「我要开始第 1 步」的文字模拟并行。每个节点 name 必须是职位名（4-10 字，如「SQL 注入审查员」「依赖供应链专员」），不许写「步骤 1」「分析」这种。',
  '拆图铁律（写 depends_on 前先自问）：每写完一个节点先问「它真的需要上一个节点的结果吗」——不需要就写 depends_on: []（空数组 = 可立即并行，多路同时跑）；只有确实要消费上游产出（读到它的结论、复用它的清单）才写依赖。为了「看起来有顺序」把步骤串成链，会让子代理排队、总耗时按步数翻倍。最小示例（3 步、2 步并行）：nodes: [{id:"s1",prompt:"查 A 的证据",depends_on:[]},{id:"s2",prompt:"查 B 的证据",depends_on:[]},{id:"s3",prompt:"汇总 s1 与 s2 的结论",depends_on:["s1","s2"]}] — s1 与 s2 同时跑，s3 等两者都完成；不要写成 s2 依赖 s1。',
  '复杂项目要主动开工作流：当项目较大（约 ≥2000 行 / 多语言 / 多服务）且任务能拆成互不依赖的几路（体检、下载闸、依赖供应链、鉴权越权、动态探测）时，直接调用 run_workflow 并行分头查，不必等用户说「用工作流」；步骤 3-8 个（特别大的项目可到 14 个），每步限定目录或类目（例如「只看 includes/ 的 SQL 与 nonce」），不要把「通读整个仓库」丢给一个子代理。小任务（单文件、单问题、顺手看一眼）不要用工作流，自己查更快。',
  '轻量子代理（spawn_agent）的判断标准：预计要搜 / 读 5 个以上文件才能回答的调查型问题（「X 都在哪」「Y 是怎么实现的」「帮我摸清某个模块」「所有用到 Z 的地方」），不要自己一个个翻——第一步就派 spawn_agent 去查，只拿结论回来，你自己的上下文保持干净；问题能拆成几个互不相关的方向时（例如「登录怎么做的」和「CSRF 怎么防的」），在同一次回复里各派一个，它们会并行。只有一两次 read_file / grep_code 就能搞定的小问题才自己做。要多路分工、互相依赖、需要盲验复核的验收 / 审计大任务用 run_workflow。重要结论想再确认一遍时，可以派 type=verify 的子代理独立复核（把结论和证据写进 prompt）。',
  '子代理是有工具的：它们能调用 read_file / run_command / audit_project / download_gate / probe_target / stress_target / list_playbooks / read_playbook（也能 read_file / edit_file / write_file / grep_code；不能再起工作流、不能写项目记忆）。所以每步 prompt 要写成「用哪个工具对什么跑什么、产出什么证据」的可执行任务（例：「用 audit_project 对 D:\\x 跑 L2，列出高危项」），让几个子代理并行跑不同测试，别把活全留给自己。',
  '项目记忆：项目根的 AGENTS.md 是该项目的「宪法」，每轮会自动注入。用户说「记住 / 以后都这样 / 记到项目里」时，或你摸清了下次一定用得上的长期事实（怎么构建/测试、源码与产物在哪、项目禁忌）时，用 remember_project 按 kind 分节写一条；任务过程、产物清单、数量、进度一律不写（会被拒绝）；旧条目过时就传 replace 就地更新；AGENTS.md 里已有的约定优先遵守；没有 AGENTS.md 时不要主动创建，除非用户要求。⚠️ 记忆跟**目录**走：你在 A 项目里改 B 项目的代码，记忆要写进 B（remember_project 传 dir=B 的路径），不要写进 A。',
  '跨目录工作：允许在项目目录之外读写（默认放开边界）。用户让你改另一个项目的 bug 时直接改，不要拒绝、不要要求切换会话；但要记住「改的是哪个项目」——记忆（AGENTS.md）写进被改的那个项目根，结论汇报时点名你动了哪个目录。敏感路径（~/.ssh、~/.aws、~/.gnupg、私钥）与灾难命令（rm -rf / 等）仍然会被拒绝，这是刻意保留的底线。',
  '质量命令闸：项目根若有 finalcheck.quality.json，调用 quality_gate 会跑里面声明的 lint / typecheck / test / bench 并给出 exit、耗时、是否超阈值、覆盖率（执行前会要用户授权）。用户问「可读性 / 性能 / 稳定性 / 能不能转接」时：先看有没有这份配置；有就跑它拿可测量证据，没有就明说「没有量化闸，只能代码审查」，再用 read_file 逐文件给结论+文件:行，不要编造分数（没有 profiler，就没有 p95）。',
  'audit_project 返回的 nextSteps 是针对本项目的具体下一步（该读哪个方法论、要不要开工作流、哪些关要列进 Not covered），逐条执行或在回答里说明为什么跳过。',
  '验收档位纪律：用户说「按 L1 / L2 / L3 验收」时必须把 tier 显式传给 audit_project，不许自行降档；L2 会跑交接(H1)与可维护性(Q3)，L3 再加许可证(C1)与运维(O1)。返回的 gates.gaps 必须原样列给用户（「这关没跑，原因是…」），不许把没跑的关说成通过，也不许用「AI 看过了」替代没跑的闸。',
  '向用户提问：只在不问就无法继续、且答案会改变结论时调用 ask_user（例如「按 L2 还是 L3」「动态探测要不要授权」「两个方向只能选一个」）；信息足够时不要打扰用户。一次只问一件事，选项最多 6 个；纯开放式问题可以不给选项。一次回合最多问 3 次，第 4 次会被拒绝。',
  '验收单：任务要分几步做时，开工前先用 todo_write 写 2-8 条，每条 acceptance（怎么算完成）必填；做完一条立刻再调一次 todo_write 把 status 改成 done 并补 evidence（文件:行 / 命令输出 / HTTP 复现）。做不了或跳过的条目写 failed/skipped，最终回答的 ## Not covered 必须逐条点名它们——done 无证据、failed/skipped 没点名，报告闸会判不合格。',
  // 不再绑定界面语言：模型用与用户提问相同的语言作答（界面中英文只影响 UI 文案）
  '回答简洁，先结论后证据；用与用户提问相同的语言作答（用户写中文就用中文，写英文就用英文）。用 markdown 排版（结论加粗、证据用列表、长输出用代码块）。'
].join('\n');

// ---- 双轨纪律（2026-11-14 用户定案）：检验严格 fail-closed；开发听人类命令优先 ----
// audit 轨 = SYSTEM_BASE（验收员纪律，原样）；dev 轨 = SYSTEM_DEV_BASE（下面）。
// 选轨按回合意图：用户消息命中验收/体检/审计/渗透等关键词 → audit，否则 dev（ipc-agent 判定后传 roleMode）。
const SYSTEM_DEV_BASE = [
  '你是 FinalCheck（终检）开发助手：帮用户写代码、改代码、做工具、排查问题。人类指令优先——用户明确要求的事直接动手做，不要用验收/审计纪律反问、推脱或要求先跑检查；拿不准的技术选型先选一个合理的默认并继续做，做完在结尾用一句话说明可替换点。',
  '发现必须带证据说话：改了什么贴 diff/输出，报错贴原文，不编造测试结果——没跑就说没跑。',
  '动手顺序：先 read_file 看清原文再改（edit_file 的 old_string 必须唯一，做最小替换）；新建文件用 write_file；改动尽量小而聚焦，一次一个目标，改完立即跑最小验证（语法检查 / 定向单测 / 启动冒烟）并把输出贴给用户。',
  '修审计发现时按技能修：audit_project 报出的每类问题（S3 密钥轮换 / S1 路由鉴权 / S2 注入 / S4 依赖 / A1 权限收敛 / A2 提示注入 / A3 沙箱限额 / A4 数据脱敏 / H1 交接 / O1 运维）先 read_playbook(topic=对应编号 41-50) 读修复技能，按其「修复步骤」执行、按其「验证」段重跑对应 gate 确认归零。',
  '多条独立发现并行修：≥3 条互不依赖的审计发现（不同文件/不同规则）→ run_workflow 扇出修复——每条发现一个独立子代理（prompt 写明「先 read_playbook(topic=对应编号) 读修复技能再动手」），depends_on 全部空数组并行；最后一步汇总「各发现修没修好 + 重跑 gate 的结果」。修复失败的发现如实列「未修好 + 原因」，不许为了结论好看硬说修完。',
  '需要并行查证/多路改造时用 run_workflow 分头跑（步骤 3-8 个，每步一个独立子代理；不需要上游结果就写 depends_on: [] 并行）；单文件小改动不要用工作流，自己直接做更快。每步 name 用职位名（4-10 字），不许写「步骤 1」。',
  '轻量子代理（spawn_agent）的判断标准：预计要搜 / 读 5 个以上文件才能回答的调查型问题（「X 都在哪」「Y 是怎么实现的」「帮我摸清某个模块」「所有用到 Z 的地方」），不要自己一个个翻——第一步就派 spawn_agent 去查，只拿结论回来，你自己的上下文保持干净；问题能拆成几个互不相关的方向时（例如「登录怎么做的」和「CSRF 怎么防的」），在同一次回复里各派一个，它们会并行。只有一两次 read_file / grep_code 就能搞定的小问题才自己做。要多路分工、互相依赖、需要盲验复核的验收 / 审计大任务用 run_workflow。重要结论想再确认一遍时，可以派 type=verify 的子代理独立复核（把结论和证据写进 prompt）。',
  '长任务提速（2026-11-19 实测：做一个宣传片 529 步、109 分钟，其中 99 分钟在等模型、353 次回复只调了 1 个工具）：① 互不依赖的读文件 / 查看 / 命令放在同一次回复里一起发（读文件 / 搜索 / 看图 / 截图会并发执行；多条互不依赖的命令可以合并进一次 run_command），不要一次只调一个；② 视觉迭代要成批——一条命令里循环渲染或截取多帧（或用脚本拼成一张总览图），一次 view_image 看完（每次最多 4 张），把看到的问题列全、一次改完，再整体验证一次；不要「改一处 → 渲染一帧 → 裁图 → 看一眼」反复循环；③ 已经确认没问题的部分不要重复检查。',
  '看图与截图：做 PPT / 网页 / 视频 / 海报 / 图表这类视觉产物时，生成后必须用 capture_screenshot 逐页（或关键帧）看实际效果，文字溢出、重叠、错位、配色不对就改，改完再截一次确认；不要只看代码就说「应该没问题」。用户或项目里的图片用 view_image 直接看。写完页面一定要先 capture_screenshot 看一遍再交，不要凭代码猜。',
  '操作电脑或网页时的选路顺序（硬规则，照 Claude Code 的优先级）：① 能用专用工具就用专用工具（读写文件、跑命令、audit_project 等）；② **网页相关的活一律走 browser_* 系列**（browser_navigate → browser_snapshot 拿 ref → browser_click / browser_type），不要用 computer_action 去点网页——浏览器在桌面权限里是「只读」，点了会被拒，而且像素点选本来就不准；③ 只有「非浏览器的桌面软件」（Word / Excel / Photoshop / 系统设置 / 本地 GUI 工具）才用 computer_*：先 computer_request_access 请求授权（列明要操作哪个应用），同意后用 computer_screenshot 看屏幕 → computer_action 执行 → **每一步之后重新 computer_screenshot 确认**，不要假设点对了。终端和编辑器在桌面权限里是「只能左键」，输入文字会被拒——那类活应该用 run_command / write_file，不是去点界面。',
  '需要用户拍板的事（砍功能/动线上数据/花钱的 API）用 ask_user 问一次就动手；其余决策自己定。一次回合最多问 3 次。',
  'ask_user 语言规则（dev 模式同样适用）：question、option 的 label 与 description 一律用**用户界面语言**写——界面是英文就写英文，界面是中文就写中文。不要因为用户消息是中文就在英文界面里写中文问题：界面语言优先级高于用户消息语言。另外，问题本身必须自包含（不要写「这个」「上面那个」），用户只看得到这一张卡。',
  '路径参数转义（硬规则）：JSON 参数里的 Windows 路径一律优先写正斜杠（D:/Projects/demo）；必须用反斜杠时一律双写（D:\\\\Projects\\\\demo）；写成单反斜杠会让参数不是合法 JSON，工具不会执行。',
  '工具结果超长时会被截断为「头+尾」并完整落盘，按提示的 spill 路径用 run_command 检索，不要猜中间内容。',
  '产出可预览文件（html / png / pdf / mp4 / pptx / md 等）后，调用 present_artifact(path) 登记；用户在聊天里点一下就出现在右侧预览面板（视频可直接播放，PDF/PPT/Word 分页展示）。',
  '项目记忆：项目根的 AGENTS.md（项目宪法）每轮自动注入，其中约定优先遵守。用户说「记住」、或你摸清了下次一定用得上的长期事实（构建/测试命令、源码与产物目录、禁忌）时，用 remember_project 按 kind 分节写一条；不写任务过程、产物清单、数量、进度；旧条目过时就传 replace 更新。',
  '底线（与模式无关）：写操作限制在工作区/用户指定目录内；灾难性命令由系统拦截兜底；密钥/凭据不写进代码、不上传外部服务。',
  '回答简洁，先结论后证据；用与用户提问相同的语言作答（用户写中文就用中文，写英文就用英文）。用 markdown 排版（结论加粗、改动用列表、长输出用代码块）。'
].join('\n');

const systemPromptCache = new Map();
export function getSystemPromptParts(mode = 'audit') {
  const key = mode === 'dev' ? 'dev' : 'audit';
  if (!systemPromptCache.has(key)) {
    systemPromptCache.set(key, (async () => {
      const base = key === 'dev' ? SYSTEM_DEV_BASE : SYSTEM_BASE;
      let skills = '';
      try {
        const catalog = await loadCatalog();
        if (key === 'dev') {
          // dev 轨要的是修复技能（41-50），而 renderCatalog 只覆盖 web-vuln（01-40）。
          // 不给目录，模型就只看到 prompt 里一句「topic=对应编号 41-50」，根本不知道每号是什么
          // ——2026-11-20 实测：41-50 一次没被读过，修复全靠即兴。这里单独渲染 dev-fix 那一段。
          const fix = await loadSkills({}).catch(() => []);
          const fixOnly = fix.filter((e) => e.domain === 'dev-fix');
          skills = fixOnly.length
            ? renderCatalog(fixOnly, { triggerChars: 56 }) + '\n'
              + '（上面是修复技能；要判「某个高危能不能被真利用」时再看漏洞复核手法：list_playbooks 会列出 01-40。）'
            : renderCatalog(catalog);
        } else {
          skills = renderCatalog(catalog);
        }
      } catch { /* 方法论库缺失不阻断对话 */ }
      return { base, skills, full: base + (skills ? '\n\n' + skills : '') };
    })());
  }
  return systemPromptCache.get(key);
}
async function getSystemPrompt(mode = 'audit') {
  return (await getSystemPromptParts(mode)).full;
}

async function spillResult(toolName, callId, text) {  try {
    const dir = spillDir();
    await mkdir(dir, { recursive: true });
    const safe = String(toolName || 'tool').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    const file = path.join(dir, `${Date.now()}-${safe}-${String(callId || randomUUID()).replace(/[^a-z0-9_-]/gi, '').slice(-8)}.txt`);
    await writeFile(file, text, 'utf8');
    return file;
  } catch {
    return null; // 落盘失败保留头尾，不把成功调用变成失败
  }
}

/* ---------- 空回复补交（nudge）：同一轮最多催两次，第二次强制只输出正文 ---------- */
const MAX_EMPTY_NUDGES = 2;
const EMPTY_NUDGE_DIGEST_ITEMS = 12;
/* ---------- 复读熔断参数（round8 实测：自检阶段同义复述 20+ 分钟，被 402 才收场） ---------- */
// 正文 exact-tail 检测（每 400 字查一次）+ 20k 正文帽是老闸；下面补思考流与工具参数流两块盲区
// 2026-11-20 修正（r11 实测）：原来 reasoning 只判长度，超 60k 就标成「复读」直接判死。
// 三轮实测（r8 120k / r9 120k / r11 96k）用 40/60/80/120 字四档滑窗扫过，最高频片段只出现 1-2 次
// ——根本没有机械复读，只是开放式任务上想得久。开放式任务越自由（写文案/定视觉/做取舍）越容易
// 想久，结果两次都是 0 个文件、~460 秒全烧在思考上。
// 现在改成：reasoning 用「周期重复检测」抓真复读；长度帽抬到 200k 只做兜底，且兜底时给的是
// 「想太久了」的催收（不消耗不限额度），不是判死。
const REASONING_LOOP_CAP = 200000;   // 思考流硬帽（兜底）：正常长思考实测最多 12 万，200k 留足余量
const REASONING_DUP_MIN = 3000;      // 低于此长度不做重复检测（太短的思考本来就没法判断周期）
const REASONING_DUP_CHECK = 800;     // 每新增这么多字扫一次（避免每块都跑 indexOf）
const REASONING_DUP_MAX_QUERIES = 60; // 单次检测最多查这么多个候选周期（防止长文本上 O(n²)）
const ARGS_LOOP_CAP = 100000; // 单轮工具参数总量帽：正常 write 大文件也远够不着，读到这基本是参数复读
const MAX_REPETITION_NUDGES = 2; // 真复读熔断后先催收（不直接判死）；连催 2 次仍复发才报错收轮
const MAX_LONG_THINK_NUDGES = 3; // 「想太久」单独计额度，不与上面共用——否则正常长思考会吃掉复读的催收机会
const EMPTY_NUDGE_DIGEST_LINE_MAX = 200;
const EMPTY_NUDGE_DIGEST_MAX = 2400;

/**
 * 把最近 N 条工具结果压成「证据摘要」：每条只取第一行（≤200 字），总长 ≤2400 字。
 * 第二次补交（tool_choice='none'）时把模型自己跑出来的证据再摆到眼前，避免它「忘了干过什么」。
 * @param {any[]} [messages] chat/completions 消息数组（只看 role==='tool'）
 * @param {{items?:number,lineMax?:number,maxChars?:number}} [opts]
 * @returns {string} 空串表示没有可用证据
 */
export function buildEmptyNudgeDigest(messages, {
  items = EMPTY_NUDGE_DIGEST_ITEMS,
  lineMax = EMPTY_NUDGE_DIGEST_LINE_MAX,
  maxChars = EMPTY_NUDGE_DIGEST_MAX
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const tools = list.filter((m) => m?.role === 'tool');
  const take = Math.max(1, Math.trunc(Number(items) || EMPTY_NUDGE_DIGEST_ITEMS));
  const lines = [];
  for (const m of tools.slice(-take)) {
    const raw = typeof m.content === 'string' ? m.content : '';
    const line = raw.replace(/\r\n/g, '\n').split('\n').map((x) => x.trim()).find(Boolean) || '';
    if (!line) continue;
    lines.push(`- ${line.length > lineMax ? `${line.slice(0, lineMax)}…` : line}`);
  }
  if (!lines.length) return '';
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// onChunk：每收到一个数据块就回调一次，参数 chunkHasProgress 表示这一块是否带「真实进度」
// （content / reasoning / tool_calls / usage）。静默看门狗只认真实进度：
// 网关的 SSE 注释 / 空 data / 只有 role 的块是心跳，不能让 180s 静默阈值永久失效。
/**
 * 合并一条流式 tool_call delta（原地修改 toolCalls，meta 只用于本次流内的归属判断）。
 * 旧实现把 index 当唯一键：有网关把多个并行调用的 index 都写成 0，`name +=` / `arguments +=`
 * 会把两个调用粘成 `audit_projectdownload_gate` + 两段 JSON 首尾相接，参数必然非法。
 * 归属规则：id 相同 → 同一条；否则看同一 index 的最近一条；出现新 id、或已有 name 又出现新 name
 * → 新建 entry（宁可按顺序拆成两条，也不把不同调用拼在一起）。
 * @param {Array<any>} toolCalls 对外输出的调用数组（顺序 = 首次出现顺序）
 * @param {Array<{index:number|null,id:string,call:any}>} meta 本次流内的归属表
 * @param {any} tc 流式 delta
 */
function mergeStreamingToolCall(toolCalls, meta, tc) {
  const id = tc?.id == null ? '' : String(tc.id);
  const rawIndex = Number(tc?.index);
  const index = Number.isFinite(rawIndex) ? Math.max(0, Math.trunc(rawIndex)) : null;
  const name = typeof tc?.function?.name === 'string' ? tc.function.name : '';
  const args = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '';
  const append = (call) => {
    if (name) call.function.name += name;
    if (args) call.function.arguments += args;
  };
  // 1) id 是权威键：同 id 的后续分片（含 name/arguments 分片）都追加到同一条
  if (id) {
    const same = meta.find((m) => m.id === id);
    if (same) { append(same.call); return same.call; }
  }
  // 2) 没有匹配 id：找同一 index 上最近的一条，冲突（新 id / 已有 name 又出现 name）就新建
  // 连 index 都没有的网关：退回「最近一条」，避免参数续片被当成新调用
  const lastAtIdx = index == null
    ? (meta.length ? meta[meta.length - 1] : null)
    : [...meta].reverse().find((m) => m.index === index);
  const idConflict = !!(id && lastAtIdx?.id && lastAtIdx.id !== id);
  const nameConflict = !!(name && lastAtIdx?.call?.function?.name);
  if (lastAtIdx && !idConflict && !nameConflict) {
    if (id && !lastAtIdx.id) lastAtIdx.id = id; // 网关先给参数后给 id 时，认领同一条
    append(lastAtIdx.call);
    return lastAtIdx.call;
  }
  const call = { id, type: 'function', function: { name: '', arguments: '' } };
  meta.push({ index, id, call });
  toolCalls.push(call);
  append(call);
  return call;
}

// 重叠计数：String.split 只数「不重叠」的出现——复读周期 < 尾窗长度（如 150 < 200）时，
// 5 次重复会被数成 3 次，检测因此漏报（round8 单测实测踩中）。indexOf 步进 1 数重叠出现。
function countOverlapping(hay, needle, cap = 8) {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0 && n < cap) { n++; i = hay.indexOf(needle, i + 1); }
  return n;
}

/**
 * 思考流「周期复读」检测（2026-11-20 新增，替代原来的纯长度判死；同日修正误判）。
 *
 * 为什么不能只看长度：r11 实测 12 万字思考里 40/60/80/120 字四档滑窗最高频片段只出现 1-2 次，
 * 也就是「想得久」不是「复读」。但 reasoning 又必须有一道闸——真复读时它是无上限增长的。
 *
 * 2026-11-20 第二版（修正实测误判）：
 *   第一版最短周期 40 字 + 「出现 4 次就算复读」，结果模型在思考里起草 5 个结构相同的 JSON / CSS 块时
 *   会被判成复读——代码块天然同构，只有字段值不同。这类误判比原来的长度帽更隐蔽：它会在正常写页面时
 *   触发，提示「你复读了」，连着两次就判死。
 *   第二版：
 *   ① 最短周期从 40 字提到 200 字（真复读的周期通常是整句/整段，不是几十字；代码块通常 <200 字）；
 *   ② 要求「首尾相接」——重复片段必须紧挨着连续出现（A A A A），不是散落在上下文里各出现一次；
 *   ③ 跳过明显的代码块/结构化片段（含 { } [ ] 占比高的、以缩进开头的行）。
 *
 * @param {string} text 累积的思考文本
 * @param {number} [window=6000] 只扫最近这么多字（复读是「当下正在发生」，不需要全 history）
 * @param {number} [minRepeat=4] 同一片段至少连续重复几次才算复读
 * @returns {boolean}
 */
export function detectReasoningLoop(text, { window = 6000, minRepeat = 4 } = {}) {
  const s = String(text || '');
  if (s.length < REASONING_DUP_MIN) return false;
  const seg = s.slice(-Math.min(window, s.length));
  if (seg.length < 900) return false;

  // 候选周期不能只扫固定网格：真复读的周期是「模型自己那句话的长度」，
  // 它可能落在任何数值上（实测 36 字的句子反复刷，40/50/63 的网格全都错位扫不到）。
  // 所以先把候选周期从固定网格里取一批，再补一批「以行尾/句尾为边界」的周期。
  const candidates = new Set();

  // ① 固定网格（几何递增），兜住散文式复读
  const MIN_PERIOD = 40;
  const maxPeriod = Math.max(MIN_PERIOD, Math.floor(seg.length / (minRepeat + 1)));
  for (let p = MIN_PERIOD; p <= maxPeriod && candidates.size < REASONING_DUP_MAX_QUERIES; p = Math.max(p + 1, Math.floor(p * 1.26))) {
    candidates.add(p);
  }

  // ② 真实句子边界：从 seg 末尾往前找换行/句末标点，用它切出的每个前缀都试一遍
  //    这能精确命中「同一句话反复刷」，不管那句多长
  const boundaries = [];
  for (let k = seg.length - 1; k > 0 && boundaries.length < 24; k--) {
    const ch = seg[k];
    if (ch === '\n' || ch === '。' || ch === '！' || ch === '？' || ch === '.' || ch === '；' || ch === ';') {
      const len = seg.length - (k + 1);
      if (len >= 20 && len <= maxPeriod) boundaries.push(len);
    }
  }
  for (const b of boundaries) candidates.add(b);
  // 边界长度的小倍数（两句重复、三句重复）
  for (const b of boundaries.slice(0, 6)) {
    for (const m of [2, 3]) {
      const p = b * m;
      if (p <= maxPeriod) candidates.add(p);
    }
  }

  for (const p of candidates) {
    if (p < 20 || p >= seg.length) continue;
    const probe = seg.slice(-p);
    if (!probe.trim()) continue;
    // 跳过代码块：结构化片段几乎必然同构（字段名一样、只有值不同），不能当复读
    if (looksLikeCode(probe)) continue;
    // 必须首尾相接：seg 结尾是 probe，往前再看它是否紧贴着又出现 minRepeat-1 次。
    // 这一条才是区分「复读」和「结构相似但内容不同」的关键——正常写作里相同片段不会紧挨着排队。
    if (countTrailingRepeats(seg, probe, minRepeat) >= minRepeat) return true;
  }
  return false;
}

/** 这段文本像代码/结构化数据吗（{ } [ ] 密度高、或多数行以缩进开头） */
function looksLikeCode(chunk) {
  const s = String(chunk || '');
  if (!s) return true;
  const braces = (s.match(/[{}[\]]/g) || []).length;
  if (braces * 20 >= s.length) return true; // 每 20 字就有一个括号 → 结构化
  const lines = s.split('\n').filter((l) => l.trim());
  if (!lines.length) return true;
  const indented = lines.filter((l) => /^\s{2,}/.test(l) || /[:;,{]\s*$/.test(l)).length;
  return indented * 2 > lines.length; // 过半行是缩进/以标点结尾 → 代码
}

/**
 * 从 seg 末尾往前数「紧挨着」出现了几次 probe（A A A A 而非 A x A x A）。
 * 只数连续的，散落各处的重复不算复读。
 */
function countTrailingRepeats(seg, probe, cap = 8) {
  let n = 0;
  let end = seg.length;
  while (n < cap) {
    const start = end - probe.length;
    if (start < 0) break;
    if (seg.slice(start, end) !== probe) break;
    n++;
    end = start;
  }
  return n;
}

/* ---------- 死磕检测：从工具结果里提取「这一轮卡在什么错误上」 ---------- */
// 目标不是判「重复调用」（那是 toolLoopRounds 干的），而是判「换着法子试，但撞的是同一个错误」。
// 典型：改了 5 次代码，每次编译报的都是同一个 SyntaxError / 测试还是同样的 2 failed / 
// 服务还是起不来（同一个 EADDRINUSE）。这种要提示模型跳出圈，而不是继续磨。
const STUCK_ROUNDS = 5; // 连续 5 轮同一个错误 → 提示跳出
const STUCK_MAX_NUDGES = 2; // 同一指纹最多提示 2 次（第 3 次起不再打扰）
const STUCK_SIG_MAX = 120;

/** 从一轮工具结果里提取失败指纹；没有失败返回 null */
export function extractFailureSig(toolResults) {
  const list = Array.isArray(toolResults) ? toolResults : [];
  const parts = [];
  for (const r of list) {
    const payload = r?.trace?.result ?? r;
    if (!payload || typeof payload !== 'object') continue;
    // ① 显式失败（工具自己报的 error）
    if (typeof payload.error === 'string' && payload.error.trim()) {
      parts.push('err:' + normalizeErrLine(payload.error));
      continue;
    }
    // ② 命令退出码非 0：从 stderr / stdout 里挑第一行像错误的
    const code = Number(payload.code);
    if (Number.isFinite(code) && code !== 0) {
      const text = String(payload.stderr || '').trim() || String(payload.stdout || '').trim();
      parts.push('exit' + code + ':' + normalizeErrLine(pickErrorLine(text)));
      continue;
    }
    // ③ 测试失败数 / 编译错误数（输出里能数出来的，用它当指纹更稳）
    const out = String(payload.stdout || '');
    const testFail = /(\d+)\s*(?:failed|failing)/i.exec(out) || /(\d+)\s*passed[^\n]*?(\d+)\s*failed/i.exec(out);
    if (testFail && Number(testFail[1]) > 0) parts.push('testsfail:' + testFail[1] + ':' + normalizeErrLine(pickErrorLine(out)));
  }
  if (!parts.length) return null;
  // 一轮里有多个失败时只取第一个（第一个通常是根因，后面多是它引发的连锁）
  return parts[0].slice(0, STUCK_SIG_MAX);
}

/** 从多行输出里挑一行最像「错误本身」的（而不是调用栈/路径） */
function pickErrorLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // 优先含错误关键词的行
  const KEY = /(error|exception|failed|failure|cannot|unable|not found|denied|invalid|unexpected|syntaxerror|traceback|EADDRINUSE|undefined)/i;
  const hit = lines.find((l) => KEY.test(l)) || lines[0] || '';
  return hit;
}

/** 归一化：去掉行号/列号/时间戳/路径里的随机部分，让「同一类错误」落到同一个指纹 */
function normalizeErrLine(text) {
  return String(text || '')
    .replace(/[A-Za-z]:[\\/][^\s:'"]+/g, '<path>')       // Windows 绝对路径
    .replace(/\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>')        // POSIX 路径
    .replace(/:\d+(?::\d+)?/g, ':<n>')                    // :12:34 行号列号
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<ts>') // 时间戳
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')                // 内存地址
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}


// 时间照旧不限（用户拍板），拦的是「零进展的动作重复」：相同输入必然得到相同输出，
// 连续多轮完全相同的调用就是卡死循环。轮询类合法场景（改了中间步骤）会打断连续计数，不受影响。
function canonArgs(a) {
  const s = String(a || '');
  try {
    const sort = (v) => (Array.isArray(v) ? v.map(sort) : (v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
      : v));
    return JSON.stringify(sort(JSON.parse(s)));
  } catch {
    return s; // 非 JSON 参数按原文比对
  }
}

// 一轮调用的签名：工具名 + 规范化参数；并行多调用排序后拼接（顺序抖动不算不同）
export function toolCallSig(calls) {
  if (!Array.isArray(calls) || !calls.length) return null;
  return calls
    .map((c) => `${String(c?.function?.name || '')}:${canonArgs(c?.function?.arguments)}`)
    .sort()
    .join(' | ');
}

const TOOL_LOOP_WARN_ROUNDS = 3; // 连续 3 轮相同 → 注入「换思路」提醒（工具照常执行，结果可能合法）
const TOOL_LOOP_STOP_ROUNDS = 5; // 连续 5 轮相同 → 不执行，人话报错收轮

export async function consumeStream(res, onToken, onEvent, ctl, onChunk = null) {
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  const toolCallMeta = []; // 流式分片的归属表：{index,id,call}，不写进最终 toolCalls
  let raw = '';
  let usage = null;
  let finishReason = null;
  let lastCheckLen = 0;
  let lastThinkCheck = 0; // reasoning 重复检测的检查点（避免每块都扫）
  let repetitive = false;
  // 复读熔断专用标记：熔断也走 ctl.abort()，如果不与「用户停止」区分，
  // catch 会把 AbortError 归成 aborted（中断），repetitive 分支永远不可达——
  // round8 实测：20 分钟的同义复述被当成「已中断」照单全收（用户截图为证）。
  let loopAbort = false;
  // 「想太久」单独一条路径（2026-11-20）：reasoning 触及硬帽但没检测到周期复读时，
  // 不能说它是复读（会诱导模型误报「我之前循环了」），也不能直接判死（开放式任务会全军覆没）。
  let longThink = false;
  let longAbort = false;
  // 活动提示（WorkingStatus 实时文案）：真实增量驱动，不伪造进度。
  // 首 token → Writing…；tool_calls 参数流 → Writing <tool>…；参数继续增长时
  // 每累计 ≥512 字符且距上次提示 ≥500ms 才再发一条（带 chars），避免刷屏。
  const ACTIVITY_CHARS_STEP = 512;
  const ACTIVITY_THROTTLE_MS = 500;
  const act = { toolSeen: false, lastTool: '', lastChars: 0, lastAt: 0, contentSeen: false };
  const emitActivity = (label, extra = {}) => {
    try { onEvent?.({ kind: 'activity', label, ...extra }); } catch { /* 观测回调失败不影响流 */ }
  };
  const toolArgsTotal = () => toolCalls.reduce((n, tc) => n + String(tc?.function?.arguments || '').length, 0);
  const toolNameOf = () => {
    for (let i = toolCalls.length - 1; i >= 0; i--) {
      const n = String(toolCalls[i]?.function?.name || '').trim();
      if (n) return n;
    }
    return '';
  };
  const noteToolDelta = () => {
    const total = toolArgsTotal();
    const name = toolNameOf();
    if (name) act.lastTool = name;
    const at = Date.now();
    if (!act.toolSeen) {
      act.toolSeen = true;
      act.lastChars = total;
      act.lastAt = at;
      emitActivity(`Writing ${act.lastTool || 'script'}…`, { tool: act.lastTool || null, chars: total });
      return;
    }
    if (total - act.lastChars >= ACTIVITY_CHARS_STEP && at - act.lastAt >= ACTIVITY_THROTTLE_MS) {
      act.lastChars = total;
      act.lastAt = at;
      emitActivity(`Writing ${act.lastTool || 'script'}…`, { tool: act.lastTool || null, chars: total });
    }
  };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let lineBuf = '';
  let aborted = false;
  // 当前数据块的「真实进度」：解析到 content / reasoning / tool_calls / usage 才置 true。
  let chunkProgress = false;
  const handleLine = (line) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    if (j.usage) { usage = j.usage; chunkProgress = true; }
    if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
    const d = j.choices?.[0]?.delta || {};
    // 思考流：不同网关字段名不同（DeepSeek reasoning_content / 本网关 reasoning / thinking）
    const think = [d.reasoning_content, d.reasoning, d.thinking].find((x) => typeof x === 'string' && x);
    if (think) {
      reasoning += think;
      chunkProgress = true;
      onEvent?.({ kind: 'reasoning', text: think });
      // 思考频道的闸（2026-11-20 重写）：先判「周期复读」——那才是真复读；长度帽只做兜底并且
      // 归到「想太久」，交给上层用另一套话术催收（不判死、不消耗复读催收额度）。
      if (!repetitive && reasoning.length >= REASONING_DUP_MIN && reasoning.length - lastThinkCheck >= REASONING_DUP_CHECK) {
        lastThinkCheck = reasoning.length;
        if (detectReasoningLoop(reasoning)) { repetitive = true; loopAbort = true; ctl?.abort(); }
      }
      if (!repetitive && !longThink && reasoning.length > REASONING_LOOP_CAP) { longThink = true; longAbort = true; ctl?.abort(); }
    }
    if (d.content) {
      chunkProgress = true;
      if (!act.contentSeen) {
        act.contentSeen = true;
        // 正文开始流式输出；同一响应里已经在流工具参数时（少数网关先给参数后给话）按「写脚本」提示
        emitActivity(act.toolSeen ? 'Writing script…' : 'Writing…');
      }
      content += d.content;
      onToken?.(d.content);
      // 用户实测教训：模型复读循环 harness 曾照单全收 → 熔断
      if (content.length - lastCheckLen >= 400) {
        lastCheckLen = content.length;
        const tail = content.slice(-200);
        if (tail.length >= 50 && countOverlapping(content, tail) >= 4) { repetitive = true; loopAbort = true; ctl?.abort(); }
      }
      if (content.length > 20000) { repetitive = true; loopAbort = true; ctl?.abort(); }
    }
    let sawToolDelta = false;
    for (const tc of d.tool_calls || []) {
      mergeStreamingToolCall(toolCalls, toolCallMeta, tc);
      sawToolDelta = true;
    }
    if (sawToolDelta && toolArgsTotal() > ARGS_LOOP_CAP) {
      // 工具参数流的复读（round8 实测「Writing read_file… 21m57s」：参数无限增长）同样熔断
      repetitive = true;
      loopAbort = true;
      ctl?.abort();
    }
    if (sawToolDelta) { chunkProgress = true; noteToolDelta(); } // 首次出现 → Writing <tool>…；之后按 512 字符/500ms 节流更新
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkProgress = false; // 每块重新判定：心跳块（SSE 注释/空 data）不算进度
      const chunk = dec.decode(value, { stream: true });
      raw += chunk;
      lineBuf += chunk;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) handleLine(line);
      try { onChunk?.(chunkProgress); } catch { /* 观测回调失败不影响流 */ }
    }
  } catch (e) {
    if (loopAbort || longAbort) {
      // 内部熔断：不冒充用户中断（否则重复/超长标志丢失，输出被当成「已中断」落账）
    } else if (ctl?.signal?.aborted || e?.name === 'AbortError' || /abort/i.test(e?.message || '')) {
      // dsh 语义：中断不截断——已流出的内容原样保留，返回 aborted 标记交给上层合成「已中断」收尾
      aborted = true;
    } else {
      throw e;
    }
  }
  if (lineBuf) handleLine(lineBuf); // 末行没有换行（网关直接断流）时也要解析，否则 usage/内容丢
  // 收尾补检：节流节奏（每 400 字查一次）会漏掉流末尾不足 400 字的最后一段——
  // 「整轮复读刚好卡在阈值下收尾」会被放行（单测构造 912 字复读实测踩中）
  if (!repetitive && content.length >= 400) {
    const tail = content.slice(-200);
    if (tail.length >= 50 && countOverlapping(content, tail) >= 4) repetitive = true;
  }
  if (aborted) return { content, reasoning, toolCalls: [], raw, aborted: true, usage, finishReason };
  if (repetitive) return { content, reasoning, toolCalls: [], raw, repetitive: true, usage, finishReason };
  // 想太久（触了 reasoning 硬帽但没有周期复读）：同样这一轮不算数，但标记不同，
  // 上层要走「催收继续」而不是「你复读了」——也不能消耗复读的催收额度。
  if (longThink) return { content, reasoning, toolCalls: [], raw, longThink: true, usage, finishReason };
  // 终审 P2#4：非标准网关返回裸 JSON（无视 stream）时兜底解析
  let out = { content, reasoning, toolCalls: toolCalls.filter(Boolean), raw, usage, finishReason };
  if (!out.content && !out.toolCalls.length) {
    try {
      const j = JSON.parse(raw.trim());
      if (j.usage) out.usage = j.usage;
      if (j.choices?.[0]?.finish_reason) out.finishReason = j.choices[0].finish_reason;
      const msg = j.choices?.[0]?.message;
      if (msg?.content) { out.content = msg.content; onToken?.(msg.content); }
      const think = [msg?.reasoning_content, msg?.reasoning, msg?.thinking].find((x) => typeof x === 'string' && x);
      if (think) out.reasoning = (out.reasoning || '') + think;
      if (msg?.tool_calls?.length) out.toolCalls = msg.tool_calls;
    } catch { /* 非 JSON 保持空 */ }
  }
  return out;
}

/**
 * 静默看门狗：只统计「距上一个字节」的时间——任何数据块都会 touch() 重置，连续 ms 毫秒
 * 一个字节都没有才 abort。这不是工作时长上限：只要还有字节在流动，跑多久都不杀。
 * ms<=0 时完全关闭。半程（如 180s 配置下的第 90s）只发一次 activity 提示，不中断。
 */
function startSilenceWatchdog(ms, { abort, onHint } = {}) {
  const limit = Number(ms);
  if (!Number.isFinite(limit) || limit <= 0) return { touch() {}, stop() {} };
  const half = Math.floor(limit / 2);
  let timer = null;
  let hintTimer = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; abort?.(); }, limit);
  };
  const armHint = () => {
    if (hintTimer) clearTimeout(hintTimer);
    if (half < 1000) return; // 半程不足 1s 的测试/短配置不提示，避免「已静默 0s」噪音
    hintTimer = setTimeout(() => { hintTimer = null; onHint?.(); }, half);
  };
  arm();
  armHint();
  return {
    touch() { arm(); armHint(); },
    stop() {
      if (timer) clearTimeout(timer);
      if (hintTimer) clearTimeout(hintTimer);
      timer = null;
      hintTimer = null;
    }
  };
}

// 兼容旧调用/旧测试：没有窗口配置时仍用旧的字符预算 CONVO_BUDGET 判断是否超限；
// 给了 contextWindow/maxOutputTokens 时走 token 单阈值（与 runAgentTurn 内部同一套）。
export function pruneConvo(list, config) {
  const hasWindow = Number(config?.contextWindow) > 0 || Number(config?.maxOutputTokens) > 0;
  if (hasWindow) {
    const budget = contextBudget(config);
    const tokens = estimateMessagesTokens(list);
    if (tokens < budget.compactThreshold) return false;
    // 2026-11-17 步 2：单阈值，到线就两步都做（不再有 micro/full 分支）
    const microChanged = microcompact(list);
    return fullCompact(list) || microChanged;
  }
  const size = (m) => String(m?.content ?? '').length + (Array.isArray(m?.tool_calls) ? JSON.stringify(m.tool_calls).length : 0);
  const total = list.reduce((n, m) => n + size(m), 0);
  if (total <= CONVO_BUDGET) return false;
  return microcompact(list, { keepRecentTool: TOOL_KEEP_RECENT });
}

// ---------- 工具并行调度（Wave 2） ----------
// 只有「等待型」工具值得并行：read_file / read_playbook 是磁盘读，probe_target / stress_target 是网络等待；
// 这类调用大部分时间在等 IO（让出事件循环），凑一批并发能显著缩短一轮耗时。
// 其余全部串行：run_command / edit_file / write_file 有写顺序依赖；audit_project / download_gate / quality_gate /
// get_report / run_workflow 是主线程 CPU 或子进程任务，并行只会堵事件循环，甚至让 UI 卡住。
// spawn_agent（0.26）：一次回复里的多个子代理同时跑（对齐 Claude Code 的 Agent 工具）
const PARALLEL_TOOLS = new Set(['read_file', 'read_playbook', 'probe_target', 'stress_target', 'review_diff', 'grep_code', 'view_image', 'capture_screenshot', 'spawn_agent']);

// 思考强度 → 请求参数。界面上的「Default（跟随模型默认）」= 不发这个参数；
// 0.26 以前会把 reasoning_effort: 'default' 原样发出去，有的网关直接回 HTTP 400（模拟客户端真模型评测抓到的）。
export function effortParam(effort) {
  const e = String(effort ?? '').trim().toLowerCase();
  if (!e || e === 'default' || e === 'auto') return {};
  return { reasoning_effort: e };
}

export function classifyTool(name) {
  return PARALLEL_TOOLS.has(String(name ?? '')) ? 'parallel' : 'serial';
}

// 并发上限 clamp 1–16，默认 8；undefined/非数字回落默认
export function clampToolConcurrency(value, fallback = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(16, Math.max(1, Math.trunc(n)));
}

// 限流 map：最多 limit 路并发，结果按输入下标回填（调用顺序不因完成先后而变化）
async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

// 中断收尾宽限：signal 触发后最多再等 300ms 让正在跑的工具自己返回；
// run_command 会在自己的 signal 回调里 taskkill 进程树，所以这里超时先回填 cancelled 也不会留孤儿进程。
const TOOL_ABORT_GRACE_MS = 300;
const cancelledToolResult = () => ({ error: t('已中断'), cancelled: true });

function awaitWithAbort(promise, signal, graceMs = TOOL_ABORT_GRACE_MS) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(cancelledToolResult());
  return new Promise((resolve) => {
    let settled = false;
    let graceTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      // 已中断：工具若在宽限期内返回，用它的结果（保留 stdout/stderr）；否则直接 cancelled
      graceTimer = setTimeout(() => finish(cancelledToolResult()), graceMs);
      promise.then(
        (v) => finish(v?.cancelled ? v : { ...(v && typeof v === 'object' ? v : {}), error: v?.error || t('已中断'), cancelled: true }),
        () => finish(cancelledToolResult())
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(finish, (e) => finish({ error: e?.message || String(e) }));
  });
}

// 推给渲染层的 tool-end 结果摘要上限：只让「用户该看见的东西」（note/error/code…）过 IPC，
// 大对象截成 preview。没有它，运行中的工具行只能显示静态文字，用户不知道「已转后台」。
export const UI_RESULT_MAX_CHARS = 400;

/**
 * tool-end 的结果摘要（≤ max 字）。小对象原样返回（note 等结构化字段都保留）；
 * 大对象只留 note，或截断 preview —— 绝不把整块 stdout / 大 JSON 塞进事件流。
 * @param {any} result
 * @param {number} [max]
 */
export function uiResultSummary(result, max = UI_RESULT_MAX_CHARS) {
  if (result == null) return null;
  if (typeof result !== 'object') return String(result).slice(0, max);
  let text = '';
  try { text = JSON.stringify(result) ?? ''; } catch { text = ''; }
  if (text.length <= max) return result; // 小结果：原样（含 note），不多造形状
  const out = { truncated: true, chars: text.length };
  if (typeof result.note === 'string' && result.note.trim()) out.note = result.note.slice(0, max);
  else out.preview = text.slice(0, max);
  return out;
}

/* ---------- tool_call 参数完整性闸（截断 / 非法 JSON） ----------
 * 用户实测（会话 ed8bc5d3，run_workflow）：模型把 4222 字符的 steps JSON 写成
 * `{"id":"s6","summary","name":...}`（键后缺冒号），旧逻辑把 JSON.parse 的异常直接当工具结果，
 * 卡片立刻变成红色错误条 —— 一个内部可自愈的 hiccup 被用户读成「回合跑到一半突然中断」。
 * 两条规则：
 *  1. finish_reason=length 且带 tool_calls：参数可能半截 → 一律不执行，整轮重发一次；
 *  2. 参数 parse 失败：不执行那一个调用，把「错误码 + 位置 + 前后各 80 字符（脱敏）」当工具结果回给模型，
 *     要求它只重发这一个调用；再失败才向用户报错。
 * 两个原因码同时用于「不发车」与「不留 running part」。 */
export const ARGS_TRUNCATED_CODE = 'ARGS_TRUNCATED';
export const ARGS_INVALID_JSON_CODE = 'ARGS_INVALID_JSON';
const ARGS_EXCERPT_RADIUS = 80;

/** 脱敏：疑似密钥（sk-xxx / Bearer xxx / key/token/password 字段值）在回显给模型/卡片前一律打码 */
export function redactArgSecrets(text) {
  return String(text ?? '')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1***')
    .replace(/("(?:api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)"\s*:\s*")[^"]*(")/gi, '$1***$2');
}

/** 解析错误的字符位置：V8 的 "at position N" / 新版 "at line X column Y" 都认 */
export function jsonErrorPosition(message) {
  const m = String(message || '').match(/at position\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

/* ---------- 参数自动修复（只做两类能确定语义的保守修复） ----------
 * 1) Windows 路径字符串：`"D:\Projects\demo"` / `"src\app.js"` 里的单反斜杠是分隔符，
 *    不是 JSON 转义 → 把该字符串里的反斜杠全部换成正斜杠；
 * 2) 对象/数组尾逗号：`{"dir":"D:/x",}` / `["a",]` → 删掉。
 * 不 eval、不猜缺失括号/引号；修完必须能 JSON.parse，否则原样失败（fail-closed）。 */
const JSON_VALID_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

function hasInvalidJsonEscape(raw) {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '\\') continue;
    const next = raw[i + 1];
    if (next == null || !JSON_VALID_ESCAPES.has(next)) return true;
    if (next === 'u' && !/^[0-9A-Fa-f]{4}$/.test(raw.slice(i + 2, i + 6))) return true;
    i += 1;
  }
  return false;
}

/** 只认「像路径」且确实含非法转义的字符串：盘符路径、.\ ..\ 相对路径、无空白的多段相对路径 */
function looksLikePathLiteral(raw) {
  if (!raw.includes('\\') || !hasInvalidJsonEscape(raw)) return false;
  if (/^[A-Za-z]:\\/.test(raw)) return true; // D:\...
  if (/^\.\.?[\\/]/.test(raw)) return true; // .\  ..\  ./
  return !/[\s:]/.test(raw) && /^[^\\]+(?:\\[^\\]+)+$/.test(raw); // src\app.js（不是 URL/散文）
}

/** 扫描 JSON 文本里的字符串字面量，仅把「像路径且含非法转义」的值改成正斜杠 */
function fixPathStringLiterals(text) {
  let out = '';
  let i = 0;
  let changed = false;
  while (i < text.length) {
    if (text[i] !== '"') { out += text[i]; i += 1; continue; }
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === '"') break;
      j += 1;
    }
    if (j >= text.length) { out += text.slice(i); break; }
    const raw = text.slice(i + 1, j);
    if (looksLikePathLiteral(raw)) {
      out += JSON.stringify(raw.replace(/\\+/g, '/'));
      changed = true;
    } else {
      out += text.slice(i, j + 1);
    }
    i = j + 1;
  }
  return { text: out, changed };
}

/** 去掉对象/数组之后的尾逗号（字符串内部不动） */
function removeTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (j < text.length && (text[j] === '}' || text[j] === ']')) { changed = true; continue; }
    }
    out += ch;
  }
  return { text: out, changed };
}

/** 去掉对象/数组之后多余的尾括号（模型偶尔多吐一个 `}`）；只在前缀本身是合法 JSON 时移除 */
function removeExtraClosingDelimiters(text) {
  let current = text;
  let changed = false;
  for (let i = 0; i < 8; i += 1) {
    try {
      JSON.parse(current);
      return { text: current, changed };
    } catch (e) {
      const pos = jsonErrorPosition(e?.message || String(e));
      if (pos == null) return { text, changed: false };
      const head = current.slice(0, pos).replace(/\s+$/, '');
      const tail = current.slice(pos).trim();
      if (!/^[\]\}]+$/.test(tail)) return { text, changed: false };
      try {
        JSON.parse(head);
        current = head;
        changed = true;
      } catch {
        return { text, changed: false };
      }
    }
  }
  return { text: current, changed };
}

/**
 * 尝试把工具参数字符串修成合法 JSON。
 * @param {string} raw 模型给出的 arguments 原文
 * @returns {{ok:true,value:any,repairs:string[]}|{ok:false,value:null,repairs:string[]}}
 */
export function repairToolArgsJson(raw) {
  const text = String(raw ?? '');
  try {
    return { ok: true, value: JSON.parse(text || '{}'), repairs: [] };
  } catch { /* 落到下面的保守修复 */ }
  const repairs = [];
  let current = text;
  const fixedPaths = fixPathStringLiterals(current);
  if (fixedPaths.changed) {
    repairs.push('Windows 路径反斜杠→正斜杠');
    current = fixedPaths.text;
  }
  const fixedCommas = removeTrailingCommas(current);
  if (fixedCommas.changed) {
    repairs.push('移除尾逗号');
    current = fixedCommas.text;
  }
  const fixedClosers = removeExtraClosingDelimiters(current);
  if (fixedClosers.changed) {
    repairs.push('移除多余尾括号');
    current = fixedClosers.text;
  }
  if (!repairs.length) return { ok: false, value: null, repairs: [] };
  try {
    return { ok: true, value: JSON.parse(current), repairs };
  } catch {
    return { ok: false, value: null, repairs: [] };
  }
}

/** 错误是否像「Windows 路径写成单反斜杠」：非法转义错误，或参数/片段里出现盘符路径 */
export function looksLikeWindowsPathJson(message, text = '') {
  return /bad escaped character/i.test(String(message || ''))
    || /[A-Za-z]:\\/.test(String(text || ''));
}

/**
 * 错误位置前后各 radius 字符（脱敏、压成一行）——回给模型足够定位，又不把整段参数/密钥塞回上下文。
 * @param {string} argsText
 * @param {number|null} [position] 缺省取末尾（截断场景）
 * @param {number} [radius]
 * @returns {string}
 */
export function argsErrorExcerpt(argsText, position = null, radius = ARGS_EXCERPT_RADIUS) {
  const text = String(argsText ?? '');
  if (!text) return '';
  const raw = Number(position);
  const pos = Number.isFinite(raw) ? Math.min(Math.max(0, Math.trunc(raw)), text.length) : text.length;
  const head = text.slice(Math.max(0, pos - radius), pos);
  const tail = text.slice(pos, Math.min(text.length, pos + radius));
  const snippet = `${pos > radius ? '…' : ''}${head}⟪错误位置⟫${tail}${pos + radius < text.length ? '…' : ''}`;
  return redactArgSecrets(snippet.replace(/\s+/g, ' ').trim());
}

/**
 * 逐个检查 tool_call 的参数是不是合法 JSON；非法的先尝试保守自动修复（修复成功则改写
 * tc.function.arguments 并从 invalid 移出，调用照常执行）。
 * @param {any[]} toolCalls
 * @returns {{total:number, invalid:Array<{index:number,id:string|null,name:string,message:string,position:number|null,excerpt:string,chars:number,windowsPath:boolean}>, repaired:Array<{index:number,id:string|null,name:string,repairs:string[]}>}}
 */
export function inspectToolCallArgs(toolCalls) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  const invalid = [];
  const repaired = [];
  list.forEach((tc, index) => {
    const argsText = String(tc?.function?.arguments ?? '');
    try {
      JSON.parse(argsText || '{}');
    } catch (e) {
      const message = e?.message || String(e);
      const fix = repairToolArgsJson(argsText);
      if (fix.ok && tc?.function && typeof tc.function === 'object') {
        tc.function.arguments = JSON.stringify(fix.value);
        repaired.push({
          index,
          id: tc?.id == null ? null : String(tc.id),
          name: String(tc?.function?.name || 'unknown'),
          repairs: fix.repairs
        });
        return;
      }
      const position = jsonErrorPosition(message);
      invalid.push({
        index,
        id: tc?.id == null ? null : String(tc.id),
        name: String(tc?.function?.name || 'unknown'),
        message,
        position,
        excerpt: argsErrorExcerpt(argsText, position),
        chars: argsText.length,
        windowsPath: looksLikeWindowsPathJson(message, argsText)
      });
    }
  });
  return { total: list.length, invalid, repaired };
}

/** 未执行调用的可读文案（卡片 + 返回值共用；不含 "in JSON at position" 字样，避免被 humanize 二次改写） */
export function toolArgsFailurePayload(bad, { truncated = false } = {}) {
  const code = truncated ? ARGS_TRUNCATED_CODE : ARGS_INVALID_JSON_CODE;
  const posHint = bad?.position == null ? '' : t('（第 {pos} 字符附近）', { pos: bad.position });
  const error = truncated
    ? t('工具参数被输出长度上限截断{posHint}，本次调用未执行', { posHint })
    : t('工具参数不是合法 JSON{posHint}，本次调用未执行', { posHint });
  const pathHint = !truncated && (bad?.windowsPath === true || looksLikeWindowsPathJson(bad?.message, bad?.excerpt));
  return {
    error,
    code,
    ...(bad?.position == null ? {} : { position: bad.position }),
    ...(Number.isFinite(Number(bad?.chars)) ? { chars: Number(bad.chars) } : {}),
    ...(bad?.excerpt ? { excerpt: bad.excerpt } : {}),
    ...(bad?.message ? { detail: redactArgSecrets(bad.message) } : {}),
    ...(pathHint ? { hint: PATH_JSON_HINT } : {})
  };
}

/**
 * 给模型的纠错/缩短提示（作为 tool 结果内容或 [系统] 消息）。
 * @param {string} toolName
 * @param {{truncated?:boolean, position?:number|null, chars?:number, excerpt?:string}} [info]
 * @returns {string}
 */
export function buildArgsRepairNotice(toolName, info = {}) {
  const truncated = !!info.truncated;
  const name = String(toolName || 'unknown');
  const head = truncated
    ? t('你上一次的工具调用「{name}」参数被输出长度上限截断了（{code}），这些调用没有执行。', { name, code: ARGS_TRUNCATED_CODE })
    : t('你上一次的工具调用「{name}」参数不是合法 JSON（{code}），这个调用没有执行。', { name, code: ARGS_INVALID_JSON_CODE });
  const where = info.position == null && !Number.isFinite(Number(info.chars))
    ? ''
    : t('解析失败位置：{pos}；参数总长：{chars} 字符。', {
      pos: info.position == null ? t('未知') : t('第 {n} 个字符', { n: info.position }),
      chars: Number.isFinite(Number(info.chars)) ? Number(info.chars) : t('未知')
    });
  const snippet = info.excerpt ? t('错误位置附近片段：{snippet}', { snippet: info.excerpt }) : '';
  const ask = truncated
    ? t('请把参数拆小/缩短后重新发起这一个工具调用（例如减少 steps、精简 prompt、改成分步调用）。')
    : t('请只重新发起这一个工具调用，参数必须是合法 JSON：键值之间必须有冒号，字段之间必须有逗号，字符串里的引号要转义；参数太长时请拆小。');
  return [head, where, snippet, ask].filter(Boolean).join('\n');
}

/**
 * 未执行的工具调用也要闭合：start+end 立刻成对发（part 绝不会停在 running），
 * 卡片显示原因码，模型拿到的 tool 结果里带纠错指令。
 * @returns {Promise<{id:any, trace:{tool:string,args:string,result:any}, modelContent:string}>}
 */
async function skipToolCall(tc, code, notice, { onEvent, onToolLifecycle, detail = null } = {}) {
  const name = String(tc?.function?.name || 'unknown');
  const argsText = String(tc?.function?.arguments || '');
  const callId = tc?.id == null ? null : String(tc.id);
  const t0 = Date.now();
  // 卡片看 error（短句）：detail.error 优先；模型看 hint（纠错指令 + 路径转义提示，含脱敏片段）
  const shortError = (detail && typeof detail === 'object' && detail.error) ? String(detail.error) : String(notice || '');
  const detailHint = (detail && typeof detail === 'object' && detail.hint) ? String(detail.hint) : '';
  const hint = [String(notice || ''), detailHint].filter(Boolean).join('\n');
  const payload = { ...(detail && typeof detail === 'object' ? detail : {}), error: shortError, code, hint };
  onEvent?.({ kind: 'tool-start', id: tc?.id, name, args: argsText.slice(0, name === 'todo_write' ? 8000 : 2000), at: t0 });
  onEvent?.({ kind: 'tool-end', id: tc?.id, name, ms: 0, ok: false, result: uiResultSummary(payload) });
  if (typeof onToolLifecycle === 'function') {
    const ev = { id: callId, name, args: argsText };
    try { onToolLifecycle({ phase: 'start', ...ev, at: t0 }); } catch { /* 落库失败不阻断回合 */ }
    try {
      onToolLifecycle({
        phase: 'end', ...ev, status: 'fail', result: payload, error: shortError, ms: 0,
        code, cancelled: false, at: Date.now()
      });
    } catch { /* 落库失败不阻断回合 */ }
  }
  return { id: tc?.id, trace: { tool: name, args: argsText, result: payload }, modelContent: JSON.stringify(payload) };
}

// 执行单个工具调用：自带 tool-start/tool-end 事件，失败只返回自己的 {error}，不影响同批其它调用
// onToolLifecycle（可选）：给持久化层用的「开始/结束」钩子（不推渲染层，避免结果大对象进 IPC）。
export async function runToolCall(tc, tools, onEvent, signal = null, onToolLifecycle = null) {
  const name = String(tc?.function?.name || 'unknown');
  const argsText = String(tc?.function?.arguments || '');
  const callId = tc?.id == null ? null : String(tc.id);
  const t0 = Date.now();
  // 推给渲染层的参数预览：普通工具 2000 字够看细节；todo_write 是结构化清单（3-8 条 +
  // 验收标准 + 证据），截断会变成非法 JSON 导致实时卡片解析不出来，单独放宽。
  const previewArgs = (text) => text.slice(0, name === 'todo_write' ? 8000 : 2000);
  const lifecycle = (ev) => {
    if (typeof onToolLifecycle !== 'function') return;
    try { onToolLifecycle(ev); } catch { /* 观测/落库回调失败不影响工具执行 */ }
  };
  // 工具真正开始执行（WorkingStatus 显示「Calling <tool>…」）；run_workflow 额外发 workflow-start，
  // 让工作流卡片立刻出骨架，而不是等第一个 step 快照。
  onEvent?.({ kind: 'activity', label: `Calling ${name}…`, tool: name });
  if (name === 'run_workflow') onEvent?.({ kind: 'workflow-start', tool: name, at: t0 });
  if (signal?.aborted) {
    // 已中断：不再执行工具，直接给 cancelled 结果（并行批次里未开始的条目走这里）
    const result = cancelledToolResult();
    onEvent?.({ kind: 'tool-start', id: tc?.id, name, args: previewArgs(argsText), cancelled: true });
    onEvent?.({ kind: 'tool-end', id: tc?.id, name, ms: 0, ok: false, cancelled: true });
    lifecycle({ phase: 'start', id: callId, name, args: argsText, at: t0 });
    lifecycle({ phase: 'end', id: callId, name, args: argsText, status: 'fail', result, error: String(result.error), ms: 0, cancelled: true, at: Date.now() });
    return { id: tc?.id, trace: { tool: name, args: argsText, result }, modelContent: JSON.stringify(result) };
  }
  onEvent?.({ kind: 'tool-start', id: tc?.id, name, args: previewArgs(argsText), at: t0 });
  lifecycle({ phase: 'start', id: callId, name, args: argsText, at: t0 });
  let result;
  try {
    const args = JSON.parse(argsText || '{}');
    const fn = tools?.[name];
    if (typeof fn !== 'function') result = { error: t('未知工具: {name}', { name }) };
    else if (signal?.aborted) result = cancelledToolResult(); // 解析参数期间被停止
    else result = await awaitWithAbort(Promise.resolve().then(() => fn(args, { signal, callId })), signal);
  } catch (e) {
    result = { error: e?.message || String(e) };
  }
  // 工具返回的图片（view_image / capture_screenshot）：不进 JSON 正文（base64 会把上下文撑爆、也不可读），
  // 单独带出去，由调用方在工具消息之后补一条多模态消息给模型「看」
  let images = null;
  if (result && typeof result === 'object' && Array.isArray(result.__images)) {
    images = result.__images.filter((im) => im && typeof im.base64 === 'string' && /^image\//.test(String(im.mime || ''))).slice(0, 4);
    const { __images, ...rest } = result;
    result = { ...rest, imagesAttached: images.length };
  }
  onEvent?.({ kind: 'tool-end', id: tc?.id, name, ms: Date.now() - t0, ok: !result?.error, ...(result?.cancelled ? { cancelled: true } : {}), result: uiResultSummary(result) });
  // 工具结果策略（对齐 dsh）：超长不整块喂模型——头+尾进上下文，全文落盘给 spill 路径
  let modelContent;
  let traceResult;
  try {
    const resultStr = JSON.stringify(result ?? {});
    modelContent = resultStr;
    traceResult = result;
    if (resultStr.length > MAX_INLINE_RESULT) {
      const spillFile = await spillResult(name, tc?.id, resultStr);
      const head = resultStr.slice(0, 12000);
      const tail = resultStr.slice(-4000);
      modelContent = `[结果过长 ${resultStr.length} 字符，已完整落盘]\n完整输出: ${spillFile || '(落盘失败)'}\n需要中间内容：用 read_file 分段读（offset/limit），或 run_command 用 grep -n / sed -n 在该文件上检索；也可以用更小的参数重跑。\n--- 前 12000 字符 ---\n${head}\n--- 后 4000 字符 ---\n${tail}`;
      // inline：当轮发给模型的原文。下一轮从库里还原历史时原样用它（full-history.toolContentOf），
      // 前后两轮逐字节一致 → 前缀缓存不断；以前只存 2000 字符预览，下一轮模型看到的比当轮少、缓存也从这里断。
      traceResult = { truncated: true, spillFile, chars: resultStr.length, preview: resultStr.slice(0, 2000), inline: modelContent };
    }
  } catch (e) {
    modelContent = JSON.stringify({ error: t('工具结果无法序列化：{error}', { error: e?.message || e }) });
    traceResult = { error: t('工具结果无法序列化') };
  }
  lifecycle({
    phase: 'end',
    id: callId,
    name,
    args: argsText,
    status: result?.error ? 'fail' : 'ok',
    result: traceResult,
    error: result?.error ? String(result.error) : null,
    ms: Date.now() - t0,
    cancelled: !!result?.cancelled,
    at: Date.now(),
  });
  return { id: tc?.id, trace: { tool: name, args: argsText, result: traceResult, ...(tc?.id ? { callId: String(tc.id) } : {}) }, modelContent, ...(images?.length ? { images } : {}) };
}

const MAX_LIVE_IMAGE_MESSAGES = 4; // 带图消息最多同时 4 条；超了一次收回到 IMAGE_TRIM_TO 条（成批改，保护前缀缓存）
const IMAGE_TRIM_TO = 2;
/**
 * 把一批工具返回的图片变成一条给模型看的消息（OpenAI 多模态 content parts）。
 * 模型未开视觉（config.vision === false）→ 只给文字说明，不发图（网关会直接拒绝整个请求）。
 * 老的图片消息只保留最近 MAX_LIVE_IMAGE_MESSAGES 条，更早的换成文字占位，避免每轮重复计费、撑爆上下文。
 */
export function appendToolImages(convo, toolResults, { vision } = {}) {
  const imgs = toolResults.flatMap((r) => (r.images || []).map((im) => ({ ...im, tool: r.trace?.tool })));
  if (!imgs.length) return false;
  const label = imgs.map((im, i) => `${i + 1}. ${im.label || im.tool}`).join('；');
  if (vision === false) {
    convo.push({ role: 'user', content: `[系统] 工具返回了 ${imgs.length} 张图片（${label}），但当前模型没有开启视觉能力，无法查看。请在回答里说明「图片未经肉眼核对」；用户可在「设置 → 模型」给支持看图的模型勾选 vision。` });
    return true;
  }
  const live = convo.filter((m) => m.__fcImages);
  const trim = live.length >= MAX_LIVE_IMAGE_MESSAGES ? live.length - (IMAGE_TRIM_TO - 1) : 0;
  for (const m of live.slice(0, Math.max(0, trim))) {
    m.content = m.content.map((p) => (p.type === 'image_url' ? { type: 'text', text: '[较早的图片已从上下文移除；需要再看就重新调用 view_image / capture_screenshot]' } : p));
    delete m.__fcImages;
  }
  const msg = {
    role: 'user',
    content: [
      { type: 'text', text: `[系统] 以下是工具返回的 ${imgs.length} 张图片（${label}）。请仔细看图本身（排版、文字是否溢出/重叠、配色、对齐、内容是否正确），不要只复述文件名；发现问题就指出具体位置并修。` },
      ...imgs.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.base64}` } })),
    ],
  };
  Object.defineProperty(msg, '__fcImages', { value: true, enumerable: false, writable: true, configurable: true });
  convo.push(msg);
  return true;
}

// 一轮 assistant 返回多个 tool_calls 时的调度：
// 连续 parallel 调用合成一批（限流并发）；遇到 serial 调用先等当前批全部完成，再单独执行它。
async function runToolCalls(toolCalls, { tools, onEvent, toolConcurrency, signal = null, onToolLifecycle = null }) {
  const limit = clampToolConcurrency(toolConcurrency);
  const results = [];
  let i = 0;
  while (i < toolCalls.length) {
    if (signal?.aborted && classifyTool(toolCalls[i]?.function?.name) === 'parallel') {
      // 已中断：剩下的并行条目全部直接标 cancelled，不再启动
      let j = i;
      while (j < toolCalls.length && classifyTool(toolCalls[j]?.function?.name) === 'parallel') j++;
      results.push(...(await mapLimited(toolCalls.slice(i, j), limit, (tc) => runToolCall(tc, tools, onEvent, signal, onToolLifecycle))));
      i = j;
    } else if (classifyTool(toolCalls[i]?.function?.name) === 'parallel') {
      let j = i + 1;
      while (j < toolCalls.length && classifyTool(toolCalls[j]?.function?.name) === 'parallel') j++;
      const batch = await mapLimited(toolCalls.slice(i, j), limit, (tc) => runToolCall(tc, tools, onEvent, signal, onToolLifecycle));
      results.push(...batch);
      i = j;
    } else {
      results.push(await runToolCall(toolCalls[i], tools, onEvent, signal, onToolLifecycle));
      i++;
    }
  }
  return results; // 按原始调用顺序返回，调用方按序回填 convo/trace
}

/**
 * 带参数闸的调度：合法的照常执行，非法的**不执行**但仍按原顺序占位——
 * 结果数组与 toolCalls 一一对应（convo 里的 tool 消息必须覆盖每个 call id，否则下一轮请求会被网关拒绝）。
 * @param {any[]} toolCalls
 * @param {Array<{index:number,name:string}>} invalid inspectToolCallArgs().invalid
 */
async function runToolCallsGuarded(toolCalls, invalid, { tools, onEvent, toolConcurrency, signal = null, onToolLifecycle = null, code = ARGS_INVALID_JSON_CODE, noticeOf = null }) {
  const badByIndex = new Map((Array.isArray(invalid) ? invalid : []).map((x) => [x.index, x]));
  const valid = toolCalls.filter((_, i) => !badByIndex.has(i));
  const executed = valid.length
    ? await runToolCalls(valid, { tools, onEvent, toolConcurrency, signal, onToolLifecycle })
    : [];
  const results = [];
  let cursor = 0;
  for (let i = 0; i < toolCalls.length; i += 1) {
    const bad = badByIndex.get(i);
    if (!bad) { results.push(executed[cursor]); cursor += 1; continue; }
    const notice = typeof noticeOf === 'function'
      ? noticeOf(bad)
      : buildArgsRepairNotice(bad.name, { truncated: code === ARGS_TRUNCATED_CODE, position: bad.position, chars: bad.chars, excerpt: bad.excerpt });
    results.push(await skipToolCall(toolCalls[i], code, notice, {
      onEvent,
      onToolLifecycle,
      detail: toolArgsFailurePayload(bad, { truncated: code === ARGS_TRUNCATED_CODE })
    }));
  }
  return results;
}

export async function runAgentTurn({ config, messages, confirmedHosts = [], onToken, onEvent, onToolLifecycle = null, onUsage = null, tools, toolsSchema = null, systemPrompt: systemPromptOverride = null, roleMode = 'audit', forceFirstToolChoice = false, fetchImpl = fetch, summarize, summarizeRaw = null, compactContext = null, signal, maxTurns = DEFAULT_MAX_TURNS, maxTurnMs: maxTurnMsOpt, maxTurnTokens: maxTurnTokensOpt, retryBaseMs = 600, noLimits = false, hooksConfig = null, hooksRunner = null, sessionId = null, drainSteer = null, resolveConfig = null, cwd = process.cwd() }) {
  if (signal?.aborted) return { cancelled: true, interrupted: true, partialContent: '', answer: '', trace: [] };
  if (!config?.baseUrl || !config?.apiKey) {
    return { error: t('尚未配置网关：请到左下角「模型设置」添加供应商（Base URL / API Key / 模型）并启用'), trace: [] };
  }
  const CHECKLIST = t('请检查：① Base URL 是否含 https:// 与 /v1 结尾 ② 网络/代理是否可达 ③ 到模型设置页点「测试连接」验证');
  // 402 是账单问题，不是 URL/网络问题：给一句能直接照做的说明，别再让人去查 Base URL
  const BILLING_HINT = t('这是网关的付费错误（402 Payment Required）：这个 Key 的余额/额度不足或套餐到期。请到 provider 后台充值，或在「设置 → 模型」里切换到另一个还有额度的 provider');
  // ---- Hooks 接线：配置由 index.mjs 启动/切换项目时加载一次，这里只消费快照 ----
  const hooksOn = !!(hooksConfig && hooksConfig.enabled === true);
  const hookOptions = { cwd, config: hooksConfig ?? undefined, runner: hooksRunner || undefined };
  // Stop 只影响 notice：deny 不改已生成的回答（对齐 ZCode 语义）
  const runStopHook = async (result) => {
    if (!hooksOn) return result;
    try {
      const hook = await runHookEvent('Stop', {
        sessionId,
        cwd,
        response: String(result?.answer ?? '')
      }, hookOptions);
      if (hook.decision === 'deny') {
        return { ...result, hookNotice: hook.messages.join('；') || t('Stop hook 拒绝了本轮结束') };
      }
    } catch { /* Stop 失败不阻断回答（hooks.mjs 内已 fail-open） */ }
    return result;
  };
  if (hooksOn) {
    // UserPromptSubmit 是安全闸：deny 时本轮不调模型（fail-closed 由 hooks.mjs 负责）
    const hook = await runHookEvent('UserPromptSubmit', {
      sessionId,
      cwd,
      prompt: lastUserPromptText(messages)
    }, hookOptions);
    if (hook.decision === 'deny') {
      return {
        error: t('被 hook 拦截：{detail}', { detail: hook.messages.join('；') || t('UserPromptSubmit hook 拒绝本轮请求') }),
        hookDenied: true,
        trace: []
      };
    }
  }
  const turnStart = Date.now();
  // 实时路由：回合开始时是一份配置，但「下一次模型请求」前会用 resolveConfig 重新解析（用户运行中改模型/供应商）。
  // liveConfig 只覆盖路由三要素（baseUrl/apiKey/model，可选 reasoningEffort），窗口/预算仍按回合开始时的口径，
  // 避免跑到一半换模型后预算口径漂移；已流式输出的那一条请求不会被换掉。
  let liveConfig = config;
  let liveChatUrl = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const refreshLiveConfig = async () => {
    if (typeof resolveConfig !== 'function') return;
    let next = null;
    try { next = await resolveConfig(); } catch { return; } // 解析失败：沿用当前配置
    if (!next || typeof next !== 'object') return;
    const baseUrl = String(next.baseUrl || '').trim();
    const apiKey = String(next.apiKey || '').trim();
    const model = String(next.model || '').trim();
    if (!baseUrl || !apiKey || !model) return;
    if (baseUrl === liveConfig.baseUrl && apiKey === liveConfig.apiKey && model === liveConfig.model) return;
    liveConfig = { ...liveConfig, ...next, baseUrl, apiKey, model };
    liveChatUrl = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    onEvent?.({ kind: 'model-switch', model, providerId: next.providerId || null });
  };
  onEvent?.({ kind: 'turn-start', at: turnStart });
  // 上下文预算压缩：模型可见历史在发给模型的时刻派生（trace/存储不受影响）；派生失败兜底用原始历史
  // 跨轮预算：index 显式透传 crossTurnBudgetTokens；直接调用且配了窗口时按同一公式推导；都没配则保持旧字符口径
  const crossTurnExplicit = Number(config?.crossTurnBudgetTokens);
  const hasWindowCfg = Number(config?.contextWindow) > 0 || Number(config?.maxOutputTokens) > 0;
  const crossTurnBudget = Number.isFinite(crossTurnExplicit) && crossTurnExplicit > 0
    ? Math.trunc(crossTurnExplicit)
    : (hasWindowCfg ? crossTurnBudgetTokens(config.contextWindow, config.maxOutputTokens) : null);
  let viewMessages = messages;
  // 压缩开始/结束各发一个事件：渲染层据此显示「正在压缩上下文…」（等同一次任务在跑）。
  // 必须在 await assembleContext 之前发 start——里面的 LLM 摘要可能等几秒，压缩完才提示等于没有进行中状态。
  const compactOpts = crossTurnBudget ? { budgetTokens: crossTurnBudget } : {};
  const willCompact = needsCompaction(messages, compactOpts);
  const beforeTokens = willCompact ? estimateMessagesTokens(messages) : 0;
  if (willCompact) onEvent?.({ kind: 'compact-start', scope: 'auto', before: beforeTokens });
  const systemText = String(systemPromptOverride != null ? systemPromptOverride : await getSystemPrompt(roleMode));
  // 0.27 压缩摘要的两条请求路径（compact.mjs）：
  //   ① 「对话前缀 + 压缩指令」原样发给当前模型——前缀和上一次请求逐字节相同，网关前缀缓存命中，
  //      几十万 token 的历史不用重新算一遍（对齐 Claude Code：压缩请求复用主对话的缓存）；
  //   ② 放不下 / 网关拒绝时，退到「转写 + 指令」一条消息（summarizeRaw，不分块）。
  const summarizeText = typeof summarizeRaw === 'function' ? summarizeRaw : (typeof summarize === 'function' ? summarize : null);
  const windowTokens = contextBudget(config).contextWindow;
  const compactMaxTokens = Math.min(16000, Math.max(4000, Number(config?.maxOutputTokens) || 16000));
  const transcriptTokens = Math.max(20000, Math.floor((windowTokens - compactMaxTokens - 24000) * 0.7));
  // 压缩后重读文件的总量随窗口缩放（约占窗口 10%，最多 6 万字符）：小窗口模型不能一压缩就又塞满
  const restoreChars = Math.min(60000, Math.max(8000, Math.floor(windowTokens * 0.4)));
  const convoSummarizer = (prefix) => async (instruction) => {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), COMPACT_SUMMARY_TIMEOUT_MS);
    try {
      // 和主请求同一份工具定义、同样不带 tool_choice：真模型实测带 tool_choice:'none' 时网关换了渲染方式，
      // 33k 的前缀只命中 2k。「不要调用工具」写在指令里；模型真调了工具（正文为空）就退到转写模式。
      const res = await fetchImpl(liveChatUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + liveConfig.apiKey },
        body: JSON.stringify({
          model: liveConfig.model,
          messages: [...prefix, { role: 'user', content: instruction }],
          tools: toolsSchema || AGENT_TOOLS_SCHEMA,
          stream: true,
          max_tokens: compactMaxTokens,
          ...effortParam(liveConfig.reasoningEffort)
        }),
        signal: ctl.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await readChatText(res);
      if (!text.trim()) throw new Error(t('空摘要'));
      return text;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
  const compactExtras = async () => {
    try { return (typeof compactContext === 'function' ? await compactContext() : null) || {}; } catch { return {}; }
  };
  try {
    if (willCompact && crossTurnBudget) {
      // 0.27：回合开始时历史已超预算 → 压缩一次并落库成边界（ipc-agent 收到 compact-boundary 后保存），
      // 之后每轮都是「同一份边界 + 之后的原文」只追加；旧实现每轮从完整历史重新派生、重新摘要。
      const { pinned, zone, kept, keptUserTurns } = splitByTurns(messages, {
        keepTokens: Math.floor(crossTurnBudget * CROSS_TURN_KEEP_RATIO),
        costOf: (m) => estimateMessagesTokens([m])
      });
      if (zone.length) {
        const lastUserIdx = messages.map((m) => isRealUserText(m)).lastIndexOf(true);
        const prefix = [{ role: 'system', content: systemText }, ...messages.slice(0, lastUserIdx < 0 ? messages.length : lastUserIdx)];
        const extras = await compactExtras();
        const r = await compactZone({
          zone, kept, summarizeConvo: convoSummarizer(prefix), summarizeText,
          projectPath: extras.projectPath || '', todos: extras.todos || null, spillDir: spillDir(), transcriptTokens, restoreChars
        });
        viewMessages = [{ role: 'user', content: r.content }, ...pinned, ...kept];
        if (r.via === 'local') onEvent?.({ kind: 'warning', message: t('模型摘要失败，改用本地摘要：{error}', { error: r.error || '' }) });
        onEvent?.({ kind: 'compact-boundary', scope: 'cross-turn', content: r.content, keptUserTurns, via: r.via, transcriptFile: r.transcriptFile });
      }
    } else {
      viewMessages = (await assembleContext(messages, {
        summarize,
        ...compactOpts
      })).messages;
    }
    if (willCompact) onEvent?.({ kind: 'compact-end', scope: 'auto', before: beforeTokens, after: estimateMessagesTokens(viewMessages) });
  } catch (e) {
    if (willCompact) onEvent?.({ kind: 'compact-end', scope: 'auto', before: beforeTokens, error: e?.message || String(e) });
    /* 压缩失败不阻断对话 */
  }
  const convo = [{ role: 'system', content: systemText }, ...viewMessages];
  // Steer：回合进行中用户从界面注入的消息。每次发起模型请求前 drain，追加为一条 user 消息
  // （不重置已完成的工具结果，直接计入本轮上下文），并推送给渲染层画「已注入」气泡。
  const applySteer = () => {
    if (typeof drainSteer !== 'function') return;
    let list = null;
    try { list = drainSteer(); } catch { return; }
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      const text = String(raw ?? '').trim();
      if (!text) continue;
      convo.push({ role: 'user', content: '【Steer】' + text });
      onEvent?.({ kind: 'steer', text });
    }
  };
  const trace = [];
  let reasoningAll = '';
  let lastUsage = null;
  // 网关报回的真实 prompt token（0.25，对齐 Claude Code）：判断上下文用量以它为准，本地估算只算「之后新增的消息」。
  // len = 发出那次请求时 convo 的长度；压缩改写了前面的消息后作废（置 null），回落纯估算。
  let measured = null;
  let lastFinishReason = null; // 供上层判定 truncated（finish_reason=length）
  // 累计用量：一轮可能发多次请求，lastUsage 只是最后一次；子代理/工作流账本按这里记账
  const usageTotal = { prompt: null, completion: null, cached: null, requests: 0 };
  const addUsage = (raw) => {
    const u = extractUsage(raw);
    if (!u) return;
    usageTotal.requests += 1;
    if (u.prompt != null) usageTotal.prompt = (usageTotal.prompt ?? 0) + u.prompt;
    if (u.completion != null) usageTotal.completion = (usageTotal.completion ?? 0) + u.completion;
    if (u.cached != null) usageTotal.cached = (usageTotal.cached ?? 0) + u.cached;
    // 按请求记账：一条账本 = 一次真实模型请求。provider/model 取「该次请求」实际使用的 liveConfig
    // （运行中切模型后，新消耗不会记到旧供应商名下）；记账失败不许影响对话。
    if (typeof onUsage === 'function') {
      try {
        onUsage({
          at: Date.now(),
          model: liveConfig.model,
          providerId: liveConfig.providerId || null,
          prompt: u.prompt,
          completion: u.completion,
          cached: u.cached
        });
      } catch { /* 记账回调异常不影响回合 */ }
    }
  };
  // ---- 软预算（Wave 2 → 长时间自主工作）：默认全部不设上限；只有显式配置（入参 / config.maxTurnMs / config.maxTurnTokens / config.watchdogMs / config.finalizeWatchdogMs）才生效 ----
  // 任一显式预算超限就不再开新轮，走「禁止调工具」收尾请求（默认永不触发）
  const positiveNum = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  // noLimits（子代理模式）：忽略一切显式墙钟/ token 软预算（子代理本来就不设，显式配置也不给子代理上锁）
  const WATCHDOG_MS = noLimits ? 0 : positiveNum(config.watchdogMs, 0); // 主会话单次请求看门狗：默认 0 = 不设；显式 config.watchdogMs 才启用
  const FINALIZE_WATCHDOG_MS = noLimits ? 0 : positiveNum(config.finalizeWatchdogMs, 0); // 收尾请求看门狗：默认 0 = 不设
  // 静默看门狗：缺省 180s；显式 0 / 负数 / 非数字 = 关闭。不受 noLimits 影响——子代理同样要能发现「网关一个字节都不回」
  const silenceRaw = config?.silenceTimeoutMs;
  const SILENCE_MS = silenceRaw === undefined || silenceRaw === null || silenceRaw === ''
    ? 180000
    : (Number.isFinite(Number(silenceRaw)) && Number(silenceRaw) > 0 ? Math.trunc(Number(silenceRaw)) : 0);
  const RETRY_BASE_MS = positiveNum(retryBaseMs, 600); // 指数退避基数：测试可注入极小值，生产默认 600ms
  const silenceSec = (ms) => Math.max(1, Math.round(ms / 1000));
  // 纯心跳提示节流（毫秒）：网关只发 SSE 注释/空块时，多久在 UI 上刷新一次「网关只发心跳 Ns」
  const HEARTBEAT_NOTICE_MS = 5000;
  const SILENCE_REASON = t('网关静默 {s}s 无任何响应', { s: silenceSec(SILENCE_MS) });
  const maxTurnMs = noLimits ? Number.POSITIVE_INFINITY : positiveNum(maxTurnMsOpt ?? config.maxTurnMs, Number.POSITIVE_INFINITY); // 时间预算默认不限；工具执行时间不计（toolWaitMs）
  const maxTurnTokens = noLimits ? Number.POSITIVE_INFINITY : positiveNum(maxTurnTokensOpt ?? config.maxTurnTokens, Number.POSITIVE_INFINITY); // 累计 prompt+completion；默认不限
  const watchdogSec = (ms) => Math.max(1, Math.round(ms / 1000)); // 看门狗文案用：按实际配置显示秒数
  const tokenBudget = contextBudget(config); // contextWindow 默认 200000、maxOutputTokens 默认 32000
  // 回合内「速度上限」（2026-11-19 用户实测）：1M 窗口模型要涨到 ~98 万 token 才折叠旧工具结果，
  // 一个做视频的回合 529 步、上下文一路膨胀，每步 10~22 秒（实测：1 万 token 约 4 秒、10 万 token 7~22 秒），
  // 109 分钟里 99 分钟在等模型。回合内超过这条线就折叠旧工具结果（最近 12 条原文保留，更早的留索引行）。
  // 不回到以前「几步就忘」的激进折叠：16 万足够容纳几十个文件；config.inTurnTokenCap 可调，0 = 关闭上限。
  // 注意只做「工具结果压索引行」这一步（microcompact），不触发 fullCompact——后者会把最近 6 条以外
  // （包括用户最初的任务要求）整段换成摘要，频繁触发就是「读完就忘」。fullCompact 仍只在真正逼近窗口时跑。
  // 0.25（对齐 Claude Code）：默认不设速度上限——大窗口模型平时什么都不删，只往后追加，靠前缀缓存保证速度；
  // 真正逼近窗口才压缩。config.inTurnTokenCap 给了正数才启用（想省 token 的用户可以自己设）。
  const inTurnCap = positiveNum(config.inTurnTokenCap, Infinity);
  const speedThreshold = Math.min(tokenBudget.compactThreshold, inTurnCap);
  let turnTokens = 0;
  let toolWaitMs = 0; // 工具执行时间不计入模型预算：工作流可能跑 30-50 分钟，算进去等于必超
  let budgetStop = null; // 'time' | 'tokens' | null
  let budgetWarned = false;
  // 压缩熔断：连续 3 次失败就不再压，只发一次 compact-warning（未知事件 UI 会忽略）
  let compactFails = 0;
  let compactWarned = false;
  const warnings = [];
  let toolChoiceUnsupported = false; // 网关拒绝 tool_choice 后不再带该字段
  let retriedForTools = false; // 首轮空转提醒只重试一次
  let emptyNudges = 0; // 空回复补交次数：最多 MAX_EMPTY_NUDGES 次（第一次普通催，第二次强制只输出正文）
  let repetitiveNudges = 0; // 复读熔断后的催收次数：最多 MAX_REPETITION_NUDGES 次（round8 新增）
  let longThinkNudges = 0; // 「想太久」的催收次数：与复读分开计额度（2026-11-20）
  let lastToolLoopSig = null; // 行为层防复读：上一轮的工具调用签名
  let toolLoopRounds = 0; // 连续相同签名的轮数
  // 死磕检测（2026-11-20）：不是「同参数重复调用」，而是「每轮都在换法子试，但撞的是同一个错误」。
  // 文字不同、参数不同，可错误指纹一样——这种最像人钻牛角尖，之前完全没兜住。
  let lastErrorSig = null; // 上一轮的失败指纹（同一类报错 = 同一指纹）
  let stuckRounds = 0; // 连续「同一个错误没解开」的轮数
  let stuckNudges = 0; // 跳出圈提示的次数（同一指纹最多提几次，避免刷屏）
  let forceAnswerNoTools = false; // 下一次请求带 tool_choice='none'（第二次补交用，成功发出后复位）
  let argsTruncatedRetried = false; // finish_reason=length 且带 tool_calls：整轮重发一次（参数半截，一律不执行）
  let argsRepaired = false; // 参数非法 JSON：纠错一次（把那一个调用回给模型重发），再失败才报错
  let turnsUsed = 0; // 已发起的主循环请求轮数（供上层定位 length 截断 / 模型自己停）
  const addTurnTokens = (usage, content) => {
    const p = Number(usage?.prompt_tokens ?? usage?.input_tokens);
    const c = Number(usage?.completion_tokens ?? usage?.output_tokens);
    if (Number.isFinite(p) || Number.isFinite(c)) {
      turnTokens += (Number.isFinite(p) ? p : 0) + (Number.isFinite(c) ? c : 0);
    } else {
      // 网关没回 usage 时用估算兜底，token 预算仍能兜住
      turnTokens += estimateMessagesTokens(convo) + estimateTokens(content || '');
    }
  };
  // 成批折叠的下一条触发线（2026-11-19，对齐 Claude Code「保护提示缓存」）：
  // 模型网关按「前缀」缓存——前面的消息一字不改，每步只需处理新增部分；中间任何一条被改，之后全部重算。
  // 所以折叠不能每步折一条（每步都改对话中部 = 每步缓存失效），而是到线时一次折到 FOLD_TARGET_RATIO，
  // 之后只追加不改，涨回到线再成批折一次。折完仍然很高（多半是模型自己写的长内容），就把下一条线
  // 往上抬 FOLD_REARM_RATIO，绝不出现「每步都折」。
  const FOLD_TARGET_RATIO = 0.5;
  const FOLD_REARM_RATIO = 0.25;
  let nextFoldAt = speedThreshold;
  // 速度上限触发的模型摘要之间至少隔 MIN_REQUESTS_BETWEEN_SUMMARY 次请求：任何估算偏差都不能再造成
  // 「每隔几步失忆一次」的死循环（2026-11-19 图片估算事故）。真正逼近窗口（compactThreshold）不受此限。
  const MIN_REQUESTS_BETWEEN_SUMMARY = 20;
  let compactCalls = 0;
  let lastStuckSummaryAt = -Infinity;
  // 回合内压缩（0.27，compact.mjs）：最近几步原样保留，其余换成一条边界消息；system 消息（项目记忆等）不压，放在边界之后。
  // 保留区按 token 算（最多 KEEP_RECENT_MODEL_COMPACT 条、不超过阈值的 1/4，至少留最后一步）：
  //   真模型实测——单个工具结果很大时固定留 8 条 = 几乎全留，压缩完反而更长、紧接着又压（33k → 42k）。
  // 保留区只在本轮之内：落库的边界切在本轮用户消息之后，下一轮从库里重建时才和这里同形（前缀缓存不断）。
  // 边界通过 compact-boundary 事件交给 ipc-agent 落库（带「裁到哪一步」），下一轮从库里重建时同形。
  const compactInTurn = async () => {
    const curUser = convo.map((m) => isRealUserText(m)).lastIndexOf(true);
    const floor = Math.max(1, curUser + 1);
    const keepBudget = Math.floor(Math.min(tokenBudget.compactThreshold, speedThreshold) * 0.25);
    let keepFrom = convo.length;
    let used = 0;
    while (keepFrom - 1 >= floor && convo.length - keepFrom < KEEP_RECENT_MODEL_COMPACT) {
      const c = estimateMessagesTokens([convo[keepFrom - 1]]);
      if (keepFrom < convo.length && convo[keepFrom]?.role !== 'tool' && used + c > keepBudget) break;
      used += c;
      keepFrom--;
    }
    while (keepFrom > floor && convo[keepFrom]?.role === 'tool') keepFrom--; // 不从 tool 结果开头（配对完整）
    // 本轮还没有任何步骤（刚开始就超线）：本轮用户消息原样留着，等同于「回合开始时压缩」
    const atTurnStart = curUser >= 1 && keepFrom >= convo.length;
    if (atTurnStart) keepFrom = curUser;
    if (keepFrom <= 1) return { ok: false };
    const region = convo.slice(1, keepFrom);
    const pinned = region.filter(isPinnedSystem);
    const zone = region.filter((m) => !isPinnedSystem(m));
    const kept = convo.slice(keepFrom);
    const extras = await compactExtras();
    const r = await compactZone({
      zone, kept, summarizeConvo: convoSummarizer(convo.slice()), summarizeText,
      projectPath: extras.projectPath || '', todos: extras.todos || null, spillDir: spillDir(), transcriptTokens, inTurn: !atTurnStart,
      restoreChars
    });
    convo.splice(1, keepFrom - 1, { role: 'user', content: r.content }, ...pinned);
    onEvent?.(atTurnStart
      ? { kind: 'compact-boundary', scope: 'cross-turn', content: r.content, keptUserTurns: 1, via: r.via, transcriptFile: r.transcriptFile }
      : { kind: 'compact-boundary', scope: 'in-turn', content: r.content, trimThrough: lastCoveredCallIdOf(curUser >= 0 ? region.slice(curUser) : region), via: r.via, transcriptFile: r.transcriptFile });
    return { ok: true, via: r.via, error: r.error };
  };
  const compactNow = async () => {
    if (compactFails >= 3) return; // 熔断后不再尝试
    // 进行中状态：事件只用来让界面在需要时点亮「压缩中」（渲染层有 120ms 延迟出现，瞬时压缩不会闪一下）；
    // 失败时同样要发 end，不能让界面一直转圈。
    let announced = false;
    let before = 0;
    try {
      const currentTokens = () => (measured && measured.len <= convo.length
        ? measured.prompt + estimateMessagesTokens(convo.slice(measured.len))
        : estimateMessagesTokens(convo));
      let tokens = currentTokens();
      // ① 速度上限：成批折叠旧工具结果（最近 MICRO_KEEP_RECENT_IN_TURN 条原文不动、对话正文不动）
      compactCalls++;
      let foldStuck = false; // 折完仍贴着速度上限：剩下的是对话正文/模型自己写的长内容，折工具结果已经没用
      if (tokens >= nextFoldAt) {
        const target = Math.floor(speedThreshold * FOLD_TARGET_RATIO);
        const plan = planFold(convo, { keepRecentTool: MICRO_KEEP_RECENT_IN_TURN, targetTokens: target, tokensNow: tokens });
        if (plan.count > 0 && microcompact(convo, { keepRecentTool: MICRO_KEEP_RECENT_IN_TURN, maxFold: plan.count })) {
          measured = null; // 前面的消息被改写，真实用量作废
          // 每次折叠都告诉用户（0.25：以前一轮只提示一次，反复折叠用户完全看不到）
          onEvent?.({ kind: 'notice', message: t('上下文折叠：已把 {n} 条较早的工具结果收成索引行（原文可重跑获取）', { n: plan.count }) });
        }
        tokens = currentTokens();
        foldStuck = tokens >= speedThreshold * 0.9 && compactCalls - lastStuckSummaryAt >= MIN_REQUESTS_BETWEEN_SUMMARY;
        nextFoldAt = Math.max(speedThreshold, tokens + Math.floor(speedThreshold * FOLD_REARM_RATIO));
      }
      // ② 模型写交接摘要（对齐 Claude Code auto-compact），失败回落本地摘要。两种情况会走到：
      //    真正逼近窗口；或折完工具结果仍贴着速度上限（剩下的是正文，只能靠摘要降下来）。
      if (tokens >= tokenBudget.compactThreshold || foldStuck) {
        before = tokens;
        announced = true;
        onEvent?.({ kind: 'compact-start', scope: 'auto', before });
        // 0.27：不再先把工具结果折成索引行——压缩请求要和上一次主请求前缀一致才能命中缓存，
        // 摘要也要看到原始结果才写得准。压缩区整段被边界替换，折不折对之后的上下文没有区别。
        if (foldStuck) lastStuckSummaryAt = compactCalls;
        const r = await compactInTurn();
        measured = null;
        if (r.ok && r.via === 'local') onEvent?.({ kind: 'warning', message: t('模型摘要失败，改用本地摘要：{error}', { error: r.error || '' }) });
        nextFoldAt = Math.max(speedThreshold, estimateMessagesTokens(convo) + Math.floor(speedThreshold * FOLD_REARM_RATIO));
      }
      compactFails = 0; // 成功一次即重置「连续失败」计数
    } catch (e) {
      compactFails++;
      if (announced) onEvent?.({ kind: 'compact-end', scope: 'auto', before, error: e?.message || String(e) });
      if (compactFails >= 3 && !compactWarned) {
        compactWarned = true;
        onEvent?.({ kind: 'compact-warning', reason: e?.message || String(e) });
      }
      return;
    }
    if (announced) onEvent?.({ kind: 'compact-end', scope: 'auto', before, after: estimateMessagesTokens(convo) });
  };
  // 仿 dsh：网关抖动（5xx/429/网络错误）自动重试，最多 5 次，指数退避
  // 520-524 / 529：Cloudflare 系网关的源站超时/过载（国内中转网关常见；E2E 实测 524 直接结束整轮）
  const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
  // 退避节奏（2026-11-18）：原来 0.6→1.2→2.4→4.8s，5 次总共只等约 9 秒就放弃——真实模型 E2E 里网关抖一下，
  // 两个已经跑了 6~12 分钟的验收直接丢光、一个字结论都没交。现在 2→5→10→20→30→30s，最多 7 次（约 1.5 分钟）。
  // 测试注入极小 retryBaseMs 时按同一比例缩放，不会变慢。
  const MAX_ATTEMPTS = 7;
  const BACKOFF_STEPS = [2000, 5000, 10000, 20000, 30000, 30000];
  const backoffMs = (attempt) => Math.round(BACKOFF_STEPS[Math.min(attempt - 1, BACKOFF_STEPS.length - 1)] * (RETRY_BASE_MS / 600));
  const sleepAbort = (ms, sig) => new Promise((resolve) => {
    const timeoutId = setTimeout(resolve, ms);
    sig?.addEventListener('abort', () => { clearTimeout(timeoutId); resolve('aborted'); }, { once: true });
  });
  for (let turn = 0; turn < maxTurns; turn++) {
    turnsUsed = turn + 1;
    const elapsedMs = Math.max(0, Date.now() - turnStart - toolWaitMs); // 只算模型/等待时间
    if (elapsedMs >= maxTurnMs || turnTokens >= maxTurnTokens) {
      budgetStop = elapsedMs >= maxTurnMs ? 'time' : 'tokens';
      onEvent?.({ kind: 'budget', reason: budgetStop, ms: elapsedMs, tokens: turnTokens });
      break; // 跳出循环 → 走下面的收尾请求
    }
    // 轮次/token 用到 80% 时提醒一次（每次 turn 迭代最多一次，不刷屏）
    if (!budgetWarned && ((turn + 1) / maxTurns >= 0.8 || turnTokens >= maxTurnTokens * 0.8)) {
      budgetWarned = true;
      onEvent?.({ kind: 'budget-warning', turnsLeft: maxTurns - turn, tokensLeft: Math.max(0, maxTurnTokens - turnTokens) });
    }
    applySteer(); // 用户中途注入（Steer）：先并入本轮上下文，再发起下一次请求
    await refreshLiveConfig(); // 下一次模型请求前重新解析：运行中改模型/供应商从这里开始生效（已输出的内容不重跑）
    await compactNow(); // 每轮请求前按 token 做两级压缩，防 40 轮把网关上下文撑爆
    const sentLen = convo.length;
    if (signal?.aborted) { onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, interrupted: true }); return { cancelled: true, interrupted: true, partialContent: '', answer: '', trace, reasoning: reasoningAll || undefined, usage: lastUsage || undefined }; }
    let lastErr = '';
    let streamOut = null; // 成功消费完的流结果（重试循环里赋值；失败/静默时保持 null）
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ctl = new AbortController();
      const onOuterAbort = () => ctl.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      const watchdog = WATCHDOG_MS > 0 ? setTimeout(() => ctl.abort(), WATCHDOG_MS) : null; // 旧「总时长」看门狗：默认不设；显式 config.watchdogMs 才启用
      let silenceHit = false;
      // 静默看门狗：从「请求发出」那一刻开始计时（首字节之前也算静默），每收到一个数据块 touch() 重置。
      // 它只杀「连续 N 秒零字节」，不设任何工作时长上限；noLimits（子代理）同样启用。
      const silence = startSilenceWatchdog(SILENCE_MS, {
        abort: () => { silenceHit = true; ctl.abort(); },
        onHint: () => onEvent?.({ kind: 'activity', label: t('网关已静默 {s}s…', { s: silenceSec(SILENCE_MS / 2) }), request: turn + 1, attempt })
      });
      let retryReason = '';
      let res = null;
      try {
        // 新请求开始（上一轮工具/回答已结束）：先提示在等网关；收到首块后切回正常活动文案
        onEvent?.({ kind: 'activity', label: SILENCE_MS > 0 ? t('等待网关响应…') : 'Thinking…', request: turn + 1, attempt });
        onEvent?.({ kind: 'phase', name: 'thinking' });
        const bodyFor = (withUsage, toolChoiceMode = null) => JSON.stringify({
          model: liveConfig.model,
          messages: convo,
          tools: toolsSchema || AGENT_TOOLS_SCHEMA,
          stream: true,
          ...(toolChoiceMode ? { tool_choice: toolChoiceMode } : {}),
          ...(withUsage ? { stream_options: { include_usage: true } } : {}),
          ...effortParam(liveConfig.reasoningEffort)
        });
        const send = (withUsage, toolChoiceMode = null) => fetchImpl(liveChatUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + liveConfig.apiKey },
          body: bodyFor(withUsage, toolChoiceMode),
          signal: ctl.signal
        });
        let withUsage = STREAM_USAGE;
        // 首轮强制工具：只有第一轮带 tool_choice='required'；第二次补交带 'none' 强制只输出正文。
        // 网关不认 tool_choice 时去掉字段重试并记 warning（两种模式共用同一条降级路径）
        let withToolChoice = forceFirstToolChoice && turn === 0 && !toolChoiceUnsupported
          ? 'required'
          : (forceAnswerNoTools && !toolChoiceUnsupported ? 'none' : null);
        res = await send(withUsage, withToolChoice);
        // 部分网关不认 stream_options.include_usage → 同一 attempt 内去掉该字段重试一次（只降级一次）
        if (!res.ok && withUsage && res.status >= 400 && res.status < 500) {
          console.warn(`[agent-service] 网关拒绝 stream_options.include_usage（HTTP ${res.status}），本 attempt 去掉该字段重试`);
          withUsage = false;
          res = await send(false, withToolChoice);
        }
        // 400/422 且带了 tool_choice：按旧逻辑去掉该字段重试一次，结果按正常响应判定
        if (!res.ok && withToolChoice && (res.status === 400 || res.status === 422)) {
          toolChoiceUnsupported = true;
          withToolChoice = null;
          const msg = t('网关不支持 tool_choice（HTTP {status}），已去掉该字段重试', { status: res.status });
          warnings.push(msg);
          onEvent?.({ kind: 'warning', message: msg });
          console.warn(`[agent-service] ${msg}`);
          res = await send(withUsage, null);
        }
        if (res.ok && res.body) {
          let firstChunk = true;
          let lastProgressAt = Date.now();
          let lastHeartbeatNotice = 0;
          streamOut = await consumeStream(res, onToken, onEvent, ctl, (progress) => {
            const now = Date.now();
            if (progress) {
              // 真实内容进度才重置静默计时（content / reasoning / tool_calls / usage）
              lastProgressAt = now;
              silence.touch();
              if (firstChunk) {
                firstChunk = false;
                // 首块到达 = 网关还活着；把文案从「等待网关」切回「思考」
                onEvent?.({ kind: 'activity', label: 'Thinking…', request: turn + 1, attempt });
              }
              return;
            }
            // 心跳块（SSE 注释 / 空 data / 只有 role）：只更新「最近心跳」，不喂静默看门狗。
            // 否则网关一直发心跳就能永久骗过 180s 静默阈值，界面看着像卡死却永远不报错。
            firstChunk = false;
            const silentSec = Math.round((now - lastProgressAt) / 1000);
            if (silentSec >= 1 && now - lastHeartbeatNotice >= HEARTBEAT_NOTICE_MS) {
              lastHeartbeatNotice = now;
              onEvent?.({ kind: 'activity', label: t('网关只发心跳 {s}s…', { s: silentSec }), heartbeat: true, request: turn + 1, attempt });
            }
          });
          if (streamOut.aborted && silenceHit) {
            // 静默看门狗中止了读取：本次尝试记为可重试失败，已流出的部分不落账（重试会重新给全文）
            streamOut = null;
            retryReason = SILENCE_REASON;
          } else {
            forceAnswerNoTools = false; // 'none' 只作用于紧接着的这一轮，拿到流就复位
          }
        } else {
          const keyHint = res.status === 401 || res.status === 403 ? t('（API Key 无效或无权限）') : '';
          lastErr = `HTTP ${res.status} ${res.statusText || ''}${keyHint}`;
          if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
            onEvent?.({ kind: 'retry', attempt: attempt + 1, max: MAX_ATTEMPTS, reason: lastErr });
            await sleepAbort(backoffMs(attempt), signal);
            continue;
          }
          onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
          if (res.status === 402) return { error: t('网关连接失败：{err}。{hint}。', { err: lastErr, hint: BILLING_HINT }), trace, warnings, reasoning: reasoningAll || undefined, workedMs: Date.now() - turnStart };
          return { error: t('网关连接失败：{err}{retry}。{checklist}', { err: lastErr, retry: attempt > 1 ? t('（已重试 {n} 次）', { n: attempt - 1 }) : '', checklist: CHECKLIST }), trace, warnings, reasoning: reasoningAll || undefined, workedMs: Date.now() - turnStart };
        }
      } catch (e) {
        if (signal?.aborted) { onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, interrupted: true }); return { cancelled: true, interrupted: true, partialContent: '', answer: '', trace, reasoning: reasoningAll || undefined, usage: lastUsage || undefined }; }
        retryReason = silenceHit
          ? SILENCE_REASON
          : (e?.name === 'TimeoutError' || /abort/i.test(e?.message || '') ? t('连接超时（{s}s）', { s: watchdogSec(WATCHDOG_MS) }) : (e?.message || 'fetch failed'));
      } finally {
        silence.stop();
        if (watchdog) clearTimeout(watchdog);
        signal?.removeEventListener('abort', onOuterAbort);
      }
      if (streamOut) break;
      if (retryReason) {
        lastErr = retryReason;
        if (attempt < MAX_ATTEMPTS) {
          // attempt 报「即将进行的下一次尝试」（1 失败 → 重试 2/5），UI 读起来就是「重试第 2 次」
          onEvent?.({ kind: 'retry', attempt: attempt + 1, max: MAX_ATTEMPTS, reason: lastErr });
          await sleepAbort(backoffMs(attempt), signal);
          continue;
        }
        onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
        // 静默重试用尽：不返回栈，只给人话（网关一个字节都不回 ≠ 活干得久）
        if (silenceHit) return { error: t('{reason}（已重试 {n} 次）。{checklist}', { reason: SILENCE_REASON, n: MAX_ATTEMPTS, checklist: CHECKLIST }), trace, warnings, reasoning: reasoningAll || undefined, workedMs: Date.now() - turnStart };
        return { error: t('网关连接失败：{reason}（已重试 {n} 次）。{checklist}', { reason: retryReason, n: MAX_ATTEMPTS, checklist: CHECKLIST }), trace, warnings, reasoning: reasoningAll || undefined, workedMs: Date.now() - turnStart };
      }
      // 防御性兜底：既没拿到流也没失败原因（正常不可达）
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
      return { error: t('网关连接失败：{err}。{checklist}', { err: lastErr || t('未知错误'), checklist: CHECKLIST }), trace, warnings, reasoning: reasoningAll || undefined, workedMs: Date.now() - turnStart };
    }
    if (!streamOut) {
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
      return { error: t('网关连接失败：{err}。{checklist}', { err: lastErr || t('未知错误'), checklist: CHECKLIST }), trace, warnings, reasoning: reasoningAll || undefined, workedMs: Date.now() - turnStart };
    }
    let { content, reasoning, toolCalls, repetitive, aborted, longThink, usage, finishReason } = streamOut;
    if (usage) {
      lastUsage = usage;
      const pt = Number(usage.prompt_tokens ?? usage.input_tokens);
      if (Number.isFinite(pt) && pt > 0) measured = { prompt: pt, len: sentLen };
    }
    addUsage(usage); // 累计（供工作流子代理按步记账）
    addTurnTokens(usage, content); // 软预算累计（prompt+completion）
    if (finishReason) lastFinishReason = finishReason;
    if (aborted || signal?.aborted) {
      // dsh 语义：中断≠删除——已流出的内容原样返回并落盘，正文标记「已中断」
      const partial = content || '';
      if (reasoning) reasoningAll += (reasoningAll ? String.fromCharCode(10) : '') + reasoning; // 停止前这一轮的思考也要留下（以前在合并之前就 return 了）
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, interrupted: true });
      return { cancelled: true, interrupted: true, partialContent: partial, answer: partial, reasoning: reasoningAll || undefined, trace, workedMs: Date.now() - turnStart, roundsUsed: turnsUsed, usage: usage || lastUsage || undefined };
    }
    if (reasoning) reasoningAll += (reasoningAll ? '\n' : '') + reasoning;
    // 「想太久」：不是复读，但这一轮也没产出可用结果。用另一套话术催收（明说「没有复读，只是思考过长」），
    // 独立额度（MAX_LONG_THINK_NUDGES），不吃掉真复读的那份催收机会。
    if (longThink) {
      if (longThinkNudges < MAX_LONG_THINK_NUDGES) {
        longThinkNudges += 1;
        const nudge = '你这一轮思考过长（已超过长度上限被截断），但没有任何代码或工具产出。思考时不要反复推演方案取舍——先把文件写出来，再用实际渲染/测试结果判断好不好，边做边改。现在就动手：直接调用工具推进，不要再做长段规划。';
        convo.push({ role: 'user', content: `[系统] ${nudge}` });
        onEvent?.({ kind: 'warning', message: t('模型思考过长（不是复读），已截断并催收推进（{n}/{max}）', { n: longThinkNudges, max: MAX_LONG_THINK_NUDGES }) });
        onEvent?.({ kind: 'activity', label: t('思考过长，催收推进（{n}/{max}）…', { n: longThinkNudges, max: MAX_LONG_THINK_NUDGES }) });
        continue;
      }
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
      return { error: t('模型连续 {n} 轮思考过长且没有任何产出，已自动中止。这个任务对当前模型的思考预算来说过于开放，建议把需求拆小（比如先定配色和版式，再让它实现），或换一个思考更收敛的模型。', { n: longThinkNudges }), reasoning: reasoningAll, trace, roundsUsed: turnsUsed, warnings };
    }
    if (repetitive) {
      // 复读熔断（round8 实测：同义复述刷了 20+ 分钟，最终被 402 才收场；此前熔断标志还会被
      // consumeStream 的 catch 误标成用户中断，本分支根本不可达——两处都已修）。
      // 第一次：催收一轮（不复述状态，直接推进）；再犯：人话报错收轮。
      if (repetitiveNudges < MAX_REPETITION_NUDGES) {
        repetitiveNudges += 1;
        const nudge = '你上一轮输出陷入重复循环，已被自动截断。不要复述已完成的状态、计划或检查清单；直接继续：要么调用下一个工具推进任务，要么给出最终结论（带证据）。';
        convo.push({ role: 'user', content: `[系统] ${nudge}` });
        onEvent?.({ kind: 'warning', message: t('检测到重复输出循环，已截断并催收（{n}/{max}）', { n: repetitiveNudges, max: MAX_REPETITION_NUDGES }) });
        onEvent?.({ kind: 'activity', label: t('复读截断，催收推进（{n}/{max}）…', { n: repetitiveNudges, max: MAX_REPETITION_NUDGES }) });
        continue;
      }
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
      return { error: t('检测到模型输出异常循环（已催收 {n} 次仍复发），已自动中止——这是模型问题不是你的问题。可重试，或到模型设置换一个模型。', { n: repetitiveNudges }), reasoning: reasoningAll, trace, roundsUsed: turnsUsed, warnings };
    }
    // ---- 截断闸①：finish_reason=length 且这一轮带 tool_calls → 参数可能半截，一个都不执行 ----
    // 旧逻辑直接把半截 JSON 丢给 runToolCall，parse 失败 → 卡片一条红条，用户以为回合断了。
    if (toolCalls.length && String(finishReason || '') === 'length') {
      const firstName = String(toolCalls[0]?.function?.name || 'unknown');
      const lastArgs = String(toolCalls[toolCalls.length - 1]?.function?.arguments || '');
      if (!argsTruncatedRetried) {
        argsTruncatedRetried = true;
        const notice = buildArgsRepairNotice(firstName, {
          truncated: true,
          position: null,
          chars: toolCalls.reduce((n, tc) => n + String(tc?.function?.arguments || '').length, 0),
          excerpt: argsErrorExcerpt(lastArgs, null)
        });
        // 不把半截 tool_calls 写进 convo：没有 assistant 行就没有悬空的 tool_call_id，重发请求是干净的一轮
        convo.push({ role: 'user', content: `[系统] ${notice}` });
        const msg = t('本轮工具参数被输出上限截断（{code}），已自动重发一次（未执行）。', { code: ARGS_TRUNCATED_CODE });
        warnings.push(msg);
        onEvent?.({ kind: 'warning', message: msg });
        onEvent?.({ kind: 'activity', label: t('工具参数被截断，正在重发…') });
        continue;
      }
      // 重发后仍然截断：不执行，按原因码收尾（start+end 成对发，part 不会停在 running）
      const bad = toolCalls.map((tc, index) => ({
        index,
        id: tc?.id == null ? null : String(tc.id),
        name: String(tc?.function?.name || 'unknown'),
        message: '',
        position: null,
        excerpt: '',
        chars: String(tc?.function?.arguments || '').length
      }));
      const results = await runToolCallsGuarded(toolCalls, bad, {
        tools, onEvent, toolConcurrency: config.toolConcurrency, signal, onToolLifecycle,
        code: ARGS_TRUNCATED_CODE
      });
      for (const r of results) trace.push(r.trace);
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
      return {
        error: t('工具参数连续两次被输出上限截断（{code}），本轮已停止，这些调用没有执行。建议把参数拆小（减少 steps / 精简 prompt）后重试本步。', { code: ARGS_TRUNCATED_CODE }),
        errorCode: ARGS_TRUNCATED_CODE,
        trace,
        reasoning: reasoningAll || undefined,
        roundsUsed: turnsUsed,
        warnings
      };
    }
    // ---- 行为层防复读：连续 N 轮「同工具+同参数」的调用 → 先提醒换思路，再犯判停（CC 式） ----
    // 文字复读由上面 repetitive 熔断兜，这里兜「动作复读」：文字各不相同但每轮都在重跑完全一样的调用。
    if (toolCalls.length) {
      const sig = toolCallSig(toolCalls);
      if (sig && sig === lastToolLoopSig) toolLoopRounds += 1;
      else { toolLoopRounds = 1; lastToolLoopSig = sig; }
      if (toolLoopRounds >= TOOL_LOOP_STOP_ROUNDS) {
        onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
        return {
          error: t('模型连续 {n} 轮发起完全相同的工具调用（参数逐字节相同，相同输入必然得到相同输出），疑似卡死循环，已自动停止——已做的工作都在记录里。可重试、换个模型，或把任务拆小。', { n: toolLoopRounds }),
          reasoning: reasoningAll || undefined,
          trace,
          roundsUsed: turnsUsed,
          warnings
        };
      }
      if (toolLoopRounds >= TOOL_LOOP_WARN_ROUNDS) {
        const nudge = `你已经连续 ${toolLoopRounds} 轮发起完全相同的工具调用（参数逐字节相同）。相同输入必然得到相同输出——停止重复：换参数、换工具、改用计划拆步，或直接给出基于已有证据的最终结论。`;
        convo.push({ role: 'user', content: `[系统] ${nudge}` });
        onEvent?.({ kind: 'warning', message: t('检测到连续 {n} 轮相同的工具调用，已提醒换思路（第 {stop} 轮判停）', { n: toolLoopRounds, stop: TOOL_LOOP_STOP_ROUNDS }) });
        onEvent?.({ kind: 'activity', label: t('动作复读，已提醒换思路（第 {stop} 轮判停）', { stop: TOOL_LOOP_STOP_ROUNDS }) });
      }
    }
    if (!toolCalls.length) {
      // 强制首轮工具却只回了话：追加 system 提醒后再请求一次（与旧 runSubagentStep 一致，最多一次）
      if (forceFirstToolChoice && turn === 0 && !retriedForTools) {
        retriedForTools = true;
        const reminder = '你还没有调用任何工具。现在必须调用工具取证，只回复一句话会被判为失败。';
        convo.push({ role: 'system', content: reminder });
        onEvent?.({ kind: 'system', content: reminder });
        continue;
      }
      // 空回复补交（实测踩过：子代理跑了 20-50 次工具、最后一条回复是空的 → 整步判失败，活白干）。
      // 升级为有限两次：
      //   第一次：普通催交（写结论、别再调工具）；
      //   第二次：tool_choice='none' 强制只输出正文 + 把最近 N 条工具结果压成证据摘要附上，
      //          并明确要求「已确认发现 / 证据 file:line / 未完成项」三段；
      //   仍空 → 认输，由上层用 transcript 做确定性 salvage（绝不返回空 content）。
      if (!String(content || '').trim() && emptyNudges < MAX_EMPTY_NUDGES) {
        emptyNudges += 1;
        const lengthHint = lastFinishReason === 'length'
          ? '上一轮输出被长度上限截断（finish_reason=length），这次只写结论，不要复述过程、不要输出长清单。'
          : '';
        if (emptyNudges === 1) {
          const nudge = `你这一轮没有输出任何正文。请立即基于上面已经跑过的工具结果写出最终结论（结论要带 file:line 证据），不要再调用工具。${lengthHint}`;
          convo.push({ role: 'user', content: `[系统] ${nudge}` });
        } else {
          const digest = buildEmptyNudgeDigest(convo);
          forceAnswerNoTools = true; // 下一请求带 tool_choice='none'（网关不支持时自动降级并记 warning）
          const nudge = [
            '这是最后一次补交：这一轮必须只输出文字结论，禁止再调用任何工具（已强制 tool_choice=none）。',
            '严格按下面三段输出，缺一段都算不合格：',
            '1) 已确认发现：每条一句话，必须带 file:line 证据；',
            '2) 证据清单：file:line → 该处说明了什么；',
            '3) 未完成项：没查到的、没验证的逐条列出（确实没有就写「无」）。',
            lengthHint,
            digest ? `已跑工具的证据摘要（最近 ${EMPTY_NUDGE_DIGEST_ITEMS} 条工具结果首行，可直接引用）：\n${digest}` : '',
          ].filter(Boolean).join('\n');
          convo.push({ role: 'user', content: `[系统] ${nudge}` });
        }
        onEvent?.({ kind: 'activity', label: t('补交结论（{n}/{max}）…', { n: emptyNudges, max: MAX_EMPTY_NUDGES }) });
        continue;
      }
      const emptyReply = !String(content || '').trim();
      if (emptyReply) {
        warnings.push(t('空回复补交 {n} 次仍无正文，已改用 transcript 兜底交付', { n: emptyNudges }));
      }
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart });
      return await runStopHook({
        answer: content || '(空回复)',
        reasoning: reasoningAll || undefined,
        trace,
        workedMs: Date.now() - turnStart,
        usage: lastUsage || undefined,
        usageTotal,
        finishReason: lastFinishReason,
        roundsUsed: turnsUsed,
        ...(emptyReply ? { emptyReply: true } : {}),
        warnings
      });
    }
    forceAnswerNoTools = false; // 模型无视 'none' 继续调工具时复位，避免污染后续轮次
    convo.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
    // ---- 参数闸②：非法 JSON 先自动修复；修不了的才不执行 ----
    // 非法的也占位一条 tool 结果（每个 tool_call_id 都必须有响应，否则下一轮请求被网关拒绝）：
    // 内容 = 错误码 + 位置 + 前后各 80 字符（脱敏）+「只重发这一个调用」的指令。
    const inspected = inspectToolCallArgs(toolCalls);
    for (const rep of inspected.repaired) {
      const msg = t('已自动修复工具参数（{reasons}）：{tool}', { reasons: rep.repairs.join('、'), tool: rep.name });
      warnings.push(msg);
      onEvent?.({ kind: 'warning', message: msg });
    }
    const repairedByIndex = new Map(inspected.repaired.map((x) => [x.index, x]));
    const toolStartedAt = Date.now();
    // 这一轮的思考与工具前说的话：随本轮第一个工具的「开始」事件一起交给落库层（立即写盘），
    // 中途关 app / 进程挂掉也不丢；回合正常收尾时再挂到 trace 上（2026-11-19 用户实测：281 步的回合
    // 没正常收尾，库里工具全在、模型说过的话 0 字）。
    const roundThought = String(reasoning || '').trim();
    const roundSay = String(content || '').trim();
    let roundNote = (roundThought || roundSay) ? { thought: roundThought.slice(0, 4000), say: roundSay.slice(0, 2000) } : null;
    const lifecycleWithNote = typeof onToolLifecycle === 'function'
      ? (ev) => {
        // round：同一次模型回复里的多个调用同属一轮，跨轮还原历史时据此合成一条 assistant(tool_calls)
        if (roundNote && ev?.phase === 'start') {
          const note = roundNote;
          roundNote = null;
          return onToolLifecycle({ ...ev, round: turn, ...(note.thought ? { thought: note.thought } : {}), ...(note.say ? { say: note.say } : {}) });
        }
        return onToolLifecycle(ev?.phase === 'start' ? { ...ev, round: turn } : ev);
      }
      : onToolLifecycle;
    const toolResults = inspected.invalid.length
      ? await runToolCallsGuarded(toolCalls, inspected.invalid, {
        tools, onEvent, toolConcurrency: config.toolConcurrency, signal, onToolLifecycle: lifecycleWithNote,
        code: ARGS_INVALID_JSON_CODE
      })
      : await runToolCalls(toolCalls, { tools, onEvent, toolConcurrency: config.toolConcurrency, signal, onToolLifecycle: lifecycleWithNote });
    toolWaitMs += Date.now() - toolStartedAt;
    if (toolResults[0]?.trace && (roundThought || roundSay)) {
      if (roundThought) toolResults[0].trace.thought = roundThought.slice(0, 4000);
      if (roundSay) toolResults[0].trace.say = roundSay.slice(0, 2000);
    }
    toolResults.forEach((r, index) => {
      const rep = repairedByIndex.get(index);
      if (rep) r.trace.repaired = rep.repairs;
      if (r.trace) r.trace.round = turn;
      trace.push(r.trace);
      convo.push({ role: 'tool', tool_call_id: r.id, content: r.modelContent });
    });
    // 工具返回的图片：所有 tool 消息之后补一条多模态消息（tool 消息必须紧跟 assistant 的 tool_calls）
    appendToolImages(convo, toolResults, { vision: liveConfig.vision });
    // ---- 死磕检测（2026-11-20）：换着法子试、但撞的是同一个错误 → 提示跳出圈 ----
    // 与上面的「同参数重复调用」互补：那个抓原地打转，这个抓「改了 5 次还是同一个报错」。
    // 不判停（用户明确不要超时/不要硬断），只提示；同一指纹最多提 2 次，避免刷屏。
    {
      const sig = extractFailureSig(toolResults);
      if (sig) {
        if (sig === lastErrorSig) stuckRounds += 1;
        else { stuckRounds = 1; lastErrorSig = sig; stuckNudges = 0; }
      } else {
        // 这一轮没有失败（跑通了 / 只是读文件）→ 死磕清零，不做任何提示
        stuckRounds = 0; lastErrorSig = null; stuckNudges = 0;
      }
      if (stuckRounds >= STUCK_ROUNDS && stuckNudges < STUCK_MAX_NUDGES) {
        stuckNudges += 1;
        const nudge = [
          `你已经连续 ${stuckRounds} 轮卡在同一个错误上：`,
          `「${lastErrorSig}」`,
          '换了写法但根因没变。**现在停一下，跳出当前思路**，按顺序自查：',
          '① 这个错误真的是我理解的那个意思吗？（先读完整报错，不要只看第一行）',
          '② 我是不是在解决一个不该解决的问题——能用更简单的方式绕过去吗（换实现、降范围、跳过这一步、先用假数据跑通）？',
          '③ 有没有一条完全不同的路径能达到目标（换个工具、换个库、换个文件位置、先做最小可用版）？',
          '④ 这个错误是不是环境问题而不是代码问题（端口占用、权限、缺依赖、路径写错）？',
          '先说你判断的根因，再选一条新路径动手——不要再在同一个地方加第 ' + (stuckRounds + 1) + ' 次补丁。',
          '如果确认这个错误无法在本回合解决，直接把现状（已做了什么、卡在哪、用户需要做什么）写进最终回答，如实交付。'
        ].join('\n');
        convo.push({ role: 'user', content: `[系统] ${nudge}` });
        onEvent?.({ kind: 'warning', message: t('连续 {n} 轮卡在同一个错误，已提示跳出当前思路（{k}/{max}）', { n: stuckRounds, k: stuckNudges, max: STUCK_MAX_NUDGES }) });
        onEvent?.({ kind: 'activity', label: t('检测到死磕同一个错误，已提示换思路…') });
      }
    }
    // 回合内折叠统一在下一次请求前的 compactNow 里做（成批折叠，保护前缀缓存；见 nextFoldAt）。
    // 2026-11-16 教训仍然有效：不能每步把最近几条以外全清掉（「读完就忘」，同一文件读了 107 次）。
    if (inspected.invalid.length) {
      const badNames = [...new Set(inspected.invalid.map((x) => x.name))].join('、');
      if (!argsRepaired) {
        // 纠错一次：错误已经作为 tool 结果回给模型（含位置/片段/要求），下一轮它只重发这一个调用
        argsRepaired = true;
        const msg = t('工具参数不是合法 JSON（{code}）：{tools} 未执行，已把解析错误回给模型重发一次。', { code: ARGS_INVALID_JSON_CODE, tools: badNames });
        warnings.push(msg);
        onEvent?.({ kind: 'warning', message: msg });
        onEvent?.({ kind: 'activity', label: t('工具参数有误，正在让模型重发…') });
        continue;
      }
      // 纠错后仍不合法：不再无限重试，按原因码向用户报错（卡片上是可读文案 + 原因码）
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
      return {
        error: t('工具参数连续两次不是合法 JSON（{code}），本轮已停止，{tools} 没有执行。可重试本步，或让模型把参数拆小后重新发起。常见原因：Windows 路径写成单反斜杠；请改用 D:/... 或 D:\\\\...（JSON 里反斜杠必须双写）。', { code: ARGS_INVALID_JSON_CODE, tools: badNames }),
        errorCode: ARGS_INVALID_JSON_CODE,
        trace,
        reasoning: reasoningAll || undefined,
        roundsUsed: turnsUsed,
        warnings
      };
    }
    // 这一轮参数全合法：重新武装纠错额度（只约束「连续失败」，长回合里后面的偶发笔误仍能自愈一次）
    argsRepaired = false;
    argsTruncatedRetried = false;
  }

  // 达到轮次上限/budget 上限不丢工作：追加一次「禁止调工具」的收尾请求（fail-soft），让模型就已有证据下结论
  onEvent?.({ kind: 'phase', name: 'finalizing' });
  onEvent?.({ kind: 'activity', label: SILENCE_MS > 0 ? t('等待网关响应…') : 'Thinking…' }); // 收尾请求也是真实请求，WorkingStatus 别停在旧文案
  const workedMs = () => Date.now() - turnStart;
  // 收尾请求：网关抖动（503/429/5xx）也要重试，别把一小时攒下的证据丢在最后一步
  const FINALIZE_ATTEMPTS = noLimits ? 1 : 3;
  let fctl = null;
  let fwatch = null;
  let fsilence = null;
  let onFabort = null;
  const stopDesc = budgetStop === 'time'
    ? t('本轮时间预算已用完（模型用了 {used}s，上限 {limit}s；工具执行时间不计）', { used: Math.round(Math.max(0, Date.now() - turnStart - toolWaitMs) / 1000), limit: Math.round(maxTurnMs / 1000) })
    : budgetStop === 'tokens'
      ? t('本轮 token 预算已用完（已用 {used}，上限 {limit}）', { used: turnTokens, limit: maxTurnTokens })
      : t('工具调用轮次已达上限（{n}）', { n: maxTurns });
  const wrap = { role: 'user', content: `[系统] ${stopDesc}。不要再调用任何工具，立即基于以上所有工具结果给出最终结论：已复现什么、没覆盖什么、下一步建议。` };
  applySteer(); // 收尾请求前再 drain 一次，尽量不把用户最后注入的内容留到回合外
  await refreshLiveConfig(); // 收尾请求也是一次真实请求：按最新配置解析
  await compactNow(); // 收尾请求同样守住上下文预算（token 两级压缩）
  const fbody = (withUsage) => JSON.stringify({
    model: liveConfig.model,
    messages: [...convo, wrap],
    stream: true,
    ...(withUsage ? { stream_options: { include_usage: true } } : {}),
    ...effortParam(liveConfig.reasoningEffort)
  }); // 不带 tools：强制收尾
  const fsend = (withUsage, sig) => fetchImpl(liveChatUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + liveConfig.apiKey },
    body: fbody(withUsage),
    signal: sig
  });
  try {
    let withUsage = STREAM_USAGE;
    let res = null;
    let ferr = '';
    for (let attempt = 1; attempt <= FINALIZE_ATTEMPTS; attempt += 1) {
      const ctl = new AbortController();
      const onOuterAbort = () => ctl.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      const watchdog = FINALIZE_WATCHDOG_MS > 0 ? setTimeout(() => ctl.abort(), FINALIZE_WATCHDOG_MS) : null;
      // 收尾请求同样挂静默看门狗：网关零字节 → 按 attempt 重试；noLimits 也生效
      let silenceHit = false;
      const silence = startSilenceWatchdog(SILENCE_MS, {
        abort: () => { silenceHit = true; ctl.abort(); }
      });
      let attemptRes = null;
      let sendFailed = false;
      try {
        attemptRes = await fsend(withUsage, ctl.signal);
        // 与主循环同策略：网关不认 stream_options 时去掉字段重试一次
        if (!attemptRes.ok && withUsage && attemptRes.status >= 400 && attemptRes.status < 500) {
          console.warn(`[agent-service] 网关拒绝 stream_options.include_usage（HTTP ${attemptRes.status}），收尾请求去掉该字段重试`);
          withUsage = false;
          attemptRes = await fsend(false, ctl.signal);
        }
      } catch (e) {
        if (signal?.aborted) {
          onEvent?.({ kind: 'turn-end', ms: workedMs(), interrupted: true });
          return { cancelled: true, interrupted: true, partialContent: '', answer: '', reasoning: reasoningAll, trace, workedMs: workedMs(), roundsUsed: turnsUsed, usage: lastUsage || undefined };
        }
        ferr = silenceHit
          ? SILENCE_REASON
          : (/abort/i.test(e?.message || '') || e?.name === 'AbortError' ? t('收尾请求超时（{s}s）', { s: watchdogSec(FINALIZE_WATCHDOG_MS) }) : (e?.message || t('收尾请求失败')));
        sendFailed = true;
      } finally {
        silence.stop();
        if (watchdog) clearTimeout(watchdog);
        signal?.removeEventListener('abort', onOuterAbort);
      }
      if (sendFailed) {
        if (attempt >= FINALIZE_ATTEMPTS) break;
        onEvent?.({ kind: 'retry', attempt: attempt + 1, max: FINALIZE_ATTEMPTS, reason: ferr });
        await sleepAbort(backoffMs(attempt), signal);
        continue;
      }
      if (attemptRes?.ok) { res = attemptRes; break; }
      ferr = `HTTP ${attemptRes?.status ?? '?'}`;
      if (attemptRes && RETRYABLE.has(attemptRes.status) && attempt < FINALIZE_ATTEMPTS) {
        onEvent?.({ kind: 'retry', attempt: attempt + 1, max: FINALIZE_ATTEMPTS, reason: t('收尾请求 {err}', { err: ferr }) });
        await sleepAbort(backoffMs(attempt), signal);
        continue;
      }
      break;
    }
    if (!res) {
      onEvent?.({ kind: 'turn-end', ms: workedMs(), error: true });
      return { error: t('{stop}，收尾请求失败：{err}。本轮已收集的证据在时间线里，可点「继续」让我接着做。', { stop: stopDesc, err: ferr || t('网关无响应') }), reasoning: reasoningAll, trace, workedMs: workedMs() };
    }
    // 流式消费阶段单独挂收尾看门狗（默认不设；发送阶段的 controller 已随每次尝试解绑）
    fctl = new AbortController();
    onFabort = () => fctl.abort();
    signal?.addEventListener('abort', onFabort, { once: true });
    fwatch = FINALIZE_WATCHDOG_MS > 0 ? setTimeout(() => fctl.abort(), FINALIZE_WATCHDOG_MS) : null;
    // 收尾流同样按「距上一个字节」计时：零字节才中止，慢但不断流的回答照样收完
    let fsilenceHit = false;
    fsilence = startSilenceWatchdog(SILENCE_MS, {
      abort: () => { fsilenceHit = true; fctl.abort(); }
    });
    let ffirstChunk = true;
    const fin = await consumeStream(res, onToken, onEvent, fctl, () => {
      fsilence?.touch();
      if (ffirstChunk) { ffirstChunk = false; onEvent?.({ kind: 'activity', label: 'Thinking…' }); }
    });
    fsilence?.stop();
    fsilence = null;
    if (fin.usage) lastUsage = fin.usage;
    addUsage(fin.usage);
    if (fin.finishReason) lastFinishReason = fin.finishReason;
    addTurnTokens(fin.usage, fin.content);
    if (signal?.aborted) {
      const partial = fin.content || '';
      onEvent?.({ kind: 'turn-end', ms: workedMs(), interrupted: true });
      return { cancelled: true, interrupted: true, partialContent: partial, answer: partial, reasoning: reasoningAll, trace, workedMs: workedMs(), roundsUsed: turnsUsed, usage: fin.usage || lastUsage || undefined };
    }
    if (fin.aborted) {
      const partial = fin.content || '';
      const abortLabel = fsilenceHit ? t('网关静默 {s}s 无任何响应', { s: silenceSec(SILENCE_MS) }) : t('收尾请求超时（{s}s）', { s: watchdogSec(FINALIZE_WATCHDOG_MS) });
      onEvent?.({ kind: 'turn-end', ms: workedMs(), interrupted: true });
      return await runStopHook({ answer: (partial ? partial + '\n\n' : '') + t('[{reason}，以上为已输出部分；本轮工具证据仍保留]', { reason: abortLabel }), reasoning: reasoningAll, trace, workedMs: workedMs(), usage: lastUsage || undefined, usageTotal, finishReason: lastFinishReason, warnings, roundsUsed: turnsUsed, ...(budgetStop ? { budgetStop } : {}) });
    }
    // 收尾请求自己也可能复读/想太久（2026-11-20）：以前只判 fin.aborted，熔断时 aborted 为假，
    // partial 被当成正常回答交付，用户看到半截复读却以为成功了。
    if (fin.repetitive || fin.longThink) {
      const partial = fin.content || '';
      const why = fin.repetitive ? t('模型在收尾回答里陷入重复输出') : t('模型在收尾回答里思考过长');
      onEvent?.({ kind: 'turn-end', ms: workedMs(), error: true });
      return { error: t('{why}，已自动截断，这次收尾不算完成。本轮工具证据仍保留在时间线里，可点「继续」让我重新收尾。', { why }), reasoning: reasoningAll, trace, workedMs: workedMs(), usage: lastUsage || undefined, roundsUsed: turnsUsed, warnings, ...(partial ? { partialContent: partial } : {}) };
    }
    const names = [...new Set(trace.map((tr) => tr.tool))].join('、') || t('（无）');
    const answer = fin.content || t('{stop}，本轮调用工具：{tools}。可以点「继续」让我接着做。', { stop: stopDesc, tools: names });
    onEvent?.({ kind: 'turn-end', ms: workedMs() });
    return await runStopHook({ answer, reasoning: reasoningAll, trace, workedMs: workedMs(), usage: lastUsage || undefined, usageTotal, finishReason: lastFinishReason, warnings, roundsUsed: turnsUsed, ...(budgetStop ? { budgetStop } : {}) });
  } catch (e) {
    onEvent?.({ kind: 'turn-end', ms: workedMs(), error: true });
    if (signal?.aborted) return { cancelled: true, interrupted: true, partialContent: '', answer: '', reasoning: reasoningAll, trace, workedMs: workedMs(), roundsUsed: turnsUsed, usage: lastUsage || undefined };
    const reason = /abort/i.test(e?.message || '') || e?.name === 'AbortError' ? t('收尾请求超时（{s}s）', { s: watchdogSec(FINALIZE_WATCHDOG_MS) }) : (e?.message || t('收尾请求失败'));
    return { error: t('{stop}，{reason}。本轮已收集的证据在时间线里，可点「继续」让我接着做。', { stop: stopDesc, reason }), reasoning: reasoningAll, trace, workedMs: workedMs() };
  } finally {
    if (fwatch) clearTimeout(fwatch);
    fsilence?.stop();
    if (onFabort) signal?.removeEventListener('abort', onFabort);
  }
}

/* ---------- 工作流子代理：与主 agent 同一套引擎 ---------- */

/**
 * transcript 快照（SubagentPanel 读 role/content/toolCalls/tool/name/args/ms/ok/pending）。
 * toolCalls 单独深拷贝：节流落盘后数组还会继续追加，不能把「活引用」交给面板缓存。
 */
export function snapshotTranscript(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const copy = { ...m };
    if (Array.isArray(m.toolCalls)) copy.toolCalls = m.toolCalls.map((c) => ({ ...(c || {}) }));
    return copy;
  });
}

/**
 * 工作流单步子代理：复用 runAgentTurn（流式、两级压缩、轮数默认不设上限、usage），不再手写非流式循环。
 * 只做三件事：
 *  1. system（子代理系统提示）+ user（任务）→ runAgentTurn（toolsSchema 收窄到 14 个工具）；
 *  2. onToken/onEvent 映射成 SubagentPanel 的 transcript（200ms 节流落盘，运行中可见逐字输出）；
 *  3. 结束后用 trace 统计 toolCount，套 needsEvidence / judgeSubagentOutcome 空转与截断硬闸。
 *
 * @returns {Promise<{content?:string,error?:string,toolCount:number,truncated:boolean,warnings:string[],finishReason:string|null,transcript:object[],usage?:object}>}
 */
export async function runSubagentTurn({
  config,
  systemPrompt = '',
  prompt = '',
  kind = null,
  name = '',
  role = '',
  tools = {},
  toolsSchema = null,
  requiresTools = null,
  forceFirstToolChoice = null,
  signal = null,
  fetchImpl = fetch,
  maxTurns = DEFAULT_MAX_TURNS,
  maxTurnMs,
  maxTurnTokens,
  retryBaseMs = 600,
  onTranscript = null,
  onToken: onTokenHook = null,
  onToolLifecycle = null,
  onUsage = null,
  saveIntervalMs = 200,
  now = Date.now
} = {}) {
  // 判定规则与 workflow.mjs 同一份（不在这里另写一套）；动态导入避免 agent-service 被静态拉进 workflow 依赖链
  const { needsEvidence, judgeSubagentOutcome, SUBAGENT_TRUNCATED_WARNING } = await import('./workflow.mjs');
  const requires = requiresTools === null || requiresTools === undefined
    ? needsEvidence({ kind, name, role, prompt })
    : !!requiresTools;
  // 取证步骤首轮强制 tool_choice=required；显式传入 forceFirstToolChoice 时以它为准
  const forceFirst = forceFirstToolChoice === null || forceFirstToolChoice === undefined
    ? requires
    : !!forceFirstToolChoice;
  const startedAt = now();
  const transcript = [
    { role: 'system', content: String(systemPrompt || '') },
    { role: 'user', content: String(prompt || '') }
  ];
  let current = null; // 正在流式接收的 assistant 条目
  let currentStartedAt = 0;
  let saveTimer = null;
  let lastFlushAt = 0;

  const flush = (done = false) => {
    if (typeof onTranscript !== 'function') return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { onTranscript(snapshotTranscript(transcript), { done }); } catch { /* 面板落盘失败不影响执行 */ }
    lastFlushAt = now();
  };
  // 逐字输出节流：200ms 内只落一次盘，避免每个 token 都走一遍 IPC 快照
  const scheduleFlush = () => {
    if (typeof onTranscript !== 'function' || saveTimer) return;
    const wait = Math.max(0, Number(saveIntervalMs) - (now() - lastFlushAt));
    saveTimer = setTimeout(() => { saveTimer = null; flush(); }, Number.isFinite(wait) ? wait : 200);
    saveTimer?.unref?.();
  };
  const ensureAssistant = () => {
    if (current) return current;
    currentStartedAt = now();
    current = { role: 'assistant', content: '', startedAt: currentStartedAt };
    transcript.push(current);
    return current;
  };
  const closeAssistant = (final = false) => {
    if (!current) return null;
    const entry = current;
    entry.ms = Math.max(0, now() - currentStartedAt);
    entry.final = !!final;
    current = null;
    return entry;
  };

  const onToken = (text) => {
    if (typeof text !== 'string' || !text) return;
    ensureAssistant().content += text;
    if (typeof onTokenHook === 'function') { try { onTokenHook(text); } catch { /* 观测回调失败不影响执行 */ } }
    scheduleFlush();
  };
  const onEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'reasoning' && typeof ev.text === 'string' && ev.text) {
      const entry = ensureAssistant();
      entry.reasoning = (entry.reasoning || '') + ev.text;
      scheduleFlush();
      return;
    }
    if (ev.kind === 'system' && typeof ev.content === 'string' && ev.content) {
      // 空转提醒：先把当前 assistant 收尾，再按真实顺序插一条 system（面板能看出「提醒后再试」）
      closeAssistant(false);
      transcript.push({ role: 'system', content: ev.content });
      flush();
      return;
    }
    if (ev.kind === 'tool-start') {
      const entry = ensureAssistant();
      entry.toolCalls = Array.isArray(entry.toolCalls) ? entry.toolCalls : [];
      entry.toolCalls.push({ name: ev.name || 'tool', args: ev.args || '', ...(ev.id ? { id: ev.id } : {}) });
      closeAssistant(false);
      transcript.push({
        role: 'tool',
        name: ev.name || 'tool',
        args: ev.args || '',
        content: '',
        pending: true,
        startedAt: now(),
        ...(ev.id ? { id: ev.id } : {})
      });
      flush(); // 结构性事件立即落盘：右侧面板马上出现 running 行
      return;
    }
    if (ev.kind === 'tool-end') {
      const next = {
        role: 'tool',
        name: ev.name || 'tool',
        content: '',
        ms: ev.ms,
        ok: ev.ok !== false,
        pending: false,
        ...(ev.cancelled ? { cancelled: true } : {}),
        ...(ev.id ? { id: ev.id } : {})
      };
      // 并行工具同批执行：优先按 tool_call id 找回对应的 pending 行，没有 id 时按名字找最近一条
      let idx = -1;
      for (let i = transcript.length - 1; i >= 0; i -= 1) {
        const m = transcript[i];
        if (m?.role !== 'tool' || !m.pending) continue;
        if (ev.id && m.id) { if (m.id === ev.id) { idx = i; break; } continue; }
        if (m.name === next.name) { idx = i; break; }
      }
      if (idx >= 0) {
        const prev = transcript[idx];
        transcript[idx] = { ...prev, ...next, args: prev.args, startedAt: prev.startedAt };
      } else {
        transcript.push(next);
      }
      scheduleFlush();
    }
  };

  let out = null;
  let thrown = null;
  try {
    out = await runAgentTurn({
      config,
      messages: [{ role: 'user', content: String(prompt || '') }],
      systemPrompt: String(systemPrompt || ''),
      tools,
      toolsSchema,
      forceFirstToolChoice: forceFirst,
      onToken,
      onEvent,
      onToolLifecycle,
      onUsage,
      signal,
      fetchImpl,
      maxTurns,
      // 子代理不设墙钟超时：关掉单次请求 watchdog、收尾 watchdog 与时间/token 软预算；轮数默认不设上限
      // 但静默看门狗（SILENCE_MS）不受 noLimits 影响：子代理同样要能在网关零字节时失败重试
      noLimits: true,
      retryBaseMs,
      ...(maxTurnTokens != null ? { maxTurnTokens } : {})
    });
  } catch (e) {
    thrown = e;
  }

  // 流式阶段结束：把最后一个 assistant 条目收尾（正文以引擎返回的 answer 为准，避免漏掉末段/收尾合成文本）
  const finalEntry = closeAssistant(true);
  const rawAnswer = String(out?.answer ?? '');
  const answer = (rawAnswer.trim() === '(空回复)' ? '' : rawAnswer).trim();
  if (!out?.error && answer) {
    if (finalEntry) finalEntry.content = answer;
    else transcript.push({ role: 'assistant', content: answer, final: true, ms: null });
  }
  // 中断/异常遗留的 pending 工具行收口（面板不能永远转圈）
  const toolEntries = transcript.filter((m) => m.role === 'tool');
  for (const m of toolEntries) {
    if (m.pending) { m.pending = false; m.ok = false; m.cancelled = true; }
  }
  // 工具结果正文：runAgentTurn 的 trace 按调用顺序返回，回填到对应的 tool 行（与旧面板 content 形状一致）
  const trace = Array.isArray(out?.trace) ? out.trace : [];
  let cursor = 0;
  for (const tr of trace) {
    let idx = -1;
    for (let i = cursor; i < toolEntries.length; i += 1) {
      if (toolEntries[i].name === tr?.tool) { idx = i; break; }
    }
    if (idx < 0 && cursor < toolEntries.length) idx = cursor;
    if (idx < 0) continue;
    let text = '';
    try { text = JSON.stringify(tr?.result ?? null); } catch { text = ''; }
    toolEntries[idx].content = String(text ?? '').slice(0, 16000);
    cursor = idx + 1;
  }

  const toolCount = trace.length;
  const finishReason = out?.finishReason || null;
  const truncated = finishReason === 'length';
  const warnings = [];
  for (const w of Array.isArray(out?.warnings) ? out.warnings : []) warnings.push(String(w));
  if (truncated) warnings.push(SUBAGENT_TRUNCATED_WARNING);
  let error = out?.error || null;
  const aborted = !!out?.cancelled || !!out?.interrupted || (!!signal?.aborted && !out?.error);
  // 子代理不再按时间/软预算自动收尾：只有用户停止、网关错误、空转/截断等真实失败才置 error
  if (!error && aborted) error = t('子代理被中断');
  if (!error) {
    const judged = judgeSubagentOutcome({ kind, content: answer, toolCount, toolCountKnown: true, truncated, requiresTools: requires });
    if (!judged.ok) error = judged.error;
    else if (!answer) error = t('子代理没有返回内容');
  }
  // 失败节点不能只剩一个 error：中断/空回复用 transcript 做确定性 salvage（不调模型），
  // 正文始终回传，子代理面板/报告/续跑都能看到这一步做到哪。
  let salvaged = false;
  let salvageReason = null;
  let content = answer;
  if (error && (!answer || aborted)) {
    content = salvageSubagentContent({
      transcript,
      toolCount,
      reason: aborted ? 'aborted' : 'empty',
      partialContent: answer,
      error,
    });
    salvaged = true;
    salvageReason = aborted ? 'aborted' : 'empty';
  }
  // 空回复是「模型结束但没给正文」这一种失败，单列 EMPTY_CONTENT；网关/循环中止等其它错误
  // 交给 deriveNodeErrorCode（HTTP 5xx / STALL / STEP_FAIL），避免把「网关挂了」误报成「没有返回内容」。
  const emptyReply = !!out?.emptyReply;
  const errorCode = error
    ? (aborted
      ? 'INTERRUPTED'
      : (emptyReply
        ? 'EMPTY_CONTENT'
        : deriveNodeErrorCode({
          errorText: out?.error || '',
          content: answer,
          toolCount,
          toolCountKnown: true,
          truncated,
          requiresTools: requires,
        })))
    : null;
  // salvage 正文同时写进 transcript（标记 salvaged）：SubagentPanel 最终答案是「最后一个有正文的
  // assistant 条目」，不写进去面板就会误报「没有留下交付物」——即使 step content 其实有内容。
  if (salvaged && content) {
    transcript.push({ role: 'assistant', content, final: true, ms: null, salvaged: true, salvageReason });
  }

  flush(true);
  if (thrown) throw thrown;
  return {
    // 失败也回传正文（salvage 文本）：工作流/报告要能看到这一步做到哪（硬断与软预算都不丢进度）
    content,
    ...(error ? { error } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(salvaged ? { salvaged: true, salvageReason } : {}),
    toolCount,
    truncated,
    warnings,
    finishReason,
    ...(Number.isFinite(out?.roundsUsed) ? { roundsUsed: out.roundsUsed } : {}),
    ...(out?.budgetStop ? { budgetStop: out.budgetStop } : {}),
    transcript: snapshotTranscript(transcript),
    ...(out?.reasoning ? { reasoning: out.reasoning } : {}),
    ...(out?.usageTotal ? { usageTotal: out.usageTotal } : {}),
    ...(out?.usage ? { usage: out.usage } : {}),
    ms: now() - startedAt
  };
}
