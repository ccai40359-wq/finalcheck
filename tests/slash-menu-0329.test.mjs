// 0.32.9 slash 菜单三处回归（用户截图报的）：
//   ① frontmatter 折叠块标量 → 菜单里只剩一个孤零零的 `>`（本机 11 个技能中招）
//   ② 中英混用：命令文案走 t(cn)，英文词典缺「定时唤醒」→ 英文界面漏中文
//   ③ 排序：跨根拼接后不排序 + 先 slice(0,50) 再拼，第 51 位的自带技能永远看不见
// 以及一个顺带发现的真 bug：CRLF 文件里 frontmatter 最后一行带 \r，$ 匹配不上 → description_en 恒空。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseFrontmatter } from '../src/playbooks.mjs';
import {
  COMMANDS, SKILL_GROUPS, buildSlashItems, skillGroupOf, skillDescription
} from '../desktop/src/renderer/lib/app-helpers.mjs';
import { t, setLanguage, getLanguage } from '../desktop/src/renderer/i18n/core.mjs';

const CJK = /[\u3400-\u9fff]/;
const hasCJK = (s) => CJK.test(String(s || ''));

// ---- ① frontmatter：块标量 / 引号标量 / CRLF ----

test('frontmatter: `description: >` 折叠块取到正文，不是 `>` 这个符号', () => {
  const text = [
    '---',
    'name: fc-browser-use',
    'description: >',
    '  Use when the task requires automating or verifying web pages: opening a',
    '  URL, clicking through flows, filling forms.',
    '---',
    '',
    '# body'
  ].join('\n');
  const f = parseFrontmatter(text);
  assert.notEqual(f.description.trim(), '>', '不能只取到折叠指示符本身');
  assert.match(f.description, /automating or verifying web pages/);
  assert.equal(f.description.includes('\n'), false, '折叠标量应折成一行');
  assert.equal(f.description.trim().startsWith('>'), false);
});

test('frontmatter: `>-`（去尾折叠）与 `|`（字面块）', () => {
  const keep = parseFrontmatter(['---', 'name: a', 'description: >-', '  one', '  two', '---'].join('\n'));
  assert.equal(keep.description, 'one two');
  const lit = parseFrontmatter(['---', 'name: b', 'description: |', '  行一', '  行二', '---'].join('\n'));
  assert.equal(lit.description, '行一\n行二', '字面块保留换行');
});

test('frontmatter: 折叠块后面紧跟 description_en，不能被并进 description', () => {
  const f = parseFrontmatter([
    '---', 'name: c', 'description: >', '  folded text here', 'description_en: short en line', '---'
  ].join('\n'));
  assert.equal(f.description, 'folded text here');
  assert.equal(f.descriptionEn, 'short en line');
});

test('frontmatter: CRLF 文件里最后一行字段也要解析出来（\\r 尾巴的历史 bug）', () => {
  // 实测：Windows 上 desktop/skills/*/SKILL.md 与 40 类内置手册都是 CRLF，
  // description_en 恰是 frontmatter 最后一行 → 老代码 $ 匹配不上，英文描述恒为空。
  const crlf = ['---', 'name: d', 'description: 中文描述', 'description_en: English description', '---'].join('\r\n');
  const f = parseFrontmatter(crlf);
  assert.equal(f.description, '中文描述');
  assert.equal(f.descriptionEn, 'English description', 'CRLF 不能吃掉最后一个字段');
  assert.equal(f.descriptionEn.includes('\r'), false);
});

test('frontmatter: 引号标量去掉外层引号（以前菜单会连引号一起显示）', () => {
  const f = parseFrontmatter(['---', 'name: e', 'description: "Design banners for social media."', '---'].join('\n'));
  assert.equal(f.description, 'Design banners for social media.');
});

test('frontmatter: 旧的单行写法照旧（40 类内置手册不能回归）', () => {
  const f = parseFrontmatter(['---', 'name: g', 'description: 识别目标 Web 技术栈时使用。', 'description_en: Identify CMS.', '---'].join('\n'));
  assert.equal(f.description, '识别目标 Web 技术栈时使用。');
  assert.equal(f.descriptionEn, 'Identify CMS.');
});

test('frontmatter: 真机技能目录里不存在「描述只剩折叠符号」的条目', async () => {
  // 这条是用户截图的直接回归：不能有任何技能的描述是 `>` / `>-` / `|`
  const { loadSkills, clearSkillsCache, commonSkillsRoot } = await import('../src/playbooks.mjs');
  const homeSkills = commonSkillsRoot();
  if (!path.isAbsolute(homeSkills)) return; // 极端环境跳过
  clearSkillsCache();
  const skills = await loadSkills({});
  const bad = skills
    .filter((s) => /^[>|][-+]?$/.test(String(s.description || '').trim()))
    .map((s) => s.name);
  assert.deepEqual(bad, [], `这些技能的描述还是折叠符号：${bad.join(', ')}`);
});

