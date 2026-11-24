// 定时唤醒（类似 cron，但先做最稳的一档）——**纯逻辑，无 React / 无 Electron / 无 IO**。
//
// 为什么需要这个（用户实机截图里模型自己承认的缺口）：
//   模型说「我没有『睡 25 分钟再醒来』的能力，一个回合结束就停了。要让『25 分钟后再看一次进度』
//   自动发生，必须你再说一句话触发我。」
//   这不是模型能力问题，是产品缺口：FC 以前只会在「用户说一句话」时动，所以所有
//   「等 N 分钟再看」的场景（等网课进度 / 等部署 / 等 CI / 等构建）都要人肉盯着。
//
// 设计边界（**刻意不做**的东西，比做了什么更重要）：
//   ① 不做「回合内 sleep 25 分钟」——那样一个回合会挂很久，上下文持续膨胀，
//      中途任何看门狗/熔断都可能把整轮结果掐掉，用户也没法在长回合里插话。
//      到点**起一个新回合**才是对的：回合之间干净，上下文不膨胀。
//   ② 不做模型自我唤醒——模型不该有回合外的自我调度能力（那是越权）。
//      调度归产品（这里），执行归引擎。
//   ③ 默认**只跑一次**（`repeat: 0`）。重复需要显式 `repeat: -1`（无限）或正整数（次数上限），
//      否则很容易变成「静默烧额度」的东西。
//   ④ 错过补偿默认**只补一次**（见 advanceDue）：电脑睡了三小时、错过六次，醒来不补跑六遍。

const MIN_DELAY_MS = 10_000;          // 少于 10 秒的延时不收（几乎必然是误触/误解析）
const MAX_DELAY_MS = 7 * 24 * 3600_000; // 单次最长 7 天（再长请用重复任务，避免「定了忘了」）
const MAX_ITEMS = 50;                 // 单机存档上限（防止配置文件无限增长）

/** 允许的重复语义：0=只跑一次；-1=无限；正整数=剩余次数 */
export const REPEAT_ONCE = 0;
export const REPEAT_FOREVER = -1;

const nowMs = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 解析「多久之后」的输入。接受：
 *   · 纯数字（毫秒太大、秒太小，这里统一按**分钟**理解？不行——歧义太大，所以**只接受带单位**）
 *   · '30s' / '30秒' / '25m' / '25min' / '25分钟' / '2h' / '2小时' / '1d' / '1天'
 *   · 组合：'1h30m' / '1小时30分'
 * 为什么只认带单位：'25' 到底是 25 秒还是 25 分钟，猜错代价很大（用户要等 25 分钟却 25 秒就唤醒）。
 * @returns {{ok:true, ms:number} | {ok:false, error:string}}
 */
export function parseDelay(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return { ok: false, error: '没有给出延时' };
  // 中文单位统一成英文记号
  const normalized = raw
    .replace(/个?小时/g, 'h').replace(/时/g, 'h')
    .replace(/分钟/g, 'm').replace(/分/g, 'm')
    .replace(/秒钟?/g, 's')
    .replace(/天/g, 'd');
  // 只允许「数字 + 单位」的组合，杜绝 '25' 这种歧义输入
  const tokenRe = /([0-9]+(?:\.[0-9]+)?)(d|h|m|s)/g;
  const unitMs = { d: 86400_000, h: 3600_000, m: 60_000, s: 1000 };
  let total = 0;
  let matched = '';
  let m;
  while ((m = tokenRe.exec(normalized)) !== null) {
    matched += m[0];
    total += Number(m[1]) * unitMs[m[2]];
  }
  // 归一化后必须整串都是「数字+单位」（去掉空格后），否则视为不认识
  if (!matched || matched !== normalized.replace(/\s+/g, '')) {
    return { ok: false, error: `看不懂的延时：${String(input).slice(0, 40)}（请写成 25m / 25分钟 / 2h 这样带单位的形式）` };
  }
  if (!Number.isFinite(total) || total <= 0) return { ok: false, error: '延时必须大于 0' };
  if (total < MIN_DELAY_MS) return { ok: false, error: `延时太短（最少 ${MIN_DELAY_MS / 1000} 秒）` };
  if (total > MAX_DELAY_MS) return { ok: false, error: '延时不支持超过 7 天' };
  return { ok: true, ms: Math.round(total) };
}

