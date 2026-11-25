// 0.31.1：浏览器三模式「先问用户，不要模型自己拍板」的纯逻辑（不 import electron，可直测）。
//
// 为什么要有这个（2026-11-23 用户真机实测）：
//   用户只说「打开浏览器，我要登录我的小红书」，模型自己拍了真 Edge，还拿 computer_* 去聚焦/截图
//   浏览器窗口，5 步绕路。浏览器模式是**用户的决定**：一次性无痕（不写盘）与长期保留（写盘）在
//   隐私上是两回事，接真 Edge 会用到用户自己登录着的账号。所以模式必须由 ask_user 让用户选。
import { t } from '../renderer/i18n/core.mjs';

export const CHOICE_MODES = Object.freeze(['oneshot', 'persistent', 'real']);

/**
 * 三选一的选项（顺序即界面顺序；parseBrowserChoice 的「选第 N 项」按这个顺序解释）。
 * realAvailable=false（没有 playwright-core / 纯 Node 测试台）时不给第三项——给不出来的路不能摆出来。
 */
export function choiceOptions({ realAvailable = true } = {}) {
  const options = [
    {
      label: t('一次性（无痕）'),
      description: t('不写磁盘，关掉浏览器就清空登录态；共享电脑、临时抓取用这一项')
    },
    {
      label: t('长期保留'),
      description: t('登录态写进本机磁盘，重启 FinalCheck 后仍在；只在自己的电脑上用')
    }
  ];
  if (realAvailable) {
    options.push({
      label: t('接我自己的 Edge（真实登录态）'),
      description: t('用你已登录的真实 Edge，能直接看到要登录才有的内容；会打开一个隔离的 Edge 窗口，不碰你日常浏览器')
    });
  }
  return options;
}

/** 提问正文：带上网址域名，让用户知道这一次问的是哪个站（卡是独立出现的，不跟着上下文）。 */
export function buildChoicePrompt({ url = '', realAvailable = true } = {}) {
  let host = '';
  try { host = new URL(String(url)).host; } catch { host = String(url || '').slice(0, 60); }
  const question = t('AI 要打开网页 {host}，用哪种浏览器？', { host: host || t('（未提供网址）') });
  return { question, options: choiceOptions({ realAvailable }) };
}

const REAL_WORDS = /(^|[^a-z])(real|edge)([^a-z]|$)|真\s*edge|自己的\s*edge|真实\s*登录/i;
// 英文界面下的 label 是 'Long-term'，别只写 persist/remember/keep（0.31.1 自查发现的漏项）
const PERSIST_WORDS = /长期|保留|记住|持久|persist|remember|keep|long[\s-]?term/i;
const ONESHOT_WORDS = /一次性|无痕|不写盘|临时|private|one-?shot|incognito|temporary/i;
const REAL_CJK = /真\s*edge|自己的\s*edge/;

/**
 * 把用户的回答（ask_user 回的是 label 文本，或自由输入，或「2」）解析成三模式。
 * 顺序很重要：「接我自己的 Edge（真实登录态）」同时含「登录」与「Edge」，必须先判 real；
 * 「一次性（无痕）」不能因为含「一次」被误判成别的。判不出来返回 ''（调用方按未选择处理）。
 */
export function parseBrowserChoice(answer) {
  const raw = String(answer == null ? '' : answer).trim();
  if (!raw) return '';
  // 「1 / 2 / 3」「第 2 个」「选项3」：按 choiceOptions 的顺序解释
  const num = raw.match(/^(?:第\s*)?([1-3])(?:\s*(?:个|项|选项)?)?$/);
  if (num) return CHOICE_MODES[Number(num[1]) - 1] || '';
  if (REAL_CJK.test(raw) || REAL_WORDS.test(raw)) return 'real';
  if (PERSIST_WORDS.test(raw)) return 'persistent';
  if (ONESHOT_WORDS.test(raw)) return 'oneshot';
  return '';
}

