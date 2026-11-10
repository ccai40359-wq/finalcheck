// 回合中途向用户提问（ask_user）的主进程侧：pending 台账 + Promise 等待。
// 语义（与 permissions 审批不同）：
// - 没有超时自动选择：用户不回答就永远等待（停止回合是唯一出口）；
// - 用户点停止 → cancelSession/cancelAll 立即 resolve 为「用户取消」；
// - 主 agent 每个回合最多问 3 次；第 4 次直接拒绝（不挂 pending、不弹卡）；
// - pending 只在内存里：App 重启后历史卡由 tool part（running/无结果）还原成「未回答（已失效）」。
import { randomUUID } from 'node:crypto';
import { t } from '../renderer/i18n/core.mjs';
import { ASK_USER_MAX_PER_TURN, formatAskAnswer, parseAskArgs } from '../renderer/lib/ask-user.mjs';

const sessionKey = (sessionId) => (sessionId == null ? '' : String(sessionId));

/**
 * @param {{emit?: (payload:any)=>void, maxPerTurn?: number, now?: ()=>number}} [opts]
 */
export function createAskUserRegistry({ emit = null, maxPerTurn = ASK_USER_MAX_PER_TURN, now = () => Date.now() } = {}) {
  // callId → { callId, sessionId, question, options, multiSelect, askedAt, settled, resolve, signal, onAbort }
  const pending = new Map();
  const counts = new Map(); // sessionKey → 本回合已提问次数

  function cleanup(entry) {
    if (entry?.onAbort && entry.signal) {
      try { entry.signal.removeEventListener('abort', entry.onAbort); } catch { /* 忽略 */ }
    }
    entry.onAbort = null;
  }

  function finish(entry, value) {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    cleanup(entry);
    if (pending.get(entry.callId) === entry) pending.delete(entry.callId);
    entry.resolve(value);
    return true;
  }

  /** 新回合开始：重置该会话的提问计数（不改 pending：新回合不应该还有旧 pending） */
  function beginTurn(sessionId) {
    counts.set(sessionKey(sessionId), 0);
  }

  /** 回合结束：清计数，并把仍挂着的 pending 按「用户取消」收尾（防孤儿 Promise） */
  function endTurn(sessionId) {
    const key = sessionKey(sessionId);
    counts.delete(key);
    cancelSession(sessionId);
  }

  /**
   * 发起一次提问并等待回答。返回值就是工具结果：
   * - 正常回答：{ answer }
   * - 用户停止/取消：{ error: '用户取消', cancelled: true }
   * - 参数错误 / 次数超限 / 无 UI 通道：{ error }
   */
  async function ask(input = {}) {
    const norm = parseAskArgs(input);
    if (!norm.question) return { error: t('提问内容不能为空') };
    const sessionId = input?.sessionId ?? null;
    const key = sessionKey(sessionId);
    const used = counts.get(key) || 0;
    if (used >= maxPerTurn) return { error: t('本次回合提问次数已达上限') };
    if (typeof emit !== 'function') return { error: t('没有可用的界面通道，无法向用户提问') };
    counts.set(key, used + 1);

    const callId = `ask-${randomUUID()}`;
    const payload = {
      callId,
      question: norm.question,
      options: norm.options,
      multiSelect: norm.multiSelect,
      ...(sessionId == null ? {} : { sessionId }),
      askedAt: now()
    };
    return new Promise((resolve) => {
      const entry = {
        ...payload,
        settled: false,
        resolve,
        signal: input?.signal || null,
        onAbort: null
      };
      const onAbort = () => { finish(entry, { error: t('用户取消'), cancelled: true }); };
      entry.onAbort = onAbort;
      if (entry.signal) {
        if (entry.signal.aborted) {
          // 已经中断：不再弹卡，直接按取消返回
          entry.settled = true;
          entry.onAbort = null;
          resolve({ error: t('用户取消'), cancelled: true });
          return;
        }
        try { entry.signal.addEventListener('abort', onAbort, { once: true }); } catch { /* 忽略 */ }
      }
      pending.set(callId, entry);
      try {
        emit(payload);
      } catch (e) {
        finish(entry, { error: t('向用户提问失败：{error}', { error: e?.message || e }) });
      }
    });
  }

  /**
   * 渲染层回填回答。兼容两种形状：
   * - { callId, answer }
   * - { callId, selected: [...], text }
   * @returns {{ok:true, callId:string, answer:string} | {ok:false, error:string}}
   */
  function answer(input = {}) {
    const callId = String(input?.callId ?? '');
    const entry = pending.get(callId);
    if (!entry) return { ok: false, error: t('该提问已失效') };
    const answerText = formatAskAnswer(input);
    if (!answerText) return { ok: false, error: t('回答不能为空') };
    finish(entry, { answer: answerText });
    return { ok: true, callId, answer: answerText };
  }

  /** 用户停止某会话：该会话所有 pending 立即 resolve 为取消 */
  function cancelSession(sessionId) {
    const key = sessionKey(sessionId);
    let n = 0;
    for (const entry of [...pending.values()]) {
      if (sessionKey(entry.sessionId) !== key) continue;
      if (finish(entry, { error: t('用户取消'), cancelled: true })) n += 1;
    }
    return n;
  }

  /** 用户停止全部会话（停止按钮没带 sessionId / 应用退出前的兜底） */
  function cancelAll() {
    let n = 0;
    for (const entry of [...pending.values()]) {
      if (finish(entry, { error: t('用户取消'), cancelled: true })) n += 1;
    }
    return n;
  }

  /** 测试/诊断：当前挂起的提问快照 */
  function listPending() {
    return [...pending.values()].map((e) => ({
      callId: e.callId,
      sessionId: e.sessionId ?? null,
      question: e.question,
      options: e.options,
      multiSelect: e.multiSelect,
      askedAt: e.askedAt
    }));
  }

  function pendingCount(sessionId = undefined) {
    if (sessionId === undefined) return pending.size;
    const key = sessionKey(sessionId);
    return [...pending.values()].filter((e) => sessionKey(e.sessionId) === key).length;
  }

  return { ask, answer, beginTurn, endTurn, cancelSession, cancelAll, listPending, pendingCount };
}