// ---- ② 中英 ----

test('命令文案在英文界面全部是英文（含 /wake）', () => {
  const before = getLanguage();
  try {
    setLanguage('en');
    const leaks = COMMANDS.filter((c) => hasCJK(t(c.cn))).map((c) => `${c.name} → ${t(c.cn)}`);
    assert.deepEqual(leaks, [], `英文界面还有中文命令文案：${leaks.join(', ')}`);
  } finally {
    setLanguage(before);
  }
});

test('每个命令都带 descriptionEn，且不含中文', () => {
  for (const c of COMMANDS) {
    assert.ok(String(c.descriptionEn || '').trim(), `/${c.name} 缺 descriptionEn`);
    assert.equal(hasCJK(c.descriptionEn), false, `/${c.name} 的 descriptionEn 含中文`);
  }
});

test('第三方技能没有中文版时，中文界面显示原文（不伪造翻译、也不塞进 cn）', () => {
  const ext = { id: 'impeccable', name: 'impeccable', cn: 'impeccable', description: 'the user wants to design...', descriptionEn: '' };
  assert.equal(skillDescription(ext, 'zh'), 'the user wants to design...');
  assert.equal(skillDescription(ext, 'en'), 'the user wants to design...');
  // FC 自带技能中英都齐
  const own = { id: 'browser-use', name: 'browser-use', cn: '操作网页', description: '操作网页：…', descriptionEn: 'Automate web pages…' };
  assert.equal(skillDescription(own, 'zh'), '操作网页：…');
  assert.equal(skillDescription(own, 'en'), 'Automate web pages…');
});

// ---- ③ 排序与分组 ----

test('菜单分组顺序固定：命令 → 方法论 → 自带 → 项目 → 外部', () => {
  const ids = SKILL_GROUPS.map((g) => g.id);
  assert.deepEqual(ids, ['methodology', 'own', 'project', 'external']);
});

test('skillGroupOf 按 scope/origin 正确归组', () => {
  assert.equal(skillGroupOf({ scope: 'builtin', id: '11' }), 'methodology');
  assert.equal(skillGroupOf({ scope: 'user', origin: 'own', id: 'browser-use' }), 'own');
  assert.equal(skillGroupOf({ scope: 'user', origin: 'common', id: 'impeccable' }), 'external');
  assert.equal(skillGroupOf({ scope: 'project', id: 'my-skill' }), 'project');
});

test('buildSlashItems: 命令在最前且保持数组序，方法论按编号数值升序', () => {
  const skills = [
    { id: '10', name: 'n10', cn: 'x', description: 'd', scope: 'builtin' },
    { id: '02', name: 'n02', cn: 'y', description: 'd', scope: 'builtin' },
    { id: '01', name: 'n01', cn: 'z', description: 'd', scope: 'builtin' }
  ];
  const items = buildSlashItems({ commands: COMMANDS, skills, lang: 'zh' });
  assert.deepEqual(items.slice(0, 3).map((i) => i.name), ['compact', 'wake', 'workflow'], '命令序 = COMMANDS 数组序');
  const ids = items.filter((i) => i.type === 'skill').map((i) => i.id);
  assert.deepEqual(ids, ['01', '02', '10'], '编号必须按数值排，字符串序会把 10 排到 02 前面');
});

test('buildSlashItems: 外部技能排在自带/方法论之后，同组内名字升序', () => {
  const skills = [
    { id: 'zeta', name: 'zeta', cn: 'z', description: 'd', scope: 'user', origin: 'common' },
    { id: 'alpha', name: 'alpha', cn: 'a', description: 'd', scope: 'user', origin: 'common' },
    { id: '11', name: 'ssrf', cn: 'SSRF', description: 'd', scope: 'builtin' },
    { id: 'browser-use', name: 'browser-use', cn: '操作网页', description: 'd', scope: 'user', origin: 'own' }
  ];
  const items = buildSlashItems({ commands: [], skills, lang: 'zh' });
  assert.deepEqual(items.map((i) => i.name), ['ssrf', 'browser-use', 'alpha', 'zeta']);
});