/**
 * 建一条定时任务（不做 IO，只算出该存什么）。
 * @param {{sessionId:string, prompt:string, delayMs:number, repeat?:number, at?:number, label?:string}} input
 */
export function createWakeup({ sessionId, prompt, delayMs, repeat = REPEAT_ONCE, at = Date.now(), label = '', id = '' } = {}) {
  const sid = String(sessionId ?? '').trim();
  if (!sid) return { ok: false, error: '缺少会话 id（定时唤醒必须挂在某个会话上）' };
  const text = String(prompt ?? '').trim();
  if (!text) return { ok: false, error: '缺少唤醒后要做的事' };
  if (text.length > 2000) return { ok: false, error: '任务描述太长（上限 2000 字）' };
  const delay = Number(delayMs);
  if (!Number.isFinite(delay) || delay < MIN_DELAY_MS) return { ok: false, error: '延时太短或非法' };
  if (delay > MAX_DELAY_MS) return { ok: false, error: '延时不支持超过 7 天' };
  const rep = Number(repeat);
  if (rep !== REPEAT_FOREVER && (!Number.isInteger(rep) || rep < 0)) return { ok: false, error: 'repeat 只能是 -1（无限）或非负整数' };
  const now = nowMs(at);
  return {
    ok: true,
    item: {
      id: String(id || `wk-${Math.random().toString(36).slice(2, 9)}`),
      sessionId: sid,
      prompt: text,
      label: String(label || text).slice(0, 80),
      intervalMs: delay,                 // 间隔（重复任务用它算下一次）
      nextAt: now + delay,               // 下一次到期时间（绝对毫秒）
      repeat: rep,                       // 0=只跑一次；-1=无限；正整数=剩余次数
      enabled: true,
      createdAt: now,
      lastRunAt: 0,
      runCount: 0,
      lastOutcome: '',                   // 'ok' / 'error' / 'missed' / 'disabled'
    }
  };
}

/** 读出「所有已到期」的任务 id（按到期时间升序，先到先跑）。 */
export function dueItems(items, at = Date.now()) {
  const now = nowMs(at);
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.enabled !== false && nowMs(it.nextAt) > 0 && nowMs(it.nextAt) <= now)
    .sort((a, b) => nowMs(a.nextAt) - nowMs(b.nextAt));
}

/**
 * 一条任务跑完之后推进时间。
 *
 * 错过补偿策略（关键决策）：**只补一次**。
 * 电脑睡了 3 小时、本来该跑 6 次 —— 醒来只跑 1 次，然后把 nextAt 推到「下一个未来的时点」。
 * 理由：重复任务的语义是「定期看一眼现状」，不是「把错过的 6 次补做一遍」；
 * 补跑 6 次既烧额度又没有意义（前 5 次看到的是同一份过时快照）。
 *
 * @param {object} item
 * @param {{at?:number, outcome?:string}} [opts]
 * @returns {object|null} 推进后的任务；返回 null 表示这条任务该被移除（只跑一次的跑完了）
 */
