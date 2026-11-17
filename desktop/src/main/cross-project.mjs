// 跨项目授权（2026-11-17 规格 §4）。
//
// 核心原则：**模型不能自己决定「这个目录相关，我去改一下」。** 跨项目必须由用户显式触发。
//
// 为什么这样设计：关掉 ACL 沙箱后，唯一的边界是应用层路径闸。如果让模型自由判断
// 「哪个目录相关」，它就等于可以自己扩权——路径闸就废了。所以授权只能来自用户原话。
//
// 触发语义（只有一种）：用户在本轮消息里明确指定了另一个目录，
//   「去改 D:\projectB 里的 xxx」
//   「顺便把 D:\other 的 README 更新一下」
//
// 判定顺序（规格 §4.2）：
//   ① 等于当前项目根            → 无需授权
//   ② 已登记项目（projects.json） → 允许（reason: registered）
//   ③ 用户本轮显式提到           → 允许一次（reason: user-mentioned）
//   ④ 以上都不是                → 不授权（路径闸会拒，并返回人话）
//
// 用途：调用方把 allowed 的路径并进 policy 的 allowPaths，
// 这样 assertPathAllowed / assertCwd / checkCommandPaths / checkDestructiveTargets
// 全部自动认出这些目录（零新增路径逻辑）。
import path from 'node:path';

const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\?[^\\/\s"'|;&<>]+[\\/]|~[\\/]|%USERPROFILE%[\\/])[^\\/\s"'|;&<>]*(?:[\\/][^\\/\s"'|;&<>]*)*/g;

/** 从用户消息里抽绝对路径（容忍反斜杠/正斜杠/~/%USERPROFILE%）。 */
export function extractAbsolutePaths(text, { home = null } = {}) {
  const found = [];
  const s = String(text || '');
  for (const m of s.matchAll(ABS_PATH_RE)) {
    let p = m[0].trim();
    if (!p) continue;
    // 去掉尾部的标点（用户常写「去改 D:\x，然后…」）
    p = p.replace(/[，。！？、,.:;!?]+$/, '');
    if (!p) continue;
    if (p.startsWith('~') || p.startsWith('%USERPROFILE%')) {
      if (!home) continue;
      p = path.join(home, p.replace(/^(~|%USERPROFILE%)/, ''));
    }
    found.push(p);
  }
  return [...new Set(found)];
}

const norm = (p) => path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * 解析本轮允许的跨项目目录。
 * @param {{userMessage?:string, currentRoot?:string, registeredProjects?:Array<{path?:string,name?:string}>, home?:string}} opts
 * @returns {{allowed: Array<{path:string, reason:'registered'|'user-mentioned', name?:string}>, currentRoot:string|null}}
 */
export function resolveCrossProjects({ userMessage = '', currentRoot = null, registeredProjects = [], home = null } = {}) {
  const root = currentRoot ? norm(currentRoot) : null;
  const mentioned = extractAbsolutePaths(userMessage, { home });
  const allowed = [];
  for (const raw of mentioned) {
    const resolved = path.resolve(raw);
    const key = norm(resolved);
    // ① 当前项目（含其子目录）：无需授权
    if (root && (key === root || key.startsWith(root + '/'))) continue;
    // ② 已登记项目：直接允许（用户在项目列表里加过，等于已经授权过这个目录）
    const reg = (Array.isArray(registeredProjects) ? registeredProjects : [])
      .find((x) => x && typeof x.path === 'string' && norm(x.path) === key);
    if (reg) {
      allowed.push({ path: resolved, reason: 'registered', name: String(reg.name || path.basename(resolved) || '') });
      continue;
    }
    // ③ 用户本轮显式提到：允许一次
    allowed.push({ path: resolved, reason: 'user-mentioned' });
  }
  return { allowed, currentRoot: currentRoot ? path.resolve(currentRoot) : null };
}

/**
 * 账本路由（规格 §4.2 后半）：按「实际被写的文件所属项目」决定账本写哪里，
 * 不是按会话所属项目。跨项目写文件时，A 的账本要留一行交叉引用。
 * @param {{absFilePath:string, currentRoot:string|null, extraRoots?:string[]}} opts
 * @returns {{root:string, ledger:string, crossRef:boolean}|null}
 */
export function ledgerFor({ absFilePath, currentRoot = null, extraRoots = [] }) {
  if (!absFilePath) return null;
  const target = norm(absFilePath);
  const roots = [];
  if (currentRoot) roots.push({ root: path.resolve(currentRoot), isCurrent: true });
  for (const r of (Array.isArray(extraRoots) ? extraRoots : [])) {
    if (typeof r !== 'string') continue;
    const resolved = path.resolve(r);
    if (currentRoot && norm(resolved) === norm(currentRoot)) continue;
    roots.push({ root: resolved, isCurrent: false });
  }
  // 最长匹配优先：嵌套项目时取更深的那个
  let best = null;
  for (const { root, isCurrent } of roots) {
    const key = norm(root);
    if (target !== key && !target.startsWith(key + '/')) continue;
    if (!best || key.length > norm(best.root).length) best = { root, isCurrent };
  }
  if (!best) return null;
  return {
    root: best.root,
    ledger: path.join(best.root, '.finalcheck', 'ledger.md'),
    // 改的不是当前项目 → 当前项目的账本需要一行交叉引用
    crossRef: !best.isCurrent
  };
}
