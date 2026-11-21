// 三级技能目录（Agent Skills 对齐）：builtin（playbooks/<域>）+ user（FINALCHECK_SKILLS_DIR）
// + project（<项目>/.finalcheck/skills），同名就近覆盖 project > user > builtin；read 走条目自带 __root。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkills, readPlaybook, clearSkillsCache } from '../src/playbooks.mjs';

async function skillDir(root, slug, body) {
  await mkdir(path.join(root, slug), { recursive: true });
  await writeFile(path.join(root, slug, 'SKILL.md'), body);
}

test('三级技能：project > user 覆盖同名；内置目录仍在；read 走对应层级的根', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fc-skills-'));
  const projectDir = path.join(tmp, 'proj');
  const userRoot = path.join(tmp, 'user-skills');
  await mkdir(projectDir, { recursive: true });
  await skillDir(userRoot, 'fix-s3-key', [
    '---',
    'name: fix-s3-key',
    'description: Use when S3 密钥命中需要轮换与迁移。读取后按步骤执行密钥轮换。',
    '---',
    '',
    '# S3 密钥轮换（用户级）',
    '',
    '内容：先撤销泄露密钥，再换新密钥，最后清理历史。',
  ].join('\n'));
  // 项目级同名覆盖用户级
  await skillDir(path.join(projectDir, '.finalcheck', 'skills'), 'fix-s3-key', [
    '---',
    'name: fix-s3-key',
    'description: Use when 本项目 S3 密钥命中（项目专属流程）。',
    '---',
    '',
    '# S3 密钥轮换（项目级覆盖）',
  ].join('\n'));
  // 项目级按英文名遮蔽内置 ssrf（11-SSRF注入-SSRFInjection name=ssrf）
  await skillDir(path.join(projectDir, '.finalcheck', 'skills'), 'ssrf', [
    '---',
    'name: ssrf',
    'description: Use when 本项目 SSRF 变体（内网元数据服务优先）。',
    '---',
    '',
    '# 项目专属 SSRF 流程',
  ].join('\n'));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  process.env.FINALCHECK_SKILLS_DIR = userRoot;
  clearSkillsCache();
  try {
    const skills = await loadSkills({ projectDir });
    const builtin = skills.filter((s) => s.scope === 'builtin');
    const user = skills.filter((s) => s.scope === 'user');
    const project = skills.filter((s) => s.scope === 'project');
    assert.ok(builtin.length >= 39, '内置 40 套减去被项目级遮蔽的 ssrf');
    assert.equal(project.filter((s) => s.dir === 'fix-s3-key').length, 1, '项目级 fix-s3-key 存在');
    assert.equal(user.filter((s) => s.name === 'fix-s3-key').length, 0, '用户级同名被项目级覆盖');
    assert.equal(skills.filter((s) => s.name === 'ssrf').length, 1, 'ssrf 只剩一条（项目级遮蔽内置）');
    const shadowed = skills.find((s) => s.name === 'ssrf');
    assert.equal(shadowed.scope, 'project', 'ssrf 命中项目级');

    // read：项目级技能从项目根读；内置技能仍从仓库根读
    const r1 = await readPlaybook({ topic: 'fix-s3-key', catalog: skills });
    assert.match(r1.content, /项目级覆盖/, '同名命中项目级正文');
    const r2 = await readPlaybook({ topic: 'ssrf', catalog: skills });
    assert.match(r2.content, /项目专属 SSRF/, 'ssrf 读的是项目级正文');
    // 未被遮蔽的内置技能照常按编号读取
    const r3 = await readPlaybook({ topic: '06', catalog: skills });
    assert.ok(/xss|跨站/i.test(r3.content || ''), '编号 06（未遮蔽）仍命中内置');

    // 用户级技能可读（换一个没有项目覆盖的 slug）
    await skillDir(userRoot, 'fix-o1-logging', [
      '---',
      'name: fix-o1-logging',
      'description: Use when O1 日志/告警缺失需要补运维基线。',
      '---',
      '',
      '# O1 运维基线（用户级正文）',
    ].join('\n'));
    clearSkillsCache();
    const skills2 = await loadSkills({ projectDir });
    const r4 = await readPlaybook({ topic: 'fix-o1-logging', catalog: skills2 });
    assert.match(r4.content, /用户级正文/, '用户级正文按 __root 读取');
  } finally {
    delete process.env.FINALCHECK_SKILLS_DIR;
    clearSkillsCache();
  }
});

