// 手动 /compact（0.27 从 ipc-workspace 移过来：不依赖 Electron，桌面端和测试台同一份）。
//
// 和自动压缩走同一个核心（compact.mjs）：
//   - 压缩材料是「上一份边界 + 之后的完整过程」（含每一轮的工具调用和结果），不再只拼最终回答；
//   - 一次请求写完交接摘要，不再分块摘要再合并；
//   - 用户原话原样保留，最近碰过的文件从磁盘重读，完整过程写成文件供 read_file 查。
// 进行中 / 结束各推一个事件给渲染层（只用于显示「正在压缩上下文…」）。
import * as sessions from '../sessions.mjs';
import { t } from '../../renderer/i18n/core.mjs';
import { compactZone, BOUNDARY_HEAD } from '../compact.mjs';
import { turnToolMessages } from '../full-history.mjs';
import { resolveModel, effectiveWindow } from '../model-config.mjs';
import { estimateMessagesTokens } from '../context.mjs';

export const COMPACT_REQUEST_TIMEOUT_MS = 240000;
export const COMPACT_MAX_TOKENS = 16000;

/** 转写模式下，转写能占多少 token：窗口减掉指令 / 输出 / 余量，再打七折（估算有误差）。 */
export function transcriptTokensFor(window) {
  const w = Number(window) > 0 ? Number(window) : 200000;
  return Math.max(20000, Math.floor((w - COMPACT_MAX_TOKENS - 24000) * 0.7));
}

/** 库里的会话 → 压缩区（上一份摘要 + 之后的消息，assistant 前面展开它的工具过程）。 */
export function zoneFromSession(s) {
  const prevCut = s?.summary ? (Number(s.summaryAt) || 0) : 0;
  const included = (s?.messages || []).filter((m) => (m.role === 'user' || m.role === 'assistant')
    && !(prevCut > 0 && Number.isFinite(Number(m?.at)) && Number(m.at) < prevCut));
  const zone = [];
  if (prevCut > 0) {
    const sum = String(s.summary);
    zone.push({ role: 'user', content: sum.startsWith(BOUNDARY_HEAD) ? sum : `[此前对话摘要]\n${sum}` });
  }
  for (const m of included) {
    if (m.role === 'assistant') zone.push(...turnToolMessages(m.trace));
    zone.push({ role: m.role, content: String(m.content || '') });
  }
  const lastAt = included.reduce((mx, m) => Math.max(mx, Number(m?.at) || 0), 0);
  return { zone, included, prevCut, lastAt };
}