/**
 * 这一次 browser_navigate 要不要先问用户、以及按什么模式跑。
 *
 * 判定顺序（先命中先返回，保证「显式指定 > 本会话已答 > 设置页已选 > 问用户 > 默认无痕」）：
 *   ① 传了 mode:real / mode:local  → 照做，不问（模型只有在用户已经说过的情况下才会这么传）
 *   ② 本会话已经答过             → 复用，不问（同一任务里连续导航不该反复弹卡）
 *   ③ 设置页已经选过（chosen）    → 按设置，不问（设置页就是用户的决定）
 *   ④ 没有提问通道（子代理/测试台）→ 不问，回落无痕（不能因为问不了就擅自接真 Edge）
 *   ⑤ 其余                        → 问
 *
 * @returns {{ ask: boolean, mode: 'oneshot'|'persistent'|'real'|'', reason: string }}
 */
export function decideBrowserChoice({
  explicitMode = '', sessionMode = '', configChosen = false, hasAskChannel = false, realAvailable = true
} = {}) {
  const explicit = String(explicitMode || '').toLowerCase();
  if (explicit === 'real') {
    return realAvailable
      ? { ask: false, mode: 'real', reason: 'explicit-real' }
      // 传了 real 但真 Edge 通道不可用：别静默改跑离屏（会让模型以为在用真登录态）
      : { ask: false, mode: 'real', reason: 'explicit-real-unavailable' };
  }
  if (explicit === 'local') return { ask: false, mode: '', reason: 'explicit-local' };
  // 用户在对话里明说了「长期保留 / 一次性」时，模型可以直接传——不必再弹卡
  if (explicit === 'persistent' || explicit === 'oneshot') {
    return { ask: false, mode: explicit, reason: 'explicit-mode' };
  }
  const sess = String(sessionMode || '').toLowerCase();
  if (CHOICE_MODES.includes(sess)) return { ask: false, mode: sess, reason: 'session' };
  if (configChosen) return { ask: false, mode: '', reason: 'config' };
  if (!hasAskChannel) return { ask: false, mode: '', reason: 'no-channel' };
  return { ask: true, mode: '', reason: 'first-use' };
}

/** 给工具结果的附注：把「这次为什么跑的是这个模式」讲给模型，后续轮次不再重复问。 */
export function choiceNote(mode, { asked = false, realStarted = false } = {}) {
  // 中文不需要空格，英文需要：用 join(' ') 拼，中文有全角标点托底（0.31.1 自查：英文界面曾粘成「foreground.(mode…」）
  const parts = [];
  if (mode === 'real') {
    parts.push(t('本次在真 Edge（CDP）里操作：看页面用 browser_screenshot，点击/输入用 browser_click / browser_type，全程不需要抢前台。'));
    if (realStarted) parts.push(t('已在隔离 Edge 里打开目标页，用户需要先在这个窗口里登录；登录完成后用 browser_login_state 复核。'));
  } else if (mode === 'persistent') {
    parts.push(t('本次用离屏持久模式：Cookie 写入本机磁盘，重启 FinalCheck 后登录态仍在。清空入口在 设置 → 浏览器会话。'));
  } else if (mode === 'oneshot') {
    parts.push(t('本次用离屏无痕模式：不写磁盘，关掉浏览器登录态即清空。'));
  }
  if (!parts.length) return '';
  if (asked) parts.push(t('（模式由用户在提问卡里选择）'));
  return parts.join(' ');
}

/** 「要不要接你自己的真实 Edge」这件事必须用户点头：二选一（接真 Edge / 改走离屏）。 */
export function buildRealConsentPrompt({ purpose = '' } = {}) {
  const question = purpose
    ? t('要操作 {purpose} 需要真实登录态。现在接你自己的 Edge（隔离窗口，不碰你日常浏览器）吗？', { purpose })
    : t('这一步需要真实登录态。现在接你自己的 Edge（隔离窗口，不碰你日常浏览器）吗？');
  return {
    question,
    options: [
      { label: t('接我自己的 Edge'), description: t('打开隔离 Edge 窗口，你在里面登录一次，之后我能读到登录后的内容') },
      { label: t('不用，走离屏浏览器'), description: t('用 FC 自己的浏览器，不碰你的账号；需要登录的内容会看不到') }
    ]
  };
}

