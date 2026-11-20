// Computer use 安全层（2026-11-21）：逐应用授权 + 三层 tier + 前台强制。
//
// 照抄 Claude Code 的设计（官方文档 code.claude.com/docs/en/computer-use + 内嵌 skill 文本）：
//   浏览器（Safari/Chrome/Firefox/Edge/Arc…）→ read  ：能看，但不许点击、不许输入
//   终端 / IDE                              → click ：可左键，但不许输入、不许右键、不许拖拽
//   其它应用                                → full  ：全部允许
//   tier 由「前台应用检查」强制执行：read-tier 在前台时 left_click 直接报错。
//
// 为什么要照抄：这套 tier 的价值不在「技术难度」，而在「承认 AI 不应该在浏览器里乱点、
// 不应该在终端里敲命令」。CC 用它把最容易造成伤害的两种前景（网页里的账号操作、
// 终端里的破坏性命令）从根上挡掉。FC 自己也是这个逻辑：终端和 IDE 只给 click。

/** 应用分类（按进程名/标题的常见写法，宽松匹配） */
const BROWSER_PATTERNS = [
  /chrome/i, /firefox/i, /safari/i, /msedge/i, /edge/i, /opera/i, /brave/i, /vivaldi/i, /arc/i,
  /chromium/i, /360se/i, /qqbrowser/i, /sogouexplorer/i
];
const TERMINAL_IDE_PATTERNS = [
  /^claude$/i, /^code$/i, /cursor/i, /windsurf/i, /zed/i, /sublime/i, /notepad\+\+/i,
  /powershell/i, /pwsh/i, /cmd\.exe/i, /^cmd$/i, /conhost/i, /windowsterminal/i, /^wt$/i,
  /mintty/i, /git-bash/i, /bash\.exe/i, /hyper/i, /alacritty/i, /wezterm/i, /kitty/i,
  /devenv/i, /idea/i, /webstorm/i, /pycharm/i, /goland/i, /rider/i, /phpstorm/i, /android studio/i,
  /^node$/i, /python/i, /java/i
];

/** 返回该应用的 tier：'read' | 'click' | 'full' */
export function tierForApp(processName = '', title = '') {
  const p = String(processName || '');
  const t = String(title || '');
  if (BROWSER_PATTERNS.some((re) => re.test(p) || re.test(t))) return 'read';
  if (TERMINAL_IDE_PATTERNS.some((re) => re.test(p) || re.test(t))) return 'click';
  return 'full';
}

/** 每个 tier 允许的动作（CC 的原文逻辑） */
export const TIER_CAPS = Object.freeze({
  // read：只能看。截图、缩放、移动鼠标（move 本身不产生点击，但为了严格也不给 move 的「悬停触发」）
  read: { screenshot: true, zoom: true, move: false, click: false, drag: false, scroll: false, type: false, key: false },
  // click：可左键，不可输入/右键/拖拽
  click: { screenshot: true, zoom: true, move: true, click: 'left-only', drag: false, scroll: true, type: false, key: false },
  // full：全部
  full: { screenshot: true, zoom: true, move: true, click: true, drag: true, scroll: true, type: true, key: true }
});

/**
 * 判断某动作在当前 tier 下是否允许。
 * @param {'read'|'click'|'full'} tier
 * @param {string} action 例如 'left_click' / 'type' / 'scroll' / 'drag'
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkActionAllowed(tier, action) {
  const caps = TIER_CAPS[tier] || TIER_CAPS.read;
  const a = String(action || '');
  const isClick = /^(left|right|middle|double|triple)_?click$|^click$/.test(a);
  const isDrag = a === 'drag' || a === 'left_click_drag';
  const isType = a === 'type';
  const isKey = a === 'key' || a === 'hold_key';
  const isScroll = a === 'scroll';
  const isMove = a === 'move' || a === 'mouse_move';

  if (isClick) {
    if (caps.click === false) return { ok: false, reason: tierReason(tier, '点击') };
    if (caps.click === 'left-only' && !/^left_?click$|^click$|^double_?click$|^triple_?click$/.test(a)) {
      return { ok: false, reason: tierReason(tier, '右键/中键') };
    }
    return { ok: true };
  }
  if (isDrag) return caps.drag ? { ok: true } : { ok: false, reason: tierReason(tier, '拖拽') };
  if (isType) return caps.type ? { ok: true } : { ok: false, reason: tierReason(tier, '输入文字') };
  if (isKey) return caps.key ? { ok: true } : { ok: false, reason: tierReason(tier, '按键') };
  if (isScroll) return caps.scroll ? { ok: true } : { ok: false, reason: tierReason(tier, '滚动') };
  if (isMove) return caps.move ? { ok: true } : { ok: false, reason: tierReason(tier, '移动鼠标') };
  return { ok: true };
}

function tierReason(tier, what) {
  if (tier === 'read') {
    return `当前前台应用属于「只读」级别（浏览器类）：可以看到截图，但不允许${what}。`
      + '要操作网页请改用 browser_* 系列工具（基于页面结构而不是点像素）；'
      + '如果确实需要在此应用里操作，请用户先手动把它切到前台并授权。';
  }
  if (tier === 'click') {
    return `当前前台应用属于「只能左键」级别（终端 / 编辑器）：允许左键，但不允许${what}。`
      + '在终端或编辑器里输入文字等于让它替用户执行命令，这一层是故意挡住的。';
  }
  return `当前级别不允许${what}`;
}

/**
 * 逐应用授权台账（CC 的 request_access 等价物）。
 * 内存态即可：FC 的进程生命周期内有效，重启要重新授权（CC 也是每会话重新请求）。
 */
export class AccessLedger {
  constructor() {
    this.granted = new Set(); // 小写进程名
  }
  isGranted(processName) {
    const p = String(processName || '').toLowerCase().trim();
    if (!p) return false;
    return this.granted.has(p);
  }
  grant(processNames) {
    const names = Array.isArray(processNames) ? processNames : [processNames];
    for (const n of names) {
      const v = String(n || '').toLowerCase().trim();
      if (v) this.granted.add(v);
    }
    return this.list();
  }
  revokeAll() { this.granted.clear(); return []; }
  list() { return [...this.granted]; }
}

/** 一次 computer use 调用的结果归一（给模型看的文案要能指导下一步） */
export function describeTier(tier) {
  if (tier === 'read') return 'read（只能看：可截图，不能点击/输入）';
  if (tier === 'click') return 'click（可左键，不能输入/右键/拖拽）';
  return 'full（全部允许）';
}
