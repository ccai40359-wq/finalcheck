// 主题：深色（墨黑鎏金）/ 浅色（宣纸暖白）。
// 除了纯逻辑单测，还有一条「不许漏网」的闸门：renderer 里不许再有写死的深色字面量
// 或 white-alpha 玻璃层——那些在浅色主题下会变成白叠白（等于没效果）或看不清。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  THEMES, DEFAULT_THEME, THEME_STORAGE_KEY,
  normalizeTheme, nextTheme, isLight, readCachedTheme, writeCachedTheme, applyThemeToDocument
} from '../desktop/src/renderer/lib/theme.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const rendererRoot = path.join(repoRoot, 'desktop/src/renderer');

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { walk(p, out); continue; }
    if (/\.(jsx|js|css|html)$/.test(name)) out.push(p);
  }
  return out;
};

// ---------------------------------------------------------------- 纯逻辑

test('theme: 只有两套主题，默认深色（老用户升级不该突然变白）', () => {
  assert.deepEqual([...THEMES], ['dark', 'light']);
  assert.equal(DEFAULT_THEME, 'dark');
});

test('theme: normalizeTheme 把任何输入收敛成 dark/light，不抛错', () => {
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  for (const bad of [undefined, null, '', 'auto', 'LIGHT', 'blue', 0, 1, {}, []]) {
    assert.equal(normalizeTheme(bad), 'dark', `input ${JSON.stringify(bad)} 应回落到 dark`);
  }
});

test('theme: nextTheme 在两套之间来回切', () => {
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme(undefined), 'light', '未知值先收敛成 dark 再切到 light');
  assert.equal(nextTheme(nextTheme('dark')), 'dark');
});

test('theme: isLight 只认 light', () => {
  assert.equal(isLight('light'), true);
  assert.equal(isLight('dark'), false);
  assert.equal(isLight(null), false);
});

test('theme: 本地缓存读不到/抛错时回落默认值', () => {
  assert.equal(readCachedTheme(null), 'dark');
  assert.equal(readCachedTheme({}), 'dark');
  assert.equal(readCachedTheme({ getItem: () => 'light' }), 'light');
  assert.equal(readCachedTheme({ getItem: () => 'nonsense' }), 'dark');
  assert.equal(readCachedTheme({ getItem: () => { throw new Error('blocked'); } }), 'dark');
});

test('theme: 写缓存失败不抛（隐私模式/配额满不影响切换）', () => {
  const calls = [];
  writeCachedTheme({ setItem: (k, v) => calls.push([k, v]) }, 'light');
  assert.deepEqual(calls, [[THEME_STORAGE_KEY, 'light']]);
  assert.doesNotThrow(() => writeCachedTheme({ setItem: () => { throw new Error('nope'); } }, 'dark'));
  assert.doesNotThrow(() => writeCachedTheme(null, 'dark'));
});

test('theme: applyThemeToDocument 落 data-theme + color-scheme', () => {
  const root = { dataset: {}, style: {} };
  const doc = { documentElement: root };
  assert.equal(applyThemeToDocument(doc, 'light'), 'light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.style.colorScheme, 'light');
  applyThemeToDocument(doc, 'garbage');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.style.colorScheme, 'dark');
});

test('theme: 没有 document 时不崩（SSR / 测试环境）', () => {
  assert.doesNotThrow(() => applyThemeToDocument(null, 'light'));
  assert.equal(applyThemeToDocument(undefined, 'light'), 'light');
});

// ---------------------------------------------------------------- 落盘约定

test('theme: index.html 的内联脚本与 theme.mjs 用同一个 storage key', () => {
  const html = readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  assert.match(html, /localStorage\.getItem\('fc\.theme'\)/);
  assert.equal(THEME_STORAGE_KEY, 'fc.theme', '两边 key 不一致会导致首屏闪白');
  // 内联脚本必须在 React 之前跑（放在 <head> 里）
  assert.ok(html.indexOf("localStorage.getItem('fc.theme')") < html.indexOf('/main.jsx'));
});

test('theme: CSS 定义了浅色覆盖块，且浅色下 lift 必须压暗', () => {
  const css = readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
  assert.ok(css.includes('[data-theme="light"]'), '缺少浅色主题变量块');

  const lightBlock = css.slice(css.indexOf('[data-theme="light"]'));
  const body = lightBlock.slice(0, lightBlock.indexOf('}', lightBlock.indexOf('--fc-lift:')));
  assert.match(body, /--fc-lift:\s*0 0 0/, '浅色主题的 lift 必须是黑（压暗），否则所有玻璃高光失效');
});

test('theme: 深色与浅色必须定义同一组语义变量', () => {
  const css = readFileSync(path.join(rendererRoot, 'styles.css'), 'utf8');
  const keysIn = (block) => new Set([...block.matchAll(/(--fc-[a-z-]+):/g)].map((m) => m[1]));
  const darkBlock = css.slice(0, css.indexOf('[data-theme="light"]'));
  const lightStart = css.indexOf('[data-theme="light"]');
  const lightBlock = css.slice(lightStart, css.indexOf('html, body, #root', lightStart));
  const dark = keysIn(darkBlock);
  const light = keysIn(lightBlock);
  const missing = [...dark].filter((k) => k !== '--fc-ease' && !light.has(k));
  assert.deepEqual(missing, [], `浅色主题缺少这些变量：${missing.join(', ')}`);
});

// ---------------------------------------------------------------- 漏网闸门

