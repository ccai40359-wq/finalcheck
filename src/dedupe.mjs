// 跨副本去重：打包产物里往往带一份完整源码（desktop/release-*/win-unpacked/resources/src/app.js），
// 同一行代码会被每条检查各报一遍。这里按「检查/规则 + 归一化相对路径 + 行号」合并，
// 并优先保留真实源码路径；只有整组都找不到真实源码时才保留副本，并写 warning 说明。
//
// 归一化只负责「副本 → 原件」的映射，不改任何判定逻辑：
//   desktop/release-0110/win-unpacked/resources/src/app.js  →  src/app.js
//   release-x/win-unpacked/src/app.js                       →  src/app.js
//   desktop/release-0110/resources/src/app.js               →  src/app.js

const UNPACKED_RE = /(?:^|\/)[^/]+-unpacked\/(?:resources\/)?(.+)$/;
const RELEASE_RESOURCES_RE = /(?:^|\/)(?:release|release-[A-Za-z0-9._-]+)\/resources\/(.+)$/i;

function normalizeSlashes(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

// 返回归一化后的相对路径；不是打包副本时原样返回（含 Windows 分隔符统一后的形式）
export function normalizeCopyPath(file) {
  const p = normalizeSlashes(file);
  const unpacked = UNPACKED_RE.exec(p);
  if (unpacked) return unpacked[1];
  const release = RELEASE_RESOURCES_RE.exec(p);
  if (release) return release[1];
  return p;
}

export function isPackagedCopyPath(file) {
  const p = normalizeSlashes(file);
  return normalizeCopyPath(p) !== p;
}

/**
 * 合并跨副本重复发现。
 * @param {Array<{checkId?:string, rule?:string, file?:string, line?:number}>} findings
 * @returns {{findings:Array, warnings:string[], removed:number, copiesOnly:number}}
 */
export function dedupeCrossCopies(findings) {
  const groups = new Map();
  for (const f of findings || []) {
    const norm = normalizeCopyPath(f.file);
    const key = `${f.checkId || ''}|${f.rule || ''}|${norm}|${f.line ?? 0}`;
    const group = groups.get(key);
    if (group) group.push(f);
    else groups.set(key, [f]);
  }

  const kept = [];
  const copyOnlyPaths = [];
  let removed = 0;
  let copiesOnly = 0;
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const real = group.find((f) => !isPackagedCopyPath(f.file));
    const chosen = real || group[0];
    removed += group.length - 1;
    if (!real) {
      copiesOnly++;
      copyOnlyPaths.push(normalizeSlashes(chosen.file));
    }
    kept.push(chosen);
  }

  const warnings = [];
  if (removed) {
    warnings.push(`去重：合并 ${removed} 条跨副本重复发现（同一检查/规则/归一化路径/行号只保留一条，优先真实源码）`);
  }
  if (copiesOnly) {
    warnings.push(`去重：${copiesOnly} 组发现只存在于打包副本（无对应真实源码），保留副本路径：${copyOnlyPaths.slice(0, 3).join('、')}${copyOnlyPaths.length > 3 ? '…' : ''}`);
  }
  return { findings: kept, warnings, removed, copiesOnly };
}
