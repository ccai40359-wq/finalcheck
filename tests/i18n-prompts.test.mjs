// 能力卡 prompt 的双语：英文界面点击卡片后插入英文 prompt；中文界面仍插入原文。
// setLanguage 改的是 globalThis 上的全局状态，测试结束必须恢复 zh。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { setLanguage, t, hasTranslation } from '../desktop/src/renderer/i18n/core.mjs';
import { CAPABILITIES } from '../desktop/src/renderer/lib/app-helpers.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const CJK = /[\u3400-\u9fff]/;
const ORIGINALS = CAPABILITIES.map((c) => ({ id: c.id, title: c.title, desc: c.desc, prompt: c.prompt }));

after(() => { setLanguage('zh'); });

test('i18n prompts: 6 张能力卡的 prompt 在英文下都有非中文译文', () => {
  setLanguage('en');
  assert.equal(ORIGINALS.length, 6, '能力卡数量应为 6');
  for (const { id, prompt } of ORIGINALS) {
    assert.ok(hasTranslation(prompt), `${id}: prompt 缺英文译文`);
    const en = t(prompt);
    assert.ok(en.trim(), `${id}: 英文 prompt 不能为空`);
    assert.ok(!CJK.test(en), `${id}: 英文 prompt 不应含中文：${en}`);
    assert.notEqual(en, prompt, `${id}: 英文 prompt 不应回退中文原文`);
    // 多行 prompt（渗透测试）保持行结构，占位行仍在第二行
    assert.equal(en.split('\n').length, prompt.split('\n').length, `${id}: 英文 prompt 行数与原文不一致`);
  }
  setLanguage('zh');
});

test('i18n prompts: 中文下 t(prompt) 原样返回，不查词典', () => {
  setLanguage('zh');
  for (const { id, prompt } of ORIGINALS) {
    assert.equal(t(prompt), prompt, `${id}: 中文下应返回原文`);
  }
});

test('i18n prompts: 每张卡片的 title/desc/prompt 都能被 t() 处理（en 有译文、zh 原样）', () => {
  setLanguage('en');
  for (const { id, title, desc, prompt } of ORIGINALS) {
    for (const [field, source] of [['title', title], ['desc', desc], ['prompt', prompt]]) {
      assert.ok(hasTranslation(source), `${id}.${field} 缺英文译文：${source}`);
      const en = t(source);
      assert.ok(en.trim(), `${id}.${field} 英文为空`);
      assert.ok(!CJK.test(en), `${id}.${field} 英文含中文：${en}`);
      assert.notEqual(en, source, `${id}.${field} 英文不应与原文相同`);
    }
  }
  setLanguage('zh');
  for (const { id, title, desc, prompt } of ORIGINALS) {
    assert.equal(t(title), title, `${id}.title 中文下应返回原文`);
    assert.equal(t(desc), desc, `${id}.desc 中文下应返回原文`);
    assert.equal(t(prompt), prompt, `${id}.prompt 中文下应返回原文`);
  }
});

test('i18n prompts: 空态卡片点击经过 t()，不再直接插入中文原文', () => {
  const src = readFileSync(path.join(repoRoot, 'desktop/src/renderer/components/EmptyState.jsx'), 'utf8');
  assert.match(src, /pickSuggestion\(t\(c\.prompt\)\)/, 'EmptyState 应插入 t(c.prompt)');
  assert.ok(!/pickSuggestion\(c\.prompt\)/.test(src), 'EmptyState 不应再直接插入 c.prompt');
});
