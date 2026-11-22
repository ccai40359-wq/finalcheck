// 0.30.0（特性 2）：post-message 后台键盘的白名单与规则（纯函数，可单测）。
//
// 产品决策（用户拍板）：只对**实测验证过的经典 Win32 应用**启用 post-message 投递；
// 微信 / Electron / Chromium 类一律走 SendInput（它们的消息循环不处理合成 WM_CHAR，
// 真机实测「看起来发了其实没发」）。不在白名单 → 明确 deny('delivery-not-whitelisted')，
// 绝不静默降级、也绝不「试一次 post 失败再退回 SendInput」。
//
// 保守起点的理由：PostMessage 投递是**跨进程、绕过输入队列**的合成消息，目标应用有权忽略；
// 只有传统 Win32 编辑控件（EDIT/RICHEDIT 类）会老实处理。所以白名单要靠实测一条条加。
export const POST_DELIVERY_WHITELIST = Object.freeze([
  'notepad',       // 经典 Win32 记事本（实测 WM_CHAR 进 EDIT 子控件）
  'wordpad'
]);

/** 进程名 → 是否允许 post 投递（大小写/扩展名不敏感）。 */
export function isPostDeliveryAllowed(processName) {
  const name = String(processName ?? '').trim().replace(/\.exe$/i, '').toLowerCase();
  if (!name) return false;
  return POST_DELIVERY_WHITELIST.includes(name);
}

/**
 * 组合键（Ctrl+S / ^s / %{F4} / Win+Space 等）**拒绝走 post**：
 * WM_KEYDOWN 的 lParam 里没有修饰键状态，接收方只能自己查 GetKeyState 拿实时键盘状态——
 * 后台投递时那个状态是用户当前的（不是我们想要的），等于「按了 Ctrl 但系统说没按」，
 * 结果不可能是确定的。所以只有纯文本（type）允许 post，key 一律 SendInput。
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function postDeliveryDecision({ processName, action, delivery, hasModifiers }) {
  if (delivery !== 'post') return { allowed: false, reason: 'not-requested' };
  if (action === 'key' || hasModifiers) {
    return { allowed: false, reason: 'chords-not-supported' };
  }
  if (action !== 'type') return { allowed: false, reason: 'action-not-supported' };
  if (!isPostDeliveryAllowed(processName)) return { allowed: false, reason: 'delivery-not-whitelisted' };
  return { allowed: true };
}

/** 组合键识别（与 C# GuardedKeyEvents 的语法一致：^ % + 前缀或 Ctrl+X / Shift+X / Alt+X / Win+X）。 */
export function hasChordModifiers(keys) {
  const spec = String(keys ?? '').trim();
  if (!spec) return false;
  if (/^[\^%+]/.test(spec)) return true;
  return /(\b|^)(ctrl|control|alt|shift|win|meta|lwin)\s*\+/i.test(spec);
}

/**
 * post 投递的结果字段（R5：PostMessage 返回值 ≠ 投递成功）。
 * 调用方必须把它合并进最终结果：delivery:'post' + confidence:'unverified' + warnings[]。
 */
export function postDeliveryResult({ targetHwnd, sent, failed, processName }) {
  const warnings = [
    'post 投递只表示「消息已放进目标窗口的消息队列」，目标应用可能忽略或丢弃——请截图/读回内容确认结果。',
    'post 投递不会移动鼠标、不抢前台焦点；若目标窗口需要先获得焦点才接受输入，内容可能不进框。'
  ];
  if (Number(failed) > 0) warnings.push(`有 ${Number(failed)} 个字符未被消息队列接受（PostMessage 返回失败）。`);
  return {
    delivery: 'post',
    confidence: 'unverified',
    targetHwnd: Number(targetHwnd) || null,
    process: String(processName ?? ''),
    sent: Number(sent) || 0,
    failed: Number(failed) || 0,
    warnings,
    note: `已用后台消息投递 ${Number(sent) || 0} 个字符（未核验；目标可能忽略）。要确认结果请重新截图。`
  };
}
