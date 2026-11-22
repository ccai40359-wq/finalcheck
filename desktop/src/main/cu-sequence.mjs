// 0.30.5 实验 1：computer_sequence（复合动作 / composite actions）
// 依据（researcher 调研，来源见 CHANGELOG）：Anthropic `computer_toolset_20260801` 的 batch action、
// OpenAI `computer_call` 的 actions 数组、trycua/cua 的 run_steps（1-32 步、首错即停、可 observe）
// 都是同一形态：**一次工具调用执行有序多动作**，省掉「每动作一次模型往返」。
//
// 实测动机（我们的真机数据）：给微信发一条消息 = 32 次调用 / 492 秒，
// 其中工具执行只占 34 秒（7%），93% 是模型思考+往返（每次往返平均 14 秒）。
// OSWorld-Human 论文同口径：planning 74.59%、screenshot 0.35%、action 0.36%。
// 所以减少往返次数是唯一有效杠杆。
//
// 设计取舍（按调研的风险提示）：
// - **首错即停**：某一步失败立即停止并返回已完成步骤，绝不继续（避免半途状态污染）。
// - **每步都可带 observe**：需要看结果时在序列内直接取观察，不额外开一次调用。
// - **不跨窗口**：整个序列绑定同一个 screenshot_id（同窗口、同缩放），坐标语义一致。
// - **动作数量上限**：默认 8、上限 16 —— 再多就不是"一段连续操作"了，应拆成两段并各自复核。
// - **不支持 focus / drag 作为序列成员**：focus 会换窗口（截图失效）；drag 需要两点语义容易错。

/** 允许放进序列的动作（与 computer_action 的 enum 取交集，去掉 focus/drag） */
export const SEQUENCE_ACTIONS = Object.freeze([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'move', 'scroll', 'type', 'key'
]);

/** 单条动作的最小校验（与 computer_action 的 validateActionArguments 保持同口径，纯函数可测） */
export function validateSequenceStep(step, index = 0) {
  const where = `第 ${index + 1} 步`;
  if (!step || typeof step !== 'object') return `${where}不是对象`;
  const action = String(step.action || '');
  if (!SEQUENCE_ACTIONS.includes(action)) {
    return action === 'focus'
      ? `${where}不能是 focus——focus 会换窗口，序列里的截图会失效。请单独调用 computer_action focus，再重新截图。`
      : action === 'drag' || action === 'left_click_drag'
        ? `${where}不能是 drag——拖拽语义（起点+终点）在序列里容易错。请单独调用。`
        : `${where}的动作「${action}」不支持（可用：${SEQUENCE_ACTIONS.join(', ')}）`;
  }
  if (action === 'type') {
    const text = String(step.text ?? '');
    if (!text) return `${where}（type）缺少非空 text`;
    if (text.length > 4096) return `${where}（type）text 超过 4096 个 UTF-16 代码单元`;
  }
  if (action === 'key') {
    const keys = String(step.keys ?? step.key ?? '');
    if (!keys) return `${where}（key）缺少 keys`;
  }
  if (['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'move'].includes(action)) {
    if (!Number.isFinite(Number(step.x)) || !Number.isFinite(Number(step.y))) {
      return `${where}（${action}）需要数字 x、y（截图像素）`;
    }
  }
  if (action === 'scroll') {
    if (step.direction != null && !['up', 'down', 'left', 'right'].includes(String(step.direction))) {
      return `${where}（scroll）direction 只能是 up/down/left/right`;
    }
  }
  return null;
}

/** 整段校验（返回错误字符串或 null） */
export function validateSequence(steps, { maxSteps = 8 } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) return 'steps 必须是非空数组';
  if (steps.length > maxSteps) {
    return `steps 最多 ${maxSteps} 步（当前 ${steps.length}）——再多就不是「一段连续操作」了，请拆成两段并各自复核`;
  }
  for (let i = 0; i < steps.length; i++) {
    const bad = validateSequenceStep(steps[i], i);
    if (bad) return bad;
  }
  return null;
}

/**
 * 序列执行计划（纯函数）：把要跑的动作列表与"第几步要 observe"算清楚。
 * 只有最后一步之后默认 observe（最终结果要看）；中间步骤按 step.observe 决定。
 * @returns {{ steps: Array<{step:number, action:string, observe:boolean}>, finalObserve: boolean }}
 */
export function planSequence(steps, { observeAfterEach = false } = {}) {
  const list = Array.isArray(steps) ? steps : [];
  return {
    steps: list.map((s, i) => ({
      step: i + 1,
      action: String(s?.action || ''),
      observe: observeAfterEach || s?.observe === true
    })),
    // 最后一步之后总是取一次观察（否则模型看不见结果又要多开一次调用）
    finalObserve: true
  };
}

/** 序列结果摘要（纯函数）：给模型看的"做了什么、停在哪、下一步该干什么" */
export function summarizeSequenceResult({ steps, completed, failed, lastObservation }) {
  const total = steps.length;
  const lines = [`序列执行：完成 ${completed}/${total} 步` + (failed ? `，在第 ${failed.index + 1} 步失败` : '，全部成功')];
  if (failed) {
    lines.push(`失败动作：${failed.action} — ${failed.error}`);
    lines.push(completed > 0
      ? `⚠️ 前 ${completed} 步已经生效，界面状态可能与你预期不同——请重新截图核对后再决定下一步（不要直接重跑整个序列，会重复前面的动作）。`
      : '第 1 步就失败，界面未被改动，可以直接重试或换方法。');
  } else {
    lines.push('全部动作已执行。若其中有提交/保存/删除类动作，请核对最终结果。');
  }
  if (lastObservation) {
    lines.push(lastObservation.canAct
      ? `已附带结果截图（screenshot_id=${lastObservation.screenshotId || '见返回体'}），可以用它继续下一步动作。`
      : `已附带结果截图但不可操作（${lastObservation.reason || '目标不在前台'}），需要先切前台再截图。`);
  }
  return lines.join('\n');
}
