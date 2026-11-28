// 0.34.7 手机打开会话的「瘦身版」：只给手机看，不改存档、不改电脑端。
// 实测（用户真实库）：最大的会话 179 条消息、2164 步工具，整份 7.6MB（gzip 后 2.2MB），
// 大头是工具结果 / 参数 / 每步思考和消息级 reasoning——这些在手机上只用来展开看，
// 发给模型的历史只用 content（renderer buildSendHistory 的 wire 只取 role+content），所以 content 一字不动。
// 规则：
//   · 工具 trace 的 result / args 里超过 STR_MAX 的字符串 → 保留头尾，中间写明省了多少字
//   · 每步 thought 截到 THOUGHT_MAX，消息 reasoning 截到 REASONING_MAX
//   · 界面要靠完整参数复原状态的工具（验收单、提问卡、产物、工作流、项目记忆）原样保留
//   · 最近 KEEP_FULL_TAIL 条消息原样保留（正在看的那几轮展开要完整）
export const STR_MAX = 900;
export const STR_HEAD = 600;
export const STR_TAIL = 200;
export const THOUGHT_MAX = 600;
export const REASONING_MAX = 1500;
export const KEEP_FULL_TAIL = 4;
const KEEP_TOOLS = new Set(['todo_write', 'ask_user', 'present_artifact', 'run_workflow', 'remember_project']);

function cutStr(s) {
  if (s.length <= STR_MAX) return s;
  return `${s.slice(0, STR_HEAD)}\n…（手机上省略 ${s.length - STR_HEAD - STR_TAIL} 字，完整内容在电脑上看）…\n${s.slice(-STR_TAIL)}`;
}

function cutDeep(v, depth = 0) {
  if (typeof v === 'string') return cutStr(v);
  if (depth > 8 || v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => cutDeep(x, depth + 1));
  if (Object.getPrototypeOf(v) !== Object.prototype) return v; // Buffer / Uint8Array 等原样交给编码层
  const out = {};
  for (const k of Object.keys(v)) out[k] = cutDeep(v[k], depth + 1);
  return out;
}

function slimTraceEntry(x) {
  if (!x || typeof x !== 'object') return x;
  if (KEEP_TOOLS.has(String(x.tool || x.name || ''))) return x;
  const o = { ...x };
  if ('result' in o) o.result = cutDeep(o.result);
  if ('args' in o) o.args = cutDeep(o.args);
  if ('output' in o) o.output = cutDeep(o.output);
  if (typeof o.thought === 'string' && o.thought.length > THOUGHT_MAX) o.thought = o.thought.slice(0, THOUGHT_MAX) + '…';
  return o;
}

/** 返回给手机的会话副本；原对象不改 */
export function slimSessionForPhone(session) {
  if (!session || !Array.isArray(session.messages)) return session;
  const n = session.messages.length;
  const messages = session.messages.map((m, i) => {
    if (!m || typeof m !== 'object' || i >= n - KEEP_FULL_TAIL) return m;
    const o = { ...m };
    if (typeof o.reasoning === 'string' && o.reasoning.length > REASONING_MAX) o.reasoning = o.reasoning.slice(0, REASONING_MAX) + '…';
    if (Array.isArray(o.trace)) o.trace = o.trace.map(slimTraceEntry);
    return o;
  });
  return { ...session, messages };
}
