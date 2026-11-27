import { spawnSync } from 'node:child_process';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// 0.35 手机访问：渲染层打包完顺手把同一套界面打成手机网页（out/mobile），两边永远是同一版界面
function mobileBuild() {
  return {
    name: 'fc-mobile-build',
    apply: 'build',
    async closeBundle() {
      if (process.env.FC_SKIP_MOBILE_BUILD === '1') return;
      // 单独进程跑：在 electron-vite 的构建里嵌套 vite.build 会串用它的配置
      const r = spawnSync(process.execPath, ['scripts/build-mobile.mjs'], { cwd: import.meta.dirname, stdio: 'inherit' });
      if (r.status !== 0) throw new Error('手机网页打包失败（scripts/build-mobile.mjs）');
    }
  };
}

export default defineConfig({
  main: {
    // 引擎（仓库根 src/）、autocannon 与 electron-updater 运行时动态加载，不打包
    build: { rollupOptions: { external: ['autocannon', 'electron-updater', 'better-sqlite3', 'electron', /^node:/] } }
  },
  preload: {
    build: { rollupOptions: { external: ['electron'] } }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), mobileBuild()],
    build: { rollupOptions: { input: 'src/renderer/index.html' } }
  }
});
