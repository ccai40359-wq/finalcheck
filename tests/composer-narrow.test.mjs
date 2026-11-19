// 输入框工具条：只放图标，不显示文字（用户定的形态，对齐参考 UI）。
//
// 起因（2026-11-19 截图）：输入框被挤窄后 "Full access" / "Type / for skills"
// 折成两三行，工具条从 36px 涨到 50px。
// 定案不是「截断成 …」，而是工具条只留图标，文字收进悬浮菜单。
// ⚠️ 只改输入框工具条，其他 UI 一律不动。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const composer = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/Composer.jsx'), 'utf8');
const css = readFileSync(path.join(repoRoot, 'desktop/src/renderer/styles.css'), 'utf8');
const icons = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/Icons.jsx'), 'utf8');

test('工具条只有图标：权限按钮不显示文字', () => {
  // 权限按钮里不该再有 完全权限 / 标准审批 的文字节点
  const permBlock = composer.slice(composer.indexOf('menu === \'perm\''), composer.indexOf('menu === \'perm\'') + 1400);
  assert.ok(!/完全权限/.test(permBlock) || /title=/.test(permBlock), '权限文字应只在 title 里');
  assert.match(permBlock, /aria-label=/, '纯图标按钮必须有 aria-label（无障碍）');
});

test('模型入口是图标按钮，不显示模型名', () => {
  assert.match(composer, /data-ui="model-menu-trigger"/);
  assert.match(composer, /<IconCube \/>/);
  // 触发按钮内不应出现 activeModel 文本渲染
  const btn = composer.slice(composer.indexOf('data-ui="model-menu-trigger"') - 400, composer.indexOf('data-ui="model-menu-trigger"') + 500);
  assert.ok(!/<span[^>]*>\{activeModel/.test(btn), '图标按钮里不该渲染模型名');
});

test('模型名与思考强度移进悬浮菜单（否则用户不知道当前用哪个模型）', () => {
  assert.match(composer, /truncate min-w-0">\{activeModel \|\| t\('未配置模型'\)\}/);
  assert.match(composer, /\{effortLabel\}/);
});

test('「输入 / 选技能」提示已移除（不再是文字条）', () => {
  // 只检查是否还有把它渲染成界面文本的地方（注释里提到历史不算）
  assert.ok(!/t\('输入 \/ 选技能'\)/.test(composer), '提示文字应从工具条里删掉');
  assert.ok(!/\{compacting \? t\('压缩中…'\)/.test(composer), '压缩提示文字也不该留在工具条');
  assert.ok(!/fc-hint-line/.test(css), '对应 CSS 也应清理');
});

test('IconCube 图标存在且可复用', () => {
  assert.match(icons, /export function IconCube\(/);
});

test('工具条强制单行（图标形态下仍然不让它换行变形）', () => {
  assert.match(css, /\.fc-composer-bar\s*\{\s*flex-wrap:\s*nowrap;\s*min-width:\s*0;\s*\}/);
  assert.match(css, /\.fc-composer-bar > \*\s*\{\s*flex-shrink:\s*0;\s*min-width:\s*0;\s*\}/);
});
