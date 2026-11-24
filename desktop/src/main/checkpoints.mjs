// 文件检查点回退（0.33.0，对齐 Claude Code 的「恢复代码」）：
// 把 AI 在「某条用户消息之后」用 edit_file / write_file 改过的文件，恢复成那条消息发出时的样子。
//
// 数据来源全是已有的东西，不新增存储：
//   · 会话里每条 assistant 消息的 trace（工具名 + 参数 + 结果）
//   · edit_file / write_file 写盘前的快照（src/repair-loop.mjs，结果里带 snapshotId；新建文件带 created:true）
//
// 规则（每个文件看「被回退的那段里第一次改它」）：
//   · 第一次是覆盖已有文件 → 用那次的快照恢复（= 改之前的内容）
//   · 第一次是新建文件     → 删除（回到不存在）
//   · 快照找不到（被清理 / 那次快照失败）→ 列为「无法恢复」，不碰它
// 不在范围内（界面上会说明）：run_command / 子代理 / 工作流 / 你自己手改的文件。
import path from 'node:path';
import { readFile, unlink, stat } from 'node:fs/promises';
import { listSnapshots, rollbackFile } from '../../../src/repair-loop.mjs';

const WRITE_TOOLS = new Set(['edit_file', 'write_file']);

function parseMaybe(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v); } catch { return null; }
}

/** trace 里一次写文件调用 → { path, snapshotId, created } ；失败的调用 / 认不出的返回 null */
export function fileChangeOf(tr) {
  const tool = String(tr?.tool ?? tr?.name ?? '');
  if (!WRITE_TOOLS.has(tool)) return null;
  if (tr?.error || (typeof tr?.status === 'string' && tr.status !== 'success')) return null;
  let res = parseMaybe(tr?.result);
  if (res?.truncated) {
    // 超长结果只存了预览：从内联文本里把关键字段捞出来
    const text = String(res.inline || res.preview || '');
    const snap = text.match(/"snapshotId"\s*:\s*"([^"]+)"/);
    const p = text.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    res = { path: p ? JSON.parse(`"${p[1]}"`) : null, snapshotId: snap ? snap[1] : null, created: /"created"\s*:\s*true/.test(text) };
  }
  if (!res || res.error) return null;
  const args = parseMaybe(tr?.args) || {};
  const p = res.path || args.path;
  if (!p) return null;
  return { path: path.resolve(String(p)), snapshotId: res.snapshotId || null, created: res.created === true };
}

/** 第 keepUserTurns 个用户回合之后的消息（与 sessions.rewindToUserTurn 同一切法） */
export function messagesAfterTurn(messages, keepUserTurns) {
  const keep = Math.max(0, Math.floor(Number(keepUserTurns) || 0));
  let seen = 0;
  const list = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.role === 'user') {
      if (seen >= keep) return list.slice(i);
      seen += 1;
    }
  }
  return [];
}

/** 纯函数：从被回退的消息算出每个文件该怎么恢复（按第一次改动） */
export function planFromMessages(messages, keepUserTurns) {
  const first = new Map(); // key → change
  let edits = 0;
  for (const m of messagesAfterTurn(messages, keepUserTurns)) {
    if (m?.role !== 'assistant') continue;
    for (const tr of Array.isArray(m.trace) ? m.trace : []) {
      const ch = fileChangeOf(tr);
      if (!ch) continue;
      edits += 1;
      const key = process.platform === 'win32' ? ch.path.toLowerCase() : ch.path;
      if (!first.has(key)) first.set(key, ch);
    }
  }
  const files = [...first.values()].map((ch) => (
    ch.created ? { path: ch.path, action: 'delete' }
      : ch.snapshotId ? { path: ch.path, action: 'restore', snapshotId: ch.snapshotId }
        : { path: ch.path, action: 'unavailable', reason: '那次修改没有留下快照' }
  ));
  return { files, edits };
}

/** 计划 + 可行性检查（快照还在不在、要删的文件还在不在） */
export async function planRewindFiles(messages, keepUserTurns) {
  const plan = planFromMessages(messages, keepUserTurns);
  for (const f of plan.files) {
    if (f.action === 'restore') {
      const snaps = await listSnapshots(f.path).catch(() => []);
      if (!snaps.some((s) => s.snapId === f.snapshotId)) { f.action = 'unavailable'; f.reason = '快照已被清理（每个文件只保留最近 20 份）'; }
    } else if (f.action === 'delete') {
      const exists = await stat(f.path).then((s) => s.isFile()).catch(() => false);
      if (!exists) { f.action = 'noop'; f.reason = '文件已经不在了'; }
    }
  }
  return plan;
}

/** 执行恢复；逐个文件报告结果（一个失败不影响其它） */
export async function applyRewindFiles(plan) {
  const results = [];
  for (const f of plan?.files || []) {
    try {
      if (f.action === 'restore') {
        const r = await rollbackFile(f.path, f.snapshotId);
        results.push(r?.ok ? { path: f.path, ok: true, action: 'restored' } : { path: f.path, ok: false, error: r?.error || '恢复失败' });
      } else if (f.action === 'delete') {
        await unlink(f.path);
        results.push({ path: f.path, ok: true, action: 'deleted' });
      } else {
        results.push({ path: f.path, ok: f.action === 'noop', action: f.action, ...(f.reason ? { reason: f.reason } : {}) });
      }
    } catch (e) {
      results.push({ path: f.path, ok: false, error: String(e?.message || e) });
    }
  }
  return { results, restored: results.filter((r) => r.action === 'restored').length, deleted: results.filter((r) => r.action === 'deleted').length, failed: results.filter((r) => !r.ok).length };
}

// 给测试 / 诊断用：读文件文本（不存在返回 null）
export async function readTextOrNull(p) { try { return await readFile(p, 'utf8'); } catch { return null; } }
