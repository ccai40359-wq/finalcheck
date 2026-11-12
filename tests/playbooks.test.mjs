import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadCatalog, readPlaybook, resolveTopic, renderCatalog, catalogSummary, PLAYBOOK_ROOT } from '../src/playbooks.mjs';

test('playbooks: 40 类目录完整，每类都有 name/description/SKILL.md', async () => {
  const c = await loadCatalog();
  assert.equal(c.length, 40);
  assert.deepEqual(c.map((e) => e.id), Array.from({ length: 40 }, (_, i) => String(i + 1).padStart(2, '0')));
  for (const e of c) {
    assert.ok(e.name, `${e.dir} 缺 name`);
    assert.ok(e.description, `${e.dir} 缺 description`);
    assert.ok(e.files.some((f) => f.name.toLowerCase() === 'skill.md'), `${e.dir} 缺 SKILL.md`);
  }
  const text = renderCatalog(c);
  assert.match(text, /40 类/);
  assert.match(text, /11 SSRF/);
  assert.match(text, /read_playbook/);
});

test('playbooks: 40 个入口全部可读且不会一次撑爆上下文', async () => {
  const c = await loadCatalog();
  for (const e of c) {
    const r = await readPlaybook({ topic: e.id });
    assert.ok(r.content.length > 0, `${e.dir} 入口为空`);
    assert.ok(r.content.length <= 14000, `${e.dir} 入口超过默认上下文预算`);
    assert.equal(r.file, 'SKILL.md');
    assert.ok(r.files.length >= 1);
  }
});

test('playbooks: 编号 / 英文名 / 中文关键词都能命中', async () => {
  const c = await loadCatalog();
  const cases = [
    ['11', '11-SSRF-SSRF'],
    ['ssrf', '11-SSRF-SSRF'],
    ['SQL注入', '05-SQL注入-SQLInjection'],
    ['越权', '21-越权访问-IDOR'],
    ['报告', '40-漏洞报告生成-VulnReportGen'],
    ['waf', '37-WAF绕过-WAFBypass']
  ];
  for (const [q, dir] of cases) {
    const r = resolveTopic(c, q);
    assert.equal(r.entry?.dir, dir, `${q} => ${r.entry?.dir || r.error}`);
  }
});

test('playbooks: 宽泛词给候选，不瞎选第一个', async () => {
  const c = await loadCatalog();
  const r = resolveTopic(c, '注入');
  assert.equal(r.ambiguous, true);
  assert.ok(r.candidates.length >= 3);
  assert.ok(r.candidates.some((x) => x.name === 'sql-injection'));
  assert.equal(r.entry, undefined);
});

test('playbooks: 未找到类目时给可用编号指引', async () => {
  const c = await loadCatalog();
  const r = resolveTopic(c, '量子力学');
  assert.match(r.error, /未找到/);
  assert.ok(r.candidates.length > 0);
});

test('playbooks: 默认读 SKILL.md 入口，带文件路由与附属手册清单', async () => {
  const r = await readPlaybook({ topic: '11' });
  assert.equal(r.file, 'SKILL.md');
  assert.match(r.content, /文件路由/);
  assert.ok(r.files.length >= 2);
  assert.equal(r.truncated, false);
  assert.ok(r.path.includes('11-SSRF-SSRF'));
});

test('playbooks: 附属手册按文件名局部匹配，分页续读可拼回全文', async () => {
  const head = await readPlaybook({ topic: '11', file: 'SCENARIOS', limit: 1000 });
  assert.match(head.file, /SCENARIOS\.md$/);
  assert.equal(head.offset, 0);
  assert.ok(head.truncated);
  assert.ok(head.nextOffset > 0);
  let acc = head.content;
  let off = head.nextOffset;
  let guard = 0;
  while (off != null && guard++ < 200) {
    const chunk = await readPlaybook({ topic: '11', file: 'SCENARIOS', offset: off, limit: 1000 });
    acc += chunk.content;
    off = chunk.nextOffset;
  }
  assert.equal(acc.length, head.totalChars);
  assert.equal(acc, (await readPlaybook({ topic: '11', file: 'SCENARIOS', limit: 30000 })).content);
});

test('playbooks: 路径监狱挡住穿越 / 绝对路径 / 路径分隔符', async () => {
  const bads = ['../../package.json', '..\\..\\package.json', 'C:\\Windows\\win.ini', '/etc/passwd', 'a/b.md', '..'];
  for (const file of bads) {
    const r = await readPlaybook({ topic: '11', file });
    assert.ok(r.error, `应拒绝 ${file}`);
    assert.equal(r.content, undefined, `${file} 不应该读到内容`);
  }
});

test('playbooks: 文件名不唯一时列候选，不瞎选', async () => {
  const r = await readPlaybook({ topic: '11', file: 'SSRF' });
  assert.ok(r.error);
  assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 2);
});

test('playbooks: limit 上限 30000，offset 超界返回空内容不越界', async () => {
  const r = await readPlaybook({ topic: '11', file: 'SCENARIOS', offset: 0, limit: 999999 });
  assert.equal(r.content.length, Math.min(30000, r.totalChars));
  const tail = await readPlaybook({ topic: '11', file: 'SCENARIOS', offset: 99999999 });
  assert.equal(tail.content, '');
  assert.equal(tail.nextOffset, null);
});

test('playbooks: catalogSummary 每项都有非空英文 descriptionEn（无中文，条目数与 SKILL.md 一致）', async () => {
  const catalog = await loadCatalog();
  const summary = catalogSummary(catalog);
  const dirs = (await readdir(PLAYBOOK_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{1,2}[-_]/.test(d.name));
  let skillCount = 0;
  for (const d of dirs) {
    const files = await readdir(path.join(PLAYBOOK_ROOT, d.name));
    if (files.some((f) => f.toLowerCase() === 'skill.md')) skillCount += 1;
  }
  assert.equal(summary.length, skillCount, '目录条目数应与 SKILL.md 数量一致');
  assert.equal(summary.length, 40);
  for (const item of summary) {
    assert.ok(item.descriptionEn?.trim(), `${item.id} ${item.name} 缺 descriptionEn`);
    assert.ok(!/[\u3400-\u9fff]/.test(item.descriptionEn), `${item.id} descriptionEn 不应含中文：${item.descriptionEn}`);
    assert.ok(item.descriptionEn.length <= 121, `${item.id} descriptionEn 截断后超长：${item.descriptionEn.length}`);
    assert.ok(item.triggers, `${item.id} 旧字段 triggers 不应丢失`);
  }
});
