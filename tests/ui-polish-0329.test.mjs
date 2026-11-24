// 0.32.9 前端整体打磨的回归闸门。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const renderer = path.join(root, 'desktop/src/renderer');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.jsx$/.test(name)) out.push(p);
  }
  return out;
};

test('标识：组件与 exe 图标源文件用同一组字形路径', async () => {
  const svg = read('desktop/build/brand/logo.svg');
  const src = read('desktop/src/renderer/components/Logo.jsx');
  const paths = [...src.matchAll(/^\s*'(M[^']+)'/gm)].map((m) => m[1]);
  assert.equal(paths.length, 4, 'Logo.jsx 应有 4 段字形路径');
  for (const d of paths) assert.ok(svg.includes(`d="${d}"`), `build/brand/logo.svg 缺少路径 ${d}`);
  assert.ok(existsSync(path.join(root, 'desktop/build/icon.ico')));
});

test('favicon 是新标识，且没有残留的旧 SVG 片段漏进页面', () => {
  const html = read('desktop/src/renderer/index.html');
  const line = html.split(/\r?\n/).find((l) => l.includes('rel="icon"'));
  assert.ok(line.includes('M392 200 A88 88 0 1 0 374 338'), 'favicon 应是 FC✓ 标识');
  assert.ok(line.trim().endsWith('</svg>" />'), 'favicon 那一行之后不应再有文字（上一版残留了半个旧 <text>，显示在窗口顶上）');
  assert.ok(!html.includes('%E9%AA%8C'), '旧的「验」字 favicon 已移除');
});

test('标题不再散落 font-kai + 金字：统一走 .fc-title（深色无衬线、浅色保留楷书）', () => {
  const offenders = [];
  for (const f of walk(renderer)) {
    readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => { if (/\bfont-kai\b/.test(l)) offenders.push(`${path.relative(root, f)}:${i + 1}`); });
  }
  assert.deepEqual(offenders, []);
  const css = read('desktop/src/renderer/styles.css');
  assert.match(css, /\.fc-title \{[^}]*var\(--ui-font-heading\)/);
  assert.match(css, /\[data-theme="light"\] \.fc-title \{[^}]*--fc-gold-soft/);
});

test('标题栏窗口按钮是 SVG，不再用 ─ ▢ ✕ ☀ ☾ 字符', () => {
  const tb = read('desktop/src/renderer/components/TitleBar.jsx');
  for (const ch of ['>─<', '>▢<', '>✕<', "'☀'", "'☾'"]) assert.ok(!tb.includes(ch), `残留字符按钮 ${ch}`);
  assert.match(tb, /hover:bg-\[#c42b1c\]/, '关闭按钮悬停应是 Windows 原生红');
});

test('开关圆点用 --fc-knob（浅色下不再是黑点），并用 transform 动画', () => {
  const s = read('desktop/src/renderer/pages/SettingsPage.jsx');
  assert.ok(!/rounded-full bg-ink shadow/.test(s), '开关圆点不能用 bg-ink（浅色主题下是近黑色）');
  assert.equal((s.match(/bg-\[rgb\(var\(--fc-knob\)\)\]/g) || []).length, 2);
  assert.ok(!s.includes("'left-[22px]'"), '用 translate 代替 left 过渡');
});

test('/ 技能菜单：说明列左对齐（上一版 button 默认居中，说明文字漂在中间）', () => {
  const c = read('desktop/src/renderer/components/Composer.jsx');
  assert.match(c, /fc-menu-row w-full flex items-center gap-3 px-2\.5 py-\[7px\] rounded-lg text-left/);
  assert.match(c, /min-w-0 flex-1 truncate text-left/);
});

test('README 视觉资产由生成器产出，且 README 引用的文件都存在', () => {
  assert.ok(existsSync(path.join(root, 'docs/assets/src/make_assets.py')));
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const md = read(readme);
    for (const m of md.matchAll(/src="(docs\/assets\/[^"]+)"/g)) {
      assert.ok(existsSync(path.join(root, m[1])), `${readme} 引用的 ${m[1]} 不存在`);
    }
  }
});