export function registerCompactIpc({ ipcMain, getWin, store, sessionProjectPathOf = () => '', sessionUsage = null }) {
  const compactAborts = new Map(); // sessionId → AbortController（正在跑的手动压缩，供「停止」中断）
  // 0.31.2 P0：压缩后必须作废「上一次请求的实测用量」。
  // 实测（prompt_tokens）是压缩**之前**那一次请求的真实值，压缩把历史换成了摘要之后它已经毫无意义；
  // 而 UI 面板优先显示实测值（`measured.prompt`），所以压缩完面板会一直停在旧的大数字上——
  // 用户看到「压缩提示写 908451 → 16411，面板却纹丝不动」就是这么来的。
  // 清掉之后面板回落到按估算算出的真实口径，下一次请求再补上新的实测值。
  const invalidateMeasured = async (sessionId) => {
    const key = String(sessionId ?? '');
    if (!key) return;
    try { sessionUsage?.delete?.(key); } catch { /* 内存表不可用 */ }
    try { await sessions.setSessionUsage(key, null); } catch { /* 落盘失败不影响压缩结果 */ }
  };
  const emitCompact = (sessionId, ev) => {
    try { getWin()?.webContents.send('finalcheck:agent-event', { sessionId, ev }); } catch { /* 窗口已关也继续压缩 */ }
  };
  ipcMain.handle('finalcheck:compact-cancel', (_e, sessionId) => {
    const ctl = compactAborts.get(String(sessionId ?? ''));
    if (!ctl) return { ok: false };
    ctl.abort();
    return { ok: true };
  });
  ipcMain.handle('finalcheck:compact-session', async (_e, sessionId) => {
    const cfg = await store.loadConfig();
    const prov = store.pickActiveProvider(cfg);
    if (!prov) return { error: t('尚未配置模型供应商') };
    const s = await sessions.loadSession(sessionId);
    const { zone, included, prevCut, lastAt } = zoneFromSession(s);
    if (!included.length) return { error: t('没有可压缩的对话') };
    // 切分点 = 摘要实际覆盖到的最后一条消息时间 + 1（压缩期间新到的消息不在摘要里，必须留在历史里）
    const cutAt = lastAt > 0 ? lastAt + 1 : (prevCut > 0 ? prevCut : Date.now());
    const ids = store.modelIdsOf ? store.modelIdsOf(prov) : [];
    const mc = s.modelConfig || {};
    const model = (mc.model && ids.includes(mc.model)) ? mc.model : ((cfg.activeModel && ids.includes(cfg.activeModel)) ? cfg.activeModel : ids[0]);
    const window = effectiveWindow(resolveModel(prov, model), prov);
    const before = estimateMessagesTokens(zone);
    const key = String(sessionId ?? '');
    const ctl = new AbortController();
    compactAborts.set(key, ctl);
    emitCompact(sessionId, { kind: 'compact-start', scope: 'manual', before });
    try {
      let projectPath = '';
      try { projectPath = sessionProjectPathOf(sessionId) || ''; } catch { /* 找不到项目就不重读文件 */ }
      const r = await compactZone({
        zone,
        summarizeText: (prompt) => store.summarizeWithProvider(prov, prompt, { signal: ctl.signal, raw: true, model, maxTokens: COMPACT_MAX_TOKENS, requestTimeoutMs: COMPACT_REQUEST_TIMEOUT_MS }),
        projectPath,
        spillDir: process.env.FINALCHECK_SPILL_DIR || '',
        transcriptTokens: transcriptTokensFor(window),
        restoreChars: Math.min(60000, Math.max(8000, Math.floor(window * 0.4)))
      });
      if (ctl.signal.aborted) throw new Error('aborted');
      // 模型摘要失败（只剩本地兜底）就不要写进去替换原文：报错，让用户决定重试
      if (r.via === 'local') throw new Error(r.error || t('模型没有返回摘要'));
      await sessions.saveSummary(sessionId, r.content, { cutAt });
      const after = estimateMessagesTokens([{ role: 'user', content: r.content }]);
      // 压缩成功 → 旧实测值作废（否则面板一直显示压缩前的 prompt_tokens）
      await invalidateMeasured(sessionId);
      await sessions.appendNotice(sessionId, t('上下文已压缩：约 {before} token → {after} token（交接摘要 + 用户原话 + 重新读取的文件）；后续请求带它 + 压缩之后新增的全部消息。', { before, after }), 'compact');
      emitCompact(sessionId, { kind: 'compact-end', scope: 'manual', before, after, invalidateMeasured: true });
      return { ok: true, summary: r.summary, before, after, transcriptFile: r.transcriptFile };
    } catch (e) {
      if (ctl.signal.aborted) {
        emitCompact(sessionId, { kind: 'compact-end', scope: 'manual', before, cancelled: true });
        return { cancelled: true };
      }
      emitCompact(sessionId, { kind: 'compact-end', scope: 'manual', before, error: e?.message || String(e) });
      // reason：给渲染层的短原因（事件里已带原文，界面用 reason 拼「压缩失败：…」，避免前缀重复）
      return { error: t('压缩失败：{msg}', { msg: e.message }), reason: e?.message || String(e) };
    } finally {
      if (compactAborts.get(key) === ctl) compactAborts.delete(key);
    }
  });
}
