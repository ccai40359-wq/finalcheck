// 输入框工具条：宽时显示模型名，窄到装不下才缩成方块图标。
//
// 用户定案（2026-11-19）：默认必须看得见模型名；只有输入框被压窄
// （右栏展开 / 窗口缩小）到装不下名字时，才退化成方块图标。
// 「一上来就只给图标」是错的——用户不知道自己在用哪个模型。
// ⚠️ 只改输入框工具条，其他 UI 一律不动。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const composer = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/Composer.jsx'), 'utf8');
const css = readFileSync(path.join(repoRoot, 'desktop/src/renderer/styles.css'), 'utf8');
const icons = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/Icons.jsx'), 'utf8');

const cssTail = css.slice(css.indexOf('输入框工具条：宽时显示模型名'));

test('宽态结构与窄态结构都在 DOM 里（由 CSS 按宽度切换，不用 JS 量宽）', () => {
  assert.match(composer, /className="fc-model-full inline-flex items-center gap-1\.5 whitespace-nowrap min-w-0"/);
  assert.match(composer, /className="fc-model-icon items-center justify-center"/);
});

test('宽态显示 模型名 + 思考强度 + 箭头', () => {
  const lines = composer.split(/\r?\n/);
  const wideStart = lines.findIndex((l) => l.includes('className="fc-model-full'));
  const wideEnd = lines.findIndex((l) => l.includes('className="fc-model-icon'));
  assert.ok(wideStart > 0 && wideEnd > wideStart, '找不到宽/窄两态的 JSX 行');
  const wide = lines.slice(wideStart, wideEnd).join('\n');
  assert.match(wide, /\{activeModel \|\| t\('未配置模型'\)\}/, '宽态必须有模型名');
  assert.match(wide, /\{effortLabel\}/, '宽态必须有思考强度');
});

test('窄态是立方体图标', () => {
  assert.match(composer, /<IconCube \/>/);
  assert.match(icons, /export function IconCube\(/);
});

test('默认宽态：方块隐藏；窄容器（≤520px）才反向切换', () => {
  assert.match(cssTail, /\.fc-composer-bar \.fc-model-icon \{ display: none; \}/);
  assert.match(cssTail, /@container \(max-width: 520px\)\s*\{[\s\S]{0,240}\.fc-model-full \{ display: none; \}[\s\S]{0,160}\.fc-model-icon \{ display: inline-flex; \}/);
});

test('切换依据是输入框自身宽度（容器查询），不是窗口宽度', () => {
  assert.match(cssTail, /\.fc-composer-box \{ container-type: inline-size; \}/);
  assert.match(composer, /glass-composer relative z-30 rounded-\[20px\] fc-composer-box/);
  assert.ok(!/@media \(max-width/.test(cssTail), '不该用 @media（右栏展开时窗口宽但输入框窄）');
});

test('工具条单行：任何宽度都不折行', () => {
  assert.match(cssTail, /\.fc-composer-bar \{ flex-wrap: nowrap; min-width: 0; \}/);
  assert.match(cssTail, /\.fc-composer-bar > \* \{ flex-shrink: 0; min-width: 0; \}/);
  assert.match(cssTail, /\.fc-composer-bar \.fc-model-btn \{ max-width: 280px; \}/, '宽态也要限宽，超长模型名截断而不是撑爆');
});

test('无障碍：纯图标态仍有可读标签', () => {
  assert.match(composer, /aria-label=\{t\('模型与思考强度'\)\}/);
  assert.match(composer, /title=\{`\$\{activeModel \|\| t\('未配置模型'\)\} · \$\{effortLabel\}`\}/);
});

test('权限按钮是纯图标（用户既定形态）', () => {
  const perm = composer.slice(composer.indexOf("menu === 'perm'"), composer.indexOf("menu === 'perm'") + 900);
  assert.match(perm, /aria-label=/, '纯图标按钮必须有 aria-label');
  assert.ok(!/>\s*\{permMode === 'full' \? t\('完全权限'\)/.test(perm), '权限按钮内不该渲染文字');
});
