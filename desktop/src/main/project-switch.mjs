// 切项目计划（纯函数，可单测）：ZCode 语义下切 Workspace 只切 UI 视角。
// 关键约束：绝不 abort 在跑的回合，也不清掉各会话的 SessionStart context——
// 正在跑的回合已经在开头快照了自己的项目路径/策略/hooks 配置。
import { sessionDirOf, memoryDirOf } from './projects.mjs';

export function planProjectSwitch(p, { reloadHooks = true } = {}) {
  if (!p || typeof p !== 'object' || !p.id || !p.path) return null;
  return Object.freeze({
    activeProjectId: String(p.id),
    activeProjectPath: String(p.path),
    sessionsDir: sessionDirOf(p.path),
    memoryDir: memoryDirOf(p.path),
    reloadHooksConfig: !!reloadHooks,
    // 显式写出两个「不做」的语义，防止以后有人把 abort / clear 加回来
    abortRunningTurns: false,
    clearSessionHookContext: false
  });
}
