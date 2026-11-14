// 三级技能目录（Agent Skills 对齐）：builtin（playbooks/<域>）+ user（FINALCHECK_SKILLS_DIR）
// + project（<项目>/.finalcheck/skills），同名就近覆盖 project > user > builtin；read 走条目自带 __root。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
