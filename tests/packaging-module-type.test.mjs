// 打包后模块类型回归（2026-11-11 现场报错）：
//   安装版首发消息报 `Named export 'EN_APP' not found. The requested module './en/app.js'
//   is a CommonJS module`。根因不是业务代码，是 **打包副本里 .js 的模块类型没被声明**：
//   - 仓库根 package.json 有 "type":"module"，所以开发/测试永远是 ESM；
//   - extraResources 把 desktop/src 复制到 resources/desktop/src，那一棵树上没有 package.json，
//     Node 只能「猜」；一旦环境把 .js 判成 CommonJS（存在 type:commonjs 边界或关闭探测），
//     core.mjs 静态 import 的 en/*.js 立刻变成 CJS，named export 全部失效。
// 修法：desktop/src/package.json 显式 "type":"module"，跟着 extraResources 一起进包。
// 这个测试用「type:commonjs 的外层边界」复现坏环境，证明修法有效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const srcRoot = path.join(repo, 'desktop', 'src');

test('desktop/src 必须显式声明 type:module（否则打包后 .js 词典会被判成 CJS）', async () => {
  const pkg = JSON.parse(await readFile(path.join(srcRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module', 'desktop/src/package.json 必须写 "type":"module"');
});

test('坏环境（外层 type:commonjs）下，i18n 词典仍能按 ESM 加载', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fc-modtype-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // 外层包边界故意声明 commonjs：模拟真实安装目录里「祖先 package.json 说 CJS」的情况
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf8');
  const appSrc = path.join(root, 'src');
  await mkdir(appSrc, { recursive: true });
  await cp(path.join(srcRoot, 'package.json'), path.join(appSrc, 'package.json'));
  await cp(path.join(srcRoot, 'renderer', 'i18n'), path.join(appSrc, 'renderer', 'i18n'), { recursive: true });

  const url = pathToFileURL(path.join(appSrc, 'renderer', 'i18n', 'core.mjs')).href;
  const mod = await import(url);
  assert.equal(typeof mod.t, 'function', 'core.mjs 必须能被加载');
  assert.equal(mod.t('共 {n} 条', { n: 3 }), '共 3 条', '中文模式逐字返回');
  mod.setLanguage('en');
  assert.equal(mod.t('最小化'), 'Minimize', '英文词典（en/app.js）必须真的被加载');
});
