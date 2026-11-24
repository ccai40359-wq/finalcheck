// 0.32.8 深色主题重做的回归闸门：防止「满屏金字」回潮。
// 规则：.md 基础规则里，正文 / 加粗 / 标题 / 行内代码 / 表头不许引用金色变量；
// 金色只留给链接（可点 = 有颜色）。浅色主题的金色楷书标题走单独的覆盖块，不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const css = readFileSync(path.join(root, 'desktop/src/renderer/styles.css'), 'utf8');

/** 取某个选择器（精确匹配、不带主题前缀）的声明体 */
const ruleBody = (selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)${esc}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  assert.ok(m, `找不到规则：${selector}`);
  return m[2];
};

test('dark 0.32.8: 正文/加粗/标题/行内代码/表头不用金色', () => {
  for (const sel of ['.md', '.md strong', '.md h1, .md h2, .md h3, .md h4, .md h5, .md h6', '.md code', '.md th']) {
    assert.doesNotMatch(ruleBody(sel), /--fc-gold/, `${sel} 又用回了金色`);
  }
  assert.match(ruleBody('.md a'), /--fc-gold/, '链接应保留琥珀强调');
});

test('dark 0.32.8: 深色正文是中性色，不是偏黄的宣纸白', () => {
  const root0 = css.slice(css.indexOf(':root {'), css.indexOf('[data-theme="light"] {'));
  const [r, _g, b] = root0.match(/--fc-ink:\s*(\d+) (\d+) (\d+)/).slice(1).map(Number);
  assert.ok(r - b <= 8, `ink 偏黄（R-B=${r - b}）`);
  const [br, bg, bb] = root0.match(/--fc-base:\s*(\d+) (\d+) (\d+)/).slice(1).map(Number);
  assert.ok(Math.min(br, bg, bb) >= 14, '画布不应是纯黑（层次面拉不开）');
});

test('dark 0.32.8: 字体走主题变量；浅色保留宋体正文 + 楷体标题', () => {
  assert.match(ruleBody('body'), /font-family:\s*var\(--ui-font-body\)/);
  const light = css.slice(css.indexOf('[data-theme="light"] {'), css.indexOf('html, body, #root'));
  assert.match(light, /--ui-font-body:[^;]*Noto Serif SC/);
  assert.match(light, /--ui-font-heading:[^;]*KaiTi/);
  assert.match(css, /\[data-theme="light"\] \.md h1[^{]*\{[^}]*--fc-gold-soft/, '浅色标题应保持金色');
});

test('dark 0.32.8: 代码禁用连字，列表符号恢复', () => {
  assert.match(css, /code, kbd, samp, pre \{[^}]*font-variant-ligatures:\s*none/);
  assert.match(css, /\.md ul \{ list-style: disc; \}/);
  assert.match(css, /\.md ol \{ list-style: decimal; \}/);
});
