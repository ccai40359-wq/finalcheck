// 子代理展示名（职位名）：把「步骤 1 / find」换成「注入面审查员」这类像人一样可读的职位。
// 纯函数、无 React 依赖（主进程 DAG、受限脚本 DSL 与渲染层共用），只依赖 i18n core 的 t()：
// 常量保持中文原文（词典 key），返回前过 t() —— 界面语言是 en 时得到英文职位名/标签。
// 选 t() 而不是 agentTitleFor(..., { lang }) 的原因：语言状态已经挂在 globalThis（core.mjs），
// 主进程与渲染层共享同一份；显式参数会让 6 个调用点各自传语言，容易漏传、且与 t() 的口径不一致。
//
// 命名优先级（agentTitleFor）：
//   ① 模型给的 name 已经是职位名（非空、≤20 字、不含「步骤/step」、不是纯英文 id）→ 原样用
//   ② 按 kind + prompt/goal/role 关键词推断（AGENT_TITLE_RULES，顺序即优先级）
//   ③ 按 kind 兜底（KIND_TITLES）
//   ④ 最终兜底「审查员」（有 index 时带 #N 后缀，绝不输出「步骤 N」）
//
// 为什么关键词要先看 prompt/goal/role 而不是 name：模型给的 name 常常是「排查」「分析」这种泛词，
// 真正的职责写在 prompt 里（「检查 SQL 注入」），所以②用的是拼起来的文本。
import { t } from '../renderer/i18n/core.mjs';

/** kind → 卡片上的中文小标签（英文枚举不许裸奔；查不到返回空串，UI 就不渲染该标签） */
export const AGENT_KIND_LABELS = Object.freeze({
  recon: '侦察',
  find: '取证',
  verify: '复核',
  arbitrate: '仲裁',
  report: '汇总',
  gate: '门禁',
  aggregate: '聚合',
  loop: '轮询',
  recurse: '递归',
  step: '执行',
  if: '分支',
  program: '程序',
});

/** kind → 兜底职位名（关键词都没命中时用） */
export const KIND_TITLES = Object.freeze({
  recon: '项目侦察员',
  find: '取证审查员',
  verify: '红队复核员',
  arbitrate: '争议仲裁员',
  report: '交付报告主编',
  gate: '程序校验员',
  aggregate: '程序校验员',
  loop: '轮次调度员',
  recurse: '递归调度员',
  if: '分支调度员',
  step: '审查员',
});

/**
 * 关键词 → 职位表（顺序即优先级：越靠前越具体）。
 * 放得越晚的规则越容易被误命中，所以「报告 / 复核」这种泛词排在最后。
 * @type {ReadonlyArray<{title: string, re: RegExp}>}
 */
export const AGENT_TITLE_RULES = Object.freeze([
  { title: '注入面审查员', re: /注入|sqli?|xss|csrf|ssrf|xxe|命令执行|rce|反序列化|模板注入|open\s*redirect/i },
  { title: '鉴权与越权审查员', re: /鉴权|认证|授权|越权|idor|权限|角色|jwt|session|会话|登录态|access\s*control|rbac/i },
  { title: '密钥与凭证审计员', re: /密钥|秘钥|凭证|credential|secret|api[\s_-]?key|环境变量|\.env\b|配置泄露|硬编码|泄露的?\s*(?:key|token)/i },
  { title: '供应链合规专员', re: /依赖|dependenc|cve\b|供应链|许可证|licen[cs]e|sbom|npm\s*audit|版本锁定/i },
  { title: '数据与隐私专员', re: /数据|备份|迁移|隐私|脱敏|加密|gdpr|pii\b/i },
  { title: '测试覆盖审查员', re: /测试|覆盖率|coverage|用例|unit\s*test|e2e\b|回归测试/i },
  { title: '性能分析员', re: /性能|慢查询|压测|n\s*\+\s*1|benchmark|延迟|吞吐|内存泄漏|qps/i },
  { title: '运维与可观测性专员', re: /日志|监控|告警|运维|发布|部署|deploy|rollback|回滚|可观测|observability|ci\/cd/i },
  { title: '代码可读性审查员', re: /可读性|复杂度|命名|重复代码|重构|readability|complexity|代码风格/i },
  { title: '项目侦察员', re: /架构|目录|入口|侦察|recon|技术栈|路由表|盘点/i },
  { title: '交付与交接专员', re: /交付|readme|交接|文档|docs?\b|handover|使用说明|说明书/i },
  { title: '交付报告主编', re: /报告|report|成稿|结论汇总/i },
  { title: '红队复核员', re: /复核|验证|verify|反驳|证伪|red\s*team|对抗/i },
  { title: '争议仲裁员', re: /仲裁|arbitrat|裁决|争议|分歧/i },
]);

