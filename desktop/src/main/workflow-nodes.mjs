// @ts-check
// 统一工作流写法（0.26）：一张流程图，只有一条规则——depends_on 决定谁等谁，互不依赖的节点一起跑。
//
// 以前有两套写法：steps（DAG：depends_on 决定顺序、并行）和 script（DSL：按数组顺序执行，
// depends_on 只决定把谁的结果塞进 prompt、不管顺序），模型和人都要先判断「任务形状」再二选一，
// 同一个词在两边意思还不一样，经常混。现在只有 nodes：
//   - 普通节点（默认 type=agent）：一个独立上下文的子代理；
//   - 特殊节点：fanout（按清单分身）、gate（程序闸，不调模型）、verify（盲验）、report（交付报告）、
//     aggregate（纯计算汇总）、loop（转圈直到满足条件）、if（条件分支）。
// 引擎不变：全是普通节点 → 交给原 DAG 引擎（workflow.mjs，久经实测）；含特殊节点 → 编译成 DSL 指令，
// 由 DSL 解释器按依赖图并行调度（workflow-script.mjs 的 dag 模式）。旧的 steps / script 参数照常可用。

export const NODE_TYPES = ['agent', 'fanout', 'gate', 'verify', 'report', 'aggregate', 'loop', 'if'];
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
// 节点里可能引用别的节点的字段（引用即依赖：要等它跑完）
const REF_FIELDS = ['from'];
const WHEN_FIELDS = ['when', 'until', 'stopWhen'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v).trim());
const typeOf = (n) => {
  const t = str(n?.type || n?.op).toLowerCase();
  if (!t || t === 'step' || t === 'agent') return 'agent';
  return t;
};

