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
  // 40 类 web-vuln 方法论 + desktop/skills 下的自动化技能（computer-use / browser-use）
  assert.equal(list.length, 42);
  for (const item of list) {
    assert.ok(item.name, `${item.id} 缺 name`);
    assert.ok(item.cn, `${item.id} 缺 cn`);
    assert.ok(item.description, `${item.id} 缺旧字段 description`);
    assert.ok(String(item.descriptionEn || '').trim(), `${item.id} 缺 descriptionEn`);
    assert.ok(!CJK.test(item.descriptionEn), `${item.id} descriptionEn 不应含中文：${item.descriptionEn}`);
  }
});

test('skills:list 并入自动化技能：computer-use / browser-use 可被斜杠菜单点名', async () => {
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
  const list = await handlers.get('finalcheck:skills:list')({ sender: null });
  const cu = list.find((x) => x.name === 'computer-use');
  const bu = list.find((x) => x.name === 'browser-use');
  assert.ok(cu, 'computer-use 应出现在斜杠菜单列表');
  assert.ok(bu, 'browser-use 应出现在斜杠菜单列表');
  // topic 用 slug 本身（read_playbook(topic="computer-use") 能按 loadSkills 目录解析）
  assert.equal(cu.id, 'computer-use');
  assert.equal(bu.id, 'browser-use');
  // 中文菜单标签：目录名是英文 slug 时用中文触发描述替代，用户能一眼看出用途
  assert.ok(CJK.test(cu.cn) && /操控电脑/.test(cu.cn), `computer-use 的中文标签应可读（实际：${cu.cn}）`);
  assert.ok(CJK.test(bu.cn) && /操作网页/.test(bu.cn), `browser-use 的中文标签应可读（实际：${bu.cn}）`);
  // dev-fix（41-50，dev 轨系统提示已带）不重复进菜单；web-vuln 不因 loadSkills 重复
  assert.ok(!list.some((x) => /^(4[1-9]|50)$/.test(x.id)), 'dev-fix 41-50 不应进斜杠菜单');
  const names = list.map((x) => x.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, '同名技能不应重复出现在菜单里');
});