/** 真 Edge 授权回答解析：返回 true=同意接，false=拒绝（走离屏），null=判不出来。 */
export function parseRealConsent(answer) {
  const raw = String(answer == null ? '' : answer).trim();
  if (!raw) return null;
  if (/^(第\s*)?([12])(\s*(个|项|选项)?)?$/.test(raw)) return raw.replace(/[^12]/g, '') === '1';
  // 0.33.4 用户反馈「明明同意了接真实浏览器，还是被拒、反复问」：英文界面提交的是译文 label
  // 「Use my own Edge」，以前只认中文「接/用」和 yes/ok → 判成 null → 当拒绝 → 模型重试 → 又弹卡。
  // 先按卡片自己的两个选项（中文原文 + 当前界面译文）精确比对，再走关键词兜底。
  const norm = (x) => String(x || '').trim().toLowerCase();
  const key = norm(raw);
  const [agree, decline] = buildRealConsentPrompt().options.map((o) => norm(o.label));
  if (key === agree || key === '接我自己的 edge' || key === 'use my own edge') return true;
  if (key === decline || key === '不用，走离屏浏览器' || key === 'no, use the offscreen browser') return false;
  // 否定优先：英文界面的「No, use the offscreen browser」里也含 "use"，必须先判否定
  // （0.31.1 自查：不加 i 标志时大写 No 认不出来，会落到「判不出来」的 safe 分支但不精确）
  if (/不用|不要|不必|拒绝|算了|否|别接|离屏/i.test(raw)) return false;
  if (/\b(no|nope|decline|not\s*now|don'?t|offscreen)\b/i.test(raw)) return false;
  if (/接|同意|可以|好|行|用|yes\b|ok\b|sure/i.test(raw)) return true;
  if (/\b(use|connect|agree|go\s*ahead|edge)\b/i.test(raw)) return true;
  return null;
}

// 浏览器进程名（CU 侧看到的是进程名，不带 .exe 的写法也要认）
const BROWSER_PROCESSES = /^(msedge|chrome|chromium|brave|opera|vivaldi|firefox)(\.exe)?$/i;

/**
 * 0.31.1 混用闸：真 Edge（CDP）已连接时，**不许**再用 computer_* 去拍/聚焦/点击浏览器窗口。
 *
 * 为什么必须硬拦（2026-11-23 用户真机实测）：模型为了给隔离 Edge 窗口聚焦，调了
 * computer_request_access + computer_screenshot + CU focus，绕了 5 步、还把用户的窗口抢到前台。
 * CDP 本身就能截图和点击，且不抢前台——用 CU 是纯粹的绕路，而且会真的动用户的键盘鼠标。
 *
 * 判据是 pid：真 Edge 的浏览器主进程 id 由 CDP 的 SystemInfo.getProcessInfo 拿到，
 * 与前台窗口的 pid 比对——只有确实是**我们自己那套隔离 Edge** 才拦，
 * 不误伤用户日常浏览器、也不误伤其它应用。
 */
export function realEdgeRedirect({ foreground = null, realPid = 0, realConnected = false } = {}) {
  if (!realConnected || !realPid) return null;
  if (!BROWSER_PROCESSES.test(String(foreground?.process || ''))) return null;
  if (Number(foreground?.pid) !== Number(realPid)) return null;
  return {
    ok: false,
    deniedBy: 'real-edge-redirect',
    hint: 'use-browser-tools',
    error: t('当前前台窗口是 FinalCheck 自己启动的隔离 Edge——它已经通过 CDP 接上了，**不要用 computer_* 操作它**（会抢前台、动用户的键鼠）。看页面用 browser_screenshot，点击/输入用 browser_click / browser_type，找元素用 browser_snapshot；这些都不抢前台，也不需要 computer_request_access。需要登录时请用户在那个 Edge 窗口里扫码，不要代劳。')
  };
}

/** browser_connect_real 的授权闸：真 Edge 连接必须用户点头（会话内同意一次即可）。 */
export function shouldAskRealConsent({ sessionMode = '', configChosen = false, hasAskChannel = false } = {}) {
  const sess = String(sessionMode || '').toLowerCase();
  if (sess === 'real') return false;      // 本会话已经同意过
  if (!hasAskChannel) return false;       // 问不了就不问（子代理/测试台）：下面会拒绝而不是擅自连接
  return true;
}

/** 没有提问通道时，真 Edge 一律拒绝——不能因为问不了就默认碰用户的真实账号。 */
export const NO_CHANNEL_REAL_DENY = '需要真实登录态时必须由用户选择「接我自己的 Edge」；当前会话没有提问通道，不能擅自连接真 Edge。改用离屏浏览器（mode 默认）完成能做的部分，或让用户在主会话里确认。';

