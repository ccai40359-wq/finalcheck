// 权限台账（fail-closed 闭集审批，对齐 deepseek-harness 审批语义）
// 设计定案（DESKTOP-ACCEPTANCE §2 强化）：
//  - decision ∈ { allowed-once, always-session, rejected } 闭集；无应答/超时(120s)/非法值 = rejected
//  - 主进程持台账，不再信任 renderer/agent 转述：
//      confirmedHosts:Set  —— 动态测试页勾选确认经专用 IPC 写入，agent 传参不生效
//      confirmedDirs:Set   —— 目录确认台账（confirm-dir IPC 写入）
//      sessionAllows:Map   —— 工具名 → Set(参数模式)，always-session 时记录（run_command 记命令前缀）
//  - 本模块不 import electron（可被 node:test 直测）：给 UI 的 emit 由主进程注入
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VALID_DECISIONS = new Set(['allowed-once', 'always-session', 'rejected']);
const APPROVAL_EVENT = 'finalcheck:approval-request'; // 常量仅作文档；emit 由 index.mjs 注入

// ---- 台账状态（进程级，应用生命周期内有效） ----
const confirmedHosts = new Set();
const confirmedDirs = new Set();
const sessionAllows = new Map(); // tool → Set(pattern)
const onceGrants = new Map();    // tool → Set(pattern)：hook ask 获批后的一次性免审，消费即删

// pending 审批：callId → { resolve, tool, summary, timer }
const pending = new Map();

let emitApproval = null;          // (payload) => void；null = 无 UI 通道
let approvalTimeoutMs = 120000;   // 120s 无应答 = denied
let permissionMode = 'ask';       // 'ask'=每次命令需审批 | 'full'=完全权限（仿 ZCode Full access）
let permissionHook = null;        // async ({tool, summary, sessionId}) => { decision: 'allow'|'deny'|null }

/** 注入 PermissionRequest hook（index.mjs 接线）；allow/deny 覆盖审批，其它值走原流程 */
export function setPermissionHook(fn) {
  permissionHook = typeof fn === 'function' ? fn : null;
}

/** 注入主进程 emit 通道（index.mjs：win.webContents.send）；传 null 恢复 fail-closed */
export function setApprovalEmitter(fn) {
  emitApproval = typeof fn === 'function' ? fn : null;
}

/** 审批超时（ms），测试可调短；非正数回退 120s */
export function setApprovalTimeout(ms) {
  const n = Number(ms);
  approvalTimeoutMs = n > 0 ? n : 120000;
}

/**
 * 发起一次审批：emit 给 UI，等待 decide() 或 120s 超时。
 * fail-closed：无 emit 通道 / emit 抛错 / 超时 / decide 非法值，一律 resolve 'rejected'。
 * 权限模式（仿 ZCode 的 Full access）：mode='full' 时自动放行（灾难命令仍被 shell 拦截层挡住）。
 */
export function setMode(m) { permissionMode = m === 'full' ? 'full' : 'ask'; return permissionMode; }
export function getMode() { return permissionMode; }

export async function requestApproval({ callId, tool, summary, sessionId = null } = {}) {
  const id = (typeof callId === 'string' && callId) ? callId : `ap-${randomUUID()}`;
  const t = String(tool || 'unknown').slice(0, 60);
  const s = String(summary ?? '').slice(0, 500);
  // 一次性免审：hook ask 已人工批准后由工具层下发；命中即放行且不再弹条
  if (consumeGrant(t, s)) return 'allowed-once';
  // PermissionRequest hook：策略层先表态；无 hook / 无明确 allow|deny 时回原审批流程
  if (permissionHook) {
    try {
      const hook = await permissionHook({ tool: t, summary: s, sessionId });
      const d = hook && typeof hook === 'object' ? hook.decision : null;
      if (d === 'deny') return 'rejected';
      if (d === 'allow') return 'allowed-once';
    } catch { /* hook 异常按无意见处理，不影响原审批 */ }
  }
  if (permissionMode === 'full') return 'allowed-once'; // 完全权限：不再询问
  return new Promise((resolve) => {
    if (!emitApproval) { resolve('rejected'); return; } // 没有 UI 可问 → 拒绝
    const entry = {
      tool: t, summary: s,
      resolve: (d) => resolve(VALID_DECISIONS.has(d) ? d : 'rejected'),
      timer: null
    };
    entry.timer = setTimeout(() => {
      if (pending.get(id) === entry) pending.delete(id);
      entry.resolve('rejected'); // 超时 = denied
    }, approvalTimeoutMs);
    pending.set(id, entry);
    try {
      emitApproval({ callId: id, tool: t, summary: s });
    } catch {
      if (pending.get(id) === entry) { pending.delete(id); clearTimeout(entry.timer); }
      entry.resolve('rejected'); // 通道故障 = denied
    }
  });
}

/**
 * 回填一次审批决定。decision 必须在闭集内，否则按 rejected 处理。
 * 返回是否成功投递（callId 不存在/已处理 → false）。
 */
