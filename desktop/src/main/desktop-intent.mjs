// 0.33.4 桌面操控（computer_*）只在用户要求时才给模型
// 用户反馈：明明是浏览器任务，AI 却去截桌面、抢前台（进 CU 模式还会把主窗缩成迷你窗）。
// 规则：最近几条用户消息里明确提到操控电脑 / 桌面软件，或者桌面操控会话正在进行（用户说「继续」），
// 才把 computer_* 放进工具表；否则 schema 里没有，硬调也会被拒并指向 browser_*。

// 「要操控电脑」的说法 + 常见桌面软件名。浏览器 / 网页任务不在这里（那走 browser_*）。
export const DESKTOP_INTENT_RE = new RegExp([
  '操控(?:电脑|桌面)', '操作(?:电脑|桌面|软件|应用|窗口)', '控制(?:电脑|桌面)', '桌面操控', '电脑上', '桌面上', '在桌面',
  '截(?:个)?屏', '截图.{0,6}(?:桌面|屏幕)', '(?:整个|电脑|桌面)屏幕', '鼠标', '键盘',
  '桌面(?:软件|应用|程序|客户端|端)', '本机(?:软件|应用|程序)', '软件里', '客户端里',
  'computer[-_ ]?use', '\\bdesktop app', 'my (?:desktop|computer|screen)', 'mouse', 'keyboard',
  '\\bword\\b', 'excel', '\\bwps\\b', 'powerpoint', '\\bppt\\b', '微信', 'wechat', '\\bqq\\b', '钉钉', '飞书', '企业微信',
  '记事本', 'notepad', '计算器', 'calculator', '资源管理器', 'explorer\\.exe', '文件管理器', '任务栏', '开始菜单',
  '画图', 'photoshop', '剪映', 'outlook', 'todesk', '向日葵', '远程桌面'
].join('|'), 'i');

const textOf = (m) => {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(' ');
  return '';
};

/**
 * @param {Array<{role:string, content:any}>} messages 发给模型的历史（最后一条是本轮用户消息）
 * @param {{ cuActive?: boolean, lookback?: number }} [o]
 */
export function desktopIntent(messages, { cuActive = false, lookback = 3 } = {}) {
  if (cuActive) return { allowed: true, why: 'cu-session' };
  const users = (Array.isArray(messages) ? messages : []).filter((m) => m?.role === 'user').slice(-lookback);
  for (let i = users.length - 1; i >= 0; i--) {
    const m = textOf(users[i]).match(DESKTOP_INTENT_RE);
    if (m) return { allowed: true, why: m[0] };
  }
  return { allowed: false, why: '' };
}

export const isDesktopTool = (name) => /^computer_/.test(String(name || ''));

export const CU_NOT_REQUESTED = {
  error: '用户这次没有要求操控电脑，桌面操控（computer_*）不可用——它会抢前台、打断用户。'
    + '网页相关的事用 browser_*（browser_screenshot 截网页、browser_snapshot 看结构、browser_click / browser_type 操作页面）；'
    + '文件和命令用 read_file / run_command。确实只能在桌面软件里完成时，先用 ask_user 问用户是否允许操控电脑。',
  deniedBy: 'cu-intent'
};

export const CU_STOPPED_BY_USER = {
  error: '用户按了「停止操控」（ESC）：本回合桌面操控已被叫停，不要再调用 computer_*。'
    + '用不需要桌面操控的方式把任务做完（browser_* / 文件 / 命令），做不到就直接告诉用户还差哪一步需要他自己操作。',
  deniedBy: 'cu-stopped'
};
