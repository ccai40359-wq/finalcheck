// 「这个节点有没有子代理对话」的判定：gate / aggregate 是程序直接执行的确定性节点，
// 面板不该去轮询 transcript（真实 bug：点门禁 chip 会转 18 秒然后说「上下文没有留下」）。
// 字段来源不统一：DSL 快照用 op（workflow-script.mjs），旧卡片/结果行可能用 opType、kind，
// 历史数据里还有一种只有 role='程序检查' 的行——这里一次收口，组件与测试共用。
import { agentTitleFor } from '../../main/agent-titles.mjs';

export function isProgramStep(target) {
  if (!target || typeof target !== 'object') return false;
  const op = String(target.opType || target.op || '').toLowerCase();
  const kind = String(target.kind || '').toLowerCase();
  const role = String(target.role || '');
  return op === 'gate' || op === 'aggregate' || kind === 'gate' || role === '程序检查';
}

/** 引擎旧兜底名（「步骤 1」「验证 1.0」「程序 2」）：不是职位名，卡片上不直接展示 */
export function isIndexName(name) {
  return /^(?:步骤|step|程序|循环|递归|分支|汇总|验证)\s*#?\s*[\d.]+$/i.test(String(name || '').trim());
}

/**
 * 卡片主标题：职位名优先。
 * 老会话/老结果里存的是「步骤 1」——渲染时按 kind/role 补一个职位名，
 * 不让序号名继续露在界面上（新运行的 name 已经是引擎生成好的职位名）。
 * @param {{name?:string|null, kind?:string|null, role?:string|null, op?:string|null, opType?:string|null}} [step]
 * @returns {string}
 */
export function stepDisplayName(step = {}) {
  const name = String(step?.name || '').trim();
  if (name && !isIndexName(name)) return name;
  if (isProgramStep(step)) return '程序校验员';
  const title = agentTitleFor({ name, kind: step?.kind, role: step?.role });
  return title || name;
}
