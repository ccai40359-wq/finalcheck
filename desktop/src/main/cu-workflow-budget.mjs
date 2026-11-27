// 0.30.4 工作流配额（引擎侧硬约束，不靠提示词）
// 真机实证：改提示词后模型仍会「先拍全屏、反复查进程、region 逐字验尸」——
// deepseek-v4.1-flash 类模型对长上下文里的软约束不敏感。按用户定下的原则
// （效率优先、token 不是约束）把纪律挪到工具层，由引擎直接拒绝并给出替代动作。
//
// 设计要点：
// - 配额按「回合」计（一轮对话内），由 agent-tools 在每次 tool 调用时喂入。
// - 只限制「浪费型」用法，不限制正当需求：全屏仍可在明确理由下使用。
// - 拒绝时返回 deniedBy:'workflow-budget' + 替代建议，让模型能立刻纠正而不是死磕。

/** 一轮 CU 会话的软配额（可被 env 覆盖，便于测试与特殊场景放宽） */
export function workflowBudgetFromEnv(env = process.env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    screenShots: n(env.FC_CU_SCREEN_SHOTS, 2), // 全屏截图上限（默认 2：足够「先看全场」一次+失败重试一次）
    regions: n(env.FC_CU_REGIONS, 2),          // region 小图上限（默认 2，真机实测模型曾拍 22 次）
    probes: n(env.FC_CU_PROBES, 1)             // 额外窗口探测（Get-Process/tasklist/Add-Type 查窗口）上限
  };
}

export const WORKFLOW_BUDGET_INITIAL = Object.freeze({ screenShots: 0, regions: 0, probes: 0 });

/**
 * 判定一次 computer_screenshot 是否允许。
 * @param {{kind:'screen'|'window'|'region', used:{screenShots:number,regions:number}, budget, reason?:string}} p
 * @returns {{allowed:true} | {allowed:false, deniedBy:'workflow-budget', error:string, hint:string}}
 */
export function checkScreenshotBudget({ kind, used, budget, reason = '' }) {
  const u = { screenShots: Number(used?.screenShots) || 0, regions: Number(used?.regions) || 0 };
  const b = budget || workflowBudgetFromEnv();
  if (kind === 'region') {
    if (u.regions >= b.regions) {
      return {
        allowed: false,
        deniedBy: 'workflow-budget',
        error: `本回合 region 小图已用 ${u.regions}/${b.regions} 次（上限）。请改用一张 target:"window" 的整窗截图看整段内容——读小字时一张要覆盖你关心的整行，不要拆成多个小块逐字核对。`,
        hint: 'window-full'
      };
    }
    return { allowed: true };
  }
  if (kind === 'screen') {
    if (u.screenShots >= b.screenShots) {
      return {
        allowed: false,
        deniedBy: 'workflow-budget',
        error: `本回合全屏截图已用 ${u.screenShots}/${b.screenShots} 次（上限）。已知目标应用时请直接用 target:"window"（可传 hwnd 或 window_title）——窗口捕获能拍到被遮挡的内容，且坐标为图内像素，比全屏更准。只有「不知道是哪个窗口 / 需要屏幕相对布局 / 目标最小化 / 目标是 FC 自己 / 怀疑托盘弹窗」才需要全屏。`,
        hint: 'window-target'
      };
    }
    return { allowed: true };
  }
  // window：不设上限（这是推荐路径），并把 reason 记录下来供排查
  return { allowed: true, reason: String(reason || '') };
}

/**
 * 判定一次「额外窗口探测」（run_command 里的 Get-Process/tasklist/Add-Type 查窗口）是否允许。
 * 窗口截图返回体已含 hwnd，正常流程根本不需要再查。
 */
export function checkProbeBudget({ used, budget, command = '' }) {
  const u = Number(used?.probes) || 0;
  const b = budget || workflowBudgetFromEnv();
  if (u >= b.probes) {
    return {
      allowed: false,
      deniedBy: 'workflow-budget',
      error: `本回合窗口探测（Get-Process/tasklist/Add-Type 查窗口）已用 ${u}/${b.probes} 次（上限）。computer_screenshot target:"window" 的返回体里已经包含 hwnd 与窗口 rect，直接用它即可，不要再单独查进程。`,
      hint: 'use-screenshot-hwnd'
    };
  }
  return { allowed: true };
}

/** 该命令是否属于「窗口探测」类（只读诊断里与窗口信息相关的部分）。
 *  注意：Add-Type 单独出现也算——真机实测模型就是用 Add-Type 写 P/Invoke 查窗口
 *  （GetWindowRect / GetWindowThreadProcessId / EnumWindows 等），这类调用同样是纯浪费
 *  （窗口截图返回体已经带 hwnd/rect）。真正需要写 C# 的其它用途会被注入闸单独管控。 */
export const PROBE_PATTERN = /Get-Process|tasklist|EnumWindows|GetWindowRect|GetWindowThreadProcessId|GetForegroundWindow|MainWindowHandle|Add-Type/i;

export function isProbeCommand(command) {
  return PROBE_PATTERN.test(String(command || ''));
}

/** 命令是不是在跑一个脚本文件（python x.py / node x.mjs / powershell -File x.ps1）。
 *  跑用户项目里的工具不算「窗口探测」——那是在开发 / 使用工具，不是绕开截图去查窗口。
 *  内联代码（python -c / python - <<EOF / node -e）不算脚本文件，照旧按探测计。 */
export function runsScriptFile(command) {
  const c = String(command || '');
  return /(^|[\s/\&;|(])(python[\d.]*|pythonw|py|node)(\.exe)?"?\s+(-(?![ce]\s)[\w-]+\s+)*["']?[^\s"'<|;&-][^\s"'<|;&]*\.(py|pyw|mjs|cjs|js)(?=$|[\s"'|;&])/i.test(c)
    || /-File\s+["']?[^\s"']+\.ps1(?=$|[\s"'])/i.test(c);
}
