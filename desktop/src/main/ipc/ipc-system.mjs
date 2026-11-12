import * as permissions from '../permissions.mjs';
import { recordProbe, recordStress } from '../dynamic-evidence.mjs';
import * as sessions from '../sessions.mjs';
import { runHookEvent } from '../hooks.mjs';
import { resolveModel, effectiveWindow } from '../model-config.mjs';
import { t } from '../../renderer/i18n/core.mjs';

// 粗略 token 估算：CJK 1 字≈1 token，其他 4 字符≈1 token；图片按 1200 token/张
const estTokens = (s) => {
  const text = String(s ?? '');
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
};
const contentTokens = (m) => {
  const c = m?.content;
  if (Array.isArray(c)) return c.reduce((n, p) => n + (p?.type === 'text' ? estTokens(p.text) : p?.type === 'image_url' ? 1200 : 0), 0);
  return estTokens(c);
};

export function registerSystemIpc({ ipcMain, getWin, engineUrl, store, getHooksConfig, sessionProjectPathOf, sessionUsage }) {
  // 输入框 Context 指示器：按当前会话 + 系统提示 + 工具 schema + 技能目录估算
  ipcMain.handle('finalcheck:context:stats', async (_e, payload = {}) => {
    const cfg = await store.loadConfig();
    let sess = null;
    if (payload.sessionId) {
      try { sess = await sessions.loadSession(payload.sessionId); } catch { /* 会话不存在/损坏 */ }
    }
    // 上下文上限跟会话自己的供应商走（不同供应商窗口不同）；没有才回落到全局启用项
    const sessProv = sess?.modelConfig?.providerId
      ? (cfg.providers || []).find((p) => p.id === sess.modelConfig.providerId)
      : null;
    const prov = sessProv || store.pickActiveProvider(cfg);
    // 窗口按会话当前模型的配置走（model > provider > 1M）；不再只认全局 provider
    const windowTokens = effectiveWindow(resolveModel(prov, sess?.modelConfig?.model), prov);
    const { TOOLS_SCHEMA, getSystemPromptParts } = await import(engineUrl('desktop/src/main/agent-service.mjs'));
    const parts = await getSystemPromptParts();
    let messagesTokens = 0;
    let metaTokens = 0;
    for (const m of payload.messages || []) {
      if (m?.role === 'system') metaTokens += contentTokens(m);
      else messagesTokens += contentTokens(m);
    }
    if (sess?.summary) metaTokens += estTokens('[此前对话摘要]\n' + sess.summary);
    const breakdown = {
      messages: messagesTokens,
      systemTools: estTokens(JSON.stringify(TOOLS_SCHEMA)),
      mcpTools: 0,
      metaContext: metaTokens,
      skills: estTokens(parts.skills),
      systemPrompt: estTokens(parts.base)
    };
    const used = Object.values(breakdown).reduce((a, b) => a + b, 0);
    // 实测/缓存命中只认这个会话自己的记录；内存没有就回退到会话 JSON 持久化的 usage
    const isUsageRec = (u) => !!u && typeof u === 'object' && typeof u.prompt === 'number' && Number.isFinite(u.prompt);
    const memUsage = payload.sessionId ? sessionUsage.get(payload.sessionId) : null;
    const measured = isUsageRec(memUsage) ? memUsage : (isUsageRec(sess?.usage) ? sess.usage : null);
    return {
      window: windowTokens,
      used,
      percent: Math.min(100, (used / windowTokens) * 100),
      measured: measured || null, // 本会话最后一次请求的真实 prompt_tokens
      breakdown,
      cacheHit: measured?.cacheHit ?? null // 没有实测就是 null（UI 显示网关未返回），不回退全局
    };
  });
  ipcMain.handle('finalcheck:audit', async (_e, dir, opts = {}) => {
    const { audit } = await import(engineUrl('src/audit.mjs'));
    // 终审 P1#1：runTests 主进程硬编码 false——audit IPC 可能指向不可信项目，禁跑其代码（§7）
    return audit(dir, { tier: opts.tier ?? null, interactive: opts.interactive ?? true, runTests: false });
  });
  ipcMain.handle('finalcheck:scan-download', async (_e, dir) => {
    const { scanDownload } = await import(engineUrl('src/download-gate.mjs'));
    return scanDownload(dir, { excludes: [] });
  });
  ipcMain.handle('finalcheck:skills:list', async () => {
    const { loadCatalog, catalogSummary } = await import(engineUrl('src/playbooks.mjs'));
    const catalog = await loadCatalog();
    return catalogSummary(catalog).map((x) => ({ id: x.id, name: x.name, cn: x.cn, description: x.triggers, descriptionEn: x.descriptionEn || '' }));
  });

  // ---- 权限台账（fail-closed 闭集审批） ----
  // 审批事件推给窗口；窗口销毁期间通道失效 → requestApproval 侧按 fail-closed 处理
  permissions.setApprovalEmitter((payload) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send('finalcheck:approval-request', payload);
  });
  // PermissionRequest hook：审批条之前先问策略。只有 hook 明确返回 allow/deny 才覆盖；
  // 无该事件 / matcher 未命中 / hook 执行失败（无意见）一律回原审批流程，不静默放行。
  permissions.setPermissionHook(async ({ tool, summary, sessionId: sid } = {}) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig || hooksConfig.enabled !== true) return { decision: null };
    const list = hooksConfig.events?.PermissionRequest;
    if (!Array.isArray(list) || !list.length) return { decision: null };
    try {
      // cwd 按「会话所属项目」而不是当前 UI 项目：切到 B 后，A 会话的审批 hook 仍在 A 里跑
      const hookProjectPath = sessionProjectPathOf(sid);
      const r = await runHookEvent('PermissionRequest', { tool, summary, sessionId: sid ?? null }, { cwd: hookProjectPath, config: hooksConfig });
      if (!r.outputs?.length || r.errors?.length) return { decision: null };
      // hooks.mjs 对未给 decision 的输出按 allow 兜底；这里必须确认确有显式 decision，否则回原审批
      const explicit = r.outputs.some((o) => {
        try {
          const j = JSON.parse(String(o.stdout || '').trim());
          return !!j && (j.decision === 'allow' || j.decision === 'deny' || j.decision === 'ask');
        } catch { return false; }
      });
      return explicit ? { decision: r.decision, messages: r.messages } : { decision: null };
    } catch { return { decision: null }; }
  });
  ipcMain.handle('finalcheck:approval-decide', (_e, callId, decision) => permissions.decide(callId, decision));
  ipcMain.handle('finalcheck:confirm-host', (_e, host) => permissions.confirmHost(host));   // 动态测试页勾选确认时调用
  ipcMain.handle('finalcheck:confirm-dir', (_e, dir) => permissions.confirmDir(dir));

  // ---- 动态测试（渗透探测 / 压测）：口头确认语义（用户定案）——给出目标即授权，台账只记账不拦 ----
  ipcMain.handle('finalcheck:probe', async (_e, baseUrl) => {
    permissions.noteTarget(baseUrl);
    const { probeTarget } = await import(engineUrl('src/dynamic/probe.mjs'));
    const t0 = Date.now();
    const out = await probeTarget(baseUrl);
    // 记账：证据等级要能区分「声明了授权」和「本轮真的跑过」
    try { recordProbe(baseUrl, { ms: Date.now() - t0, ok: Number(out?.samples) > 0, samples: Number(out?.samples) || 0 }); } catch { /* 记账失败不影响探测 */ }
    return out;
  });
  ipcMain.handle('finalcheck:stress', async (_e, baseUrl, { duration = 10, connections = 10 } = {}) => {
    permissions.noteTarget(baseUrl);
    if (duration > 60 || connections > 50) throw new Error(t('超过温和上限（60s / 50 连接），请分批进行'));
    const { stressTarget } = await import(engineUrl('src/dynamic/stress.mjs'));
    const t0 = Date.now();
    const out = await stressTarget(baseUrl, { duration, connections });
    try { recordStress(baseUrl, { ms: Date.now() - t0, ok: Number(out?.samples) > 0 && !out?.errors, samples: Number(out?.samples) || 0 }); } catch { /* 记账失败不影响压测 */ }
    return out;
  });
}
