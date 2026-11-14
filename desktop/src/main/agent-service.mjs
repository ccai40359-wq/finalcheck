// Agent 服务：OpenAI 兼容 /chat/completions + tools 循环（DESKTOP-ACCEPTANCE §5）
// 安全边界由主进程 assertAllowedTarget 把守，这里只管协议与循环
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assembleContext, estimateTokens, estimateMessagesTokens, microcompact, fullCompact, contextBudget, needsCompaction } from './context.mjs';
import { crossTurnBudgetTokens } from './model-config.mjs';
// token 估算/两级压缩原语实现放在 context.mjs（与上下文视图同源）；这里重新导出，单测可直接从 agent-service 取
export { estimateTokens, estimateMessagesTokens, microcompact, fullCompact, contextBudget } from './context.mjs';
import { loadCatalog, renderCatalog } from '../../../src/playbooks.mjs';
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
const STREAM_USAGE = process.env.FINALCHECK_STREAM_USAGE !== '0'; // 请求流式 usage；个别网关不认该字段时按 4xx 降级
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
  { type: 'function', function: { name: 'list_playbooks', description: '列出渗透方法论库的 40 个类目（编号/中文名/英文名/触发词/文件数）。开始渗透测试或不确定该用哪类手法时先调用它', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read_playbook', description: '读方法论库（playbooks/web-vuln，40 类漏洞技能包）。topic 传类目编号或英文名（如 11 / ssrf / sql-injection）；默认返回 SKILL.md 入口（含文件路由）；附属手册用 file 指定、大文件用 offset/limit 续读', parameters: { type: 'object', properties: { topic: { type: 'string', description: '类目编号或英文名，如 11 / ssrf / idor / jwt / wafbypass / vuln-report-generate' }, file: { type: 'string', description: '可选：该类目目录下的具体文件名（可先用 topic 读入口看 files 列表）' }, offset: { type: 'number', description: '可选：从第几个字符开始读，默认 0' }, limit: { type: 'number', description: '可选：本次最多读多少字符，默认 14000，上限 30000' } }, required: ['topic'] } } },
  { type: 'function', function: { name: 'read_file', description: '读取本机文本文件（带行数/分页）。修改代码前先用它看清原文；大文件用 offset/limit 续读', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径。' + PATH_JSON_HINT }, offset: { type: 'number', description: '可选：从第几个字符开始，默认 0' }, limit: { type: 'number', description: '可选：本次最多读多少字符，默认 20000，上限 40000' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'edit_file', description: '精确修改文件：把 old_string 替换成 new_string（old_string 必须在文件中唯一，否则拒绝）。改前先 read_file；改后返回 +N/-M 与 diff。需要用户审批', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径。' + PATH_JSON_HINT }, old_string: { type: 'string', description: '要替换的原文本（含缩进，必须唯一）' }, new_string: { type: 'string', description: '替换后的文本（可为空字符串=删除）' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'write_file', description: '新建或整体覆盖文本文件（≤2MB），返回 +N/-M 与 diff。父目录必须已存在；需要用户审批', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径。' + PATH_JSON_HINT }, content: { type: 'string', description: '完整文件内容' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'present_artifact', description: '把生成/修改好的 png / html / pdf / 文本文件登记为右侧可预览产物（用户点一下就在右侧打开）。生成了网页/图片后调用它', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径。' + PATH_JSON_HINT }, title: { type: 'string', description: '可选：展示标题' } }, required: ['path'] } } },
  {
    type: 'function',
    function: {
      name: 'run_workflow',
      description: '多 agent 工作流。第一步先判断任务形状，再二选一（互斥，只给一个）：步骤数量固定、方向并列/串行 → steps（自己设计 2-14 个步骤，每步一个独立子代理，引擎按 depends_on 拓扑排序、互不依赖的步骤并行执行，上游结果自动注入下游；互不依赖的步骤请用空 depends_on []，不要为了「看起来有顺序」串成链）；步骤数量由上游结果决定（按列表扇出/循环到满足条件/条件分支/递归/纯计算汇总）→ script（受限 JSON 指令 step/fanout/if/gate/verify/report/loop/recurse/aggregate，只解释执行，不运行代码）；判断不了 → 默认 steps。不要问用户用哪种，自己判断，最后用一句话说明用了哪种、为什么。每个步骤/节点都必须给 name：写成人名化职位名（4-10 字，如「SQL 注入审查员」「依赖供应链专员」「交付报告主编」），不许写「步骤 1」「分析」「检查」这种序号名或泛词。不要自己串行假装并行',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: '整个工作流要达成的总目标（一句话）' },
          steps: {
            type: 'array',
            description: '步骤列表（1-14 个；与 script 互斥，二选一）',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '步骤 id（字母数字-_，唯一）' },
                name: { type: 'string', description: '步骤职位名（展示用，必填）：4-10 字的人名化职位，如「SQL 注入审查员」「依赖供应链专员」「交付报告主编」；不许写「步骤 1」「分析」「检查」这种序号名或泛词' },
                role: { type: 'string', description: '子代理角色，如「SQL 注入专家」「代码审查员」' },
                prompt: { type: 'string', description: '交给子代理的具体任务；要自包含（输入、要产出什么），上游结果会自动附上' },
                depends_on: { type: 'array', items: { type: 'string' }, description: '依赖的步骤 id 列表；不需要上游结果就写空数组 []（=可立即并行），只有确实要消费上游产出才写依赖' },
                kind: { type: 'string', enum: ['recon', 'find', 'verify', 'arbitrate', 'report'], description: '可选：对抗验证协议角色；find 取证、verify/arbitrate 复核' },
                model: { type: 'string', description: '可选：本步使用的模型，必须在该供应商的 models 列表里（否则回退全局子代理模型）' },
                providerId: { type: 'string', description: '可选：本步使用的供应商 id；verify/arbitrate 建议换成与 find 不同家族的供应商' },
                blind: { type: 'boolean', description: '可选：verify/arbitrate 默认盲验（只给 claim 与证据指针）' }
              },
              required: ['id', 'prompt']
            }
          },
          script: {
            type: 'array',
            description: '受限脚本 DSL（与 steps 互斥）：按数组顺序解释执行，只支持 step/fanout/if/gate/verify/report/loop/recurse/aggregate；未知 op 直接报错。上限：总节点 200、fanout 50 项、if 嵌套 8 层、loop 20 轮、recurse 4 层',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['step', 'fanout', 'if', 'gate', 'verify', 'report', 'loop', 'recurse', 'aggregate'], description: '指令类型' },
                id: { type: 'string', description: '指令/节点 id（字母数字-_，唯一）' },
                name: { type: 'string', description: '可选：展示用职位名（4-10 字，如「鉴权与越权审查员」）；fanout 的 step.name 是子节点职位名，会与扇出项拼成「/api/login 鉴权与越权审查员」' },
                role: { type: 'string', description: '可选：子代理角色' },
                prompt: { type: 'string', description: 'step 的任务；fanout/recurse 的 prompt 支持 ${变量} 插值' },
                depends_on: { type: 'array', items: { type: 'string' }, description: '可选：只影响上游结果注入，不改变执行顺序' },
                over: { description: 'fanout/recurse 的字符串数组，或已执行节点的引用', anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] },
                as: { type: 'string', description: 'fanout/recurse 变量名；prompt 里用 ${名} 引用当前项' },
                step: { type: 'object', description: 'fanout 的子步骤 {name?, role?, prompt}', properties: { name: { type: 'string' }, role: { type: 'string' }, prompt: { type: 'string' } }, required: ['prompt'] },
                when: { type: 'object', description: 'if 条件 {ref, test:{contains?, equals?, notEmpty?}}' },
                then: { type: 'array', items: { type: 'object' }, description: 'if 命中时执行的 op 数组（递归）' },
                else: { type: 'array', items: { type: 'object' }, description: 'if 不命中时执行的 op 数组（递归）' },
                tool: { type: 'string', enum: ['audit_project', 'quality_gate', 'review_diff'], description: 'gate 直接执行的程序工具（不调模型）' },
                args: { type: 'object', description: 'gate 工具参数（如 {dir, tier, base}）' },
                from: { description: 'verify/report/aggregate 的上游节点引用（字符串或字符串数组）', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
                ask: { type: 'string', description: 'report 的汇总要求' },
                maxRounds: { type: 'number', description: 'loop 必填：最大轮次 1..20' },
                body: { type: 'array', items: { type: 'object' }, description: 'loop/recurse 的 body op 数组（递归）' },
                until: { type: 'object', description: 'loop 结束条件 {ref, test}' },
                maxDepth: { type: 'number', description: 'recurse 必填：最大深度 1..4' },
                stopWhen: { type: 'object', description: 'recurse 某分支停止条件 {ref, test}' },
                by: { type: 'string', enum: ['severity', 'rule', 'file', 'status'], description: 'aggregate 聚合键' },
                top: { type: 'number', description: 'aggregate 返回前 N 组 1..20（默认 10）' }
              },
              required: ['op', 'id']
            }
          }
        },
        required: ['goal']
      }
    }
  },
  { type: 'function', function: { name: 'remember_project', description: '把用户明确要求长期记住的项目事实写进项目根的 AGENTS.md（追加到「## 记忆」小节，自动去重）。只记稳定事实：项目用途、技术栈、目录约定、禁忌、验收口径；不要记一次性会话内容', parameters: { type: 'object', properties: { fact: { type: 'string', description: '一条事实，一句话，尽量带路径/命令等可核对信息' } }, required: ['fact'] } } },
  { type: 'function', function: { name: 'run_command', description: '在本机执行 shell 命令（Windows cmd 语法：dir/type/findstr/curl 等）。用于探查目录、读文件、验证问题——用户明确授权自由使用。灾难性命令会被拦截。起常驻服务（node server.mjs / 端口监听）必须用 background:true 立刻拿 PID，不要用 Start-Process / start /b 再等它返回；连续 120s 无输出的命令会自动转后台并返回 PID（进程不杀）', parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' }, cwd: { type: 'string', description: '工作目录（可选）。' + PATH_JSON_HINT }, timeout_ms: { type: 'number', description: '超时毫秒（可选）；不传则不限时跑到命令结束（连续 120s 无输出会转后台返回 PID），传了按该毫秒数到点终止' }, background: { type: 'boolean', description: 'true=立刻在后台启动并返回 PID（起常驻服务用），不等待输出' }, idle_ms: { type: 'number', description: '可选：多久无输出算卡住并转后台，默认 120000；0=关闭该兜底' } }, required: ['command'] } } }
];

// review_diff：只读 git 改动审查。单列一份而不是塞进 TOOLS_SCHEMA：
// TOOLS_SCHEMA 同时是 MCP 通道的 SSOT（src/mcp/server.mjs 照抄并精确断言工具表），
// MCP 通道没有 review_diff 的实现，放进去会让 tools/list 暴露一个调不通的工具。
export const AGENT_ONLY_TOOLS_SCHEMA = [
  // 修复回路（③）：回滚到 edit_file/write_file 改动前的快照（主 agent 专属，子代理不给）
  { type: 'function', function: { name: 'repair_rollback', description: '把文件回滚到本次编辑前的快照（edit_file/write_file 每次覆盖已存在文件都会自动留一份快照）。改坏了就用它恢复，不要手工拼回原文', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径（与 edit 时一致）。' + PATH_JSON_HINT }, snapshotId: { type: 'string', description: '可选：edit_file 结果里返回的 snapshotId；不给就恢复到最新一次改动前' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'review_diff', description: '只读审查 git 改动（默认对比 HEAD，也可 HEAD~1 / 分支名）：返回改动文件与 +/- 行数，并标出新增 SQL 拼接 / 命令执行 / 密钥字面量、删除的鉴权中间件、被改的 .env/.gitignore。不执行被审项目代码，不做 add/commit/checkout', parameters: { type: 'object', properties: { dir: { type: 'string', description: '项目绝对路径。' + PATH_JSON_HINT }, base: { type: 'string', description: '可选：对比基线，默认 HEAD（也可 HEAD~1 或分支名）' } }, required: ['dir'] } } },
  // 回合中途向用户提问：只在主 agent 的工具表；子代理不注册（避免并行子代理同时弹多个问题）。
  // 卡片 UI 用 callId 关联；回答经 finalcheck:ask-user-answer 回填，工具返回 { answer }。
  { type: 'function', function: { name: 'ask_user', description: '回合中途向用户提问并等待回答（同一回合最多 3 次）。只在真有分叉且影响结论时使用（例如「按 L2 还是 L3」「动态探测要不要授权」「两个方向只能选一个」），信息足够时不要打扰用户。最多给 6 个选项；纯开放式提问可以不给 options，由用户自己输入。调用后本回合暂停，直到用户回答或点击停止', parameters: { type: 'object', properties: { question: { type: 'string', description: '要问用户的问题，一句话说清分叉点与影响' }, options: { type: 'array', maxItems: 6, description: '可选：2-6 个候选答案；不给则纯开放式提问', items: { type: 'object', properties: { label: { type: 'string', description: '选项短标签' }, description: { type: 'string', description: '可选的补充说明（影响/代价）' } }, required: ['label'] } }, multiSelect: { type: 'boolean', description: '可选：是否允许多选，默认 false' } }, required: ['question'] } } },
  // 验收单（ZCode todo 式）：用户可见的勾选清单，3-8 条，每条必须写清验收标准。
  // 可多次调用更新状态；done 必须带 evidence，failed/skipped 会被报告闸要求写进 ## Not covered。
  { type: 'function', function: { name: 'todo_write', description: '维护本轮任务的验收单（勾选清单）：3-8 条，每条必须给 acceptance（怎么算做完）；可多次调用按 id 更新 status。开工时先写一遍，做完一条就把 status 改成 done 并补 evidence（文件:行 / 命令输出 / HTTP 复现）。不能做或跳过的条目标 failed/skipped，最终回答的 ## Not covered 必须点名它们', parameters: { type: 'object', properties: { items: { type: 'array', minItems: 3, maxItems: 8, description: '3-8 条任务；id 稳定（更新状态时按 id 合并）', items: { type: 'object', properties: { id: { type: 'string', description: '稳定标识（如 s1 / step-1）' }, task: { type: 'string', description: '这一步要做什么（一句话）' }, acceptance: { type: 'string', description: '验收标准（必填）：怎么算这一步完成，可检查的条件' }, status: { type: 'string', enum: ['pending', 'running', 'done', 'failed', 'skipped'], description: '状态，默认 pending' }, evidence: { type: 'string', description: '证据（done 时必填）：文件:行 / 命令输出摘要 / HTTP 复现' } }, required: ['id', 'task', 'acceptance'] } } }, required: ['items'] } } }
];
export const AGENT_TOOLS_SCHEMA = [...TOOLS_SCHEMA, ...AGENT_ONLY_TOOLS_SCHEMA];

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
  '你还有 run_command：像 coding agent 一样自由执行命令（Windows cmd 语法：dir /b、type、findstr、curl、node 等）——用户让你"看看某目录/某个盘"就用它探查后再回答，不要拒绝；灾难性命令会被系统拦截，不必自己判断。',
  '做渗透测试时必先查方法论库：先 list_playbooks 看 40 类目录，命中类目后 read_playbook(topic=编号或英文名) 读入口 SKILL.md，再按其「文件路由」用 file+offset 下钻附属手册；按手册的方法论执行测试，不要凭空瞎试。',
  '测试纪律：侦察（端口/指纹/目录/JS/API）→ 选类目 → 读方法论 → 用 probe_target / run_command 构造请求验证 → 只把已复现的写进结论，未复现的标「线索」。',
  '工具可用性：不假设 nmap/sqlmap/dirsearch 等外部工具已安装；先用 run_command 的 where 探测，没有就用 curl/node 做等价的手工验证，不要卡在装工具上。',
  '执行节奏：每个类目先跑手册里的最小验证集（3-5 个请求），有证据就停；大字典爆破、压测、登录尝试只在用户明确要求时做。',
  '边界：动态目标以用户在对话中的口头确认为准——用户给出目标 URL 或表示同意，即为授权，直接执行（压测默认温和参数）；结论引用工具返回的 verdict；覆盖不足要明说"没查到"。',
  '工具结果超长时会被截断为「头+尾」并完整落盘，按提示的 spill 路径用 run_command 检索，不要猜中间内容。',
  '修代码：先 read_file 看清原文，再用 edit_file 做最小替换（old_string 必须唯一）；新建文件用 write_file。改完明确告诉用户「改了哪个文件、+几行/-几行、为什么」。',
  '路径参数转义（硬规则）：JSON 参数里的 Windows 路径一律优先写正斜杠（D:/Projects/demo）；必须用反斜杠时一律双写（D:\\\\Projects\\\\demo）；写成单反斜杠会让参数不是合法 JSON，工具不会执行。',
  '产出可预览文件（html / png / pdf / md 等）后，调用 present_artifact(path) 登记；用户在聊天里点一下就出现在右侧预览面板。',
  '多 agent 工作流（第一步先判断任务形状，再二选一；不要问用户用哪种，你自己判断，最后用一句话说明用了哪种、为什么）：步骤数量固定、方向并列/串行 → 用 steps（每步一个独立子代理：角色 + 自包含任务 + depends_on，引擎按依赖并行；拿到各步结果后汇总成一份结论）；步骤数量由上游结果决定（按列表扇出、循环到满足条件、按类型递归、条件分支、纯计算汇总）→ 用 script（受限 JSON 指令 step/fanout/if/gate/verify/report/loop/recurse/aggregate，只解释执行、不运行代码）；判断不了 → 默认 steps。不要用「我要开始第 1 步」的文字模拟并行。每步 name 必须是职位名（4-10 字，如「SQL 注入审查员」「依赖供应链专员」），不许写「步骤 1」「分析」这种。',
  '拆步铁律（写 depends_on 前先自问）：每写完一步先问「这一步真的需要上一步的结果吗」——不需要就写 depends_on: []（空数组 = 可立即并行，多路同时跑）；只有确实要消费上游产出（读到它的结论、复用它的清单）才写依赖。为了「看起来有顺序」把步骤串成链，会让子代理排队、总耗时按步数翻倍。最小示例（3 步、2 步并行）：[{id:"s1",prompt:"查 A 的证据",depends_on:[]},{id:"s2",prompt:"查 B 的证据",depends_on:[]},{id:"s3",prompt:"汇总 s1 与 s2 的结论",depends_on:["s1","s2"]}] — s1 与 s2 同时跑，s3 等两者都完成；不要写成 s2 依赖 s1。',
  '复杂项目要主动开工作流：当项目较大（约 ≥2000 行 / 多语言 / 多服务）且任务能拆成互不依赖的几路（体检、下载闸、依赖供应链、鉴权越权、动态探测）时，直接调用 run_workflow 并行分头查，不必等用户说「用工作流」；步骤 3-8 个（特别大的项目可到 14 个），每步限定目录或类目（例如「只看 includes/ 的 SQL 与 nonce」），不要把「通读整个仓库」丢给一个子代理。小任务（单文件、单问题、顺手看一眼）不要用工作流，自己查更快。',
  '子代理是有工具的：它们能调用 read_file / run_command / audit_project / download_gate / probe_target / stress_target / list_playbooks / read_playbook（不能改文件、不能再起工作流）。所以每步 prompt 要写成「用哪个工具对什么跑什么、产出什么证据」的可执行任务（例：「用 audit_project 对 D:\\x 跑 L2，列出高危项」），让几个子代理并行跑不同测试，别把活全留给自己。',
  '项目记忆：项目根的 AGENTS.md 是该项目唯一的长期记忆载体，每轮会自动注入。用户说「记住 / 以后都这样 / 记到项目里」时，用 remember_project 追加一条稳定事实（不要凭印象编造，也不要塞一次性内容）；AGENTS.md 里已有的约定优先遵守；没有 AGENTS.md 时不要主动创建，除非用户要求。',
  '质量命令闸：项目根若有 finalcheck.quality.json，调用 quality_gate 会跑里面声明的 lint / typecheck / test / bench 并给出 exit、耗时、是否超阈值、覆盖率（执行前会要用户授权）。用户问「可读性 / 性能 / 稳定性 / 能不能转接」时：先看有没有这份配置；有就跑它拿可测量证据，没有就明说「没有量化闸，只能代码审查」，再用 read_file 逐文件给结论+文件:行，不要编造分数（没有 profiler，就没有 p95）。',
  '验收档位纪律：用户说「按 L1 / L2 / L3 验收」时必须把 tier 显式传给 audit_project，不许自行降档；L2 会跑交接(H1)与可维护性(Q3)，L3 再加许可证(C1)与运维(O1)。返回的 gates.gaps 必须原样列给用户（「这关没跑，原因是…」），不许把没跑的关说成通过，也不许用「AI 看过了」替代没跑的闸。',
  '向用户提问：只在不问就无法继续、且答案会改变结论时调用 ask_user（例如「按 L2 还是 L3」「动态探测要不要授权」「两个方向只能选一个」）；信息足够时不要打扰用户。一次只问一件事，选项最多 6 个；纯开放式问题可以不给选项。一次回合最多问 3 次，第 4 次会被拒绝。',
  '验收单：任务要分几步做时，开工前先用 todo_write 写 3-8 条，每条 acceptance（怎么算完成）必填；做完一条立刻再调一次 todo_write 把 status 改成 done 并补 evidence（文件:行 / 命令输出 / HTTP 复现）。做不了或跳过的条目写 failed/skipped，最终回答的 ## Not covered 必须逐条点名它们——done 无证据、failed/skipped 没点名，报告闸会判不合格。',
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
  '需要用户拍板的事（砍功能/动线上数据/花钱的 API）用 ask_user 问一次就动手；其余决策自己定。一次回合最多问 3 次。',
  '路径参数转义（硬规则）：JSON 参数里的 Windows 路径一律优先写正斜杠（D:/Projects/demo）；必须用反斜杠时一律双写（D:\\\\Projects\\\\demo）；写成单反斜杠会让参数不是合法 JSON，工具不会执行。',
  '工具结果超长时会被截断为「头+尾」并完整落盘，按提示的 spill 路径用 run_command 检索，不要猜中间内容。',
  '产出可预览文件（html / png / pdf / md 等）后，调用 present_artifact(path) 登记；用户在聊天里点一下就出现在右侧预览面板。',
  '项目记忆：项目根的 AGENTS.md 每轮自动注入，其中约定优先遵守；用户说「记住」时用 remember_project 追加。',
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
        skills = renderCatalog(catalog);
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

export async function consumeStream(res, onToken, onEvent, ctl, onChunk = null) {
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  const toolCallMeta = []; // 流式分片的归属表：{index,id,call}，不写进最终 toolCalls
  let raw = '';
  let usage = null;
  let finishReason = null;
  let lastCheckLen = 0;
  let repetitive = false;
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
    if (think) { reasoning += think; chunkProgress = true; onEvent?.({ kind: 'reasoning', text: think }); }
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
        if (tail.length >= 50 && content.split(tail).length - 1 >= 4) { repetitive = true; ctl?.abort(); }
      }
      if (content.length > 20000) { repetitive = true; ctl?.abort(); }
    }
    let sawToolDelta = false;
    for (const tc of d.tool_calls || []) {
      mergeStreamingToolCall(toolCalls, toolCallMeta, tc);
      sawToolDelta = true;
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
    // dsh 语义：中断不截断——已流出的内容原样保留，返回 aborted 标记交给上层合成「已中断」收尾
    if (ctl?.signal?.aborted || e?.name === 'AbortError' || /abort/i.test(e?.message || '')) {
      aborted = true;
    } else {
      throw e;
    }
  }
  if (lineBuf) handleLine(lineBuf); // 末行没有换行（网关直接断流）时也要解析，否则 usage/内容丢
  if (aborted) return { content, reasoning, toolCalls: [], raw, aborted: true, usage, finishReason };
  if (repetitive) return { content, reasoning, toolCalls: [], raw, repetitive: true, usage, finishReason };
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
// 给了 contextWindow/maxOutputTokens 时走 token 两级压缩（与 runAgentTurn 内部同一套阈值）。
export function pruneConvo(list, config) {
  const hasWindow = Number(config?.contextWindow) > 0 || Number(config?.maxOutputTokens) > 0;
  if (hasWindow) {
    const budget = contextBudget(config);
    const tokens = estimateMessagesTokens(list);
    if (tokens < budget.microThreshold) return false;
    const microChanged = microcompact(list);
    if (tokens >= budget.fullThreshold) return fullCompact(list) || microChanged;
    return microChanged;
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
const PARALLEL_TOOLS = new Set(['read_file', 'read_playbook', 'probe_target', 'stress_target', 'review_diff']);

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
async function runToolCall(tc, tools, onEvent, signal = null, onToolLifecycle = null) {
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
    else result = await awaitWithAbort(Promise.resolve().then(() => fn(args, { signal })), signal);
  } catch (e) {
    result = { error: e?.message || String(e) };
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
      modelContent = `[结果过长 ${resultStr.length} 字符，已完整落盘]\n完整输出: ${spillFile || '(落盘失败)'}\n可用 run_command 在该文件上检索（findstr / Select-String），或用更小的参数重跑。\n--- 前 12000 字符 ---\n${head}\n--- 后 4000 字符 ---\n${tail}`;
      traceResult = { truncated: true, spillFile, chars: resultStr.length, preview: resultStr.slice(0, 2000) };
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
  return { id: tc?.id, trace: { tool: name, args: argsText, result: traceResult }, modelContent };
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

export async function runAgentTurn({ config, messages, confirmedHosts = [], onToken, onEvent, onToolLifecycle = null, onUsage = null, tools, toolsSchema = null, systemPrompt: systemPromptOverride = null, roleMode = 'audit', forceFirstToolChoice = false, fetchImpl = fetch, summarize, signal, maxTurns = DEFAULT_MAX_TURNS, maxTurnMs: maxTurnMsOpt, maxTurnTokens: maxTurnTokensOpt, retryBaseMs = 600, noLimits = false, hooksConfig = null, hooksRunner = null, sessionId = null, drainSteer = null, resolveConfig = null, cwd = process.cwd() }) {
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
  try {
    viewMessages = (await assembleContext(messages, {
      summarize,
      ...compactOpts
    })).messages;
    if (willCompact) onEvent?.({ kind: 'compact-end', scope: 'auto', before: beforeTokens, after: estimateMessagesTokens(viewMessages) });
  } catch (e) {
    if (willCompact) onEvent?.({ kind: 'compact-end', scope: 'auto', before: beforeTokens, error: e?.message || String(e) });
    /* 压缩失败不阻断对话 */
  }
  const convo = [{ role: 'system', content: String(systemPromptOverride != null ? systemPromptOverride : await getSystemPrompt(roleMode)) }, ...viewMessages];
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
  const compactNow = () => {
    if (compactFails >= 3) return; // 熔断后不再尝试
    // 进行中状态：这里的压缩是本地同步的两级裁剪，事件只用来让界面在需要时点亮「压缩中」
    // （渲染层有 120ms 延迟出现，瞬时压缩不会闪一下）；失败时同样要发 end，不能让界面一直转圈。
    let announced = false;
    let before = 0;
    try {
      const tokens = estimateMessagesTokens(convo);
      if (tokens >= tokenBudget.microThreshold) {
        before = tokens;
        announced = true;
        onEvent?.({ kind: 'compact-start', scope: 'auto', before });
        if (tokens >= tokenBudget.fullThreshold) {
          microcompact(convo); // 先清掉旧工具结果，降低正文压缩的切除量
          fullCompact(convo);  // 再把最老的成对 user/assistant 正文换成 [历史摘要]
        } else {
          microcompact(convo);
        }
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
  const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 5;
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
    compactNow(); // 每轮请求前按 token 做两级压缩，防 40 轮把网关上下文撑爆
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
          ...(liveConfig.reasoningEffort ? { reasoning_effort: liveConfig.reasoningEffort } : {})
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
            await sleepAbort(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
            continue;
          }
          onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
          if (res.status === 402) return { error: t('网关连接失败：{err}。{hint}。', { err: lastErr, hint: BILLING_HINT }), trace, warnings };
          return { error: t('网关连接失败：{err}{retry}。{checklist}', { err: lastErr, retry: attempt > 1 ? t('（已重试 {n} 次）', { n: attempt - 1 }) : '', checklist: CHECKLIST }), trace, warnings };
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
          await sleepAbort(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
          continue;
        }
        onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
        // 静默重试用尽：不返回栈，只给人话（网关一个字节都不回 ≠ 活干得久）
        if (silenceHit) return { error: t('{reason}（已重试 {n} 次）。{checklist}', { reason: SILENCE_REASON, n: MAX_ATTEMPTS, checklist: CHECKLIST }), trace, warnings };
        return { error: t('网关连接失败：{reason}（已重试 {n} 次）。{checklist}', { reason: retryReason, n: MAX_ATTEMPTS, checklist: CHECKLIST }), trace, warnings };
      }
      // 防御性兜底：既没拿到流也没失败原因（正常不可达）
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
      return { error: t('网关连接失败：{err}。{checklist}', { err: lastErr || t('未知错误'), checklist: CHECKLIST }), trace, warnings };
    }
    if (!streamOut) {
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
      return { error: t('网关连接失败：{err}。{checklist}', { err: lastErr || t('未知错误'), checklist: CHECKLIST }), trace, warnings };
    }
    let { content, reasoning, toolCalls, repetitive, aborted, usage, finishReason } = streamOut;
    if (usage) lastUsage = usage;
    addUsage(usage); // 累计（供工作流子代理按步记账）
    addTurnTokens(usage, content); // 软预算累计（prompt+completion）
    if (finishReason) lastFinishReason = finishReason;
    if (aborted || signal?.aborted) {
      // dsh 语义：中断≠删除——已流出的内容原样返回并落盘，正文标记「已中断」
      const partial = content || '';
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, interrupted: true });
      return { cancelled: true, interrupted: true, partialContent: partial, answer: partial, reasoning: reasoningAll || undefined, trace, workedMs: Date.now() - turnStart, roundsUsed: turnsUsed, usage: usage || lastUsage || undefined };
    }
    if (reasoning) reasoningAll += (reasoningAll ? '\n' : '') + reasoning;
    if (repetitive) {
      onEvent?.({ kind: 'turn-end', ms: Date.now() - turnStart, error: true });
      return { error: t('检测到模型输出异常循环，已自动中止——这是模型问题不是你的问题。可重试，或到模型设置换一个模型。'), reasoning: reasoningAll, trace, roundsUsed: turnsUsed };
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
    const toolResults = inspected.invalid.length
      ? await runToolCallsGuarded(toolCalls, inspected.invalid, {
        tools, onEvent, toolConcurrency: config.toolConcurrency, signal, onToolLifecycle,
        code: ARGS_INVALID_JSON_CODE
      })
      : await runToolCalls(toolCalls, { tools, onEvent, toolConcurrency: config.toolConcurrency, signal, onToolLifecycle });
    toolWaitMs += Date.now() - toolStartedAt;
    toolResults.forEach((r, index) => {
      const rep = repairedByIndex.get(index);
      if (rep) r.trace.repaired = rep.repairs;
      trace.push(r.trace);
      convo.push({ role: 'tool', tool_call_id: r.id, content: r.modelContent });
    });
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
  compactNow(); // 收尾请求同样守住上下文预算（token 两级压缩）
  const fbody = (withUsage) => JSON.stringify({
    model: liveConfig.model,
    messages: [...convo, wrap],
    stream: true,
    ...(withUsage ? { stream_options: { include_usage: true } } : {}),
    ...(liveConfig.reasoningEffort ? { reasoning_effort: liveConfig.reasoningEffort } : {})
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
        await sleepAbort(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
        continue;
      }
      if (attemptRes?.ok) { res = attemptRes; break; }
      ferr = `HTTP ${attemptRes?.status ?? '?'}`;
      if (attemptRes && RETRYABLE.has(attemptRes.status) && attempt < FINALIZE_ATTEMPTS) {
        onEvent?.({ kind: 'retry', attempt: attempt + 1, max: FINALIZE_ATTEMPTS, reason: t('收尾请求 {err}', { err: ferr }) });
        await sleepAbort(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
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
