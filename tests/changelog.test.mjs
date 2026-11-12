import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseChangelog,
  entryFor,
  changelogView,
  changelogSection,
  normalizeVersion,
  sameVersion,
  pickChangelogEntries
} from '../desktop/src/renderer/lib/changelog.mjs';
import { registerUpdaterIpc } from '../desktop/src/main/ipc/ipc-updater.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readMd = (name) => readFileSync(path.join(ROOT, name), 'utf8');

const sample = `# 更新记录

## [0.13.0] - 2026-11-11

### 新增

- 设置页可以查看更新详情。
- 发版前必须写更新记录。

### 修复

- 修复会话恢复失效。

### 优化

- 长内容可以滚动。

## [0.1.2] - 2026-11-10

### 新增

- 多个工作区可以同时展开。

## v0.1.0 - 2026-11-10

### 优化

- 首个安装包。
`;

test('changelog: 多版本按文件顺序解析，日期与三段内容齐全', () => {
  const entries = parseChangelog(sample);
  assert.deepEqual(entries.map((e) => e.version), ['0.13.0', '0.1.2', '0.1.0']);
  assert.equal(entries[0].date, '2026-11-11');
  assert.deepEqual(entries[0].added, ['设置页可以查看更新详情。', '发版前必须写更新记录。']);
  assert.deepEqual(entries[0].fixed, ['修复会话恢复失效。']);
  assert.deepEqual(entries[0].improved, ['长内容可以滚动。']);
});

test('changelog: 只有新增段的版本，其余两段为空数组而不是 undefined', () => {
  const entry = entryFor(parseChangelog(sample), '0.1.2');
  assert.ok(entry);
  assert.deepEqual(entry.added, ['多个工作区可以同时展开。']);
  assert.deepEqual(entry.fixed, []);
  assert.deepEqual(entry.improved, []);
  assert.equal(entry.date, '2026-11-10');
});

test('changelog: 重复版本标题合并到一条，条目去重', () => {
  const md = `## 1.0.0 - 2026-01-01
### 新增
- 第一条
## [1.0.0] - 2026-01-02
### 新增
- 第一条
- 第二条
### 修复
- 修一个问题
`;
  const entries = parseChangelog(md);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].added, ['第一条', '第二条']);
  assert.deepEqual(entries[0].fixed, ['修一个问题']);
  assert.equal(entries[0].date, '2026-01-01', '保留首个标题的日期');
});

test('changelog: 空文件 / 非字符串输入返回空数组且不抛错', () => {
  for (const input of ['', '   \n\n', null, undefined, 42, {}, []]) {
    assert.deepEqual(parseChangelog(input), [], `输入 ${JSON.stringify(input)} 应返回空数组`);
  }
});

test('changelog: 脏 Markdown（乱序标题、无列表符号、CRLF、未闭合标记）不崩', () => {
  const dirty = '\uFEFF## 2.0.0\r\n### Added\r\n* ok one\r\n没有列表符号的一行\r\n' +
    '#### 深四层标题\r\n- 仍在新增段\r\n### 未知段落\r\n- 应被忽略\r\n' +
    '## Unreleased\r\n### 新增\r\n- 不属于任何版本\r\n' +
    '## [v2.1.0] - 2026-02-30 extra]\r\n### Fixed\r\n1. 编号条目\r\n- [ ] 未完成样式\r\n';
  const entries = parseChangelog(dirty);
  assert.deepEqual(entries.map((e) => e.version), ['2.0.0', '2.1.0']);
  assert.deepEqual(entries[0].added, ['ok one', '仍在新增段']);
  assert.deepEqual(entries[0].fixed, []);
  assert.deepEqual(entries[1].fixed, ['编号条目', '[ ] 未完成样式']);
  assert.equal(entries.some((e) => e.version === 'Unreleased'), false);
});

test('changelog: entryFor 兼容 v 前缀与 0.13 / 0.13.0；找不到返回 null', () => {
  const entries = parseChangelog(sample);
  assert.equal(entryFor(entries, '0.13.0')?.version, '0.13.0');
  assert.equal(entryFor(entries, 'v0.13.0')?.version, '0.13.0');
  assert.equal(entryFor(entries, '0.13')?.version, '0.13.0');
  assert.equal(entryFor(entries, 'v0.1.2')?.version, '0.1.2');
  assert.equal(entryFor(entries, '9.9.9'), null);
  assert.equal(entryFor(entries, ''), null);
  assert.equal(entryFor(null, '0.13.0'), null);
  assert.equal(entryFor(entries, null), null);
});

