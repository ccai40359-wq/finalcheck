import * as sessions from '../sessions.mjs';
import * as projects from '../projects.mjs';
import { registerSessionDir, getSessionDir, unregisterSessionDir, findSessionDir } from '../session-projects.mjs';
import { t } from '../../renderer/i18n/core.mjs';

// ---- 会话持久化（DeepSeek 式多会话） ----
// 登记「会话 → 项目目录」：切项目后旧会话的读写仍落到它自己的项目目录
export function registerSessionIpc({ ipcMain, state, sessionProjectPathOf, runSessionStart }) {
  const ensureSessionDirRegistered = async (id) => {
    const known = getSessionDir(id);
    if (known) {
      const hit = await findSessionDir(id, [known]);
      if (hit) return hit;
      unregisterSessionDir(id); // 登记过期（文件被外部移动/删除）：继续按磁盘找
    }
    const candidates = [process.env.FINALCHECK_SESSIONS_DIR, ...(await projects.listProjects().catch(() => [])).map((p) => projects.sessionDirOf(p.path))];
    const found = await findSessionDir(id, candidates);
    if (found) registerSessionDir(id, found);
    return found;
  };

  ipcMain.handle('finalcheck:sessions:new', async (_e, title) => {
    const s = await sessions.newSession(title);
    registerSessionDir(s.id, sessions.dirFor(s.id)); // 新会话属于当前项目
    await runSessionStart(s.id, sessionProjectPathOf(s.id)); // fail-open：SessionStart 不阻断新建
    return s;
  });
  ipcMain.handle('finalcheck:sessions:list', async () => {
    const list = await sessions.listSessions();
    const dir = sessions.dirFor(null); // 列表目录 = 当前项目
    for (const s of list) registerSessionDir(s.id, dir); // 列出来就说明它在这里
    return list;
  });
  ipcMain.handle('finalcheck:sessions:open', async (_e, id) => {
    await ensureSessionDirRegistered(id); // 未登记的会话（老数据/后加项目）先按磁盘找一次
    await sessions.markRead(id).catch(() => {});
    const s = await sessions.loadSession(id);
    await runSessionStart(id, sessionProjectPathOf(id)); // fail-open：SessionStart 不阻断打开
    return s;
  });
  ipcMain.handle('finalcheck:sessions:delete', async (_e, id) => {
    const ok = await sessions.deleteSession(id);
    unregisterSessionDir(id); // 会话没了，目录登记也清掉
    state.sessionUsage.delete(id); // 会话没了，内存里的实测记录也清掉
    state.hookSessionContext.delete(id);
    return ok;
  });
  ipcMain.handle('finalcheck:sessions:rename', (_e, id, title) => sessions.renameSession(id, title));
  // 排队消息存档（F8）：重启后恢复成「待发送」，不静默丢；空数组 = 清档
  ipcMain.handle('finalcheck:sessions:queue-get', async (_e, id) => {
    await ensureSessionDirRegistered(id); // 会话可能在旧项目目录：先登记再读
    return sessions.loadSessionQueue(id);
  });
  ipcMain.handle('finalcheck:sessions:queue-save', async (_e, id, items) => {
    await ensureSessionDirRegistered(id);
    return sessions.saveSessionQueue(id, items);
  });
  ipcMain.handle('finalcheck:sessions:flags', (_e, id, flags) => sessions.setSessionFlags(id, flags));
  ipcMain.handle('finalcheck:sessions:rewind', (_e, id, keepUserTurns) => sessions.rewindToUserTurn(id, keepUserTurns));
  ipcMain.handle('finalcheck:sessions:set-model', async (_e, id, cfg) => {
    const r = await sessions.setModelConfig(id, cfg);
    state.sessionUsage.delete(id); // 换模型/供应商后旧实测（尤其缓存命中）不再适用
    return r;
  });
  ipcMain.handle('finalcheck:sessions:move', async (_e, id, targetProjectId) => {
    const p = await projects.getProject(targetProjectId);
    if (!p) throw new Error(t('目标项目不存在'));
    const targetDir = projects.sessionDirOf(p.path);
    const r = await sessions.moveSessionTo(id, targetDir);
    registerSessionDir(id, targetDir); // 移动后会话归目标项目（后续 append 走新目录）
    return r;
  });
}
