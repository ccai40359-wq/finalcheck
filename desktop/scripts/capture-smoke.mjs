// capture_screenshot 冒烟（真 Electron）：electron desktop/scripts/capture-smoke.mjs <项目目录> <输出目录>
// 对项目里的 html / pdf / pptx / mp4 各截一张，图片写到输出目录供人工核对。需先 npx electron-vite build。
import { app, protocol, ipcMain } from 'electron';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { registerMediaScheme, installMediaProtocol } from '../src/main/media-protocol.mjs';
import { setSnapshotRenderer } from '../src/main/capture.mjs';
import { isPreviewAllowed } from '../src/main/preview-allow.mjs';
import { createAgentTools } from '../src/main/agent-tools.mjs';

const [project, outDir] = process.argv.slice(-2);
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
  const tools = createAgentTools({ repoRoot: path.resolve(root, '..'), permissions: { sessionAllowed: () => true }, projectPath: project });
  await mkdir(outDir, { recursive: true });
  const cases = [
    ['html', { target: path.join(project, 'card.html'), width: 900, height: 500 }],
    ['pdf-p2', { target: path.join(project, 'deck.pdf'), page: 2, width: 1280 }],
    ['pptx-p4', { target: path.join(project, 'deck.pptx'), page: 4, width: 1280 }],
    ['video-10s', { target: path.join(project, 'promo.mp4'), time: 10, width: 1280 }],
  ];
  for (const [name, args] of cases) {
    const t0 = Date.now();
    const r = await tools.capture_screenshot(args);
    if (r.error) { await appendFile(path.join(outDir, 'log.txt'), `${name} ERROR ${r.error}
`); continue; }
    const im = r.__images[0];
    const file = path.join(outDir, `${name}.${im.mime === 'image/png' ? 'png' : 'jpg'}`);
    await writeFile(file, Buffer.from(im.base64, 'base64'));
    await appendFile(path.join(outDir, 'log.txt'), `${name} ${Date.now() - t0}ms ${r.width}x${r.height} ${r.title} saved=${r.path}
`);
  }
  app.quit();
});