test('buildSlashItems: 排序与切片解耦（85 条时自带技能不会掉出前 50）', () => {
  // 以前是 [...COMMANDS, ...skillItems].filter(...).slice(0,50) —— 拼接顺序决定去留，
  // 自带技能排在外部技能后面就整段被切掉。现在排序在前，调用方切片在后。
  const builtin = Array.from({ length: 40 }, (_, i) => ({ id: String(i + 1).padStart(2, '0'), name: `s${i}`, cn: `技${i}`, description: 'd', scope: 'builtin' }));
  const own = [{ id: 'browser-use', name: 'browser-use', cn: '操作网页', description: 'd', scope: 'user', origin: 'own' },
    { id: 'computer-use', name: 'computer-use', cn: '操控电脑', description: 'd', scope: 'user', origin: 'own' }];
  const common = Array.from({ length: 43 }, (_, i) => ({ id: `ext${i}`, name: `ext${i}`, cn: 'e', description: 'd', scope: 'user', origin: 'common' }));
  const items = buildSlashItems({ commands: COMMANDS, skills: [...builtin, ...own, ...common], lang: 'zh' });
  assert.equal(items.length, 88);
  const idx = items.findIndex((i) => i.name === 'browser-use');
  assert.ok(idx > 0, 'browser-use 必须在列表里');
  assert.ok(idx <= 50, `browser-use 原第 45 位（3 命令 + 40 方法论 + 2 自带），现在第 ${idx + 1} 位——排序须先于切片`);
  assert.equal(items[items.length - 1].group, 'external', '外部技能永远在最后');
});

test('buildSlashItems: 置换不变（同一组输入换顺序，输出顺序不变）', () => {
  const base = [
    { id: '11', name: 'ssrf', cn: 'SSRF', description: 'd', scope: 'builtin' },
    { id: '02', name: 'fp', cn: '指纹', description: 'd', scope: 'builtin' },
    { id: 'browser-use', name: 'browser-use', cn: '操作网页', description: 'd', scope: 'user', origin: 'own' },
    { id: 'alpha', name: 'alpha', cn: 'a', description: 'd', scope: 'user', origin: 'common' }
  ];
  const a = buildSlashItems({ commands: [], skills: base, lang: 'zh' }).map((i) => i.name);
  const b = buildSlashItems({ commands: [], skills: base.slice().reverse(), lang: 'zh' }).map((i) => i.name);
  assert.deepEqual(a, b);
});

test('buildSlashItems: 搜索命中后组序仍然稳定，且大小写不敏感', () => {
  const skills = [
    { id: '11', name: 'ssrf', cn: 'SSRF', description: 'Test web URL-fetching features', scope: 'builtin' },
    { id: 'browser-use', name: 'browser-use', cn: '操作网页', description: 'Automate web pages', scope: 'user', origin: 'own' },
    { id: 'impeccable', name: 'impeccable', cn: 'impeccable', description: 'design skill', scope: 'user', origin: 'common' }
  ];
  const hit = buildSlashItems({ commands: [], skills, lang: 'en', query: 'WEB' });
  assert.deepEqual(hit.map((i) => i.name), ['ssrf', 'browser-use'], '大写 WEB 命中两条；方法论在前，外部技能不命中');
});

test('skills:list IPC 透传分组字段（不分就无法显示分节标题）', async () => {
  process.env.FINALCHECK_COMMON_SKILLS_DIR = path.join(os.tmpdir(), 'fc-test-no-common-' + Date.now());
  const { clearSkillsCache } = await import('../src/playbooks.mjs');
  clearSkillsCache();
  try {
    const { registerSystemIpc } = await import('../desktop/src/main/ipc/ipc-system.mjs');
    const handlers = new Map();
    const ipcMain = { handle(ch, fn) { handlers.set(ch, fn); }, removeHandler(ch) { handlers.delete(ch); } };
    const repoRoot = path.resolve(import.meta.dirname, '..');
    registerSystemIpc({
      ipcMain, getWin: () => null,
      engineUrl: (rel) => pathToFileURL(path.join(repoRoot, rel)).href,
      store: {}, getHooksConfig: () => null, sessionProjectPathOf: () => '', sessionUsage: new Map()
    });
    const list = await handlers.get('finalcheck:skills:list')({ sender: null });
    for (const item of list) {
      assert.ok(item.scope, `${item.name} 缺 scope`);
      assert.ok(['methodology', 'own', 'project', 'external'].includes(skillGroupOf(item)), `${item.name} 分组异常`);
    }
    // 方法论 40 条按编号升序
    const methods = list.filter((x) => skillGroupOf(x) === 'methodology').map((x) => x.id);
    assert.deepEqual(methods, [...methods].sort((a, b) => Number(a) - Number(b)), '方法论条目要按编号升序');
    // 本机自带技能的中文标签必须可读（不是英文长句）
    const own = list.find((x) => x.name === 'browser-use');
    if (own) assert.ok(hasCJK(own.cn), `自带技能 cn 应为可读中文标签（实际：${own.cn}）`);
  } finally {
    delete process.env.FINALCHECK_COMMON_SKILLS_DIR;
    clearSkillsCache();
  }
});
