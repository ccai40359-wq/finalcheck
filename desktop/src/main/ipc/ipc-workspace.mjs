import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dialog, shell, clipboard } from 'electron';
import * as sessions from '../sessions.mjs';
import { t } from '../../renderer/i18n/core.mjs';
import { assertArtifactPath } from '../artifact-gate.mjs';

// ---- 附件 / 产物预览（右侧面板） ----
export function registerWorkspaceIpc({ ipcMain, getWin, getDataRoot, imageMime, store }) {
  const attachDir = () => path.join(getDataRoot(), 'attachments');

  ipcMain.handle('finalcheck:pick-files', async () => {
    const r = await dialog.showOpenDialog(getWin(), { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('finalcheck:attachment:save', async (_e, payload = {}) => {
    const name = String(payload.name || 'attachment').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-80);
    const b64 = String(payload.dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error(t('附件为空'));
    if (buf.length > 20 * 1024 * 1024) throw new Error(t('附件过大（上限 20MB）'));
    await mkdir(attachDir(), { recursive: true });
    const file = path.join(attachDir(), `${Date.now()}-${randomUUID().slice(0, 6)}-${name}`);
    await writeFile(file, buf);
    return { path: file, name, size: buf.length };
  });
  ipcMain.handle('finalcheck:artifact:read', async (_e, p) => {
    // 敏感路径闸：%APPDATA%\FinalCheck（config.json）、~/.ssh、私钥名一律拒绝
    const gate = assertArtifactPath(p);
    if (!gate.ok) return { kind: 'missing', path: gate.path, name: path.basename(gate.path), error: gate.reason };
    const abs = gate.path;
    let st;
    try { st = await stat(abs); } catch (e) {
      // 产物可能在会话之后被移动/删除（agent 的临时文件很常见）：给可读提示，不把 ENOENT 原样抛给渲染层
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { kind: 'missing', path: abs, name: path.basename(abs), error: t('文件已不存在（可能已被删除或移动）') };
      throw e;
    }
    if (!st.isFile()) return { kind: 'missing', path: abs, name: path.basename(abs), error: t('不是文件') };
    if (st.size > 15 * 1024 * 1024) throw new Error(t('文件过大（上限 15MB）'));
    const ext = path.extname(abs).toLowerCase();
    const mime = imageMime[ext];
    if (mime) return { kind: 'image', path: abs, name: path.basename(abs), size: st.size, dataUrl: `data:${mime};base64,${(await readFile(abs)).toString('base64')}` };
    if (ext === '.html' || ext === '.htm') return { kind: 'html', path: abs, name: path.basename(abs), size: st.size, content: await readFile(abs, 'utf8') };
    if (ext === '.pdf') return { kind: 'pdf', path: abs, name: path.basename(abs), size: st.size, dataUrl: `data:application/pdf;base64,${(await readFile(abs)).toString('base64')}` };
    if (['.txt', '.md', '.json', '.js', '.mjs', '.css', '.csv', '.log', '.xml', '.yml', '.yaml'].includes(ext)) return { kind: 'text', path: abs, name: path.basename(abs), size: st.size, content: await readFile(abs, 'utf8') };
    throw new Error(t('不支持预览的类型：{ext}', { ext }));
  });
  ipcMain.handle('finalcheck:artifact:open', async (_e, p) => {
    const gate = assertArtifactPath(p);
    if (!gate.ok) return gate.reason;
    return shell.openPath(gate.path);
  });
  ipcMain.handle('finalcheck:clipboard:write', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

  // 手动 /compact（dsh 式）：把会话压成摘要，后续请求只带摘要+最近 6 条，UI 历史保留
  // 进行中/结束各推一个事件给渲染层（只用于显示「正在压缩上下文…」，不落库）。
  const compactAborts = new Map(); // sessionId → AbortController（正在跑的手动压缩，供「停止」中断）
  const emitCompact = (sessionId, ev) => {
    try { getWin()?.webContents.send('finalcheck:agent-event', { sessionId, ev }); } catch { /* 窗口已关也继续压缩 */ }
  };
  ipcMain.handle('finalcheck:compact-cancel', (_e, sessionId) => {
    const ctl = compactAborts.get(String(sessionId ?? ''));
    if (!ctl) return { ok: false };
    ctl.abort();
    return { ok: true };
  });
  ipcMain.handle('finalcheck:compact-session', async (_e, sessionId) => {
    const cfg = await store.loadConfig();
    const prov = store.pickActiveProvider(cfg);
    if (!prov) return { error: t('尚未配置模型供应商') };
    const s = await sessions.loadSession(sessionId);
    // 2026-11-17（规格 §4 步 5）：这里不再截断。
    // 旧代码 `.slice(-30000)` = 只保留最后 3 万字符（保尾丢头），
    // 而跨轮摘要那边用的是 slice(0, maxChars)（保头丢尾）—— 同一上限、两个相反口径，
    // 必有一个是错的。现在整段交给 summarizeWithProvider，超长时它会分块逐段摘要再合并，
    // 头尾都覆盖。
    // 已有会话摘要时只压「旧摘要 + 切分点之后的新消息」（2026-11-17 优化）：
    // 旧实现每次 /compact 都把全部历史从头再摘要一遍，会话越长越慢、越贵，越容易超时。
    // 切分点之前的内容已经在旧摘要里，原文也仍在库里（压缩只改发给模型的视图）。
    const prevCut = s.summary ? (Number(s.summaryAt) || 0) : 0;
    const included = (s.messages || []).filter((m) => (m.role === 'user' || m.role === 'assistant')
      && !(prevCut > 0 && Number.isFinite(Number(m?.at)) && Number(m.at) < prevCut));
    const text = [
      ...(prevCut > 0 ? [`[此前对话摘要]\n${String(s.summary)}`] : []),
      ...included.map((m) => `[${m.role}] ${String(m.content || '')}`)
    ].join('\n');
    // 切分点 = 摘要实际覆盖到的最后一条消息时间 + 1（2026-11-17 修复）。
    // 旧实现用「摘要写入时刻」切：压缩要跑几十秒，期间新到的消息时间早于写入时刻、
    // 却不在摘要输入里 → 下一轮既不在摘要里也不在历史里，凭空消失。
    const startedAt = Date.now();
    const lastAt = included.reduce((mx, m) => Math.max(mx, Number(m?.at) || 0), 0);
    const cutAt = lastAt > 0 ? lastAt + 1 : (prevCut > 0 ? prevCut : startedAt);
    if (!text.trim()) return { error: t('没有可压缩的对话') };
    const key = String(sessionId ?? '');
    const ctl = new AbortController();
    compactAborts.set(key, ctl);
    emitCompact(sessionId, { kind: 'compact-start', scope: 'manual', before: text.length });
    try {
      const summary = await store.summarizeWithProvider(prov, text, { signal: ctl.signal });
      await sessions.saveSummary(sessionId, summary, { cutAt });
      await sessions.appendNotice(sessionId, t('上下文已压缩：{before} 字符 → 摘要 {after} 字符；后续请求带摘要 + 压缩之后新增的全部消息（历史继续正常累积）。', { before: text.length, after: summary.length }), 'compact');
      emitCompact(sessionId, { kind: 'compact-end', scope: 'manual', before: text.length, after: summary.length });
      return { ok: true, summary, before: text.length, after: summary.length };
    } catch (e) {
      if (ctl.signal.aborted) {
        emitCompact(sessionId, { kind: 'compact-end', scope: 'manual', before: text.length, cancelled: true });
        return { cancelled: true };
      }
      emitCompact(sessionId, { kind: 'compact-end', scope: 'manual', before: text.length, error: e?.message || String(e) });
      // reason：给渲染层的短原因（事件里已带原文，界面用 reason 拼「压缩失败：…」，避免前缀重复）
      return { error: t('压缩失败：{msg}', { msg: e.message }), reason: e?.message || String(e) };
    } finally {
      if (compactAborts.get(key) === ctl) compactAborts.delete(key);
    }
  });
}
