// 打包形态冒烟：模拟 electron-builder 把 desktop/src 复制成 resources/desktop/src，
// 验证 0.31.1 新增的 browser-choice.mjs 及其相对 import（../renderer/i18n/core.mjs）
// 在**仓库外**资源布局下仍然能加载。这类「仓库内全绿、装完就炸」的坑本仓库踩过
// （0.1.8 安装包 ESM 打包 bug：extraResources 只拷了 desktop/src 没拷 package.json）。
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(repoRoot, 'desktop', 'src');
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'fc-pkg-smoke-'));
const dstDir = path.join(tmpRoot, 'resources', 'desktop', 'src');

try {
  cpSync(srcDir, dstDir, { recursive: true, filter: (p) => !p.includes('.mimosa') });

  // ① 文件确实被复制过去（electron-builder extraResources: desktop/src → desktop/src）
  for (const rel of ['main/browser-choice.mjs', 'main/browser-session.mjs', 'renderer/i18n/core.mjs']) {
    assert.ok(existsSync(path.join(dstDir, rel)), `打包后必须存在 ${rel}`);
  }

  // ② 从仓库外的资源目录动态 import：相对 import 必须解析成功（node_modules 缺失也无所谓，
  //    这个模块只依赖 ../renderer/i18n/core.mjs，不依赖 electron）
  const mod = await import(pathToFileURL(path.join(dstDir, 'main', 'browser-choice.mjs')).href);
  assert.equal(typeof mod.decideBrowserChoice, 'function', '打包形态下必须能导出决策函数');
  assert.equal(typeof mod.realEdgeRedirect, 'function');
  assert.equal(typeof mod.parseBrowserChoice, 'function');

  // ③ 行为在资源布局下也正确（不是「能 import 但跑不对」）
  assert.deepEqual(mod.decideBrowserChoice({ hasAskChannel: true, realAvailable: true }),
    { ask: true, mode: '', reason: 'first-use' });
  assert.equal(mod.parseBrowserChoice('长期保留'), 'persistent');
  assert.equal(mod.realEdgeRedirect({ foreground: { process: 'msedge', pid: 7 }, realPid: 7, realConnected: true })?.deniedBy, 'real-edge-redirect');

  // ④ 三选一选项文案在资源布局下也能出来（i18n core 的相对路径没断）
  const opts = mod.choiceOptions({ realAvailable: true });
  assert.equal(opts.length, 3);
  for (const o of opts) assert.ok(o.label.length > 0, 'label 不能为空（相对 import 断了会静默变空）');
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