export function decide(callId, decision) {
  const entry = pending.get(String(callId || ''));
  if (!entry) return false;
  pending.delete(String(callId));
  clearTimeout(entry.timer);
  const d = VALID_DECISIONS.has(decision) ? decision : 'rejected'; // 非法值 = denied
  if (d === 'always-session') {
    // 本会话总是允许：记录参数模式（run_command 记命令前缀，其余工具记原样摘要）
    const pattern = entry.tool === 'run_command' ? commandPrefix(entry.summary) : entry.summary;
    let set = sessionAllows.get(entry.tool);
    if (!set) { set = new Set(); sessionAllows.set(entry.tool, set); }
    set.add(pattern);
  }
  entry.resolve(d);
  return true;
}

/**
 * 一次性免审券：hook 的 PreToolUse 返回 ask 且用户批准后，由工具包装层下发；
 * 工具内部的 requestApproval 检查前 consumeGrant 命中即视为已批准，避免同一调用弹第二次审批条。
 */
export function grantOnce(tool, target) {
  const t = String(tool || '');
  if (!t) return false;
  let set = onceGrants.get(t);
  if (!set) { set = new Set(); onceGrants.set(t, set); }
  set.add(String(target ?? ''));
  return true;
}

/** 消费一次性免审券；只有第一次命中返回 true */
export function consumeGrant(tool, target) {
  const t = String(tool || '');
  const key = String(target ?? '');
  const set = onceGrants.get(t);
  if (!set || !set.has(key)) return false;
  set.delete(key);
  if (!set.size) onceGrants.delete(t);
  return true;
}

/** 该工具该参数模式是否已被 always-session 放行（一次性免审券先查，消费交给 consumeGrant） */
export function sessionAllowed(tool, pattern) {
  const set = sessionAllows.get(String(tool || ''));
  if (!!set && set.has(String(pattern ?? ''))) return true;
  const grants = onceGrants.get(String(tool || ''));
  return !!grants && grants.has(String(pattern ?? ''));
}

/** 命令前缀（参数模式）：前两个空白分隔 token，小写归一 —— always-session 的比对粒度 */
export function commandPrefix(cmd) {
  return String(cmd || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((t) => t.toLowerCase()).join(' ');
}

// ---- 主机台账 ----
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']); // 本机默认放行（§2：动态目标默认仅本机）

/** host 归一：取 hostname（小写、去端口）；接受裸 host / host:port / 完整 URL；IPv6 归一为 [::1] 形式 */
function normalizeHost(host) {
  let s = String(host || '').trim().toLowerCase();
  if (!s) return null;
  if (s === '::1') s = '[::1]';
  try {
    const u = new URL(s.includes('://') ? s : 'http://' + s);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname || null;
  } catch { return null; }
}

/** 确认主机（动态测试页勾选 / confirm-host IPC 写台账）；非法输入返回 false（不写入） */
export function confirmHost(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  confirmedHosts.add(h);
  return true;
}

/** fail-closed 校验：本机默认放行，其余必须在台账 */
export function assertHost(host) {
  const h = normalizeHost(host);
  if (!h) throw new Error('无效主机名');
  if (LOCAL_HOSTS.has(h) || confirmedHosts.has(h)) return h;
  throw new Error(`目标 ${h} 不在已确认名单：请先在动态测试页确认该目标（或使用 localhost）`);
}

// ---- 目录台账 ----
function normalizeDir(dir) {
  const s = String(dir || '').trim();
  if (!s) return null;
  try { return path.resolve(s); } catch { return null; }
}

/** 确认目录（confirm-dir IPC 写台账） */
export function confirmDir(dir) {
  const d = normalizeDir(dir);
  if (!d) return false;
  confirmedDirs.add(d);
  return true;
}

/** fail-closed 校验目录：必须在台账（相对路径先归一为绝对路径） */
export function assertDir(dir) {
  const d = normalizeDir(dir);
  if (!d || !confirmedDirs.has(d)) throw new Error('目录不在已确认名单：请先确认该目录');
  return d;
}

/**
 * 动态目标（口头确认语义，用户定案 2026-11-07）：只解析 URL + 协议白名单（http/https），
 * 目标记录进台账但不拦截——用户在对话里给出目标或口头同意即为授权。
 * MCP 出口另有 localhost 锁（不同战线）。
 */
export function noteTarget(urlStr) {
  let u;
  try { u = new URL(String(urlStr || '')); } catch { throw new Error('无效 URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('仅允许 http/https');
  confirmedHosts.add(u.hostname); // 只记账不拦截
  return u;
}

// ---- 测试/调试辅助 ----
export function getLedger() {
  return {
    confirmedHosts: [...confirmedHosts],
    confirmedDirs: [...confirmedDirs],
    sessionAllows: Object.fromEntries([...sessionAllows].map(([k, v]) => [k, [...v]]))
  };
}

export function resetLedger() {
  confirmedHosts.clear();
  confirmedDirs.clear();
  sessionAllows.clear();
  onceGrants.clear();
  for (const [, e] of pending) { clearTimeout(e.timer); e.resolve('rejected'); }
  pending.clear();
  setApprovalEmitter(null);
  setApprovalTimeout(120000);
  setPermissionHook(null);
}