test('theme: renderer 里不许再有 white-alpha 玻璃层（浅色下会白叠白）', () => {
  const offenders = [];
  for (const file of walk(rendererRoot)) {
    if (file.endsWith('styles.css')) continue; // CSS 里用 rgb(var(--fc-lift) / a) 表达，已变量化
    const src = readFileSync(file, 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      if (/\b(bg|border|divide|ring|text)-white(\/|\[)/.test(line)) {
        offenders.push(`${path.relative(repoRoot, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `改用 bg-lift / border-lift 等语义类：\n${offenders.join('\n')}`);
});

test('theme: renderer 里不许再有写死的深色 hex 类名', () => {
  const DARK_HEX = /(bg|border|text|divide|ring|ring-offset)-\[#(0a0a0c|0b0b0c|0b0b0e|0d0d10|111114|141210|15151a|ece7dc|141008)\]/;
  const offenders = [];
  for (const file of walk(rendererRoot)) {
    const src = readFileSync(file, 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      if (DARK_HEX.test(line)) offenders.push(`${path.relative(repoRoot, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], `改用 bg-base / bg-sunken / bg-well / bg-panel 等语义类：\n${offenders.join('\n')}`);
});

test('theme: Tailwind 调色板全部指向 CSS 变量（否则切主题不生效）', async () => {
  const { default: cfg } = await import('../desktop/tailwind.config.js');
  const colors = cfg.theme.extend.colors;
  const semantic = ['base', 'card', 'cardHover', 'edge', 'ink', 'mute', 'gold', 'goldSoft', 'goldDeep', 'jade', 'lift', 'sunken', 'panel', 'well', 'pop'];
  for (const key of semantic) {
    assert.equal(typeof colors[key], 'string', `${key} 缺失`);
    assert.match(colors[key], /^rgb\(var\(--fc-[a-z-]+\) \/ <alpha-value>\)$/, `${key} 必须指向 CSS 变量：${colors[key]}`);
  }
  // 语义告警色也要变量化，否则浅色下 text-red-300 在白底上几乎看不见
  for (const [family, shades] of Object.entries({ red: ['300', '400', '500'], amber: ['300', '400', '500'], emerald: ['400', '500'] })) {
    for (const shade of shades) {
      assert.match(colors[family]?.[shade] || '', /^rgb\(var\(--fc-/, `${family}-${shade} 必须指向变量`);
    }
  }
});

test('theme: 主进程 normalizeConfig 收敛 theme 字段（未知值 → dark）', () => {
  const src = readFileSync(path.join(repoRoot, 'desktop/src/main/ipc/config-store.mjs'), 'utf8');
  assert.match(src, /out\.theme\s*=\s*cfg\.theme === 'light' \? 'light' : 'dark'/, 'normalizeConfig 没有收敛 theme');
});

test('theme: 窗口底板色跟随主题（浅色启动不该闪黑边）', () => {
  const src = readFileSync(path.join(repoRoot, 'desktop/src/main/index.mjs'), 'utf8');
  assert.match(src, /backgroundColor:\s*startupTheme\(\) === 'light'/, 'BrowserWindow 底色没跟随主题');
  assert.match(src, /function startupTheme\(\)/, '缺少启动期读主题的函数');
});

test('theme: 设置页有外观分节，且切换写回 config.theme', () => {
  const src = readFileSync(path.join(rendererRoot, 'pages/SettingsPage.jsx'), 'utf8');
  assert.match(src, /'appearance'/, 'SECTIONS 里没有 appearance');
  assert.match(src, /THEME_MODES/, '缺少 THEME_MODES');
  assert.match(src, /theme:\s*normalizeTheme\(themeValue\)/, '保存配置时没写 theme');
  // 受控：状态由 App 持有，设置页只是展示——否则标题栏与外观页会各存一份，必然打架
  assert.match(src, /theme: controlledTheme/, '设置页没有接收受控 theme');
  assert.match(src, /onThemeChange\?\.\(value\)/, '设置页没有把选择回传给 App');
});

test('theme: 标题栏切换会落盘 config.json（不能只改内存）', () => {
  const src = readFileSync(path.join(rendererRoot, 'App.jsx'), 'utf8');
  // 切换主题必须同时 setConfig，否则设置页读盘后与界面状态不一致
  assert.match(src, /const persistTheme = \(next\) => \{[\s\S]{0,400}?setConfig\?\.\(\{ \.\.\.\(c \|\| \{\}\), theme: next \}\)/, 'toggleTheme 没有写回 config');
  // 落盘不能在 setState updater 里（StrictMode 会跑两遍 → 双写盘）
  assert.ok(
    !/setThemeState\(\(prev\) => \{[\s\S]{0,300}?setConfig/.test(src),
    '落盘写进了 setState updater：StrictMode 下会双写盘'
  );
});

test('theme: 标题栏有快捷切换按钮', () => {
  const src = readFileSync(path.join(rendererRoot, 'components/TitleBar.jsx'), 'utf8');
  assert.match(src, /onToggleTheme/, 'TitleBar 没有接切换回调');
  assert.match(src, /data-ui="theme-toggle"/, '缺少可测试的切换按钮标记');
});

test('theme: 新增的界面文案都有英文词条', async () => {
  const { hasTranslation } = await import('../desktop/src/renderer/i18n/core.mjs');
  const keys = [
    '外观', '深色', '浅色',
    '墨黑鎏金：暗底金字，长时间看不刺眼。',
    '宣纸暖白：亮底深字，白天或投影时更清楚。',
    '深色（墨黑鎏金）与浅色（宣纸暖白）两套主题；切换立即生效。',
    '主题只影响界面配色，不改动任何代码、报告与导出的文件内容。标题栏右上角的 ☀/☾ 也能随时切换。',
    '切换到深色主题', '切换到浅色主题'
  ];
  const missing = keys.filter((k) => !hasTranslation(k));
  assert.deepEqual(missing, [], `缺英文翻译：${missing.join(' / ')}`);
});