/** 这些 name 是泛词/流程词，不配当职位名（模型最常见的偷懒写法） */
const GENERIC_NAMES = /^(?:分析|检查|执行|处理|任务|工作|步骤|流程|工作流|阶段|子代理|汇总|总结|审查|扫描|检测|验证|复核|初稿|草稿|todo|step|task|agent|workflow|subagent|check|scan|review|report|find|verify|verify-step)[\s:：#0-9]*$/i;

export const TITLE_MAX = 20;
const NAME_SLICE = 60;

const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

/** 模型给的名字能不能直接当职位名用 */
export function isRoleLikeName(name) {
  const n = str(name);
  if (!n) return false;
  if (n.length > TITLE_MAX) return false;
  if (/步骤|step/i.test(n)) return false;
  if (GENERIC_NAMES.test(n)) return false;
  // 纯英文/编号 id（find、s1、verify-2）不是职位名：交给关键词与 kind 推断
  if (!/[\u4e00-\u9fa5]/.test(n)) return false;
  return true;
}

function clip(text) {
  const s = str(text);
  return s.length > NAME_SLICE ? s.slice(0, NAME_SLICE) : s;
}

/**
 * 生成一个子代理的展示职位名。
 *
 * @param {object} [input]
 * @param {string|null} [input.name] 模型给的原始 name（可为空/为「步骤 1」）
 * @param {string|null} [input.kind] swarm 协议角色（recon/find/verify/arbitrate/report…）
 * @param {string|null} [input.prompt] 该步骤的任务描述
 * @param {string|null} [input.goal] 整个工作流的目标（步骤本身信息不足时用来兜）
 * @param {number|null} [input.index] 1 起的序号；只有落到兜底名时才作为 #N 后缀
 * @param {string|null} [input.role] 角色说明
 * @returns {string} 职位名（中文；永不为空、永不是「步骤 N」）
 */
export function agentTitleFor({ name = '', kind = null, prompt = '', goal = '', index = null, role = '' } = {}) {
  const given = str(name);
  // ① 模型已经给了像样的职位名：原样保留（只做长度裁剪）
  if (isRoleLikeName(given)) return clip(given);
  const k = str(kind).toLowerCase();
  // 报告节点的 prompt 里必然出现「报告」，关键词会被它带偏：直接落到主编
  if (k === 'report') return t(KIND_TITLES.report);
  // ② 关键词推断（prompt 是主信号，其次 goal/role；原始 name 也拼上，泛词命中也比「步骤 N」强）
  const haystack = [prompt, goal, role, given].map(str).filter(Boolean).join('\n');
  if (haystack) {
    for (const rule of AGENT_TITLE_RULES) {
      if (rule.re.test(haystack)) return t(rule.title);
    }
  }
  // ③ kind 兜底
  if (KIND_TITLES[k]) return t(KIND_TITLES[k]);
  // ④ 最终兜底：没有更好信息时才把序号当后缀
  const n = Number(index);
  const fallback = t('审查员');
  return Number.isInteger(n) && n > 0 ? `${fallback} #${n}` : fallback;
}

const ROLE_NOUN_RE = /(审查员|审计员|专员|分析员|侦察员|主编|仲裁员|复核员|校验员|调度员)$/;
// 英文职位名词（en 界面下 baseTitle 已是英文，长名同样只保留名词部分）
const ROLE_NOUN_RE_EN = /(Reviewer|Auditor|Specialist|Officer|Analyst|Scout|Editor|Arbitrator|Coordinator)$/;
const FANOUT_TITLE_MAX = 28;

/** 扇出项本身有没有信息量（空 / 纯序号 / 单个符号都不算） */
function hasSubject(item) {
  const s = str(item);
  if (!s) return false;
  if (!/[\p{L}\p{N}]/u.test(s)) return false;
  return !/^[\d\s._-]+$/.test(s);
}

/**
 * fanout 子节点名字：把扇出项当修饰语 + 容器职位名，例如
 *   base「鉴权与越权审查员」+ item「/api/login」 → 「/api/login 鉴权与越权审查员」
 *   base「路由审查员」     + item「/api/login」 → 「/api/login 路由审查员」
 *   base「注入面审查员」   + item 为空/纯序号   → 「注入面审查员 #3」
 * 优先「读得懂 + 短」：扇出项超过 16 字截断，整名不超过 28 字（卡片一行放得下）。
 * 只做展示，参与 scriptOp 的仍是原始 op（断点指纹不受影响）。
 *
 * @param {{baseTitle?: string, item?: any, index?: number|null}} [input]
 * @returns {string}
 */
export function agentTitleForFanout({ baseTitle = '', item = '', index = null } = {}) {
  const base = clip(str(baseTitle) || t('审查员'));
  if (!hasSubject(item)) {
    const n = Number(index);
    return Number.isInteger(n) && n >= 0 ? clip(`${base} #${n + 1}`) : base;
  }
  const raw = str(item).replace(/\s+/g, ' ');
  const subject = raw.length > 16 ? `${raw.slice(0, 15)}…` : raw;
  const title = `${subject} ${base}`;
  if (title.length <= FANOUT_TITLE_MAX) return title;
  // 太长：先砍修饰语里冗余的「与」字长名，只留职位名词（如「鉴权与越权审查员」→「审查员」）
  const noun = (base.match(ROLE_NOUN_RE) || base.match(ROLE_NOUN_RE_EN) || [])[1] || '';
  return clip(noun ? `${subject} ${noun}` : title);
}

/**
 * kind 的小标签（卡片副标题用）。未知 kind 返回空串——宁可什么都不显示，也不让英文枚举裸奔。
 * 返回值按当前界面语言取词典：zh 原样返回中文，en 返回英文标签。
 * @param {string|null|undefined} kind
 * @returns {string}
 */
export function agentKindLabel(kind) {
  const k = str(kind).toLowerCase();
  if (!k) return '';
  return AGENT_KIND_LABELS[k] ? t(AGENT_KIND_LABELS[k]) : '';
}