export function advanceDue(item, { at = Date.now(), outcome = 'ok' } = {}) {
  if (!item) return null;
  const now = nowMs(at);
  const ran = {
    ...item,
    lastRunAt: now,
    runCount: Number(item.runCount || 0) + 1,
    lastOutcome: String(outcome || 'ok')
  };
  const repeat = Number(item.repeat || 0);
  // 只跑一次：跑完即移除
  if (repeat === REPEAT_ONCE) return null;
  // 无限：剩余次数不变
  if (repeat === REPEAT_FOREVER) {
    return { ...ran, repeat: REPEAT_FOREVER, nextAt: nextFuture(now, Number(item.intervalMs) || MIN_DELAY_MS) };
  }
  // 有限次数：减一，减到 0 就移除
  const left = repeat - 1;
  if (left <= 0) return null;
  return { ...ran, repeat: left, nextAt: nextFuture(now, Number(item.intervalMs) || MIN_DELAY_MS) };
}

/** 把 nextAt 推到「严格大于 now」的第一个时点（对齐原始节奏，且不补跑历史）。 */
function nextFuture(now, intervalMs) {
  const step = Math.max(MIN_DELAY_MS, Number(intervalMs) || MIN_DELAY_MS);
  let next = now + step;
  // 间隔大于 10 秒时按固定步长推进；这样节奏不会因为每次实际执行耗时不同而漂移
  if (next <= now) next = now + step;
  return next;
}

/** 人类可读的「还有多久」（给 UI 用；纯函数便于测）。 */
export function humanizeIn(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  if (n <= 0) return '即将执行';
  const s = Math.round(n / 1000);
  if (s < 60) return `${s} 秒后`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟后`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} 小时 ${rm} 分钟后` : `${h} 小时后`;
  const d = Math.floor(h / 24);
  return `${d} 天后`;
}

/** 存档校验：读档时丢掉结构坏掉的条目（宁可少一条，也不要让调度器崩在启动时）。 */
export function sanitizeItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const it of list.slice(0, MAX_ITEMS)) {
    if (!it || typeof it !== 'object') continue;
    const sid = String(it.sessionId ?? '').trim();
    const prompt = String(it.prompt ?? '').trim();
    if (!sid || !prompt) continue;
    const nextAt = nowMs(it.nextAt);
    if (nextAt <= 0) continue;
    out.push({
      id: String(it.id || `wk-${Math.random().toString(36).slice(2, 9)}`),
      sessionId: sid,
      prompt,
      label: String(it.label || prompt).slice(0, 80),
      intervalMs: Math.max(MIN_DELAY_MS, Number(it.intervalMs) || MIN_DELAY_MS),
      nextAt,
      repeat: Number.isInteger(Number(it.repeat)) ? Number(it.repeat) : REPEAT_ONCE,
      enabled: it.enabled !== false,
      createdAt: nowMs(it.createdAt) || 0,
      lastRunAt: nowMs(it.lastRunAt) || 0,
      runCount: Number(it.runCount) || 0,
      lastOutcome: String(it.lastOutcome || '')
    });
  }
  return out;
}

/** 满了没有（给 UI 提示「先删几条」）。 */
export function isFull(items) { return (Array.isArray(items) ? items.length : 0) >= MAX_ITEMS; }

export const WAKEUP_LIMITS = Object.freeze({ MIN_DELAY_MS, MAX_DELAY_MS, MAX_ITEMS });

/**
 * 定时回合的**只读护栏**——这里用**白名单**而不是黑名单，是刻意选择。
 *
 * 为什么不写「黑名单」：黑名单是 fail-open 的。以后新增一个会改世界的工具（比如 deploy、
 * 发邮件、下单），只要忘了把它加进黑名单，无人值守回合就会自动执行它。
 * 白名单是 fail-closed：新工具默认被拒，必须显式加进来才能用。安全功能的默认方向必须是拒绝。
 *
 * ⚠️ 工具名必须与 `agent-tools.mjs` 里实际注册的键**逐字一致**。
 * 第一版我凭印象写了 `search_code` / `list_dir`，那两个名字根本不存在
 * （真正的搜索工具叫 `grep_code`）—— 结果是「最该允许的 grep_code 被误拒，
 * 两个不存在的名字占着位置」，定时体检直接不可用。所以下面是照着工具表核过的。
 */
