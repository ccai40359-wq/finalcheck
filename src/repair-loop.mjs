// 修复回路基建（③，2026-11-14 定案）：改前自动快照、可回滚。
// fs-tools 的 edit/write 在写盘前调 snapshotBeforeWrite()，返回 snapshotId 随工具结果带给 agent；
// repair_rollback 工具把指定（或最新）快照写回原文件。快照放统一数据根（不在源码树里产生噪声）。
// 保留策略：同一文件最多 KEEP_PER_FILE 份，超出删最旧——防无限增长。
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const KEEP_PER_FILE = 20;

export function snapshotsRoot() {
  return process.env.FINALCHECK_SNAPSHOTS_DIR || path.join(os.homedir(), '.finalcheck', 'snapshots');
}

function fileKey(abs) {
  // 同一真实文件跨平台/跨盘符表示归并：小写盘符 + 正斜杠
  const norm = String(abs || '').replace(/\\/g, '/');
  return createHash('sha1').update(norm.toLowerCase()).digest('hex').slice(0, 12);
}

async function readIfExists(abs) {
  try {
    return await readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 写盘前快照。文件不存在（新建）返回 { skipped }——回滚语义是「恢复旧内容」，新建文件没有旧内容。
 * @returns {Promise<{snapId: string} | {skipped: string}>}
 */
export async function snapshotBeforeWrite(abs) {
  const before = await readIfExists(abs);
  if (before === null) return { skipped: 'new-file' };
  const key = fileKey(abs);
  const dir = path.join(snapshotsRoot(), key);
  await mkdir(dir, { recursive: true });
  const at = Date.now();
  const snapId = `${at}-${key}`;
  const manifest = { snapId, file: path.resolve(abs), at, content: before };
  await writeFile(path.join(dir, `${snapId}.json`), JSON.stringify(manifest), 'utf8');
  // 保留策略：超出 KEEP_PER_FILE 删最旧（按文件名时间戳排序）
  const all = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort();
  for (const stale of all.slice(0, Math.max(0, all.length - KEEP_PER_FILE))) {
    await unlink(path.join(dir, stale)).catch(() => {});
  }
  return { snapId };
}

/** 列出某文件可回滚的快照（新→旧）。 */
export async function listSnapshots(abs) {
  const key = fileKey(abs);
  const dir = path.join(snapshotsRoot(), key);
  const all = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort().reverse();
  const out = [];
  for (const name of all) {
    try {
      const m = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      out.push({ snapId: m.snapId, at: m.at, chars: (m.content || '').length });
    } catch { /* 单份损坏不影响列表 */ }
  }
  return out;
}

/**
 * 回滚：把指定（缺省最新）快照的内容写回原文件。
 * @returns {Promise<{ok: true, file: string, snapId: string, at: number} | {error: string}>}
 */
export async function rollbackFile(abs, snapId = null) {
  const resolved = path.resolve(String(abs || ''));
  const snaps = await listSnapshots(resolved);
  if (!snaps.length) return { error: '没有可回滚的快照（该文件在本机从未被 FC 编辑过，或快照已被清理）', path: resolved };
  const pick = snapId ? snaps.find((s) => s.snapId === snapId) : snaps[0];
  if (!pick) return { error: `快照不存在：${snapId}`, available: snaps.map((s) => s.snapId) };
  const manifestPath = path.join(snapshotsRoot(), fileKey(resolved), `${pick.snapId}.json`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    return { error: `快照读取失败：${e.message}` };
  }
  const target = path.resolve(manifest.file || resolved);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, manifest.content, 'utf8');
  return { ok: true, file: target, snapId: pick.snapId, at: manifest.at };
}
