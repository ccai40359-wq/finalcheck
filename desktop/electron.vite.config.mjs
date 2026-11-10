import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // 引擎（仓库根 src/）、autocannon 与 electron-updater 运行时动态加载，不打包
    build: { rollupOptions: { external: ['autocannon', 'electron-updater', 'electron', /^node:/] } }
  },
  preload: {
    build: { rollupOptions: { external: ['electron'] } }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { rollupOptions: { input: 'src/renderer/index.html' } }
  }
});
