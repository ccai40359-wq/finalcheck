// 按项目列出会话（侧栏「同时展开多个 Workspace」用）。
// 隔离约束：这里只按显式目录读，绝不写 process.env.FINALCHECK_SESSIONS_DIR，也不碰
// activeProjectId / projects.json 的 activeProjectId；并发列多个项目互不影响。
// 返回形状与 sessions.listSessions() 完全一致（渲染层缓存可直接复用）。
import path from 'node:path';
import { getProject, sessionDirOf } from './projects.mjs';
import { listSessionsIn } from './sessions.mjs';

/**
 * projectId → 该项目会话列表。
 * 不存在的 projectId 返回空数组（侧栏对脏 id 容忍，不把错误弹给用户）；
 * 目录解析只读项目注册表，目录不存在时 listSessionsIn 也会返回 []（sqlite 首次会建空库，与现有列表行为一致）。
 */
export async function listForProject(projectId) {
  const id = typeof projectId === 'string' ? projectId.trim() : '';
  if (!id) return [];
  let p = null;
  try { p = await getProject(id); } catch { p = null; }
  if (!p || typeof p.path !== 'string' || !p.path.trim()) return [];
  return listSessionsIn(sessionDirOf(path.resolve(p.path)));
}
