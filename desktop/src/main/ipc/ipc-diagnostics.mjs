import path from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { dialog } from 'electron';
import * as sessions from '../sessions.mjs';
import { computeStats, usageFilePath } from '../usage-ledger.mjs';
import { buildDiagnostics, collectApiKeys, hooksFilePath, readLastErrors } from '../diagnostics.mjs';
import { t } from '../../renderer/i18n/core.mjs';

// ---- 用量统计 / 诊断导出 / 示例项目（新增通道，不改动已有回合与沙箱逻辑） ----
export function registerDiagnosticsIpc({ ipcMain, getWin, getDataRoot, repoRoot, app, store }) {
  ipcMain.handle('finalcheck:usage:stats', async (_e, payload = {}) => {
    const requested = typeof payload === 'number' ? payload : payload?.days;
    const days = Number(requested) === 30 ? 30 : 7;
    let sessionList = [];
    try { sessionList = await sessions.listSessions(); } catch { /* 会话目录不可读不影响用量统计 */ }
    return computeStats({ days, sessions: sessionList });
  });

  // 诊断包只读：配置经 diagnostics.mjs 脱敏（apiKey → ***），日志里出现的密钥也一并抹除
  ipcMain.handle('finalcheck:diagnostics:export', async () => {
    const cfg = await store.loadConfig();
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const r = await dialog.showSaveDialog(getWin(), {
      title: t('导出诊断包'),
      defaultPath: path.join(getDataRoot(), `FinalCheck-diagnostics-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    let sessionCount = 0;
    try { sessionCount = (await sessions.listSessions()).length; } catch { /* 会话目录不可读按 0 */ }
    let logsDir = path.join(getDataRoot(), 'logs');
    try { logsDir = app.getPath('logs'); } catch { /* 非 ready/平台不支持时回落 DATA_ROOT */ }
    const lastErrors = await readLastErrors(path.join(logsDir, 'main.log'), { secrets: collectApiKeys(cfg) });
    const payload = buildDiagnostics({
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      config: cfg,
      providers: (cfg.providers || []).map((p) => p.name),
      activeModel: cfg.activeModel || '',
      sessionCount,
      lastErrors,
      files: {
        usage: usageFilePath(),
        hooks: hooksFilePath(),
        sessionsDir: process.env.FINALCHECK_SESSIONS_DIR ? path.resolve(process.env.FINALCHECK_SESSIONS_DIR) : ''
      }
    });
    await writeFile(r.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle('finalcheck:demo:path', async () => {
    const demo = path.join(repoRoot, 'src', 'fixtures', 'demo-project');
    try {
      const st = await stat(demo);
      if (!st.isDirectory()) return { error: t('示例项目路径不是目录：{path}', { path: demo }) };
      return demo;
    } catch {
      return { error: t('示例项目不存在：{path}', { path: demo }) };
    }
  });
}