/** 引用写法 → 被引用的顶层节点 id（fanout 子节点 a#0、分支节点 a.then.0 都归到 a） */
const baseRef = (ref) => str(ref).split(/[#.]/)[0];

/** prompt 里的 ${节点id.content} 也是引用 */
function promptRefs(text) {
  const out = [];
  const re = /\$\{([A-Za-z0-9_-]{1,32})(?:[#.][^}]*)?\}/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1]);
  return out;
}

/** 一个节点隐含依赖的所有节点 id（depends_on ∪ over/from/when/until 引用 ∪ prompt 插值） */
export function nodeRefs(node) {
  const refs = new Set();
  for (const d of Array.isArray(node?.depends_on) ? node.depends_on : []) refs.add(baseRef(d));
  if (typeof node?.over === 'string') refs.add(baseRef(node.over));
  for (const f of REF_FIELDS) {
    const v = node?.[f];
    for (const r of Array.isArray(v) ? v : (v ? [v] : [])) refs.add(baseRef(r));
  }
  for (const f of WHEN_FIELDS) if (isObj(node?.[f]) && node[f].ref) refs.add(baseRef(node[f].ref));
  for (const r of promptRefs(node?.prompt)) refs.add(r);
  if (isObj(node?.step)) for (const r of promptRefs(node.step.prompt)) refs.add(r);
  refs.delete('');
  return [...refs];
}

/** 分支 / 循环体里的节点引用（只用来找它们对顶层节点的依赖） */
function nestedRefs(node) {
  const out = new Set();
  for (const k of ['then', 'else', 'body']) {
    for (const child of Array.isArray(node?.[k]) ? node[k] : []) {
      for (const r of nodeRefs(child)) out.add(r);
      for (const r of nestedRefs(child)) out.add(r);
    }
  }
  return out;
}

/** 节点 → DSL 指令（分支 / 循环体递归转换；体内仍按数组顺序执行） */
function toOp(node) {
  const type = typeOf(node);
  const { type: _t, op: _o, then, else: els, body, ...rest } = node;
  const op = { op: type === 'agent' ? 'step' : type, ...rest };
  if (Array.isArray(then)) op.then = then.map(toOp);
  if (Array.isArray(els)) op.else = els.map(toOp);
  if (Array.isArray(body)) op.body = body.map(toOp);
  return op;
}

/** 节点 → DAG 引擎的 step（字段原样，去掉 type） */
function toStep(node) {
  const { type: _t, op: _o, ...rest } = node;
  return rest;
}

/**
 * 编译 nodes。
 * @param {any} nodes
 * @returns {{ error: string } | { mode: 'steps', steps: any[], order: string[] } | { mode: 'script', script: any[], dag: { deps: Record<string, string[]> }, order: string[] }}
 */
export function compileNodes(nodes) {
  let list = nodes;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return { error: 'nodes 必须是数组：JSON 解析失败' }; }
  }
  if (!Array.isArray(list) || !list.length) return { error: 'nodes 不能为空：至少 1 个节点' };
  const byId = new Map();
  for (const [i, n] of list.entries()) {
    if (!isObj(n)) return { error: `第 ${i + 1} 个节点不是对象` };
    const id = str(n.id);
    if (!ID_RE.test(id)) return { error: `第 ${i + 1} 个节点的 id「${id}」不合法（只能字母数字-_，最长 32）` };
    if (byId.has(id)) return { error: `节点 id 重复：${id}` };
    const type = typeOf(n);
    if (!NODE_TYPES.includes(type)) return { error: `节点 ${id} 的 type「${type}」不认识；可用：${NODE_TYPES.join(' / ')}` };
    if (n.depends_on != null && !Array.isArray(n.depends_on)) return { error: `节点 ${id} 的 depends_on 必须是数组` };
    byId.set(id, n);
  }
  // 依赖（显式 + 隐式引用）只认顶层节点；引用不存在的节点直接报错（以前 DSL 会在运行到那一步才炸）
  const deps = new Map();
  for (const [id, n] of byId) {
    const refs = nodeRefs(n).filter((r) => r !== id);
    const missing = refs.filter((r) => !byId.has(r));
    // fanout 的 as 变量（${item}）不是节点引用
    const asName = str(n.as || n?.step?.as);
    const realMissing = missing.filter((r) => r !== asName);
    if (realMissing.length) return { error: `节点 ${id} 依赖/引用了不存在的节点：${realMissing.join('、')}` };
    if (Array.isArray(n.depends_on) && n.depends_on.map(baseRef).includes(id)) return { error: `节点 ${id} 不能依赖自己` };
    // 分支 / 循环体里引用的顶层节点也要先跑完（体内自己定义的节点由 DSL 解释器校验）
    const nested = [...nestedRefs(n)].filter((r) => byId.has(r) && r !== id);
    deps.set(id, [...new Set([...refs.filter((r) => byId.has(r)), ...nested])]);
  }
  // 拓扑排序（Kahn，同层保持原顺序）；成环直接报错并指出环
  const order = [];
  const indeg = new Map([...byId.keys()].map((id) => [id, deps.get(id).length]));
  const ready = [...byId.keys()].filter((id) => indeg.get(id) === 0);
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const [other, ds] of deps) {
      if (!ds.includes(id)) continue;
      indeg.set(other, indeg.get(other) - 1);
      if (indeg.get(other) === 0) ready.push(other);
    }
  }
  if (order.length < byId.size) {
    const stuck = [...byId.keys()].filter((id) => !order.includes(id));
    return { error: `依赖成环，跑不起来：${stuck.join(' → ')}（检查这些节点的 depends_on / from / over）` };
  }
  const allAgent = [...byId.values()].every((n) => typeOf(n) === 'agent');
  if (allAgent) {
    // 普通节点：显式 depends_on 加上 prompt 里的 ${x.content} 引用，交给原 DAG 引擎
    const steps = order.map((id) => {
      const s = toStep(byId.get(id));
      return { ...s, depends_on: deps.get(id) };
    });
    return { mode: 'steps', steps, order };
  }
  const script = order.map((id) => toOp(byId.get(id)));
  const depObj = {};
  for (const id of order) depObj[id] = deps.get(id);
  return { mode: 'script', script, dag: { deps: depObj }, order };
}

/** 给工作流卡/模型看的一句话：这张图怎么跑 */
export function describeNodes(compiled) {
  if (!compiled || 'error' in compiled) return '';
  const n = compiled.order.length;
  if (compiled.mode === 'steps') return `${n} 个子代理，按依赖并行`;
  return `${n} 个节点（含扇出/闸/循环等特殊节点），按依赖并行`;
}
