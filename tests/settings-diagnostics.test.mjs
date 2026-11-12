import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.join(here, '..', 'desktop', 'src', 'renderer', 'pages', 'SettingsPage.jsx'), 'utf8');
const en = readFileSync(path.join(here, '..', 'desktop', 'src', 'renderer', 'i18n', 'en', 'settings.js'), 'utf8');

test('settings: About 页有诊断导出入口，复用 preload 的 exportDiagnostics', () => {
  assert.match(page, /const exportDiagnostics = async \(\) =>/);
  assert.match(page, /await y\.exportDiagnostics\(\)/);
  assert.match(page, /t\('导出诊断'\)/);
  assert.match(page, /t\('导出中…'\)/);
  assert.match(page, /setDiagMsg\(/);
});

test('settings: 诊断导出的用户文案都有英文翻译', () => {
  for (const key of ['导出诊断', '导出中…', '当前版本不支持导出诊断', '已取消', '已导出：{path}', '导出失败', '导出失败：{msg}']) {
    assert.ok(en.includes(`'${key}'`), `missing English translation: ${key}`);
  }
});
