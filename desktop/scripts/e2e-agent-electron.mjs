// 在 Electron 主进程里跑 e2e-agent（截图类工具需要 Electron）：
//   electron desktop/scripts/e2e-agent-electron.mjs --project … --prompt … --out …（参数同 e2e-agent.mjs）
// 需先 npx electron-vite build（截 PDF/视频要用渲染层的 #fc-snapshot 路由）。
import { app, protocol, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { registerMediaScheme, installMediaProtocol } from '../src/main/media-protocol.mjs';
import { setSnapshotRenderer } from '../src/main/capture.mjs';
import { isPreviewAllowed } from '../src/main/preview-allow.mjs';

registerMediaScheme(protocol);
app.on('window-all-closed', () => {}); // 没有主窗口：截图窗口销毁后别自动退出
app.whenReady().then(async () => {
  installMediaProtocol(protocol);
  ipcMain.handle('finalcheck:artifact:bytes', async (_e, p) => {
    if (!isPreviewAllowed(p)) throw new Error('not allowed');
    return new Uint8Array(await readFile(path.resolve(p)));
  });
  const root = path.resolve(import.meta.dirname, '..');
  setSnapshotRenderer({ file: path.join(root, 'out/renderer/index.html'), preload: path.join(root, 'out/preload/index.mjs') });
  try { await import('./e2e-agent.mjs'); } finally { app.quit(); }
});
