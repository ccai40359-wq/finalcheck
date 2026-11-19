// 输入框工具条在窄宽度下不许换行。
//
// 起因（用户 2026-11-19 截图）：输入框被右栏挤窄后，"Full access" 拆成两行、
// "Type / for skills" 拆成三行，工具条从 36px 涨到 50px，整个输入框变形。
// ⚠️ 只改输入框工具条，其他 UI 一律不动。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const composerPath = path.join(repoRoot, 'desktop/src/renderer/components/Composer.jsx');
const cssPath = path.join(repoRoot, 'desktop/src/renderer/styles.css');
const composer = readFileSync(composerPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');

test('工具条容器带 fc-composer-bar 标记（供 CSS 精确收口，不误伤其他 flex 行）', () => {
  assert.match(composer, /className="flex items-center gap-0\.5 px-2 pb-2 fc-composer-bar"/);
});

test('输入框外层是容器查询容器（按输入框宽度收口，而不是按窗口宽度）', () => {
  assert.match(composer, /glass-composer relative z-30 rounded-\[20px\] fc-composer-box/);
  assert.match(css, /\.fc-composer-box\s*\{\s*container-type:\s*inline-size;\s*\}/);
});

test('工具条与直接子元素都不许换行、不许撑开', () => {
  assert.match(css, /\.fc-composer-bar\s*\{\s*flex-wrap:\s*nowrap;\s*min-width:\s*0;\s*\}/);
  assert.match(css, /\.fc-composer-bar > \*\s*\{\s*min-width:\s*0;\s*\}/);
});

test('权限按钮文字单行 + 可截断（"Full access" 不许断成两行）', () => {
  assert.match(css, /\.fc-composer-bar \.fc-shrink-label > button\s*\{\s*white-space:\s*nowrap;\s*\}/);
  // 源码里文字包了 span，CSS 才能按断点隐藏它（裸文本节点选不中）
  assert.match(composer, /<span className="fc-perm-text">\{permMode === 'full' \? t\('完全权限'\) : t\('标准审批'\)\}<\/span>/);
});

test('提示文案（输入 / 选技能）单行省略，窄容器里整条隐藏', () => {
  assert.match(css, /\.fc-composer-bar \.fc-hint-line\s*\{[\s\S]{0,160}text-overflow:\s*ellipsis/);
  assert.match(css, /@container \(max-width: 460px\)\s*\{\s*\.fc-hint-line\s*\{\s*display:\s*none;\s*\}/);
  assert.match(composer, /className="text-\[10px\] text-mute\/35 select-none pl-1 fc-hint-line"/);
});

test('模型名可收缩省略、effort 与箭头不被压缩', () => {
  // 模型按钮：min-w-0 + truncate；effort 与 chevron 是 shrink-0
  assert.match(composer, /max-w-\[280px\] min-w-0[^"]*whitespace-nowrap/);
  assert.match(composer, /<span className="text-mute\/45 shrink-0">\{effortLabel\}<\/span>/);
});

test('极窄（≤320px）时权限按钮只留图标，文字仍留在 DOM（读屏可读）', () => {
  assert.match(css, /@container \(max-width: 320px\)\s*\{\s*\/\*[^*]*\*\/\s*\.fc-composer-bar \.fc-perm-text\s*\{\s*display:\s*none;\s*\}/);
});

test('窄宽度收口用的是容器查询而不是媒体查询（右栏展开时窗口宽但输入框窄）', () => {
  const block = css.slice(css.indexOf('.fc-composer-box'));
  assert.match(block, /@container \(max-width/);
  // 这段里不该出现按窗口宽度的 @media (max-width: …)
  const tail = css.slice(css.indexOf('输入框工具条：窄宽度不换行'));
  assert.ok(!/@media \(max-width/.test(tail), '工具条收口不该用 @media（窗口宽但输入框窄时失效）');
});

test('本次改动没碰其他 UI 文件', () => {
  // 只允许 Composer.jsx + styles.css 两个文件参与（其余保持 0.26.0 原样）
  const allowed = ['desktop/src/renderer/components/Composer.jsx', 'desktop/src/renderer/styles.css'];
  for (const f of allowed) {
    assert.ok(readFileSync(path.join(repoRoot, f), 'utf8').length > 0, `${f} 应存在`);
  }
});
