// 验收单（todo_write）的主进程侧：按会话保存最新一份清单 + 回合边界重置。
// 语义：
// - 只有主 agent 注册（子代理 schema 不含 todo_write，见 agent-service 的 AGENT_ONLY_TOOLS_SCHEMA）；
// - 一次回合内可多次调用：按 id 合并，evidence 不被「只改状态」的第二次调用冲掉；
// - 台账只在内存里：卡片本身由 tool part（args）落库，重开会话从 trace 还原，不改会话 schema；
// - 回合结束时由 ipc-agent 用 list(sessionId) 跑报告闸（lintTodoReport）。
import { mergeTodoItems, todoProgress, validateTodoItems } from '../renderer/lib/todo.mjs';

const sessionKey = (sessionId) => (sessionId == null ? '' : String(sessionId));

/**
 * @returns {{
 *   beginTurn: (sessionId?: any) => void,
 *   write: (sessionId: any, args?: any) => {ok:true, items:any[], progress:any} | {ok:false, error:string},
 *   list: (sessionId?: any) => any[],
 *   clear: (sessionId?: any) => void
 * }}
 */
export function createTodoRegistry() {
  const bySession = new Map();

  /** 新回合开始：清掉上一回合的清单（报告闸只判本回合的验收单） */
  function beginTurn(sessionId) {
    bySession.delete(sessionKey(sessionId));
  }

  /**
   * 工具实现：校验 → 与上一版按 id 合并 → 记账。
   * 返回值直接进模型上下文（清单回显 + 进度），让模型知道下一步该改哪条。
   */
  function write(sessionId, args) {
    const checked = validateTodoItems(args?.items);
    if (!checked.ok) return { ok: false, error: checked.error };
    const key = sessionKey(sessionId);
    const items = mergeTodoItems(bySession.get(key) || [], checked.items);
    bySession.set(key, items);
    return { ok: true, items, progress: todoProgress(items) };
  }

  function list(sessionId) {
    return bySession.get(sessionKey(sessionId)) || [];
  }

  function clear(sessionId) {
    bySession.delete(sessionKey(sessionId));
  }

  return { beginTurn, write, list, clear };
}
