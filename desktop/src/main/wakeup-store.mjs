// 定时唤醒的持久化（单文件 JSON，放全局数据根，跟会话/配置同一个地方）。
//
// 为什么用 JSON 而不是 SQLite：定时任务数量小（上限 50）、写入频率低（创建/删除/每次运行后），
// 而 SQLite 需要 better-sqlite3（Electron 内可用但纯 Node 测试要 mock）。
// 用 JSON 的好处是**纯 Node 直接测**、可人肉查看/手改、坏档好修。
//
// 为什么原子写（tmp + rename）：断电/崩溃时直接覆写会留下半截 JSON，下次启动读档失败 →
// 所有定时任务静默消失（用户会以为"我设的怎么没了"）。rename 在同一分区上是原子的。
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeItems } from './wakeups.mjs';

const FILE_NAME = 'wakeups.json';

/** 数据根：优先用主进程注入的解析器，其次环境变量，最后 cwd（纯 Node 测试兜底）。 */
function resolveDir(getDataRoot) {
  try {
    const r = typeof getDataRoot === 'function' ? getDataRoot() : null;
    if (typeof r === 'string' && r.trim()) return path.resolve(r.trim());
  } catch { /* 解析器异常按环境变量 */ }
  const env = String(process.env.FINALCHECK_DATA_ROOT || process.env.FINALCHECK_WAKEUPS_DIR || '').trim();
  if (env) return path.resolve(env);
  return process.cwd();
}

export function wakeupFile(getDataRoot) {
  return path.join(resolveDir(getDataRoot), FILE_NAME);
}

/** 读全部任务。文件不存在 = 空列表（不是错误）。坏档 = 空列表 + 备份留证。 */
export async function loadWakeups(getDataRoot) {
  const file = wakeupFile(getDataRoot);
  let raw = '';
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, items: [], file };
    return { ok: false, items: [], file, error: String(e?.message || e) };
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) {
    // 坏档：留一份 .bad 便于排查，然后按空列表继续（宁可丢任务也不要让调度器崩在启动时）
    try { await rename(file, `${file}.bad-${Date.now()}`); } catch { /* 备份失败也不阻塞 */ }
    return { ok: false, items: [], file, error: `存档损坏：${String(e?.message || e)}` };
  }
  const items = sanitizeItems(parsed?.items);
  return { ok: true, items, file };
}

/** 原子写全部任务。 */
export async function saveWakeups(items, getDataRoot) {
  const file = wakeupFile(getDataRoot);
  const dir = path.dirname(file);
  try { await mkdir(dir, { recursive: true }); } catch { /* 已存在 */ }
  const body = JSON.stringify({ version: 1, savedAt: Date.now(), items: sanitizeItems(items) }, null, 2);
  const tmp = `${file}.tmp-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, file);          // 原子替换
    return { ok: true, file, count: (Array.isArray(items) ? items : []).length };
  } catch (e) {
    try { await unlink(tmp); } catch { /* 清不掉就算了 */ }
    return { ok: false, file, error: String(e?.message || e) };
  }
}
