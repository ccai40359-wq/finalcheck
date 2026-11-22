// 0.30.5 实验 2：中段 code-action（一次生成小段脚本执行）
// 依据（researcher 调研 + 论文实测）：
// - CoAct-1 消融：纯 code 35.73% 成功 / 1.14 步，纯 GUI 50.68% / 11.20 步，**混合 60.76% / 10.15 步**
//   → 纯脚本快 10 倍但成功率掉 15 个百分点，**必须混合而非替换**
// - CodeAct：5.5 vs 7.6 turns，但单原子调用场景 JSON 反超
// - Anthropic Programmatic Tool Calling：tokens -37%，但未给延迟 benchmark
//
// 我们的用法（混合式）：
// - 只在「坐标已确认、同屏可见、界面不会变」的连续段里用脚本
// - 脚本边界前后保留 GUI 环（截图确认 → 执行脚本 → 截图确认）
// - 脚本内容受注入闸约束（不能做窗口状态变更、不能 AttachThreadInput）
//
// 这个模块只做**计划与校验**（纯函数），真正执行走 run_command（受既有注入闸管控）。

/** code-action 的适用性判定：什么样的连续段适合用脚本一次做完 */
export function codeActionApplicability({ steps, hasVerifiedScreenshot, windowStable = true, needsMidObservation = false }) {
  if (!Array.isArray(steps) || steps.length < 3) {
    return { ok: false, reason: 'steps-too-few', detail: '少于 3 步不值得起一个脚本（GUI 逐步更稳）' };
  }
  if (!hasVerifiedScreenshot) {
    return { ok: false, reason: 'no-verified-screenshot', detail: '没有已核对的截图就不能把坐标写进脚本（写死错坐标会连错一串）' };
  }
  if (needsMidObservation) {
    return { ok: false, reason: 'needs-mid-observation', detail: '中途要看结果（弹窗/加载）就不能用脚本——脚本中间看不见界面' };
  }
  if (!windowStable) {
    return { ok: false, reason: 'window-unstable', detail: '窗口位置/大小会变时脚本里的绝对坐标会失效' };
  }
  return { ok: true, reason: 'applicable' };
}

/**
 * 把动作序列渲染成 pyautogui 脚本片段（纯函数，便于审阅与单测）。
 * 只允许"安全"动作：点击/移动/打字/按键（不做窗口操作，那属于注入闸禁区）。
 * @returns {{ ok: boolean, script?: string, error?: string }}
 */
export function renderPyAutoGuiScript({ steps, waitBetweenMs = 120, header = '' }) {
  const SAFE = new Set(['left_click', 'right_click', 'double_click', 'move', 'type', 'key', 'scroll']);
  const lines = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    const action = String(s.action || '');
    if (!SAFE.has(action)) {
      return { ok: false, error: `第 ${i + 1} 步（${action}）不能写进脚本（脚本只允许点击/移动/打字/按键）` };
    }
    if (action === 'type') {
      const text = String(s.text ?? '');
      if (!text) return { ok: false, error: `第 ${i + 1} 步（type）缺少 text` };
      // 用 repr 风格的安全转义（单引号包裹 + 转义反斜杠与单引号）
      const esc = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      lines.push(`pyautogui.typewrite('${esc}', interval=0.015)`);
    } else if (action === 'key') {
      const keys = String(s.keys ?? s.key ?? '');
      if (!keys) return { ok: false, error: `第 ${i + 1} 步（key）缺少 keys` };
      const esc = keys.replace(/'/g, "\\'");
      lines.push(`pyautogui.hotkey(*'${esc}'.split('+'))`);
    } else if (action === 'scroll') {
      const amount = Number(s.amount ?? 3);
      lines.push(`pyautogui.scroll(${amount > 0 ? '-' : ''}${Math.abs(amount)} * 100)`);
    } else {
      const x = Number(s.x); const y = Number(s.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: `第 ${i + 1} 步（${action}）缺少坐标` };
      }
      const fn = action === 'right_click' ? 'rightClick' : action === 'double_click' ? 'doubleClick' : 'click';
      lines.push(`pyautogui.${fn}(${Math.round(x)}, ${Math.round(y)})`);
      if (action === 'left_click' || action === 'right_click') {
        lines.push('CONFIRM_TARGET()  # 点击前确认坐标确实属于目标窗口（由 FC 注入层做）');
      }
    }
    if (i + 1 < steps.length && waitBetweenMs > 0) {
      lines.push(`time.sleep(${(waitBetweenMs / 1000).toFixed(3)})`);
    }
  }
  const body = [
    'import time',
    'import pyautogui',
    'pyautogui.PAUSE = 0.05',
    ...lines
  ].join('\n');
  return { ok: true, script: (header ? header + '\n' : '') + body };
}

/** 实验结果记录（用于 A/B 对比表，纯函数） */
export function compareExperimentResults(runs) {
  const rows = (Array.isArray(runs) ? runs : []).map((r) => ({
    name: String(r?.name || ''),
    calls: Number(r?.calls) || 0,
    totalMs: Number(r?.totalMs) || 0,
    success: r?.success === true,
    note: String(r?.note || '')
  }));
  if (!rows.length) return { rows: [], best: null };
  const okRows = rows.filter((r) => r.success);
  const best = okRows.length
    ? okRows.reduce((a, b) => (a.calls <= b.calls ? a : b))
    : rows.reduce((a, b) => (a.calls <= b.calls ? a : b));
  return { rows, best: best.name };
}
