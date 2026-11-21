// AI 自检截图分组（2026-11-21）：agent 用 capture_screenshot 自查时每张都会渲染一个 chip
//（「截图： http://127.0.0.1:…」），几十次自查把会话流占满。这些是 AI 自己的检查证据，
// 不是给用户看的交付物 → 同一条 assistant 消息内收成单个「检查截图 ×N」分组条，默认收起。
//
// 这里放纯函数（不依赖 React/DOM）：分组规则与折叠态的渲染模型 tests/ 直接可测。
// collectArtifacts（chat/ArtifactPanel.jsx）给 capture_screenshot 的产物打 shot:true 标记，
// 本模块按标记分组，不猜文件名/标题前缀——i18n 改文案不会悄悄弄坏分组。

// 分组条默认收起：截图是 AI 自查证据，默认只露一个计数按钮，展开才渲染 chip
export const SHOT_GROUP_DEFAULT_EXPANDED = false;

// collectArtifacts 给 capture_screenshot 打的标记；仅认显式 true，不误伤普通产物
export const isScreenshotArtifact = (a) => !!(a && a.shot === true);

/**
 * 把 collectArtifacts 的产物数组拆成「常规产物」与「截图组」。
 * 签名兼容：输入仍是数组（collectArtifacts(trace) 的输出），不改变 collectArtifacts 本身。
 * @param {Array<{path:string,name:string,shot?:boolean}>} artifacts
 * @returns {{ regular: Array, shotGroup: { count: number, items: Array } | null }}
 *   shotGroup=null 表示这条消息没有截图（不渲染分组条）；items 是展开时要渲染的 chip 数据。
 */
export function partitionArtifacts(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const regular = [];
  const shots = [];
  for (const a of list) {
    if (isScreenshotArtifact(a)) shots.push(a);
    else regular.push(a);
  }
  return {
    regular,
    shotGroup: shots.length > 0 ? { count: shots.length, items: shots } : null
  };
}

/**
 * 分组条的展示模型：收起时 chips 为空数组（DOM 只渲染计数按钮，不渲染任何 chip / <img>），
 * 展开时 chips = 截图产物（每项仍走原 onOpen(path) 链路，右侧 ArtifactPanel 打开）。
 * @param {{count?:number, items?:Array}|null} shotGroup partitionArtifacts 的 shotGroup
 * @param {boolean} expanded 当前是否展开
 * @returns {{ count:number, labelKey:string, params:{n:number}, expanded:boolean, chips:Array } | null}
 */
export function shotGroupView(shotGroup, expanded = SHOT_GROUP_DEFAULT_EXPANDED) {
  if (!shotGroup || typeof shotGroup !== 'object') return null;
  const items = Array.isArray(shotGroup.items) ? shotGroup.items : [];
  const count = Number.isFinite(shotGroup.count) && shotGroup.count > 0
    ? shotGroup.count
    : items.length;
  if (!count) return null;
  const isOpen = expanded === true;
  return {
    count,
    labelKey: '检查截图 ×{n}',
    params: { n: count },
    expanded: isOpen,
    chips: isOpen ? items : []
  };
}