// 0.29.5：跨 agent 互通文件夹 ~/.agents/skills（ZCode / Claude Code 同款）。FINALCHECK_COMMON_SKILLS_DIR 可覆盖。
// 优先级：FC 自带 desktop/skills > 互通文件夹；同名时 FC 自带留、互通让。
test('common 文件夹：并入 user 层；FC 自带同名优先；不存在的目录静默为空', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fc-common-skills-'));
  const ownRoot = path.join(tmp, 'own-skills');
  const commonRoot = path.join(tmp, 'common-skills');
  await skillDir(ownRoot, 'fix-s3-key', [
    '---', 'name: fix-s3-key', 'description: Use when S3 密钥需要轮换（FC 自带版）。',
    '---', '', '# S3 密钥轮换（FC 自带）',
  ].join('\n'));
  await skillDir(commonRoot, 'fix-s3-key', [
    '---', 'name: fix-s3-key', 'description: Use when S3 密钥需要轮换（互通文件夹版）。',
    '---', '', '# S3 密钥轮换（互通）',
  ].join('\n'));
  await skillDir(commonRoot, 'fc-computer-use', [
    '---', 'name: fc-computer-use', 'description: Use when driving a desktop GUI on Windows (click/type/screenshot).',
    '---', '', '# Computer Use（互通）',
  ].join('\n'));
  await skillDir(commonRoot, 'fc-browser-use', [
    '---', 'name: fc-browser-use', 'description: Use when testing or driving a web page in a real browser.',
    '---', '', '# Browser Use（互通）',
  ].join('\n'));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  process.env.FINALCHECK_SKILLS_DIR = ownRoot;
  process.env.FINALCHECK_COMMON_SKILLS_DIR = commonRoot;
  clearSkillsCache();
  try {
    const skills = await loadSkills({});
    const user = skills.filter((s) => s.scope === 'user');
    assert.equal(user.filter((s) => s.name === 'fix-s3-key').length, 1, '同名只留一条');
    assert.match(user.find((s) => s.name === 'fix-s3-key').description, /FC 自带版/, '同名时 FC 自带胜出');
    assert.ok(user.some((s) => s.name === 'fc-computer-use'), '互通文件夹的 computer-use 进目录');
    assert.ok(user.some((s) => s.name === 'fc-browser-use'), '互通文件夹的 browser-use 进目录');
    assert.equal(user.filter((s) => s.name === 'fc-computer-use').length, 1, '无残影');

    const r = await readPlaybook({ topic: 'fc-computer-use', catalog: skills });
    assert.match(r.content, /Computer Use（互通）/, '互通技能正文按 __root 可读');
  } finally {
    delete process.env.FINALCHECK_SKILLS_DIR;
    delete process.env.FINALCHECK_COMMON_SKILLS_DIR;
    clearSkillsCache();
  }
});

test('common 文件夹：目录不存在=静默无技能，不影响自带与内置', async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'fc-common-absent-'));
  const ownRoot = path.join(tmp, 'own-skills');
  await skillDir(ownRoot, 'only-own', [
    '---', 'name: only-own', 'description: Use when 只有自带目录的场景。',
    '---', '', '# 自带正文',
  ].join('\n'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  process.env.FINALCHECK_SKILLS_DIR = ownRoot;
  process.env.FINALCHECK_COMMON_SKILLS_DIR = path.join(tmp, 'does-not-exist');
  clearSkillsCache();
  try {
    const skills = await loadSkills({});
    const user = skills.filter((s) => s.scope === 'user');
    assert.equal(user.length, 1, '不存在的互通目录不产生条目也不报错');
    assert.equal(user[0].name, 'only-own');
    assert.ok(skills.some((s) => s.scope === 'builtin'), '内置不受影响');
  } finally {
    delete process.env.FINALCHECK_SKILLS_DIR;
    delete process.env.FINALCHECK_COMMON_SKILLS_DIR;
    clearSkillsCache();
  }
});

// 打包回归钉：安装包必须带上 desktop/skills（0.29.4 漏拷 → 打包版斜杠菜单无 CU/BU），
// 且打包版 REPO_ROOT=resources 时 userSkillsRoot() 恰好解析到 resources/desktop/skills。
test('打包钉：extraResources 拷 skills → desktop/skills；commonSkillsRoot 指向 ~/.agents/skills', async () => {
  const { readFileSync } = await import('node:fs');
  const pathMod = await import('node:path');
  const repo = pathMod.resolve(pathMod.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(pathMod.join(repo, 'desktop', 'package.json'), 'utf8'));
  const hit = (pkg.build.extraResources || []).find((e) => e.from === 'skills' && e.to === 'desktop/skills');
  assert.ok(hit, 'desktop/package.json extraResources 必须含 skills → desktop/skills');
  const { commonSkillsRoot } = await import('../src/playbooks.mjs');
  delete process.env.FINALCHECK_COMMON_SKILLS_DIR;
  assert.equal(commonSkillsRoot(), pathMod.join(os.homedir(), '.agents', 'skills'), '默认互通目录=home/.agents/skills');
});
