// 探针：最小可复现，看 electron 能不能起
import { app, BrowserWindow } from 'electron';
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 600, height: 400, show: true });
  w.loadURL('data:text/html,<h1>hello</h1>');
  console.log('WINDOW_CREATED');
});
process.on('uncaughtException', (e) => console.error('UNCAUGHT', e));
