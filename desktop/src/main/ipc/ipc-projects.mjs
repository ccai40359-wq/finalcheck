import { readdir } from 'node:fs/promises';
import { dialog } from 'electron';
import * as projects from '../projects.mjs';
import { listForProject } from '../project-sessions.mjs';
import { registerSessionDir, scanSessionsDir } from '../session-projects.mjs';
import { t } from '../../renderer/i18n/core.mjs';

// ---- 项目文件夹：会话/记忆都在 <project>/.finalcheck/ ----
export function registerProjectIpc({ ipcMain, getWin, getActiveProjectId, selectProjectEnv }) {
  ipcMain.handle('finalcheck:pick-directory', async () => {
    const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('finalcheck:projects:list', async () => {
    const list = await projects.listProjects();
    const out = [];
    for (const p of list) {
      // 列出项目时顺手登记它的会话（只 readdir 文件名；ZCode 语义：会话属于各自项目）
      await scanSessionsDir(projects.sessionDirOf(p.path)).catch(() => {});
      out.push({
        ...p,
        sessionCount: (await readdir(projects.sessionDirOf(p.path)).catch(() => [])).filter((f) => f.endsWith('.json')).length
      });
    }
    return out;
  });
  ipcMain.handle('finalcheck:projects:current', () => getActiveProjectId());
  ipcMain.handle('finalcheck:projects:add', async (_e, dir) => {
    const p = await projects.addProject(dir);
    await scanSessionsDir(projects.sessionDirOf(p.path)).catch(() => {}); // 新加项目可能已带旧会话
    return p;
  });
  ipcMain.handle('finalcheck:projects:remove', async (_e, id) => {
    const ok = await projects.removeProject(id);
    let list = await projects.listProjects();
    if (getActiveProjectId() === id) {
      const next = list[0] || await projects.ensureDefaultProject();
      await selectProjectEnv(next);
      list = await projects.listProjects();
    }
    return { ok, projects: list };
  });
  ipcMain.handle('finalcheck:projects:select', async (_e, id) => {
    const p = await projects.getProject(id);
    if (!p) throw new Error(t('项目不存在'));
    await selectProjectEnv(p);
    return p;
  });
  // 侧栏同时展开多个 Workspace：列「指定项目」的会话。
  // 关键隔离：按项目路径解析会话目录后直接 listSessionsIn(dir)，全程不改
  // FINALCHECK_SESSIONS_DIR / activeProjectId；并发列 A、B 两个项目互不踩。
  // 不存在的 projectId → []（渲染层按空列表显示，不弹错误）。
  ipcMain.handle('finalcheck:projects:sessions', async (_e, projectId) => {
    const list = await listForProject(projectId);
    const p = await projects.getProject(String(projectId || '')).catch(() => null);
    if (p) {
      const dir = projects.sessionDirOf(p.path);
      for (const s of list) registerSessionDir(s.id, dir); // sqlite 会话没有 JSON 文件名，靠列表登记所属项目
    }
    return list;
  });
}
