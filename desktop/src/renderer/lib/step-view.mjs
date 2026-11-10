// 「这个节点有没有子代理对话」的判定：gate / aggregate 是程序直接执行的确定性节点，
// 面板不该去轮询 transcript（真实 bug：点门禁 chip 会转 18 秒然后说「上下文没有留下」）。
// 字段来源不统一：DSL 快照用 op（workflow-script.mjs），旧卡片/结果行可能用 opType、kind，
// 历史数据里还有一种只有 role='程序检查' 的行——这里一次收口，组件与测试共用。
export function isProgramStep(target) {
  if (!target || typeof target !== 'object') return false;
  const op = String(target.opType || target.op || '').toLowerCase();
  const kind = String(target.kind || '').toLowerCase();
  const role = String(target.role || '');
  return op === 'gate' || op === 'aggregate' || kind === 'gate' || role === '程序检查';
}