test('changelog: normalizeVersion / sameVersion 处理前缀、构建号与非法值', () => {
  assert.equal(normalizeVersion('v0.13.0'), '0.13.0');
  assert.equal(normalizeVersion('[1.2.3]'), '1.2.3');
  assert.equal(normalizeVersion('1.2.3-beta.1'), '1.2.3-beta.1');
  assert.equal(normalizeVersion('不是版本'), '');
  assert.equal(sameVersion('0.13', '0.13.0'), true);
  assert.equal(sameVersion('v0.13.0', '0.13.0'), true);
  assert.equal(sameVersion('0.13.1', '0.13.0'), false);
});

test('changelog: changelogView 当前版本置顶、历史不重复', () => {
  const entries = parseChangelog(sample);
  const view = changelogView(entries, '0.1.2');
  assert.equal(view.empty, false);
  assert.equal(view.current?.version, '0.1.2');
  assert.deepEqual(view.history.map((e) => e.version), ['0.13.0', '0.1.0']);
  assert.deepEqual(changelogView([], '0.13.0'), { current: null, history: [], empty: true });
  assert.deepEqual(changelogView(null, '0.13.0'), { current: null, history: [], empty: true });
  // 找不到当前版本时，所有条目都进历史，不会丢内容
  const miss = changelogView(entries, '9.9.9');
  assert.equal(miss.current, null);
  assert.equal(miss.history.length, 3);
});

test('changelog: changelogSection 输出可当 Release 正文，且到下一个版本为止', () => {
  const section = changelogSection(sample, 'v0.1.2');
  assert.ok(section.startsWith('## [0.1.2] - 2026-11-10'));
  assert.ok(section.includes('### 新增'));
  assert.ok(section.includes('多个工作区可以同时展开。'));
  assert.ok(!section.includes('0.13.0'), '不能带上别的版本');
  assert.ok(!section.includes('v0.1.0'));
  assert.equal(changelogSection(sample, '9.9.9'), '');
  assert.equal(changelogSection('', '0.1.2'), '');
});

test('IPC finalcheck:update:changelog 返回 { version, entries, entriesEn, raw, rawEn } 且中英都能读到', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const app = {
    isPackaged: false,
    getVersion: () => '0.13.0',
    getAppPath: () => path.join(ROOT, 'desktop')
  };
  registerUpdaterIpc({ ipcMain, app, getWin: () => null });
  const handler = handlers.get('finalcheck:update:changelog');
  assert.equal(typeof handler, 'function', '必须注册 finalcheck:update:changelog');
  const result = await handler();
  assert.equal(result.version, '0.13.0');
  assert.equal(typeof result.raw, 'string');
  assert.ok(result.raw.includes('# 更新记录'));
  assert.ok(result.entries.length >= 13);
  assert.equal(entryFor(result.entries, '0.13.0')?.version, '0.13.0');
  // 英文文件随包存在：entriesEn / rawEn 都要有内容，且版本顺序与中文一致
  assert.equal(typeof result.rawEn, 'string');
  assert.ok(result.rawEn.includes('# Release Notes'));
  assert.ok(Array.isArray(result.entriesEn));
  assert.ok(result.entriesEn.length >= 13);
  assert.equal(entryFor(result.entriesEn, '0.13.0')?.version, '0.13.0');
  assert.deepEqual(result.entriesEn.map((e) => e.version), result.entries.map((e) => e.version));
});

