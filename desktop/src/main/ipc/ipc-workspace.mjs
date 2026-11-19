import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dialog, shell, clipboard } from 'electron';
import { t } from '../../renderer/i18n/core.mjs';
import { assertArtifactPath } from '../artifact-gate.mjs';
import { OFFICE_EXTS, VIDEO_EXTS, officeToPdf } from '../preview-convert.mjs';
import { allowPreviewFile, isPreviewAllowed } from '../preview-allow.mjs';

// ---- 附件 / 产物预览（右侧面板） ----
export function mediaUrl(abs) {
  return `fc-media://local/${encodeURIComponent(path.resolve(abs))}`;
}

export function registerWorkspaceIpc({ ipcMain, getWin, getDataRoot, imageMime }) {
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
    const ext = path.extname(abs).toLowerCase();
    const base = { path: abs, name: path.basename(abs), size: st.size };
    // 视频：走 fc-media:// 流式协议（支持拖进度条），不整份读进内存，也不受 15MB 上限
    if (VIDEO_EXTS.has(ext)) return { ...base, kind: 'video', mime: VIDEO_EXTS.get(ext), url: mediaUrl(abs) };
    // PDF：分页查看器按需取字节（artifact:bytes），上限放宽到 200MB
    if (ext === '.pdf') {
      if (st.size > 200 * 1024 * 1024) throw new Error(t('文件过大（上限 200MB）'));
      return { ...base, kind: 'pdf', pdfPath: allowPreviewFile(abs) };
    }
    // PPT / Word：本机 LibreOffice 转成 PDF 后同样分页看；没装就明确说
    if (OFFICE_EXTS.has(ext)) {
      const r = await officeToPdf(abs, { cacheDir: path.join(getDataRoot(), 'preview-cache') });
      if (!r.ok) {
        const why = r.reason === 'no-libreoffice'
          ? t('预览 PPT / Word 需要本机安装 LibreOffice（免费）：装好后点「刷新」即可分页预览；也可以先点「外部打开」')
          : r.reason === 'timeout' ? t('转换超时（3 分钟），请点「外部打开」查看')
            : t('转换失败：{detail}', { detail: r.reason });
        return { ...base, kind: 'missing', error: why };
      }
      return { ...base, kind: 'pdf', converted: true, pdfPath: allowPreviewFile(r.pdfPath) };
    }
    if (st.size > 15 * 1024 * 1024) throw new Error(t('文件过大（上限 15MB）'));
    const mime = imageMime[ext];
    if (mime) return { kind: 'image', path: abs, name: path.basename(abs), size: st.size, dataUrl: `data:${mime};base64,${(await readFile(abs)).toString('base64')}` };
    if (ext === '.html' || ext === '.htm') return { kind: 'html', path: abs, name: path.basename(abs), size: st.size, content: await readFile(abs, 'utf8') };
    if (['.txt', '.md', '.json', '.js', '.mjs', '.css', '.csv', '.log', '.xml', '.yml', '.yaml'].includes(ext)) return { kind: 'text', path: abs, name: path.basename(abs), size: st.size, content: await readFile(abs, 'utf8') };
    throw new Error(t('不支持预览的类型：{ext}', { ext }));
  });
  // 分页查看器取 PDF 字节：只给 artifact:read 刚放行过的文件（转换缓存在 %APPDATA%\FinalCheck 下，
  // 普通产物闸会拒绝它，所以用一次性放行表，而不是放宽产物闸）
  ipcMain.handle('finalcheck:artifact:bytes', async (_e, p) => {
    const abs = path.resolve(String(p || ''));
    if (!isPreviewAllowed(abs)) throw new Error(t('该文件未经预览放行'));
    return new Uint8Array(await readFile(abs));
  });
  ipcMain.handle('finalcheck:artifact:open', async (_e, p) => {
    const gate = assertArtifactPath(p);
    if (!gate.ok) return gate.reason;
    return shell.openPath(gate.path);
  });
  ipcMain.handle('finalcheck:clipboard:write', (_e, text) => { clipboard.writeText(String(text || '')); return true; });
  // 手动 /compact 移到 ipc-compact.mjs（0.27：桌面端与测试台共用，走统一的压缩核心）
}
