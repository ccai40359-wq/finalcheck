// 手机访问的网页：把桌面端界面原样打包成网页 → out/mobile/（主进程的手机访问服务从这里发静态文件）
// 'electron' 换成 src/mobile/bridge-electron.mjs：window.finalcheck 的每个调用走 HTTP 到同一个主进程，事件走 SSE。
// electron-vite build 结束时自动跑（见 electron.vite.config.mjs）；也可以单独 node scripts/build-mobile.mjs
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const DESKTOP = path.resolve(import.meta.dirname, '..');
const RENDERER = path.join(DESKTOP, 'src', 'renderer');
const PRELOAD = path.join(DESKTOP, 'src', 'preload', 'index.mjs');
const MOBILE = path.join(DESKTOP, 'src', 'mobile');
const BRIDGE = path.join(MOBILE, 'bridge-electron.mjs');
const ENTRY = path.join(MOBILE, 'entry.mjs');
const OUT = path.join(DESKTOP, 'out', 'mobile');
const slash = (p) => p.replace(/\\/g, '/');

export async function buildMobile({ quiet = false } = {}) {
  const vite = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const version = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8')).version;
  // tailwind 的 content 路径相对当前目录（./src/renderer/**）
  const cwd = process.cwd();
  process.chdir(DESKTOP);
  try {
    const fcMobile = {
      name: 'fc-mobile',
      enforce: 'pre',
      resolveId(id) {
        if (id === '/@fc-entry') return ENTRY;
        // preload 和入口都 import 'electron'：必须是同一份桥（一份连事件流、一份挂监听器就收不到事件）
        if (id === 'electron') return BRIDGE;
        return null;
      },
      transform(code, id) {
        if (slash(id) !== slash(ENTRY)) return null;
        return code.replace("'__FC_PRELOAD__'", JSON.stringify(slash(PRELOAD))).replace("'__FC_MAIN__'", JSON.stringify(slash(path.join(RENDERER, 'main.jsx'))));
      },
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html
          // 桌面端 CSP 是给 file:// 写的；网页版同源请求接口 + SSE，connect-src 'self' 即可
          .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' __FC_SCRIPT_HASHES__; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' data: blob:; connect-src 'self'" />`)
          // maximum-scale=1：iOS 聚焦输入框不整页放大，同时输入框保持桌面字号
          .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />\n    <meta name="apple-mobile-web-app-capable" content="yes" />\n    <meta name="mobile-web-app-capable" content="yes" />\n    <meta name="theme-color" content="#0f0f12" />')
          .replace('<script type="module" src="/main.jsx"></script>', '<script type="module" src="/@fc-entry"></script>')
      }
    };
    // 首屏主题脚本是内联的：CSP 按最终产物里的内容哈希放行（浏览器按 LF 算哈希，产物统一成 LF）
    const fcCspHash = {
      name: 'fc-mobile-csp-hash',
      transformIndexHtml: {
        order: 'post',
        handler: (raw) => {
          const html = raw.replace(/\r\n?/g, '\n');
          return html.replace('__FC_SCRIPT_HASHES__', [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
            .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`).join(' '));
        }
      }
    };
    await vite.build({
      configFile: false,
      root: RENDERER,
      base: './',
      logLevel: quiet ? 'error' : 'warn',
      cacheDir: path.join(os.tmpdir(), 'fc-vite-mobile-cache'),
      plugins: [fcMobile, react(), fcCspHash],
      define: { 'globalThis.__FC_MOBILE_VERSION__': JSON.stringify(version) },
      build: { outDir: OUT, emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4000, rollupOptions: { input: path.join(RENDERER, 'index.html') } }
    });
    fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2));
    if (!quiet) console.log(`[build-mobile] 手机网页 ${version} → out/mobile`);
  } finally {
    process.chdir(cwd);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await buildMobile();