test('IPC finalcheck:update:changelog 英文文件缺失时 entriesEn 为空、entries 仍是中文', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fc-changelog-'));
  const prevCwd = process.cwd();
  try {
    writeFileSync(path.join(tmp, 'CHANGELOG.md'), sample, 'utf8'); // 故意不放 CHANGELOG.en.md
    const handlers = new Map();
    const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
    const app = { isPackaged: false, getVersion: () => '0.13.0', getAppPath: () => tmp };
    registerUpdaterIpc({ ipcMain, app, getWin: () => null });
    process.chdir(tmp); // 让 cwd 候选也落在没有英文文件的临时目录
    const result = await handlers.get('finalcheck:update:changelog')();
    assert.equal(result.entries.length, 3);
    assert.deepEqual(result.entriesEn, []);
    assert.equal(result.rawEn, '');
    assert.equal(result.raw.includes('# 更新记录'), true);
  } finally {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('changelog: pickChangelogEntries en 有数据选 en、en 为空回退 zh、zh 始终选 zh', () => {
  const zh = parseChangelog(sample);
  const en = zh.map((e) => ({
    ...e,
    added: e.added.map((s) => `EN: ${s}`),
    fixed: e.fixed.map((s) => `EN: ${s}`),
    improved: e.improved.map((s) => `EN: ${s}`)
  }));
  assert.deepEqual(pickChangelogEntries('en', { entries: zh, entriesEn: en }), en);
  assert.deepEqual(pickChangelogEntries('en', { entries: zh, entriesEn: [] }), zh);
  assert.deepEqual(pickChangelogEntries('zh', { entries: zh, entriesEn: en }), zh);
  assert.deepEqual(pickChangelogEntries('en', { entries: zh }), zh);
  assert.deepEqual(pickChangelogEntries('zh', null), []);
  assert.deepEqual(pickChangelogEntries('en', null), []);
});

test('changelog: 中英文件版本集合、日期与三段条目数一一对应', () => {
  const zh = parseChangelog(readMd('CHANGELOG.md'));
  const en = parseChangelog(readMd('CHANGELOG.en.md'));
  assert.ok(en.length >= 13, `英文版本条目过少（${en.length}）`);
  assert.equal(en.length, zh.length, '英文文件版本数必须与中文一致');
  assert.deepEqual(en.map((e) => e.version), zh.map((e) => e.version), '版本号与顺序必须一致');
  assert.deepEqual(en.map((e) => e.date), zh.map((e) => e.date), '日期必须一致');
  for (let i = 0; i < zh.length; i += 1) {
    for (const key of ['added', 'fixed', 'improved']) {
      const zhItems = zh[i][key];
      const enItems = en[i][key];
      assert.equal(enItems.length, zhItems.length, `${zh[i].version} 的 ${key} 条目数不一致`);
      for (const item of enItems) {
        assert.equal(typeof item, 'string', `${zh[i].version} 的 ${key} 条目必须是字符串`);
        assert.ok(item.trim().length > 0, `${zh[i].version} 的 ${key} 存在空条目`);
        assert.equal(/[\u4e00-\u9fff]/.test(item), false, `${zh[i].version} 的英文条目仍含中文：${item}`);
        assert.ok(/[A-Za-z]/.test(item), `${zh[i].version} 的英文条目没有英文内容：${item}`);
      }
    }
  }
});

test('changelog: 英文文件版本标题不重复，且包含当前版本', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
  const entries = parseChangelog(readMd('CHANGELOG.en.md'));
  const versions = entries.map((e) => e.version);
  assert.equal(new Set(versions).size, versions.length, `英文版本标题重复：${versions.join(', ')}`);
  const entry = entryFor(entries, pkg.version);
  assert.ok(entry, `CHANGELOG.en.md 缺少当前版本 ${pkg.version} 的条目`);
  assert.ok(entry.added.length + entry.fixed.length + entry.improved.length > 0, '当前版本至少有一条更新记录');
});

test('制度闸门: CHANGELOG.md 必须存在并包含 package.json 的当前版本号', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
  const md = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const entries = parseChangelog(md);
  const entry = entryFor(entries, pkg.version);
  assert.ok(entry, `CHANGELOG.md 缺少当前版本 ${pkg.version} 的条目；发版前必须先写更新记录`);
  assert.ok(
    entry.added.length + entry.fixed.length + entry.improved.length > 0,
    `CHANGELOG.md 中 ${pkg.version} 条目必须至少有一条新增/修复/优化`
  );
  assert.equal(entry.added.some((s) => /[\r\n]/.test(s)), false, '每条更新记录必须是一行');
});

test('制度闸门: CHANGELOG.md 版本标题不重复', () => {
  const entries = parseChangelog(readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'));
  const versions = entries.map((e) => e.version);
  assert.equal(new Set(versions).size, versions.length, `版本标题重复：${versions.join(', ')}`);
  assert.ok(versions.length >= 13, `历史版本条目过少（${versions.length}），检查是否漏写`);
});
