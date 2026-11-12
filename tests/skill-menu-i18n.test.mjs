// slash 菜单技能描述的双语选择：英文界面用 descriptionEn，缺英文回退中文；
// skills:list IPC 必须把 descriptionEn 透传给渲染层（保留旧的 description/cn/name 字段）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { skillDescription } from '../desktop/src/renderer/lib/app-helpers.mjs';
import { registerSystemIpc } from '../desktop/src/main/ipc/ipc-system.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const CJK = /[\u3400-\u9fff]/;

test('skillDescription: en 且 descriptionEn 非空 → 英文', () => {
  const s = { id: '11', cn: 'SSRF', description: '测 SSRF 时使用。Use when 目标存在 URL 拉取功能。', descriptionEn: 'Test URL-fetching features for SSRF.' };
  assert.equal(skillDescription(s, 'en'), 'Test URL-fetching features for SSRF.');
});

test('skillDescription: en 但 descriptionEn 为空/空白 → 回退中文', () => {
  const s = { id: '11', cn: 'SSRF', description: '测 SSRF 时使用。', descriptionEn: '' };
  assert.equal(skillDescription(s, 'en'), '测 SSRF 时使用。');
  assert.equal(skillDescription({ ...s, descriptionEn: '   ' }, 'en'), '测 SSRF 时使用。');
  assert.equal(skillDescription({ id: '11', cn: 'SSRF', description: '测 SSRF 时使用。' }, 'en'), '测 SSRF 时使用。');
});

test('skillDescription: zh → 中文（即使有英文）', () => {
  const s = { id: '11', cn: 'SSRF', description: '测 SSRF 时使用。', descriptionEn: 'Test URL-fetching features for SSRF.' };
  assert.equal(skillDescription(s, 'zh'), '测 SSRF 时使用。');
  assert.equal(skillDescription(s, undefined), '测 SSRF 时使用。');
});

test('skills:list IPC 返回每项 descriptionEn，且保留旧字段', async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); }
  };
  registerSystemIpc({
    ipcMain,
    getWin: () => null,
    engineUrl: (rel) => pathToFileURL(path.join(repoRoot, rel)).href,
    store: {},
    getHooksConfig: () => null,
    sessionProjectPathOf: () => '',
    sessionUsage: new Map()
  });
  const call = handlers.get('finalcheck:skills:list');
  assert.equal(typeof call, 'function', 'finalcheck:skills:list 应已注册');
  const list = await call({ sender: null });
  assert.equal(list.length, 40);
  for (const item of list) {
    assert.ok(item.name, `${item.id} 缺 name`);
    assert.ok(item.cn, `${item.id} 缺 cn`);
    assert.ok(item.description, `${item.id} 缺旧字段 description`);
    assert.ok(String(item.descriptionEn || '').trim(), `${item.id} 缺 descriptionEn`);
    assert.ok(!CJK.test(item.descriptionEn), `${item.id} descriptionEn 不应含中文：${item.descriptionEn}`);
  }
});
